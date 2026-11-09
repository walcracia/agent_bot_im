[CmdletBinding()]
param([switch]$SkipNodeTests)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7。' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$bridge = Join-Path $projectRoot 'workspace/bridge'
$node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nodeVersion = (& $node.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+\.\d+\.\d+)' -or [Version]$Matches[1] -lt [Version]'24.9.0') { throw '需要Node.js 24.9或更高版本。' }
foreach ($module in @(Get-ChildItem -LiteralPath $bridge -Filter 'super-*.mjs' -File)) {
  & $node.Source --check $module.FullName
  if ($LASTEXITCODE) { throw "新模块语法检查失败：$($module.Name)" }
}
foreach ($path in @((Join-Path $bridge 'enable-super.ps1'), $PSCommandPath)) {
  $tokens = $null; $errors = $null
  [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count) { throw "PowerShell语法检查失败：$([IO.Path]::GetFileName($path))" }
}
$example = Get-Content -LiteralPath (Join-Path $bridge 'config.super.example.json') -Raw | ConvertFrom-Json -AsHashtable
if ($example.superAgent.enabled -ne $true -or $example.superAgent.maxWorkers -ne 2 -or $example.superAgent.controlPort -ne 18202 -or
    $example.superAgent.watchdog.enabled -ne $true -or $example.statePath -eq $example.superAgent.statePath) { throw 'Super-agent示例配置不符合隔离默认值。' }
