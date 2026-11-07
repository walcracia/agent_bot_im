param(
  [string]$Config = "$PSScriptRoot\config.local.json",
  [switch]$Handshake,
  [switch]$Once,
  [string]$RetryEvent,
  [string]$SkipEvent
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dshExe = Join-Path $projectRoot 'environment\tools\dsh\desktop\DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $dshExe)) { throw 'Deploy the official Desktop payload first; see bridge README.' }
$resolverUri = ([System.Uri](Join-Path $PSScriptRoot 'desktop-resolver.mjs')).AbsoluteUri
$launchArgs = @('--import', $resolverUri, (Join-Path $PSScriptRoot 'bridge.mjs'), '--config', $Config)
if ($Handshake) { $launchArgs += '--handshake' }
if ($Once) { $launchArgs += '--once' }
if ($RetryEvent) { $launchArgs += @('--retry-event', $RetryEvent) }
if ($SkipEvent) { $launchArgs += @('--skip-event', $SkipEvent) }
$previousNodeMode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $logDirectory = Join-Path $projectRoot 'environment\logs'
  New-Item -ItemType Directory -Force $logDirectory | Out-Null
  $stdoutPath = Join-Path $logDirectory 'bridge-runtime.log'
  $stderrPath = Join-Path $logDirectory 'bridge-runtime-error.log'
  $argumentString = ($launchArgs | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
  $bridgeProcess = Start-Process -FilePath $dshExe -ArgumentList $argumentString -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Get-Content -LiteralPath $stdoutPath
  if ($bridgeProcess.ExitCode -ne 0) {
    Get-Content -LiteralPath $stderrPath | Write-Error -ErrorAction Continue
    throw "Bridge exited with $($bridgeProcess.ExitCode)"
  }
} finally {
  if ($null -eq $previousNodeMode) { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
  else { $env:ELECTRON_RUN_AS_NODE = $previousNodeMode }
}
