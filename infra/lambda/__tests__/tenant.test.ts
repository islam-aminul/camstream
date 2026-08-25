import { describe, it, expect } from 'vitest';
import { isValidId, thingName, parseThingName, cookieResource, THING_NAME_PATTERN } from '../shared/tenant';
import { slugFor } from '../shared/registry';

describe('identifiers', () => {
  it('accepts ordinary ids', () => {
    for (const id of ['acme', 'acme-hq', 'gate-01', 'a-b-c', 'x'.repeat(32)]) {
      expect(isValidId(id), id).toBe(true);
    }
  });

  it('rejects anything that would break a prefix boundary or a URL', () => {
    // '--' is the separator between the parts of a thing name. Allowing it
    // inside an id would let live/<tenant>--* match a neighbouring tenant.
    for (const id of ['ac--me', 'AcmeHQ', 'acme hq', 'acme_hq', '-acme', 'acme-', 'ab', 'x'.repeat(33), '']) {
      expect(isValidId(id), id).toBe(false);
    }
  });
});

describe('thing names', () => {
  const identity = { tenantId: 'acme', premisesId: 'acme-hq', deviceId: 'gate-01' };

  it('round-trips', () => {
    const name = thingName(identity);
    expect(name).toBe('acme--acme-hq--gate-01');
    expect(parseThingName(name)).toEqual(identity);
    expect(THING_NAME_PATTERN.test(name)).toBe(true);
  });

  it('refuses names that are not exactly three parts', () => {
    expect(parseThingName('acme--gate-01')).toBeNull();
    expect(parseThingName('acme--hq--gate--extra')).toBeNull();
    expect(parseThingName('acme')).toBeNull();
  });

  it('refuses a part that is not a valid id', () => {
    expect(parseThingName('ACME--hq--gate')).toBeNull();
    expect(parseThingName('acme--hq--')).toBeNull();
  });
});

describe('cookie scoping', () => {
  const origin = 'https://camstream.online';

  it('grants the whole tenant when unscoped', () => {
    expect(cookieResource(origin, 'acme', undefined)).toBe(`${origin}/live/acme--*`);
    expect(cookieResource(origin, 'acme', [])).toBe(`${origin}/live/acme--*`);
  });

  it('grants exactly one site when scoped to one', () => {
    expect(cookieResource(origin, 'acme', ['acme-hq'])).toBe(`${origin}/live/acme--acme-hq--*`);
  });

  it('falls back to the tenant for several sites', () => {
    // A CloudFront policy carries a single wildcard, so a partial restriction
    // cannot be expressed. Widening is the honest failure; silently granting
    // only the first site would be worse.
    expect(cookieResource(origin, 'acme', ['acme-hq', 'acme-dc'])).toBe(`${origin}/live/acme--*`);
  });

  it('does not let one tenant wildcard reach another', () => {
    const scope = cookieResource(origin, 'acme', undefined);
    const prefix = scope.replace(`${origin}/live/`, '').replace('*', '');
    expect('acmex--hq--gate/x'.startsWith(prefix)).toBe(false);
    expect('acme--hq--gate/x'.startsWith(prefix)).toBe(true);
  });
});

describe('slugFor', () => {
  it('leaves the identities the agent actually produces unchanged', () => {
    // assignIdentity already emits lower-case, separator-free forms.
    expect(slugFor('mac-aabbccddeeff')).toBe('mac-aabbccddeeff');
    expect(slugFor('ip-192-168-1-9')).toBe('ip-192-168-1-9');
  });

  it('normalises anything a camera serial might contain', () => {
    expect(slugFor('sn-ABC123')).toBe('sn-abc123');
    expect(slugFor('SN/2024:001')).toBe('sn-2024-001');
  });

  it('never emits the reserved separator', () => {
    expect(slugFor('a__b..c')).not.toContain('--');
  });

  it('always meets the minimum length', () => {
    expect(slugFor('a').length).toBeGreaterThanOrEqual(3);
  });
});
