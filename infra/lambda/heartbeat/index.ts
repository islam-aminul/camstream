import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { IoTClient, ListPrincipalThingsCommand } from '@aws-sdk/client-iot';
import type { APIGatewayProxyEventV2WithIAMAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { parseThingName, isValidId } from '../shared/tenant';
import { fail, json } from '../shared/http';
import { key, type CameraRecord } from '../shared/registry';

const TABLE = process.env.REGISTRY_TABLE!;
/** Records outlive a few missed heartbeats, then vanish on their own. */
const RECORD_TTL_SECONDS = 600;
const MAX_CAMERAS = 64;
/** Discoveries outlive an agent restart, unlike heartbeat liveness records. */
const DISCOVERY_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_DISCOVERED = 256;

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

/**
 * Merges what this agent saw into the tenant-wide view.
 *
 * Keyed by the camera's own identity, so a camera within range of two agents
 * becomes one record listing both — not two records that an administrator would
 * approve separately and pay for twice.
 */
async function recordDiscoveries(pk: string, thingName: string, reported: unknown, now: number): Promise<void> {
  if (!Array.isArray(reported) || reported.length === 0) {
    return;
  }
  const expiresAt = now + DISCOVERY_TTL_SECONDS;

  await Promise.all(
    reported.slice(0, MAX_DISCOVERED).map((raw) => {
      const camera = raw as Record<string, unknown>;
      const identity = typeof camera.id === 'string' ? camera.id : null;
      if (!identity || !/^[A-Za-z0-9._-]{3,64}$/.test(identity)) {
        return Promise.resolve();
      }
      const sighting = {
        ipAddress: String(camera.ipAddress ?? ''),
        authState: String(camera.authState ?? 'UNKNOWN'),
        lastSeen: now,
        profiles: Array.isArray(camera.profiles) ? camera.profiles.slice(0, 8) : [],
      };
      return ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk, sk: key.discovered(identity) },
          // reachableBy is a map keyed by thingName, so concurrent heartbeats
          // from different agents update disjoint paths and cannot clobber
          // each other's sighting.
          UpdateExpression:
            'SET identity = :identity, identityStable = :stable, reachableBy.#agent = :sighting, ' +
            'lastSeen = :now, expiresAt = :expiresAt' +
            ', macAddress = if_not_exists(macAddress, :mac)' +
            ', manufacturer = if_not_exists(manufacturer, :make)' +
            ', model = if_not_exists(model, :model)',
          ExpressionAttributeNames: { '#agent': thingName },
          ExpressionAttributeValues: {
            ':identity': identity,
            ':stable': camera.identityStable === true,
            ':sighting': sighting,
            ':now': now,
            ':expiresAt': expiresAt,
            ':mac': camera.macAddress ?? null,
            ':make': camera.manufacturer ?? null,
            ':model': camera.model ?? null,
            ':empty': {},
          },
          ConditionExpression: 'attribute_exists(reachableBy)',
        }),
      ).catch(async () => {
        // First sighting: the map does not exist yet, so create the record whole.
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { pk, sk: key.discovered(identity) },
            UpdateExpression:
              'SET identity = :identity, identityStable = :stable, reachableBy = :first, ' +
              'macAddress = :mac, manufacturer = :make, model = :model, lastSeen = :now, expiresAt = :expiresAt',
            ExpressionAttributeValues: {
              ':identity': identity,
              ':stable': camera.identityStable === true,
              ':first': { [thingName]: sighting },
              ':mac': camera.macAddress ?? null,
              ':make': camera.manufacturer ?? null,
              ':model': camera.model ?? null,
              ':now': now,
              ':expiresAt': expiresAt,
            },
          }),
        );
      });
    }),
  );
}

/** Published so the admin UI can encrypt credentials only this agent can open. */
async function recordPublicKey(pk: string, thingName: string, publicKey: unknown): Promise<void> {
  if (typeof publicKey !== 'string' || publicKey.length < 64 || publicKey.length > 2048) {
    return;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk, sk: key.device(thingName) },
      UpdateExpression: 'SET credentialPublicKey = :pk',
      ExpressionAttributeValues: { ':pk': publicKey },
    }),
  );
}

/** Ciphertext blobs stored for this agent. The control plane cannot read them. */
async function credentialsFor(pk: string, thingName: string): Promise<{ scope: string; ciphertext: string }[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': `CREDENTIAL#${thingName}#` },
    }),
  );
  return (result.Items ?? [])
    .map((item) => ({ scope: String(item.scope ?? '*'), ciphertext: String(item.ciphertext ?? '') }))
    .filter((entry) => entry.ciphertext.length > 0);
}

/** Cameras an administrator approved and assigned to this agent. */
async function camerasAssignedTo(pk: string, thingName: string): Promise<unknown[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': 'CAMERA#' },
    }),
  );
  return (result.Items ?? [])
    .filter((item) => (item as unknown as CameraRecord).assignedTo === thingName)
    .map((item) => {
      const camera = item as unknown as CameraRecord;
      return {
        identity: camera.identity,
        cameraId: camera.cameraId,
        displayName: camera.displayName,
        subProfileToken: camera.subProfileToken,
        mainProfileToken: camera.mainProfileToken,
      };
    });
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

  let body: {
    cameras?: unknown;
    siteName?: unknown;
    agentVersion?: unknown;
    discovered?: unknown;
    credentialPublicKey?: unknown;
  };
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

  await recordDiscoveries(pk, caller, body.discovered, now);
  await recordPublicKey(pk, caller, body.credentialPublicKey);

  // The response is how configuration reaches the agent: credentials it alone
  // can decrypt, and the cameras an administrator assigned to it.
  const [credentials, approvedCameras] = await Promise.all([
    credentialsFor(pk, caller),
    camerasAssignedTo(pk, caller),
  ]);

  return json(200, {
    thingName: caller,
    tenantId,
    cameras: cameras.length,
    nextHeartbeatIn: 30,
    credentials,
    approvedCameras,
  });
}
