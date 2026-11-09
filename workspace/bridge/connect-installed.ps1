[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Workspace,
  [string]$BaseUrl = 'http://127.0.0.1:18200',
  [string]$CliPath = 'D:\Work\ai\deepseek-harness\resources\runtime\cli\bin\dsh.cmd',
  [string[]]$ConversationIds,
  [string[]]$SenderIds,
  [string]$ConfigPath,
  [switch]$EnableStartup,
  [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7 运行此入口。' }
if ($EnableStartup -and !$IsWindows) { throw 'EnableStartup 需要 Windows 当前用户 DPAPI；其他系统请使用原进程连接方式。' }
. (Join-Path $PSScriptRoot 'startup-credential.ps1')
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
if (!(Test-Path -LiteralPath $workspacePath -PathType Container)) { throw 'Workspace 必须是已准备好的独立 Git 工作副本。' }
if ($workspacePath -eq $projectRoot) { throw 'Workspace 不能使用当前活跃项目根目录；请指定独立的 Git worktree 或工作副本。' }
$gitRoot = & git -C $workspacePath rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($gitRoot) -ne $workspacePath) { throw 'Workspace 必须指向 Git 工作副本根目录。' }
$gitStatus = & git -C $workspacePath status --porcelain=v1 --untracked-files=normal
if ($LASTEXITCODE -ne 0) { throw '无法检查工作副本状态。' }
if ($gitStatus) { throw '工作副本有未提交或未跟踪修改；请保留它们，另行准备干净副本，不要 reset/stash。' }
$cli = (Resolve-Path -LiteralPath $CliPath -ErrorAction SilentlyContinue).Path
if (!$cli -or !(Test-Path -LiteralPath $cli -PathType Leaf)) { throw '未找到已安装的 DSH CLI；用 -CliPath 指定其实际路径，本入口不会重新安装。' }
$node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nodeVersion = (& $node.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+\.\d+\.\d+)' -or [Version]$Matches[1] -lt [Version]'24.9.0') { throw '需要 Node.js 24.9 或更高版本。' }
$null = Get-Command pwsh -CommandType Application -ErrorAction Stop
$origin = $null
if (![Uri]::TryCreate($BaseUrl, [UriKind]::Absolute, [ref]$origin) -or $origin.Scheme -notin @('http', 'https') -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/') {
  throw 'BaseUrl 必须是无路径、参数或凭据的 HTTP(S) 服务根地址。'
}
if ($origin.Scheme -eq 'http' -and !$origin.IsLoopback) { throw '远端同频服务必须使用 HTTPS；HTTP 仅允许本机回环地址。' }
$base = $origin.GetLeftPart([UriPartial]::Authority)
$configDirectory = [IO.Path]::GetFullPath((Join-Path $projectRoot 'environment/config'))
if (!$ConfigPath) { $ConfigPath = Join-Path $configDirectory 'bridge-installed.local.json' }
$configPathFull = [IO.Path]::GetFullPath($ConfigPath)
$comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
if (!$configPathFull.StartsWith($configDirectory + [IO.Path]::DirectorySeparatorChar, $comparison) -or [IO.Path]::GetExtension($configPathFull) -ne '.json') {
  throw 'ConfigPath 必须位于本项目忽略的 environment/config 目录中，并使用 .json 扩展名。'
}
$configPathFull = Resolve-ImStartupConfigFile -Path $configPathFull

function Get-ImJson([string]$Route, [hashtable]$Headers) {
  try {
    $response = Invoke-RestMethod -Uri ($base + $Route) -Headers $Headers -Method Get -TimeoutSec 20
    # Invoke-RestMethod emits JSON arrays as one pipeline object. Returning the
    # assigned value enumerates them before Where-Object / Select-ImItems.
    return $response
  }
  catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'network' }
    # Do not echo an HTTP body, headers, or the connection code into diagnostics.
    throw "同频 GET $Route 失败（$status）；请检查服务地址、网络或助手连接码。"
  }
}

function Select-ImItems([object[]]$Items, [string[]]$Requested, [string]$Prompt) {
  if (!$Items.Count) { throw "$Prompt：没有可选项。请先由同频管理员完成成员/群聊设置。" }
  if ($Requested.Count) {
    $chosen = @($Requested | Select-Object -Unique)
    foreach ($id in $chosen) { if ($id -notin $Items.id) { throw "$Prompt：指定的 ID 不在此助手有权使用的列表内。" } }
    return $chosen
  }
  for ($index = 0; $index -lt $Items.Count; $index++) {
    $item = $Items[$index]
    $label = if ($item.display_name) { "$($item.display_name) ($($item.username))" } elseif ($item.title) { $item.title } else { '私聊' }
    Write-Host ('[{0}] {1}' -f ($index + 1), $label)
  }
  $answer = Read-Host "$Prompt（输入编号，多项用逗号分隔）"
  $parts = @($answer -split '[,，\s]+' | Where-Object { $_ })
  if (!$parts.Count) { throw '未选择任何项；没有保存或启动监听。' }
  $chosen = foreach ($part in $parts) {
    $number = 0
    if (![int]::TryParse($part, [ref]$number) -or $number -lt 1 -or $number -gt $Items.Count) { throw '选择编号无效；没有保存或启动监听。' }
    $Items[$number - 1].id
  }
  return @($chosen | Select-Object -Unique)
}

