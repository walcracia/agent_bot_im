$ErrorActionPreference = 'Stop'

function Open-ImRuntimeController {
  param([Parameter(Mandatory)][string]$ProjectRoot)
  $directory = Join-Path $ProjectRoot 'environment/config'
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $path = Join-Path $directory 'runtime-controller-lock.json'
  try {
    # The OS lock, rather than the persistent file's age, defines ownership.
    $stream = [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] { throw '另一个启动/停止操作正在运行，请等待其完成后再试。' }
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes((@{pid=$PID; at=(Get-Date).ToString('o')} | ConvertTo-Json -Compress))
    $stream.SetLength(0); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
    return $stream
  } catch { $stream.Dispose(); throw }
}

function Get-ImConfigPath {
  param([Parameter(Mandatory)][string]$ProjectRoot, [Parameter(Mandatory)][string]$Path)
  $directory = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'environment/config'))
  $full = [IO.Path]::GetFullPath($Path)
  if (!$full.StartsWith($directory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($full) -ne '.json') {
    throw 'DSH 配置必须位于本项目忽略的 environment/config 目录并使用 .json 扩展名。'
  }
  return $full
}

function Read-ImRuntimeJson {
  param([Parameter(Mandatory)][string]$Path)
  try { return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "运行记录不存在或无法解析：$Path；请保留文件并检查。" }
}

function Write-ImRuntimeJson {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary, $Path, $true)
}

function ConvertTo-ImProcessArgument {
  param([AllowEmptyString()][string]$Value)
  # Start-Process joins ArgumentList without quoting. Escape Windows argv here.
  if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
  return '"' + ([regex]::Replace($Value, '(\\*)"', '${1}${1}\"') -replace '(\\+)$', '$1$1') + '"'
}

function Test-ImCommandArgument {
  param([string]$CommandLine, [Parameter(Mandatory)][string]$Value)
  $escaped = [regex]::Escape($Value)
  return [regex]::IsMatch($CommandLine, '(?<!\S)(?:' + $escaped + '|"' + $escaped + '")(?=\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Get-ImSavedProcess {
  param([Parameter(Mandatory)]$Record, [Parameter(Mandatory)][ValidateSet('server','dsh')][string]$Role)
  if (!$Record.pid -or !$Record.executable -or !$Record.creation_ticks) { throw "$Role 进程记录缺少身份信息，拒绝操作。" }
  $processId = 0
  if (![int]::TryParse([string]$Record.pid, [ref]$processId) -or $processId -lt 1) { throw "$Role 进程记录 PID 无效。" }
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
  if (!$current) { return $null }
  if (![string]::Equals($current.ExecutablePath, $Record.executable, [StringComparison]::OrdinalIgnoreCase) -or $current.CreationDate.Ticks -ne [long]$Record.creation_ticks) {
    throw "$Role PID/可执行路径/创建时间不匹配，拒绝操作。"
  }
  if ($Role -eq 'server') {
    if (!(Test-ImCommandArgument $current.CommandLine '-m') -or !(Test-ImCommandArgument $current.CommandLine 'uvicorn') -or !(Test-ImCommandArgument $current.CommandLine 'server.app:app')) {
      throw '服务器命令行与本项目记录不符，拒绝操作。'
    }
  } else {
    foreach ($argument in @($Record.bridge_path, '--config', $Record.config_path, '--runtime-file', $Record.runtime_file, '--instance-id', $Record.instance_id)) {
      if (!$argument -or !(Test-ImCommandArgument $current.CommandLine $argument)) { throw 'DSH 进程命令行与本项目记录不符，拒绝操作。' }
    }
  }
  return $current
}

function Assert-ImDshRecordPaths {
  param([Parameter(Mandatory)]$Record, [Parameter(Mandatory)][string]$ProjectRoot)
  $instance = [Guid]::Empty
  if (![Guid]::TryParse([string]$Record.instance_id, [ref]$instance)) { throw 'DSH 实例标识无效。' }
  $null = Get-ImConfigPath -ProjectRoot $ProjectRoot -Path $Record.config_path
  $expectedRuntime = Join-Path $ProjectRoot ('environment/data/startup/' + [string]$Record.instance_id + '.json')
  if (![string]::Equals([IO.Path]::GetFullPath($Record.runtime_file), [IO.Path]::GetFullPath($expectedRuntime), [StringComparison]::OrdinalIgnoreCase) -or
      ![string]::Equals($Record.bridge_path, (Join-Path $ProjectRoot 'workspace/bridge/bridge.mjs'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'DSH 运行记录路径不属于本项目，拒绝操作。'
  }
}

function Get-ImBridgeRuntime {
  param([Parameter(Mandatory)]$Record, [switch]$AllowMissing)
  if ($AllowMissing -and !(Test-Path -LiteralPath $Record.runtime_file)) { return $null }
  $runtime = Read-ImRuntimeJson $Record.runtime_file
  if ($runtime.instanceId -cne $Record.instance_id -or $runtime.pid -ne $Record.pid -or
      ![string]::Equals($runtime.configPath, $Record.config_path, [StringComparison]::OrdinalIgnoreCase) -or
      $runtime.status -notin @('starting','listening','stopping','stopped','failed')) {
    throw 'DSH 就绪记录身份不匹配或状态无效，拒绝复用/停止。'
  }
  return $runtime
}

function Assert-ImServerListener {
  param([Parameter(Mandatory)]$Record, [Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)]$Listener)
  if ($Record.port -ne $Port -or $Listener.OwningProcess -ne $Record.pid -or $Listener.LocalAddress -ne '127.0.0.1') {
    throw "端口 $Port 的监听不属于本项目记录，拒绝操作。"
  }
  $current = Get-ImSavedProcess -Record $Record -Role server
  if (!$current) { throw '记录的服务器进程已退出。' }
  if ($current.CommandLine -notmatch ('(?:^|\s)--port\s+"?' + $Port + '"?(?:\s|$)')) { throw '服务器端口命令与记录不符。' }
  return $current
}
