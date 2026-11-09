param(
  [Parameter(Mandatory = $true)][string]$Python,
  [string]$Node = 'node'
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$workspace = Join-Path $projectRoot 'workspace'
if (![IO.Path]::IsPathFullyQualified($Python) -or !(Test-Path -LiteralPath $Python -PathType Leaf)) {
  throw 'Python必须是可信配置中已安装解释器的绝对路径。'
}
$pythonPath = (Resolve-Path -LiteralPath $Python).Path
$nodePath = (Get-Command $Node -CommandType Application -ErrorAction Stop).Source
$scratchParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$scratch = Join-Path $scratchParent ('relay-task-verify-' + [Guid]::NewGuid().ToString('N'))
$savedEnvironment = @{}
foreach ($name in @('PYTHONPATH', 'PYTHONDONTWRITEBYTECODE', 'PYTEST_ADDOPTS', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD', 'IM_TEST_PYTHON')) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Get-SourceFingerprint {
  $files = @(& git -c core.quotepath=false ls-files --cached --others --exclude-standard)
  if ($LASTEXITCODE) { throw '无法枚举任务副本源码。' }
  $fingerprints = foreach ($file in ($files | Sort-Object -Unique)) {
    $path = Join-Path $projectRoot $file
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { "$file`tmissing"; continue }
    "$file`t$((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)"
  }
  $status = @(& git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE) { throw '无法读取任务副本状态。' }
  $index = @(& git diff --cached --no-ext-diff --binary)
  if ($LASTEXITCODE) { throw '无法读取任务副本索引。' }
  return ($fingerprints -join "`n") + "`0" + ($status -join "`n") + "`0" + ($index -join "`n")
}

Push-Location -LiteralPath $projectRoot
try {
  $gitRoot = (& git rev-parse --show-toplevel).Trim()
  if ($LASTEXITCODE -or [IO.Path]::GetFullPath($gitRoot) -ne [IO.Path]::GetFullPath($projectRoot)) { throw '验收脚本必须位于当前Git任务根。' }
  $version = & $nodePath --version
  if ($LASTEXITCODE -or $version -notmatch '^v(\d+)\.(\d+)\.(\d+)') { throw '无法核验Node版本。' }
  if ([int]$Matches[1] -lt 24 -or ([int]$Matches[1] -eq 24 -and [int]$Matches[2] -lt 9)) { throw '任务验收需要Node>=24.9。' }
  $before = Get-SourceFingerprint
  New-Item -ItemType Directory -Path $scratch | Out-Null
  $env:PYTHONPATH = $workspace
  $env:PYTHONDONTWRITEBYTECODE = '1'
  $env:PYTEST_ADDOPTS = ''
  $env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = '1'
  $env:IM_TEST_PYTHON = $pythonPath
  & $pythonPath -X utf8 -c 'import importlib.util,pathlib,sys; actual=pathlib.Path(importlib.util.find_spec("server.app").origin).resolve(); expected=pathlib.Path(sys.argv[1]).resolve(); assert actual == expected, "Python imported another checkout"; assert sys.version_info >= (3,12)' (Join-Path $workspace 'server/app.py')
  if ($LASTEXITCODE) { throw 'Python必须导入当前任务副本的源码，且版本至少3.12。' }
  & $pythonPath -X utf8 -m pytest workspace/tests -q -p no:cacheprovider --basetemp (Join-Path $scratch 'pytest')
  if ($LASTEXITCODE) { throw '任务副本Python验收未通过。' }
  $javascript = @((Join-Path $workspace 'client/app.js'), (Join-Path $workspace 'desktop/main.cjs'), (Join-Path $workspace 'desktop/build.cjs'))
  $javascript += @(Get-ChildItem -LiteralPath (Join-Path $workspace 'bridge') -Filter '*.mjs' -File | Sort-Object Name | ForEach-Object FullName)
  foreach ($path in $javascript) {
    & $nodePath --check $path
    if ($LASTEXITCODE) { throw ('JavaScript语法验收失败：' + (Split-Path -Leaf $path)) }
  }
  $tests = @(Get-ChildItem -LiteralPath (Join-Path $workspace 'bridge/test') -Filter '*.test.mjs' -File | Sort-Object Name | ForEach-Object FullName)
  if (!$tests.Count) { throw '任务副本缺少桥接可靠性测试。' }
  & $nodePath --test @tests
  if ($LASTEXITCODE) { throw '任务副本桥接验收未通过。' }
  if ((Get-SourceFingerprint) -cne $before) { throw '验收期间Git状态、索引或源码发生改变，不能视为通过。' }
  Write-Output '任务副本验收通过：Python、JavaScript语法和桥接测试；未调用真实模型。'
} finally {
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
  Pop-Location
  if (Test-Path -LiteralPath $scratch) {
    $resolvedScratch = (Resolve-Path -LiteralPath $scratch).Path
    $item = Get-Item -LiteralPath $resolvedScratch -Force
    $prefix = $scratchParent + [IO.Path]::DirectorySeparatorChar
    if (!$resolvedScratch.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedScratch) -notmatch '^relay-task-verify-[a-f0-9]{32}$' -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw '临时验收目录归属无法确认，已保留供检查。'
    }
    Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
  }
}
