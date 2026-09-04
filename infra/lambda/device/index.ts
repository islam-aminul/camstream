import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { IoTClient, ListPrincipalThingsCommand } from '@aws-sdk/client-iot';
import type { APIGatewayProxyEventV2WithIAMAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { parseThingName, isValidId } from '../shared/tenant';
import { key, queryAllPages, type CameraRecord, DEFAULT_MAX_TRANSCODES } from '../shared/registry';
import { base64Key, bounded, ipAddress, label, macAddress, oneOf } from '../shared/sanitise';
import { fail, json } from '../shared/http';
import { emit, METRICS } from '../shared/metrics';

const TABLE = process.env.REGISTRY_TABLE!;
const DISCOVERY_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * The most cameras one agent may publish.
 *
 * How many it can actually carry is a property of the hardware — CPU, memory,
 * disk throughput, network interface, upstream bandwidth — which only the
 * agent can measure. This is the ceiling above which the answer is no
 * regardless.
 */
const MAX_CAMERAS = 128;
const MAX_DISCOVERED = 256;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const iot = new IoTClient({});

/**
 * `identity` and `model` are DynamoDB reserved words, so they cannot appear
 * literally in an expression. This surfaced only once a real camera was
 * discovered — every earlier test found nothing to report, so the path had
 * never run.
 */
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
  // The agent's own premises, taken from the name on its certificate. It never
  // sends one, which is why re-partitioning the registry needed no agent
  // change at all.
  const pk = key.site(identity.tenantId, identity.premisesId);

  const route = event.routeKey.split(' ')[1] ?? '';
  if (route === '/api/device/config') {
    return await sendConfig(pk, thingName);
  }
  if (route === '/api/device/report') {
    // Agents report on connect and every twenty seconds after. A fleet-wide
    // sum of zero therefore means nothing is talking to the control plane at
    // all, which is the alarm worth having - one agent going quiet is a site
    // losing power and belongs in the console instead.
    emit(METRICS.AGENT_REPORTS, 1);
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

  const record = device.Items?.[0] ?? {};
  return json(200, {
    configVersion: Number(record.configVersion ?? 0),
    // How much CPU this box can spare is the operator's knowledge, not
    // something the agent can measure, so it is set from the console.
    maxConcurrentTranscodes: Number(record.maxConcurrentTranscodes ?? DEFAULT_MAX_TRANSCODES),
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

  const reported = Array.isArray(body.cameras) ? body.cameras : [];
  // Refused, not truncated. Quietly discarding the hundred and twenty-ninth
  // camera means an operator who wired one up sees nothing and is told
  // nothing; an error at least names the wall they have hit.
  if (reported.length > MAX_CAMERAS) {
    return fail(400,
      `This agent reported ${reported.length} cameras; one agent may publish at most ${MAX_CAMERAS}. `
      + 'Split the site across more agents.');
  }
  const cameras = reported;
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
          // Both originate on the customer's network and reach here through
          // the agent, so they are shaped rather than trusted.
          ipAddress: ipAddress(camera.ipAddress),
          macAddress: macAddress(camera.macAddress),
          // Bounded like everything else the camera gets a say in.
          width: bounded(camera.width, 1, 16384),
          height: bounded(camera.height, 1, 16384),
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
    await writeBatch(items.slice(i, i + 25));
  }
}

/**
 * Writes one batch, following up whatever DynamoDB declined to take.
 *
 * BatchWriteItem reports throttled writes in UnprocessedItems rather than
 * failing, and nothing read it — so under load a camera simply did not appear
 * in the registry, and the agent would not rewrite it, because its report had
 * not changed. The camera stayed missing from /api/streams until something
 * else happened to move.
 */
async function writeBatch(batch: Record<string, unknown>[]): Promise<void> {
  let pending = batch;
  for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
    if (attempt > 0) {
      // Exponential, because the reason for a retry here is always capacity.
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
    const result = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }));
    pending = (result.UnprocessedItems?.[TABLE] ?? []) as Record<string, unknown>[];
  }
  if (pending.length > 0) {
    // Louder than dropping them: the next report will try again, and a log
    // line is the only way anyone learns this site is being throttled.
    console.warn(`${pending.length} camera record(s) still unwritten after retries`);
  }
}

