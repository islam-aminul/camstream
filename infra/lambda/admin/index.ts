import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand, UpdateCommand, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { SNSClient, ListSubscriptionsByTopicCommand, SubscribeCommand, UnsubscribeCommand }
  from '@aws-sdk/client-sns';
import {
  IoTClient, ListThingPrincipalsCommand, DetachThingPrincipalCommand, ListAttachedPoliciesCommand,
  DetachPolicyCommand, UpdateCertificateCommand, DeleteCertificateCommand, DeleteThingCommand,
} from '@aws-sdk/client-iot';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  CognitoIdentityProviderClient, ListUsersCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminGetUserCommand,
  AdminAddUserToGroupCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand, AdminEnableUserCommand, AdminDisableUserCommand,
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
import { key, slugFor, DEFAULT_MAX_TRANSCODES, MAX_CONCURRENT_TRANSCODES, queryAllPages, encodeCursor, decodeCursor, REGISTRY_PK, type CameraRecord, type CustomerRecord, type DiscoveredRecord, type PremisesRecord } from '../shared/registry';
import { buildInstaller, buildInstallerArchive, bundleUrl, bundleFacts, isPlatform, PLATFORMS,
  BUNDLE_EXTENSION, BUNDLE_FORMATS, isBundleFormat } from './installer';

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
const sns = new SNSClient({});
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
          event.queryStringParameters?.platform, event.queryStringParameters);
      case 'GET /api/admin/discovered':  return await listDiscovered(caller,
          event.queryStringParameters?.premisesId, event.queryStringParameters?.tenantId);
      case 'POST /api/admin/cameras':    return await approveCamera(caller, event.body);
      case 'GET /api/admin/alerts':      return await listAlertRecipients(caller);
      case 'POST /api/admin/alerts':     return await addAlertRecipient(caller, event.body);
      case 'DELETE /api/admin/alerts':
        return await removeAlertRecipient(caller, event.queryStringParameters?.arn);
      case 'POST /api/admin/cameras/move':
        return await moveCameras(caller, event.body);
      case 'PATCH /api/admin/cameras/{identity}':
        return await renameCamera(caller, event.pathParameters?.identity, event.body);
      case 'DELETE /api/admin/cameras/{identity}':
        return await removeCamera(caller, event.pathParameters?.identity,
          event.queryStringParameters?.premisesId, event.queryStringParameters?.tenantId);
      case 'GET /api/admin/credentials': return await listCredentials(caller,
          event.queryStringParameters?.thingName);
      case 'POST /api/admin/credentials':return await storeCredential(caller, event.body);
      case 'DELETE /api/admin/credentials':
        return await removeCredential(caller, event.queryStringParameters?.thingName,
          event.queryStringParameters?.scope);
      case 'POST /api/admin/scan':       return await triggerScan(caller, event.body);
      case 'POST /api/admin/agents/{thingName}/update':
        return await upgradeAgent(caller, event.pathParameters?.thingName, event.body);
      case 'GET /api/admin/users':       return await listUsers(caller, event.queryStringParameters);
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

