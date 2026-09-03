import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLE_EXTENSION, BUNDLE_FORMATS, bundleKey, isBundleFormat, PLATFORMS } from '../lambda/admin/installer';

/**
 * One container format, for every platform.
 *
 * Windows had a .zip and the others a .tar.gz, and the split was the bug rather
 * than a detail of it. The agent's updater opened every bundle as a zip, so a
 * remote update on Linux failed on the archive header and stayed on the old
 * build — remote update worked on exactly one of the three platforms it was
 * offered for, and nobody knew until an agent was installed on a Pi.
 *
 * Two formats also means one of them is always the one nobody exercised: the
 * Windows bundle once stayed months behind because the zip step failed while
 * the tarballs published anyway.
 *
 * These assertions are cheap and the property is worth a lot, because the two
 * halves live in different languages — a lambda decides the key, a shell script
 * writes the file — and nothing else would notice them drifting apart.
 */
const ROOT = join(__dirname, '..', '..');

describe('the agent bundle', () => {
  it('is a tarball on every platform', () => {
    for (const platform of PLATFORMS) {
      expect(bundleKey('0.1.0', platform)).toBe(
        `downloads/camstream-agent-0.1.0-${platform}.tar.gz`);
    }
    expect(BUNDLE_EXTENSION).toBe('tar.gz');
  });

  it('is built in that format by the packaging script', () => {
    const script = readFileSync(join(ROOT, 'packaging', 'build-dist.sh'), 'utf8');
    for (const platform of PLATFORMS) {
      expect(script, `build-dist.sh should tar the ${platform} bundle`)
        .toContain(`camstream-agent-$VERSION-${platform}.tar.gz`);
    }
    // The zip branch existed only for Windows and needed a three-way fallback
    // because zip is not reliably installed. Its absence is the point.
    expect(script).not.toContain('make_zip');
  });

  it('is fetched and unpacked as a tarball by every generated installer', async () => {
    const { buildInstaller } = await import('../lambda/admin/installer');
    const identity = {
      thingName: 'acme--hq--one', tenantId: 'acme', premisesId: 'hq', deviceId: 'one',
      region: 'ap-south-1', bucket: 'b', apiInvokeUrl: 'https://x.invalid',
      iotDataEndpoint: 'x.invalid', iotCredentialsEndpoint: 'x.invalid',
      provisioningTemplate: 't', roleAlias: 'r', enrollmentToken: 'tok',
    };

    for (const platform of PLATFORMS) {
      const built = await buildInstaller(platform, identity as never, 'bucket', '0.1.0');
      const body = typeof built.body === 'string' ? built.body : built.body.toString('binary');
      expect(body, `${platform} installer should fetch a tarball`).toContain('agent.tar.gz');
      expect(body, `${platform} installer should not expand a zip bundle`)
        .not.toContain('Expand-Archive -Path "$Work');
    }
  });

  it('can still point an agent at the format it was built to read', () => {
    // The migration affordance. An agent built before the formats were
    // unified reads zip and nothing else, so telling it to fetch a tarball
    // fails on the archive header and it stays on the old build for ever -
    // unable to take the very update that would teach it the new format.
    // Without this, pass one of a format change needs a person at a keyboard.
    expect(bundleKey('0.1.0', 'windows', 'zip'))
      .toBe('downloads/camstream-agent-0.1.0-windows.zip');
    expect(bundleKey('0.1.0', 'windows')).toBe('downloads/camstream-agent-0.1.0-windows.tar.gz');
  });

  it('refuses a format it does not publish', () => {
    expect(isBundleFormat('tar.gz')).toBe(true);
    expect(isBundleFormat('zip')).toBe(true);
    expect(isBundleFormat('7z')).toBe(false);
    expect(isBundleFormat(undefined)).toBe(false);
    // The current format has to be first: it is the default everything else
    // falls back to.
    expect(BUNDLE_FORMATS[0]).toBe(BUNDLE_EXTENSION);
  });
});
