[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'startup-credential.ps1')
# Captured privately by the controller process. Never invoke this helper in a
# terminal or redirect its output into logs; it is not an interactive command.
$credential = Get-ImStartupToken -ConfigPath $ConfigPath
if (!$credential -or $credential -match '\s') { throw 'Stored assistant binding is unavailable.' }
[Console]::Write($credential)
$credential = $null
