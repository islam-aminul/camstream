import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isValidId, parseThingName } from '../shared/tenant';
import { fail, json } from '../shared/http';
import { readSession } from '../shared/session';

const TABLE = process.env.REGISTRY_TABLE!;
const IOT_ENDPOINT = process.env.IOT_DATA_ENDPOINT!;

/**
 * How long one keepalive keeps a rendition alive. The client re-posts well
 * inside this, so closing a tab stops the stream within a minute.
 */
const DEMAND_TTL_SECONDS = 60;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const iot = new IoTDataPlaneClient({ endpoint: `https://${IOT_ENDPOINT}` });

interface DemandRecord {
  sk: string;
  sessionId: string;
  grid: boolean;
  mainThingName?: string;
  mainCameraId?: string;
  expiresAt: number;
}

/** What a single agent should be publishing right now. */
interface DesiredState {
  thingName: string;
  renditions: { cameraId: string; profile: 'sub' | 'main' }[];
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const tenantId = claims['custom:tenantId'];
  const userSub = claims.sub;

  if (typeof userSub !== 'string' || !isValidId(tenantId)) {
    return fail(403, 'Account is not associated with a valid tenant');
  }

  let body: { sessionId?: unknown; grid?: unknown; main?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return fail(400, 'Body must be JSON');
  }

  // Watching is gated on holding the tenant's single active session, so a
  // displaced tab stops driving agents immediately rather than at cookie expiry.
  if (typeof body.sessionId !== 'string') {
    return fail(400, 'Body must include sessionId');
  }
  const current = await readSession(ddb, TABLE, userSub);
  if (!current || current.sessionId !== body.sessionId) {
    return fail(409, 'Session superseded by a newer sign-in');
  }

  const grid = body.grid !== false;

  // At most one full-resolution stream per viewer — this is the cap that keeps
  // main-stream bandwidth predictable.
  let mainThingName: string | undefined;
  let mainCameraId: string | undefined;
  if (body.main && typeof body.main === 'object') {
    const main = body.main as { thingName?: unknown; cameraId?: unknown };
    if (typeof main.thingName !== 'string' || typeof main.cameraId !== 'string') {
      return fail(400, 'main must be { thingName, cameraId }');
    }
    const parsed = parseThingName(main.thingName);
    if (!parsed || parsed.tenantId !== tenantId) {
      return fail(403, 'Device does not belong to this tenant');
    }
    if (!isValidId(main.cameraId)) {
      return fail(400, 'Invalid cameraId');
    }
    mainThingName = main.thingName;
    mainCameraId = main.cameraId;
  }

  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `TENANT#${tenantId}`,
        sk: `DEMAND#${body.sessionId}`,
        sessionId: body.sessionId,
        grid,
        mainThingName,
        mainCameraId,
        expiresAt: now + DEMAND_TTL_SECONDS,
      },
    }),
  );

  const [demands, devices, cameras] = await Promise.all([
    queryPrefix<DemandRecord>(tenantId, 'DEMAND#'),
    queryPrefix<{ thingName: string }>(tenantId, 'DEVICE#'),
    queryPrefix<{ thingName: string; cameraId: string }>(tenantId, 'CAMERA#'),
  ]);

  const desired = resolveDesiredState(now, demands, devices, cameras);

  // Every known device is told its full desired state, including an empty one,
  // so an agent whose last viewer left learns to stop rather than time out.
  await Promise.all(
    desired.map((state) =>
      iot.send(
        new PublishCommand({
          topic: `camstream/${state.thingName}/watch`,
          qos: 1,
          payload: Buffer.from(JSON.stringify({ renditions: state.renditions, issuedAt: now })),
        }),
      ),
    ),
  );

  return json(200, {
    keepaliveInSeconds: Math.floor(DEMAND_TTL_SECONDS / 2),
    desired,
  });
}

/**
 * Union of what every live session wants: the grid needs every camera's sub
 * stream, and each viewer may pin one camera to its main stream.
 *
 * TTL deletion is best-effort and can lag by minutes, so expired demand rows
 * are filtered by timestamp rather than trusted to be gone.
 */
export function resolveDesiredState(
  now: number,
  demands: DemandRecord[],
  devices: { thingName: string }[],
  cameras: { thingName: string; cameraId: string }[],
): DesiredState[] {
  const live = demands.filter((d) => d.expiresAt > now);
  const anyGrid = live.some((d) => d.grid);

  const byThing = new Map<string, Map<string, 'sub' | 'main'>>();
  for (const device of devices) {
    byThing.set(device.thingName, new Map());
  }

  if (anyGrid) {
    for (const camera of cameras) {
      byThing.get(camera.thingName)?.set(camera.cameraId, 'sub');
    }
  }

  for (const demand of live) {
    if (!demand.mainThingName || !demand.mainCameraId) continue;
    // main wins over sub for the same camera — one rendition per camera.
    byThing.get(demand.mainThingName)?.set(demand.mainCameraId, 'main');
  }

  return [...byThing.entries()].map(([thingName, renditions]) => ({
    thingName,
    renditions: [...renditions.entries()]
      .map(([cameraId, profile]) => ({ cameraId, profile }))
      .sort((a, b) => a.cameraId.localeCompare(b.cameraId)),
  }));
}

async function queryPrefix<T>(tenantId: string, prefix: string): Promise<T[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':prefix': prefix },
    }),
  );
  return (result.Items ?? []) as T[];
}
