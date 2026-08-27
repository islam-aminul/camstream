import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isValidId, parseThingName, premisesScope, withinScope } from '../shared/tenant';
import { fail, json } from '../shared/http';
import { readSession, sessionSuperseded } from '../shared/session';

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
  /** Codecs this viewer's browser can actually decode. */
  codecs?: string[];
  /**
   * Cameras this viewer has explicitly asked the agent to transcode.
   *
   * Transcoding costs CPU at the edge and money, so it is never inferred from
   * a browser's limitations — a viewer who cannot decode a camera is shown the
   * choice and makes it.
   */
  transcode?: string[];
  /** Premises this viewer may drive. Empty means the whole tenant. */
  scope?: string[];
  expiresAt: number;
}

interface CameraRecord {
  thingName: string;
  cameraId: string;
  /** What the camera emits natively, reported by the agent. */
  sourceCodec?: string;
}

type Variant = 'source' | 'h264';

/** What a single agent should be publishing right now. */
interface DesiredState {
  thingName: string;
  renditions: { cameraId: string; profile: 'sub' | 'main'; variant: Variant }[];
}

/**
 * H.264 is the universal floor: every browser that can play HLS at all can
 * decode it, so a camera already emitting it never needs transcoding.
 */
function canDecode(sourceCodec: string | undefined, viewerCodecs: string[]): boolean {
  const codec = (sourceCodec ?? 'h264').toLowerCase();
  if (codec === 'h264' || codec === 'avc' || codec === 'avc1') {
    return true;
  }
  return viewerCodecs.map((c) => c.toLowerCase()).includes(codec);
}

/**
 * What this viewer should be served for a camera, or null to publish nothing.
 *
 * A viewer who cannot decode the source and has not asked for a transcode
 * contributes no demand: publishing the source would produce bytes they cannot
 * play, and transcoding without being asked would spend edge CPU and money on
 * their behalf.
 */
function variantFor(
  sourceCodec: string | undefined,
  viewerCodecs: string[],
  transcodeRequested: boolean,
): Variant | null {
  if (canDecode(sourceCodec, viewerCodecs)) {
    return 'source';
  }
  return transcodeRequested ? 'h264' : null;
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
  if (!current || current.sessionId !== body.sessionId
      || await sessionSuperseded(ddb, TABLE, userSub, claims as Record<string, unknown>)) {
    return fail(409, 'Session superseded by a newer sign-in');
  }

  const grid = body.grid !== false;
  // Bounds which agents this viewer can cause to start publishing. Without it
  // a restricted viewer drives — and bills — cameras at sites they cannot see.
  const scope = premisesScope(claims as Record<string, unknown>);

  // Declared by the player from MediaSource.isTypeSupported. Absent means we
  // assume the conservative floor and transcode anything exotic.
  const codecs = Array.isArray(body.codecs)
    ? body.codecs.filter((c): c is string => typeof c === 'string' && /^[a-z0-9]{1,12}$/i.test(c)).slice(0, 8)
    : [];
  const transcode = Array.isArray(body.transcode)
    ? body.transcode.filter((c): c is string => isValidId(c)).slice(0, 32)
    : [];

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
    if (!withinScope(main.thingName, scope)) {
      return fail(403, 'Device is not within your permitted premises');
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
        codecs,
        transcode,
        scope,
        expiresAt: now + DEMAND_TTL_SECONDS,
      },
    }),
  );

  const [demands, devices, cameras] = await Promise.all([
    queryPrefix<DemandRecord>(tenantId, 'DEMAND#'),
    queryPrefix<{ thingName: string }>(tenantId, 'DEVICE#'),
    queryPrefix<CameraRecord>(tenantId, 'LIVECAMERA#'),
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
  cameras: CameraRecord[],
): DesiredState[] {
  const live = demands.filter((d) => d.expiresAt > now);

  const codecByCamera = new Map<string, string | undefined>();
  for (const camera of cameras) {
    codecByCamera.set(`${camera.thingName}/${camera.cameraId}`, camera.sourceCodec);
  }

  // Keyed by camera+profile+variant: two viewers with different browsers can
  // legitimately require the same camera in two codecs at once.
  const byThing = new Map<string, Map<string, { cameraId: string; profile: 'sub' | 'main'; variant: Variant }>>();
  for (const device of devices) {
    byThing.set(device.thingName, new Map());
  }

  const want = (
    thingName: string,
    cameraId: string,
    profile: 'sub' | 'main',
    viewerCodecs: string[],
    transcodeRequested: string[],
  ) => {
    const bucket = byThing.get(thingName);
    if (!bucket) return;
    const variant = variantFor(
      codecByCamera.get(`${thingName}/${cameraId}`),
      viewerCodecs,
      transcodeRequested.includes(cameraId),
    );
    if (variant === null) {
      return;
    }
    bucket.set(`${cameraId}/${profile}/${variant}`, { cameraId, profile, variant });
  };

  for (const demand of live) {
    const viewerCodecs = demand.codecs ?? [];
    const transcodeRequested = demand.transcode ?? [];
    const pinned = demand.mainThingName && demand.mainCameraId
      ? `${demand.mainThingName}/${demand.mainCameraId}`
      : null;

    if (demand.grid) {
      for (const camera of cameras) {
        if (!withinScope(camera.thingName, demand.scope ?? [])) {
          continue;
        }
        want(camera.thingName, camera.cameraId, 'sub', viewerCodecs, transcodeRequested);
      }
    }
    if (demand.mainThingName && demand.mainCameraId) {
      // The pinned camera gets both rungs: the sub it already had, plus main.
      // That pair is the ABR ladder, and the detail view is the only place a
      // stream is large enough to outrun a viewer's connection.
      want(demand.mainThingName, demand.mainCameraId, 'main', viewerCodecs, transcodeRequested);
      want(demand.mainThingName, demand.mainCameraId, 'sub', viewerCodecs, transcodeRequested);
    }
  }

  return [...byThing.entries()].map(([thingName, renditions]) => ({
    thingName,
    renditions: [...renditions.values()].sort(
      (a, b) => a.cameraId.localeCompare(b.cameraId) || a.profile.localeCompare(b.profile) || a.variant.localeCompare(b.variant),
    ),
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
