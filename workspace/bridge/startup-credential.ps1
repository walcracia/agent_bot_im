# Dot-source this file. IM connection codes are protected by Windows DPAPI for
# the current user; DSH's own stored authentication is never read here.
function Resolve-ImStartupConfigFile {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
  $directory = [IO.Path]::GetFullPath((Join-Path $projectRoot 'environment/config'))
  $full = [IO.Path]::GetFullPath($Path)
  $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
  if (!$full.StartsWith($directory + [IO.Path]::DirectorySeparatorChar, $comparison) -or [IO.Path]::GetExtension($full) -ne '.json') {
    throw '启动配置和加密连接码必须是本项目 environment/config 内的 JSON 文件。'
  }
  $relative = [IO.Path]::GetRelativePath($directory, $full)
  if ($relative.Contains(':')) { throw '启动配置不允许使用文件数据流。' }
  # Refuse junctions/symlinks rather than following a lexical path outside the
  # ignored local configuration directory. Check existing ancestors as well.
  $current = $full
  while ($current -and $current.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, $comparison)) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '启动配置路径不能经过链接或联接目录。' }
    }
    $current = [IO.Path]::GetDirectoryName($current)
  }
  return $full
}

function Save-ImStartupToken {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][string]$CredentialPath,
    [Parameter(Mandatory)][Security.SecureString]$Token
  )
  if (!$IsWindows) { throw '随启动连接码只支持 Windows 当前用户 DPAPI；其他系统请使用进程环境变量。' }
  $configFile = Resolve-ImStartupConfigFile -Path $ConfigPath
  $credentialFile = Resolve-ImStartupConfigFile -Path $CredentialPath
  if ($configFile -eq $credentialFile) { throw '加密连接码不能覆盖监听配置文件。' }
  $plain = $null
  $temporary = $null
  try {
    $plain = [Net.NetworkCredential]::new('', $Token).Password
    if (!$plain -or $plain.Length -gt 4096 -or $plain -match '\s') { throw '助手连接码为空或格式无效。' }
    $protected = ConvertFrom-SecureString -SecureString $Token -ErrorAction Stop
    $payload = [ordered]@{ version = 1; kind = 'windows-dpapi-current-user'; protectedToken = $protected }
    $parent = [IO.Path]::GetDirectoryName($credentialFile)
    New-Item -ItemType Directory -Force -Path $parent -ErrorAction Stop | Out-Null
    $temporary = Join-Path $parent ([IO.Path]::GetFileNameWithoutExtension($credentialFile) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp.json')
    [IO.File]::WriteAllText($temporary, ($payload | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $credentialFile, $true)
    $temporary = $null
  } catch {
    # Do not propagate crypto exception details, ciphertext, or token values.
    throw '无法保存当前 Windows 用户的加密助手连接码；原监听配置未更新。'
  } finally {
    $plain = $null
    $protected = $null
    if ($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function Get-ImStartupToken {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$ConfigPath)
  if (!$IsWindows) { throw '随启动连接码只支持 Windows 当前用户 DPAPI；其他系统请使用进程环境变量。' }
  $secure = $null
  try {
    $configFile = Resolve-ImStartupConfigFile -Path $ConfigPath
    $config = Get-Content -LiteralPath $configFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($config.executor -ne 'installed-headless' -or $config.tokenEnv -ne 'TEAM_RELAY_BOT_TOKEN' -or $config.startup.enabled -isnot [bool] -or !$config.startup.enabled) {
      throw 'Invalid startup configuration.'
    }
    if ($config.startup.credentialPath -isnot [string] -or ![IO.Path]::IsPathFullyQualified($config.startup.credentialPath)) { throw 'Invalid credential path.' }
    $credentialFile = Resolve-ImStartupConfigFile -Path $config.startup.credentialPath
    if ($credentialFile -eq $configFile -or !(Test-Path -LiteralPath $credentialFile -PathType Leaf) -or (Get-Item -LiteralPath $credentialFile).Length -gt 65536) {
      throw 'Invalid credential file.'
    }
    $payload = Get-Content -LiteralPath $credentialFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($payload.version -ne 1 -or $payload.kind -ne 'windows-dpapi-current-user' -or $payload.protectedToken -isnot [string] -or !$payload.protectedToken) {
      throw 'Invalid protected credential.'
    }
    $secure = ConvertTo-SecureString -String $payload.protectedToken -ErrorAction Stop
    $plain = [Net.NetworkCredential]::new('', $secure).Password
    if (!$plain -or $plain.Length -gt 4096 -or $plain -match '\s') { throw 'Invalid decrypted token.' }
    # Caller must assign this value and only pass it to the IM bridge process.
    return $plain
  } catch {
    throw '无法读取本机加密助手连接码；请用保存它的 Windows 用户运行，或重新运行 connect-installed.ps1 -EnableStartup 完成绑定。'
  } finally {
    if ($secure) { $secure.Dispose() }
    $plain = $null
    $payload = $null
  }
}
