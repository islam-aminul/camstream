import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The control plane's heartbeat has to beat faster than the agent's patience.
 *
 * These two numbers live in different languages in different packages and are
 * never read together, so nothing connected them: the control plane repeats an
 * unchanged desired state every WATCH_RESEND_SECONDS, and the agent stops
 * every rendition once no instruction has arrived for idleShutdownSeconds.
 * Publishing only on change is deliberate and worth keeping - it is what stops
 * the fan-out being agents x viewers - but it makes the resend the only sound
 * an agent hears while somebody watches.
 *
 * Set 300 against 30 and the result is not a slow stream, it is no stream:
 * ffmpeg starts, publishes for half a minute, stops itself, and comes back for
 * another half minute every five. From the console that is indistinguishable
 * from a camera that never worked, and it survived weeks of debugging aimed at
 * S3, cookies, playlists and the registry, because every one of those really
 * was reachable from the symptom.
 *
 * Headroom of 2x is the point rather than 1x: at parity a single dropped
 * QoS-1 message stops a stream somebody is actively watching.
 */
const ROOT = join(__dirname, '..', '..');

function resendSeconds(): number {
  const source = readFileSync(join(ROOT, 'infra', 'lambda', 'watch', 'index.ts'), 'utf8');
  const match = source.match(/const WATCH_RESEND_SECONDS = (\d+)/);
  expect(match, 'WATCH_RESEND_SECONDS should be declared in the watch lambda').not.toBeNull();
  return Number(match![1]);
}

/**
 * Every idle window the project ships: the compiled default, what each installer
 * writes, and the example an operator is invited to copy.
 */
function idleWindows(): Array<{ where: string; seconds: number }> {
  const found: Array<{ where: string; seconds: number }> = [];

  const config = join('agent', 'src', 'main', 'java', 'online', 'camstream', 'agent', 'config', 'AgentConfig.java');
  const java = readFileSync(join(ROOT, config), 'utf8').match(/int idleShutdownSeconds = (\d+)/);
  expect(java, 'AgentConfig should declare a default idle window').not.toBeNull();
  found.push({ where: config, seconds: Number(java![1]) });

  for (const template of [
    join('packaging', 'linux', 'install.sh'),
    join('packaging', 'windows', 'install.ps1'),
    join('scripts', 'provision-device.sh'),
    join('packaging', 'agent.yaml.example'),
  ]) {
    const written = readFileSync(join(ROOT, template), 'utf8').match(/idleShutdownSeconds: (\d+)/);
    expect(written, `${template} should write an idle window into agent.yaml`).not.toBeNull();
    found.push({ where: template, seconds: Number(written![1]) });
  }

  return found;
}

describe('watch cadence', () => {
  it('resends often enough that a watched stream is never stopped for silence', () => {
    const resend = resendSeconds();
    for (const { where, seconds } of idleWindows()) {
      expect(
        seconds,
        `${where} stops renditions after ${seconds}s, but the control plane may stay quiet for ${resend}s. ` +
          'A stream someone is watching would stop itself. Raise the window or shorten the resend.',
      ).toBeGreaterThanOrEqual(resend * 2);
    }
  });

  it('keeps the idle window inside the range the agent will accept', () => {
    // AgentConfig rejects anything outside 10..600 at startup, so a window
    // chosen here to clear the resend must still be a window the agent boots
    // with - otherwise every install crash-loops on its own config.
    const source = readFileSync(
      join(ROOT, 'agent', 'src', 'main', 'java', 'online', 'camstream', 'agent', 'config', 'AgentConfig.java'),
      'utf8',
    );
    const bounds = source.match(/idleShutdownSeconds < (\d+) \|\| idleShutdownSeconds > (\d+)/);
    expect(bounds, 'AgentConfig should validate the idle window').not.toBeNull();
    const [low, high] = [Number(bounds![1]), Number(bounds![2])];

    for (const { where, seconds } of idleWindows()) {
      expect(seconds, `${where} is outside the range AgentConfig accepts`).toBeGreaterThanOrEqual(low);
      expect(seconds, `${where} is outside the range AgentConfig accepts`).toBeLessThanOrEqual(high);
    }
  });
});
