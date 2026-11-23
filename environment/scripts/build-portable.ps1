[CmdletBinding()]
param(
  [string]$ToolchainWorkspace,
  [string]$NodePath,
  [string]$PythonPath,
  [switch]$VerifyOnly
)
# Keep the historical entry point; all versioned release checks live in one place.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'deliver-windows.ps1') @PSBoundParameters