function queryPrefix<T>(pk: string, prefix: string, projection?: string): Promise<T[]> {
  return queryAllPages<T>(
    (input) => ddb.send(new QueryCommand(input)), TABLE, pk, prefix, projection);
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
 *
 * Measured, because the premise above is the whole argument and premises rot.
 * At a hundred cameras in a site — the shape this is sold at, ten thousand
 * cameras across a hundred sites — every read here is about 120ms, and a page
 * of sixteen costs the same as a page of two hundred, which is the point.
 *
 * The cost is linear in the size of the *site*, not the estate. Ten thousand
 * cameras in one site takes the same read to about 1.5s, because the partition
 * is then some two megabytes and arrives over several round trips. That is the
 * boundary: sites of a few hundred are comfortable, and a site of thousands
 * wants a secondary index on the name so a page can be fetched rather than
 * filtered. Splitting such a site across premises is the cheaper answer, and
 * is what the partitioning already assumes.
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
  const [devices, health, cameras] = await Promise.all([
    queryPrefix<Record<string, unknown>>(site.pk, 'DEVICE#'),
    // Health stays partitioned by customer: the IoT rule that writes it builds
    // its key in SQL and cannot cut a thing name at the second separator.
    queryPrefix<Record<string, unknown>>(key.tenant(forTenant), 'HEALTH#'),
    // Assignments, which is what capacity is actually measured against. Only
    // the owning agent is read: the rest of a camera record is several times
    // its size, and this walks every camera at the site to count them.
    queryPrefix<CameraRecord>(site.pk, 'CAMERA#', 'assignedTo'),
  ]);
  const healthOf = new Map(health.map((h) => [String(h.thingName), h]));

  // How many cameras each agent has been given, as opposed to how many it has
  // got round to telling us about. An agent that has never connected reports
  // nothing, so reading its own figure showed an agent carrying three hundred
  // cameras as empty — and the console uses this to warn before the ceiling.
  const assigned = new Map<string, number>();
  for (const camera of cameras) {
    const owner = String(camera.assignedTo ?? '');
    assigned.set(owner, (assigned.get(owner) ?? 0) + 1);
  }
  const page = paginate(devices.filter((d) => visible(caller, d.premisesId as string | undefined)), {
    q: query?.q,
    sortBy: (d) => String(d.siteName ?? d.thingName ?? ''),
    cursor: query?.cursor,
    limit: query?.limit,
  });
  return json(200, {
    total: page.total,
    cursor: page.cursor,
    /**
     * The build an Update would install.
     *
     * Sent once for the page rather than per agent, because it is a property
     * of the control plane and not of any agent. Without it the console can
     * show what each agent is running but cannot say whether that is current,
     * so the only way to find out was to press Update and see whether
     * anything changed.
     */
    currentVersion: AGENT_VERSION,
    agents: page.items
      .map((device) => ({
        thingName: device.thingName,
        premisesId: device.premisesId,
        siteName: device.siteName,
        agentVersion: device.agentVersion,
        cameraCount: assigned.get(String(device.thingName)) ?? 0,
        // What the agent itself last said it was handling. Differs from the
        // assignment while it is catching up, and staying different while it
        // is connected is the interesting case.
        reportedCameras: Number(device.cameraCount ?? 0),
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
        // What the agent was configured to allow. What it is actually
        // honouring can be lower, and comes back on the health record — a
        // machine under pressure lowers its own cap.
        maxConcurrentTranscodes: Number(device.maxConcurrentTranscodes ?? DEFAULT_MAX_TRANSCODES),
        // How far this machine's clock is from the control plane's, measured
        // server-side on its last report. Null when it has never said, which
        // must not read as zero: zero is the answer that means all is well.
        clockSkewSeconds: typeof device.clockSkewSeconds === 'number'
          ? device.clockSkewSeconds : null,
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
  if (!Number.isInteger(cap) || (cap as number) < 0 || (cap as number) > MAX_CONCURRENT_TRANSCODES) {
    return fail(400,
      `maxConcurrentTranscodes must be a whole number between 0 and ${MAX_CONCURRENT_TRANSCODES}`);
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
  await pushConfig(thing);

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
  if (!isCredentialScope(target)) return fail(400, 'Invalid scope');

  const existing = await getRecord<Record<string, unknown>>(
    siteOfThing(thing), key.credential(thing, target));
  if (!existing) return fail(404, 'No credential stored for that scope');

  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { pk: siteOfThing(thing), sk: key.credential(thing, target) },
  }));
  // The agent replaces its whole relayed set from the config it fetches, so
  // bumping the version is what actually revokes this on the edge box.
  await pushConfig(thing);
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
    /**
     * Which resource is binding, and what to do about it.
     *
     * The agent decides this, because it is the only thing that can see the
     * machine. It arrives as a sentence rather than a set of thresholds so the
     * console does not have to re-derive a judgement the agent already made
     * with better information.
     */
    constraint: typeof record.constraint === 'string' ? record.constraint : 'none',
    constraintMessage:
      typeof record.constraintMessage === 'string' ? record.constraintMessage : null,
    /** The numbers behind it, so a healthy agent's headroom is visible too. */
    resources: {
      cpuLoad: numberOrNull(record.cpuLoad),
      memoryUsedFraction: numberOrNull(record.memoryUsedFraction),
      memoryFreeBytes: numberOrNull(record.memoryFreeBytes),
      diskFreeBytes: numberOrNull(record.diskFreeBytes),
      uploadBytesPerSecond: numberOrNull(record.uploadBytesPerSecond),
      uploadMillisPerSegment: numberOrNull(record.uploadMillisPerSegment),
    },
  };
}

/** A reading the agent omitted stays absent rather than becoming a zero. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  let usable = tokens
    .filter((t) => t.thingName === thing && !t.usedAt && Number(t.expiresAt) > now)
    .sort((a, b) => Number(b.issuedAt) - Number(a.issuedAt))[0];
  if (!usable) {
    // The installer *is* the enrolment: asking for one is asking for a token,
    // and refusing because the last one was spent told an administrator to go
    // and perform, by hand, the thing they had just asked for. A token is
    // one-use and short-lived, so issuing a fresh one here is the same act as
    // issuing the first.
    const token = randomBytes(32).toString('base64url');
    const issuedAt = Math.floor(Date.now() / 1000);
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        pk: key.tenant(tenantId), sk: key.enrollment(token),
        token, thingName: thing, premisesId,
        issuedAt, issuedBy: caller.email,
        expiresAt: issuedAt + ENROLLMENT_TTL_SECONDS,
      },
    }));
    usable = { token, thingName: thing, premisesId, issuedAt,
      expiresAt: issuedAt + ENROLLMENT_TTL_SECONDS } as Record<string, unknown>;
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
async function agentInstaller(
  caller: Caller,
  thing: string | undefined,
  platform: unknown,
  query?: Record<string, string | undefined>,
) {
  if (!isPlatform(platform)) {
    return fail(400, `platform must be one of ${PLATFORMS.join(', ')}`);
  }
  const identity = await agentIdentity(caller, thing);
  if (identity.statusCode !== 200) {
    return identity;
  }

  const parsed = JSON.parse(identity.body ?? '{}');

  // A folder by default. A bare script is awkward to carry to a machine: it
  // cannot be double-clicked, the execution policy is against it, and it says
  // nothing about the runtime archives the operator still has to supply. The
  // raw form stays available for anyone driving this from a script.
  if (query?.format !== 'raw') {
    const archive = await buildInstallerArchive(platform, parsed, LIVE_BUCKET, AGENT_VERSION);
    return {
      statusCode: 200,
      headers: {
        'content-type': archive.contentType,
        'content-disposition': `attachment; filename="${archive.filename}"`,
        'cache-control': 'no-store',
      },
      // Binary has to travel base64 and be decoded by API Gateway; sending it
      // as a string would corrupt every byte above 127 in the archive.
      isBase64Encoded: true,
      body: archive.body.toString('base64'),
    };
  }

  const installer = await buildInstaller(platform, parsed, LIVE_BUCKET, AGENT_VERSION);

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
/**
 * A codec name off the live record, which is typed as unknown here.
 *
 * The device lambda already bounds and lowercases this on the way in; the
 * narrowing is so the value can be used, not a second validation. Anything
 * unexpected becomes absent rather than a string the console would render as
 * though a camera had reported it.
 */
function codec(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * One row of the cameras listing: what was approved, plus what the agent
 * holding it last reported.
 *
 * Separated out because the interesting part is the join, and it was wrong.
 * A codec is only ever written to the live record - the agent learns it from
 * ffprobe once a stream runs - while the listing read it from the approved
 * record, which only carries one if it happened to be known at approval time.
 * At approval nothing has looked at the stream yet, so it never is, and the
 * console showed an empty column for every camera forever.
 */
export function cameraRow(c: CameraRecord, seen: Record<string, unknown> | undefined) {
  return {
    identity: c.identity,
    cameraId: c.cameraId,
    displayName: c.displayName,
    assignedTo: c.assignedTo,
    // When it entered service, and who put it there. Until now the console
    // could not answer "how long has this been here" about anything at all.
    approvedAt: typeof c.approvedAt === 'number' ? c.approvedAt : null,
    approvedBy: c.approvedBy ?? null,
    // The approved record wins when it has one: an operator who set it meant
    // it, and should not be overruled by what a stream happened to report.
    sourceCodec: c.sourceCodec ?? codec(seen?.sourceCodec) ?? null,
    // Presence of a live record is what publishing means; it expires on its
    // own when an agent stops reporting.
    publishing: seen !== undefined,
  };
}

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
  /**
   * What each agent last reported about the cameras it holds.
   *
   * Kept as a map rather than a set of keys because the live record carries
   * more than the fact of publishing: the codec, its profile and the frame
   * size all arrive here from ffprobe, and this is the only place they are
   * written. Reading only the approved record meant the console asked for a
   * codec that nothing ever put there.
   */
  const reported = new Map(live.map((c) => [`${c.thingName}/${c.cameraId}`, c]));

  const rows = approved
    // Narrowing by agent is the rail's second dropdown feeding the third.
    .filter((c) => !query?.agentId || c.assignedTo === query.agentId)
    // An exact id, for the live view showing one chosen camera on its own.
    // Distinct from `q`, which is a substring of the display name: searching
    // for the name would match every camera that happens to contain it, and
    // choosing a camera in the rail means that camera and no other.
    .filter((c) => !query?.cameraId || c.cameraId === query.cameraId)
    .map((c) => cameraRow(c, reported.get(`${c.assignedTo}/${c.cameraId}`)))
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

async function listDiscovered(caller: Caller, premisesId?: string, requestedTenant?: string) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to list discovered cameras');
  // The caller's own tenant is not the tenant being looked at. The platform
  // operator selects a customer in the console, and reading their own instead
  // queried an empty partition: cameras were found, written and waiting, and
  // the page said nothing had been found yet.
  const forTenant = readTenant(caller, requestedTenant);
  if (!forTenant) return fail(403, 'Not permitted to act on that tenant');
  const site = siteOf(caller, forTenant, premisesId);
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
  await pushConfig(assignedTo);
  // Reassignment used to tell the new owner and nobody else. The old agent's
  // configVersion never moved, so it never refetched, never learned the camera
  // had been taken away, and went on publishing into the same S3 prefix the
  // new one now writes — two agents interleaving segments under one key, which
  // is the exact outcome single ownership exists to prevent.
  if (previousOwner && previousOwner !== assignedTo) {
    await pushConfig(previousOwner);
    // And take the old owner's live record with it, for the same reason as in
    // moveCameras: it is what /api/streams hands a player, and it would point
    // at a prefix the previous agent has stopped writing.
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { pk: siteOfThing(assignedTo), sk: key.liveCamera(previousOwner, camera.cameraId) },
    }));
  }
  return json(200, { approved: camera.cameraId, assignedTo, reassignedFrom: previousOwner ?? null });
}

