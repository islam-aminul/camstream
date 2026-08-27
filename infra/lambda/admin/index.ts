import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  CognitoIdentityProviderClient, ListUsersCommand, AdminCreateUserCommand, AdminDeleteUserCommand,
  AdminAddUserToGroupCommand, AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isValidId, parseThingName, thingName as buildThingName, THING_NAME_PATTERN } from '../shared/tenant';
import { identify, can, targetTenant, ROLES, type Caller, type Role } from '../shared/roles';
import { fail, json } from '../shared/http';
import { sessionSuperseded } from '../shared/session';

/** A refusal the caller can act on, as distinct from an unexpected failure. */
class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'Refused';
  }
}
import { key, slugFor, type CameraRecord, type DiscoveredRecord, type PremisesRecord } from '../shared/registry';
import { buildInstaller, isPlatform, PLATFORMS } from './installer';

const TABLE = process.env.REGISTRY_TABLE!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const IOT_ENDPOINT = process.env.IOT_DATA_ENDPOINT!;
const CLAIM_PARAM = process.env.CLAIM_CERT_PARAM!;
const PROVISIONING_TEMPLATE = process.env.PROVISIONING_TEMPLATE!;
const IOT_CREDENTIAL_ENDPOINT = process.env.IOT_CREDENTIAL_ENDPOINT!;
const LIVE_BUCKET = process.env.LIVE_BUCKET!;
const API_INVOKE_URL = process.env.API_INVOKE_URL!;
const AGENT_VERSION = process.env.AGENT_VERSION ?? '0.1.0';

/** An installer is useless without a token, so the token is short-lived. */
const ENROLLMENT_TTL_SECONDS = 14 * 24 * 60 * 60;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});
const iot = new IoTDataPlaneClient({ endpoint: `https://${IOT_ENDPOINT}` });
const ssm = new SSMClient({});

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const caller = identify(event);
  if (!caller) {
    return fail(403, 'Not a recognised account');
  }

  // A displaced administrator must stop being an administrator immediately,
  // not whenever their token happens to expire.
  const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  if (await sessionSuperseded(ddb, TABLE, caller.sub, claims)) {
    return fail(409, 'Session superseded by a newer sign-in');
  }

  const route = `${event.requestContext.http.method} ${event.routeKey.split(' ')[1] ?? ''}`;
  try {
    switch (route) {
      case 'GET /api/admin/me':          return json(200, { ...caller });
      case 'GET /api/admin/premises':    return await listPremises(caller);
      case 'POST /api/admin/premises':   return await createPremises(caller, event.body);
      case 'DELETE /api/admin/premises/{premisesId}':
        return await deletePremises(caller, event.pathParameters?.premisesId);
      case 'GET /api/admin/agents':      return await listAgents(caller);
      case 'POST /api/admin/agents':     return await createAgent(caller, event.body);
      case 'GET /api/admin/agents/{thingName}/identity':
        return await agentIdentity(caller, event.pathParameters?.thingName);
      case 'GET /api/admin/agents/{thingName}/installer':
        return await agentInstaller(caller, event.pathParameters?.thingName,
          event.queryStringParameters?.platform);
      case 'GET /api/admin/discovered':  return await listDiscovered(caller);
      case 'POST /api/admin/cameras':    return await approveCamera(caller, event.body);
      case 'DELETE /api/admin/cameras/{identity}':
        return await removeCamera(caller, event.pathParameters?.identity);
      case 'POST /api/admin/credentials':return await storeCredential(caller, event.body);
      case 'POST /api/admin/scan':       return await triggerScan(caller, event.body);
      case 'GET /api/admin/users':       return await listUsers(caller);
      case 'POST /api/admin/users':      return await createUser(caller, event.body);
      case 'DELETE /api/admin/users/{username}':
        return await deleteUser(caller, event.pathParameters?.username);
      default:
        return fail(404, `Unknown admin route: ${route}`);
    }
  } catch (err) {
    // A conflict or a bad request is the caller's to fix and says so; anything
    // else is ours, and is logged rather than explained.
    if (err instanceof Refused) {
      return fail(err.status, err.message);
    }
    console.error(route, err);
    return fail(500, 'Unexpected error');
  }
}

