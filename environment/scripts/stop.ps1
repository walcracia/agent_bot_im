$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$record = Join-Path $projectRoot 'environment/config/server-process.json'
if (!(Test-Path -LiteralPath $record)) { Write-Output '没有本项目的启动记录。'; exit 0 }
$saved = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($saved.pid)" -ErrorAction SilentlyContinue
if (!$proc) { Write-Output '记录的进程已经停止。'; exit 0 }
if ($proc.ExecutablePath -ne $saved.executable -or $proc.CommandLine -notmatch 'uvicorn server.app:app' -or $proc.CreationDate.Ticks -ne $saved.creation_ticks) { throw 'PID 与本项目启动记录不匹配，拒绝停止。' }
Stop-Process -Id $saved.pid
Write-Output '同频服务器已停止。'
