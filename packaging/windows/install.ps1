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
  [switch]$AllowSystemTools
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

function Assert-Runtime {
  Write-Host 'Preparing the bundled runtime...'
  $archives = Expand-Dependencies
  if ($archives.Count -eq 0 -and -not $AllowSystemTools) {
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

  $versionLine = (& $script:JavaBin -version 2>&1 | Select-Object -First 1)
  if ($versionLine -match 'version "(\d+)') {
    if ([int]$Matches[1] -lt 21) { throw "Java 21 or newer is required (found $($Matches[1]))." }
  }

  # What matters is the JVM's architecture, not the machine's: AWS CRT ships no
  # native for Windows on ARM64, but an x64 JVM running under Windows 11's
  # emulation reports x86_64 and loads the x64 library perfectly well.
  $props = (& $script:JavaBin -XshowSettings:properties -version 2>&1) -join "`n"
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
  $config = (& $script:FfmpegBin -hide_banner -version 2>&1) -join ' '
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

segmentDurationMs: 2000
playlistWindow: 4
idleShutdownSeconds: 30

discoveryEnabled: true
discoveryIntervalMinutes: 30

# Cameras are normally approved centrally in the admin console. Anything listed
# here is configured locally and takes precedence.
cameras: []
"@ | Set-Content -Path "$DataDir\agent.yaml" -Encoding UTF8
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
  # The template says <executable>java</executable>; replace it with the
  # bundled JVM so the service does not depend on SYSTEM's PATH either.
  (Get-Content "$Here\camstream-agent.xml" -Raw).Replace(
    '<executable>java</executable>', "<executable>$script:JavaBin</executable>") |
    Set-Content -Path "$InstallDir\$ServiceName.xml" -Encoding UTF8

  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    & $exe stop  2>$null | Out-Null
    & $exe uninstall 2>$null | Out-Null
    Start-Sleep -Seconds 2
  }
  & $exe install
  & $exe start
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