// ------------------------------------------------------------------- alerts

/**
 * Who is emailed when the control plane raises an alarm.
 *
 * Platform-wide, so superadmin only: these alarms are about this deployment
 * failing - a wedged lambda, a throttled table, no agent heartbeats anywhere -
 * and not about any one customer's cameras. A customer administrator has no
 * business reading them and would only be confused by them.
 *
 * Managed here rather than in the stack because who is on call is runtime
 * state. It used to be a CDK context value, which made changing the address a
 * deploy - impossible for the person holding a phone at midnight, and it put a
 * shared mailbox in a public repository.
 */
const ALARM_TOPIC_ARN = process.env.ALARM_TOPIC_ARN ?? '';

function alertsUnavailable(): APIGatewayProxyStructuredResultV2 | null {
  return ALARM_TOPIC_ARN ? null : fail(503, 'No alarm topic is configured for this deployment');
}

async function listAlertRecipients(caller: Caller) {
  if (!can(caller, 'crossTenant')) return fail(403, 'Not permitted to manage alerts');
  const unavailable = alertsUnavailable();
  if (unavailable) return unavailable;

  const recipients: { endpoint: string; protocol: string; confirmed: boolean; arn: string }[] = [];
  let token: string | undefined;
  do {
    const page = await sns.send(new ListSubscriptionsByTopicCommand({
      TopicArn: ALARM_TOPIC_ARN, NextToken: token,
    }));
    for (const subscription of page.Subscriptions ?? []) {
      const arn = subscription.SubscriptionArn ?? '';
      recipients.push({
        endpoint: subscription.Endpoint ?? '',
        protocol: subscription.Protocol ?? '',
        // Until the recipient clicks the link AWS sends, the "ARN" is the
        // literal string PendingConfirmation and nothing is delivered. Saying
        // so is the whole point of showing this list: a subscription that
        // exists is not the same as somebody being told.
        confirmed: arn.startsWith('arn:'),
        arn,
      });
    }
    token = page.NextToken;
  } while (token);

  recipients.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  return json(200, { topicArn: ALARM_TOPIC_ARN, recipients });
}

