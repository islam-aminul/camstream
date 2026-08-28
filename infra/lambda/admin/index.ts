import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import {
  IoTClient, ListThingPrincipalsCommand, DetachThingPrincipalCommand, ListAttachedPoliciesCommand,
  DetachPolicyCommand, UpdateCertificateCommand, DeleteCertificateCommand, DeleteThingCommand,
} from '@aws-sdk/client-iot';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  CognitoIdentityProviderClient, ListUsersCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminGetUserCommand,
  AdminAddUserToGroupCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isValidId, isValidDisplayName, idFrom, parseThingName, thingName as buildThingName, isThingName } from '../shared/tenant';
import { identify, can, targetTenant, ROLES, type Caller, type Role } from '../shared/roles';
import { fail, json } from '../shared/http';
import { label } from '../shared/sanitise';
import { sessionSuperseded } from '../shared/session';

/** A refusal the caller can act on, as distinct from an unexpected failure. */
class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'Refused';
  }
}
import { key, slugFor, DEFAULT_MAX_TRANSCODES, queryAllPages, encodeCursor, decodeCursor, REGISTRY_PK, type CameraRecord, type CustomerRecord, type DiscoveredRecord, type PremisesRecord } from '../shared/registry';
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

/** The shape of a discovered camera's identity, as the agent reports it. */
const CAMERA_IDENTITY = /^[A-Za-z0-9._-]{3,64}$/;

/** An installer is useless without a token, so the token is short-lived. */
const ENROLLMENT_TTL_SECONDS = 14 * 24 * 60 * 60;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});
const iot = new IoTDataPlaneClient({ endpoint: `https://${IOT_ENDPOINT}` });
/** Control plane rather than data plane: things and certificates, not messages. */
const iotControl = new IoTClient({});
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
      case 'GET /api/admin/customers':   return await listCustomers(caller);
      case 'POST /api/admin/customers':  return await createCustomer(caller, event.body);
      case 'GET /api/admin/premises':    return await listPremises(caller, event.queryStringParameters?.tenantId);
      case 'POST /api/admin/premises':   return await createPremises(caller, event.body);
      case 'DELETE /api/admin/premises/{premisesId}':
        return await deletePremises(caller, event.pathParameters?.premisesId,
          event.queryStringParameters?.tenantId);
      case 'GET /api/admin/agents':      return await listAgents(caller,
          event.queryStringParameters?.tenantId, event.queryStringParameters?.premisesId,
          event.queryStringParameters);
      case 'GET /api/admin/cameras':     return await listCameras(caller, event.queryStringParameters);
      case 'GET /api/admin/counts':      return await counts(caller, event.queryStringParameters);
      case 'GET /api/admin/search':      return await search(caller, event.queryStringParameters);
      case 'POST /api/admin/agents':     return await createAgent(caller, event.body);
      case 'PATCH /api/admin/agents/{thingName}':
        return await updateAgent(caller, event.pathParameters?.thingName, event.body);
      case 'DELETE /api/admin/agents/{thingName}':
        return await removeAgent(caller, event.pathParameters?.thingName);
      case 'GET /api/admin/agents/{thingName}/identity':
        return await agentIdentity(caller, event.pathParameters?.thingName);
      case 'GET /api/admin/agents/{thingName}/installer':
        return await agentInstaller(caller, event.pathParameters?.thingName,
          event.queryStringParameters?.platform);
      case 'GET /api/admin/discovered':  return await listDiscovered(caller,
          event.queryStringParameters?.premisesId);
      case 'POST /api/admin/cameras':    return await approveCamera(caller, event.body);
      case 'DELETE /api/admin/cameras/{identity}':
        return await removeCamera(caller, event.pathParameters?.identity,
          event.queryStringParameters?.premisesId);
      case 'POST /api/admin/credentials':return await storeCredential(caller, event.body);
      case 'DELETE /api/admin/credentials':
        return await removeCredential(caller, event.queryStringParameters?.thingName,
          event.queryStringParameters?.scope);
      case 'POST /api/admin/scan':       return await triggerScan(caller, event.body);
      case 'GET /api/admin/users':       return await listUsers(caller);
      case 'POST /api/admin/users':      return await createUser(caller, event.body);
      case 'PATCH /api/admin/users/{username}':
        return await updateUser(caller, event.pathParameters?.username, event.body);
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

function queryPrefix<T>(pk: string, prefix: string): Promise<T[]> {
  return queryAllPages<T>(
    (input) => ddb.send(new QueryCommand(input)), TABLE, pk, prefix);
}

/**
 * One record by its exact sort key.
 *
 * Several lookups used to pass a complete identifier to `queryPrefix` and take
 * the first row, which is a `begins_with` scan wearing a point lookup's
 * clothing: `PREMISES#hq` matches `PREMISES#hq-2`, so an agent could be
 * enrolled against a premises that does not exist, and `DISCOVERED#sn-ABC`
 * matches `DISCOVERED#sn-ABCD`, so a camera could be approved from a
 * different camera's record.
 */
