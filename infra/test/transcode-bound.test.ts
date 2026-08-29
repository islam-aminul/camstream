import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_CONCURRENT_TRANSCODES, DEFAULT_MAX_TRANSCODES } from '../lambda/shared/registry';

/**
 * One bound on how many cameras an agent may convert at once, stated in three
 * languages.
 *
 * The API refuses a number outside it, the console refuses it before the round
 * trip so the operator is told immediately, and the agent refuses it again when
 * its configuration arrives. Three copies because each has to answer without
 * asking the others, and three copies is how a limit quietly becomes two
 * limits — the console offering a number the agent will then crash-loop on
 * rejecting, which is a worse failure than the one the bound prevents.
 */
const ROOT = join(__dirname, '..', '..');

function numberIn(file: string, pattern: RegExp, what: string): number {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const match = source.match(pattern);
  expect(match, `${what} should be declared in ${file}`).not.toBeNull();
  return Number(match![1]);
}

describe('the transcode ceiling', () => {
  it('is the same number in the console as in the API', () => {
    const console_ = numberIn(
      join('web', 'src', 'player', 'tile-state.ts'),
      /export const MAX_TRANSCODE_CAP = (\d+)/,
      'MAX_TRANSCODE_CAP');
    expect(console_, 'the console would offer a number the API refuses')
      .toBe(MAX_CONCURRENT_TRANSCODES);
  });

  it('is the same number in the agent as in the API', () => {
    const agent = numberIn(
      join('agent', 'src', 'main', 'java', 'online', 'camstream', 'agent', 'config', 'AgentConfig.java'),
      /int MAX_CONCURRENT_TRANSCODES = (\d+)/,
      'MAX_CONCURRENT_TRANSCODES');
    expect(agent, 'the agent would reject a configuration the console accepted')
      .toBe(MAX_CONCURRENT_TRANSCODES);
  });

  it('leaves the default well inside itself', () => {
    // The default is deliberately 1: a conversion is a full re-encode where an
    // ordinary camera is a copy. The bound is the guard rail, not the intent.
    expect(DEFAULT_MAX_TRANSCODES).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_MAX_TRANSCODES).toBeLessThan(MAX_CONCURRENT_TRANSCODES);
  });
});
