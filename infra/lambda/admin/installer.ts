import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { makeZip, type ZipEntry } from './zip';

const s3 = new S3Client({});

/** How long the installer has to download the agent bundle. */
const DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;

export type Platform = 'linux' | 'windows';

export const PLATFORMS: Platform[] = ['linux', 'windows'];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as string[]).includes(value);
}

/**
 * A presigned link to the generic agent bundle.
 *
 * The bundle lives under a `downloads/` prefix that no CloudFront behaviour
 * maps to, so it is reachable only through a link signed here — the binary is
 * not a secret, but it should not be anonymously enumerable either.
 */
/**
 * One container format for every platform.
 *
 * Windows used to get a .zip and the others a .tar.gz, and that split was the
 * bug rather than an incidental detail of it: the agent's updater opened every
 * bundle as a zip, so a remote update on Linux failed on the archive header and
 * stayed on the old build. Two formats meant one of them was always the one
 * nobody had exercised - the same reason the Windows bundle once silently
 * stayed months behind the other two when the zip step failed and the tarballs
 * published anyway.
 *
 * tar.gz is the format that exists everywhere. Windows has shipped bsdtar as
 * \Windows\System32\tar.exe since Windows 10 1803, and Linux has always
 * had tar. `unzip` is the one with the extra dependency: it is not
 * installed by default on a current Ubuntu, and was missing on the first
 * Raspberry Pi this was deployed to.
 *
 * The per-agent installer folder is still a .zip. A person downloads that one
 * and opens it in Explorer or Finder, which is a different requirement from an
 * archive only scripts ever read.
 */
export const BUNDLE_EXTENSION = 'tar.gz';

/**
 * Formats an agent may be pointed at, newest first.
 *
 * "zip" is here only so a fleet can be migrated off it. An agent built before
 * the formats were unified reads zip and nothing else, so telling it to fetch
 * a tarball fails on the archive header and it stays on the old build for
 * ever - it cannot take the very update that would teach it the new format.
 *
 * Changing a container format therefore needs two passes: publish a build that
 * reads both, in the format the fleet can still read; then, once every agent
 * has it, switch what is published. This parameter is what makes the first
 * pass possible without visiting machines, which is the whole point of remote
 * update.
 */
export const BUNDLE_FORMATS = ['tar.gz', 'zip'] as const;
export type BundleFormat = (typeof BUNDLE_FORMATS)[number];

export function isBundleFormat(value: unknown): value is BundleFormat {
  return typeof value === 'string' && (BUNDLE_FORMATS as readonly string[]).includes(value);
}

/** Where a platform's bundle lives. The one place that spells this out. */
export function bundleKey(
  version: string,
  platform: Platform,
  format: BundleFormat = BUNDLE_EXTENSION,
): string {
  return `downloads/camstream-agent-${version}-${platform}.${format}`;
}

export async function bundleUrl(
  bucket: string,
  platform: Platform,
  version: string,
  format: BundleFormat = BUNDLE_EXTENSION,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: bundleKey(version, platform, format) }),
    { expiresIn: DOWNLOAD_TTL_SECONDS },
  );
}

/**
 * Builds the per-agent bootstrap script an administrator downloads.
 *
 * Deliberately tiny. Assembling a 30MB bundle per agent would exceed Lambda's
 * response limit and defeat caching of a binary that is identical for every
 * customer; instead the identity travels inline and the bundle is fetched on
 * the target machine.
 *
 * The result contains a live enrollment token, so it is a secret until used.
 */
export async function buildInstaller(
  platform: Platform,
  identity: Record<string, unknown>,
  bucket: string,
  version: string,
): Promise<{ filename: string; contentType: string; body: string }> {
  const url = await bundleUrl(bucket, platform, version);
  const thing = String(identity.thingName);
  const json = JSON.stringify(identity, null, 2);

  if (platform === 'windows') {
    return {
      filename: `install-${thing}.ps1`,
      contentType: 'text/plain; charset=utf-8',
      body: windowsScript(thing, json, url, version),
    };
  }
  return {
    filename: `install-${thing}.sh`,
    contentType: 'text/x-shellscript; charset=utf-8',
    body: posixScript(thing, json, url, version, platform),
  };
}

/**
 * The same installer, packaged for someone who has to carry it to a machine.
 *
 * A bare .ps1 is awkward to hand over: it cannot be double-clicked, it arrives
 * with the execution policy against it, and it says nothing about the runtime
 * archives the operator has to supply. A folder answers all three — a launcher
 * that sets the policy for that one invocation, the script itself, and the
 * note explaining what else is needed, next to the empty directory it goes in.
 */
