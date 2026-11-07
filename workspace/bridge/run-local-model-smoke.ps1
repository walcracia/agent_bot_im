param([ValidateSet('sdk', 'im')][string]$Mode = 'sdk')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dshExe = Join-Path $projectRoot 'environment\tools\dsh\desktop\DeepSeek Harness.exe'
$resolverUri = ([Uri](Join-Path $PSScriptRoot 'desktop-resolver.mjs')).AbsoluteUri
$scriptName = if ($Mode -eq 'im') { 'local-model-im-smoke.mjs' } else { 'local-model-smoke.mjs' }
$launchArgs = @('--import', $resolverUri, (Join-Path $PSScriptRoot $scriptName))
$argumentString = ($launchArgs | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
$logDirectory = Join-Path $projectRoot 'environment\logs'
New-Item -ItemType Directory -Force $logDirectory | Out-Null
$stdoutPath = Join-Path $logDirectory "local-model-$Mode.log"
$stderrPath = Join-Path $logDirectory "local-model-$Mode-error.log"
$previousNodeMode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $testProcess = Start-Process -FilePath $dshExe -ArgumentList $argumentString -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Get-Content -LiteralPath $stdoutPath
  if ($testProcess.ExitCode -ne 0) {
    Get-Content -LiteralPath $stderrPath | Write-Error -ErrorAction Continue
    throw "Local model acceptance failed (exit $($testProcess.ExitCode)); no automatic retry."
  }
} finally {
  if ($null -eq $previousNodeMode) { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
  else { $env:ELECTRON_RUN_AS_NODE = $previousNodeMode }
}
