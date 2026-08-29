<#
.SYNOPSIS
  Installs CamStreamAgent as a Windows service, with its own runtime.

.DESCRIPTION
  The agent runs the Java and FFmpeg binaries shipped in this bundle's
  dependencies\ directory, extracted into the installation directory. Nothing
  is read from PATH and nothing is installed system-wide.

  That is deliberate. An edge box is not a developer workstation: PATH differs
  between the installing user and SYSTEM, another product's installer can put a
  different java ahead of yours, and a distribution upgrade can replace ffmpeg
  under a running service. Pinning the binaries means the agent keeps running
  exactly what was tested.

  Java cannot answer the Service Control Manager directly, so one of two
  mechanisms is used:

    WinSW (default)  a real Windows service, with restart-on-failure and log
                     rolling. MIT licensed; downloaded unless already present.
    Scheduled task   no external dependency, runs at boot as SYSTEM. Chosen
                     with -UseScheduledTask, or automatically when WinSW cannot
                     be obtained. Restarts on failure, but is not visible in
                     services.msc.

.EXAMPLE
  .\install.ps1 -IdentityPath .\identity.json   # zero-touch enrollment
  .\install.ps1 -ConfigPath .\agent.yaml        # pre-configured agent
#>
[CmdletBinding()]
param(
  [string]$IdentityPath,
  [string]$ConfigPath,
  [switch]$UseScheduledTask,
  [string]$InstallDir = "$env:ProgramFiles\CamStream",
  [string]$DataDir = "$env:ProgramData\CamStream",
  # Where the runtime archives were put. Anything extractable in here is
  # unpacked into $InstallDir\runtime and used in preference to the system.
  [string]$DependencyDir,
  # Escape hatch for a box that genuinely does have a curated PATH.
  [switch]$AllowSystemTools,
  # Take this machine over for a different agent, discarding the identity and
  # certificate of the one installed here now. One machine hosts one agent.
  [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'camstream-agent'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell prompt.'
  }
}

$RuntimeDir = "$InstallDir\runtime"

<#
  Unpacks every archive in dependencies\ into $InstallDir\runtime.

  Windows ships bsdtar as tar.exe, which reads .7z, .tar.gz, .tar.xz and .tar
  alike - so the convenient FFmpeg builds, which are distributed as .7z, need
  no third-party extractor. Expand-Archive handles .zip, which is what the
  Temurin JRE downloads are.
#>
function Expand-Dependencies {
  $source = if ($DependencyDir) { $DependencyDir } else { "$Here\dependencies" }
  if (-not (Test-Path $source)) {
    return @()
  }

  $archives = Get-ChildItem -Path $source -File | Where-Object {
    $_.Name -match '\.(zip|7z|tar|tgz|tar\.gz|tar\.xz|tar\.bz2)$'
  }
  if ($archives.Count -eq 0) {
    return @()
  }

  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  foreach ($archive in $archives) {
    # One directory per archive, named after it, so two runtimes cannot
    # overwrite one another and a re-install is idempotent.
    $name = $archive.Name -replace '\.(zip|7z|tar|tgz|tar\.gz|tar\.xz|tar\.bz2)$', ''
    $target = "$RuntimeDir\$name"
    if (Test-Path $target) {
      Write-Host "  already extracted: $($archive.Name)"
      continue
    }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Write-Host "  extracting $($archive.Name)..."

    if ($archive.Name -match '\.zip$') {
      Expand-Archive -Path $archive.FullName -DestinationPath $target -Force
    } else {
      & tar.exe -xf $archive.FullName -C $target
      if ($LASTEXITCODE -ne 0) {
        Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue
        throw @"
Could not extract $($archive.Name).

Windows' built-in tar handles .7z, .tar.gz and .tar.xz, but this copy refused
it. Download the .zip build of the same tool instead and re-run.
"@
      }
    }
  }
  return $archives
}