async function addAlertRecipient(caller: Caller, rawBody: string | undefined) {
  if (!can(caller, 'crossTenant')) return fail(403, 'Not permitted to manage alerts');
  const unavailable = alertsUnavailable();
  if (unavailable) return unavailable;

  let body: { email?: unknown };
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return fail(400, 'Body must be JSON');
  }

  const email = String(body.email ?? '').trim();
  // Deliberately loose. The authority on whether an address exists is whether
  // the confirmation mail arrives, and a stricter pattern here would refuse
  // valid addresses while still not proving anything about invalid ones.
  if (email.length < 6 || email.length > 254 || !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) {
    return fail(400, 'That does not look like an email address');
  }

  await sns.send(new SubscribeCommand({
    TopicArn: ALARM_TOPIC_ARN,
    Protocol: 'email',
    Endpoint: email,
    ReturnSubscriptionArn: true,
  }));

  // Not "subscribed": AWS has sent a confirmation link and will deliver
  // nothing until it is clicked. Reporting success here would be a lie the
  // operator only discovers during an incident.
  return json(202, { pending: email });
}

async function removeAlertRecipient(caller: Caller, requested: string | undefined) {
  if (!can(caller, 'crossTenant')) return fail(403, 'Not permitted to manage alerts');
  const unavailable = alertsUnavailable();
  if (unavailable) return unavailable;

  // A query parameter rather than a body: DELETE with a body is awkward
  // through API Gateway and adds nothing here, since the subscription ARN is
  // the whole request.
  const arn = String(requested ?? '');
  // Must be a subscription of this topic and nothing else: the ARN arrives
  // from the client, and sns:Unsubscribe cannot be scoped to one topic by IAM
  // alone because a subscription ARN is not the topic ARN.
  if (!arn.startsWith(`${ALARM_TOPIC_ARN}:`)) {
    return fail(400, 'That subscription does not belong to this alarm topic');
  }

  await sns.send(new UnsubscribeCommand({ SubscriptionArn: arn }));
  return json(200, { removed: arn });
}

