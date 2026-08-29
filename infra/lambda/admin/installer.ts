import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { makeZip, type ZipEntry } from './zip';

const s3 = new S3Client({});

/** How long the installer has to download the agent bundle. */
const DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;

export type Platform = 'linux' | 'windows' | 'macos';

export const PLATFORMS: Platform[] = ['linux', 'windows', 'macos'];

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
async function bundleUrl(bucket: string, platform: Platform, version: string): Promise<string> {
  const extension = platform === 'windows' ? 'zip' : 'tar.gz';
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: `downloads/camstream-agent-${version}-${platform}.${extension}` }),
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
REM does not already have it. Arguments are passed through, so to use tools
REM already on this machine rather than supplying your own:
REM
REM   install.cmd -AllowSystemTools
REM
setlocal
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${scriptName}" %*
echo.
pause
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
  [switch]$AllowSystemTools
)
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
  $relaunch = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
  if ($Dependencies)     { $relaunch += @('-Dependencies', ('"' + $Dependencies + '"')) }
  if ($AllowSystemTools) { $relaunch += '-AllowSystemTools' }
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
  Invoke-WebRequest -Uri $BundleUrl -OutFile "$Work\\agent.zip" -UseBasicParsing
  Expand-Archive -Path "$Work\\agent.zip" -DestinationPath $Work -Force

  $identityJson = @'
${identity}
'@
  Write-Utf8NoBom -Path "$Work\\identity.json" -Content $identityJson

  # The bundle ships an empty dependencies\\ folder; fill it from wherever the
  # operator put the archives, so install.ps1 finds them where it expects.
  if (Test-Path $Dependencies) {
    Copy-Item "$Dependencies\\*" "$Work\\dependencies\\" -Force -ErrorAction SilentlyContinue
  }

  $args = @{ IdentityPath = "$Work\\identity.json" }
  if ($AllowSystemTools) { $args['AllowSystemTools'] = $true }
  & "$Work\\install.ps1" @args
} finally {
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
`;
}