async function queryPrefix<T>(tenantId: string, prefix: string): Promise<T[]> {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': key.tenant(tenantId), ':prefix': prefix },
  }));
  return (result.Items ?? []) as T[];
}

/** Premises this caller may act on. Empty claim means all within the tenant. */
function visible(caller: Caller, premisesId: string | undefined): boolean {
  if (caller.premises.length === 0) return true;
  return premisesId !== undefined && caller.premises.includes(premisesId);
}

/**
 * Guard for any request addressed by thing name.
 *
 * The premises is encoded in the name itself, so this needs no lookup — and
 * applying it uniformly is the point: an operator restricted to one site was
 * able to approve cameras, store credentials and trigger scans at another,
 * because each endpoint checked the role but not the scope.
 */
function refuseOutOfScope(caller: Caller, thing: string): APIGatewayProxyStructuredResultV2 | null {
  const identity = parseThingName(thing);
  if (!identity) {
    return fail(400, 'Invalid agent name');
  }
  if (identity.tenantId !== caller.tenantId && !can(caller, 'crossTenant')) {
    return fail(403, 'Agent belongs to another tenant');
  }
  if (!visible(caller, identity.premisesId)) {
    return fail(403, 'Agent is not within your permitted premises');
  }
  return null;
}

// ---------------------------------------------------------------- premises

async function listPremises(caller: Caller) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to list premises');
  const premises = await queryPrefix<PremisesRecord>(caller.tenantId, 'PREMISES#');
  return json(200, { premises: premises.filter((p) => visible(caller, p.premisesId)) });
}

async function createPremises(caller: Caller, rawBody: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to create premises');
  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const tenantId = targetTenant(caller, body.tenantId);
  if (!tenantId) return fail(403, 'Not permitted to act on that tenant');

  const premisesId = String(body.premisesId ?? '').trim().toLowerCase();
  if (!isValidId(premisesId)) {
    return fail(400, 'premisesId must be 3-32 chars of [a-z0-9-] and must not contain "--"');
  }
  // Someone restricted to particular sites creating a new one would produce a
  // premises they immediately cannot see or manage.
  if (caller.premises.length > 0) {
    return fail(403, 'Restricted accounts cannot create premises');
  }

  const record: PremisesRecord = {
    pk: key.tenant(tenantId),
    sk: key.premises(premisesId),
    premisesId,
    displayName: String(body.displayName ?? premisesId).slice(0, 128),
    address: body.address ? String(body.address).slice(0, 256) : undefined,
    createdAt: Math.floor(Date.now() / 1000),
    createdBy: caller.email,
  };
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: record,
    // Re-creating a premises would silently re-point every agent under it.
    ConditionExpression: 'attribute_not_exists(sk)',
  })).catch((err) => {
    if (err?.name === 'ConditionalCheckFailedException') {
      throw new Refused(409, 'That premises already exists');
    }
    throw err;
  });
  return json(200, { premisesId, tenantId });
}

async function deletePremises(caller: Caller, premisesId: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted');
  if (!premisesId || !isValidId(premisesId)) return fail(400, 'Invalid premises id');
  if (!visible(caller, premisesId)) return fail(403, 'Not permitted for that premises');

  const agents = await queryPrefix<Record<string, unknown>>(caller.tenantId, 'DEVICE#');
  const attached = agents.filter((a) => a.premisesId === premisesId);
  if (attached.length > 0) {
    // Deleting it would orphan agents whose thing names encode it.
    return fail(400, `${attached.length} agent(s) are still assigned to this premises`);
  }
  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { pk: key.tenant(caller.tenantId), sk: key.premises(premisesId) },
  }));
  return json(200, { removed: premisesId });
}

// ------------------------------------------------------------------ agents

