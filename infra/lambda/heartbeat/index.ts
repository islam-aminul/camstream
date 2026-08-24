import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { IoTClient, ListPrincipalThingsCommand } from '@aws-sdk/client-iot';
import type { APIGatewayProxyEventV2WithIAMAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { parseThingName, isValidId } from '../shared/tenant';
import { fail, json } from '../shared/http';

const TABLE = process.env.REGISTRY_TABLE!;
/** Records outlive a few missed heartbeats, then vanish on their own. */
const RECORD_TTL_SECONDS = 600;
const MAX_CAMERAS = 64;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface CameraInput {
  cameraId?: unknown;
  displayName?: unknown;
  width?: unknown;
  height?: unknown;
  /** Which renditions this camera can serve, e.g. ["sub","main"]. */
  profiles?: unknown;
  /** Codec the camera emits natively; decides whether a viewer needs a transcode. */
  sourceCodec?: unknown;
}

const iot = new IoTClient({});

/**
 * Certificate id -> thing name. Cached for the container's lifetime: the
 * binding only changes when a device is re-provisioned, and this call would
 * otherwise run on every heartbeat from every device.
 */
const thingNameByCertId = new Map<string, string>();

/**
 * The IoT Credentials Provider sets the STS role-session name to the
 * *certificate id*, not the thing name, so the caller has to be resolved
 * through IoT. Deriving identity from the credentials rather than the request
 * body is what stops one agent registering cameras under another tenant.
 */
function callerCertificateId(userArn: string | undefined): string | null {
  if (!userArn) return null;
  const match = /^arn:aws[a-z-]*:sts::\d+:assumed-role\/[^/]+\/(.+)$/.exec(userArn);
  if (!match) return null;
  // The credentials provider always uses the bare certificate id here.
  return /^[0-9a-f]{64}$/.test(match[1]) ? match[1] : null;
}

async function resolveThingName(certificateId: string, region: string, account: string): Promise<string | null> {
  const cached = thingNameByCertId.get(certificateId);
  if (cached) return cached;

  const principal = `arn:aws:iot:${region}:${account}:cert/${certificateId}`;
  const result = await iot.send(new ListPrincipalThingsCommand({ principal }));
  const things = result.things ?? [];
  // A certificate attached to several things has no single identity, so it is
  // refused rather than guessed at.
  if (things.length !== 1) return null;

  thingNameByCertId.set(certificateId, things[0]);
  return things[0];
}

export async function handler(
  event: APIGatewayProxyEventV2WithIAMAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const certificateId = callerCertificateId(event.requestContext.authorizer?.iam?.userArn);
  if (!certificateId) {
    return fail(403, 'Could not determine calling device');
  }

  const [, , , region, account] = (event.requestContext.authorizer?.iam?.userArn ?? '').split(':');
  const caller = await resolveThingName(certificateId, process.env.AWS_REGION ?? region, account);
  if (!caller) {
    return fail(403, 'Certificate is not attached to exactly one thing');
  }

  const identity = parseThingName(caller);
  if (!identity) {
    return fail(403, `Device name "${caller}" is not a valid CamStream thing name`);
  }
  const { tenantId } = identity;

  let body: { cameras?: unknown; siteName?: unknown; agentVersion?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return fail(400, 'Body must be JSON');
  }

  if (!Array.isArray(body.cameras)) {
    return fail(400, 'Body must include a "cameras" array');
  }
  if (body.cameras.length > MAX_CAMERAS) {
    return fail(400, `At most ${MAX_CAMERAS} cameras per device`);
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + RECORD_TTL_SECONDS;
  const pk = `TENANT#${tenantId}`;

  const cameras: CameraInput[] = body.cameras;
  const invalid = cameras.find((c) => !isValidId(c.cameraId));
  if (invalid) {
    return fail(400, `Invalid cameraId: ${JSON.stringify(invalid.cameraId)}`);
  }

  const items = [
    {
      PutRequest: {
        Item: {
          pk,
          sk: `DEVICE#${caller}`,
          thingName: caller,
          tenantId,
          siteName: typeof body.siteName === 'string' ? body.siteName.slice(0, 128) : undefined,
          agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion.slice(0, 32) : undefined,
          cameraCount: cameras.length,
          lastSeen: now,
          expiresAt,
        },
      },
    },
    ...cameras.map((camera) => ({
      PutRequest: {
        Item: {
          pk,
          sk: `CAMERA#${caller}#${camera.cameraId as string}`,
          thingName: caller,
          cameraId: camera.cameraId as string,
          displayName:
            typeof camera.displayName === 'string' ? camera.displayName.slice(0, 128) : (camera.cameraId as string),
          width: typeof camera.width === 'number' ? camera.width : undefined,
          height: typeof camera.height === 'number' ? camera.height : undefined,
          sourceCodec:
            typeof camera.sourceCodec === 'string' && /^[a-z0-9]{1,12}$/i.test(camera.sourceCodec)
              ? camera.sourceCodec.toLowerCase()
              : undefined,
          profiles: Array.isArray(camera.profiles)
            ? camera.profiles.filter((p): p is string => p === 'sub' || p === 'main')
            : ['sub'],
          lastSeen: now,
          expiresAt,
        },
      },
    })),
  ];

  // BatchWrite caps at 25 items per call.
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: items.slice(i, i + 25) } }));
  }

  return json(200, { thingName: caller, tenantId, cameras: cameras.length, nextHeartbeatIn: 30 });
}
