import { describe, it, expect } from 'vitest';
import { isFirstSighting } from '../device/index';

/**
 * A camera within range of several agents is one record with several
 * sightings, and keeping it that way depends on telling two failures apart.
 *
 * `recordDiscoveries` updates `reachableBy.<agent>` guarded on the map already
 * existing, and falls back to writing the record whole. That fallback used to
 * run on any error at all — so a throttle, a validation fault or a transient
 * network error rewrote `reachableBy` with only the reporting agent, silently
 * erasing every other agent's sighting.
 */
describe('deciding whether a camera record is new', () => {
  it('says yes only when the condition itself failed', () => {
    expect(isFirstSighting({ name: 'ConditionalCheckFailedException' })).toBe(true);
  });

  it('says no to every retryable fault, so none can take the destructive path', () => {
    // Throughput exceptions are the realistic ones here: they arrive exactly
    // when an estate is busy enough to have several agents reporting at once,
    // which is the case this whole record shape exists for.
    for (const name of [
      'ProvisionedThroughputExceededException',
      'ThrottlingException',
      'RequestLimitExceeded',
      'InternalServerError',
      'TimeoutError',
      'ValidationException',
      'ItemCollectionSizeLimitExceededException',
      'AccessDeniedException',
    ]) {
      expect(isFirstSighting({ name }), name).toBe(false);
    }
  });

  it('treats anything unrecognisable as not-new rather than guessing', () => {
    expect(isFirstSighting({})).toBe(false);
    expect(isFirstSighting(undefined)).toBe(false);
    expect(isFirstSighting(null)).toBe(false);
    expect(isFirstSighting(new Error('boom'))).toBe(false);
    expect(isFirstSighting('ConditionalCheckFailedException')).toBe(false);
  });
});
