[CmdletBinding()]
param(
  [string]$NodePath,
  [string]$PythonPath,
  [string]$ToolchainWorkspace,
  [switch]$VerifyOnly
)
# Build and verify a client-only Windows release. Existing versioned artifacts are never overwritten.
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$workspace = Join-Path $projectRoot 'workspace'
$package = Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid desktop version.' }
if (!$NodePath) { $NodePath = Join-Path $projectRoot 'environment/tools/node-v24.19.0-win-x64/node.exe' }
if (!$PythonPath) { $PythonPath = Join-Path $projectRoot 'environment/venv/Scripts/python.exe' }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$PythonPath = (Resolve-Path -LiteralPath $PythonPath).Path
if ($ToolchainWorkspace) { $ToolchainWorkspace = (Resolve-Path -LiteralPath $ToolchainWorkspace).Path }
$destination = Join-Path $projectRoot ('outputs/desktop-v' + $version)
$executable = Join-Path $destination 'TeamRelay-win32-x64/TeamRelay.exe'
$archive = Join-Path $projectRoot ('outputs/TeamRelay-v' + $version + '-windows-x64.zip')
$checksum = Join-Path $projectRoot ('outputs/SHA256SUMS-v' + $version + '-portable.txt')
$verification = Join-Path $projectRoot ('environment/verification/desktop-artifacts-v' + $version)
$nativeVerification = Join-Path $projectRoot ('environment/verification/desktop-native-v' + $version)
if (!$VerifyOnly) {
  foreach ($path in @($destination, $archive, $checksum)) {
    if (Test-Path -LiteralPath $path) { throw ('Versioned artifact already exists; inspect it with -VerifyOnly or use a new product version: ' + $path) }
  }
  $beforeVersioned = [Environment]::GetEnvironmentVariable('TEAM_RELAY_BUILD_VERSIONED', 'Process')
  $beforeToolchain = [Environment]::GetEnvironmentVariable('TEAM_RELAY_BUILD_TOOLCHAIN', 'Process')
  try {
    $env:TEAM_RELAY_BUILD_VERSIONED = '1'
    if ($ToolchainWorkspace) { $env:TEAM_RELAY_BUILD_TOOLCHAIN = $ToolchainWorkspace }
    & $NodePath (Join-Path $workspace 'desktop/build.cjs')
    if ($LASTEXITCODE) { throw 'Portable build failed.' }
  } finally {
    if ($null -eq $beforeVersioned) { Remove-Item Env:TEAM_RELAY_BUILD_VERSIONED -ErrorAction SilentlyContinue } else { $env:TEAM_RELAY_BUILD_VERSIONED = $beforeVersioned }
    if ($null -eq $beforeToolchain) { Remove-Item Env:TEAM_RELAY_BUILD_TOOLCHAIN -ErrorAction SilentlyContinue } else { $env:TEAM_RELAY_BUILD_TOOLCHAIN = $beforeToolchain }
  }
}

& $NodePath (Join-Path $PSScriptRoot 'verify-desktop-asar.mjs')
if ($LASTEXITCODE) { throw 'Packaged source/ASAR allowlist verification failed.' }
$metadata = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
if ($metadata.ProductVersion -ne $version -or $metadata.ProductName -ne '同频TeamPlay' -or $metadata.FileDescription -ne '同频TeamPlay 小团队私有 IM') {
  throw 'Windows executable product metadata differs from the source version/name.'
}
$pe = [IO.File]::OpenRead($executable)
try {
  $reader = [IO.BinaryReader]::new($pe)
  if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'Missing MZ executable signature.' }
  $pe.Position = 0x3C; $pe.Position = $reader.ReadUInt32()
  if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Expected a Windows x64 PE executable.' }
} finally { $pe.Dispose() }
New-Item -ItemType Directory -Path $verification -Force | Out-Null
$peReport = [ordered]@{ status = 'passed'; version = $version; architecture = 'win32-x64'; productName = $metadata.ProductName; productVersion = $metadata.ProductVersion; executableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() }
[IO.File]::WriteAllText((Join-Path $verification 'pe-report.json'), ($peReport | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
if (!$VerifyOnly) {
  Compress-Archive -LiteralPath @((Join-Path $destination 'TeamRelay-win32-x64'), (Join-Path $destination 'WINDOWS-README.txt')) -DestinationPath $archive -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($checksum, ($hash + '  ' + [IO.Path]::GetFileName($archive) + "`n"), [Text.UTF8Encoding]::new($false))
}
& $PythonPath (Join-Path $PSScriptRoot 'verify-desktop-zip.py') --archive $archive --checksum $checksum
if ($LASTEXITCODE) { throw 'Portable ZIP CRC/manifest/file-hash verification failed.' }
& $PythonPath (Join-Path $PSScriptRoot 'verify-desktop-native.py') --exe $executable --output-dir $nativeVerification --node $NodePath
if ($LASTEXITCODE) { throw 'Real packaged Electron verification failed; preserve evidence and fix before delivery.' }
$nativeReport = Get-Content -LiteralPath (Join-Path $nativeVerification 'native-report.json') -Raw | ConvertFrom-Json
if ($nativeReport.status -ne 'passed') { throw 'Native desktop report did not confirm completion.' }
$receipt = [ordered]@{
  status = 'passed'; version = $version; scope = 'Windows x64 client only; IM server and native Agents run separately.'
  executable = $executable; archive = $archive; checksum = $checksum
  bytes = (Get-Item -LiteralPath $archive).Length
  sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  checks = @('ASAR exact allowlist and source bytes', 'PE x64 and product metadata', 'ZIP CRC, full manifest and every file hash', 'Packaged Electron against isolated IM, native tray, messaging and report download')
  nativeChecks = $nativeReport.checks.Count
}
[IO.File]::WriteAllText((Join-Path $verification 'delivery-report.json'), ($receipt | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 4