/**
 * Moves cameras between the agents of one premises, all or nothing.
 *
 * A move is one entry and a swap is two, which is why this takes a list rather
 * than a single camera. Two cameras exchanging agents cannot be done as two
 * requests: the first would succeed, the second could fail its reachability
 * check, and the estate would be left in a state nobody asked for - both
 * cameras on one agent, one of them dark. DynamoDB applies the whole set or
 * none of it.
 *
 * Reassignment already existed inside approveCamera, but only as a side effect
 * of re-approving, which meant re-stating a camera's name and profile tokens to
 * change the one field being changed. This does only the thing it says.
 *
 * Every agent that gains or loses a camera is told. That matters more than it
 * looks: an agent that is not told goes on publishing into the same S3 prefix
 * the new owner now writes, and two agents interleaving segments under one key
 * is exactly what single ownership exists to prevent.
 */
async function moveCameras(caller: Caller, rawBody: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to move cameras');

  let body: { moves?: unknown; premisesId?: unknown; tenantId?: unknown };
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return fail(400, 'Body must be JSON');
  }

  const raw = Array.isArray(body.moves) ? body.moves : [];
  if (raw.length === 0) return fail(400, 'moves must be a non-empty array');
  // The transaction limit is 100; a premises-wide reshuffle should be several
  // requests rather than one that half-applies at an unpredictable boundary.
  if (raw.length > 25) return fail(400, 'at most 25 moves at a time');

  const moves = raw.map((entry) => {
    const move = entry as { identity?: unknown; assignedTo?: unknown };
    return { identity: String(move.identity ?? ''), assignedTo: String(move.assignedTo ?? '') };
  });
  for (const move of moves) {
    if (!CAMERA_IDENTITY.test(move.identity)) return fail(400, `Invalid camera identity: ${move.identity}`);
    if (!isThingName(move.assignedTo)) return fail(400, `Invalid agent name: ${move.assignedTo}`);
  }
  if (new Set(moves.map((m) => m.identity)).size !== moves.length) {
    return fail(400, 'the same camera appears twice');
  }

  const forTenant = readTenant(caller, typeof body.tenantId === 'string' ? body.tenantId : undefined);
  if (!forTenant) return fail(403, 'Not permitted to act on that tenant');
  const site = siteOf(caller, forTenant, typeof body.premisesId === 'string' ? body.premisesId : undefined);
  if (site.refusal) return site.refusal;

  // Cameras move between the agents of one premises. Across premises the S3
  // prefix, the video cookie and the viewer's scope all change, so it is a
  // different operation and not one to reach by accident.
  for (const move of moves) {
    const target = parseThingName(move.assignedTo)!;
    if (key.site(target.tenantId, target.premisesId) !== site.pk) {
      return fail(400, `${move.assignedTo} is not an agent of this premises`);
    }
    const outOfScope = refuseOutOfScope(caller, move.assignedTo);
    if (outOfScope) return outOfScope;
  }

  const touched = new Set<string>();
  const stale: { pk: string; sk: string }[] = [];
  for (const move of moves) {
    const camera = await getRecord<CameraRecord>(site.pk!, key.camera(move.identity));
    if (!camera) return fail(404, `No such camera: ${move.identity}`);
    // An agent that cannot see the camera cannot publish it, so the move would
    // produce a tile that never starts and no explanation of why.
    const discovered = await getRecord<DiscoveredRecord>(site.pk!, key.discovered(move.identity));
    if (!Object.keys(discovered?.reachableBy ?? {}).includes(move.assignedTo)) {
      return fail(400,
        `${move.assignedTo} cannot reach ${camera.displayName || move.identity}. `
        + 'Only an agent that has discovered a camera can publish it.');
    }
    touched.add(camera.assignedTo);
    touched.add(move.assignedTo);
    if (camera.assignedTo !== move.assignedTo) {
      // The record that tells a viewer where to fetch this camera is written
      // per agent, so the previous owner's copy has to go with the camera.
      // Left behind it is not merely untidy: /api/streams returns it, the
      // player follows it, and every segment request 403s against a prefix
      // nobody is writing any more. An agent that is still running clears its
      // own on the next report - but a moved camera is very often one whose
      // agent has stopped, which is why it was moved.
      stale.push({ pk: site.pk!, sk: key.liveCamera(camera.assignedTo, camera.cameraId) });
    }
  }

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      ...moves.map((move) => ({
        Update: {
          TableName: TABLE,
          Key: { pk: site.pk!, sk: key.camera(move.identity) },
          UpdateExpression: 'SET assignedTo = :to',
          ExpressionAttributeValues: { ':to': move.assignedTo },
          // The record was read a moment ago; this refuses a camera deleted in
          // between rather than recreating it as a fragment.
          ConditionExpression: 'attribute_exists(sk)',
        },
      })),
      // In the same transaction as the move itself. Done afterwards, a failure
      // between the two would leave a camera owned by one agent and advertised
      // from another, which is the state this is here to prevent.
      ...stale.map((key_) => ({ Delete: { TableName: TABLE, Key: key_ } })),
    ],
  }));

  // After the writes, so an agent cannot fetch a configuration describing a
  // state the transaction then failed to reach.
  await Promise.all([...touched].map((thing) => pushConfig(thing)));

  return json(200, { moved: moves.length, agentsNotified: [...touched].sort() });
}

