[CmdletBinding()]
param([string]$ToolchainWorkspace)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$workspace = Join-Path $projectRoot 'workspace'
$package = Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid portable version.' }
if ($ToolchainWorkspace) { $ToolchainWorkspace = (Resolve-Path -LiteralPath $ToolchainWorkspace).Path }
$beforeVersioned = [Environment]::GetEnvironmentVariable('TEAM_RELAY_BUILD_VERSIONED','Process')
$beforeToolchain = [Environment]::GetEnvironmentVariable('TEAM_RELAY_BUILD_TOOLCHAIN','Process')
try {
  $env:TEAM_RELAY_BUILD_VERSIONED = '1'
  if ($ToolchainWorkspace) { $env:TEAM_RELAY_BUILD_TOOLCHAIN = $ToolchainWorkspace }
  & node (Join-Path $workspace 'desktop/build.cjs')
  if ($LASTEXITCODE) { throw 'Portable build failed.' }
  $destination = Join-Path $projectRoot ('outputs/desktop-v' + $package.version)
  $archive = Join-Path $projectRoot 'outputs/TeamRelay-portable.zip'
  if (Test-Path -LiteralPath $archive) { throw 'Portable archive already exists; inspect the prior build instead of overwriting it.' }
  Compress-Archive -LiteralPath @((Join-Path $destination 'TeamRelay-win32-x64'),(Join-Path $destination 'WINDOWS-README.txt')) -DestinationPath $archive -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path $projectRoot 'outputs/SHA256SUMS-portable.txt'),$hash+'  TeamRelay-portable.zip'+"`n",[Text.UTF8Encoding]::new($false))
  Write-Output ('Built portable version ' + $package.version + ' SHA256 ' + $hash)
} finally {
  if ($null -eq $beforeVersioned) { Remove-Item Env:TEAM_RELAY_BUILD_VERSIONED -ErrorAction SilentlyContinue } else { $env:TEAM_RELAY_BUILD_VERSIONED = $beforeVersioned }
  if ($null -eq $beforeToolchain) { Remove-Item Env:TEAM_RELAY_BUILD_TOOLCHAIN -ErrorAction SilentlyContinue } else { $env:TEAM_RELAY_BUILD_TOOLCHAIN = $beforeToolchain }
}