async function getRecord<T>(pk: string, sk: string): Promise<T | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }));
  return result.Item as T | undefined;
}

/**
 * Filtering, sorting and paging, applied in the lambda rather than in DynamoDB.
 *
 * This works because of the partitioning, not in spite of it. A site holds on
 * the order of a hundred cameras, so reading the partition and narrowing it
 * here costs about what one page would have cost anyway — and it buys
 * case-insensitive matching anywhere in a name, which a DynamoDB filter
 * expression cannot do, without a search service or a second index to keep
 * true. Estate-wide search is the case this does not cover, and it is
 * deliberately prefix-only for the same reason.
 */
function paginate<T extends Record<string, unknown>>(
  rows: T[],
  options: { q?: string; sortBy: (row: T) => string; cursor?: string; limit?: string },
): { items: T[]; cursor?: string; total: number } {
  const needle = (options.q ?? '').trim().toLowerCase();
  const matched = needle
    ? rows.filter((row) => options.sortBy(row).toLowerCase().includes(needle))
    : rows;
  matched.sort((a, b) => options.sortBy(a).localeCompare(options.sortBy(b)));

  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  // The cursor is an offset into a stable sort, which is what makes a page
  // boundary meaningful once filtering has changed which rows exist at all.
  const from = Number((decodeCursor(options.cursor) ?? {}).from ?? 0) || 0;
  const items = matched.slice(from, from + limit);
  const next = from + limit < matched.length
    ? encodeCursor({ from: from + limit })
    : undefined;
  return { items, cursor: next, total: matched.length };
}

/**
 * The partition an agent's records live in, taken from its own name.
 *
 * A thing name is <tenant>--<premises>--<device>, so anything addressed by one
 * already knows where to look. Callers reach this only after refuseOutOfScope
 * has established the name parses and belongs to them.
 */
function siteOfThing(thing: string): string {
  const identity = parseThingName(thing)!;
  return key.site(identity.tenantId, identity.premisesId);
}

/**
 * The premises a request names, checked against what the caller may see.
 *
 * Most reads now address one site rather than one customer, because that is
 * where the estate-sized collections live.
 */
function siteOf(caller: Caller, tenantId: string, premisesId: unknown):
    { pk: string; refusal?: undefined } | { pk?: undefined; refusal: APIGatewayProxyStructuredResultV2 } {
  if (!isValidId(premisesId)) {
    return { refusal: fail(400, 'premisesId is required') };
  }
  if (!visible(caller, premisesId)) {
    return { refusal: fail(403, 'That premises is not within your permitted sites') };
  }
  return { pk: key.site(tenantId, premisesId) };
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

// --------------------------------------------------------------- customers

/**
 * Every customer, for the top level of the console's selection rail.
 *
 * Superadmin only, and deliberately unpaginated: a customer list is measured
 * in tens, and paging it would be ceremony over a single page.
 */
async function listCustomers(caller: Caller) {
  if (!can(caller, 'crossTenant')) return fail(403, 'Only a superadmin may list customers');
  const customers = await queryAllPages<CustomerRecord>(
    (input) => ddb.send(new QueryCommand(input)), TABLE, REGISTRY_PK, 'CUSTOMER#');
  return json(200, {
    customers: customers
      .map((c) => ({ tenantId: c.tenantId, displayName: c.displayName, createdAt: c.createdAt }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  });
}

/**
 * Brings a customer into existence deliberately.
 *
 * Until now a tenant was created by writing into it: passing an unrecognised
 * `tenantId` to any create call made one, so a typo produced a customer with
 * no users, no name, and no way to find it again. It also meant nothing could
 * enumerate customers without scanning the whole table.
 *
 * The caller supplies a name and the id is derived from it, because the id
 * ends up inside IoT thing names, S3 keys and signed cookies where spaces are
 * either illegal or need escaping everywhere.
 */
async function createCustomer(caller: Caller, rawBody: string | undefined) {
  if (!can(caller, 'crossTenant')) return fail(403, 'Only a superadmin may create a customer');

  let body: { displayName?: unknown };
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return fail(400, 'Body must be JSON');
  }

  const displayName = String(body.displayName ?? '').trim();
  if (!isValidDisplayName(displayName)) {
    return fail(400,
      'displayName must be 3-64 characters of letters, digits, single spaces and single hyphens, '
      + 'with no "--" and no repeated spaces');
  }
  const tenantId = idFrom(displayName);
  if (!tenantId) return fail(400, `"${displayName}" does not reduce to a usable id`);

  const record: CustomerRecord = {
    pk: REGISTRY_PK, sk: key.customer(tenantId),
    tenantId, displayName,
    createdAt: Math.floor(Date.now() / 1000), createdBy: caller.email,
  };
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: record,
    // Re-creating one would rename a live customer and re-point everything
    // already filed under its id.
    ConditionExpression: 'attribute_not_exists(sk)',
  })).catch((err) => {
    if (err?.name === 'ConditionalCheckFailedException') {
      throw new Refused(409, `A customer with the id "${tenantId}" already exists`);
    }
    throw err;
  });

  return json(200, { tenantId, displayName });
}