export async function buildInstallerArchive(
  platform: Platform,
  identity: Record<string, unknown>,
  bucket: string,
  version: string,
): Promise<{ filename: string; contentType: string; body: Buffer }> {
  const script = await buildInstaller(platform, identity, bucket, version);
  const thing = String(identity.thingName);

  const entries: ZipEntry[] = [
    {
      name: script.filename,
      data: Buffer.from(script.body, 'utf8'),
      executable: platform !== 'windows',
    },
    { name: 'dependencies/README.txt', data: Buffer.from(dependenciesNote(platform), 'utf8') },
  ];

  if (platform === 'windows') {
    // CRLF: a .cmd with bare newlines is read by cmd.exe one byte at a time
    // and misbehaves in ways that are hard to see.
    entries.unshift({
      name: `install-${thing}.cmd`,
      data: Buffer.from(
        windowsLauncher(script.filename).replace(/\n/g, '\r\n'), 'utf8'),
    });
  }

  return {
    filename: `camstream-agent-${thing}-${platform}.zip`,
    contentType: 'application/zip',
    body: makeZip(entries),
  };
}

/**
 * A double-clickable launcher.
 *
 * -ExecutionPolicy Bypass applies to this one invocation only; it changes
 * nothing on the machine. %~dp0 is the folder the launcher is in, so the pair
 * can be extracted anywhere. The pause is there because a double-clicked
 * window closes the instant the script ends, taking the result with it.
 */
function windowsLauncher(scriptName: string): string {
  return `@echo off
REM CamStream agent installer.
REM
REM Double-click this, or run it from a prompt. It asks for administrator if it
REM does not already have it. Arguments are passed through:
REM
REM   install.cmd -AllowSystemTools    use java and ffmpeg already on this machine
REM   install.cmd -Replace             take this machine over from another agent
REM
setlocal
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${scriptName}" %*
set RESULT=%ERRORLEVEL%
if not "%RESULT%"=="0" (
  REM Held open only when there is something to read. A window that pauses on
  REM success makes every install end with a keypress for no reason; one that
  REM closes on failure takes the reason with it.
  echo.
  echo Install failed with exit code %RESULT%. The message above says why.
  pause
)
exit /b %RESULT%
`;
}

/** What has to be put in dependencies/, and why it is not shipped. */
function dependenciesNote(platform: Platform): string {
  const archives = platform === 'windows'
    ? 'a Java 21 runtime (.zip) and an FFmpeg build (.zip or .7z)'
    : 'a Java 21 runtime (.tar.gz) and an FFmpeg build (.tar.gz or .tar.xz)';
  const flag = platform === 'windows' ? '-AllowSystemTools' : '--allow-system-tools';
  const run = platform === 'windows' ? 'install.cmd' : './install-*.sh';

  return `CamStream agent - dependencies
==============================

Put ${archives} in this directory, then run the installer again.

The agent does not ship with either. Both carry licences you should choose
deliberately rather than inherit from us: FFmpeg builds differ in whether they
include GPL or non-free components, and Java runtimes differ in their support
and redistribution terms. Picking them yourself is the point, not an oversight.

The installer extracts whatever it finds here into the installation and pins
the agent to those exact binaries. Nothing is taken from PATH.

Where to get them
-----------------
  Java 21   Eclipse Temurin, Amazon Corretto, Azul Zulu, or your distribution
  FFmpeg    ffmpeg.org, or your distribution's package

If you would rather use tools already installed on this machine:

  ${run} ${flag}

Be aware that the service then depends on the PATH of the account it runs as,
which is not the PATH you see in your own shell - and that a later change to
those tools changes the agent's behaviour without anybody redeploying it.
`;
}

