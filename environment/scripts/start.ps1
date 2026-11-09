[CmdletBinding()]
param(
  [ValidateRange(1,65535)][int]$Port = 18200,
  [string]$DshConfigPath,
  [switch]$ServerOnly,
  [ValidateRange(1,300)][int]$ReadyTimeoutSeconds = 45
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7 运行启动入口。' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $PSScriptRoot 'runtime-processes.ps1')
$controller = Open-ImRuntimeController $projectRoot
try {
  $config = $null
  if (!$ServerOnly) {
    if (!$DshConfigPath) { $DshConfigPath = Join-Path $projectRoot 'environment/config/bridge-installed.local.json' }
    $configPath = Get-ImConfigPath -ProjectRoot $projectRoot -Path $DshConfigPath
    if (!(Test-Path -LiteralPath $configPath)) { throw '尚未绑定 DSH。首次先用 start.ps1 -ServerOnly 启动，再运行 workspace/bridge/connect-installed.ps1 -EnableStartup 完成绑定。' }
    $config = Read-ImRuntimeJson $configPath
    if ($config.executor -ne 'installed-headless' -or $config.startup.enabled -ne $true -or !$config.startup.credentialPath) {
      throw 'DSH 配置未启用同步启动；请运行 connect-installed.ps1 -EnableStartup 重新保存绑定。'
    }
    $configuredUrl = $null
    if (![Uri]::TryCreate($config.baseUrl, [UriKind]::Absolute, [ref]$configuredUrl) -or $configuredUrl.Scheme -ne 'http' -or
        !$configuredUrl.IsLoopback -or $configuredUrl.Port -ne $Port -or $configuredUrl.AbsolutePath -ne '/' -or
        $configuredUrl.Query -or $configuredUrl.Fragment -or $configuredUrl.UserInfo) {
      throw 'DSH 的 baseUrl 必须指向本次启动的本机 HTTP 服务端口。'
    }
    . (Join-Path $projectRoot 'workspace/bridge/startup-credential.ps1')
    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $nodeVersion = (& $node.Source --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+\.\d+\.\d+)' -or [Version]$Matches[1] -lt [Version]'24.9.0') {
      throw '同步启动 DSH 需要 Node.js 24.9 或更高版本；未启动新服务器。'
    }
  }

  $serverRecordPath = Join-Path $projectRoot 'environment/config/server-process.json'
  $listener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($listener.Count) {
    if ($listener.Count -ne 1 -or !(Test-Path -LiteralPath $serverRecordPath)) { throw "端口 $Port 已占用且无法确认为本项目服务，请先检查。" }
    $server = Read-ImRuntimeJson $serverRecordPath
    $null = Assert-ImServerListener -Record $server -Port $Port -Listener $listener[0]
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
    if ($health.status -ne 'ok') { throw '本项目服务器未通过健康检查，未启动新的监听。' }
    Write-Host "复用本项目服务器：http://127.0.0.1:$Port (PID $($server.pid))"
  } else {
    if (Test-Path -LiteralPath $serverRecordPath) {
      $previousServer = Read-ImRuntimeJson $serverRecordPath
      if (Get-ImSavedProcess -Record $previousServer -Role server) { throw '记录的服务器进程仍在运行但没有预期监听，请先检查；不重复启动。' }
    }
    $python = Join-Path $projectRoot 'environment/venv/Scripts/python.exe'
    if (!(Test-Path -LiteralPath $python)) { throw '先运行 setup.ps1 创建项目依赖。' }
    $logDirectory = Join-Path $projectRoot 'environment/logs'
    [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
    $serverInstance = [Guid]::NewGuid().ToString('D')
    $previousDataDirectory = [Environment]::GetEnvironmentVariable('IM_DATA_DIR','Process')
    try {
      $env:IM_DATA_DIR = Join-Path $projectRoot 'environment/data'
      $arguments = @('-m','uvicorn','server.app:app','--host','127.0.0.1','--port',[string]$Port,'--workers','1','--no-access-log') | ForEach-Object { ConvertTo-ImProcessArgument $_ }
      $launcher = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory (Join-Path $projectRoot 'workspace') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory "server-$serverInstance.stdout.log") -RedirectStandardError (Join-Path $logDirectory "server-$serverInstance.stderr.log") -PassThru
    } finally {
      if ($null -eq $previousDataDirectory) { Remove-Item Env:IM_DATA_DIR -ErrorAction SilentlyContinue }
      else { $env:IM_DATA_DIR = $previousDataDirectory }
    }
    $server = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
      try {
        $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
        $listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
        if ($listening.Count -ne 1 -or $listening[0].LocalAddress -ne '127.0.0.1') { throw '没有唯一的本机回环监听。' }
        $running = Get-CimInstance Win32_Process -Filter "ProcessId=$($listening[0].OwningProcess)"
        if (!$running -or ($running.ProcessId -ne $launcher.Id -and $running.ParentProcessId -ne $launcher.Id) -or
            !(Test-ImCommandArgument $running.CommandLine 'server.app:app') -or $health.status -ne 'ok') { throw '服务身份/健康尚未就绪。' }
        $candidateServer = [pscustomobject]@{pid=[int]$running.ProcessId;launcher_pid=$launcher.Id;port=$Port;executable=$running.ExecutablePath;creation_ticks=$running.CreationDate.Ticks;started_at=(Get-Date).ToString('o')}
        Write-ImRuntimeJson -Path $serverRecordPath -Value $candidateServer
        $server = $candidateServer
        break
      } catch { Start-Sleep -Milliseconds 500 }
    }
    if (!$server) {
      # No DSH worker has been launched. Only terminate this unready server tree.
      $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($launcher.Id)" -ErrorAction SilentlyContinue)
      foreach ($child in $children) { if (Test-ImCommandArgument $child.CommandLine 'server.app:app') { Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue } }
      $currentLauncher = Get-Process -Id $launcher.Id -ErrorAction SilentlyContinue
      if ($currentLauncher -and $currentLauncher.StartTime -eq $launcher.StartTime) { Stop-Process -Id $launcher.Id -ErrorAction SilentlyContinue }
      throw "服务器未通过健康检查，请检查 environment/logs/server-$serverInstance.stderr.log。"
    }
    Write-Host "同频服务器已启动：http://127.0.0.1:$Port (PID $($server.pid))"
  }
  if ($ServerOnly) {
    Write-Host '已按 ServerOnly 仅启动/复用 IM 服务；未声明 DSH 就绪。'
    return [pscustomobject]@{server_url="http://127.0.0.1:$Port";server_pid=$server.pid;dsh_status='server-only'}
  }

  $dshRecordPath = Join-Path $projectRoot 'environment/config/dsh-process.json'
  if (Test-Path -LiteralPath $dshRecordPath) {
    $existing = Read-ImRuntimeJson $dshRecordPath
    Assert-ImDshRecordPaths -Record $existing -ProjectRoot $projectRoot
    $existingProcess = Get-ImSavedProcess -Record $existing -Role dsh
    if ($existingProcess) {
      if (![string]::Equals($existing.config_path, $configPath, [StringComparison]::OrdinalIgnoreCase)) { throw '已有 DSH 监听绑定其他配置，请先正常停止该实例。' }
      $runtime = Get-ImBridgeRuntime -Record $existing
      if ($runtime.status -ne 'listening') { throw "DSH 实例尚未就绪或正在退出（$($runtime.status)），保留服务并请检查运行记录。" }
      Write-Host "DSH 监听已就绪，复用现有实例 (PID $($existing.pid))。"
      return [pscustomobject]@{server_url="http://127.0.0.1:$Port";server_pid=$server.pid;dsh_pid=$existing.pid;dsh_status='listening'}
    }
  }

  $instance = [Guid]::NewGuid().ToString('D')
  $runtimeDirectory = Join-Path $projectRoot 'environment/data/startup'
  [IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
  $runtimePath = Join-Path $runtimeDirectory "$instance.json"
  $bridgePath = Join-Path $projectRoot 'workspace/bridge/bridge.mjs'
  $logDirectory = Join-Path $projectRoot 'environment/logs/dsh-startup'
  [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
  $previousToken = [Environment]::GetEnvironmentVariable('TEAM_RELAY_BOT_TOKEN','Process')
  $token = $null
  try {
    $token = Get-ImStartupToken -ConfigPath $configPath
    if (!$token) { throw 'DSH 同步启动凭据为空，未启动监听。' }
    $env:TEAM_RELAY_BOT_TOKEN = $token
    $arguments = @($bridgePath,'--config',$configPath,'--runtime-file',$runtimePath,'--instance-id',$instance) | ForEach-Object { ConvertTo-ImProcessArgument $_ }
    $nodeProcess = Start-Process -FilePath $node.Source -ArgumentList $arguments -WorkingDirectory (Join-Path $projectRoot 'workspace/bridge') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory "$instance.stdout.log") -RedirectStandardError (Join-Path $logDirectory "$instance.stderr.log") -PassThru
  } finally {
    $token = $null
    if ($null -eq $previousToken) { Remove-Item Env:TEAM_RELAY_BOT_TOKEN -ErrorAction SilentlyContinue }
    else { $env:TEAM_RELAY_BOT_TOKEN = $previousToken }
  }
  $observed = Get-CimInstance Win32_Process -Filter "ProcessId=$($nodeProcess.Id)" -ErrorAction Stop
  if (!$observed) { throw "DSH 已退出，请检查 environment/logs/dsh-startup/$instance.stderr.log；服务器保留运行。" }
  $dsh = [pscustomobject]@{pid=[int]$observed.ProcessId;executable=$observed.ExecutablePath;creation_ticks=$observed.CreationDate.Ticks;config_path=$configPath;runtime_file=$runtimePath;instance_id=$instance;bridge_path=$bridgePath;started_at=(Get-Date).ToString('o')}
  Write-ImRuntimeJson -Path $dshRecordPath -Value $dsh
  $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
  do {
    $current = Get-ImSavedProcess -Record $dsh -Role dsh
    $runtime = Get-ImBridgeRuntime -Record $dsh -AllowMissing
    if ($runtime -and $runtime.status -eq 'failed') { throw "DSH 监听启动失败，请检查 $runtimePath 和 environment/logs/dsh-startup/$instance.stderr.log；服务器保留运行。" }
    if (!$current) { throw "DSH 监听进程已退出，请检查 $runtimePath；服务器保留运行。" }
    if ($runtime -and $runtime.status -eq 'listening') {
      Write-Host "同频服务和 DSH 监听均已就绪 (DSH PID $($dsh.pid))。"
      return [pscustomobject]@{server_url="http://127.0.0.1:$Port";server_pid=$server.pid;dsh_pid=$dsh.pid;dsh_status='listening'}
    }
    if ($runtime -and $runtime.status -in @('stopping','stopped')) { throw 'DSH 在就绪前收到停止请求，未声明启动成功；服务器保留运行。' }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "DSH 就绪等待超时；保留进程与服务器，请检查 $runtimePath，不重复启动或删除锁。"
} finally { $controller.Dispose() }
