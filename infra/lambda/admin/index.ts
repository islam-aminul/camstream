import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isValidId } from '../shared/tenant';
import { fail, json } from '../shared/http';
import { key, slugFor, type CameraRecord, type DiscoveredRecord } from '../shared/registry';

const TABLE = process.env.REGISTRY_TABLE!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const ADMIN_GROUP = 'admin';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

interface Caller {
  tenantId: string;
  sub: string;
  email: string;
}

/**
 * Admin membership is a Cognito group, checked here rather than at the
 * authorizer. The authorizer only proves the token is valid; it says nothing
 * about what the holder may do.
 */
function authorise(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller | null {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const tenantId = claims['custom:tenantId'];
  const sub = claims.sub;
  if (typeof sub !== 'string' || !isValidId(tenantId)) {
    return null;
  }
  // The claim arrives as an array, or as a bracketed string depending on the
  // token type — normalise before testing membership.
  const raw = claims['cognito:groups'];
  const groups = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean)
      : [];
  if (!groups.includes(ADMIN_GROUP)) {
    return null;
  }
  return { tenantId, sub, email: typeof claims.email === 'string' ? claims.email : sub };
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const caller = authorise(event);
  if (!caller) {
    return fail(403, 'Administrator access required');
  }

  const route = `${event.requestContext.http.method} ${event.routeKey.split(' ')[1] ?? ''}`;
  try {
    switch (route) {
      case 'GET /api/admin/agents':
        return await listAgents(caller);
      case 'GET /api/admin/discovered':
        return await listDiscovered(caller);
      case 'POST /api/admin/cameras':
        return await approveCamera(caller, event.body);
      case 'DELETE /api/admin/cameras/{identity}':
        return await removeCamera(caller, event.pathParameters?.identity);
      case 'POST /api/admin/credentials':
        return await storeCredential(caller, event.body);
      case 'GET /api/admin/users':
        return await listUsers(caller);
      case 'POST /api/admin/users':
        return await createUser(caller, event.body);
      case 'DELETE /api/admin/users/{username}':
        return await deleteUser(caller, event.pathParameters?.username);
      default:
        return fail(404, `Unknown admin route: ${route}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    return fail(500, message);
  }
}

async function queryPrefix<T>(tenantId: string, prefix: string): Promise<T[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': key.tenant(tenantId), ':prefix': prefix },
    }),
  );
  return (result.Items ?? []) as T[];
}

async function listAgents(caller: Caller) {
  const devices = await queryPrefix<Record<string, unknown>>(caller.tenantId, 'DEVICE#');
  const now = Math.floor(Date.now() / 1000);
  return json(200, {
    agents: devices.map((device) => ({
      thingName: device.thingName,
      siteName: device.siteName,
      agentVersion: device.agentVersion,
      cameraCount: device.cameraCount ?? 0,
      lastSeen: device.lastSeen,
      // Heartbeats are every 30s; three missed ones is a real outage.
      online: typeof device.lastSeen === 'number' && now - device.lastSeen < 90,
      // Presence of the key is what tells the UI it can encrypt for this agent.
      credentialPublicKey: device.credentialPublicKey ?? null,
    })),
  });
}

async function listDiscovered(caller: Caller) {
  const [discovered, approved] = await Promise.all([
    queryPrefix<DiscoveredRecord>(caller.tenantId, 'DISCOVERED#'),
    queryPrefix<CameraRecord>(caller.tenantId, 'CAMERA#'),
  ]);
  const approvedByIdentity = new Map(approved.map((camera) => [camera.identity, camera]));

  return json(200, {
    cameras: discovered.map((record) => {
      const agents = Object.entries(record.reachableBy ?? {});
      const existing = approvedByIdentity.get(record.identity);
      return {
        identity: record.identity,
        identityStable: record.identityStable,
        macAddress: record.macAddress,
        manufacturer: record.manufacturer,
        model: record.model,
        lastSeen: record.lastSeen,
        // Several agents on one premises will legitimately see the same
        // camera; the administrator picks which one owns it.
        reachableBy: agents.map(([thingName, sighting]) => ({
          thingName,
          ipAddress: sighting.ipAddress,
          authState: sighting.authState,
          lastSeen: sighting.lastSeen,
          profiles: sighting.profiles ?? [],
        })),
        approved: existing
          ? { cameraId: existing.cameraId, displayName: existing.displayName, assignedTo: existing.assignedTo }
          : null,
      };
    }),
  });
}

async function approveCamera(caller: Caller, rawBody: string | undefined) {
  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const identity = String(body.identity ?? '');
  const assignedTo = String(body.assignedTo ?? '');

  if (!/^[A-Za-z0-9._-]{3,64}$/.test(identity)) {
    return fail(400, 'Invalid camera identity');
  }
  const discovered = await queryPrefix<DiscoveredRecord>(caller.tenantId, key.discovered(identity));
  const record = discovered[0];
  if (!record) {
    return fail(404, 'No such discovered camera');
  }
  // Assigning a camera to an agent that cannot see it would produce a stream
  // that never starts, with nothing to indicate why.
  if (!Object.keys(record.reachableBy ?? {}).includes(assignedTo)) {
    return fail(400, `Agent ${assignedTo} cannot reach this camera`);
  }

  const camera: CameraRecord = {
    pk: key.tenant(caller.tenantId),
    sk: key.camera(identity),
    identity,
    cameraId: typeof body.cameraId === 'string' && isValidId(body.cameraId)
      ? body.cameraId
      : slugFor(identity),
    displayName: String(body.displayName ?? record.model ?? identity).slice(0, 128),
    assignedTo,
    subProfileToken: body.subProfileToken ? String(body.subProfileToken) : undefined,
    mainProfileToken: body.mainProfileToken ? String(body.mainProfileToken) : undefined,
    sourceCodec: body.sourceCodec ? String(body.sourceCodec) : undefined,
    approvedAt: Math.floor(Date.now() / 1000),
    approvedBy: caller.email,
  };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: camera }));
  return json(200, { approved: camera.cameraId, assignedTo });
}

async function removeCamera(caller: Caller, identity: string | undefined) {
  if (!identity) {
    return fail(400, 'Camera identity is required');
  }
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { pk: key.tenant(caller.tenantId), sk: key.camera(identity) },
    }),
  );
  return json(200, { removed: identity });
}

/**
 * Stores a credential the browser already encrypted for one agent.
 *
 * There is deliberately no decrypt path here, and no endpoint that returns
 * plaintext: the control plane is a courier. A scope of '*' applies to every
 * camera that agent reaches; anything else is a camera identity.
 */
async function storeCredential(caller: Caller, rawBody: string | undefined) {
  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const thingName = String(body.thingName ?? '');
  const scope = String(body.scope ?? '*');
  const ciphertext = String(body.ciphertext ?? '');

  if (!/^[a-z0-9-]{3,32}--[a-z0-9-]{3,32}$/.test(thingName)) {
    return fail(400, 'Invalid agent name');
  }
  if (!/^[A-Za-z0-9+/=]{64,2048}$/.test(ciphertext)) {
    return fail(400, 'Ciphertext must be base64 and of plausible RSA size');
  }
  if (scope !== '*' && !/^[A-Za-z0-9._-]{3,64}$/.test(scope)) {
    return fail(400, 'Invalid scope');
  }

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: key.tenant(caller.tenantId),
        sk: key.credential(thingName, scope),
        thingName,
        scope,
        ciphertext,
        storedAt: Math.floor(Date.now() / 1000),
        storedBy: caller.email,
      },
    }),
  );
  return json(200, { stored: scope, thingName });
}

async function listUsers(caller: Caller) {
  const result = await cognito.send(
    new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }),
  );
  const users = (result.Users ?? [])
    .map((user) => {
      const attributes = Object.fromEntries(
        (user.Attributes ?? []).map((attribute) => [attribute.Name, attribute.Value]),
      );
      return {
        username: user.Username,
        email: attributes.email,
        tenantId: attributes['custom:tenantId'],
        status: user.UserStatus,
        enabled: user.Enabled,
        created: user.UserCreateDate,
      };
    })
    // An administrator manages their own tenant, not the whole pool.
    .filter((user) => user.tenantId === caller.tenantId);
  return json(200, { users });
}

async function createUser(caller: Caller, rawBody: string | undefined) {
  const body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return fail(400, 'A valid email address is required');
  }

  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        // Tenant is taken from the caller, never from the request: an admin
        // must not be able to mint users into someone else's tenant.
        { Name: 'custom:tenantId', Value: caller.tenantId },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    }),
  );

  if (body.admin === true) {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        GroupName: ADMIN_GROUP,
      }),
    );
  }
  return json(200, { created: email, tenantId: caller.tenantId, admin: body.admin === true });
}

async function deleteUser(caller: Caller, username: string | undefined) {
  if (!username) {
    return fail(400, 'Username is required');
  }
  if (username === caller.email || username === caller.sub) {
    return fail(400, 'You cannot delete your own account');
  }
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
  return json(200, { deleted: username });
}