<#
  Finds one executable inside the extracted runtime.

  Archive layouts vary between builds and between versions of the same build,
  so the tree is searched rather than a path being assumed. A copy under bin\
  wins, which is what distinguishes a real JRE layout from a stray tool.
#>
function Find-Bundled([string]$exeName) {
  if (-not (Test-Path $RuntimeDir)) { return $null }
  $found = Get-ChildItem -Path $RuntimeDir -Filter $exeName -Recurse -File -ErrorAction SilentlyContinue
  if (-not $found) { return $null }
  $preferred = $found | Where-Object { $_.DirectoryName -match '\\bin$' } | Select-Object -First 1
  if ($preferred) { return $preferred.FullName }
  return ($found | Select-Object -First 1).FullName
}

function Resolve-Tool([string]$exeName, [string]$what) {
  $bundled = Find-Bundled $exeName
  if ($bundled) { return $bundled }

  if ($AllowSystemTools) {
    $onPath = Get-Command $exeName -ErrorAction SilentlyContinue
    if ($onPath) {
      Write-Warning "$exeName came from PATH, not from this bundle. It can change underneath the service."
      return $onPath.Source
    }
  }

  throw @"
$exeName was not found in this bundle.

Put $what into the dependencies\ directory next to this installer and run it
again. dependencies\README.txt lists where to download it and which package to
choose. Nothing needs to be unpacked first.

Looked in: $RuntimeDir
"@
}

<#
  Runs a bundled tool and returns everything it printed, stdout and stderr
  alike, as plain strings.

  Windows PowerShell wraps a native command's stderr in ErrorRecords whenever
  it is redirected, and with $ErrorActionPreference = 'Stop' the first of those
  ends the script. `java -version` writes the version to stderr, so the check
  that this is Java 21 was itself fatal - on the shell that ships with Windows
  and that most operators will use.

  PowerShell 7 does not do this, which is why every automated run of this file
  passed while every hand run failed.

  The preference is lowered inside this function only, so a genuine failure
  anywhere else still stops the install.
#>
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

function Invoke-Tool {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @())
  $ErrorActionPreference = 'Continue'
  $output = & $Exe @Arguments 2>&1
  return @($output | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { $_ }
  })
}

