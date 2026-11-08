[CmdletBinding()]
param(
  [string]$Config,
  [switch]$Once,
  [string]$RetryEvent,
  [string]$SkipEvent
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7。' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (!$Config) { $Config = Join-Path $projectRoot 'environment/config/bridge-installed.local.json' }
$configPath = [IO.Path]::GetFullPath($Config)
$configDirectory = Join-Path $projectRoot 'environment/config'
$comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
if (!$configPath.StartsWith($configDirectory + [IO.Path]::DirectorySeparatorChar, $comparison)) { throw '请使用本项目 environment/config 内已经绑定的本机配置。' }
try { $settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -ErrorAction Stop }
catch { throw '本机配置不存在或无法解析；首次请运行 connect-installed.ps1。' }
if ($settings.executor -ne 'installed-headless' -or $settings.tokenEnv -ne 'TEAM_RELAY_BOT_TOKEN') { throw '此入口仅运行本机 DSH 绑定配置。' }
if ($RetryEvent -and $SkipEvent) { throw 'RetryEvent 和 SkipEvent 只能选择一项。' }
$node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nodeVersion = (& $node.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+\.\d+\.\d+)' -or [Version]$Matches[1] -lt [Version]'24.9.0') { throw '需要 Node.js 24.9 或更高版本。' }
$arguments = @((Join-Path $PSScriptRoot 'bridge.mjs'), '--config', $configPath)
if ($Once) { $arguments += '--once' }
if ($RetryEvent) { $arguments += @('--retry-event', $RetryEvent) }
if ($SkipEvent) { $arguments += @('--skip-event', $SkipEvent) }
$previous = [Environment]::GetEnvironmentVariable('TEAM_RELAY_BOT_TOKEN', 'Process')
$secureCode = $null
try {
  if (!$previous) {
    $secureCode = Read-Host '同频助手连接码（不写入文件）' -AsSecureString
    $env:TEAM_RELAY_BOT_TOKEN = [Net.NetworkCredential]::new('', $secureCode).Password.Trim()
  }
  if (!$env:TEAM_RELAY_BOT_TOKEN) { throw '连接码为空，未启动监听。' }
  & $node.Source @arguments
  if ($LASTEXITCODE) { throw '监听退出；请检查本机运行记录。不要为恢复而删除状态或重做不确定任务。' }
} finally {
  if ($null -eq $previous) { Remove-Item Env:TEAM_RELAY_BOT_TOKEN -ErrorAction SilentlyContinue }
  else { $env:TEAM_RELAY_BOT_TOKEN = $previous }
  if ($secureCode) { $secureCode.Dispose() }
}
