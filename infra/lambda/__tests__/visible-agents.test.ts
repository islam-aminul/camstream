import { describe, it, expect } from 'vitest';
import { visibleAgents } from '../streams/index';

/**
 * The agent list beside the cameras, and who is allowed to see it.
 *
 * `/api/streams` now returns the agents at a site as well as the cameras they
 * have reported. It has to: a camera an agent has never reported has no record
 * in the response at all, so the console had nowhere to read that agent's
 * state from and blamed the camera by default — it told an operator to check a
 * camera's cabling and password when the agent was offline, or restarting, or
 * unable to reach AWS.
 *
 * The new field carries thing names, and a thing name is
 * `<tenant>--<premises>--<device>`. So it names sites. `/api/watch` had exactly
 * this disclosure once (see scope-disclosure.test.ts) — a scope check applied
 * to what was published but not to what came back — and this is the same field
 * shape arriving by a new route, which is why it is tested rather than assumed.
 */
describe('the agents /api/streams discloses', () => {
  const devices = [
    { thingName: 'demo--acme-hq--gate', connected: true, lastReportAt: 1_000 },
    { thingName: 'demo--secret-site--box', connected: true, lastReportAt: 2_000 },
  ];

  it('gives a premises-scoped viewer only their own site', () => {
    const seen = visibleAgents(devices, ['acme-hq']);
    expect(seen.map((a) => a.thingName)).toEqual(['demo--acme-hq--gate']);
  });

  it('never leaks another site through the agent list', () => {
    // The assertion that matters. A thing name spells out the premises, so one
    // row here is enough to tell a restricted viewer that a site exists and
    // what it is called.
    const seen = visibleAgents(devices, ['acme-hq']);
    expect(JSON.stringify(seen)).not.toContain('secret-site');
  });

  it('gives an unscoped viewer everything', () => {
    // An empty scope is "no restriction", which is what an ordinary tenant
    // administrator has - premisesScope() returns [] for a claim that names no
    // sites. Reading it as "nothing permitted" would blank the console for the
    // people who use it most.
    expect(visibleAgents(devices, []).map((a) => a.thingName)).toHaveLength(2);
  });

  it('reports whether each agent is connected', () => {
    const seen = visibleAgents(
      [{ thingName: 'demo--acme-hq--gate', connected: false }], [],
    );
    expect(seen[0].online).toBe(false);
  });

  it('treats a missing connected flag as not connected', () => {
    // Absent is not "true". An agent that has never connected has no flag at
    // all, and calling that online would put a green tile over a site that has
    // never once been heard from.
    expect(visibleAgents([{ thingName: 'demo--acme-hq--gate' }], [])[0].online).toBe(false);
  });

  it('reports a null lastReportAt when the agent has not reported', () => {
    // This is the field that separates "still starting up, wait" from "looked
    // and did not find your camera". Null must survive as null: a zero or an
    // absent key read as a number would make a starting agent look like one
    // that had reported and found nothing, which is the accusation this whole
    // change exists to stop making.
    const seen = visibleAgents([{ thingName: 'demo--acme-hq--gate', connected: true }], []);
    expect(seen[0].lastReportAt).toBeNull();
  });

  it('passes a real lastReportAt through', () => {
    expect(visibleAgents(devices, ['acme-hq'])[0].lastReportAt).toBe(1_000);
  });

  it('drops a device with no thing name rather than emitting an empty one', () => {
    // A malformed row would otherwise become an agent called "", which the
    // console would key a lookup on and quietly match against nothing.
    expect(visibleAgents([{ connected: true }, ...devices], [])).toHaveLength(2);
  });
});
