[CmdletBinding()]
param([ValidateRange(1024,65535)][int]$Port = 18310)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$preview = Join-Path $projectRoot 'outputs/design-review-2026-11-10'
$python = Join-Path $projectRoot 'environment/venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath (Join-Path $preview 'index.html'))) { throw '先运行 node environment/scripts/build-design-review.mjs 生成审核页。' }
if (!(Test-Path -LiteralPath $python)) { throw '先按environment/README.md恢复项目Python环境。' }
$url = "http://127.0.0.1:$Port/"
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  try { $page = Invoke-WebRequest -Uri $url -TimeoutSec 3 -ErrorAction Stop }
  catch { throw '端口已被占用，保留已有进程；请指定其他-Port。' }
  if ($page.Content -notmatch '<title>同频风格审核</title>') { throw '端口属于其他服务，未接管；请指定其他-Port。' }
  Write-Output "审核页已在运行：$url"
  return
}
Write-Output "审核页：$url 。此终端运行独立静态服务，按Ctrl+C停止。"
& $python -m http.server $Port --bind 127.0.0.1 --directory $preview
if ($LASTEXITCODE) { throw '审核静态服务未正常退出。' }