/**
 * Refuses to act on a customer that was never created.
 *
 * This is the other half of making customers real: without it, a mistyped
 * tenant still silently brings one into being on the next write.
 */
async function customerExists(tenantId: string): Promise<boolean> {
  const found = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { pk: REGISTRY_PK, sk: key.customer(tenantId) },
  }));
  return found.Item !== undefined;
}

// ---------------------------------------------------------------- premises

/**
 * The tenant a read should address.
 *
 * Creating a premises or an agent already accepted a `tenantId` for a
 * superadmin, but every read and delete hard-coded the caller's own — so
 * onboarding a customer half-worked: you could create their site and then not
 * see it. Reads take the same optional parameter, resolved by the same rule.
 */
function readTenant(caller: Caller, requested: string | undefined): string | null {
  return targetTenant(caller, requested);
}

async function listPremises(caller: Caller, requestedTenant?: string) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to list premises');
  const tenantId = readTenant(caller, requestedTenant);
  if (!tenantId) return fail(403, 'Not permitted to act on that tenant');
  const premises = await queryPrefix<PremisesRecord>(key.tenant(tenantId), 'PREMISES#');
  return json(200, { tenantId, premises: premises.filter((p) => visible(caller, p.premisesId)) });
}

async function createPremises(caller: Caller, rawBody: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to create premises');
  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const tenantId = targetTenant(caller, body.tenantId);
  if (!tenantId) return fail(403, 'Not permitted to act on that tenant');

  // A customer must exist before anything can be filed under it. Without this
  // a mistyped tenantId still creates one by writing into it.
  if (!(await customerExists(tenantId))) {
    return fail(404, `No customer with the id "${tenantId}"`);
  }

  // The name is typed; the id is derived. An explicit premisesId is still
  // accepted so an existing integration does not break.
  const displayName = String(body.displayName ?? '').trim();
  const premisesId = body.premisesId
    ? String(body.premisesId).trim().toLowerCase()
    : (displayName ? idFrom(displayName) : null);
  if (displayName && !isValidDisplayName(displayName)) {
    return fail(400,
      'displayName must be 3-64 characters of letters, digits, single spaces and single hyphens, '
      + 'with no "--" and no repeated spaces');
  }
  if (!premisesId || !isValidId(premisesId)) {
    return fail(400, 'Supply a displayName, or a premisesId of 3-32 chars of [a-z0-9-] without "--"');
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
    displayName: displayName || premisesId,
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

async function deletePremises(caller: Caller, premisesId: string | undefined, requestedTenant?: string) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted');
  if (!premisesId || !isValidId(premisesId)) return fail(400, 'Invalid premises id');
  if (!visible(caller, premisesId)) return fail(403, 'Not permitted for that premises');
  const tenantId = readTenant(caller, requestedTenant);
  if (!tenantId) return fail(403, 'Not permitted to act on that tenant');

  const attached = await queryPrefix<Record<string, unknown>>(key.site(tenantId, premisesId), 'DEVICE#');
  if (attached.length > 0) {
    // Deleting it would orphan agents whose thing names encode it.
    return fail(400, `${attached.length} agent(s) are still assigned to this premises`);
  }
  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { pk: key.tenant(tenantId), sk: key.premises(premisesId) },
  }));
  return json(200, { removed: premisesId, tenantId });
}

// ------------------------------------------------------------------ agents

async function listAgents(
  caller: Caller,
  requestedTenant?: string,
  premisesId?: string,
  query?: Record<string, string | undefined>,
) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to list agents');
  const forTenant = readTenant(caller, requestedTenant);
  if (!forTenant) return fail(403, 'Not permitted to act on that tenant');
  // Agents are listed for one site. A thousand of them across a customer is
  // more than a page and more than a partition; the console always has a site
  // selected, and counts come from their own endpoint.
  const site = siteOf(caller, forTenant, premisesId);
  if (site.refusal) return site.refusal;
  // Health arrives on its own item, written directly by an IoT rule, so it is
  // read alongside the registration rather than being part of it.
  const [devices, health] = await Promise.all([
    queryPrefix<Record<string, unknown>>(site.pk, 'DEVICE#'),
    // Health stays partitioned by customer: the IoT rule that writes it builds
    // its key in SQL and cannot cut a thing name at the second separator.
    queryPrefix<Record<string, unknown>>(key.tenant(forTenant), 'HEALTH#'),
  ]);
  const healthOf = new Map(health.map((h) => [String(h.thingName), h]));
  const page = paginate(devices.filter((d) => visible(caller, d.premisesId as string | undefined)), {
    q: query?.q,
    sortBy: (d) => String(d.siteName ?? d.thingName ?? ''),
    cursor: query?.cursor,
    limit: query?.limit,
  });
  return json(200, {
    total: page.total,
    cursor: page.cursor,
    agents: page.items
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
        maxConcurrentTranscodes: Number(device.maxConcurrentTranscodes ?? DEFAULT_MAX_TRANSCODES),
      })),
  });
}

