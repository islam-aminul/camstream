import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../shared/registry';

/**
 * A cursor is opaque on purpose.
 *
 * It carries a page boundary, whose shape is ours to change, and it comes back
 * from a caller who could have written anything into it. Encoding it means a
 * client cannot read meaning into a boundary, and cannot hand back something
 * we would then treat as a key.
 */
describe('paging cursors', () => {
  it('round-trips a boundary', () => {
    const cursor = encodeCursor({ from: 50 });
    expect(cursor).toBeTypeOf('string');
    expect(decodeCursor(cursor)).toEqual({ from: 50 });
  });

  it('reveals nothing readable', () => {
    const cursor = encodeCursor({ from: 50, pk: 'TENANT#acme-ltd#PREMISES#hq-north' })!;
    expect(cursor).not.toContain('acme');
    expect(cursor).not.toContain('PREMISES');
    expect(cursor).not.toContain('from');
  });

  it('is URL-safe, because it travels in a query string', () => {
    const cursor = encodeCursor({ from: 200, sk: 'CAMERA#mac-28:18:fd:f1:e5:be' })!;
    expect(cursor).toBe(encodeURIComponent(cursor));
  });

  it('treats a nonsense cursor as the beginning rather than an error', () => {
    // A stale bookmark should show the first page. Failing would make a
    // shared link that outlived its data into a broken page.
    for (const junk of ['', 'not-base64!!', 'YWJj', Buffer.from('[1,2,3]').toString('base64url')]) {
      expect(decodeCursor(junk), junk).toBeUndefined();
    }
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it('has no cursor when there is nothing after this page', () => {
    expect(encodeCursor(undefined)).toBeUndefined();
  });
});

/**
 * Filtering runs in the lambda rather than in DynamoDB, which is affordable
 * only because a site holds on the order of a hundred cameras. It buys
 * case-insensitive matching anywhere in a name — something a filter expression
 * cannot do without a second index to keep true.
 */
describe('filter and page together', () => {
  const rows = [
    { name: 'North Gate' }, { name: 'north dock' }, { name: 'South Gate' },
    { name: 'Loading Bay' }, { name: 'GATEHOUSE' },
  ];

  /** Mirrors the ordering and slicing the admin lambda applies. */
  function page(q: string, from = 0, limit = 2) {
    const needle = q.trim().toLowerCase();
    const matched = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : [...rows];
    matched.sort((a, b) => a.name.localeCompare(b.name));
    return { items: matched.slice(from, from + limit), total: matched.length };
  }

  it('matches anywhere in a name, not just the start', () => {
    expect(page('gate').total).toBe(3);
    expect(page('gate').items.map((r) => r.name)).toContain('GATEHOUSE');
  });

  it('ignores case on both sides', () => {
    expect(page('NORTH').total).toBe(2);
    expect(page('north').total).toBe(2);
  });

  it('pages a filtered set, not the unfiltered one', () => {
    // The bug this guards: filtering after slicing gives short pages and a
    // total that does not match what is shown.
    const first = page('gate', 0, 2);
    const second = page('gate', 2, 2);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
  });

  it('orders stably, so a page boundary means the same thing twice', () => {
    expect(page('', 0, 5).items.map((r) => r.name))
      .toEqual(page('', 0, 5).items.map((r) => r.name));
  });
});