$previousToken = [Environment]::GetEnvironmentVariable('TEAM_RELAY_BOT_TOKEN', 'Process')
$secureCode = $null
$headers = $null
try {
  if ($previousToken) {
    $secureCode = ConvertTo-SecureString -String $previousToken.Trim() -AsPlainText -Force
  } else {
    $prompt = if ($EnableStartup) { '同频助手连接码（将由 Windows 当前用户加密保存，用于随服务启动）' } else { '同频助手连接码（仅用于当前进程，不写入配置）' }
    $secureCode = Read-Host $prompt -AsSecureString
  }
  $token = [Net.NetworkCredential]::new('', $secureCode).Password.Trim()
  if (!$token -or $token -match '[\r\n]') { throw '助手连接码为空或格式无效。' }
  # Persist the same normalized value used for IM authentication, including
  # when a pasted connection code has leading/trailing whitespace.
  $secureCode.Dispose()
  $secureCode = ConvertTo-SecureString -String $token -AsPlainText -Force
  $env:TEAM_RELAY_BOT_TOKEN = $token
  $headers = @{ Authorization = 'Bearer ' + $token }
  $token = $null
  $bot = Get-ImJson '/api/me' $headers
  if (!$bot.is_bot -or !$bot.id -or $bot.username -notmatch '^[A-Za-z0-9_.-]+$') { throw '此连接码不属于有效助手账号，请在同频设置中生成助手连接码。' }
  $conversations = @(Get-ImJson '/api/conversations' $headers | Where-Object { $_.id -and $bot.id -in $_.members.id })
  $selectedConversations = @(Select-ImItems $conversations $ConversationIds '选择允许自动识别任务的聊天')
  $members = @($conversations | Where-Object { $_.id -in $selectedConversations } | ForEach-Object { $_.members.id } | Select-Object -Unique)
  $users = @(Get-ImJson '/api/users' $headers | Where-Object { $_.id -and !$_.is_bot -and $_.id -in $members })
  $selectedSenders = @(Select-ImItems $users $SenderIds '选择允许派任务的成员')

  $instance = [IO.Path]::GetFileNameWithoutExtension($configPathFull) -replace '[^A-Za-z0-9_.-]', '_'
  $configIdentity = if ($IsWindows) { $configPathFull.ToLowerInvariant() } else { $configPathFull }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $pathHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($configIdentity))).Replace('-', '').ToLowerInvariant().Substring(0, 12) }
  finally { $hasher.Dispose() }
  $instance += '-' + $pathHash
  $stateDirectory = Join-Path $projectRoot ('environment/data/' + $instance)
  $config = [ordered]@{
    executor = 'installed-headless'; triggerMode = 'auto'; baseUrl = $base
    tokenEnv = 'TEAM_RELAY_BOT_TOKEN'; botUsername = $bot.username
    conversationIds = @($selectedConversations); senderIds = @($selectedSenders)
    pollMilliseconds = 2000; statePath = Join-Path $stateDirectory 'state.json'
    contextMessages = 20; contextCharacters = 12000
    harness = [ordered]@{
      cwd = $workspacePath; cliPath = $cli
      runsPath = Join-Path $projectRoot ('environment/logs/' + $instance)
      sessionMapPath = Join-Path $stateDirectory 'sessions.json'
      auth = 'stored'; permissionMode = 'danger-full-access'; powershellPath = 'pwsh'; runTimeoutMs = 300000
    }
  }
  if (Test-Path -LiteralPath ($config.statePath + '.lock')) { throw '此实例存在桥接锁；请先检查拥有该锁的监听进程，不自动删锁或重复启动。' }
  if (Test-Path -LiteralPath $configPathFull) {
    try { $old = Get-Content -LiteralPath $configPathFull -Raw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw '已有监听配置无法解析；请保留检查或用另一个 ConfigPath，不覆盖原文件。' }
    if ($old.baseUrl -ne $base -or $old.botUsername -ne $bot.username -or $old.harness.cwd -ne $workspacePath -or $old.harness.cliPath -ne $cli) {
      throw '已有配置绑定了其他服务、助手或工作副本；请用新的 ConfigPath 建立独立实例，原配置与状态保持不变。'
    }
    if (!$EnableStartup -and $null -ne $old.startup) { $config.startup = $old.startup }
  }
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($configPathFull)) | Out-Null
  if ($EnableStartup) {
    $credentialPath = Join-Path $configDirectory ($instance + '.credential.json')
    Save-ImStartupToken -ConfigPath $configPathFull -CredentialPath $credentialPath -Token $secureCode
    $config.startup = [ordered]@{ enabled = $true; credentialPath = $credentialPath }
  }
  [IO.File]::WriteAllText($configPathFull, ($config | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Write-Host "配置已保存：$configPathFull"
  Write-Host "项目副本：$workspacePath；聊天 $($selectedConversations.Count) 个；授权成员 $($selectedSenders.Count) 位。"
  if ($EnableStartup) { Write-Host '已启用随服务器启动；连接码已由当前 Windows 用户加密保存。' }
  if ($PassThru) { return [pscustomobject]$config }
  Write-Host '正在前台监听；普通讨论自动识别任务。Ctrl+C 退出。'
  & $node.Source (Join-Path $PSScriptRoot 'bridge.mjs') --config $configPathFull
  if ($LASTEXITCODE -ne 0) { throw "桥接已退出（$LASTEXITCODE）；请检查本实例运行记录，不自动重做不确定任务。" }
} finally {
  if ($null -eq $previousToken) { Remove-Item Env:TEAM_RELAY_BOT_TOKEN -ErrorAction SilentlyContinue }
  else { $env:TEAM_RELAY_BOT_TOKEN = $previousToken }
  if ($secureCode) { $secureCode.Dispose() }
  $headers = $null
  $token = $null
}