/**
 * Sets how many renditions an agent will transcode at once.
 *
 * This is a property of the hardware, which only the operator knows: a rack
 * server and a Raspberry Pi both run this agent. The cap is enforced in two
 * places on purpose — here, so a viewer is told immediately that no slot is
 * free, and on the agent, which owns the CPU and cannot rely on the control
 * plane being reachable or truthful.
 */
async function updateAgent(caller: Caller, thingName: string | undefined, rawBody: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to change agents');
  const thing = label(thingName, 128);
  if (!thing) return fail(400, 'Invalid thingName');

  let body: { maxConcurrentTranscodes?: unknown };
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return fail(400, 'Body must be JSON');
  }

  const cap = body.maxConcurrentTranscodes;
  if (!Number.isInteger(cap) || (cap as number) < 0 || (cap as number) > 64) {
    return fail(400, 'maxConcurrentTranscodes must be a whole number between 0 and 64');
  }

  const existing = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: siteOfThing(thing), sk: key.device(thing) },
  }));
  if (!existing.Item) return fail(404, 'No such agent');

  // Takes the thing name, which encodes tenant and premises both.
  const outOfScope = refuseOutOfScope(caller, thing);
  if (outOfScope) return outOfScope;

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: siteOfThing(thing), sk: key.device(thing) },
    UpdateExpression: 'SET maxConcurrentTranscodes = :cap',
    ExpressionAttributeValues: { ':cap': cap },
  }));
  await pushConfig(caller.tenantId, thing);

  return json(200, { thingName: thing, maxConcurrentTranscodes: cap });
}

/**
 * Retires an agent: its records, its credentials, and its identity.
 *
 * There was no way to do this. Enrolment was one-way, so a decommissioned edge
 * box stayed in the registry permanently — listed, counted, and able to
 * reconnect and resume publishing while its certificate lived. It compounded
 * one level up: `deletePremises` refuses while agents are attached, quite
 * rightly, so a premises that had ever held an agent could not be deleted
 * either. The estate could only grow.
 *
 * Cameras are refused rather than cascaded. Which agent takes over a camera is
 * a decision with a cost attached, and it belongs to the administrator, not to
 * a delete.
 */
async function removeAgent(caller: Caller, thingName: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to remove agents');
  const thing = thingName ?? '';
  const outOfScope = refuseOutOfScope(caller, thing);
  if (outOfScope) return outOfScope;

  const existing = await getRecord<Record<string, unknown>>(siteOfThing(thing), key.device(thing));
  if (!existing) return fail(404, 'No such agent');

  const cameras = await queryPrefix<CameraRecord>(siteOfThing(thing), 'CAMERA#');
  const owned = cameras.filter((camera) => camera.assignedTo === thing);
  if (owned.length > 0) {
    return fail(400,
      `${owned.length} camera(s) are still assigned to this agent — reassign or remove them first`);
  }

  // The identity goes first. A record without a certificate is untidy; a
  // certificate without a record is an agent that can still publish.
  const retired = await retireThing(thing);

  const stale = [
    key.device(thing),
    `HEALTH#${thing}`,
    ...(await queryPrefix<Record<string, unknown>>(siteOfThing(thing), `CREDENTIAL#${thing}#`))
      .map((item) => String(item.sk)),
    ...(await queryPrefix<Record<string, unknown>>(siteOfThing(thing), `LIVECAMERA#${thing}#`))
      .map((item) => String(item.sk)),
  ];
  for (const sk of stale) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: siteOfThing(thing), sk } }));
  }

  return json(200, { removed: thing, records: stale.length, identityRevoked: retired });
}

/**
 * Detaches and deletes the thing's certificate, then the thing.
 *
 * Reports rather than throws. An agent enrolled but never booted has no
 * certificate at all, and a half-torn-down identity should not leave the
 * registry records behind — that is the state nobody can clean up from.
 */
