param(
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$Message,
  [string]$Repository = 'walcracia/agent_bot_im'
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($Version -notmatch '^v\d+\.\d+\.\d+([-.][a-zA-Z0-9.-]+)?$') { throw '版本必须使用 v0.1.0 等 tag 格式。' }
$gh = Join-Path $projectRoot 'environment/tools/gh/bin/gh.exe'
if (!(Test-Path -LiteralPath $gh)) { $gh = 'gh' }
Push-Location $projectRoot
try {
  & $gh auth status
  if ($LASTEXITCODE) { throw '请先在本机执行 gh auth login；不要把 token 发到聊天或写进脚本。' }
  & (Join-Path $PSScriptRoot 'verify.ps1')
  if ($LASTEXITCODE) { throw '验证未通过，不发布版本。' }
  git diff --check
  if ($LASTEXITCODE) { throw '工作树格式检查未通过。' }
  Write-Output '即将提交以下文件（敏感配置和数据已由 .gitignore 排除）：'
  git status --short
  git add --all
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 1) { git commit -m $Message; if ($LASTEXITCODE) { throw '提交失败' } }
  git show-ref --verify --quiet "refs/tags/$Version"
  if ($LASTEXITCODE -ne 0) { git tag -a $Version -m $Message; if ($LASTEXITCODE) { throw '打标签失败' } }
  git remote get-url origin 2>$null | Out-Null
  if ($LASTEXITCODE) {
    & $gh repo view $Repository --json nameWithOwner 2>$null | Out-Null
    if ($LASTEXITCODE) {
      & $gh repo create $Repository --private --source . --remote origin
      if ($LASTEXITCODE) { throw '创建仓库失败' }
    } else { git remote add origin "https://github.com/$Repository.git" }
  }
  & $gh auth setup-git
  git push -u origin main
  if ($LASTEXITCODE) { throw '分支推送失败，版本保留本机，禁止标记已上传。' }
  git push origin --tags
  if ($LASTEXITCODE) { throw 'tag 推送失败，需重试。' }
  Write-Output "已推送 $Version：https://github.com/$Repository"
} finally { Pop-Location }