/**
 * Renames a camera.
 *
 * The name is the only thing about a camera an operator chooses, and until
 * this existed it could only be chosen once, at approval, from whatever the
 * device happened to say about itself. A camera that said nothing was approved
 * as its own MAC address and stayed that way, so a wall of tiles read
 * "mac-2818fdf1e5be" where it should have read "Front Gate".
 *
 * Deliberately only the name. Identity, assignment and profiles are what the
 * stream is built from; letting a rename touch them would make a typing
 * mistake capable of stopping a camera.
 */
async function renameCamera(caller: Caller, identity: string | undefined, rawBody: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted to rename cameras');
  if (!identity || !CAMERA_IDENTITY.test(identity)) return fail(400, 'Invalid camera identity');

  let body: { displayName?: unknown; premisesId?: unknown; tenantId?: unknown };
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return fail(400, 'Body must be JSON');
  }

  const displayName = String(body.displayName ?? '').trim();
  // The same rule as every other name in the system: no double hyphens, no
  // double spaces. Thing names are built by joining on "--", so a name
  // carrying one would produce an identifier that cannot be taken apart again.
  if (!isValidDisplayName(displayName)) {
    return fail(400,
      'displayName must be 3-64 characters of letters, digits, single spaces and single hyphens, '
      + 'with no double hyphens and no double spaces');
  }

  const forTenant = readTenant(caller, typeof body.tenantId === 'string' ? body.tenantId : undefined);
  if (!forTenant) return fail(403, 'Not permitted to act on that tenant');
  const site = siteOf(caller, forTenant, typeof body.premisesId === 'string' ? body.premisesId : undefined);
  if (site.refusal) return site.refusal;

  const existing = await getRecord<CameraRecord>(site.pk!, key.camera(identity));
  if (!existing) return fail(404, 'No such camera');
  const outOfScope = refuseOutOfScope(caller, existing.assignedTo);
  if (outOfScope) return outOfScope;

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: site.pk!, sk: key.camera(identity) },
    UpdateExpression: 'SET displayName = :name',
    ExpressionAttributeValues: { ':name': displayName },
  }));
  // The agent labels its own logs and its ffmpeg processes with this, so it
  // should hear about it rather than keep using the name it was given once.
  await pushConfig(existing.assignedTo);

  return json(200, { identity, displayName, assignedTo: existing.assignedTo });
}