if (!$SkipNodeTests) {
  $tests = @(Get-ChildItem -LiteralPath (Join-Path $bridge 'test') -Filter 'super-*.test.mjs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
  if (!$tests.Count) { throw '没有找到Super-agent隔离测试。' }
  & $node.Source --test @tests
  if ($LASTEXITCODE) { throw 'Super-agent隔离测试失败；未调用正式配置、模型或团队GitHub。' }
}
if (!$IsWindows) { Write-Host '新模块检查完成；Windows配置转换测试未执行。'; return }

# Copy only scripts into an isolated synthetic checkout. Never alter the actual binding.
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('team-relay-super-settings-' + [Guid]::NewGuid().ToString('N'))
$fixtureRoot = [IO.Path]::GetFullPath($fixtureRoot)
$fixtureBridge = Join-Path $fixtureRoot 'workspace/bridge'
$fixtureConfig = Join-Path $fixtureRoot 'environment/config'
[IO.Directory]::CreateDirectory($fixtureBridge) | Out-Null
[IO.Directory]::CreateDirectory($fixtureConfig) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $fixtureRoot 'environment/scripts')) | Out-Null
function Assert-SuperCheck([bool]$Condition, [string]$Description) { if (!$Condition) { throw "配置转换验收失败：$Description" } }
function Expect-SuperRejection([scriptblock]$Action, [string]$Description) {
  $refused = $false
  try { & $Action | Out-Null } catch { $refused = $true }
  Assert-SuperCheck $refused $Description
}
try {
  foreach ($name in @('enable-super.ps1', 'startup-credential.ps1')) { Copy-Item -LiteralPath (Join-Path $bridge $name) -Destination (Join-Path $fixtureBridge $name) }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime-processes.ps1') -Destination (Join-Path $fixtureRoot 'environment/scripts/runtime-processes.ps1')
  & git init --initial-branch=main $fixtureRoot *> $null
  if ($LASTEXITCODE) { throw '无法建立隔离Git夹具。' }
  & git -C $fixtureRoot remote add origin 'https://github.com/owner/repository.git'
  if ($LASTEXITCODE) { throw '无法设置合成Git远端。' }
  $file = Join-Path $fixtureConfig 'bridge-installed.local.json'
  $state = Join-Path $fixtureRoot 'environment/data/legacy/state.json'
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($state)) | Out-Null
  $settings = [ordered]@{ executor='installed-headless'; triggerMode='auto'; baseUrl='http://127.0.0.1:18200';
    tokenEnv='TEAM_RELAY_BOT_TOKEN'; botUsername='dsh'; conversationIds=@('synthetic-group'); senderIds=@('synthetic-member');
    pollMilliseconds=2000; statePath=$state; harness=[ordered]@{ cwd=$fixtureRoot; cliPath='C:/synthetic/dsh.cmd'; auth='stored' } }
  [IO.File]::WriteAllText($file, ($settings | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  $original = [IO.File]::ReadAllText($file)
  $enable = Join-Path $fixtureBridge 'enable-super.ps1'
  [IO.File]::WriteAllText($state, '{"cursor":12,"current":{"phase":"uncertain","event":{"id":12}}}')
  Expect-SuperRejection { & $enable -RepositoryPath $fixtureRoot } '未完成旧任务必须拒绝转换'
  Assert-SuperCheck ([IO.File]::ReadAllText($file) -ceq $original) '拒绝时原配置字节不变'
  Assert-SuperCheck ([IO.File]::ReadAllText($state).Contains('uncertain')) '拒绝时旧任务保留'
  [IO.File]::WriteAllText($state, '{"cursor":12,"current":null}')
  [IO.File]::WriteAllText(($state + '.lock'), '{"pid":1}')
  Expect-SuperRejection { & $enable -RepositoryPath $fixtureRoot } '存在旧锁必须拒绝'
  Assert-SuperCheck ([IO.File]::Exists($state + '.lock')) '旧锁不得自动删除'
  [IO.File]::Delete($state + '.lock')
  $settings.token = 'SYNTHETIC_NOT_A_REAL_CREDENTIAL'
  [IO.File]::WriteAllText($file, ($settings | ConvertTo-Json -Depth 8))
  Expect-SuperRejection { & $enable -RepositoryPath $fixtureRoot } '内联认证不得备份'
  Assert-SuperCheck (!(Test-Path -LiteralPath (Join-Path $fixtureConfig 'backups'))) '拒绝认证字段时不建立备份'
  $settings.Remove('token')
  [IO.File]::WriteAllText($file, $original)
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
  $record = [ordered]@{pid=$PID;executable=$current.ExecutablePath;creation_ticks=$current.CreationDate.Ticks;
    bridge_path=(Join-Path $fixtureBridge 'bridge.mjs');config_path=$file;instance_id=[Guid]::NewGuid().ToString('D')}
  $record.runtime_file = Join-Path $fixtureRoot ('environment/data/startup/' + $record.instance_id + '.json')
  $recordFile = Join-Path $fixtureConfig 'dsh-process.json'
  [IO.File]::WriteAllText($recordFile, ($record | ConvertTo-Json))
  Expect-SuperRejection { & $enable -RepositoryPath $fixtureRoot } '存活或身份不能核验的进程记录必须拒绝'
  [IO.File]::Delete($recordFile)
  $result = & $enable -RepositoryPath $fixtureRoot -PassThru
  $converted = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -AsHashtable
  Assert-SuperCheck ($converted.superAgent.enabled -eq $true -and $converted.superAgent.maxWorkers -eq 2) '转换为双worker模式'
  Assert-SuperCheck ($converted.statePath -eq $state -and $converted.superAgent.statePath -ne $state) '旧/新账本分开'
  Assert-SuperCheck ($converted.superAgent.watchdog.enabled -eq $true -and $converted.superAgent.executionMode -eq 'local') '独立监督及本机默认'
  Assert-SuperCheck ([IO.File]::ReadAllText($result.backupPath) -ceq $original) '独立备份保留原配置字节'
  Assert-SuperCheck ([IO.File]::ReadAllText($state) -ceq '{"cursor":12,"current":null}') '成功转换不修改旧账本'
  $superState = $converted.superAgent.statePath
  $null = & $enable -RepositoryPath $fixtureRoot -MaxWorkers 3 -GitHubRepo 'owner/repository' -AllowedGitHubActors @('maintainer') -TestExecutable $node.Source -TestArguments @('-e','process.exit(0)') -PassThru
  $withGitHub = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -AsHashtable
  Assert-SuperCheck ($withGitHub.superAgent.statePath -eq $superState) '重复转换保留新任务账本归属'
  Assert-SuperCheck ($withGitHub.superAgent.github.testCommands.Count -eq 1 -and $withGitHub.superAgent.github.testCommands[0].Count -eq 3) '可信测试命令保持嵌套argv数组'
  Assert-SuperCheck ($withGitHub.superAgent.github.autoMerge -eq $false) '默认不自动合并'
  Expect-SuperRejection { & $enable -RepositoryPath $fixtureRoot -GitHubRepo 'owner/repository' -AllowedGitHubActors @('maintainer') -TestExecutable $node.Source -AutoMerge } '自动合并缺少检查和审查者时拒绝'
  Write-Host 'Super-agent配置转换隔离验收通过：旧任务/锁/身份/认证门禁、原子备份、独立账本与可信argv。零模型、零团队GitHub写入。'
} finally {
  # Only this exact, newly-created temporary checkout may be recursively removed.
  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolved = [IO.Path]::GetFullPath($fixtureRoot)
  if (!$resolved.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'team-relay-super-settings-*') { throw '临时清理路径不在本次验收范围内。' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
