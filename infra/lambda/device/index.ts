import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { IoTClient, ListPrincipalThingsCommand } from '@aws-sdk/client-iot';
import type { APIGatewayProxyEventV2WithIAMAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { parseThingName, isValidId } from '../shared/tenant';
import { key, type CameraRecord } from '../shared/registry';
import { base64Key, bounded, ipAddress, label, macAddress, oneOf } from '../shared/sanitise';
import { fail, json } from '../shared/http';

const TABLE = process.env.REGISTRY_TABLE!;
const DISCOVERY_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_CAMERAS = 64;
const MAX_DISCOVERED = 256;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const iot = new IoTClient({});

/**
 * `identity` and `model` are DynamoDB reserved words, so they cannot appear
 * literally in an expression. This surfaced only once a real camera was
 * discovered — every earlier test found nothing to report, so the path had
 * never run.
 */
const RESERVED_NAMES = (thingName: string) => ({
  '#agent': thingName,
  '#identity': 'identity',
  '#model': 'model',
});

/** Certificate id -> thing name, cached for the container's lifetime. */
const thingNameByCertId = new Map<string, string>();

/**
 * The agent's side of the control plane.
 *
 * Both routes are event-driven. `report` is sent when an agent connects or
 * when what it can see changes; `config` is fetched when a version push over
 * MQTT says it is stale. Nothing here runs on a timer, so an idle site makes no
 * requests at all.
 *
 * Configuration is fetched over HTTPS rather than pushed over MQTT because
 * credentials and camera assignments outgrow both the 128KB message limit and
 * the 8KB shadow limit on a large site. MQTT carries only the version number.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithIAMAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const userArn = event.requestContext.authorizer?.iam?.userArn;
  const certificateId = callerCertificateId(userArn);
  if (!certificateId) {
    return fail(403, 'Could not determine calling device');
  }

  const [, , , region, account] = (userArn ?? '').split(':');
  const thingName = await resolveThingName(certificateId, process.env.AWS_REGION ?? region, account);
  if (!thingName) {
    return fail(403, 'Certificate is not attached to exactly one thing');
  }
  const identity = parseThingName(thingName);
  if (!identity) {
    return fail(403, `Device name "${thingName}" is not a valid CamStream thing name`);
  }
  const pk = key.tenant(identity.tenantId);

  const route = event.routeKey.split(' ')[1] ?? '';
  if (route === '/api/device/config') {
    return await sendConfig(pk, thingName);
  }
  if (route === '/api/device/report') {
    return await acceptReport(pk, thingName, identity.premisesId, event.body);
  }
  return fail(404, `Unknown device route: ${route}`);
}

/**
 * The IoT Credentials Provider sets the STS role-session name to the
 * certificate id, not the thing name, so the caller is resolved through IoT.
 * Deriving identity from the credentials rather than the body is what stops one
 * agent writing as another.
 */
function callerCertificateId(userArn: string | undefined): string | null {
  if (!userArn) return null;
  const match = /^arn:aws[a-z-]*:sts::\d+:assumed-role\/[^/]+\/(.+)$/.exec(userArn);
  if (!match) return null;
  return /^[0-9a-f]{64}$/.test(match[1]) ? match[1] : null;
}

async function resolveThingName(certificateId: string, region: string, account: string): Promise<string | null> {
  const cached = thingNameByCertId.get(certificateId);
  if (cached) return cached;

  const principal = `arn:aws:iot:${region}:${account}:cert/${certificateId}`;
  const result = await iot.send(new ListPrincipalThingsCommand({ principal }));
  const things = result.things ?? [];
  if (things.length !== 1) return null;

  thingNameByCertId.set(certificateId, things[0]);
  return things[0];
}

async function sendConfig(pk: string, thingName: string): Promise<APIGatewayProxyStructuredResultV2> {
  const [credentials, cameras, device] = await Promise.all([
    queryPrefix(pk, `CREDENTIAL#${thingName}#`),
    queryPrefix(pk, 'CAMERA#'),
    ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: { ':pk': pk, ':sk': key.device(thingName) },
    })),
  ]);

  return json(200, {
    configVersion: Number(device.Items?.[0]?.configVersion ?? 0),
    // Ciphertext the control plane relayed but cannot open.
    credentials: credentials
      .map((item) => ({ scope: String(item.scope ?? '*'), ciphertext: String(item.ciphertext ?? '') }))
      .filter((entry) => entry.ciphertext.length > 0),
    approvedCameras: cameras
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
      }),
  });
}