async function retireThing(thing: string): Promise<boolean> {
  try {
    const principals = await iotControl.send(new ListThingPrincipalsCommand({ thingName: thing }));
    for (const principal of principals.principals ?? []) {
      await iotControl.send(new DetachThingPrincipalCommand({ thingName: thing, principal }));
      const attached = await iotControl.send(new ListAttachedPoliciesCommand({ target: principal }));
      for (const policy of attached.policies ?? []) {
        await iotControl.send(new DetachPolicyCommand({ policyName: policy.policyName!, target: principal }));
      }
      const certificateId = principal.split('/').pop()!;
      // Deactivate before delete: an active certificate cannot be deleted, and
      // deactivating is itself what stops the agent reconnecting.
      await iotControl.send(new UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' }));
      await iotControl.send(new DeleteCertificateCommand({ certificateId, forceDelete: true }));
    }
    await iotControl.send(new DeleteThingCommand({ thingName: thing }));
    return true;
  } catch (err) {
    console.warn(`could not fully retire ${thing}: ${err}`);
    return false;
  }
}

/**
 * Withdraws a stored credential.
 *
 * Storing one was possible and withdrawing it was not, so a credential set by
 * mistake, or for a camera long since removed, was relayed to the agent
 * forever. For a system whose stated property is that the operator controls
 * where camera passwords live, "cannot be taken back" is a gap in the claim.
 */
async function removeCredential(caller: Caller, thingName: unknown, scope: unknown) {
  if (!can(caller, 'manageCredentials')) return fail(403, 'Not permitted to manage credentials');
  const thing = String(thingName ?? '');
  const target = String(scope ?? '*');

  const outOfScope = refuseOutOfScope(caller, thing);
  if (outOfScope) return outOfScope;
  if (target !== '*' && !CAMERA_IDENTITY.test(target)) return fail(400, 'Invalid scope');

  const existing = await getRecord<Record<string, unknown>>(
    siteOfThing(thing), key.credential(thing, target));
  if (!existing) return fail(404, 'No credential stored for that scope');

  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { pk: siteOfThing(thing), sk: key.credential(thing, target) },
  }));
  // The agent replaces its whole relayed set from the config it fetches, so
  // bumping the version is what actually revokes this on the edge box.
  await pushConfig(caller.tenantId, thing);
  return json(200, { removed: target, thingName: thing });
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

  if (!(await customerExists(tenantId))) {
    return fail(404, `No customer with the id "${tenantId}"`);
  }

  const premisesId = String(body.premisesId ?? '').trim().toLowerCase();
  const siteName = String(body.siteName ?? '').trim();
  const deviceId = body.deviceId
    ? String(body.deviceId).trim().toLowerCase()
    : (siteName ? idFrom(siteName) : null);
  if (siteName && !isValidDisplayName(siteName)) {
    return fail(400,
      'siteName must be 3-64 characters of letters, digits, single spaces and single hyphens, '
      + 'with no "--" and no repeated spaces');
  }
  if (!isValidId(premisesId) || !deviceId || !isValidId(deviceId)) {
    return fail(400, 'premisesId is required, and deviceId must be supplied or derivable from siteName');
  }
  if (!visible(caller, premisesId)) return fail(403, 'Not permitted for that premises');

  const premises = await getRecord<PremisesRecord>(key.tenant(tenantId), key.premises(premisesId));
  if (!premises) return fail(404, 'No such premises');

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
      pk: key.site(tenantId, premisesId), sk: key.device(thingName),
      thingName, premisesId, siteName: siteName || deviceId,
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
  if (!isThingName(thing)) return fail(400, 'Invalid agent name');

  const { tenantId, premisesId, deviceId } = parseThingName(thing)!;
  if (tenantId !== caller.tenantId && !can(caller, 'crossTenant')) return fail(403, 'Not permitted');
  if (!visible(caller, premisesId)) return fail(403, 'Not permitted for that premises');

  const tokens = await queryPrefix<Record<string, unknown>>(key.tenant(tenantId), 'ENROLLMENT#');
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

// --------------------------------------------------------- listing at scale

/**
 * The approved cameras at one site, filtered, sorted and paged.
 *
 * Distinct from /api/streams, which answers "where do I fetch this camera's
 * video". This answers "what cameras exist here", which is what the console's
 * table and the rail's third dropdown are built on.
 */
async function listCameras(caller: Caller, query: Record<string, string | undefined> | undefined) {
  if (!can(caller, 'viewStreams')) return fail(403, 'Not permitted');
  const tenantId = readTenant(caller, query?.tenantId);
  if (!tenantId) return fail(403, 'Not permitted to act on that tenant');
  const site = siteOf(caller, tenantId, query?.premisesId);
  if (site.refusal) return site.refusal;

  const [approved, live] = await Promise.all([
    queryPrefix<CameraRecord>(site.pk, 'CAMERA#'),
    queryPrefix<Record<string, unknown>>(site.pk, 'LIVECAMERA#'),
  ]);
  const publishing = new Set(live.map((c) => `${c.thingName}/${c.cameraId}`));

  const rows = approved
    // Narrowing by agent is the rail's second dropdown feeding the third.
    .filter((c) => !query?.agentId || c.assignedTo === query.agentId)
    .map((c) => ({
      identity: c.identity,
      cameraId: c.cameraId,
      displayName: c.displayName,
      assignedTo: c.assignedTo,
      sourceCodec: c.sourceCodec ?? null,
      approvedAt: c.approvedAt,
      publishing: publishing.has(`${c.assignedTo}/${c.cameraId}`),
    }))
    .filter((c) => query?.status !== 'publishing' || c.publishing);

  const page = paginate(rows as unknown as Record<string, unknown>[], {
    q: query?.q,
    sortBy: (c) => String(c.displayName ?? c.cameraId ?? ''),
    cursor: query?.cursor,
    limit: query?.limit,
  });
  return json(200, { total: page.total, cursor: page.cursor, cameras: page.items });
}

