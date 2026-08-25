<#
.SYNOPSIS
  Installs CamStreamAgent as a Windows service.

.DESCRIPTION
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
  [string]$DataDir = "$env:ProgramData\CamStream"
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

function Assert-Prerequisites {
  foreach ($tool in 'java', 'ffmpeg', 'ffprobe') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      throw "$tool was not found on PATH. Install a JRE 21+ and an ffmpeg build, then retry."
    }
  }
  $versionLine = (& java -version 2>&1 | Select-Object -First 1)
  if ($versionLine -match 'version "(\d+)') {
    if ([int]$Matches[1] -lt 21) { throw "Java 21 or newer is required (found $($Matches[1]))." }
  }

  # What matters is the JVM's architecture, not the machine's: AWS CRT ships no
  # native for Windows on ARM64, but an x64 JVM running under Windows 11's
  # emulation reports x86_64 and loads the x64 library perfectly well.
  $props = (& java -XshowSettings:properties -version 2>&1) -join "`n"
  $jvmArch = if ($props -match 'os\.arch\s*=\s*(\S+)') { $Matches[1] } else { 'unknown' }
  Write-Host "  jvm architecture: $jvmArch"

  if ($jvmArch -eq 'aarch64' -or $jvmArch -eq 'arm64') {
    throw @'
This is an ARM64 JVM, and the AWS CRT native library is not published for
Windows on ARM — the agent would fail at startup with an UnsatisfiedLinkError.

Install an x64 JRE instead and re-run. Windows 11 on ARM runs x64 binaries under
emulation, and the agent works normally that way.
'@
  }
  if ($jvmArch -eq 'x86') {
    Write-Warning 'A 32-bit JVM is installed. Use a 64-bit JRE unless this machine really is 32-bit.'
  }
  # CamStream stream-copies and needs no GPL codec. Warn, do not block.
  $config = (& ffmpeg -hide_banner -version 2>&1) -join ' '
  if ($config -match '--enable-gpl|--enable-nonfree') {
    Write-Warning 'This ffmpeg build is GPL/non-free. Fine for evaluation; do not redistribute it. See docs/licensing.md.'
  }
}

Assert-Admin
Assert-Prerequisites

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
  Write-Host "  wrote a template to $DataDir\agent.yaml — edit it before starting"
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
  Copy-Item "$Here\camstream-agent.xml" "$InstallDir\$ServiceName.xml" -Force

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
  $action = New-ScheduledTaskAction -Execute 'java.exe' `
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