function Assert-Runtime {
  Write-Host 'Preparing the bundled runtime...'
  $archives = Expand-Dependencies

  # An installation that already has a runtime does not need the archives
  # again. Demanding them on every re-install meant upgrading a machine, or
  # moving it to another agent, required the operator to go and find the same
  # two files they used the first time - which on a site visit months later is
  # the difference between a two-minute job and an abandoned one.
  $haveRuntime = (Test-Path $RuntimeDir) -and @(Get-ChildItem -Path $RuntimeDir -Filter 'java.exe' `
      -Recurse -File -ErrorAction SilentlyContinue).Count -gt 0
  if ($haveRuntime -and $archives.Count -eq 0) {
    Write-Host '  using the runtime already installed here'
  }

  if ($archives.Count -eq 0 -and -not $haveRuntime -and -not $AllowSystemTools) {
    throw @"
The dependencies\ directory is empty.

The agent ships without a Java runtime or FFmpeg so that you choose the builds
and their licences. Put both archives in dependencies\ and run this again -
see dependencies\README.txt.

To use tools already on this machine instead, re-run with -AllowSystemTools.
Be aware the service then depends on SYSTEM's PATH, which is not the PATH you
see in this window.
"@
  }

  $script:JavaBin = Resolve-Tool 'java.exe' 'a JRE 21 or newer'
  $script:FfmpegBin = Resolve-Tool 'ffmpeg.exe' 'an FFmpeg build'
  $script:FfprobeBin = Resolve-Tool 'ffprobe.exe' 'an FFmpeg build (ffprobe ships with it)'

  Write-Host "  java:    $script:JavaBin"
  Write-Host "  ffmpeg:  $script:FfmpegBin"
  Write-Host "  ffprobe: $script:FfprobeBin"

  $versionLine = (Invoke-Tool $script:JavaBin @('-version')) | Select-Object -First 1
  if ($versionLine -match 'version "(\d+)') {
    if ([int]$Matches[1] -lt 21) { throw "Java 21 or newer is required (found $($Matches[1]))." }
  }

  # What matters is the JVM's architecture, not the machine's: AWS CRT ships no
  # native for Windows on ARM64, but an x64 JVM running under Windows 11's
  # emulation reports x86_64 and loads the x64 library perfectly well.
  $props = (Invoke-Tool $script:JavaBin @('-XshowSettings:properties', '-version')) -join "`n"
  $jvmArch = if ($props -match 'os\.arch\s*=\s*(\S+)') { $Matches[1] } else { 'unknown' }
  Write-Host "  jvm architecture: $jvmArch"

  if ($jvmArch -eq 'aarch64' -or $jvmArch -eq 'arm64') {
    throw @'
This is an ARM64 JVM, and the AWS CRT native library is not published for
Windows on ARM - the agent would fail at startup with an UnsatisfiedLinkError.

Put an x64 JRE in dependencies\ instead and re-run. Windows 11 on ARM runs x64
binaries under emulation, and the agent works normally that way.
'@
  }
  if ($jvmArch -eq 'x86') {
    Write-Warning 'A 32-bit JVM is bundled. Use a 64-bit JRE unless this machine really is 32-bit.'
  }

  # CamStream stream-copies and needs no GPL codec. Warn, do not block.
  $config = (Invoke-Tool $script:FfmpegBin @('-hide_banner', '-version')) -join ' '
  if ($config -match '--enable-gpl|--enable-nonfree') {
    Write-Warning 'This ffmpeg build is GPL/non-free. Fine for evaluation; do not redistribute it. See LICENSING.md.'
  }
}

Assert-Admin

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Assert-Runtime

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir, "$DataDir\logs" | Out-Null

Write-Host 'Installing agent...'
Copy-Item "$Here\camstream-agent.jar" "$InstallDir\camstream-agent.jar" -Force

if ($IdentityPath) {
  if (-not (Test-Path $IdentityPath)) { throw "Identity file not found: $IdentityPath" }

  # One machine hosts one agent: there is a single service and a single data
  # directory. Installing a second agent over the first used to produce a
  # mixture that could not work and did not say so - the new identity, the old
  # configuration, and the previous agent's certificate. The new agent never
  # enrolled, the old one stopped, and the console showed both as offline with
  # no explanation.
  $incoming = (Get-Content $IdentityPath -Raw | ConvertFrom-Json).thingName
  $existingIdentity = Join-Path $DataDir 'identity.json'
  if ((Test-Path $existingIdentity) -and -not $Replace) {
    $current = (Get-Content $existingIdentity -Raw | ConvertFrom-Json).thingName
    if ($current -and $current -ne $incoming) {
      throw @"
This machine is already running $current.
Installing $incoming here would replace it: there is one service and one data
directory, and the two cannot share them.

  To move this machine to $incoming, re-run with -Replace. Its certificate and
  local state are discarded and it enrols again from this installer.

  To upgrade $current instead, download its own installer from the console.
"@
    }
  }

  if ($Replace -and (Test-Path $existingIdentity)) {
    # A different agent's certificate is worse than none: the agent would
    # present it, IoT would refuse the identity it does not match, and the
    # failure would look like a network problem.
    Write-Host '  replacing the agent previously installed here'
    foreach ($stale in 'device.crt', 'device.key', 'identity.json', 'agent.yaml') {
      Remove-Item (Join-Path $DataDir $stale) -Force -ErrorAction SilentlyContinue
    }
  }

  # The agent enrols itself from this on first boot, then strips the secrets out
  # of it and keeps the endpoints.
  Copy-Item $IdentityPath "$DataDir\identity.json" -Force
  if (-not (Test-Path "$DataDir\agent.yaml")) {
    @"
# Written by install.ps1. Everything about this device's identity and endpoints
# comes from identity.json; only local preferences belong here.
identityFile: $DataDir\identity.json
stateDir: $DataDir

# Absolute paths into this installation's own runtime. The service runs as
# SYSTEM, whose PATH is not the one the installing administrator sees, and a
# later system upgrade must not be able to change which ffmpeg the agent runs.
ffmpegPath: $script:FfmpegBin
ffprobePath: $script:FfprobeBin

# Four seconds. Halving this doubles the S3 request bill, which is the largest
# single cost in the system - see the tile dial in the console, which quotes
# the price per hour from this number.
segmentDurationMs: 4000
playlistWindow: 4
idleShutdownSeconds: 30

discoveryEnabled: true
discoveryIntervalMinutes: 30

# Cameras are normally approved centrally in the admin console. Anything listed
# here is configured locally and takes precedence.
cameras: []
"@ | ForEach-Object { Write-Utf8NoBom -Path "$DataDir\agent.yaml" -Content $_ }
    Write-Host "  wrote $DataDir\agent.yaml"
  }
} elseif ($ConfigPath) {
  Copy-Item $ConfigPath "$DataDir\agent.yaml" -Force
} elseif (-not (Test-Path "$DataDir\agent.yaml")) {
  Copy-Item "$Here\agent.yaml.example" "$DataDir\agent.yaml" -Force
  Write-Host "  wrote a template to $DataDir\agent.yaml - edit it before starting"
}

# However the config arrived, it must name the binaries this installation
# resolved. A config without these falls back to bare "ffmpeg" on SYSTEM's
# PATH, which is exactly what the bundled runtime exists to remove. An operator
# who set them deliberately keeps their choice.
$configPath = "$DataDir\agent.yaml"
$configText = Get-Content $configPath -Raw
if ($configText -notmatch '(?m)^\s*ffmpegPath:') {
  Add-Content -Path $configPath -Encoding UTF8 -Value @"

# Added by install.ps1: absolute paths into this installation's own runtime.
ffmpegPath: $script:FfmpegBin
"@
  Write-Host '  pinned ffmpegPath to the bundled runtime'
}
if ($configText -notmatch '(?m)^\s*ffprobePath:') {
  Add-Content -Path $configPath -Encoding UTF8 -Value "ffprobePath: $script:FfprobeBin"
  Write-Host '  pinned ffprobePath to the bundled runtime'
}

# Device identity, if the provisioning bundle was placed alongside.
foreach ($file in 'device.crt', 'device.key', 'credential-key.pem') {
  if (Test-Path "$Here\$file") { Copy-Item "$Here\$file" "$DataDir\$file" -Force }
}

# The config and keys hold camera credentials: administrators and SYSTEM only.
$acl = Get-Acl $DataDir
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
foreach ($account in 'SYSTEM', 'Administrators') {
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
    $account, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl $DataDir $acl

<#
  Writes the launcher the service actually runs.

  It exists for one reason: a JVM holds its own jar open on Windows, so an
  agent cannot replace the file it is running from - the move fails with
  "access denied" and the update silently never happens. The agent therefore
  stages the new build as camstream-agent.jar.new, and this swaps it in at the
  only moment nothing has the jar open, which is just before the JVM starts.

  The previous jar is kept beside it. If a new build will not start, that is
  the copy that did, already on the machine that needs it.
#>
function Write-Launcher {
  $launcher = "$InstallDir\run-agent.cmd"
  $body = @"
@echo off
REM Written by install.ps1. Runs the agent, swapping in a staged update first.
setlocal
set JAR=$InstallDir\camstream-agent.jar
if exist "%JAR%.new" (
  echo Applying staged update...
  if exist "%JAR%" copy /Y "%JAR%" "%JAR%.previous" >nul
  move /Y "%JAR%.new" "%JAR%" >nul
)
"$script:JavaBin" -XX:MaxRAMPercentage=50 -jar "%JAR%" "$DataDir\agent.yaml"
exit /b %ERRORLEVEL%
"@
  Write-Utf8NoBom -Path $launcher -Content $body
  return $launcher
}

function Install-WithWinSW {
  $exe = "$InstallDir\$ServiceName.exe"
  if (-not (Test-Path $exe)) {
    if (Test-Path "$Here\WinSW.exe") {
      Copy-Item "$Here\WinSW.exe" $exe -Force
    } else {
      Write-Host 'Downloading WinSW (MIT)...'
      $url = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
      Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    }
  }
  # The service runs the launcher, not java directly, so a staged update can
  # be applied at the one moment nothing holds the jar open. Matched by
  # pattern rather than by literal: the arguments carry backslashes and
  # percent signs, and a long exact string is one typo from silently not
  # matching - which left the service running cmd.exe with java's arguments.
  $launcher = Write-Launcher
  $xml = Get-Content "$Here\camstream-agent.xml" -Raw
  $xml = $xml -replace '<executable>[^<]*</executable>', '<executable>cmd.exe</executable>'
  $xml = $xml -replace '<arguments>[^<]*</arguments>', ('<arguments>/c "' + $launcher + '"</arguments>')
  if ($xml -notmatch [regex]::Escape($launcher)) {
    throw 'Could not point the service at the launcher; refusing to install a broken service.'
  }
  $xml |
    ForEach-Object { Write-Utf8NoBom -Path "$InstallDir\$ServiceName.xml" -Content $_ }

  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    & $exe stop  2>$null | Out-Null
    & $exe uninstall 2>$null | Out-Null

    # Deleting a service is asynchronous: the Service Control Manager keeps it
    # until every handle to it closes, and a fixed two-second sleep was not
    # enough. Installing into that window fails with "already exists", and the
    # machine is left with no service at all.
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Service $ServiceName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
    }
    if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
      throw "The existing $ServiceName service could not be removed. Close services.msc, or any window showing it, and run this again."
    }
  }

  # WinSW reports failure by exit code, and the script used to ignore it and
  # print "Installed as a Windows service" regardless - which is how a machine
  # came to have no service and a successful install.
  & $exe install
  if ($LASTEXITCODE -ne 0) { throw "WinSW could not install the service (exit $LASTEXITCODE)." }
  & $exe start
  if ($LASTEXITCODE -ne 0) { throw "WinSW installed the service but could not start it (exit $LASTEXITCODE)." }

  $running = Get-Service $ServiceName -ErrorAction SilentlyContinue
  if (-not $running) { throw 'The service was not registered.' }
  Write-Host "Installed as a Windows service. Manage it with: sc.exe query $ServiceName"
}

function Install-WithScheduledTask {
  $action = New-ScheduledTaskAction -Execute $script:JavaBin `
    -Argument "-XX:MaxRAMPercentage=50 -jar `"$InstallDir\camstream-agent.jar`" `"$DataDir\agent.yaml`"" `
    -WorkingDirectory $DataDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  # Never stop it: this is a daemon, not a maintenance job.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

  Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description 'CamStream edge ingestion agent' | Out-Null
  Start-ScheduledTask -TaskName $ServiceName
  Write-Host 'Installed as a scheduled task running at startup.'
  Write-Warning 'Not visible in services.msc. Manage it with Get-ScheduledTask -TaskName camstream-agent.'
}

if ($UseScheduledTask) {
  Install-WithScheduledTask
} else {
  try {
    Install-WithWinSW
  } catch {
    Write-Warning "WinSW route failed ($($_.Exception.Message)). Falling back to a scheduled task."
    Install-WithScheduledTask
  }
}

Write-Host ''
Write-Host "  config : $DataDir\agent.yaml"
Write-Host "  logs   : $DataDir\logs"