async function removeCamera(
  caller: Caller,
  identity: string | undefined,
  premisesId?: string,
  requestedTenant?: string,
) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted');
  const forTenant = readTenant(caller, requestedTenant);
  if (!forTenant) return fail(403, 'Not permitted to act on that tenant');
  const site = siteOf(caller, forTenant, premisesId);
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
  if (existing.assignedTo) await pushConfig(existing.assignedTo);
  return json(200, { removed: identity });
}

/**
 * The scopes a credential may be filed under.
 *
 * "*" is the first site-wide slot and "*-2" to "*-5" are the rest: a site
 * commonly has more than one account in use across its cameras, and the
 * installer's ordering is a judgement about which is most likely to work. Five
 * is a cap on how many refusals a scan will provoke before giving up, which
 * matters on devices that lock an account out after a handful.
 *
 * Anything else names a single camera by its identity.
 */
const SITE_WIDE_SCOPE = /^\*(-[2-5])?$/;

export const MAX_SITE_CREDENTIALS = 5;

function isCredentialScope(scope: string): boolean {
  return SITE_WIDE_SCOPE.test(scope) || /^[A-Za-z0-9._-]{3,64}$/.test(scope);
}

/**
 * What is filed against an agent, without any of the secrets.
 *
 * Returns the account names and when they were set, never the ciphertext: the
 * console needs to show what is configured so it can be corrected, and nothing
 * here needs the password to do that.
 */
async function listCredentials(caller: Caller, thingName: string | undefined) {
  if (!can(caller, 'manageCredentials')) return fail(403, 'Not permitted to manage credentials');
  const thing = String(thingName ?? '');
  const outOfScope = refuseOutOfScope(caller, thing);
  if (outOfScope) return outOfScope;

  const rows = await queryPrefix<Record<string, unknown>>(
    siteOfThing(thing), `CREDENTIAL#${thing}#`);

  return json(200, {
    thingName: thing,
    maxSiteCredentials: MAX_SITE_CREDENTIALS,
    credentials: rows
      .map((row) => ({
        scope: String(row.scope ?? '*'),
        username: typeof row.username === 'string' ? row.username : null,
        storedAt: row.storedAt ?? null,
        storedBy: row.storedBy ?? null,
        siteWide: SITE_WIDE_SCOPE.test(String(row.scope ?? '*')),
      }))
      .sort((a, b) => a.scope.localeCompare(b.scope)),
  });
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
  if (!isCredentialScope(scope)) return fail(400, 'Invalid scope');

  // The account name travels in the clear, on purpose. It is not the secret -
  // the password is - and without it the console can only offer "a credential
  // is set", which cannot be reviewed, corrected or told apart from the other
  // four.
  const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';

  // There is deliberately no route that returns a credential: this API is a
  // courier for ciphertext it has no key to open.
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: siteOfThing(thing), sk: key.credential(thing, scope),
      thingName: thing, scope, ciphertext, username,
      storedAt: Math.floor(Date.now() / 1000), storedBy: caller.email,
    },
  }));
  await pushConfig(thing);
  return json(200, { stored: scope, thingName: thing });
}

/**
 * Tells an agent to install a build and restart into it.
 *
 * The alternative is walking to every site, which stops scaling at the second
 * one. The instruction carries a presigned link rather than a bare version so
 * the agent needs no credentials of its own to fetch it, and the link expires
 * — an instruction replayed a week later reaches a URL that no longer works.
 *
 * The agent decides whether to act: it refuses a version it is already
 * running, a version that is not a version, and a URL that is not this
 * bucket. Sending the instruction is not the same as it being obeyed, which
 * is the right way round for something that replaces a program.
 */
