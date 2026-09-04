import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Windows agent does not run as LocalSystem.
 *
 * LocalSystem is the most privileged principal on a Windows machine. An agent
 * running as it can read any file, alter any service, load drivers and reach
 * every account on the box - none of which publishing a camera needs. On Linux
 * the agent is unprivileged and cannot even write its own program, so this was
 * the largest remaining asymmetry between the two platforms.
 *
 * A virtual account is the right principal: the Service Control Manager makes
 * it, it has its own SID so permissions can name it, and it has no password to
 * store, rotate or leak.
 *
 * What this deliberately does not fix: the account keeps write access to the
 * install directory, because a staged update is applied by the launcher in the
 * service's own identity. Taking that away would break remote updates, and the
 * privileged pre-start step that makes it safe on Linux has no cheap Windows
 * equivalent. A compromised agent can still replace its own jar - it can no
 * longer touch anything else.
 *
 * Tested here rather than by installing, because the failure is silent in the
 * direction that matters: drop the call and every install still works, starts
 * and streams. It is simply running as SYSTEM again, and nothing says so.
 */
const ROOT = join(__dirname, '..', '..');
const installer = () => readFileSync(join(ROOT, 'packaging', 'windows', 'install.ps1'), 'utf8');

describe('the Windows service runs as its own account', () => {
  it('sets a virtual account on the registered service', () => {
    expect(installer()).toMatch(/sc\.exe config \$ServiceName obj= \$account/);
    expect(installer()).toMatch(/\$account = "NT SERVICE\\\$ServiceName"/);
  });

  it('does it after registering and before starting', () => {
    // Order is the whole trick. The account does not exist until the service
    // is configured to use it, and the service cannot read its own files until
    // the permissions are granted - so a start in between fails.
    const source = installer();
    const install = source.indexOf('& $exe install');
    // The call, not the declaration. Searching for the bare name finds the
    // function definition, which sits above everything and made this pass
    // whatever the order really was.
    //
    // Matched as a line rather than with literal newlines: this file is stored
    // with CRLF, so a "\n...\n" search succeeds on a working copy checked out
    // with LF and fails on CI, which is exactly how it was found.
    const setAccount = source.search(/^[ \t]+Set-ServiceAccount[ \t]*\r?$/m);
    const start = source.indexOf('& $exe start');

    expect(install, 'the installer should register the service').toBeGreaterThan(-1);
    expect(setAccount, 'expected a call to Set-ServiceAccount').toBeGreaterThan(-1);
    expect(setAccount).toBeGreaterThan(install);
    expect(start).toBeGreaterThan(setAccount);
  });

  it('grants the new account access to both directories it needs', () => {
    // Without this the service starts as a principal that cannot read its own
    // jar, which presents as a service that will not stay running - and the
    // cause is invisible from the agent's own log, because there isn't one.
    const source = installer();
    expect(source).toMatch(/icacls\.exe \$path \/grant/);
    expect(source).toMatch(/foreach \(\$path in @\(\$InstallDir, \$DataDir\)\)/);
  });

  it('warns rather than refusing when the account cannot be set', () => {
    // An agent running as LocalSystem is how every install worked until now.
    // Failing the install would trade a working camera for a hardening
    // improvement, which is the wrong way round - but it must be said aloud.
    expect(installer()).toMatch(/WARNING: could not run the service as/);
  });
});
