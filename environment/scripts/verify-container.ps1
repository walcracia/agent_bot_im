param([string]$ContainerName = 'agent-im-verification', [string]$BaseUrl = 'http://127.0.0.1:18201')
$ErrorActionPreference = 'Stop'
# Only use the isolated container created for this project. Never points at production.
if ($ContainerName -ne 'agent-im-verification' -or $BaseUrl -ne 'http://127.0.0.1:18201') { throw '此验证脚本仅允许项目隔离容器。' }
$initialReady = $false
for ($i=0;$i -lt 30;$i++) {
  try { $null = Invoke-RestMethod "$BaseUrl/api/health"; $initialReady=$true; break } catch { Start-Sleep -Milliseconds 500 }
}
if (!$initialReady) { throw '隔离容器尚未就绪' }
$username = 'verify-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$password = [guid]::NewGuid().ToString('N')
$env:IM_ADMIN_PASSWORD = $password
try {
  docker exec -e IM_ADMIN_PASSWORD $ContainerName python -m server.cli init-admin --username $username
  if ($LASTEXITCODE) { throw '容器内创建测试管理员失败' }
} finally { Remove-Item Env:\IM_ADMIN_PASSWORD -ErrorAction SilentlyContinue }
$login = Invoke-RestMethod "$BaseUrl/api/login" -Method Post -ContentType application/json -Body (@{username=$username;password=$password} | ConvertTo-Json)
$auth = @{Authorization='Bearer ' + $login.token}
$member = Invoke-RestMethod "$BaseUrl/api/admin/users" -Method Post -Headers $auth -ContentType application/json -Body (@{username=($username+'-member');display_name='验证成员';password=[guid]::NewGuid().ToString('N')} | ConvertTo-Json)
$conversation = Invoke-RestMethod "$BaseUrl/api/conversations" -Method Post -Headers $auth -ContentType application/json -Body (@{title='Container verification';member_ids=@($member.id);is_direct=$false} | ConvertTo-Json)
$message = Invoke-RestMethod "$BaseUrl/api/conversations/$($conversation.id)/messages" -Method Post -Headers $auth -ContentType application/json -Body (@{text='container-persistence-ok';client_id=[guid]::NewGuid().ToString('N')} | ConvertTo-Json)
docker restart $ContainerName | Out-Null
if ($LASTEXITCODE) { throw '隔离容器重启失败' }
$ready = $false
for ($i=0;$i -lt 30;$i++) {
  try { $null = Invoke-RestMethod "$BaseUrl/api/health"; $ready=$true; break } catch { Start-Sleep -Milliseconds 500 }
}
if (!$ready) { throw '重启后未恢复' }
$history = Invoke-RestMethod "$BaseUrl/api/conversations/$($conversation.id)/messages" -Headers $auth
if (!($history | Where-Object { $_.id -eq $message.id -and $_.text -eq 'container-persistence-ok' })) { throw '重启后消息未持久保留' }
Write-Output 'PASS: Linux容器创建账号/会话/消息，重启后会话身份与消息持久化通过。'
