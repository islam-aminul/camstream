import { describe, it, expect } from 'vitest';
import { isValidDisplayName, nameComplaint, idFrom } from './naming';

/**
 * The rule as stated: no double dashes anywhere in a customer, site or agent
 * name; only spaces and single dashes as separators; and no run of spaces.
 */
describe('what a customer, site or agent may be called', () => {
  it('accepts ordinary names', () => {
    for (const name of ['HQ North', 'North-West Depot', 'Gate House 2', 'acme']) {
      expect(isValidDisplayName(name)).toBe(true);
    }
  });

  it('refuses two dashes in a row', () => {
    // The reason it matters: a thing name is <tenant>--<premises>--<device>,
    // so a double dash inside any part makes the whole name ambiguous and can
    // place a device in the wrong site.
    expect(isValidDisplayName('North--West')).toBe(false);
    expect(nameComplaint('North--West')).toContain('Two dashes in a row');
  });

  it('refuses two spaces in a row', () => {
    expect(isValidDisplayName('HQ  North')).toBe(false);
    expect(nameComplaint('HQ  North')).toContain('Two spaces in a row');
  });

  it('refuses a name that starts or ends with a separator', () => {
    expect(isValidDisplayName('-HQ')).toBe(false);
    expect(isValidDisplayName('HQ-')).toBe(false);
    expect(nameComplaint('HQ-')).toContain('letter or a number');
  });

  it('names the character it did not like', () => {
    // Somebody pasting a name from a spreadsheet cannot see what is wrong with
    // it; "invalid name" gives them nothing to act on.
    expect(nameComplaint('HQ_North')).toContain('"_"');
    expect(nameComplaint('Café')).toContain('"é"');
  });

  it('holds the length bounds', () => {
    expect(isValidDisplayName('ab')).toBe(false);
    expect(nameComplaint('ab')).toContain('At least 3');
    expect(isValidDisplayName('a'.repeat(65))).toBe(false);
    expect(nameComplaint('a'.repeat(65))).toContain('At most 64');
  });

  it('ignores surrounding whitespace, since that is what trimming is for', () => {
    expect(isValidDisplayName('  HQ North  ')).toBe(true);
    expect(nameComplaint('  HQ North  ')).toBeNull();
  });

  it('says nothing about a name it accepts', () => {
    expect(nameComplaint('North-West Depot')).toBeNull();
  });

  it('refuses things that are not strings at all', () => {
    expect(isValidDisplayName(undefined)).toBe(false);
    expect(isValidDisplayName(42)).toBe(false);
  });
});

describe('the id a name becomes', () => {
  it('lower-cases and joins with single dashes', () => {
    expect(idFrom('HQ North')).toBe('hq-north');
    expect(idFrom('North-West Depot')).toBe('north-west-depot');
  });

  it('never produces a double dash, whatever it was given', () => {
    // The id ends up in thing names, URLs and S3 paths, where a double dash is
    // the separator itself.
    expect(idFrom('North - West')).toBe('north-west');
    expect(idFrom('A  B')).toBe('a-b');
  });

  it('refuses a name that leaves nothing usable behind', () => {
    expect(idFrom('--')).toBeNull();
    expect(idFrom('é')).toBeNull();
  });
});
