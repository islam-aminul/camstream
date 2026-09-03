import { describe, it, expect } from 'vitest';

/**
 * The shape of a camera move, and why it is a list.
 *
 * Moving one camera is one entry; swapping two is two. The reason it is not
 * two requests is that the second can be refused — an agent that has never
 * discovered a camera cannot publish it — and by then the first has landed.
 * Both cameras would sit on one agent, one of them dark, arrived at half way
 * through an operation that looked atomic from the console.
 */
type Move = { identity: string; assignedTo: string };

/** Mirrors the validation order in moveCameras, which is the part worth pinning. */
function refuse(moves: Move[], premises: string, reachable: Record<string, string[]>): string | null {
  if (moves.length === 0) return 'moves must be a non-empty array';
  if (moves.length > 25) return 'at most 25 moves at a time';
  if (new Set(moves.map((m) => m.identity)).size !== moves.length) {
    return 'the same camera appears twice';
  }
  for (const move of moves) {
    const parts = move.assignedTo.split('--');
    if (parts.length !== 3) return `Invalid agent name: ${move.assignedTo}`;
    if (parts[1] !== premises) return `${move.assignedTo} is not an agent of this premises`;
    if (!(reachable[move.identity] ?? []).includes(move.assignedTo)) {
      return `${move.assignedTo} cannot reach ${move.identity}`;
    }
  }
  return null;
}

const REACHABLE = {
  'mac-aaa': ['acme--hq--one', 'acme--hq--two'],
  'mac-bbb': ['acme--hq--one', 'acme--hq--two'],
  'mac-ccc': ['acme--hq--one'],
};

describe('moving cameras between agents', () => {
  it('accepts a single move', () => {
    expect(refuse([{ identity: 'mac-aaa', assignedTo: 'acme--hq--two' }], 'hq', REACHABLE)).toBeNull();
  });

  it('accepts a swap as two moves in one request', () => {
    expect(refuse([
      { identity: 'mac-aaa', assignedTo: 'acme--hq--two' },
      { identity: 'mac-bbb', assignedTo: 'acme--hq--one' },
    ], 'hq', REACHABLE)).toBeNull();
  });

  it('refuses the whole swap when either half is unreachable', () => {
    // The case the atomicity exists for: mac-ccc has never been seen by agent
    // two, so this must fail before mac-aaa has moved anywhere.
    expect(refuse([
      { identity: 'mac-aaa', assignedTo: 'acme--hq--two' },
      { identity: 'mac-ccc', assignedTo: 'acme--hq--two' },
    ], 'hq', REACHABLE)).toContain('cannot reach mac-ccc');
  });

  it('refuses an agent at another premises', () => {
    // Across premises the S3 prefix, the video cookie and the viewer's scope
    // all change; that is a different operation, not one to reach by accident.
    expect(refuse([{ identity: 'mac-aaa', assignedTo: 'acme--depot--one' }], 'hq', REACHABLE))
      .toContain('not an agent of this premises');
  });

  it('refuses the same camera named twice', () => {
    // Two entries for one camera have no meaningful order in a transaction.
    expect(refuse([
      { identity: 'mac-aaa', assignedTo: 'acme--hq--two' },
      { identity: 'mac-aaa', assignedTo: 'acme--hq--one' },
    ], 'hq', REACHABLE)).toBe('the same camera appears twice');
  });

  it('refuses an empty or oversized batch', () => {
    expect(refuse([], 'hq', REACHABLE)).toContain('non-empty');
    const many = Array.from({ length: 26 }, (_, i) => ({
      identity: `mac-${i}`, assignedTo: 'acme--hq--two',
    }));
    expect(refuse(many, 'hq', REACHABLE)).toContain('at most 25');
  });
});
