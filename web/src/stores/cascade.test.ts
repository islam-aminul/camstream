import { describe, it, expect } from 'vitest';
import { settleLevel, levelStatus } from './cascade';

describe('what a level does with its options', () => {
  it('selects the only option there is, and admits it chose', () => {
    expect(settleLevel(null, ['hq-north'])).toEqual({ value: 'hq-north', automatic: true });
  });

  it('waits when there is a choice to make', () => {
    // Guessing here starts streams at a site nobody asked about, and each one
    // is an ffmpeg process on the customer's own hardware.
    expect(settleLevel(null, ['hq-north', 'depot'])).toEqual({ value: null, automatic: false });
  });

  it('selects nothing when there is nothing, so the level can say so', () => {
    expect(settleLevel(null, [])).toEqual({ value: null, automatic: false });
  });

  it('keeps a selection that is still valid', () => {
    // A background refresh must not move what somebody is watching.
    expect(settleLevel('depot', ['hq-north', 'depot']))
      .toEqual({ value: 'depot', automatic: false });
  });

  it('drops a selection the new options no longer contain', () => {
    // The stale case: a camera chosen under one site must not survive into
    // another where it does not exist.
    expect(settleLevel('gone', ['hq-north', 'depot']))
      .toEqual({ value: null, automatic: false });
  });

  it('stops calling a choice automatic once a second option appears', () => {
    // An agent enrolling should not silently relabel what the user is doing,
    // but it should stop claiming there was no alternative.
    const alone = settleLevel(null, ['edge-01']);
    expect(alone).toEqual({ value: 'edge-01', automatic: true });

    const joined = settleLevel(alone.value, ['edge-01', 'edge-02']);
    expect(joined).toEqual({ value: 'edge-01', automatic: false });
  });

  it('re-selects automatically when a list narrows back to one', () => {
    expect(settleLevel(null, ['edge-02'])).toEqual({ value: 'edge-02', automatic: true });
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

  it('says when it chose for you', () => {
    expect(levelStatus({ options: 1, selected: true, automatic: true }))
      .toBe('Only one — selected for you');
  });

  it('does not claim to have chosen when the user did', () => {
    expect(levelStatus({ options: 4, selected: true, automatic: false })).toBe('4 available');
  });

  it('prefers the blocked message over every other state', () => {
    // Being unusable is the more useful thing to say: the levels above it are
    // what the user has to act on.
    expect(levelStatus({ blockedBy: 'customer', loading: true, options: 9, selected: true }))
      .toBe('Choose a customer first');
  });
});
