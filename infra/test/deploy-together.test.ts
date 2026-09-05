import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * The control plane and the console deploy together.
 *
 * They are two separate deploys, and skipping the second is silent. `cdk
 * deploy` reports success, the API gains its new endpoints, and the site keeps
 * serving whatever bundle was last synced. Nothing in the console names the
 * build it came from, and nothing compares the bundle behind CloudFront to the
 * commit, so the only way to notice is to fetch the deployed JavaScript and
 * grep it for something new.
 *
 * That is not hypothetical. It happened twice on 2026-09-05: once leaving the
 * site on a bundle from 28 August, with the clock-drift tag, the last-report
 * and in-service columns and the rename action merged for days and reachable
 * by nobody; and again the same afternoon, an hour after the first had been
 * written up as a known trap.
 *
 * Worth guarding at this level because the failure is invisible from both
 * ends. Both deploys report success. Only the two together are one.
 */
const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

describe('deploying', () => {
  const script = () => read('scripts', 'deploy.sh');

  it('does the control plane and the console in one place', () => {
    expect(script()).toMatch(/cdk deploy/);
    expect(script()).toMatch(/deploy-web\.sh/);
  });

  it('does the stack first', () => {
    // deploy-web.sh reads the bucket name and the Cognito ids out of the
    // stack's outputs and writes them into the console's config, so the other
    // order publishes a console pointed at whatever the stack used to be.
    const source = script();
    expect(source.indexOf('cdk deploy')).toBeLessThan(source.indexOf('deploy-web.sh'));
  });

  it('is executable where it counts', () => {
    // Asked of git rather than of the filesystem. The mode git records is what
    // a Linux operator receives, and it is the only one that survives a clone:
    // NTFS has no executable bit, and Node on Windows reports none either, so
    // a filesystem check passes or fails for reasons unrelated to the answer.
    //
    // Not theoretical - this file was committed 100644 the first time, which
    // would have made the command the README gives fail with "Permission
    // denied" on every machine that matters.
    const mode = execSync('git ls-files -s scripts/deploy.sh', { cwd: ROOT, encoding: 'utf8' })
      .trim().split(/\s+/)[0];
    expect(mode, 'scripts/deploy.sh should be committed executable').toBe('100755');
  });

  it('stamps the console with the commit it was built from', () => {
    // Into config.json specifically. Everything else behind CloudFront is
    // content-hashed and cached forever, so an old bundle is indistinguishable
    // from a current one from outside; config.json is fetched no-store and
    // rewritten on every deploy, so it is the only file that cannot lie.
    const web = read('scripts', 'deploy-web.sh');
    expect(web).toMatch(/rev-parse --short HEAD/);
    expect(web).toMatch(/"buildCommit":/);
    expect(web).toMatch(/"builtAt":/);
  });

  it('writes the stamp into the file that is never cached', () => {
    // Ordering, not presence: the commit has to be computed before the heredoc
    // that writes config.json, or the field is written empty and the whole
    // point is lost while still looking correct.
    const web = read('scripts', 'deploy-web.sh');
    expect(web.indexOf('rev-parse --short HEAD'))
      .toBeLessThan(web.indexOf('cat > dist/config.json'));
    // And config.json must stay out of the immutable sync, or the stamp is
    // cached as hard as the bundle it describes.
    expect(web).toMatch(/--exclude "config\.json"/);
  });

  it('is what the README tells people to use', () => {
    // The trap is only closed if this is the documented path. Leaving the
    // README pointing at the two separate commands would keep the habit that
    // caused it.
    expect(read('README.md')).toMatch(/\.\/scripts\/deploy\.sh/);
  });
});
