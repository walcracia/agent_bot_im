param([string]$SevenZip = 'C:\Program Files\7-Zip\7z.exe', [switch]$CheckoutSource)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$toolDirectory = Join-Path $projectRoot 'environment\tools\dsh'
New-Item -ItemType Directory -Force $toolDirectory | Out-Null
$installer = Join-Path $toolDirectory 'dsh-official-0.2.2-rc.1.exe'
$expectedInstallerHash = '830947F8996DC05D991CA9133FFF4D3400073E47B9CFA6507754867E79482B23'
if (-not (Test-Path -LiteralPath $installer)) {
  Invoke-WebRequest -Uri 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe' -OutFile $installer
}
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expectedInstallerHash) {
  throw 'Official latest download no longer matches pinned 0.2.2-rc.1. Review upstream version before updating the pin.'
}
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Hangzhou DeepSeek Artificial Intelligence*') {
  throw 'Official installer Authenticode verification failed.'
}
if (-not (Test-Path -LiteralPath $SevenZip)) { throw '7-Zip is required to extract the signed payload without running its installer.' }
$extractDirectory = Join-Path $toolDirectory 'extract'
$desktopDirectory = Join-Path $toolDirectory 'desktop'
if (-not (Test-Path -LiteralPath (Join-Path $desktopDirectory 'DeepSeek Harness.exe'))) {
  & $SevenZip x "-o$extractDirectory" '-y' $installer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'NSIS extraction failed.' }
  & $SevenZip x "-o$desktopDirectory" '-y' (Join-Path $extractDirectory '$PLUGINSDIR\app-64.7z') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Desktop payload extraction failed.' }
}
$sdkArchive = Join-Path $toolDirectory 'deepseek-ai-dsh-sdk-client-0.2.2-rc.1.tgz'
if (-not (Test-Path -LiteralPath $sdkArchive)) {
  Invoke-WebRequest -Uri 'https://registry.npmjs.org/@deepseek-ai/dsh-sdk-client/-/dsh-sdk-client-0.2.2-rc.1.tgz' -OutFile $sdkArchive
}
$hashAlgorithm = [System.Security.Cryptography.SHA512]::Create()
try { $actualSdkHash = [Convert]::ToBase64String($hashAlgorithm.ComputeHash([System.IO.File]::ReadAllBytes($sdkArchive))) }
finally { $hashAlgorithm.Dispose() }
if ($actualSdkHash -ne 'Wvpq8qKnNefXG7aPTQgH5GqPkdAV3ReAzm5cS2cvFMM7EwagDjxdbJE7v1T6KEKJfiLkgf1m/F6KBYWCU073Rg==') {
  throw 'SDK tarball integrity mismatch.'
}
$sdkDirectory = Join-Path $toolDirectory 'sdk-client'
New-Item -ItemType Directory -Force $sdkDirectory | Out-Null
tar -xzf $sdkArchive -C $sdkDirectory
if ($LASTEXITCODE -ne 0) { throw 'SDK extraction failed.' }
if ($CheckoutSource) {
  $sourceDirectory = Join-Path $toolDirectory 'source'
  $expectedCommit = 'fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159'
  if (-not (Test-Path -LiteralPath $sourceDirectory)) {
    git init $sourceDirectory | Out-Null
    git -C $sourceDirectory remote add origin 'https://github.com/deepseek-ai/deepseek-harness.git'
    git -C $sourceDirectory fetch --depth 1 origin $expectedCommit
    if ($LASTEXITCODE -ne 0) { throw 'Source fetch failed.' }
    git -C $sourceDirectory checkout --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Source checkout failed.' }
  }
  $actualCommit = git -C $sourceDirectory rev-parse HEAD
  if ($actualCommit -ne $expectedCommit) { throw 'Existing source has another revision; preserving it for operator review.' }
}
$localConfig = Join-Path $PSScriptRoot 'config.local.json'
if (-not (Test-Path -LiteralPath $localConfig)) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.example.json') -Destination $localConfig }
Write-Output 'Official signed Desktop and original SDK deployed under environment/tools/dsh. No installer, PATH or default Harness home changes.'
& (Join-Path $PSScriptRoot 'run-desktop.ps1') -Config $localConfig -Handshake