/**
 * Whether a failed conditional update means the record does not exist yet.
 *
 * The distinction is load-bearing. The update below is guarded on
 * `reachableBy` already existing, and its fallback rewrites the record whole
 * with only this agent's sighting. That fallback used to run on *any* error,
 * so a throttle or a transient fault erased every other agent's sighting of
 * the camera — destroying exactly the merge the identity-keyed design exists
 * to produce, and doing it most readily on a busy estate, which is the kind
 * with several agents in the first place.
 */
export function isFirstSighting(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
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
      const learnt = learnedFrom(camera);
      const known = learnt.values;
      // #identity and #model are reserved words; #agent is the thing name used
      // as a map key. Only the ones the expression actually names may appear,
      // because DynamoDB rejects an unused entry as firmly as a missing one.
      const names: Record<string, string> = {
        '#agent': thingName, '#identity': 'identity', ...learnt.names,
      };
      const learned = learnt.clause;

      const values = {
        ':identity': identity,
        ':stable': camera.identityStable === true,
        ':sighting': sighting,
        ':now': now,
        ':expiresAt': expiresAt,
        ...known,
      };
      try {
        // reachableBy is a map keyed by thing name, so concurrent reports from
        // different agents touch disjoint paths and cannot clobber each other.
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { pk, sk: key.discovered(identity) },
          UpdateExpression:
            'SET #identity = :identity, identityStable = :stable, reachableBy.#agent = :sighting, ' +
            'lastSeen = :now, expiresAt = :expiresAt' + learned,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: 'attribute_exists(reachableBy)',
        }));
      } catch (err) {
        if (!isFirstSighting(err)) {
          throw err;
        }
        // First sighting: the map does not exist yet, so create the record
        // whole. :sighting is deliberately dropped — DynamoDB rejects an
        // ExpressionAttributeValues entry that the expression never uses.
        const { ':sighting': _unused, ...withoutSighting } = values;
        const { '#agent': _agent, ...firstNames } = names;
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { pk, sk: key.discovered(identity) },
          UpdateExpression:
            'SET #identity = :identity, identityStable = :stable, reachableBy = :first, ' +
            'lastSeen = :now, expiresAt = :expiresAt' + learned,
          ExpressionAttributeNames: firstNames,
          ExpressionAttributeValues: { ...withoutSighting, ':first': { [thingName]: sighting } },
        }));
      }
    }),
  );
}

/**
 * What a sighting learned about the device itself, as an update clause.
 *
 * Only fields this sighting actually carries. These used to be written with
 * `if_not_exists`, meaning to stop a later, less informative sighting erasing
 * a name already known - and it achieved the opposite. A camera first seen
 * before its credentials were set answers no ONVIF question, so its record was
 * created with `manufacturer` explicitly null, and a DynamoDB null is a value
 * that exists. Every later report found the attribute present and kept it, so
 * the console read "Unknown model" for the life of the record while the agent
 * reported CPPLUS on every single scan.
 *
 * Writing only what is known leaves the attribute absent until something knows
 * it, which is both the honest representation of "not discovered yet" and the
 * state `if_not_exists` was reasoning about in the first place.
 */
export function learnedFrom(camera: {
  macAddress?: unknown; manufacturer?: unknown; model?: unknown;
}): { clause: string; names: Record<string, string>; values: Record<string, unknown> } {
  const mac = macAddress(camera.macAddress);
  const make = label(camera.manufacturer, 64);
  const model = label(camera.model, 64);

  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  if (mac) { sets.push('macAddress = :mac'); values[':mac'] = mac; }
  if (make) { sets.push('manufacturer = :make'); values[':make'] = make; }
  if (model) { sets.push('#model = :model'); names['#model'] = 'model'; values[':model'] = model; }

  return { clause: sets.length ? ', ' + sets.join(', ') : '', names, values };
}

/**
 * Every item under a prefix, following the cursor.
 *
 * This used to be a single Query, which is the bug queryAllPages was written
 * to prevent — and the one place it mattered most, since an agent that reads a
 * short list of credentials or approved cameras does not fail, it just quietly
 * stops publishing part of the site.
 */
function queryPrefix(pk: string, prefix: string): Promise<Record<string, unknown>[]> {
  return queryAllPages<Record<string, unknown>>(
    (input) => ddb.send(new QueryCommand(input)), TABLE, pk, prefix);
}