async function acceptReport(
  pk: string,
  thingName: string,
  premisesId: string,
  rawBody: string | undefined,
): Promise<APIGatewayProxyStructuredResultV2> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return fail(400, 'Body must be JSON');
  }

  const cameras = Array.isArray(body.cameras) ? body.cameras.slice(0, MAX_CAMERAS) : [];
  const invalid = cameras.find((c) => !isValidId((c as { cameraId?: unknown }).cameraId));
  if (invalid) {
    return fail(400, `Invalid cameraId: ${JSON.stringify((invalid as { cameraId?: unknown }).cameraId)}`);
  }

  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk, sk: key.device(thingName) },
      UpdateExpression:
        'SET thingName = :thing, premisesId = :premises, siteName = :site, agentVersion = :version, ' +
        'cameraCount = :count, taskHealth = :health, lastReportAt = :now, lastSeen = :now' +
        ', credentialPublicKey = if_not_exists(credentialPublicKey, :key)',
      ExpressionAttributeValues: {
        ':thing': thingName,
        ':premises': premisesId,
        ':site': label(body.siteName) ?? null,
        ':version': label(body.agentVersion, 32) ?? null,
        ':count': cameras.length,
        ':health': Array.isArray(body.taskHealth)
          ? body.taskHealth.slice(0, 16).map((entry) => label(entry, 200) ?? '').filter(Boolean)
          : [],
        ':now': now,
        ':key': base64Key(body.credentialPublicKey, 64, 2048) ?? null,
      },
    }),
  );

  // A re-provisioned agent publishes a new key; overwrite rather than keep the
  // stale one, or every credential sealed afterwards would be undecryptable.
  const publishedKey = base64Key(body.credentialPublicKey, 64, 2048);
  if (publishedKey) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk, sk: key.device(thingName) },
      UpdateExpression: 'SET credentialPublicKey = :key',
      ExpressionAttributeValues: { ':key': publishedKey },
    }));
  }

  await writeCameras(pk, thingName, cameras, now);
  await recordDiscoveries(pk, thingName, body.discovered, now);

  return json(200, { thingName, cameras: cameras.length });
}

async function writeCameras(pk: string, thingName: string, cameras: unknown[], now: number): Promise<void> {
  if (cameras.length === 0) return;
  const items = cameras.map((raw) => {
    const camera = raw as Record<string, unknown>;
    return {
      PutRequest: {
        Item: {
          pk,
          sk: `LIVECAMERA#${thingName}#${camera.cameraId as string}`,
          thingName,
          cameraId: camera.cameraId as string,
          displayName: label(camera.displayName) ?? camera.cameraId,
          sourceCodec:
            typeof camera.sourceCodec === 'string' && /^[a-z0-9]{1,12}$/i.test(camera.sourceCodec)
              ? camera.sourceCodec.toLowerCase()
              : undefined,
          // ffprobe's profile names carry spaces, digits and colons — "High
          // 4:2:2" — so this is bounded and character-classed rather than
          // matched against a fixed list the next codec would break.
          sourceCodecProfile:
            typeof camera.sourceCodecProfile === 'string'
            && /^[a-z0-9 :.+-]{1,32}$/i.test(camera.sourceCodecProfile)
              ? camera.sourceCodecProfile.toLowerCase()
              : undefined,
          profiles: Array.isArray(camera.profiles)
            ? camera.profiles.filter((p): p is string => p === 'sub' || p === 'main')
            : ['sub'],
          lastSeen: now,
          // Outlives a brief agent restart, unlike presence.
          expiresAt: now + 3600,
        },
      },
    };
  });
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: items.slice(i, i + 25) } }));
  }
}

