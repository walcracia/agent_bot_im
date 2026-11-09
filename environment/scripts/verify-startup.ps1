[CmdletBinding()]
param([string]$ReportPath)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (!$ReportPath) { $ReportPath = Join-Path $projectRoot 'environment/verification/startup-v0.2.1/orchestration.json' }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('relay startup orchestration ' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$results = [Collections.Generic.List[object]]::new()
$savedToken = [Environment]::GetEnvironmentVariable('TEAM_RELAY_BOT_TOKEN','Process')
$savedData = [Environment]::GetEnvironmentVariable('IM_DATA_DIR','Process')

function Assert-Test([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Write-TestJson([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}
function Read-TestJson([string]$Path) { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
function Assert-TestThrows([scriptblock]$Action, [string]$Pattern) {
  $caught = $null
  try { $null = & $Action } catch { $caught = $_ }
  Assert-Test ($null -ne $caught) 'Expected a failure rather than successful startup/stop.'
  if ($Pattern) { Assert-Test ($caught.Exception.Message -match $Pattern) ('Unexpected failure: ' + $caught.Exception.Message) }
}
function New-TestFixture([switch]$NoConfig, [switch]$NoServer, [switch]$ExistingDsh) {
  $root = Join-Path $testRoot ([Guid]::NewGuid().ToString('N'))
  foreach ($relative in @('environment/scripts','environment/config','environment/data/startup','environment/logs','environment/venv/Scripts','workspace/bridge')) {
    [IO.Directory]::CreateDirectory((Join-Path $root $relative)) | Out-Null
  }
  foreach ($name in @('start.ps1','stop.ps1','runtime-processes.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root ('environment/scripts/' + $name))
  }
  # Synthetic decryption boundary: actual DPAPI roundtrip has a separate process test.
  [IO.File]::WriteAllText((Join-Path $root 'workspace/bridge/startup-credential.ps1'), @'
function Get-ImStartupToken {
  param([string]$ConfigPath)
  $global:ImStartupHarness.CredentialReads++
  return 'synthetic-startup-secret'
}
'@)
  [IO.File]::WriteAllText((Join-Path $root 'workspace/bridge/bridge.mjs'), '// never executed: Start-Process is mocked')
  [IO.File]::WriteAllText((Join-Path $root 'environment/venv/Scripts/python.exe'), 'never executed: Start-Process is mocked')
  $configPath = Join-Path $root 'environment/config/bridge-installed.local.json'
  if (!$NoConfig) {
    Write-TestJson $configPath @{executor='installed-headless';triggerMode='auto';baseUrl='http://127.0.0.1:23991';startup=@{enabled=$true;credentialPath=(Join-Path $root 'environment/config/secret.json')}}
  }
  $global:ImStartupHarness = @{
    Root=$root;ConfigPath=$configPath;Port=23991;Processes=@{};Starts=[Collections.Generic.List[object]]::new();Stops=[Collections.Generic.List[int]]::new()
    CredentialReads=0;DshReadyStatus='listening';CompleteOnStop=$false;ServerLive=$false;DshLive=$false
  }
  if (!$NoServer) { New-TestServer }
  if ($ExistingDsh) { New-TestDsh }
  return $root
}
function New-TestServer {
  $s = $global:ImStartupHarness
  $creation = [DateTime]::UtcNow.AddMinutes(-2)
  $executable = Join-Path $s.Root 'environment/venv/Scripts/python.exe'
  $process = [pscustomobject]@{ProcessId=610001;ParentProcessId=0;ExecutablePath=$executable;CreationDate=$creation;CommandLine=('"' + $executable + '" -m uvicorn server.app:app --host 127.0.0.1 --port 23991 --workers 1')}
  $s.Processes[610001] = $process
  $s.ServerLive = $true
  Write-TestJson (Join-Path $s.Root 'environment/config/server-process.json') @{pid=610001;launcher_pid=610001;port=23991;executable=$executable;creation_ticks=$creation.Ticks}
  return
}
function New-TestDsh([string[]]$Arguments) {
  $s = $global:ImStartupHarness
  $instance = [Guid]::NewGuid().ToString('D')
  $runtime = Join-Path $s.Root ('environment/data/startup/' + $instance + '.json')
  $bridge = Join-Path $s.Root 'workspace/bridge/bridge.mjs'
  if ($Arguments) {
    $instance = $Arguments[[Array]::IndexOf($Arguments,'--instance-id')+1].Trim('"')
    $runtime = $Arguments[[Array]::IndexOf($Arguments,'--runtime-file')+1].Trim('"')
  } else {
    $Arguments = @('"'+$bridge+'"','--config','"'+$s.ConfigPath+'"','--runtime-file','"'+$runtime+'"','--instance-id',$instance)
  }
  $creation = [DateTime]::UtcNow.AddMinutes(-1)
  $node = (Microsoft.PowerShell.Core\Get-Command node -CommandType Application | Select-Object -First 1).Source
  $process = [pscustomobject]@{ProcessId=610002;ParentProcessId=0;ExecutablePath=$node;CreationDate=$creation;CommandLine=('"'+$node+'" '+($Arguments -join ' '))}
  $s.Processes[610002] = $process
  $s.DshLive = $true
  $s.RuntimePath = $runtime
  $s.InstanceId = $instance
  $record = @{pid=610002;executable=$node;creation_ticks=$creation.Ticks;config_path=$s.ConfigPath;runtime_file=$runtime;instance_id=$instance;bridge_path=$bridge}
  Write-TestJson (Join-Path $s.Root 'environment/config/dsh-process.json') $record
  Write-TestJson $runtime @{instanceId=$instance;pid=610002;configPath=$s.ConfigPath;status=$s.DshReadyStatus}
  return
}

# Only these test-process-local mocks can see the synthetic fixture. No real service/process is touched.
function Get-NetTCPConnection {
  [CmdletBinding()]param($LocalPort,$State)
  $s = $global:ImStartupHarness
  if ($s.ServerLive) { return [pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=$s.Port;OwningProcess=610001} }
}
function Get-CimInstance {
  [CmdletBinding()]param($ClassName,[string]$Filter)
  $s = $global:ImStartupHarness
  if ($Filter -notmatch '^ProcessId=(\d+)$') { throw 'Unexpected CIM fixture request.' }
  $processId = [int]$Matches[1]
  if ($processId -eq 610002 -and $s.CompleteOnStop -and (Test-Path -LiteralPath ($s.RuntimePath+'.stop'))) {
    $runtime = Read-TestJson $s.RuntimePath
    $runtime.status = 'stopped'
    Write-TestJson $s.RuntimePath $runtime
    $s.Processes.Remove(610002)
    $s.DshLive = $false
  }
  return $s.Processes[$processId]
}
function Invoke-RestMethod {
  [CmdletBinding()]param($Uri,$TimeoutSec)
  if ($Uri -ne 'http://127.0.0.1:23991/api/health') { throw 'Unexpected HTTP fixture request.' }
  return [pscustomobject]@{status='ok';version='synthetic'}
}
function Get-Command {
  [CmdletBinding()]param($Name,$CommandType)
  if ($Name -eq 'node' -and $global:ImStartupHarness.NodeVersionScript) {
    return [pscustomobject]@{Source=$global:ImStartupHarness.NodeVersionScript}
  }
  return Microsoft.PowerShell.Core\Get-Command @PSBoundParameters
}
function Start-Process {
  [CmdletBinding()]param($FilePath,[string[]]$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru)
  $s = $global:ImStartupHarness
  $s.Starts.Add(@{FilePath=$FilePath;Arguments=$ArgumentList;Token=[Environment]::GetEnvironmentVariable('TEAM_RELAY_BOT_TOKEN','Process');WindowStyle=$WindowStyle})
  if ([IO.Path]::GetFileName($FilePath) -eq 'python.exe') { New-TestServer; return [pscustomobject]@{Id=610001;StartTime=$s.Processes[610001].CreationDate} }
  New-TestDsh -Arguments $ArgumentList
  return [pscustomobject]@{Id=610002;StartTime=$s.Processes[610002].CreationDate}
}
function Stop-Process {
  [CmdletBinding()]param([int]$Id)
  $s = $global:ImStartupHarness
  $s.Stops.Add($Id)
  $s.Processes.Remove($Id)
  if ($Id -eq 610001) { $s.ServerLive=$false }
}
function Invoke-Test([string]$Name,[scriptblock]$Action) {
  try { & $Action; $results.Add(@{name=$Name;passed=$true}); Write-Host "PASS $Name" }
  catch { $results.Add(@{name=$Name;passed=$false;error=$_.Exception.Message}); Write-Host "FAIL $Name`: $($_.Exception.Message)" }
}

try {
  $env:TEAM_RELAY_BOT_TOKEN='synthetic-parent-token'
  $env:IM_DATA_DIR='synthetic-parent-data'
  Invoke-Test 'default start refuses unbound configuration before launching anything' {
    $root = New-TestFixture -NoConfig
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 } 'DSH'
    Assert-Test ($global:ImStartupHarness.Starts.Count -eq 0) 'Unbound start launched a process.'
  }
  Invoke-Test 'ServerOnly explicitly reuses the existing server without DSH credentials' {
    $root = New-TestFixture -NoConfig
    $result = & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 -ServerOnly
    Assert-Test ($result.dsh_status -eq 'server-only') 'Bootstrap did not report server-only.'
    Assert-Test ($global:ImStartupHarness.Starts.Count -eq 0 -and $global:ImStartupHarness.CredentialReads -eq 0) 'Bootstrap touched DSH.'
  }
  Invoke-Test 'unsupported Node version is rejected before either server or listener is spawned' {
    $root = New-TestFixture -NoServer
    $versionScript=Join-Path $root 'synthetic-old-node.ps1'
    [IO.File]::WriteAllText($versionScript, '$global:LASTEXITCODE=0; Write-Output "v20.19.0"')
    $global:ImStartupHarness.NodeVersionScript=$versionScript
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 } 'Node.js 24.9'
    Assert-Test ($global:ImStartupHarness.Starts.Count -eq 0 -and !$global:ImStartupHarness.ServerLive) 'Unsupported Node launched a server/listener.'
  }
  Invoke-Test 'bound startup launches one listener and repeated startup reuses both identities' {
    $root = New-TestFixture
    $first = & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991
    $second = & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991
    $s=$global:ImStartupHarness
    Assert-Test ($first.dsh_pid -eq 610002 -and $second.dsh_pid -eq 610002 -and $s.Starts.Count -eq 1) 'Repeated start created another listener.'
    Assert-Test ($s.CredentialReads -eq 1) 'Reused listener unexpectedly reloaded credentials.'
    Assert-Test ($s.Starts[0].Token -eq 'synthetic-startup-secret' -and $s.Starts[0].WindowStyle -eq 'Hidden') 'Child token/visibility was wrong.'
    Assert-Test (($s.Starts[0].Arguments -join ' ') -notmatch 'synthetic-startup-secret') 'Token leaked to arguments.'
    Assert-Test ($env:TEAM_RELAY_BOT_TOKEN -eq 'synthetic-parent-token') 'Parent token was not restored.'
  }
  Invoke-Test 'new server and listener start together while parent environment is restored' {
    $root = New-TestFixture -NoServer
    $result = & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991
    Assert-Test ($result.dsh_status -eq 'listening' -and $global:ImStartupHarness.Starts.Count -eq 2) 'Combined start did not prepare both processes.'
    Assert-Test ($env:IM_DATA_DIR -eq 'synthetic-parent-data' -and $env:TEAM_RELAY_BOT_TOKEN -eq 'synthetic-parent-token') 'Process environment leaked to caller.'
  }
  Invoke-Test 'server PID creation mismatch refuses reuse without launching or stopping' {
    $root = New-TestFixture
    $global:ImStartupHarness.Processes[610001].CreationDate=[DateTime]::UtcNow
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 } 'PID|创建时间'
    Assert-Test ($global:ImStartupHarness.Starts.Count -eq 0 -and $global:ImStartupHarness.Stops.Count -eq 0) 'Mismatched server was mutated.'
  }
  Invoke-Test 'foreign occupied port without owned record refuses startup' {
    $root = New-TestFixture
    [IO.File]::Delete((Join-Path $root 'environment/config/server-process.json'))
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 } '占用'
    Assert-Test ($global:ImStartupHarness.Starts.Count -eq 0) 'Foreign listener was bypassed.'
  }
  Invoke-Test 'runtime nonce mismatch cannot reuse or terminate another listener' {
    $root = New-TestFixture -ExistingDsh
    $runtime=Read-TestJson $global:ImStartupHarness.RuntimePath
    $runtime.instanceId=[Guid]::NewGuid().ToString('D')
    Write-TestJson $global:ImStartupHarness.RuntimePath $runtime
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 } '身份不匹配'
    Assert-Test ($global:ImStartupHarness.Starts.Count -eq 0 -and $global:ImStartupHarness.Stops.Count -eq 0) 'Wrong-nonce listener was mutated.'
  }
  Invoke-Test 'DSH PID creation mismatch fails rather than launching duplicate listener' {
    $root = New-TestFixture -ExistingDsh
    $global:ImStartupHarness.Processes[610002].CreationDate=[DateTime]::UtcNow
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 } 'PID|创建时间'
    Assert-Test ($global:ImStartupHarness.Starts.Count -eq 0) 'Mismatched DSH record was replaced.'
  }
  Invoke-Test 'a live process without ready status times out and preserves server and worker' {
    $root = New-TestFixture
    $global:ImStartupHarness.DshReadyStatus='starting'
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 -ReadyTimeoutSeconds 1 } '超时'
    Assert-Test ($global:ImStartupHarness.Stops.Count -eq 0 -and $global:ImStartupHarness.ServerLive -and $global:ImStartupHarness.DshLive) 'Timeout killed a process.'
  }
  Invoke-Test 'failed readiness cannot be reported as successful startup' {
    $root = New-TestFixture
    $global:ImStartupHarness.DshReadyStatus='failed'
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 } '启动失败'
    Assert-Test ($global:ImStartupHarness.Stops.Count -eq 0) 'Failed startup killed a process.'
  }
  Invoke-Test 'normal stop requests matching listener exit before stopping only the server' {
    $root = New-TestFixture -ExistingDsh
    $global:ImStartupHarness.CompleteOnStop=$true
    & (Join-Path $root 'environment/scripts/stop.ps1') -StopTimeoutSeconds 1
    $s=$global:ImStartupHarness
    Assert-Test ($s.Stops.Count -eq 1 -and $s.Stops[0] -eq 610001 -and !$s.DshLive) 'Stop killed DSH or did not stop the server last.'
    Assert-Test ((Read-TestJson ($s.RuntimePath+'.stop')).instanceId -eq $s.InstanceId) 'Stop request nonce was wrong.'
  }
  Invoke-Test 'busy listener stop timeout never kills worker or stops server' {
    $root = New-TestFixture -ExistingDsh
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/stop.ps1') -StopTimeoutSeconds 1 } '超时'
    Assert-Test ($global:ImStartupHarness.Stops.Count -eq 0 -and $global:ImStartupHarness.ServerLive -and $global:ImStartupHarness.DshLive) 'Busy listener was force-stopped.'
  }
  Invoke-Test 'wrong existing stop nonce is preserved and server remains running' {
    $root = New-TestFixture -ExistingDsh
    $wrong=[Guid]::NewGuid().ToString('D')
    Write-TestJson ($global:ImStartupHarness.RuntimePath+'.stop') @{instanceId=$wrong}
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/stop.ps1') -StopTimeoutSeconds 1 } '标识不符'
    Assert-Test ((Read-TestJson ($global:ImStartupHarness.RuntimePath+'.stop')).instanceId -eq $wrong) 'Foreign stop request was overwritten.'
    Assert-Test ($global:ImStartupHarness.Stops.Count -eq 0) 'Server stopped for foreign stop request.'
  }
  Invoke-Test 'concurrent lifecycle controller lock refuses a competing start' {
    $root = New-TestFixture
    $path=Join-Path $root 'environment/config/runtime-controller-lock.json'
    $owner=[IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try { Assert-TestThrows { & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 } '另一个启动' }
    finally { $owner.Dispose() }
    Assert-Test ($global:ImStartupHarness.Starts.Count -eq 0) 'Competing startup launched a process.'
  }
  Invoke-Test 'configuration outside project config directory is rejected' {
    $root = New-TestFixture
    Assert-TestThrows { & (Join-Path $root 'environment/scripts/start.ps1') -Port 23991 -DshConfigPath (Join-Path $testRoot 'outside.json') } '配置必须'
    Assert-Test ($global:ImStartupHarness.Starts.Count -eq 0) 'Outside configuration launched a process.'
  }
} finally {
  if ($null -eq $savedToken) { Remove-Item Env:TEAM_RELAY_BOT_TOKEN -ErrorAction SilentlyContinue } else { $env:TEAM_RELAY_BOT_TOKEN=$savedToken }
  if ($null -eq $savedData) { Remove-Item Env:IM_DATA_DIR -ErrorAction SilentlyContinue } else { $env:IM_DATA_DIR=$savedData }
  $report=[ordered]@{scope='Isolated orchestration mocks; no real server, process, credentials or model';passed=@($results | Where-Object passed).Count;failed=@($results | Where-Object { !$_.passed }).Count;checks=@($results)}
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReportPath))) | Out-Null
  Write-TestJson $ReportPath $report
  $resolved=[IO.Path]::GetFullPath($testRoot)
  $prefix=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  if (!$resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'relay startup orchestration *') { throw 'Refusing cleanup outside verified test directory.' }
  [IO.Directory]::Delete($resolved,$true)
  Remove-Variable -Name ImStartupHarness -Scope Global -ErrorAction SilentlyContinue
}
if ($report.failed) { throw "Startup orchestration checks failed: $($report.failed); report: $ReportPath" }
Write-Output "Startup orchestration checks passed: $($report.passed); no real processes or model were started."
