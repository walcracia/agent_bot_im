param([int]$Port = 18200)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$python = Join-Path $projectRoot 'environment/venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $python)) { throw '先运行 setup.ps1 创建项目依赖。' }
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "端口 $Port 已占用，请先检查 state.json 和服务进程。" }
$env:IM_DATA_DIR = Join-Path $projectRoot 'environment/data'
$logDir = Join-Path $projectRoot 'environment/logs'
$proc = Start-Process -FilePath $python -ArgumentList @('-m','uvicorn','server.app:app','--host','127.0.0.1','--port',"$Port",'--workers','1','--no-access-log') -WorkingDirectory (Join-Path $projectRoot 'workspace') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'server.stdout.log') -RedirectStandardError (Join-Path $logDir 'server.stderr.log') -PassThru
for ($i=0; $i -lt 30; $i++) {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health"
    $owner = Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess
    $running = Get-CimInstance Win32_Process -Filter "ProcessId=$owner"
    if ($running.CommandLine -notmatch 'uvicorn server.app:app' -or ($owner -ne $proc.Id -and $running.ParentProcessId -ne $proc.Id)) { throw '监听进程不属于本次启动' }
    @{pid=$owner; launcher_pid=$proc.Id; port=$Port; executable=$running.ExecutablePath; creation_ticks=$running.CreationDate.Ticks; started_at=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $projectRoot 'environment/config/server-process.json') -Encoding utf8
    Write-Output "同频服务器已启动：http://127.0.0.1:$Port (PID $owner)"
    $health
    exit 0
  } catch { Start-Sleep -Milliseconds 500 }
}
$children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue
foreach ($child in $children) { if ($child.CommandLine -match 'uvicorn server.app:app') { Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue } }
$launcher = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($launcher -and $launcher.StartTime -eq $proc.StartTime) { Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue }
throw '启动未通过健康检查，请检查 environment/logs/server.stderr.log。'
