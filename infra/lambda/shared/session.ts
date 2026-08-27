import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Exactly one live session per user.
 *
 * The stored `sessionId` is the single source of truth: signing in anywhere
 * overwrites it, and the previous tab's next refresh fails the comparison and
 * is logged out.
 *
 * The revocation bound is the cookie lifetime, not this check. CloudFront
 * validates signed cookies at the edge against nothing but their own expiry —
 * there is no revocation list — so a displaced session keeps working until its
 * cookies lapse. That is why SESSION_TTL is minutes rather than hours.
 */
export const SESSION_TTL_SECONDS = 300;

/** Record lives a little past the cookies it authorised, so refreshes can be matched. */
const RECORD_TTL_SECONDS = SESSION_TTL_SECONDS * 3;

export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  issuedAt: number;
  expiresAt: number;
  /**
   * Cognito's `origin_jti`, which identifies the sign-in rather than the token.
   * It survives a token refresh but changes on a fresh authentication, so
   * comparing it detects a displaced session on any request — without the
   * client having to send anything extra.
   */
  originJti?: string;
}

const key = (userSub: string) => ({ pk: `USER#${userSub}`, sk: 'SESSION' });

export async function readSession(
  ddb: DynamoDBDocumentClient,
  table: string,
  userSub: string,
): Promise<SessionRecord | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: table, Key: key(userSub), ConsistentRead: true }));
  return result.Item as SessionRecord | undefined;
}

/**
 * Refuses a request whose sign-in has been superseded.
 *
 * Single session has to hold on every authenticated route, not just the ones
 * that happen to carry a session id: a displaced administrator holding a valid
 * token could otherwise keep managing the estate until that token lapsed.
 *
 * Absence of a record means the record's TTL passed, not that someone else
 * signed in — so that case is allowed rather than inventing a second way to be
 * locked out.
 */
export async function sessionSuperseded(
  ddb: DynamoDBDocumentClient,
  table: string,
  userSub: string,
  claims: Record<string, unknown> | undefined,
): Promise<boolean> {
  const originJti = claims?.origin_jti;
  if (typeof originJti !== 'string' || originJti.length === 0) {
    return false;
  }
  const current = await readSession(ddb, table, userSub);
  if (!current || !current.originJti) {
    return false;
  }
  return current.originJti !== originJti;
}

export async function writeSession(
  ddb: DynamoDBDocumentClient,
  table: string,
  userSub: string,
  record: Omit<SessionRecord, 'expiresAt'>,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: { ...key(userSub), ...record, expiresAt: Math.floor(Date.now() / 1000) + RECORD_TTL_SECONDS },
    }),
  );
}