async function listAgents(caller: Caller) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to list agents');
  // Health arrives on its own item, written directly by an IoT rule, so it is
  // read alongside the registration rather than being part of it.
  const [devices, health] = await Promise.all([
    queryPrefix<Record<string, unknown>>(caller.tenantId, 'DEVICE#'),
    queryPrefix<Record<string, unknown>>(caller.tenantId, 'HEALTH#'),
  ]);
  const healthOf = new Map(health.map((h) => [String(h.thingName), h]));
  return json(200, {
    agents: devices
      .filter((d) => visible(caller, d.premisesId as string | undefined))
      .map((device) => ({
        thingName: device.thingName,
        premisesId: device.premisesId,
        siteName: device.siteName,
        agentVersion: device.agentVersion,
        cameraCount: device.cameraCount ?? 0,
        lastSeen: device.lastSeen,
        // Liveness comes from IoT presence events, not a poll, so this is the
        // connection's actual state rather than "seen within N seconds".
        online: device.connected === true,
        disconnectReason: device.disconnectReason ?? null,
        taskHealth: device.taskHealth ?? [],
        credentialPublicKey: device.credentialPublicKey ?? null,
        enrolled: device.credentialPublicKey != null,
        // A connected agent whose heartbeat has stopped is the case presence
        // events cannot see: the socket is up and the agent is stuck.
        health: heartbeat(healthOf.get(String(device.thingName))),
      })),
  });
}

/**
 * Shapes one agent's last heartbeat for the console.
 *
 * Deliberately reports the raw timestamp and lets the caller judge staleness:
 * what counts as overdue depends on whether the agent is streaming, and the
 * console knows that from the same response.
 */
function heartbeat(record: Record<string, unknown> | undefined) {
  if (!record) return null;
  return {
    at: record.heartbeatAt ?? null,
    healthy: record.healthy !== false,
    failingTasks:
      typeof record.failingTasks === 'string' && record.failingTasks.length > 0
        ? record.failingTasks.split(',')
        : [],
    publishing: record.publishing ?? 0,
    uptimeSeconds: record.uptimeSeconds ?? null,
    camerasConfigured: record.camerasConfigured ?? null,
    agentVersion: record.agentVersion ?? null,
  };
}

/**
 * Registers an agent and mints the one-time token its installer will use.
 *
 * No certificate is issued here. The agent creates its own key pair on first
 * boot and exchanges the token for a certificate through fleet provisioning, so
 * no private key ever travels through this API or the administrator's browser.
 */
async function createAgent(caller: Caller, rawBody: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to enrol agents');
  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const tenantId = targetTenant(caller, body.tenantId);
  if (!tenantId) return fail(403, 'Not permitted to act on that tenant');

  const premisesId = String(body.premisesId ?? '').trim().toLowerCase();
  const deviceId = String(body.deviceId ?? '').trim().toLowerCase();
  if (!isValidId(premisesId) || !isValidId(deviceId)) {
    return fail(400, 'premisesId and deviceId must be 3-32 chars of [a-z0-9-] without "--"');
  }
  if (!visible(caller, premisesId)) return fail(403, 'Not permitted for that premises');

  const premises = await queryPrefix<PremisesRecord>(tenantId, key.premises(premisesId));
  if (premises.length === 0) return fail(404, 'No such premises');

  const thingName = buildThingName({ tenantId, premisesId, deviceId });
  const token = randomBytes(32).toString('base64url');
  const now = Math.floor(Date.now() / 1000);

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: key.tenant(tenantId), sk: key.enrollment(token),
      token, thingName, premisesId,
      issuedAt: now, issuedBy: caller.email,
      expiresAt: now + ENROLLMENT_TTL_SECONDS,
    },
  }));
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: key.tenant(tenantId), sk: key.device(thingName),
      thingName, premisesId, siteName: String(body.siteName ?? deviceId).slice(0, 128),
      connected: false, createdAt: now, createdBy: caller.email,
    },
    ConditionExpression: 'attribute_not_exists(sk)',
  })).catch((err) => {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
    // Re-issuing a token for an existing agent is legitimate — a site being
    // re-imaged, or a lost installer.
  });

  return json(200, { thingName, premisesId, expiresAt: now + ENROLLMENT_TTL_SECONDS });
}

/**
 * The identity file an installer needs: endpoints, the shared claim
 * certificate, and this agent's one-time token.
 *
 * Deliberately small and separate from the installer itself. Generating a 30MB
 * bundle per agent would blow the response limit and waste the CDN; the binary
 * is generic and versioned, and only this is per-agent.
 */
