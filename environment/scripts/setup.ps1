param(
  [string]$UvCommand = 'uv',
  [string]$PythonVersion = '3.12',
  [switch]$SkipDesktop
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$venv = Join-Path $projectRoot 'environment/venv'
if (!(Get-Command $UvCommand -ErrorAction SilentlyContinue)) { throw '需要 uv；安装后加入 PATH，或用 -UvCommand 指定 uv.exe。' }
foreach ($directory in @('environment/config', 'environment/logs', 'environment/verification')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot $directory) | Out-Null
}
if (!(Test-Path -LiteralPath (Join-Path $venv 'Scripts/python.exe'))) {
  $previousPythonDirectory = $env:UV_PYTHON_INSTALL_DIR
  try {
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $projectRoot 'environment/tools/python'
    # Avoid embedded interpreters (for example LibreOffice) that cannot create a venv.
    & $UvCommand venv $venv --python $PythonVersion --managed-python
    if ($LASTEXITCODE) { throw 'venv 创建失败' }
  } finally { $env:UV_PYTHON_INSTALL_DIR = $previousPythonDirectory }
}
& (Join-Path $venv 'Scripts/python.exe') -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'
if ($LASTEXITCODE) { throw '已有 venv 无法运行或 Python 低于 3.12；请保留并移开该目录，再运行 setup.ps1。' }
& $UvCommand pip install --python (Join-Path $venv 'Scripts/python.exe') -r (Join-Path $projectRoot 'environment/config/requirements.lock.txt')
if ($LASTEXITCODE) { throw 'Python 依赖安装失败' }
if (!$SkipDesktop) {
  Push-Location (Join-Path $projectRoot 'workspace')
  try { npm.cmd ci; if ($LASTEXITCODE) { throw 'npm 依赖安装失败' } } finally { Pop-Location }
}
Write-Output '依赖已准备。首次创建管理员请阅读 workspace/README.md。'
