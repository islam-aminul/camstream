import { describe, it, expect } from 'vitest';
import {
  isValidId, thingName, parseThingName, cookieResource, isThingName,
  premisesScope, withinScope,
} from '../shared/tenant';
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

describe('the thing-name validator agrees with the parser', () => {
  it('rejects the names the old regex let through', () => {
    // '-' inside the character class let the first group swallow a separator,
    // so a four-part name matched as three and a leading hyphen passed —
    // names parseThingName rejects, and the device lambda therefore refuses
    // forever once one has been registered.
    for (const bad of ['acme--hq--gate-01--evil', '-ab--cde--fgh', 'ab--cde--fgh-', 'ac--me--gate--01']) {
      expect(isThingName(bad), bad).toBe(false);
      expect(parseThingName(bad), bad).toBeNull();
    }
  });

  it('agrees with the parser on well-formed names', () => {
    for (const good of ['acme--acme-hq--gate-01', 'demo--hq-north--edge-01']) {
      expect(isThingName(good), good).toBe(true);
      expect(parseThingName(good), good).not.toBeNull();
    }
  });
});

describe('thing names', () => {
  const identity = { tenantId: 'acme', premisesId: 'acme-hq', deviceId: 'gate-01' };

  it('round-trips', () => {
    const name = thingName(identity);
    expect(name).toBe('acme--acme-hq--gate-01');
    expect(parseThingName(name)).toEqual(identity);
    expect(isThingName(name)).toBe(true);
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

describe('premises scoping of listings', () => {
  it('lets an unscoped account see every site', () => {
    expect(withinScope('acme--acme-hq--gate-01', [])).toBe(true);
    expect(withinScope('acme--acme-dc--rack-01', [])).toBe(true);
  });

  it('hides other sites from a restricted account', () => {
    // Not only playback: a restricted viewer must not learn from a camera list
    // that other sites exist or what their agents are called.
    expect(withinScope('acme--acme-hq--gate-01', ['acme-hq'])).toBe(true);
    expect(withinScope('acme--acme-dc--rack-01', ['acme-hq'])).toBe(false);
  });

  it('does not match a premises by prefix', () => {
    expect(withinScope('acme--acme-hq-annex--gate-01', ['acme-hq'])).toBe(false);
  });

  it('refuses a thing name it cannot parse', () => {
    expect(withinScope('nonsense', ['acme-hq'])).toBe(false);
    expect(withinScope('acme--gate-01', ['acme-hq'])).toBe(false);
  });

  it('reads and sanitises the premises claim', () => {
    expect(premisesScope({ 'custom:premises': 'acme-hq, acme-dc' })).toEqual(['acme-hq', 'acme-dc']);
    expect(premisesScope({ 'custom:premises': '' })).toEqual([]);
    expect(premisesScope(undefined)).toEqual([]);
    expect(premisesScope({ 'custom:premises': 'BAD,ok--no,xy' })).toEqual([]);
  });
});
