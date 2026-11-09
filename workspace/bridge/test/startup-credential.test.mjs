import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Windows startup credentials use real current-user DPAPI and isolated binding/restart', { skip: process.platform !== 'win32' }, async t => {
  const prefix = join(tmpdir(), 'team-relay-credential-');
  const root = await mkdtemp(prefix);
  try {
    await mkdir(join(root, 'workspace', 'bridge'), { recursive: true });
    await mkdir(join(root, 'environment', 'config'), { recursive: true });
    for (const name of ['startup-credential.ps1', 'connect-installed.ps1', 'run-installed.ps1']) {
      await copyFile(join(source, name), join(root, 'workspace', 'bridge', name));
    }
    await mkdir(join(root, 'worker'));
    await execute('git', ['init', '-q', join(root, 'worker')]);
    await writeFile(join(root, 'cli.cmd'), '@echo off\r\nexit /b 0\r\n');
    await writeFile(join(root, 'workspace', 'bridge', 'bridge.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.CREDENTIAL_TEST_RESULT, JSON.stringify({
        matched: process.env.TEAM_RELAY_BOT_TOKEN === process.env.CREDENTIAL_TEST_EXPECTED,
        once: process.argv.includes('--once')
      }));
    `);
    await writeFile(join(root, 'credential-test.ps1'), String.raw`