/**
 * Totals for the rail, without fetching the rows behind them.
 *
 * A rail that says "Cameras (128)" should not have to read 128 records to say
 * so, and at a hundred sites the console would otherwise read the estate just
 * to render its own furniture.
 */
async function counts(caller: Caller, query: Record<string, string | undefined> | undefined) {
  if (!can(caller, 'viewStreams')) return fail(403, 'Not permitted');
  const tenantId = readTenant(caller, query?.tenantId);
  if (!tenantId) return fail(403, 'Not permitted to act on that tenant');

  const countOf = async (pk: string, prefix: string) => {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
      Select: 'COUNT',
    }));
    return result.Count ?? 0;
  };

  if (query?.premisesId) {
    const site = siteOf(caller, tenantId, query.premisesId);
    if (site.refusal) return site.refusal;
    const [agents, cameras, discovered] = await Promise.all([
      countOf(site.pk, 'DEVICE#'),
      countOf(site.pk, 'CAMERA#'),
      countOf(site.pk, 'DISCOVERED#'),
    ]);
    return json(200, { tenantId, premisesId: query.premisesId, agents, cameras, discovered });
  }

  const premises = await queryPrefix<PremisesRecord>(key.tenant(tenantId), 'PREMISES#');
  const mine = premises.filter((p) => visible(caller, p.premisesId));
  return json(200, { tenantId, premises: mine.length });
}

/**
 * Finds something by name without knowing where it lives.
 *
 * Premises come from one partition and are matched anywhere in the name.
 * Cameras and agents are matched within a site when one is given, because that
 * is one partition too. Across the estate they are matched by prefix over a
 * bounded fan-out — searching every site on every keystroke is exactly the
 * read this rebuild removed, so this is meant for a deliberate search rather
 * than type-ahead.
 */
async function search(caller: Caller, query: Record<string, string | undefined> | undefined) {
  if (!can(caller, 'viewStreams')) return fail(403, 'Not permitted');
  const tenantId = readTenant(caller, query?.tenantId);
  if (!tenantId) return fail(403, 'Not permitted to act on that tenant');
  const needle = (query?.q ?? '').trim().toLowerCase();
  if (needle.length < 2) return fail(400, 'Search for at least two characters');

  const premises = (await queryPrefix<PremisesRecord>(key.tenant(tenantId), 'PREMISES#'))
    .filter((p) => visible(caller, p.premisesId))
    .filter((p) => `${p.displayName} ${p.premisesId}`.toLowerCase().includes(needle));

  // One site if named, otherwise a bounded sweep of the sites this caller can
  // see. The bound is what keeps a search from becoming a scan of the estate.
  const sites = query?.premisesId
    ? [query.premisesId]
    : (await queryPrefix<PremisesRecord>(key.tenant(tenantId), 'PREMISES#'))
        .filter((p) => visible(caller, p.premisesId))
        .map((p) => p.premisesId)
        .slice(0, 25);

  const found = await Promise.all(sites.map(async (premisesId) => {
    const pk = key.site(tenantId, premisesId);
    const [agents, cameras] = await Promise.all([
      queryPrefix<Record<string, unknown>>(pk, 'DEVICE#'),
      queryPrefix<CameraRecord>(pk, 'CAMERA#'),
    ]);
    return {
      agents: agents
        .filter((a) => `${a.siteName ?? ''} ${a.thingName ?? ''}`.toLowerCase().includes(needle))
        .map((a) => ({ thingName: a.thingName, siteName: a.siteName, premisesId })),
      cameras: cameras
        .filter((c) => `${c.displayName} ${c.cameraId}`.toLowerCase().includes(needle))
        .map((c) => ({
          identity: c.identity, cameraId: c.cameraId, displayName: c.displayName,
          assignedTo: c.assignedTo, premisesId,
        })),
    };
  }));

  return json(200, {
    premises: premises.map((p) => ({ premisesId: p.premisesId, displayName: p.displayName })).slice(0, 25),
    agents: found.flatMap((f) => f.agents).slice(0, 25),
    cameras: found.flatMap((f) => f.cameras).slice(0, 50),
    // Says plainly when the answer is partial, rather than looking complete.
    searchedSites: sites.length,
  });
}

// ----------------------------------------------------------------- cameras

