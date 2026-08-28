import { describe, it, expect } from 'vitest';
import { key, REGISTRY_PK } from '../shared/registry';
import { thingName, parseThingName } from '../shared/tenant';

/**
 * Premises is the partition for everything that scales with the estate.
 *
 * A single partition key gets about 3,000 reads a second whatever the table is
 * provisioned for. Resolving what an agent should publish needs every demand
 * that mentions it — partitioned by customer, that meant reading the customer:
 * some 11,500 items per watch call at the size this is sold for, against that
 * 3,000 ceiling. A hundred sites is a hundred partitions.
 */
describe('what lives in which partition', () => {
  const t = 'acme-ltd';
  const p = 'hq-north';

  it('puts estate-sized collections under the site', () => {
    expect(key.site(t, p)).toBe('TENANT#acme-ltd#PREMISES#hq-north');
  });

  it('keeps the few, and the ones read before a site is known, under the customer', () => {
    expect(key.tenant(t)).toBe('TENANT#acme-ltd');
  });

  it('keeps customers in their own small partition, so they can be listed at all', () => {
    expect(REGISTRY_PK).toBe('REGISTRY');
    expect(key.customer(t)).toBe('CUSTOMER#acme-ltd');
  });

  it('gives every site its own partition rather than sharing one', () => {
    const partitions = new Set(
      ['hq-north', 'north-west-depot', 'bay-4'].map((site) => key.site(t, site)));
    expect(partitions.size).toBe(3);
  });

  it('separates customers even when their sites share a name', () => {
    expect(key.site('acme-ltd', 'hq-north')).not.toBe(key.site('acme-two', 'hq-north'));
  });
});

/**
 * The agent never sends a tenant or a premises. Its certificate carries a
 * thing name, and the name carries both — which is the reason re-partitioning
 * the registry required no change to the agent at all.
 */
describe('an agent addresses its own partition without being told', () => {
  it('recovers the partition from the thing name alone', () => {
    const thing = thingName({ tenantId: 'acme-ltd', premisesId: 'hq-north', deviceId: 'gate-house' });
    expect(thing).toBe('acme-ltd--hq-north--gate-house');

    const identity = parseThingName(thing)!;
    expect(key.site(identity.tenantId, identity.premisesId)).toBe('TENANT#acme-ltd#PREMISES#hq-north');
  });

  it('round-trips every part, so a name is never a lossy address', () => {
    const identity = { tenantId: 'acme-ltd', premisesId: 'north-west-depot', deviceId: 'bay-4' };
    expect(parseThingName(thingName(identity))).toEqual(identity);
  });
});
