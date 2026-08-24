import { randomUUID, createSign } from 'node:crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isValidId } from '../shared/tenant';
import { fail, json } from '../shared/http';
import { SESSION_TTL_SECONDS, readSession, writeSession } from '../shared/session';

const KEY_PAIR_ID = requiredEnv('CF_KEY_PAIR_ID');
const PRIVATE_KEY_PARAM = requiredEnv('CF_PRIVATE_KEY_PARAM');
const ALLOWED_HOSTS = requiredEnv('ALLOWED_HOSTS').split(',');
const TABLE = requiredEnv('REGISTRY_TABLE');

const ssm = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Cached across invocations — the key is immutable for the life of the deployment. */
let privateKeyPromise: Promise<string> | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function getPrivateKey(): Promise<string> {
  privateKeyPromise ??= ssm
    .send(new GetParameterCommand({ Name: PRIVATE_KEY_PARAM, WithDecryption: true }))
    .then((res) => {
      const value = res.Parameter?.Value;
      if (!value) throw new Error(`SSM parameter ${PRIVATE_KEY_PARAM} is empty`);
      return value;
    })
    .catch((err) => {
      // Don't cache a failure — a transient SSM error would otherwise poison
      // this container for its entire lifetime.
      privateKeyPromise = undefined;
      throw err;
    });
  return privateKeyPromise;
}

/** CloudFront's base64 variant: `+/=` are not URL- or cookie-safe. */
function cfEncode(input: Buffer): string {
  return input.toString('base64').replaceAll('+', '-').replaceAll('=', '_').replaceAll('/', '~');
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const tenantId = claims['custom:tenantId'];
  const userSub = claims.sub;

  if (typeof userSub !== 'string' || userSub.length === 0) {
    return fail(403, 'Token carries no subject');
  }
  if (!isValidId(tenantId)) {
    // The user exists but was provisioned without a usable tenant claim.
    return fail(403, 'Account is not associated with a valid tenant');
  }

  // Derive the cookie/policy origin from the request host so that the apex,
  // www and the raw *.cloudfront.net domain each get cookies that actually
  // match the URLs the player will request.
  const host = (event.headers?.host ?? '').toLowerCase().split(':')[0];
  if (!ALLOWED_HOSTS.includes(host)) {
    return fail(400, 'Unrecognised host');
  }

  let body: { sessionId?: unknown } = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return fail(400, 'Body must be JSON');
    }
  }

  // A request carrying a sessionId is a refresh and must still hold the claim;
  // one without is a fresh sign-in, which takes the claim from whoever had it.
  let sessionId: string;
  let displaced = false;
  if (typeof body.sessionId === 'string' && body.sessionId.length > 0) {
    const current = await readSession(ddb, TABLE, userSub);
    if (!current || current.sessionId !== body.sessionId) {
      return fail(409, 'Session superseded by a newer sign-in');
    }
    sessionId = current.sessionId;
  } else {
    const current = await readSession(ddb, TABLE, userSub);
    displaced = current !== undefined;
    sessionId = randomUUID();
  }

  const now = Math.floor(Date.now() / 1000);
  await writeSession(ddb, TABLE, userSub, { sessionId, tenantId, issuedAt: now });

  const expiresAt = now + SESSION_TTL_SECONDS;

  // One wildcard covers every device belonging to this tenant, because thing
  // names are `<tenantId>--<deviceId>` and ids may not contain `--`.
  const resource = `https://${host}/live/${tenantId}--*`;

  const policy = JSON.stringify({
    Statement: [
      {
        Resource: resource,
        Condition: { DateLessThan: { 'AWS:EpochTime': expiresAt } },
      },
    ],
  });

  const privateKey = await getPrivateKey();
  // CloudFront verifies signed cookies with RSA-SHA1. This is fixed by the
  // service, not a choice.
  const signature = createSign('RSA-SHA1').update(policy).sign(privateKey);

  const attrs = `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
  const cookies = [
    `CloudFront-Policy=${cfEncode(Buffer.from(policy))}; ${attrs}`,
    `CloudFront-Signature=${cfEncode(signature)}; ${attrs}`,
    `CloudFront-Key-Pair-Id=${KEY_PAIR_ID}; ${attrs}`,
  ];

  return json(200, {
    sessionId,
    tenantId,
    expiresAt,
    // Refresh comfortably before the cookies lapse.
    refreshInSeconds: Math.floor(SESSION_TTL_SECONDS * 0.8),
    displacedPreviousSession: displaced,
    scope: resource,
  }, cookies);
}
