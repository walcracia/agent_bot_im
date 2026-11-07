$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$python = Join-Path $projectRoot 'environment/venv/Scripts/python.exe'
Push-Location (Join-Path $projectRoot 'workspace')
try {
  & $python -m pytest tests -q --junitxml=../environment/verification/pytest.xml 2>&1 | Tee-Object -FilePath ../environment/logs/pytest.log
  if ($LASTEXITCODE) { throw '服务器测试未通过。' }
  npm.cmd run check
  if ($LASTEXITCODE) { throw '客户端语法检查未通过。' }
  node --test bridge/test/*.test.mjs
  if ($LASTEXITCODE) { throw '桥接可靠性测试未通过。' }
} finally { Pop-Location }
