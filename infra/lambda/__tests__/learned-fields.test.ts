import { describe, it, expect } from 'vitest';
import { learnedFrom } from '../device/index';

/**
 * What a sighting is allowed to write about the device itself.
 *
 * The fields were written with `if_not_exists`, meaning to protect a name
 * already known from a later sighting that knew less. It did the opposite. A
 * camera first seen before its credentials were set answers no ONVIF question,
 * so its record was created with `manufacturer` explicitly null — and a
 * DynamoDB null is a value that *exists*. `if_not_exists` then found the
 * attribute present on every later report and kept the null, so the console
 * showed "Unknown model" for the life of the record while the agent was
 * reporting CPPLUS on every scan, several times an hour, for days.
 */
describe('what a sighting writes about a device', () => {
  it('writes the fields it knows', () => {
    const learnt = learnedFrom({
      macAddress: '28:18:fd:f1:e5:be', manufacturer: 'CPPLUS', model: 'CP-E41A',
    });
    expect(learnt.clause).toContain('manufacturer = :make');
    expect(learnt.clause).toContain('#model = :model');
    expect(learnt.clause).toContain('macAddress = :mac');
    expect(learnt.values[':make']).toBe('CPPLUS');
    expect(learnt.names['#model']).toBe('model');
  });

  it('writes nothing at all when it learned nothing', () => {
    // The state that created the poisoned record. Saying nothing leaves the
    // attribute absent, so the next sighting that does know can fill it in.
    const learnt = learnedFrom({});
    expect(learnt.clause).toBe('');
    expect(learnt.values).toEqual({});
    expect(learnt.names).toEqual({});
  });

  it('lets a later sighting replace what an earlier one could not see', () => {
    const before = learnedFrom({ macAddress: '28:18:fd:f1:e5:be' });
    expect(before.clause).not.toContain('manufacturer');

    const after = learnedFrom({ macAddress: '28:18:fd:f1:e5:be', manufacturer: 'CPPLUS' });
    expect(after.clause).toContain('manufacturer = :make');
    // Plain assignment, not if_not_exists: the whole point is that it wins.
    expect(after.clause).not.toContain('if_not_exists');
  });

  it('names only what the clause uses, since DynamoDB rejects the unused', () => {
    // An ExpressionAttributeNames entry the expression never mentions is a
    // ValidationException, so #model may only appear alongside the assignment.
    const noModel = learnedFrom({ manufacturer: 'CPPLUS' });
    expect(noModel.names).toEqual({});
    expect(Object.keys(noModel.values)).toEqual([':make']);
  });

  it('ignores blank and malformed values rather than storing them', () => {
    const blank = learnedFrom({ manufacturer: '   ', model: '', macAddress: 'not-a-mac' });
    expect(blank.clause).toBe('');
  });
});
