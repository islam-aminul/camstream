<# Removes the CamStream agent. Use -Purge to also delete configuration and device keys. #>
[CmdletBinding()]
param([switch]$Purge, [string]$InstallDir = "$env:ProgramFiles\CamStream", [string]$DataDir = "$env:ProgramData\CamStream")
$ErrorActionPreference = 'SilentlyContinue'
$ServiceName = 'camstream-agent'

if (Test-Path "$InstallDir\$ServiceName.exe") {
  & "$InstallDir\$ServiceName.exe" stop | Out-Null
  & "$InstallDir\$ServiceName.exe" uninstall | Out-Null
}
Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false
Remove-Item -Recurse -Force $InstallDir

if ($Purge) {
  # Destroys the credential key: camera credentials must be re-entered afterwards.
  Remove-Item -Recurse -Force $DataDir
  Write-Host 'Purged. Camera credentials will need to be re-entered.'
} else {
  Write-Host 'Removed. Configuration and device identity kept; use -Purge to delete them.'
}