async function listDiscovered(caller: Caller, premisesId?: string) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to list discovered cameras');
  const site = siteOf(caller, caller.tenantId, premisesId);
  if (site.refusal) return site.refusal;
  const [discovered, approved, agents] = await Promise.all([
    queryPrefix<DiscoveredRecord>(site.pk, 'DISCOVERED#'),
    queryPrefix<CameraRecord>(site.pk, 'CAMERA#'),
    queryPrefix<Record<string, unknown>>(site.pk, 'DEVICE#'),
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
        // The identity is derived from the MAC where one was readable, so
        // showing both makes the derivation visible rather than magic.
        identifiedBy: record.identity?.startsWith('mac-') ? 'mac'
          : record.identity?.startsWith('sn-') ? 'serial' : 'address',
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

  if (!CAMERA_IDENTITY.test(identity)) return fail(400, 'Invalid camera identity');
  const outOfScope = refuseOutOfScope(caller, assignedTo);
  if (outOfScope) return outOfScope;

  const record = await getRecord<DiscoveredRecord>(siteOfThing(assignedTo), key.discovered(identity));
  if (!record) return fail(404, 'No such discovered camera');
  // Assigning to an agent that cannot see it yields a stream that never starts.
  if (!Object.keys(record.reachableBy ?? {}).includes(assignedTo)) {
    return fail(400, `Agent ${assignedTo} cannot reach this camera`);
  }

  const camera: CameraRecord = {
    pk: siteOfThing(assignedTo), sk: key.camera(identity), identity,
    cameraId: typeof body.cameraId === 'string' && isValidId(body.cameraId) ? body.cameraId : slugFor(identity),
    displayName: String(body.displayName ?? record.model ?? identity).slice(0, 128),
    assignedTo,
    subProfileToken: body.subProfileToken ? String(body.subProfileToken) : undefined,
    mainProfileToken: body.mainProfileToken ? String(body.mainProfileToken) : undefined,
    sourceCodec: body.sourceCodec ? String(body.sourceCodec) : undefined,
    approvedAt: Math.floor(Date.now() / 1000), approvedBy: caller.email,
  };
  const previousOwner = (await getRecord<CameraRecord>(siteOfThing(assignedTo), key.camera(identity)))?.assignedTo;

  await ddb.send(new PutCommand({ TableName: TABLE, Item: camera }));
  await pushConfig(caller.tenantId, assignedTo);
  // Reassignment used to tell the new owner and nobody else. The old agent's
  // configVersion never moved, so it never refetched, never learned the camera
  // had been taken away, and went on publishing into the same S3 prefix the
  // new one now writes — two agents interleaving segments under one key, which
  // is the exact outcome single ownership exists to prevent.
  if (previousOwner && previousOwner !== assignedTo) {
    await pushConfig(caller.tenantId, previousOwner);
  }
  return json(200, { approved: camera.cameraId, assignedTo, reassignedFrom: previousOwner ?? null });
}

async function removeCamera(caller: Caller, identity: string | undefined, premisesId?: string) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted');
  const site = siteOf(caller, caller.tenantId, premisesId);
  if (site.refusal) return site.refusal;
  // Shaped like the identity approveCamera accepts. Without this an unbounded
  // path parameter reached a key expression unchecked.
  if (!identity || !CAMERA_IDENTITY.test(identity)) return fail(400, 'Invalid camera identity');

  const existing = await getRecord<CameraRecord>(site.pk, key.camera(identity));
  if (!existing) return fail(404, 'No such camera');
  // The scope check used to sit inside `if (assignedTo)`, so a record without
  // an owner was deleted by anyone in the tenant, and a 200 came back either
  // way whether or not anything had been there.
  const outOfScope = existing.assignedTo ? refuseOutOfScope(caller, existing.assignedTo) : null;
  if (outOfScope) return outOfScope;

  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { pk: site.pk, sk: key.camera(identity) },
  }));
  if (existing.assignedTo) await pushConfig(caller.tenantId, existing.assignedTo);
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
      pk: siteOfThing(thing), sk: key.credential(thing, scope),
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
    Key: { pk: siteOfThing(thing), sk: key.device(thing) },
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

  // Every page, not the first sixty. The cap was applied before the tenant
  // filter, so a tenant whose users sorted late saw an empty console — and
  // nothing said the list had been truncated.
  const found = [];
  let token: string | undefined;
  do {
    const page = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID, Limit: 60, PaginationToken: token,
    }));
    found.push(...(page.Users ?? []));
    token = page.PaginationToken;
  } while (token && found.length < 5000);

  const users = await Promise.all(found.map(async (user) => {
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
  if (!(await customerExists(tenantId))) {
    return fail(404, `No customer with the id "${tenantId}"`);
  }

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

/**
 * Removes an account, within the caller's own tenant.
 *
 * The tenant check is the point. Listing users has always been filtered by
 * tenant, but deleting one was not — so an administrator who knew or guessed
 * an address in another tenant could remove that account, up to and including
 * a superadmin. Usernames are email addresses, so the guess did not even have
 * to be an informed one.
 */
/**
 * Changes a user's role, the sites they may see, or both.
 *
 * The routes were create, list and delete. AdminRemoveUserFromGroup was
 * granted to this function and never called, so changing someone's role — or
 * moving them between sites, which the reasoning for making `custom:premises`
 * mutable calls routine — meant deleting the account and re-inviting it.
 *
 * The same guards as createUser, because this is the same decision made later:
 * only a superadmin may mint or unmake one, and nobody may grant access to a
 * premises they cannot see themselves.
 */
async function updateUser(caller: Caller, username: string | undefined, rawBody: string | undefined) {
  if (!can(caller, 'manageUsers')) return fail(403, 'Not permitted to manage users');
  if (!username) return fail(400, 'Username is required');

  let body: { role?: unknown; premises?: unknown };
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return fail(400, 'Body must be JSON');
  }

  const target = await cognito
    .send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }))
    .catch((err) => {
      if (err?.name === 'UserNotFoundException') return null;
      throw err;
    });
  if (!target) return fail(404, 'No such user');

  const targetTenantId = (target.UserAttributes ?? [])
    .find((attribute) => attribute.Name === 'custom:tenantId')?.Value;
  // Indistinguishable from absent, as in deleteUser: this must not become a
  // way to test whether an address exists in another tenant.
  if (!can(caller, 'crossTenant') && targetTenantId !== caller.tenantId) {
    return fail(404, 'No such user');
  }

  const held = (await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID, Username: username,
  }))).Groups ?? [];
  const wasSuperadmin = held.some((g) => g.GroupName === 'superadmin');
  if (wasSuperadmin && !can(caller, 'crossTenant')) {
    return fail(403, 'Only a superadmin may change a superadmin');
  }

  const changed: Record<string, unknown> = {};

  if (body.role !== undefined) {
    const role = String(body.role) as Role;
    if (!(ROLES as readonly string[]).includes(role)) {
      return fail(400, `role must be one of ${ROLES.join(', ')}`);
    }
    if (role === 'superadmin' && !can(caller, 'crossTenant')) {
      return fail(403, 'Only a superadmin may create a superadmin');
    }
    // Every role is removed before the new one is added, or an account that
    // was demoted would keep whichever of its old groups outranked the new.
    for (const group of held) {
      if (group.GroupName && group.GroupName !== role) {
        await cognito.send(new AdminRemoveUserFromGroupCommand({
          UserPoolId: USER_POOL_ID, Username: username, GroupName: group.GroupName,
        }));
      }
    }
    if (!held.some((g) => g.GroupName === role)) {
      await cognito.send(new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID, Username: username, GroupName: role,
      }));
    }
    changed.role = role;
  }

  if (body.premises !== undefined) {
    const requested = Array.isArray(body.premises)
      ? body.premises.filter((p): p is string => typeof p === 'string' && isValidId(p))
      : [];
    const beyond = requested.filter((p) => !visible(caller, p));
    if (beyond.length > 0) {
      return fail(403, `You cannot grant access to: ${beyond.join(', ')}`);
    }
    // A restricted administrator must not be able to lift someone else's
    // restriction, which clearing the list would do.
    if (requested.length === 0 && caller.premises.length > 0) {
      return fail(403, 'Restricted accounts cannot grant access to every premises');
    }
    await cognito.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID, Username: username,
      UserAttributes: [{ Name: 'custom:premises', Value: requested.join(',') }],
    }));
    changed.premises = requested;
  }

  if (Object.keys(changed).length === 0) {
    return fail(400, 'Nothing to change — supply role, premises, or both');
  }
  return json(200, { updated: username, ...changed });
}

