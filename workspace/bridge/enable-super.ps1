[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepositoryPath,
  [string]$ConfigPath,
  [ValidateRange(1,8)][int]$MaxWorkers = 2,
  [ValidateRange(1,65535)][int]$ControlPort = 18202,
  [string]$GitHubRepo,
  [string]$GitProxy,
  [string[]]$AllowedGitHubActors = @(),
  [string]$TestExecutable,
  [string[]]$TestArguments = @(),
  [string]$BaseBranch = 'main',
  [string[]]$RequiredChecks = @(),
  [string[]]$TrustedReviewers = @(),
  [ValidateSet('review','verified-tests')][string]$MergePolicy = 'review',
  [switch]$AutoMerge,
  [switch]$PassThru
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or !$IsWindows) { throw '此配置转换入口需要 Windows PowerShell 7。' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $projectRoot 'environment/scripts/runtime-processes.ps1')
. (Join-Path $PSScriptRoot 'startup-credential.ps1')
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot 'environment/config/bridge-installed.local.json' }
$configFile = Resolve-ImStartupConfigFile -Path (Get-ImConfigPath -ProjectRoot $projectRoot -Path $ConfigPath)
$controller = Open-ImRuntimeController $projectRoot
$temporary = $null
try {
  if (!(Test-Path -LiteralPath $configFile -PathType Leaf)) { throw '先用 connect-installed.ps1 完成助手、聊天和成员绑定。' }
  $original = [IO.File]::ReadAllText($configFile)
  try { $settings = ConvertFrom-Json -InputObject $original -AsHashtable -ErrorAction Stop }
  catch { throw '已有监听配置无法解析；保留原文件，未转换。' }
  function Assert-NoInlineSecrets($value) {
    if ($value -is [Collections.IDictionary]) {
      foreach ($key in $value.Keys) {
        if ([string]$key -match '(?:^|[_-])(?:token|api[_-]?key|access[_-]?token|password|secret|authorization|credentials?)(?:$|[_-])|^(?:accessToken|apiKey|protectedToken)$') {
          throw '配置包含内联认证字段；请保留原配置并改用环境变量或DPAPI文件引用，不复制明文到备份。'
        }
        Assert-NoInlineSecrets $value[$key]
      }
    } elseif ($value -is [Collections.IEnumerable] -and $value -isnot [string]) { foreach ($item in $value) { Assert-NoInlineSecrets $item } }
  }
  Assert-NoInlineSecrets $settings
  if ($settings.executor -ne 'installed-headless' -or $settings.triggerMode -ne 'auto' -or $settings.tokenEnv -ne 'TEAM_RELAY_BOT_TOKEN' -or
      !$settings.harness -or !$settings.statePath -or !$settings.conversationIds.Count -or !$settings.senderIds.Count) {
    throw '需要已有 installed-headless/auto 绑定及明确的群、成员、账本路径；未修改配置。'
  }
  function Resolve-BoundPath([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path) -or $path -match '[\r\n\x00]') { throw '绑定配置路径无效。' }
    return [IO.Path]::GetFullPath($path, [IO.Path]::GetDirectoryName($configFile))
  }
  $legacyState = Resolve-BoundPath $settings.statePath
  $comparison = [StringComparison]::OrdinalIgnoreCase
  $repo = (Resolve-Path -LiteralPath $RepositoryPath).Path
  $gitRoot = & git -C $repo rev-parse --show-toplevel 2>$null
  if ($LASTEXITCODE -ne 0 -or ![string]::Equals([IO.Path]::GetFullPath([string]$gitRoot), $repo, $comparison)) { throw 'RepositoryPath 必须是明确的Git仓库根目录。' }
  $recordPath = Join-Path $projectRoot 'environment/config/dsh-process.json'
  if (Test-Path -LiteralPath $recordPath) {
    $record = Read-ImRuntimeJson $recordPath
    Assert-ImDshRecordPaths -Record $record -ProjectRoot $projectRoot
    if (Get-ImSavedProcess -Record $record -Role dsh) { throw '本项目监听仍存活；先用 stop.ps1 正常停止再转换，不覆盖在线配置。' }
  }
  # Also catch a directly started listener and a surviving external supervisor.
  $bridgePath = Join-Path $projectRoot 'workspace/bridge/bridge.mjs'
  $watchdogPath = Join-Path $projectRoot 'workspace/bridge/super-watchdog.mjs'
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'node'" -ErrorAction Stop)) {
    if ($process.ProcessId -eq $PID -or !$process.CommandLine) { continue }
    if ((Test-ImCommandArgument $process.CommandLine $bridgePath) -or (Test-ImCommandArgument $process.CommandLine $watchdogPath)) {
      throw '本项目监听或Watchdog仍存活；请核对正常停止，不使用转换入口杀进程。'
    }
  }
  if (Test-Path -LiteralPath ($legacyState + '.lock')) { throw '旧监听账本存在锁；保留并核对拥有者，不自动删除。' }
  if (Test-Path -LiteralPath $legacyState) {
    try { $legacy = Get-Content -LiteralPath $legacyState -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop }
    catch { throw '旧监听账本无法解析；保留检查，不创建新任务替代。' }
    if ($legacy.current) { throw '旧监听有未完成任务；先在旧模式明确接续或取消，保留原会话后再转换。' }
  }
  $identity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($configFile.ToLowerInvariant()))).ToLowerInvariant().Substring(0,12)
  $dataRoot = Join-Path $projectRoot ('environment/data/super-' + $identity)
  $super = if ($settings.superAgent) { $settings.superAgent } else { [ordered]@{} }
  if ($GitProxy) {
    $proxyUri = $null
    if ($GitProxy -notmatch '^https?://[^/?#\\]+/?$' -or ![Uri]::TryCreate($GitProxy, [UriKind]::Absolute, [ref]$proxyUri) -or $proxyUri.Scheme -notin @('http','https') -or
        $proxyUri.UserInfo -or $proxyUri.AbsolutePath -ne '/' -or $proxyUri.Query -or $proxyUri.Fragment -or $GitProxy -match '\s') {
      throw 'GitProxy必须是无凭据、路径或参数的HTTP(S)根地址。'
    }
    $GitProxy = $proxyUri.GetLeftPart([UriPartial]::Authority)
  }
  if ($super.repositoryPath -and ![string]::Equals((Resolve-BoundPath $super.repositoryPath), $repo, $comparison)) { throw '已有Super-agent绑定其他仓库；请保留它并建立独立配置，不替换任务归属。' }
  foreach ($pair in @(@('statePath',(Join-Path $dataRoot 'state.json')),
      @('worktreesPath',(Join-Path $projectRoot ('environment/tools/dsh/super-' + $identity))),
      @('runsPath',(Join-Path $projectRoot ('environment/logs/super-' + $identity))),
      @('sessionMapsPath',(Join-Path $dataRoot 'sessions')))) {
    if (!$super[$pair[0]]) { $super[$pair[0]] = $pair[1] }
    else { $super[$pair[0]] = Resolve-BoundPath $super[$pair[0]] }
  }
  if ([string]::Equals($legacyState, $super.statePath, $comparison)) { throw 'Super-agent账本必须与旧账本分开，不能覆盖原状态。' }
  foreach ($path in @($super.statePath, (Join-Path ([IO.Path]::GetDirectoryName($super.statePath)) 'watchdog-state.json'))) {
    if ((Test-Path -LiteralPath ($path + '.lock')) -or (Test-Path -LiteralPath ($path + '.lock.recovery'))) { throw '新模式状态或监督状态存在锁；保留并核对，不自动删除。' }
  }
  if ($GitHubRepo) {
    if ($GitHubRepo -notmatch '^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$' -or !$AllowedGitHubActors.Count -or !$TestExecutable) {
      throw 'GitHub交付需要固定owner/repo、明确GitHub人员名单及可信TestExecutable。'
    }
    foreach ($name in @($AllowedGitHubActors + $TrustedReviewers)) { if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$') { throw 'GitHub人员必须是明确的login。' } }
    if ($BaseBranch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $BaseBranch.Contains('..')) { throw 'BaseBranch无效。' }
    if ($AutoMerge -and $MergePolicy -eq 'review' -and (!$RequiredChecks.Count -or !$TrustedReviewers.Count)) { throw 'review自动合并必须指定RequiredChecks和TrustedReviewers。' }
    if (@($TestArguments | Where-Object { $_ -match '[\r\n\x00]' }).Count) { throw '测试参数不能含控制字符。' }
    $executable = Get-Command $TestExecutable -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if ([IO.Path]::GetExtension($executable.Source) -in @('.cmd','.bat')) { throw '测试命令使用直接可执行文件，如node/pwsh/python；不要把批处理隐式交给shell。' }
    $origin = [string](& git -C $repo remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or $origin -notmatch ('^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)' + [regex]::Escape($GitHubRepo) + '(?:\.git)?$')) {
      throw 'RepositoryPath的origin与固定GitHubRepo不一致；未转换。'
    }
    $testArgv = @($executable.Source) + $TestArguments
    $super.github = [ordered]@{ enabled=$true; repository=$GitHubRepo; base=$BaseBranch; remote='origin';
      allowedActors=@($AllowedGitHubActors | Select-Object -Unique); testCommands=@(,$testArgv);
      requiredChecks=@($RequiredChecks); reviewers=@($TrustedReviewers); autoMerge=[bool]$AutoMerge; mergePolicy=$MergePolicy; pollMilliseconds=15000 }
  } elseif ($AutoMerge -or $TestExecutable -or $AllowedGitHubActors.Count -or $RequiredChecks.Count -or $TrustedReviewers.Count) {
    throw 'GitHub设置必须与GitHubRepo一起明确提供。'
  } elseif (!$super.github) { $super.github = [ordered]@{ enabled=$false } }
  if ($GitProxy) {
    $super.github.gitProxy = $GitProxy
    if ($super.release) { $super.release.gitProxy = $GitProxy }
  }
  $super.enabled = $true; $super.executionMode = 'local'; $super.projectId = 'agent-bot-im'
  $super.repositoryPath = $repo; $super.legacyStatePath = $legacyState; $super.maxWorkers = $MaxWorkers
  if ($legacy -and $legacy.ContainsKey('cursor')) {
    if ($legacy.cursor -isnot [long] -and $legacy.cursor -isnot [int]) { throw '旧游标不是整数，保留状态等待核对。' }
    if ($legacy.cursor -lt 0) { throw '旧游标无效，保留状态等待核对。' }
    $super.initialCursor = $legacy.cursor
  }
  $super.controlHost = '127.0.0.1'; $super.controlPort = $ControlPort
  $super.maxAutoRepairs = 2; $super.contextCharacters = 12000; $super.routerBatchSize = 8
  if (!$super.proactive) { $super.proactive = [ordered]@{enabled=[bool]$super.github.enabled} }
  $super.watchdog = [ordered]@{ enabled=$true; intervalMs=60000; staleHeartbeatMs=90000; taskAgeMs=120000; cooldownMs=300000; maxAssessmentsPerTick=4; maxConsecutiveModelFailures=3 }
  $settings.superAgent = $super
  Assert-NoInlineSecrets $settings
  $backupDirectory = Join-Path $projectRoot 'environment/config/backups'
  $null = Resolve-ImStartupConfigFile -Path (Join-Path $backupDirectory 'identity-check.json')
  [IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
  $backup = Join-Path $backupDirectory ([IO.Path]::GetFileNameWithoutExtension($configFile) + '.before-super.' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '.' + [Guid]::NewGuid().ToString('N') + '.json')
  # Exclusive backup preserves the exact old bytes; no credential file is read or copied.
  [IO.File]::Copy($configFile, $backup, $false)
  if ([IO.File]::ReadAllText($configFile) -cne $original) { throw '备份期间配置发生改变；保留备份，拒绝覆盖。' }
  $temporary = Join-Path ([IO.Path]::GetDirectoryName($configFile)) ([Guid]::NewGuid().ToString('N') + '.super.tmp.json')
  [IO.File]::WriteAllText($temporary, ($settings | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary, $configFile, $true); $temporary = $null
  Write-Host "Super-agent配置已启用；尚未启动监听。并行任务上限：$MaxWorkers。"
  Write-Host "原配置备份：$backup"
  Write-Host "旧账本保留：$legacyState；新账本：$($super.statePath)"
  if ($PassThru) { return [pscustomobject]@{ configPath=$configFile; backupPath=$backup; statePath=$super.statePath; legacyStatePath=$legacyState; maxWorkers=$MaxWorkers } }
} finally {
  if ($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  $controller.Dispose()
}