function posixScript(thing: string, identity: string, url: string, version: string, platform: Platform): string {
  return `#!/usr/bin/env bash
#
# CamStream agent installer for ${thing}
#
# Generated by the admin console. This file contains a single-use enrollment
# token: treat it as a secret until it has been run, and do not share it. The
# token is spent on first boot, and re-running this script afterwards will
# report that the device is already enrolled.
#
# The agent ships without a Java runtime or FFmpeg, so that you choose those
# builds and their licences. Put both archives in a directory and pass it:
#
#   ./install-${thing}.sh --dependencies ~/camstream-deps
#
# Root is needed to install the service; run it without and it re-runs itself
# under sudo rather than failing.
#
# With no --dependencies, a "dependencies" directory beside this script is
# used. Either way the binaries are extracted into the installation and the
# agent is pinned to them — nothing is taken from PATH.
#
set -euo pipefail

# Installing a service needs root. Rather than refusing and making the operator
# retype the line, ask for it — and before parsing arguments, so the
# re-executed copy is handed exactly what was typed. An absolute path is used
# because sudo does not promise to keep the working directory.
SELF="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/$(basename "\${BASH_SOURCE[0]}")"
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    echo "This installs a system service and needs root; re-running with sudo."
    exec sudo -- "$SELF" "$@"
  fi
  echo "This installs a system service and must be run as root." >&2
  echo "  su -c '$SELF $*'" >&2
  exit 1
fi

THING="${thing}"
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DEPS="$HERE/dependencies"
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dependencies) DEPS="\${2:-}"; shift 2 ;;
    --dependencies=*) DEPS="\${1#*=}"; shift ;;
    --allow-system-tools) EXTRA+=(--allow-system-tools); shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
BUNDLE_URL="${url}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching the CamStream agent (${version}, ${platform})..."
if command -v curl >/dev/null 2>&1; then
  curl -fSL --retry 3 -o "$WORK/agent.tar.gz" "$BUNDLE_URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$WORK/agent.tar.gz" "$BUNDLE_URL"
else
  echo "Neither curl nor wget is available." >&2
  exit 1
fi

tar -xzf "$WORK/agent.tar.gz" -C "$WORK"

# Written next to the bundle so install.sh can place it in the state directory.
cat > "$WORK/identity.json" <<'CAMSTREAM_IDENTITY'
${identity}
CAMSTREAM_IDENTITY
chmod 600 "$WORK/identity.json"

# The bundle ships an empty dependencies/ directory; fill it from wherever the
# operator put the archives, so install.sh finds them where it expects.
if [ -d "$DEPS" ]; then
  cp -f "$DEPS"/* "$WORK/dependencies/" 2>/dev/null || true
fi

"$WORK/install.sh" --identity "$WORK/identity.json" "\${EXTRA[@]+"\${EXTRA[@]}"}"
`;
}

