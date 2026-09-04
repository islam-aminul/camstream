import { describe, it, expect } from 'vitest';
import { clockSkew } from '../device/index';

/**
 * How far an agent's clock is from ours.
 *
 * Measured here rather than trusted from the agent, because the server is the
 * authority on the time and a machine with a wrong clock is precisely the one
 * that cannot measure its own error.
 *
 * It exists because a Raspberry Pi with no clock battery booted thirty-nine
 * days behind, every signed request was refused with a bare 403, and the agent
 * ran for a day with no credentials and no cameras while looking entirely
 * healthy. Nothing in the console said anything about time, so every symptom
 * pointed at the camera and its password. Both were fine.
 *
 * What this can catch is the approach to that failure — drift growing while
 * the agent still works — because past roughly five minutes AWS stops signing
 * its requests and no report arrives to measure at all.
 */
describe('measuring an agent clock', () => {
  const NOW = 1_788_000_000;

  it('is positive when the agent is behind', () => {
    expect(clockSkew(NOW - 54 * 60, NOW)).toBe(54 * 60);
  });

  it('is negative when the agent is ahead', () => {
    // A clock ahead is the same class of fault and must not be hidden: it
    // breaks signing just as surely.
    expect(clockSkew(NOW + 120, NOW)).toBe(-120);
  });

  it('is zero for a clock in step', () => {
    expect(clockSkew(NOW, NOW)).toBe(0);
  });

  it('is null when the agent did not say', () => {
    // An older build. Null has to survive to the console, because "unknown"
    // and "correct" are different answers and only one is reassuring — showing
    // it as zero would state that a clock is right when nobody has checked.
    expect(clockSkew(undefined, NOW)).toBeNull();
    expect(clockSkew(null, NOW)).toBeNull();
    expect(clockSkew('1788000000', NOW)).toBeNull();
    expect(clockSkew(0, NOW)).toBeNull();
    expect(clockSkew(Number.NaN, NOW)).toBeNull();
  });

  it('clamps a clock that has been lost entirely', () => {
    // Thirty-nine days behind is not a drift measurement, it is a board that
    // has forgotten the date. Unbounded, it would only make the column
    // unreadable, and the tag says "far enough out to be refused" either way.
    expect(clockSkew(NOW - 39 * 86400, NOW)).toBe(86400);
    expect(clockSkew(NOW + 39 * 86400, NOW)).toBe(-86400);
  });
});
