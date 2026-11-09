[CmdletBinding()]
param(
  [Parameter(Mandatory)][int]$ControllerPid,
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][string]$RuntimeFile,
  [Parameter(Mandatory)][string]$InstanceId
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $projectRoot 'environment/scripts/runtime-processes.ps1')
$controller = Open-ImRuntimeController $projectRoot
try {
  $path = Join-Path $projectRoot 'environment/config/dsh-process.json'
  $old = Read-ImRuntimeJson $path
  Assert-ImDshRecordPaths -Record $old -ProjectRoot $projectRoot
  if ($old.instance_id -cne $InstanceId -or $old.config_path -cne $ConfigPath -or $old.runtime_file -cne $RuntimeFile) { throw 'Recovery process registration does not match the managed instance.' }
  if (Get-ImSavedProcess -Record $old -Role dsh) { throw 'Old controller is still alive; do not replace its registration.' }
  $record = Read-ImRuntimeJson $RuntimeFile
  $running = Get-CimInstance Win32_Process -Filter "ProcessId=$ControllerPid"
  $bridge = Join-Path $projectRoot 'workspace/bridge/bridge.mjs'
  if (!$running -or $record.instanceId -cne $InstanceId -or $record.pid -ne $ControllerPid -or $record.configPath -cne $ConfigPath -or
      !(Test-ImCommandArgument $running.CommandLine $bridge) -or !(Test-ImCommandArgument $running.CommandLine $ConfigPath) -or
      !(Test-ImCommandArgument $running.CommandLine $RuntimeFile) -or !(Test-ImCommandArgument $running.CommandLine $InstanceId) -or
      ![string]::Equals($running.ExecutablePath,$old.executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Recovered controller identity could not be proven.' }
  $old.pid = [int]$running.ProcessId
  $old.executable = $running.ExecutablePath
  $old.creation_ticks = $running.CreationDate.Ticks
  $old.started_at = (Get-Date).ToString('o')
  Write-ImRuntimeJson -Path $path -Value $old
} finally { $controller.Dispose() }
