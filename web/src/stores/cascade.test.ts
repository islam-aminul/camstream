import { describe, it, expect } from 'vitest';
import { settleLevel, levelStatus, createLatest } from './cascade';

describe('what a level does with its options', () => {
  it('selects the only option there is', () => {
    expect(settleLevel(null, ['hq-north'])).toBe('hq-north');
  });

  it('waits when there is a choice to make', () => {
    // Guessing here starts streams at a site nobody asked about, and each one
    // is an ffmpeg process on the customer's own hardware.
    expect(settleLevel(null, ['hq-north', 'depot'])).toBeNull();
  });

  it('selects nothing when there is nothing, so the level can say so', () => {
    expect(settleLevel(null, [])).toBeNull();
  });

  it('keeps a selection that is still valid', () => {
    // A background refresh must not move what somebody is watching.
    expect(settleLevel('depot', ['hq-north', 'depot'])).toBe('depot');
  });

  it('drops a selection the new options no longer contain', () => {
    // The stale case: a camera chosen under one site must not survive into
    // another where it does not exist.
    expect(settleLevel('gone', ['hq-north', 'depot'])).toBeNull();
  });

  it('keeps its value when a second option appears', () => {
    // An agent enrolling must not move what somebody is already looking at.
    const alone = settleLevel(null, ['edge-01']);
    expect(alone).toBe('edge-01');
    expect(settleLevel(alone, ['edge-01', 'edge-02'])).toBe('edge-01');
  });

  it('re-selects automatically when a list narrows back to one', () => {
    expect(settleLevel(null, ['edge-02'])).toBe('edge-02');
  });
});

describe('what a level says about itself', () => {
  it('distinguishes blocked, loading, empty and unchosen', () => {
    expect(levelStatus({ blockedBy: 'premises', options: 0, selected: false }))
      .toBe('Choose a premises first');
    expect(levelStatus({ loading: true, options: 0, selected: false })).toBe('Loading…');
    expect(levelStatus({ options: 0, selected: false })).toBe('None here');
    expect(levelStatus({ options: 12, selected: false })).toBe('12 to choose from');
  });

  it('says nothing about how a level came to be selected', () => {
    // A level with one option is not a decision anybody made, and announcing
    // it drew the eye to the least interesting thing on the page.
    expect(levelStatus({ options: 1, selected: true })).toBe('1 available');
    expect(levelStatus({ options: 4, selected: true })).toBe('4 available');
  });

  it('prefers the blocked message over every other state', () => {
    // Being unusable is the more useful thing to say: the levels above it are
    // what the user has to act on.
    expect(levelStatus({ blockedBy: 'customer', loading: true, options: 9, selected: true }))
      .toBe('Choose a customer first');
  });
});

describe('which answer is allowed to win', () => {
  it('lets the newest request write and silences the ones it replaced', () => {
    const latest = createLatest();
    const first = latest.begin('camera');
    const second = latest.begin('camera');

    expect(latest.current('camera', second)).toBe(true);
    expect(latest.current('camera', first)).toBe(false);
  });

  it('keeps levels independent of each other', () => {
    const latest = createLatest();
    const camera = latest.begin('camera');
    latest.begin('agent');

    // Reloading agents must not discard a camera response that is still wanted.
    expect(latest.current('camera', camera)).toBe(true);
  });
});