/**
 * Merges what this agent saw into the tenant-wide view, keyed by the camera's
 * own identity so a camera within range of several agents is one record with
 * several sightings.
 */
async function recordDiscoveries(pk: string, thingName: string, reported: unknown, now: number): Promise<void> {
  if (!Array.isArray(reported) || reported.length === 0) return;
  const expiresAt = now + DISCOVERY_TTL_SECONDS;

  await Promise.all(
    reported.slice(0, MAX_DISCOVERED).map(async (raw) => {
      const camera = raw as Record<string, unknown>;
      const identity = typeof camera.id === 'string' ? camera.id : null;
      if (!identity || !/^[A-Za-z0-9._-]{3,64}$/.test(identity)) return;

      // Everything below originates in an ONVIF response, which is
      // attacker-controlled input on the customer's network. The agent relays
      // it verbatim; bounding it is this end's job.
      const sighting = {
        ipAddress: ipAddress(camera.ipAddress) ?? '',
        authState: oneOf(camera.authState,
          ['UNKNOWN', 'NEEDS_CREDENTIALS', 'AUTHENTICATED', 'UNSUPPORTED'] as const, 'UNKNOWN'),
        lastSeen: now,
        profiles: Array.isArray(camera.profiles)
          ? camera.profiles.slice(0, 8).map((raw) => {
              const profile = raw as Record<string, unknown>;
              return {
                token: label(profile.token, 64) ?? '',
                name: label(profile.name, 64) ?? null,
                codec: label(profile.codec, 12) ?? null,
                width: bounded(profile.width, 1, 16384) ?? null,
                height: bounded(profile.height, 1, 16384) ?? null,
                fps: bounded(profile.fps, 1, 1000) ?? null,
              };
            }).filter((profile) => profile.token.length > 0)
          : [],
      };
      const values = {
        ':identity': identity,
        ':stable': camera.identityStable === true,
        ':sighting': sighting,
        ':now': now,
        ':expiresAt': expiresAt,
        ':mac': macAddress(camera.macAddress) ?? null,
        ':make': label(camera.manufacturer, 64) ?? null,
        ':model': label(camera.model, 64) ?? null,
      };
      try {
        // reachableBy is a map keyed by thing name, so concurrent reports from
        // different agents touch disjoint paths and cannot clobber each other.
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { pk, sk: key.discovered(identity) },
          UpdateExpression:
            'SET #identity = :identity, identityStable = :stable, reachableBy.#agent = :sighting, ' +
            'lastSeen = :now, expiresAt = :expiresAt, macAddress = if_not_exists(macAddress, :mac), ' +
            'manufacturer = if_not_exists(manufacturer, :make), #model = if_not_exists(#model, :model)',
          ExpressionAttributeNames: RESERVED_NAMES(thingName),
          ExpressionAttributeValues: values,
          ConditionExpression: 'attribute_exists(reachableBy)',
        }));
      } catch {
        // First sighting: the map does not exist yet, so create the record
        // whole. :sighting is deliberately dropped — DynamoDB rejects an
        // ExpressionAttributeValues entry that the expression never uses.
        const { ':sighting': _unused, ...withoutSighting } = values;
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { pk, sk: key.discovered(identity) },
          UpdateExpression:
            'SET #identity = :identity, identityStable = :stable, reachableBy = :first, ' +
            'macAddress = :mac, manufacturer = :make, #model = :model, lastSeen = :now, expiresAt = :expiresAt',
          ExpressionAttributeNames: { '#identity': 'identity', '#model': 'model' },
          ExpressionAttributeValues: { ...withoutSighting, ':first': { [thingName]: sighting } },
        }));
      }
    }),
  );
}

async function queryPrefix(pk: string, prefix: string): Promise<Record<string, unknown>[]> {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
  }));
  return (result.Items ?? []) as Record<string, unknown>[];
}