function windowsScript(thing: string, identity: string, url: string, version: string): string {
  return `<#
  CamStream agent installer for ${thing}

  Generated by the admin console. This file contains a single-use enrollment
  token: treat it as a secret until it has been run. The token is spent on
  first boot, and re-running this afterwards reports the device as already
  enrolled.

  The agent ships without a Java runtime or FFmpeg, so that you choose those
  builds and their licences. Put both archives in a folder and pass it:

    .\\install-${thing}.ps1 -Dependencies C:\\camstream-deps

  With no -Dependencies, a "dependencies" folder beside this script is used.
  Either way the binaries are extracted into the installation and the agent is
  pinned to them - nothing is taken from PATH.

  Administrator rights are needed to install the service. Run it without them
  and it asks for elevation rather than failing.
#>
[CmdletBinding()]
param(
  [string]$Dependencies,
  [switch]$AllowSystemTools,
  # One machine hosts one agent. Set this to take a machine over from another.
  [switch]$Replace,
  # Set when this script relaunched itself elevated. The new window is the only
  # place the output appears, so a failure there has to be readable before it
  # closes - and a success has nothing worth holding the window open for.
  [switch]$Relaunched
)

trap {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  if ($Relaunched) { Read-Host 'Install failed. Press Enter to close' }
  exit 1
}
$ErrorActionPreference = 'Stop'

$Thing     = '${thing}'
$BundleUrl = '${url}'
$Work      = Join-Path $env:TEMP ("camstream-" + [guid]::NewGuid())
$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Dependencies) { $Dependencies = Join-Path $Here 'dependencies' }

# Installing a service needs administrator. Rather than refusing and making the
# operator go and find an elevated prompt, ask for one through UAC and hand the
# new window the same arguments. -NoExit keeps that window open: it is where
# the output goes, and a window that closes on completion takes the result with
# it.
<#
  Writes a UTF-8 text file with no byte-order mark.

  Windows PowerShell's -Encoding UTF8 writes one; PowerShell 7's does not.
  Three bytes of U+FEFF in front of a JSON file are rejected by every JSON
  parser there is, and this crash-looped a real install: the agent read
  identity.json, failed on its first character, exited, and was restarted every
  ten seconds forever.

  .NET is asked directly, because that is the only way to say "UTF-8, no mark"
  that both editions honour.
#>
function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Content
  )
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding $false))
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  # Only a person can answer a UAC prompt. In automation there is nobody to
  # ask, and delegating would let this script return success having installed
  # nothing - so there it fails as loudly as it used to.
  if (-not [Environment]::UserInteractive) {
    throw 'This installs a system service and needs administrator. Run it from an elevated prompt.'
  }
  Write-Host 'This installs a system service and needs administrator; asking for elevation.'
  $relaunch = @('-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $PSCommandPath + '"'), '-Relaunched')
  if ($Dependencies)     { $relaunch += @('-Dependencies', ('"' + $Dependencies + '"')) }
  if ($AllowSystemTools) { $relaunch += '-AllowSystemTools' }
  if ($Replace)          { $relaunch += '-Replace' }
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $relaunch | Out-Null
  } catch {
    throw 'Elevation was declined. Re-run this from an elevated PowerShell prompt.'
  }
  Write-Host 'Continuing in the elevated window.'
  return
}

New-Item -ItemType Directory -Force -Path $Work | Out-Null
try {
  Write-Host "Fetching the CamStream agent (${version}, windows)..."
  Invoke-WebRequest -Uri $BundleUrl -OutFile "$Work\\agent.tar.gz" -UseBasicParsing
  # tar.exe rather than Expand-Archive: the bundle is a .tar.gz on every
  # platform now. Windows has shipped bsdtar since 10/1803, and it is the
  # same single format the Linux installer and the agent's own
  # updater read.
  & tar.exe -xzf "$Work\\agent.tar.gz" -C $Work
  if ($LASTEXITCODE -ne 0) { throw "Could not unpack the agent bundle (tar exit $LASTEXITCODE)." }

  $identityJson = @'
${identity}
'@
  Write-Utf8NoBom -Path "$Work\\identity.json" -Content $identityJson

  # The bundle ships an empty dependencies\\ folder; fill it from wherever the
  # operator put the archives, so install.ps1 finds them where it expects.
  if (Test-Path $Dependencies) {
    Copy-Item "$Dependencies\\*" "$Work\\dependencies\\" -Force -ErrorAction SilentlyContinue
  }

  # Not $args: that is one of PowerShell's automatic variables, and
  # shadowing it inside a script that also takes parameters is a trap for
  # whoever edits this next.
  $installArgs = @{ IdentityPath = "$Work\\identity.json" }
  if ($AllowSystemTools) { $installArgs['AllowSystemTools'] = $true }
  if ($Replace)          { $installArgs['Replace'] = $true }
  & "$Work\\install.ps1" @installArgs
} finally {
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
`;
}

/**
 * What identifies a build, as opposed to what it calls itself.
 *
 * S3's ETag changes whenever the object does, which a version string does not:
 * every build of this project so far has called itself 0.1.0, so an agent
 * comparing versions would refuse them all as already installed. The ETag is
 * the answer to "is this the same bundle I am running", which is the question
 * actually being asked.
 */
/**
 * The build id and the signature, from one HeadObject.
 *
 * Both are properties of the published object, so asking twice would be two
 * round trips for one answer. The signature is written as object metadata at
 * publish time rather than kept beside the bundle, which means it cannot go
 * missing separately from the thing it describes.
 *
 * Absent on a bundle published before signing existed. The agent treats a
 * missing signature as unsigned, which it still accepts while the fleet
 * migrates - see docs/signing.md.
 */
export async function bundleFacts(
  bucket: string,
  platform: Platform,
  version: string,
  format: BundleFormat = BUNDLE_EXTENSION,
): Promise<{ build?: string; signature?: string; keyId?: string }> {
  try {
    const head = await s3.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: bundleKey(version, platform, format),
    }));
    return {
      build: head.ETag?.replaceAll('"', ''),
      signature: head.Metadata?.signature,
      keyId: head.Metadata?.['signing-key-id'],
    };
  } catch {
    // Same reasoning as below: failing the whole instruction because the head
    // request failed would be worse than sending it without these.
    return {};
  }
}

export async function bundleBuildId(
  bucket: string,
  platform: Platform,
  version: string,
  format: BundleFormat = BUNDLE_EXTENSION,
): Promise<string | undefined> {
  try {
    const head = await s3.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: bundleKey(version, platform, format),
    }));
    return head.ETag?.replaceAll('"', '');
  } catch {
    // Without one the agent falls back to comparing versions, which is worse
    // but not wrong. Failing the whole instruction over it would be.
    return undefined;
  }
}