async function agentIdentity(caller: Caller, thing: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted');
  if (!thing || !THING_NAME_PATTERN.test(thing)) return fail(400, 'Invalid agent name');

  const [tenantId, premisesId, deviceId] = thing.split('--');
  if (tenantId !== caller.tenantId && !can(caller, 'crossTenant')) return fail(403, 'Not permitted');
  if (!visible(caller, premisesId)) return fail(403, 'Not permitted for that premises');

  const tokens = await queryPrefix<Record<string, unknown>>(tenantId, 'ENROLLMENT#');
  const now = Math.floor(Date.now() / 1000);
  const usable = tokens
    .filter((t) => t.thingName === thing && !t.usedAt && Number(t.expiresAt) > now)
    .sort((a, b) => Number(b.issuedAt) - Number(a.issuedAt))[0];
  if (!usable) {
    return fail(404, 'No unused enrollment token for this agent — create it again to issue a new one');
  }

  const claim = await ssm.send(new GetParameterCommand({ Name: CLAIM_PARAM, WithDecryption: true }));
  const claimBundle = JSON.parse(claim.Parameter?.Value ?? '{}') as { certificatePem?: string; privateKey?: string };
  if (!claimBundle.certificatePem || !claimBundle.privateKey) {
    return fail(500, 'Claim certificate is not configured — run scripts/bootstrap-claim-cert.sh');
  }

  return json(200, {
    schema: 1,
    tenantId, premisesId, deviceId, thingName: thing,
    region: process.env.AWS_REGION,
    bucket: LIVE_BUCKET,
    apiInvokeUrl: API_INVOKE_URL,
    iotDataEndpoint: IOT_ENDPOINT,
    iotCredentialsEndpoint: IOT_CREDENTIAL_ENDPOINT,
    roleAlias: 'camstream-device',
    provisioningTemplate: PROVISIONING_TEMPLATE,
    enrollmentToken: usable.token,
    enrollmentExpiresAt: usable.expiresAt,
    // Shared across every installer, and worth nothing without the token above.
    claimCertificatePem: claimBundle.certificatePem,
    claimPrivateKey: claimBundle.privateKey,
  });
}

/**
 * A ready-to-run installer for one agent and one platform.
 *
 * Returned as a script rather than an archive: the response carries the
 * identity inline and a presigned link to the generic bundle, which keeps this
 * a few kilobytes and leaves the 30MB binary cacheable and identical for every
 * customer.
 */
async function agentInstaller(caller: Caller, thing: string | undefined, platform: unknown) {
  if (!isPlatform(platform)) {
    return fail(400, `platform must be one of ${PLATFORMS.join(', ')}`);
  }
  const identity = await agentIdentity(caller, thing);
  if (identity.statusCode !== 200) {
    return identity;
  }

  const installer = await buildInstaller(
    platform, JSON.parse(identity.body ?? '{}'), LIVE_BUCKET, AGENT_VERSION);

  return {
    statusCode: 200,
    headers: {
      'content-type': installer.contentType,
      'content-disposition': `attachment; filename="${installer.filename}"`,
      // Contains a live enrollment token.
      'cache-control': 'no-store',
    },
    body: installer.body,
  };
}

// ----------------------------------------------------------------- cameras

