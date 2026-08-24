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