async function upgradeAgent(caller: Caller, thing: string | undefined, rawBody: string | undefined) {
  if (!can(caller, 'manageEstate')) return fail(403, 'Not permitted');
  if (!isThingName(thing)) return fail(400, 'Invalid agent name');
  const outOfScope = refuseOutOfScope(caller, thing);
  if (outOfScope) return outOfScope;

  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const platform = typeof body.platform === 'string' ? body.platform : 'linux';
  if (!isPlatform(platform)) {
    return fail(400, `platform must be one of ${PLATFORMS.join(', ')}`);
  }
  // The version this control plane is currently publishing. Naming it in the
  // instruction is what lets the agent refuse to reinstall what it is running.
  const version = typeof body.version === 'string' && body.version ? body.version : AGENT_VERSION;

  // Almost always the current format. The exception is migrating a fleet off
  // an old one: an agent built before the formats were unified reads zip and
  // nothing else, so pointing it at a tarball fails on the archive header and
  // it stays on the old build for ever - unable to take the very update that
  // would teach it the new format. Naming the old format here is how such an
  // agent is brought forward without somebody driving to it.
  const format = body.format === undefined ? BUNDLE_EXTENSION : body.format;
  if (!isBundleFormat(format)) {
    return fail(400, `format must be one of ${BUNDLE_FORMATS.join(', ')}`);
  }

  const [url, facts] = await Promise.all([
    bundleUrl(LIVE_BUCKET, platform, version, format),
    bundleFacts(LIVE_BUCKET, platform, version, format),
  ]);
  const build = facts.build;

  await iot.send(new PublishCommand({
    topic: `camstream/${thing}/command`, qos: 1,
    payload: Buffer.from(JSON.stringify({
      action: 'update', version, build, url, issuedAt: Math.floor(Date.now() / 1000),
      // Absent on a bundle that did not go through publish-agent.sh, which
      // an agent from 0.1.7 on refuses outright rather than installing.
      signature: facts.signature, keyId: facts.keyId,
    })),
  }));
  return json(200, { requested: 'update', thingName: thing, version, build, format });
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
/**
 * Bumps an agent's config version and tells it.
 *
 * Takes only the thing name, which already encodes the tenant and premises.
 * It used to take a tenant as well and ignore it, which meant five call sites
 * passing `caller.tenantId` into a parameter that did nothing - and reading as
 * though the caller's own tenant were the right answer, which elsewhere in
 * this file it was not.
 */
async function pushConfig(thing: string): Promise<void> {
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

async function listUsers(caller: Caller, query: Record<string, string | undefined> | undefined) {
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

  const rows = found
    .map((user) => {
      const attributes = Object.fromEntries((user.Attributes ?? []).map((a) => [a.Name, a.Value]));
      return {
        username: user.Username!,
        email: attributes.email ?? '',
        tenantId: attributes['custom:tenantId'],
        premises: attributes['custom:premises'] ?? '',
        status: user.UserStatus,
        enabled: user.Enabled,
      };
    })
    .filter((u) => can(caller, 'crossTenant') || u.tenantId === caller.tenantId);

  const page = paginate(rows as unknown as Record<string, unknown>[], {
    q: query?.q,
    sortBy: (u) => String(u.email ?? u.username ?? ''),
    cursor: query?.cursor,
    limit: query?.limit,
  });

  // Roles are read for the page, not the pool. Each one is its own Cognito
  // call, and at the five hundred users this is sold for, asking for all of
  // them at once put five hundred parallel requests into a quota measured in
  // tens per second — the list got slower the more it had to show, which is
  // exactly backwards.
  const users = await Promise.all(page.items.map(async (row) => {
    const groups = await cognito.send(new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID, Username: String(row.username),
    }));
    const held = (groups.Groups ?? []).map((g) => g.GroupName).filter((g): g is Role =>
      (ROLES as readonly string[]).includes(g ?? ''));
    return { ...row, role: held[0] ?? 'viewer' };
  }));

  return json(200, { total: page.total, cursor: page.cursor, users });
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

  let body: { role?: unknown; premises?: unknown; enabled?: unknown };
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

  if (body.enabled !== undefined) {
    const enabled = body.enabled === true;
    // Locking yourself out of the console you administer is not something to
    // discover after the fact, and there may be no one else who can undo it.
    if (!enabled && username === caller.sub) {
      return fail(400, 'You cannot disable your own account');
    }
    await cognito.send(enabled
      ? new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: username })
      : new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    changed.enabled = enabled;
  }

  if (Object.keys(changed).length === 0) {
    return fail(400, 'Nothing to change — supply role, premises or enabled');
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