async function deleteUser(caller: Caller, username: string | undefined) {
  if (!can(caller, 'manageUsers')) return fail(403, 'Not permitted to manage users');
  if (!username) return fail(400, 'Username is required');
  // Locking yourself out of your own tenant would need AWS console access to undo.
  if (username === caller.email || username === caller.sub) {
    return fail(400, 'You cannot delete your own account');
  }

  const target = await cognito
    .send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }))
    .catch((err) => {
      if (err?.name === 'UserNotFoundException') return null;
      throw err;
    });
  // Absent and forbidden are the same answer, so this cannot be used to test
  // whether an address exists in another tenant.
  if (!target) return fail(404, 'No such user');

  const targetTenant = (target.UserAttributes ?? [])
    .find((attribute) => attribute.Name === 'custom:tenantId')?.Value;
  if (!can(caller, 'crossTenant') && targetTenant !== caller.tenantId) {
    return fail(404, 'No such user');
  }

  // An admin removing the platform operator from their own tenant would be a
  // customer evicting the vendor; only another superadmin may do that.
  const targetGroups = await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID, Username: username,
  }));
  const targetIsSuperadmin = (targetGroups.Groups ?? []).some((g) => g.GroupName === 'superadmin');
  if (targetIsSuperadmin && !can(caller, 'crossTenant')) {
    return fail(403, 'Only a superadmin may remove a superadmin');
  }

  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
  return json(200, { deleted: username });
}
