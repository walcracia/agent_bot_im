param(
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$Message,
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string[]]$Files,
  [string]$Repository = 'walcracia/agent_bot_im'
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($Version -notmatch '^v\d+\.\d+\.\d+([-.][a-zA-Z0-9.-]+)?$') { throw '版本必须使用 v0.1.0 等 tag 格式。' }
$gh = Join-Path $projectRoot 'environment/tools/gh/bin/gh.exe'
if (!(Test-Path -LiteralPath $gh)) { $gh = 'gh' }
Push-Location $projectRoot
try {
  $branch = git symbolic-ref --quiet --short HEAD
  if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw '此发布入口仅允许 main 分支；请先审查并整合目标分支。' }
  & $gh auth status
  if ($LASTEXITCODE) { throw '请先在本机执行 gh auth login；不要把 token 发到聊天或写进脚本。' }
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { throw '已有暂存内容，请先确认其归属；脚本不会混入其他工作。' }
  & (Join-Path $PSScriptRoot 'verify.ps1')
  if ($LASTEXITCODE) { throw '验证未通过，不发布版本。' }
  git diff --check
  if ($LASTEXITCODE) { throw '工作树格式检查未通过。' }
  Write-Output '仅暂存 -Files 明确指定的路径；请在调用前审查文件内容与敏感信息：'
  git status --short
  git add -- $Files
  if ($LASTEXITCODE) { throw '暂存指定文件失败' }
  git diff --cached --check
  if ($LASTEXITCODE) { throw '暂存内容格式检查未通过' }
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 1) { git commit -m $Message; if ($LASTEXITCODE) { throw '提交失败' } }
  git show-ref --verify --quiet "refs/tags/$Version"
  if ($LASTEXITCODE -ne 0) { git tag -a $Version -m $Message; if ($LASTEXITCODE) { throw '打标签失败' } }
  else {
    $tagCommit = git rev-parse "$Version^{commit}"
    $headCommit = git rev-parse HEAD
    if ($tagCommit -ne $headCommit) { throw '该版本已用于其他提交，请使用新的版本号；未移动已有标签。' }
  }
  git remote get-url origin 2>$null | Out-Null
  if ($LASTEXITCODE) {
    & $gh repo view $Repository --json nameWithOwner 2>$null | Out-Null
    if ($LASTEXITCODE) {
      & $gh repo create $Repository --private --source . --remote origin
      if ($LASTEXITCODE) { throw '创建仓库失败' }
    } else { git remote add origin "https://github.com/$Repository.git" }
  }
  git push -u origin main
  if ($LASTEXITCODE) { throw '分支推送失败，版本保留本机，禁止标记已上传。' }
  git push origin "refs/tags/$Version"
  if ($LASTEXITCODE) { throw 'tag 推送失败，需重试。' }
  Write-Output "已推送 $Version：https://github.com/$Repository"
} finally { Pop-Location }
