import { describe, it, expect } from 'vitest';
import { sessionSuperseded, type SessionRecord } from '../shared/session';

/** Stands in for DynamoDB; returns whatever record the test planted. */
function stubDdb(record: Partial<SessionRecord> | undefined) {
  return { send: async () => ({ Item: record }) } as never;
}

const claims = (originJti?: string) => (originJti ? { origin_jti: originJti } : {});

describe('single session across every route', () => {
  it('allows the sign-in that established the session', async () => {
    const ddb = stubDdb({ sessionId: 's1', originJti: 'origin-a' });
    expect(await sessionSuperseded(ddb, 't', 'user', claims('origin-a'))).toBe(false);
  });

  it('refuses a sign-in that has been displaced', async () => {
    // The displaced device still holds a valid, unexpired token — which is
    // exactly why the check cannot rely on token expiry.
    const ddb = stubDdb({ sessionId: 's2', originJti: 'origin-b' });
    expect(await sessionSuperseded(ddb, 't', 'user', claims('origin-a'))).toBe(true);
  });

  it('allows a token refresh, which keeps the same origin', async () => {
    // Cognito rotates jti on refresh but keeps origin_jti, so a refreshed
    // token must not read as a different sign-in.
    const ddb = stubDdb({ sessionId: 's1', originJti: 'origin-a' });
    expect(await sessionSuperseded(ddb, 't', 'user', { origin_jti: 'origin-a', jti: 'a-different-jti' }))
      .toBe(false);
  });

  it('allows when the record has expired rather than been displaced', async () => {
    // Absence means the record's TTL passed. Treating that as displacement
    // would invent a second way to be locked out.
    expect(await sessionSuperseded(stubDdb(undefined), 't', 'user', claims('origin-a'))).toBe(false);
  });

  it('allows a session recorded before origin was tracked', async () => {
    const ddb = stubDdb({ sessionId: 's1' });
    expect(await sessionSuperseded(ddb, 't', 'user', claims('origin-a'))).toBe(false);
  });

  it('allows a token carrying no origin claim', async () => {
    const ddb = stubDdb({ sessionId: 's1', originJti: 'origin-a' });
    expect(await sessionSuperseded(ddb, 't', 'user', claims())).toBe(false);
    expect(await sessionSuperseded(ddb, 't', 'user', undefined)).toBe(false);
  });
});