async function listDiscovered(caller: Caller) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to list discovered cameras');
  const [discovered, approved, agents] = await Promise.all([
    queryPrefix<DiscoveredRecord>(caller.tenantId, 'DISCOVERED#'),
    queryPrefix<CameraRecord>(caller.tenantId, 'CAMERA#'),
    queryPrefix<Record<string, unknown>>(caller.tenantId, 'DEVICE#'),
  ]);
  const premisesOf = new Map(agents.map((a) => [String(a.thingName), a.premisesId as string | undefined]));
  const approvedByIdentity = new Map(approved.map((camera) => [camera.identity, camera]));

  const cameras = discovered
    .map((record) => {
      const sightings = Object.entries(record.reachableBy ?? {})
        .filter(([thing]) => visible(caller, premisesOf.get(thing)));
      if (sightings.length === 0) return null;
      const existing = approvedByIdentity.get(record.identity);
      return {
        identity: record.identity,
        identityStable: record.identityStable,
        macAddress: record.macAddress,
        manufacturer: record.manufacturer,
        model: record.model,
        lastSeen: record.lastSeen,
        reachableBy: sightings.map(([thingName, sighting]) => ({
          thingName, premisesId: premisesOf.get(thingName),
          ipAddress: sighting.ipAddress, authState: sighting.authState,
          lastSeen: sighting.lastSeen, profiles: sighting.profiles ?? [],
        })),
        approved: existing
          ? { cameraId: existing.cameraId, displayName: existing.displayName, assignedTo: existing.assignedTo }
          : null,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  return json(200, { cameras });
}

async function approveCamera(caller: Caller, rawBody: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to approve cameras');
  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const identity = String(body.identity ?? '');
  const assignedTo = String(body.assignedTo ?? '');

  if (!/^[A-Za-z0-9._-]{3,64}$/.test(identity)) return fail(400, 'Invalid camera identity');
  const outOfScope = refuseOutOfScope(caller, assignedTo);
  if (outOfScope) return outOfScope;

  const discovered = await queryPrefix<DiscoveredRecord>(caller.tenantId, key.discovered(identity));
  const record = discovered[0];
  if (!record) return fail(404, 'No such discovered camera');
  // Assigning to an agent that cannot see it yields a stream that never starts.
  if (!Object.keys(record.reachableBy ?? {}).includes(assignedTo)) {
    return fail(400, `Agent ${assignedTo} cannot reach this camera`);
  }

  const camera: CameraRecord = {
    pk: key.tenant(caller.tenantId), sk: key.camera(identity), identity,
    cameraId: typeof body.cameraId === 'string' && isValidId(body.cameraId) ? body.cameraId : slugFor(identity),
    displayName: String(body.displayName ?? record.model ?? identity).slice(0, 128),
    assignedTo,
    subProfileToken: body.subProfileToken ? String(body.subProfileToken) : undefined,
    mainProfileToken: body.mainProfileToken ? String(body.mainProfileToken) : undefined,
    sourceCodec: body.sourceCodec ? String(body.sourceCodec) : undefined,
    approvedAt: Math.floor(Date.now() / 1000), approvedBy: caller.email,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: camera }));
  await pushConfig(caller.tenantId, assignedTo);
  return json(200, { approved: camera.cameraId, assignedTo });
}

async function removeCamera(caller: Caller, identity: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted');
  if (!identity) return fail(400, 'Camera identity is required');

  const existing = await queryPrefix<CameraRecord>(caller.tenantId, key.camera(identity));
  if (existing[0]?.assignedTo) {
    const outOfScope = refuseOutOfScope(caller, existing[0].assignedTo);
    if (outOfScope) return outOfScope;
  }
  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { pk: key.tenant(caller.tenantId), sk: key.camera(identity) },
  }));
  if (existing[0]?.assignedTo) await pushConfig(caller.tenantId, existing[0].assignedTo);
  return json(200, { removed: identity });
}

async function storeCredential(caller: Caller, rawBody: string | undefined) {
  if (!can(caller, 'manageCredentials')) return fail(403, 'Not permitted to set credentials');
  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const thing = String(body.thingName ?? '');
  const scope = String(body.scope ?? '*');
  const ciphertext = String(body.ciphertext ?? '');

  const outOfScope = refuseOutOfScope(caller, thing);
  if (outOfScope) return outOfScope;
  if (!/^[A-Za-z0-9+/=]{64,2048}$/.test(ciphertext)) return fail(400, 'Ciphertext must be base64 of plausible RSA size');
  if (scope !== '*' && !/^[A-Za-z0-9._-]{3,64}$/.test(scope)) return fail(400, 'Invalid scope');

  // There is deliberately no route that returns a credential: this API is a
  // courier for ciphertext it has no key to open.
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: key.tenant(caller.tenantId), sk: key.credential(thing, scope),
      thingName: thing, scope, ciphertext,
      storedAt: Math.floor(Date.now() / 1000), storedBy: caller.email,
    },
  }));
  await pushConfig(caller.tenantId, thing);
  return json(200, { stored: scope, thingName: thing });
}

async function triggerScan(caller: Caller, rawBody: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted');
  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const thing = String(body.thingName ?? '');
  const outOfScope = refuseOutOfScope(caller, thing);
  if (outOfScope) return outOfScope;

  await iot.send(new PublishCommand({
    topic: `camstream/${thing}/command`, qos: 1,
    payload: Buffer.from(JSON.stringify({ action: 'scan', issuedAt: Math.floor(Date.now() / 1000) })),
  }));
  return json(200, { requested: 'scan', thingName: thing });
}

