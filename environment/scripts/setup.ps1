$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$venv = Join-Path $projectRoot 'environment/venv'
if (!(Test-Path -LiteralPath (Join-Path $venv 'Scripts/python.exe'))) { uv venv $venv --python 3.12; if ($LASTEXITCODE) { throw 'venv 创建失败' } }
uv pip install --python (Join-Path $venv 'Scripts/python.exe') -r (Join-Path $projectRoot 'environment/config/requirements.lock.txt')
if ($LASTEXITCODE) { throw 'Python 依赖安装失败' }
Push-Location (Join-Path $projectRoot 'workspace')
try { npm.cmd ci; if ($LASTEXITCODE) { throw 'npm 依赖安装失败' } } finally { Pop-Location }
Write-Output '依赖已准备。首次创建管理员请阅读 workspace/README.md。'
