[CmdletBinding()]
param([ValidateRange(1,3600)][int]$StopTimeoutSeconds = 30)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7 运行停止入口。' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $PSScriptRoot 'runtime-processes.ps1')
$controller = Open-ImRuntimeController $projectRoot
try {
  $dshRecordPath = Join-Path $projectRoot 'environment/config/dsh-process.json'
  if (Test-Path -LiteralPath $dshRecordPath) {
    $dsh = Read-ImRuntimeJson $dshRecordPath
    Assert-ImDshRecordPaths -Record $dsh -ProjectRoot $projectRoot
    $current = Get-ImSavedProcess -Record $dsh -Role dsh
    $runtime = Get-ImBridgeRuntime -Record $dsh
    if ($current) {
      if ($runtime.status -in @('stopped','failed')) { throw 'DSH 已报告终态但进程仍存在，保留服务器，请稍后检查；未强制终止。' }
      $stopPath = $dsh.runtime_file + '.stop'
      if (Test-Path -LiteralPath $stopPath) {
        $request = Read-ImRuntimeJson $stopPath
        if ($request.instanceId -cne $dsh.instance_id) { throw 'DSH 停止请求的实例标识不符；未覆盖请求或停止服务器。' }
      } else { Write-ImRuntimeJson -Path $stopPath -Value @{instanceId=$dsh.instance_id} }
      Write-Host '已请求 DSH 完成当前事件后退出，等待释放状态锁。'
      $deadline = [DateTime]::UtcNow.AddSeconds($StopTimeoutSeconds)
      do {
        $current = Get-ImSavedProcess -Record $dsh -Role dsh
        $runtime = Get-ImBridgeRuntime -Record $dsh
        if (!$current) { break }
        Start-Sleep -Milliseconds 500
      } while ([DateTime]::UtcNow -lt $deadline)
      if ($current) { throw 'DSH 尚在处理当前事件或退出，等待超时；没有杀 worker，服务器保持运行。稍后可再次运行 stop.ps1。' }
    }
    if ($runtime.status -ne 'stopped') { throw "DSH 退出状态为 $($runtime.status)，无法确认正常清理；服务器保持运行，请核对任务与锁。" }
    Write-Host 'DSH 监听已正常退出。'
  }

  $serverRecordPath = Join-Path $projectRoot 'environment/config/server-process.json'
  if (!(Test-Path -LiteralPath $serverRecordPath)) { Write-Host '没有本项目的服务器启动记录。'; return }
  $saved = Read-ImRuntimeJson $serverRecordPath
  $server = Get-ImSavedProcess -Record $saved -Role server
  if (!$server) { Write-Host '记录的服务器进程已经停止。'; return }
  $listeners = @(Get-NetTCPConnection -LocalPort $saved.port -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count) {
    if ($listeners.Count -ne 1) { throw '服务器端口有多个监听，拒绝停止。' }
    $null = Assert-ImServerListener -Record $saved -Port $saved.port -Listener $listeners[0]
  }
  Stop-Process -Id $saved.pid -ErrorAction Stop
  Write-Host '同频服务器已停止。'
} finally { $controller.Dispose() }