/**
 * Bumps the agent's config version and tells it over MQTT.
 *
 * Only the version travels: the agent fetches the document over HTTPS. That
 * keeps a large site's credentials and assignments clear of the 128KB message
 * limit while still making the change arrive in under a second.
 */
async function pushConfig(tenantId: string, thing: string): Promise<void> {
  const updated = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: key.tenant(tenantId), sk: key.device(thing) },
    UpdateExpression: 'SET configVersion = if_not_exists(configVersion, :zero) + :one',
    ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
    ReturnValues: 'UPDATED_NEW',
  }));
  const configVersion = Number(updated.Attributes?.configVersion ?? 1);
  await iot.send(new PublishCommand({
    topic: `camstream/${thing}/config`, qos: 1,
    payload: Buffer.from(JSON.stringify({ configVersion })),
  })).catch((err) => {
    // A disconnected agent fetches on its next connect, so this is not fatal.
    console.warn(`could not notify ${thing} of config v${configVersion}: ${err}`);
  });
}

// ------------------------------------------------------------------- users

async function listUsers(caller: Caller) {
  if (!can(caller, 'manageUsers')) return fail(403, 'Not permitted to manage users');
  const result = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }));

  const users = await Promise.all((result.Users ?? []).map(async (user) => {
    const attributes = Object.fromEntries((user.Attributes ?? []).map((a) => [a.Name, a.Value]));
    const groups = await cognito.send(new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID, Username: user.Username!,
    }));
    const held = (groups.Groups ?? []).map((g) => g.GroupName).filter((g): g is Role =>
      (ROLES as readonly string[]).includes(g ?? ''));
    return {
      username: user.Username, email: attributes.email,
      tenantId: attributes['custom:tenantId'],
      premises: attributes['custom:premises'] ?? '',
      role: held[0] ?? 'viewer',
      status: user.UserStatus, enabled: user.Enabled,
    };
  }));

  return json(200, {
    users: users.filter((u) => can(caller, 'crossTenant') || u.tenantId === caller.tenantId),
  });
}

async function createUser(caller: Caller, rawBody: string | undefined) {
  if (!can(caller, 'manageUsers')) return fail(403, 'Not permitted to manage users');
  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const email = String(body.email ?? '').trim().toLowerCase();
  const role = String(body.role ?? 'viewer') as Role;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, 'A valid email address is required');
  if (!(ROLES as readonly string[]).includes(role)) return fail(400, `role must be one of ${ROLES.join(', ')}`);
  // Only a superadmin may mint another one, or an admin could escalate itself.
  if (role === 'superadmin' && !can(caller, 'crossTenant')) {
    return fail(403, 'Only a superadmin may create a superadmin');
  }

  const tenantId = targetTenant(caller, body.tenantId);
  if (!tenantId) return fail(403, 'Not permitted to act on that tenant');

  const requested = Array.isArray(body.premises)
    ? body.premises.filter((p): p is string => typeof p === 'string' && isValidId(p))
    : [];
  const beyond = requested.filter((p) => !visible(caller, p));
  if (beyond.length > 0) {
    return fail(403, `You cannot grant access to: ${beyond.join(', ')}`);
  }
  // A restricted admin creating an unrestricted user would be an escalation by
  // proxy, so the new account inherits the creator's own bounds by default.
  const premises = (requested.length > 0 ? requested : caller.premises).join(',');

  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: USER_POOL_ID, Username: email,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
      // Taken from the caller, never the request: an admin must not be able to
      // mint users into another tenant.
      { Name: 'custom:tenantId', Value: tenantId },
      ...(premises ? [{ Name: 'custom:premises', Value: premises }] : []),
    ],
    DesiredDeliveryMediums: ['EMAIL'],
  }));
  await cognito.send(new AdminAddUserToGroupCommand({
    UserPoolId: USER_POOL_ID, Username: email, GroupName: role,
  }));

  return json(200, { created: email, tenantId, role, premises });
}

async function deleteUser(caller: Caller, username: string | undefined) {
  if (!can(caller, 'manageUsers')) return fail(403, 'Not permitted to manage users');
  if (!username) return fail(400, 'Username is required');
  // Locking yourself out of your own tenant would need AWS console access to undo.
  if (username === caller.email || username === caller.sub) {
    return fail(400, 'You cannot delete your own account');
  }
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
  return json(200, { deleted: username });
}
