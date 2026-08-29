import { describe, it, expect } from 'vitest';
import { isValidDisplayName, idFrom, isValidId } from '../shared/tenant';

/**
 * Two strings, not one.
 *
 * A display name is read by people and carries spaces. An id becomes an AWS
 * IoT thing name segment, an S3 key prefix, a signed-cookie wildcard and a URL
 * segment — and IoT thing names permit only letters, digits, hyphen,
 * underscore and colon, so a space cannot live there at all. Deriving the id
 * means nobody has to know that.
 */
describe('names a person may type', () => {
  it('accepts letters, digits, single spaces and single hyphens', () => {
    for (const name of ['HQ North', 'Acme Ltd', 'gate-01', 'Bay 4', 'North West Depot', 'Unit 7-B']) {
      expect(isValidDisplayName(name), name).toBe(true);
    }
  });

  it('refuses a double hyphen, because it separates the parts of a thing name', () => {
    for (const name of ['HQ--North', 'a--b', 'Acme -- Ltd']) {
      expect(isValidDisplayName(name), name).toBe(false);
    }
  });

  it('refuses repeated spaces, which are invisible and make two names differ', () => {
    expect(isValidDisplayName('HQ  North')).toBe(false);
    expect(isValidDisplayName('A   B')).toBe(false);
  });

  it('refuses leading and trailing separators, and anything exotic', () => {
    for (const name of [' -HQ', 'HQ-', '-HQ', 'HQ_North', 'HQ/North', 'HQ.North', 'Ω North', '']) {
      expect(isValidDisplayName(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('trims before judging, so trailing whitespace is not an error', () => {
    expect(isValidDisplayName('  HQ North  ')).toBe(true);
  });

  it('holds a name to a sensible length', () => {
    expect(isValidDisplayName('ab')).toBe(false);
    expect(isValidDisplayName('a'.repeat(64))).toBe(true);
    expect(isValidDisplayName('a'.repeat(65))).toBe(false);
  });
});

describe('the id a display name becomes', () => {
  it('lowercases and joins on single hyphens', () => {
    expect(idFrom('HQ North')).toBe('hq-north');
    expect(idFrom('Acme Ltd')).toBe('acme-ltd');
    expect(idFrom('North West Depot')).toBe('north-west-depot');
    expect(idFrom('Unit 7-B')).toBe('unit-7-b');
  });

  it('never produces a double hyphen, whatever it is given', () => {
    for (const name of ['HQ North', 'Bay  4', 'A - B', 'x---y']) {
      const id = idFrom(name);
      if (id !== null) {
        expect(id.includes('--'), `${name} -> ${id}`).toBe(false);
      }
    }
  });

  it('always yields something isValidId accepts, or nothing at all', () => {
    for (const name of ['HQ North', 'ab', '---', '   ', 'A', 'Ω']) {
      const id = idFrom(name);
      expect(id === null || isValidId(id), `${name} -> ${id}`).toBe(true);
    }
  });

  it('refuses rather than inventing an id it cannot make', () => {
    // "aa" slugs to "aa", which is under the three-character floor. Returning
    // it anyway would push the failure to whichever call site used it next.
    expect(idFrom('aa')).toBeNull();
    expect(idFrom('---')).toBeNull();
    expect(idFrom('   ')).toBeNull();
  });

  it('round-trips every name a person is allowed to type', () => {
    for (const name of ['HQ North', 'Acme Ltd', 'gate-01', 'Bay 4', 'North West Depot']) {
      const id = idFrom(name);
      expect(id, name).not.toBeNull();
      expect(isValidId(id!), `${name} -> ${id}`).toBe(true);
    }
  });
});
