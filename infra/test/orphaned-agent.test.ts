import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stopping the Windows service must stop the agent, not orphan it.
 *
 * The service runs `cmd.exe`, which runs `java`. The launcher exists for a good
 * reason - it applies a staged update at the one moment nothing holds the jar
 * open - but it makes the JVM a grandchild of the service, and WinSW's default
 * is to stop the process it started and leave the rest running.
 *
 * So stopping the service killed the launcher and left the agent alive. It kept
 * publishing, kept its MQTT connection, and kept its client id.
 *
 * AWS IoT permits one connection per client id and evicts the older when a
 * second arrives. Two agents from one machine therefore evict each other
 * indefinitely. Measured on a real install: 242 disconnections in eight hours,
 * at a metronomic 129.5-second interval, each connection living about a second
 * before being displaced. Every reconnect reported `sessionPresent=false`, so
 * subscriptions were re-established each time and any watch instruction
 * arriving in a gap was dropped.
 *
 * None of it appeared as a failure. The service was Running, the console showed
 * the agent online and publishing, and the only symptom was streams that took
 * an unreasonable time to start. It was found by counting lines in a log, and
 * confirmed by killing the orphan: the disconnections stopped dead.
 *
 * This happens on any restart, which means on every remote update - so an
 * estate would accumulate one orphan per update per machine.
 */
const ROOT = join(__dirname, '..', '..');
const service = () =>
  readFileSync(join(ROOT, 'packaging', 'windows', 'camstream-agent.xml'), 'utf8');

describe('stopping the Windows service stops the agent', () => {
  it('stops child processes before the parent', () => {
    // WinSW defaults this to true, which kills cmd.exe and orphans java.
    expect(service()).toMatch(/<stopparentprocessfirst>\s*false\s*<\/stopparentprocessfirst>/);
  });

  it('still runs the agent through the launcher', () => {
    // If the launcher ever goes away the setting above is pointless, but so is
    // the staged-update mechanism - this pins why the tree has two levels at
    // all, so the two facts are read together.
    expect(service()).toMatch(/<executable>/);
    expect(service()).toMatch(/camstream-agent\.jar/);
  });
});
