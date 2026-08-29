import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No route may take the caller's own tenant as the tenant it acts on.
 *
 * This mistake has now been made four times, in four unrelated handlers, and
 * every time it looked correct while reading: the caller has a tenant, the
 * route needs a tenant, so the caller's is used. It is wrong because the
 * platform operator selects a customer in the console and is not a member of
 * it, and it fails silently — the query succeeds against an empty partition
 * and the page reports nothing rather than an error.
 *
 * What it cost, in order: the stream list showed no cameras; the video cookie
 * was cut for the wrong customer so every tile would have stalled; the
 * discovered list said nothing had been found while two cameras waited; and
 * the watch endpoint filed demand under a customer with no agents, so nothing
 * was ever asked to publish.
 *
 * `targetTenant` and `readTenant` exist to answer this question properly:
 * the caller's tenant unless they may cross and named another. This asserts
 * nobody reaches around them.
 */
const LAMBDA = join(__dirname, '..', 'lambda');

/** Every .ts file under lambda/, excluding tests and the shared helpers. */
function handlers(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') handlers(path, found);
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

describe('how a route decides whose data it is touching', () => {
  const files = handlers(LAMBDA).filter((f) => !f.includes(join('shared', 'roles.ts')));

  it('finds the handlers at all', () => {
    // Guards the guard: a moved directory would silently assert nothing.
    expect(files.length).toBeGreaterThan(5);
  });

  it('never reads the tenant claim directly outside the roles helper', () => {
    // roles.ts is where the claim is read, once, and turned into a Caller.
    // Anywhere else it is the caller's own tenant standing in for a decision
    // that should have been targetTenant's.
    const offenders = files
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => /claims\[['"]custom:tenantId['"]\]/.test(source))
      .map(({ file }) => file.slice(file.indexOf('lambda')));

    expect(offenders).toEqual([]);
  });

  it('resolves the tenant through the helpers wherever a body or query names one', () => {
    // A route that accepts tenantId must pass it through one of the two
    // resolvers rather than trusting it, which is the other half of the same
    // mistake: trusting a named tenant would let anyone read any customer.
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const accepts = /(body|query|queryStringParameters)\??\.\s*tenantId/.test(source);
      if (!accepts) continue;
      expect(
        /targetTenant\(|readTenant\(/.test(source),
        `${file.slice(file.indexOf('lambda'))} accepts a tenantId without resolving it`,
      ).toBe(true);
    }
  });
});
