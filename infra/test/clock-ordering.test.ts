import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The agent must not start before the machine knows what time it is.
 *
 * A Raspberry Pi has no clock battery. It boots at whatever fake-hwclock last
 * wrote to disk, so the error on restore is the save interval plus the length
 * of the outage - and the outage is unbounded. No save interval fixes this.
 *
 * AWS refuses to sign a request whose clock is more than about five minutes
 * out, and refuses with a bare 403. That produces the worst shape a fault can
 * have: the agent connects, heartbeats, discovers devices and reports itself
 * healthy in the console, while its configuration fetch is refused - so it
 * holds no credentials and publishes no cameras. Every symptom points at the
 * camera and its password. Both were fine. It cost a day.
 *
 * time-sync.target is the fix because it is the only thing here that can wait:
 * it is reached once chrony has actually stepped the clock, which took 103
 * seconds on the machine this was found on. It trades a slower start for a
 * start that works.
 *
 * These are file assertions rather than behavioural ones because the failure
 * is silent. Delete the two lines and everything still builds, installs, runs
 * and passes; the cost appears at the next power cut, at a site nobody is
 * standing at, as a camera that is simply missing.
 */
const ROOT = join(__dirname, '..', '..');

const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');
const unit = () => read('packaging', 'linux', 'camstream-agent.service');

describe('the agent waits for a real clock', () => {
  it('is ordered after the clock is synchronised', () => {
    expect(unit()).toMatch(/^After=time-sync\.target$/m);
  });

  it('pulls the target in itself', () => {
    // After= alone is inert: it constrains ordering only if something else
    // already pulls time-sync.target into the boot. Wants= is what makes the
    // ordering happen at all, and without it the guard is decoration.
    expect(unit()).toMatch(/^Wants=time-sync\.target$/m);
  });

  it('installs something that actually reaches that target', () => {
    // On Debian and Raspberry Pi OS the unit that reaches time-sync.target is
    // chrony-wait.service, and it is not enabled by default. Unenabled, the
    // target is reached immediately and both lines above mean nothing - which
    // is a worse state than not having them, because it looks handled.
    expect(read('packaging', 'linux', 'install.sh'))
      .toMatch(/systemctl enable chrony-wait\.service/);
  });
});