param([string]$Scenario, [string]$BaseUrl)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$fixture = $PSScriptRoot
$bridge = Join-Path $fixture 'workspace/bridge'
. (Join-Path $bridge 'startup-credential.ps1')
$code = if ($Scenario -eq 'real-http-connect') { $env:CREDENTIAL_TEST_CODE } else { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)) }
$secure = ConvertTo-SecureString -String $code -AsPlainText -Force
$configPath = Join-Path $fixture ('environment/config/' + $Scenario + '.json')
$credentialPath = Join-Path $fixture ('environment/config/' + $Scenario + '.credential.json')
$settings = @{ executor='installed-headless'; tokenEnv='TEAM_RELAY_BOT_TOKEN'; startup=@{enabled=$true;credentialPath=$credentialPath} }
function Write-Settings { [IO.File]::WriteAllText($configPath, ($settings | ConvertTo-Json -Depth 5)) }
function Expect-Failure([scriptblock]$Action) {
  $rejected = $false
  try { & $Action | Out-Null } catch {
    $rejected = $true
    if ($_.Exception.Message.Contains($code)) { throw 'Secret appeared in an error.' }
  }
  if (!$rejected) { throw 'Expected rejection did not occur.' }
}
Remove-Item Env:TEAM_RELAY_BOT_TOKEN -ErrorAction SilentlyContinue
try {
  switch ($Scenario) {
    'roundtrip' {
      Save-ImStartupToken -ConfigPath $configPath -CredentialPath $credentialPath -Token $secure
      Write-Settings
      $result = Get-ImStartupToken -ConfigPath $configPath
      if ($result -cne $code) { throw 'Roundtrip mismatch.' }
      $raw = [IO.File]::ReadAllText($credentialPath)
      if ($raw.Contains($code)) { throw 'Credential was stored in plaintext.' }
      $payload = $raw | ConvertFrom-Json
      if ($payload.version -ne 1 -or $payload.kind -ne 'windows-dpapi-current-user') { throw 'Wrong DPAPI payload schema.' }
    }
    'outside-config' {
      Expect-Failure { Save-ImStartupToken -ConfigPath (Join-Path $fixture 'outside.json') -CredentialPath $credentialPath -Token $secure }
      if (Test-Path -LiteralPath $credentialPath) { throw 'Unexpected credential write.' }
    }
    'outside-credential' {
      Expect-Failure { Save-ImStartupToken -ConfigPath $configPath -CredentialPath (Join-Path $fixture 'outside.json') -Token $secure }
      Write-Settings
      $settings.startup.credentialPath = Join-Path $fixture 'outside.json'
      Write-Settings
      Expect-Failure { Get-ImStartupToken -ConfigPath $configPath }
    }
    'wrong-extension' {
      Expect-Failure { Save-ImStartupToken -ConfigPath ($configPath + '.env') -CredentialPath $credentialPath -Token $secure }
      Expect-Failure { Save-ImStartupToken -ConfigPath $configPath -CredentialPath ($credentialPath + '.env') -Token $secure }
    }
    'same-file' {
      Expect-Failure { Save-ImStartupToken -ConfigPath $configPath -CredentialPath $configPath -Token $secure }
    }
    'disabled' {
      Save-ImStartupToken -ConfigPath $configPath -CredentialPath $credentialPath -Token $secure
      $settings.startup.enabled = $false
      Write-Settings
      Expect-Failure { Get-ImStartupToken -ConfigPath $configPath }
      $settings.startup.enabled = 'true'
      Write-Settings
      Expect-Failure { Get-ImStartupToken -ConfigPath $configPath }
    }
    'corrupt' {
      Write-Settings
      [IO.File]::WriteAllText($credentialPath, (@{version=1;kind='windows-dpapi-current-user';protectedToken=$code} | ConvertTo-Json))
      Expect-Failure { Get-ImStartupToken -ConfigPath $configPath }
    }
    'relative-credential' {
      $settings.startup.credentialPath = 'relative.credential.json'
      Write-Settings
      Expect-Failure { Get-ImStartupToken -ConfigPath $configPath }
    }
    'junction' {
      $target = New-Item -ItemType Directory -Path (Join-Path $fixture 'junction-target')
      $link = Join-Path $fixture 'environment/config/junction-link'
      New-Item -ItemType Junction -Path $link -Target $target.FullName | Out-Null
      Expect-Failure { Save-ImStartupToken -ConfigPath $configPath -CredentialPath (Join-Path $link 'secret.json') -Token $secure }
      if (Test-Path -LiteralPath (Join-Path $target.FullName 'secret.json')) { throw 'Followed a junction.' }
    }
    { $_ -in @('connect','prompt-connect') } {
      function Read-Host {
        if ($Scenario -ne 'prompt-connect') { throw 'Unexpected connection-code prompt.' }
        return (ConvertTo-SecureString -String ('  ' + $code + '  ') -AsPlainText -Force)
      }
      function Invoke-RestMethod {
        param($Uri,$Headers,$Method,$TimeoutSec)
        if ($Headers.Authorization -cne ('Bearer ' + $code)) { throw 'Wrong in-memory token.' }
        switch (([Uri]$Uri).AbsolutePath) {
          '/api/me' { return @{id='bot';username='dsh';is_bot=$true} }
          '/api/conversations' { return @(@{id='group';title='Test';members=@(@{id='bot'},@{id='human'})}) }
          '/api/users' { return @(@{id='human';username='tester';is_bot=$false}) }
          default { throw 'Unexpected route.' }
        }
      }
      if ($Scenario -eq 'connect') { $env:TEAM_RELAY_BOT_TOKEN = $code }
      $bound = & (Join-Path $bridge 'connect-installed.ps1') -Workspace (Join-Path $fixture 'worker') -CliPath (Join-Path $fixture 'cli.cmd') -ConfigPath $configPath -ConversationIds group -SenderIds human -EnableStartup -PassThru -InformationAction SilentlyContinue
      if (!$bound.startup.enabled -or $bound.senderIds.Count -ne 1 -or $bound.conversationIds.Count -ne 1) { throw 'Wrong persisted binding.' }
      if ($Scenario -eq 'connect' -and $env:TEAM_RELAY_BOT_TOKEN -cne $code) { throw 'Parent environment was not restored.' }
      if ($Scenario -eq 'prompt-connect' -and $env:TEAM_RELAY_BOT_TOKEN) { throw 'Prompted code leaked into parent environment.' }
      $recovered = Get-ImStartupToken -ConfigPath $configPath
      if ($recovered -cne $code -or [IO.File]::ReadAllText($configPath).Contains($code)) { throw 'Binding credential mismatch or plaintext leak.' }
    }
    'ephemeral-connect' {
      function Read-Host { throw 'Unexpected connection-code prompt.' }
      function Invoke-RestMethod {
        param($Uri,$Headers,$Method,$TimeoutSec)
        switch (([Uri]$Uri).AbsolutePath) {
          '/api/me' { return @{id='bot';username='dsh';is_bot=$true} }
          '/api/conversations' { return @(@{id='group';title='Test';members=@(@{id='bot'},@{id='human'})}) }
          '/api/users' { return @(@{id='human';username='tester';is_bot=$false}) }
          default { throw 'Unexpected route.' }
        }
      }
      $env:TEAM_RELAY_BOT_TOKEN = $code
      $bound = & (Join-Path $bridge 'connect-installed.ps1') -Workspace (Join-Path $fixture 'worker') -CliPath (Join-Path $fixture 'cli.cmd') -ConfigPath $configPath -ConversationIds group -SenderIds human -PassThru -InformationAction SilentlyContinue
      if ($null -ne $bound.startup) { throw 'Opt-out binding unexpectedly persisted a credential.' }
      if ([IO.File]::ReadAllText($configPath).Contains($code)) { throw 'Ephemeral binding leaked token.' }
    }
    'real-http-connect' {
      function Read-Host { throw 'Unexpected connection-code prompt.' }
      $env:TEAM_RELAY_BOT_TOKEN = $code
      $bound = & (Join-Path $bridge 'connect-installed.ps1') -Workspace (Join-Path $fixture 'worker') -CliPath (Join-Path $fixture 'cli.cmd') -BaseUrl $BaseUrl -ConfigPath $configPath -ConversationIds group -SenderIds @('admin','alice','bob') -EnableStartup -PassThru -InformationAction SilentlyContinue
      if (!$bound.startup.enabled -or $bound.baseUrl -ne $BaseUrl -or $bound.conversationIds.Count -ne 1 -or $bound.conversationIds[0] -ne 'group') { throw 'Wrong real HTTP group binding.' }
      if ($bound.senderIds.Count -ne 3 -or @($bound.senderIds | Sort-Object) -join ',' -ne 'admin,alice,bob') { throw 'Real HTTP JSON users were not individually enumerated.' }
      if ($env:TEAM_RELAY_BOT_TOKEN -cne $code) { throw 'Parent environment was not restored.' }
      $recovered = Get-ImStartupToken -ConfigPath $configPath
      if ($recovered -cne $code -or [IO.File]::ReadAllText($configPath).Contains($code)) { throw 'Real HTTP credential mismatch or plaintext leak.' }
    }
    'restart' {
      Save-ImStartupToken -ConfigPath $configPath -CredentialPath $credentialPath -Token $secure
      Write-Settings
      function Read-Host { throw 'Unexpected restart prompt.' }
      $env:CREDENTIAL_TEST_RESULT = Join-Path $fixture 'restart-result.json'
      $env:CREDENTIAL_TEST_EXPECTED = $code
      & (Join-Path $bridge 'run-installed.ps1') -Config $configPath -Once
      if ($env:TEAM_RELAY_BOT_TOKEN) { throw 'Startup leaked IM token into parent environment.' }
      $result = Get-Content -LiteralPath $env:CREDENTIAL_TEST_RESULT -Raw | ConvertFrom-Json
      if (!$result.matched -or !$result.once) { throw 'Restart failed to pass saved token or arguments.' }
    }
    'environment-priority' {
      $settings.startup.credentialPath = Join-Path $fixture 'environment/config/missing.json'
      Write-Settings
      function Read-Host { throw 'Unexpected environment-token prompt.' }
      $env:TEAM_RELAY_BOT_TOKEN = $code
      $env:CREDENTIAL_TEST_RESULT = Join-Path $fixture 'env-result.json'
      $env:CREDENTIAL_TEST_EXPECTED = $code
      & (Join-Path $bridge 'run-installed.ps1') -Config $configPath -Once
      if ($env:TEAM_RELAY_BOT_TOKEN -cne $code) { throw 'Existing environment token changed.' }
      $result = Get-Content -LiteralPath $env:CREDENTIAL_TEST_RESULT -Raw | ConvertFrom-Json
      if (!$result.matched) { throw 'Environment token was not preferred over missing saved token.' }
    }
    default { throw 'Unknown test scenario.' }
  }
  @{scenario=$Scenario;passed=$true} | ConvertTo-Json -Compress
} finally {
  $secure.Dispose()
  $code = $null
  Remove-Item Env:TEAM_RELAY_BOT_TOKEN -ErrorAction SilentlyContinue
}
`);
    for (const scenario of ['roundtrip', 'outside-config', 'outside-credential', 'wrong-extension', 'same-file', 'disabled', 'corrupt', 'relative-credential', 'junction', 'connect', 'prompt-connect', 'ephemeral-connect', 'restart', 'environment-priority']) {
      await t.test(scenario, async () => {
        const { stdout } = await execute('pwsh', ['-NoProfile', '-File', join(root, 'credential-test.ps1'), '-Scenario', scenario], { timeout: 20000 });
        const line = stdout.trim().split(/\r?\n/).at(-1);
        assert.deepEqual(JSON.parse(line), { scenario, passed: true });
      });
    }
    await t.test('real-http-connect enumerates JSON arrays for one group and three authorized members', async () => {
      const code = randomBytes(24).toString('hex');
      const users = [
        { id: 'admin', username: 'admin', display_name: 'Admin', is_bot: false },
        { id: 'alice', username: 'alice', display_name: 'Alice', is_bot: false },
        { id: 'bob', username: 'bob', display_name: 'Bob', is_bot: false },
        { id: 'bot', username: 'dsh', display_name: 'Assistant', is_bot: true },
      ];
      const routes = [];
      const server = createServer((request, response) => {
        if (request.headers.authorization !== `Bearer ${code}`) {
          response.writeHead(401).end();
          return;
        }
        routes.push(request.url);
        const payload = request.url === '/api/me' ? users.at(-1)
          : request.url === '/api/users' ? users
          : request.url === '/api/conversations' ? [{ id: 'group', title: 'Test group', members: users }]
          : null;
        response.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      });
      await new Promise((resolveReady, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveReady);
      });
      try {
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const { stdout } = await execute('pwsh', ['-NoProfile', '-File', join(root, 'credential-test.ps1'), '-Scenario', 'real-http-connect', '-BaseUrl', baseUrl], {
          timeout: 20000, env: { ...process.env, CREDENTIAL_TEST_CODE: code },
        });
        assert.deepEqual(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)), { scenario: 'real-http-connect', passed: true });
        assert.deepEqual(routes, ['/api/me', '/api/conversations', '/api/users']);
        const binding = JSON.parse(await readFile(join(root, 'environment', 'config', 'real-http-connect.json'), 'utf8'));
        assert.deepEqual(binding.conversationIds, ['group']);
        assert.deepEqual(binding.senderIds, ['admin', 'alice', 'bob']);
        assert.equal(binding.startup.enabled, true);
      } finally {
        server.closeAllConnections();
        await new Promise(resolveClosed => server.close(resolveClosed));
      }
    });
    const config = await readFile(join(root, 'environment', 'config', 'connect.json'), 'utf8');
    assert.equal(JSON.parse(config).startup.enabled, true);
  } finally {
    assert.ok(root.startsWith(prefix), 'Cleanup must stay within the created temporary fixture');
    await rm(root, { recursive: true, force: true });
  }
});
