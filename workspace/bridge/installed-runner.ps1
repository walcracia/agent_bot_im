[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Workspace,
    [Parameter(Mandatory)][string]$CliPath,
    [Parameter(Mandatory)][string]$RunDirectory,
    [string]$TaskFile,
    [string]$SessionId,
    [string]$ExtraPatchesJson = '[]',
    [ValidateSet('stored', 'environment')][string]$Auth = 'stored',
    [ValidateSet('read-only', 'workspace-write', 'danger-full-access')][string]$PermissionMode = 'danger-full-access',
    [switch]$VersionOnly
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
$workspacePath = (Resolve-Path -LiteralPath $Workspace).ProviderPath
$commandPath = (Resolve-Path -LiteralPath $CliPath).ProviderPath
$runPath = (Resolve-Path -LiteralPath $RunDirectory).ProviderPath
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw 'Workspace must be an existing directory.' }
if (-not (Test-Path -LiteralPath $commandPath -PathType Leaf)) { throw 'CLI must be an existing file.' }
if ($SessionId -and $SessionId -notmatch '^session-[A-Za-z0-9_-]+$') { throw 'Invalid native session ID.' }
$utf8 = [Text.UTF8Encoding]::new($false)
$paths = @{}
foreach ($name in @('run.json', 'events.jsonl', 'stderr.log', 'result.json', 'answer.txt')) {
    $paths[$name] = Join-Path $runPath $name
    if (Test-Path -LiteralPath $paths[$name]) { throw 'Choose a fresh run directory; existing results are preserved.' }
}
$savedEncoding = $OutputEncoding
$savedConsoleEncoding = [Console]::OutputEncoding
$savedBotToken = $env:TEAM_RELAY_BOT_TOKEN
try {
    Remove-Item Env:\TEAM_RELAY_BOT_TOKEN -ErrorAction SilentlyContinue
    $OutputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    Push-Location -LiteralPath $workspacePath
    try {
        if ($VersionOnly) {
            $version = (& $commandPath --version 2> $paths['stderr.log'] | Out-String).Trim()
            $nativeCode = $LASTEXITCODE
            $summary = @{ completed = ($nativeCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($version)); version = $version; nativeExitCode = $nativeCode }
            [IO.File]::WriteAllText($paths['result.json'], ($summary | ConvertTo-Json), $utf8)
            if (-not $summary.completed) { exit 1 }
            exit 0
        }
        $taskPath = (Resolve-Path -LiteralPath $TaskFile).ProviderPath
        $taskText = [IO.File]::ReadAllText($taskPath, [Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($taskText)) { throw 'Task file is empty.' }
        $cliArguments = @()
        if ($Auth -eq 'stored') { $cliArguments += @('--patch', (Join-Path $PSScriptRoot 'saved-auth.patch.yml')) }
        $extraPatches = $ExtraPatchesJson | ConvertFrom-Json -NoEnumerate
        if ($extraPatches -isnot [array]) { throw 'Extra patches must be a JSON array.' }
        foreach ($patch in $extraPatches) { $cliArguments += @('--patch', (Resolve-Path -LiteralPath $patch).ProviderPath) }
        $cliArguments += @('--profile', 'headless', '--json', '--permission-mode', $PermissionMode, '--approval-policy', 'never')
        if ($SessionId) { $cliArguments += @('--session-id', $SessionId) }
        $cliArguments += '-'
        $metadata = [ordered]@{ workspace = $workspacePath; requestedSessionId = $SessionId; auth = $Auth; permissionMode = $PermissionMode; supervisorPid = $PID; startedUtc = [DateTime]::UtcNow.ToString('o'); status = 'running' }
        [IO.File]::WriteAllText($paths['run.json'], ($metadata | ConvertTo-Json), $utf8)
        $nativeExitCode = $null
        $launchError = $null
        try { $taskText | & $commandPath @cliArguments 1> $paths['events.jsonl'] 2> $paths['stderr.log']; $nativeExitCode = $LASTEXITCODE }
        catch { $launchError = 'Unable to launch the configured Harness CLI.' }
    } finally { Pop-Location }
} finally {
    $OutputEncoding = $savedEncoding
    [Console]::OutputEncoding = $savedConsoleEncoding
    if ($null -eq $savedBotToken) { Remove-Item Env:\TEAM_RELAY_BOT_TOKEN -ErrorAction SilentlyContinue }
    else { $env:TEAM_RELAY_BOT_TOKEN = $savedBotToken }
}
$session = $null
$final = $null
$eventError = $false
$parseError = $false
$eventCount = 0
if (Test-Path -LiteralPath $paths['events.jsonl']) {
    foreach ($line in [IO.File]::ReadLines($paths['events.jsonl'], [Text.Encoding]::UTF8)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $event = $line | ConvertFrom-Json -Depth 100 -ErrorAction Stop }
        catch { $parseError = $true; break }
        if ($event -isnot [Management.Automation.PSCustomObject] -or [string]::IsNullOrWhiteSpace([string]$event.type)) { $parseError = $true; break }
        if ($eventCount -eq 0 -and $event.type -ne 'session') { $parseError = $true; break }
        if ($final) { $parseError = $true; break }
        $eventCount++
        if ($event.type -eq 'session') {
            if ($session) { $parseError = $true; break }
            $session = $event
        } elseif ($event.type -eq 'final') { $final = $event }
        elseif ($event.type -eq 'error') { $eventError = $true }
    }
}
$resolvedSessionId = if ($session.sessionId) { [string]$session.sessionId } else { $SessionId }
$reason = if ($final.reason.kind) { [string]$final.reason.kind } else { $null }
$completed = (-not $launchError -and -not $parseError -and -not $eventError -and $session.sessionId -match '^session-[A-Za-z0-9_-]+$' -and $final -and $nativeExitCode -eq 0 -and $reason -eq 'completed' -and $final.sessionId -eq $session.sessionId -and (-not $SessionId -or $SessionId -eq $session.sessionId) -and $final.text -is [string])
$answer = if ($final.text -is [string]) { $final.text } else { '' }
[IO.File]::WriteAllText($paths['answer.txt'], $answer, $utf8)
$metadata.status = if ($completed) { 'completed' } else { 'failed' }
$metadata['sessionId'] = $resolvedSessionId
$metadata['finishedUtc'] = [DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($paths['run.json'], ($metadata | ConvertTo-Json), $utf8)
$summary = [ordered]@{ completed = [bool]$completed; sessionId = $resolvedSessionId; nativeExitCode = $nativeExitCode; finalReason = $reason; workspace = $workspacePath; eventCount = $eventCount }
[IO.File]::WriteAllText($paths['result.json'], ($summary | ConvertTo-Json), $utf8)
if ($completed) { exit 0 }
exit 1
