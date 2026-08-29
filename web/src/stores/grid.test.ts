import { describe, it, expect } from 'vitest';
import { pageOf, hourlyCostUsd, costNote, gridTemplate, SEGMENT_SECONDS } from './grid';

describe('which cameras a page holds', () => {
  const cameras = Array.from({ length: 23 }, (_, i) => `cam-${i + 1}`);

  it('counts from one for the person reading it', () => {
    const plan = pageOf(cameras, 9, 0);
    expect(plan.items).toHaveLength(9);
    expect([plan.from, plan.to, plan.total]).toEqual([1, 9, 23]);
    expect(plan.pages).toBe(3);
  });

  it('gives a short last page rather than padding it', () => {
    const plan = pageOf(cameras, 9, 2);
    expect(plan.items).toEqual(['cam-19', 'cam-20', 'cam-21', 'cam-22', 'cam-23']);
    expect([plan.from, plan.to]).toEqual([19, 23]);
  });

  it('falls back to the last page when the list shrinks underneath it', () => {
    // Ordinary: the operator is on page three and picks an agent with four
    // cameras. An empty grid would look like a failure; the last page is the
    // honest answer.
    const plan = pageOf(cameras.slice(0, 4), 9, 2);
    expect(plan.page).toBe(0);
    expect(plan.items).toHaveLength(4);
  });

  it('reports one page and no rows when there is nothing', () => {
    const plan = pageOf([], 16, 0);
    expect(plan).toMatchObject({ items: [], page: 0, pages: 1, from: 0, to: 0, total: 0 });
  });
});

describe('what a wall of cameras costs', () => {
  it('prices an hour of one stream from the segment length', () => {
    // 4s segments: 900 segments an hour, each one a segment PUT and a playlist
    // rewrite, at $0.005 per thousand.
    expect(hourlyCostUsd(1, 4)).toBeCloseTo(0.009, 6);
  });

  it('shows why segment length is the lever', () => {
    // Halving the segment doubles the request bill, which is the single
    // largest cost decision in the system.
    expect(hourlyCostUsd(1, 2)).toBeCloseTo(hourlyCostUsd(1, 4) * 2, 6);
  });

  it('scales with the tiles on screen', () => {
    expect(hourlyCostUsd(16)).toBeCloseTo(hourlyCostUsd(1) * 16, 6);
  });

  it('quotes the full grid in money the reader can act on', () => {
    expect(costNote(16)).toBe('16 live streams — about $0.14 an hour while open.');
    expect(costNote(1)).toBe('1 live stream — about $0.01 an hour while open.');
    expect(costNote(0)).toBe('Nothing is streaming.');
  });

  it('quotes the segment length the agent actually publishes', () => {
    // Guards the pair: AgentConfig.segmentDurationMs is 4000ms, and a change
    // there without a change here would have the console quoting a price the
    // system no longer charges.
    expect(SEGMENT_SECONDS).toBe(4);
  });
});

describe('how the grid fills the width it has', () => {
  it('lets a narrow window drop columns instead of shrinking tiles', () => {
    // min(100%, floor) is the part that matters: on a phone a 300px floor
    // would otherwise force a track wider than the screen and scroll sideways.
    expect(gridTemplate(9)).toContain('min(100%,');
    expect(gridTemplate(9)).toContain('auto-fill');
  });

  it('asks for smaller tiles as the count rises', () => {
    const floor = (t: number) => Number(/(\d+)px/.exec(gridTemplate(t))![1]);
    expect(floor(16)).toBeLessThan(floor(9));
    expect(floor(9)).toBeLessThan(floor(4));
  });
});
