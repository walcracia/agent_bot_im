import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile), bridgePath = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const person = { id: 'human-service', username: 'alice', is_bot: false }, bot = { id: 'bot-service', username: 'dsh', is_bot: true };
const windows = { skip: process.platform !== 'win32' ? 'Actual installed-runner fixture requires Windows PowerShell.' : false, timeout: 65000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (cause) { if (cause.code === 'ESRCH') return false; throw cause; } };
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; } }
async function waitFor(check, message, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(35); }
  throw new Error(message);
}
async function freePort() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-super-service-')), repository = join(root, 'repository');
  await mkdir(repository);
  const git = args => exec('git', ['-C', repository, ...args], { windowsHide: true });
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Synthetic Service']); await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(repository, 'source.txt'), 'synthetic source'); await git(['add', '--', 'source.txt']); await git(['commit', '-m', 'fixture']);
  const audit = join(root, 'audit'); await mkdir(audit);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const cli = join(root, 'synthetic service cli.ps1');
  await writeFile(cli, String.raw`
$ErrorActionPreference = 'Stop'
$audit = ${quote(audit)}
if ($args -contains '--version') { $global:LASTEXITCODE = 0; Write-Output 'synthetic-service-cli 0.3.0'; return }
$prompt = $input | Out-String
$session = 'session-service-' + [Guid]::NewGuid().ToString('N')
$resume = [Array]::IndexOf($args, '--session-id'); if ($resume -ge 0) { $session = $args[$resume + 1] }
$permission = $args[[Array]::IndexOf($args, '--permission-mode') + 1]
$payload = ($prompt.Trim() -split '\r?\n')[-1] | ConvertFrom-Json -Depth 100
$kind = if ($permission -ne 'read-only') { 'worker' } elseif ($payload.events) { 'router' } else { 'watchdog' }
$record = @{kind=$kind;pid=$PID;permission=$permission;session=$session;botTokenSeen=[bool](Test-Path Env:\TEAM_RELAY_BOT_TOKEN);controlTokenSeen=[bool](Test-Path Env:\SUPER_AGENT_CONTROL_TOKEN)}
[IO.File]::WriteAllText((Join-Path $audit ($kind + '-' + $session + '.json')), ($record | ConvertTo-Json -Compress))
@{type='session';sessionId=$session} | ConvertTo-Json -Compress
if ($kind -eq 'router') {
  $decisions = @($payload.events | ForEach-Object { @{eventId=$_.id;action='new';taskId=$null;summary=('Synthetic task ' + $_.id);instructions=$_.text} })
  $answer = ConvertTo-Json -InputObject $decisions -Depth 6 -Compress
} elseif ($kind -eq 'watchdog') {
  $answer = @{taskId=$payload.id;action='observe';reason='Synthetic independent observer sees the active fixture.';instruction=''} | ConvertTo-Json -Compress
} else {
  [IO.File]::WriteAllText((Join-Path (Get-Location).Path 'worker-live.json'), ($record | ConvertTo-Json -Compress))
  Start-Sleep -Seconds 25
  $answer = 'Synthetic work finished'
}
@{type='final';sessionId=$session;reason=@{kind='completed'};text=$answer} | ConvertTo-Json -Depth 6 -Compress
$global:LASTEXITCODE = 0
`);
  const events = [], replies = [], requests = [];
  const im = createServer(async (request, response) => {
    try {
      const address = new URL(request.url, 'http://localhost'); requests.push(address.pathname);
      if (request.headers.authorization !== 'Bearer synthetic-service-im-only') { response.writeHead(401); response.end('{}'); return; }
      let result;
      if (address.pathname === '/api/me') result = bot;
      else if (address.pathname === '/api/conversations') result = [{ id: 'c1', title: 'Synthetic service group', members: [bot, person], last_message: events.at(-1) ?? null }];
      else if (address.pathname === '/api/agent/events') result = { events: events.filter(item => item.id > Number(address.searchParams.get('after'))) };
      else if (address.pathname === '/api/conversations/c1/messages' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        const message = JSON.parse(body); if (!replies.some(item => item.client_id === message.client_id)) replies.push(message);
        result = { id: 1000 + replies.length };
      } else { response.writeHead(404); response.end('{}'); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } catch { response.writeHead(500); response.end('{}'); }
  });
  await new Promise(done => im.listen(0, '127.0.0.1', done));
  const legacy = join(root, 'legacy-state.json'), statePath = join(root, 'super-state/state.json'), runtimePath = join(root, 'runtime.json');
  const legacyBytes = JSON.stringify({ version: 1, identity: 'historical-local-state', cursor: 41, current: null, sessions: { historical: 'preserved-session' } });
  await writeFile(legacy, legacyBytes);
  const controlPort = await freePort(), configPath = join(root, 'config.json'), instanceId = randomUUID(), secret = 'synthetic-control-' + 'z'.repeat(40);
  const config = { executor: 'installed-headless', triggerMode: 'auto', baseUrl: 'http://127.0.0.1:' + im.address().port,
    tokenEnv: 'TEAM_RELAY_BOT_TOKEN', botUsername: bot.username, conversationIds: ['c1'], senderIds: [person.id], pollMilliseconds: 250, statePath: legacy,
    harness: { cwd: repository, cliPath: cli, auth: 'environment', powershellPath: process.env.TEAM_RELAY_TEST_POWERSHELL ?? 'pwsh',
      runsPath: join(root, 'legacy-runs'), sessionMapPath: join(root, 'legacy-sessions.json'), permissionMode: 'workspace-write', runTimeoutMs: 40000, classificationTimeoutMs: 10000 },
    superAgent: { enabled: true, projectId: 'fixture', repositoryPath: repository, statePath, worktreesPath: join(root, 'worktrees'), runsPath: join(root, 'runs'),
      sessionMapsPath: join(root, 'sessions'), maxWorkers: 2, controlHost: '127.0.0.1', controlPort,
      watchdog: { enabled: true, intervalMs: 250, taskAgeMs: 500, cooldownMs: 60000, maxAssessmentsPerTick: 1, requestTimeoutMs: 5000 }, github: { enabled: false } } };
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [bridgePath, '--config', configPath, '--runtime-file', runtimePath, '--instance-id', instanceId],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEAM_RELAY_BOT_TOKEN: 'synthetic-service-im-only', SUPER_AGENT_CONTROL_TOKEN: secret } });
  let output = '', failed = false;
  child.stdout.setEncoding('utf8').on('data', part => { output += part; }); child.stderr.setEncoding('utf8').on('data', part => { output += part; });
  const exited = new Promise((done, no) => { child.once('error', no); child.once('exit', (code, signal) => done({ code, signal })); });
  const stop = async nonce => {
    await writeFile(runtimePath + '.stop', JSON.stringify({ instanceId: nonce ?? instanceId }));
    if (nonce && nonce !== instanceId) return;
    const result = await Promise.race([exited, delay(20000, undefined, { ref: false }).then(() => { throw new Error('Owned Super-agent did not stop: ' + output.slice(-4000)); })]);
    assert.equal(result.code, 0, output); return result;
  };
  const diagnostics = async () => {
    await writeFile(join(root, 'service-diagnostics.json'), JSON.stringify({ output, runtime: await json(runtimePath), state: await json(statePath), requests, replies }, null, 2));
  };
  t.after(async () => {
    try { if (child.exitCode === null && child.signalCode === null) await stop(); }
    catch {
      failed = true; await diagnostics();
      // This exact child was spawned by this fixture; do not scan or kill unrelated Node processes.
      if (child.exitCode === null && child.signalCode === null) await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      await Promise.race([exited, delay(3000, undefined, { ref: false })]);
    }
    im.closeAllConnections(); await new Promise(done => im.close(done));
    if (failed) { await diagnostics(); t.diagnostic('Preserved synthetic service evidence: ' + root); }
    else {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true });
    }
  });
  const guarded = async action => { try { return await action(); } catch (cause) { failed = true; await diagnostics(); cause.message += '\nFixture: ' + root + '\n' + output.slice(-4000); throw cause; } };
  const ready = () => guarded(() => waitFor(async () => {
    const status = await json(runtimePath);
    if (status?.status === 'failed' || child.exitCode !== null) throw new Error('Super-agent failed before ready');
    return status?.status === 'listening' ? status : null;
  }, 'Super-agent never became ready'));
  const push = text => { const item = { id: events.length + 1, text, sender: person, conversation_id: 'c1', created_at: new Date().toISOString(), attachment: null }; events.push(item); return item; };
  const records = async () => Promise.all((await readdir(audit)).map(name => json(join(audit, name))));
  return { root, statePath, runtimePath, legacy, legacyBytes, controlPort, secret, child, output: () => output, events, replies, push, ready, stop, guarded, records };
}

test('actual Super-agent entry waits for an independent Watchdog, rejects unauthenticated control and stops by managed nonce', windows, async t => {
  const f = await fixture(t);
  await f.guarded(async () => {
    const runtime = await f.ready();
    assert.equal(runtime.mode, 'super-agent'); assert.notEqual(runtime.watchdogPid, runtime.pid); assert.ok(alive(runtime.watchdogPid));
    const owner = await json(join(f.root, 'super-state/watchdog-state.json.runtime.json'));
    assert.equal(owner.pid, runtime.watchdogPid); assert.ok(!['failed', 'stopped', 'starting'].includes(owner.status), JSON.stringify(owner));
    const forbidden = await fetch(`http://127.0.0.1:${f.controlPort}/api/supervisor/snapshot`); assert.equal(forbidden.status, 403);
    const allowed = await fetch(`http://127.0.0.1:${f.controlPort}/api/supervisor/snapshot`, { headers: { Authorization: 'Bearer ' + f.secret } }); assert.equal(allowed.status, 200);
    await f.stop(randomUUID()); await delay(350); assert.equal(f.child.exitCode, null, 'A stale nonce stopped the current controller');
    await f.stop();
    assert.equal((await json(f.runtimePath)).status, 'stopped');
    assert.ok(!alive(runtime.watchdogPid), 'Independent Watchdog survived normal managed shutdown');
    assert.equal(await readFile(f.legacy, 'utf8'), f.legacyBytes);
    assert.equal((await f.records()).length, 0, 'Idle startup made a fake model invocation');
  });
});

test('actual classifier starts two independent workers while status and cancellation remain responsive; shutdown reaps all owners', windows, async t => {
  const f = await fixture(t);
  await f.guarded(async () => {
    const runtime = await f.ready();
    f.push('Fix independent synthetic feature A'); f.push('Fix independent synthetic feature B');
    const workers = await waitFor(async () => {
      const one = await json(join(f.root, 'worktrees/T000001/worker-live.json')), two = await json(join(f.root, 'worktrees/T000002/worker-live.json'));
      return one && two ? [one, two] : null;
    }, 'Real classified tasks did not launch two workers: ' + f.output());
    assert.notEqual(workers[0].pid, workers[1].pid); assert.ok(workers.every(item => alive(item.pid)));
    const requested = Date.now(); f.push('任务列表');
    await waitFor(() => f.replies.some(reply => /#T000001/.test(reply.text) && /#T000002/.test(reply.text)), 'Status was blocked behind the running workers', 6000);
    assert.ok(Date.now() - requested < 6000);
    f.push('取消任务 #T000001');
    await waitFor(async () => (await json(f.statePath))?.superAgent.tasks.T000001.status === 'cancelled', 'Task control did not stop its worker', 10000);
    assert.ok(!alive(workers[0].pid)); assert.ok(alive(workers[1].pid), 'Stopping one task stopped its sibling');
    await waitFor(async () => (await f.records()).some(item => item.kind === 'watchdog'), 'Independent semantic observer did not run', 10000);
    const calls = await f.records();
    assert.ok(calls.some(item => item.kind === 'router')); assert.ok(calls.some(item => item.kind === 'watchdog'));
    assert.ok(calls.every(item => !item.botTokenSeen && !item.controlTokenSeen), 'A DSH invocation inherited a control credential');
    const readOnly = calls.filter(item => item.kind !== 'worker'); assert.ok(readOnly.every(item => item.permission === 'read-only'));
    assert.ok(new Set(readOnly.map(item => item.session)).size >= 2);
    await f.stop();
    assert.ok(workers.every(item => !alive(item.pid)), 'An owned worker survived managed shutdown');
    assert.ok(!alive(runtime.watchdogPid)); assert.equal(await readFile(f.legacy, 'utf8'), f.legacyBytes);
    assert.equal((await json(f.runtimePath)).status, 'stopped');
  });
});

test('independent Watchdog recovers an idle crashed controller, reuses its owner and refreshes actual managed CIM registration', { ...windows, timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-super-crash-service-'));
  const fixtureBridge = join(root, 'workspace/bridge'), configDirectory = join(root, 'environment/config');
  const instanceId = randomUUID(), runtimePath = join(root, 'environment/data/startup', instanceId + '.json');
  const statePath = join(root, 'environment/data/super/state.json'), ownerPath = join(root, 'environment/data/super/watchdog-state.json.runtime.json');
  const configPath = join(configDirectory, 'bridge-installed.local.json'), recordPath = join(configDirectory, 'dsh-process.json');
  const fixtureEntry = join(fixtureBridge, 'bridge.mjs'), secret = 'synthetic-crash-control-' + 'q'.repeat(40);
  let im, child, childExited, failed = false, output = '', originalWatchdog;
  const ownedControllers = new Set();
  const cim = async pid => {
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if(!$p){[Console]::Write('null');exit 0}; @{pid=[int]$p.ProcessId;executable=$p.ExecutablePath;creation_ticks=[string]$p.CreationDate.Ticks;commandLine=$p.CommandLine}|ConvertTo-Json -Compress`;
    const result = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 });
    return JSON.parse(result.stdout);
  };
  const ownedProcess = async pid => {
    const info = await cim(pid);
    return info?.commandLine?.includes(root) && info.commandLine.includes(configPath) && info.commandLine.includes(fixtureEntry) ? info : null;
  };
  const evidence = async () => {
    await writeFile(join(root, 'crash-diagnostics.json'), JSON.stringify({ output, runtime: await json(runtimePath), state: await json(statePath),
      watchdog: await json(ownerPath), watchdogState: await json(join(root, 'environment/data/super/watchdog-state.json')), registration: await json(recordPath) }, null, 2));
  };
  // Cleanup exists before copying/launching, and all process operations are tied to this unique layout.
  t.after(async () => {
    try {
      const runtime = await json(runtimePath);
      if (runtime?.pid && await ownedProcess(runtime.pid)) ownedControllers.add(runtime.pid);
      await mkdir(join(root, 'environment/data/startup'), { recursive: true });
      await writeFile(runtimePath + '.stop', JSON.stringify({ instanceId }));
      const owner = await json(ownerPath);
      if (owner?.pid && owner?.nonce && owner.statePath === join(root, 'environment/data/super/watchdog-state.json')) {
        await writeFile(ownerPath + '.stop', JSON.stringify({ pid: owner.pid, nonce: owner.nonce }));
      }
      await waitFor(() => [...ownedControllers].every(pid => !alive(pid)) && (!owner?.pid || !alive(owner.pid)), 'Crash fixture did not stop normally', 12000);
    } catch {
      failed = true;
      // Stop only verified fixture controllers, never a process merely named node.exe.
      for (const pid of ownedControllers) if (await ownedProcess(pid)) await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      const owner = await json(ownerPath);
      if (owner?.pid && alive(owner.pid)) {
        const info = await cim(owner.pid);
        if (info?.commandLine?.includes(root) && info.commandLine.includes(join(fixtureBridge, 'super-watchdog.mjs')))
          await exec('taskkill.exe', ['/PID', String(owner.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      }
    }
    if (im) { im.closeAllConnections(); await new Promise(done => im.close(done)); }
    if (child && child.exitCode === null && child.signalCode === null && await ownedProcess(child.pid)) {
      child.kill('SIGKILL'); await childExited;
    }
    if (failed) { await evidence(); t.diagnostic('Preserved crash-recovery fixture: ' + root); }
    else { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); }
  });
  try {
    await mkdir(fixtureBridge, { recursive: true }); await mkdir(configDirectory, { recursive: true });
    await mkdir(join(root, 'environment/scripts'), { recursive: true }); await mkdir(join(root, 'environment/data/startup'), { recursive: true });
    const sourceBridge = fileURLToPath(new URL('..', import.meta.url));
    for (const entry of await readdir(sourceBridge, { withFileTypes: true })) if (entry.isFile() && /\.(?:mjs|ps1|yml)$/u.test(entry.name))
      await copyFile(join(sourceBridge, entry.name), join(fixtureBridge, entry.name));
    await copyFile(fileURLToPath(new URL('../../../environment/scripts/runtime-processes.ps1', import.meta.url)), join(root, 'environment/scripts/runtime-processes.ps1'));
    const repository = join(root, 'repository'); await mkdir(repository);
    const git = args => exec('git', ['-C', repository, ...args], { windowsHide: true });
    await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Synthetic Recovery']); await git(['config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repository, 'source.txt'), 'synthetic committed source'); await git(['add', '--', 'source.txt']); await git(['commit', '-m', 'fixture']);
    const audit = join(root, 'probe-audit'); await mkdir(audit);
    const cliPath = join(root, 'synthetic zero-model cli.ps1'), quotedAudit = "'" + audit.replaceAll("'", "''") + "'";
    await writeFile(cliPath, String.raw`
if ($args -contains '--version') {
  @{pid=$PID;im=[bool](Test-Path Env:\TEAM_RELAY_BOT_TOKEN);control=[bool](Test-Path Env:\SUPER_AGENT_CONTROL_TOKEN);bundle=[bool](Test-Path Env:\SUPER_AGENT_RESTART_TOKEN_BUNDLE)} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path ${quotedAudit} ([Guid]::NewGuid().ToString('N') + '.json'))
  $global:LASTEXITCODE=0;Write-Output 'synthetic-recovery-cli 0.3.0';return
}
throw 'Crash recovery must not invoke a model.'
`);
    im = createServer((request, response) => {
      if (request.headers.authorization !== 'Bearer synthetic-recovery-im-only') { response.writeHead(401); response.end('{}'); return; }
      const route = new URL(request.url, 'http://localhost').pathname;
      const data = route === '/api/me' ? bot : route === '/api/conversations' ? [{ id: 'c1', members: [bot, person], last_message: null }]
        : route === '/api/agent/events' ? { events: [] } : null;
      response.setHeader('Content-Type', 'application/json'); response.writeHead(data === null ? 404 : 200); response.end(JSON.stringify(data ?? {}));
    });
    await new Promise(done => im.listen(0, '127.0.0.1', done));
    const port = await freePort(), legacy = join(root, 'environment/data/legacy-state.json');
    const legacyBytes = '{"version":1,"cursor":21,"current":null,"syntheticEvidence":"retain"}'; await writeFile(legacy, legacyBytes);
    const config = { executor: 'installed-headless', triggerMode: 'auto', tokenEnv: 'TEAM_RELAY_BOT_TOKEN', baseUrl: 'http://127.0.0.1:' + im.address().port,
      botUsername: 'dsh', conversationIds: ['c1'], senderIds: [person.id], pollMilliseconds: 250, statePath: legacy,
      startup: { enabled: true, credentialPath: join(configDirectory, 'intentionally-absent.credential.json') },
      harness: { cwd: repository, cliPath, powershellPath: 'pwsh', auth: 'environment', permissionMode: 'workspace-write',
        runsPath: join(root, 'legacy-runs'), sessionMapPath: join(root, 'legacy-map.json'), runTimeoutMs: 10000 },
      superAgent: { enabled: true, projectId: 'crash-fixture', statePath, repositoryPath: repository,
        worktreesPath: join(root, 'worktrees'), runsPath: join(root, 'runs'), sessionMapsPath: join(root, 'sessions'),
        maxWorkers: 2, controlHost: '127.0.0.1', controlPort: port, github: { enabled: false },
        watchdog: { enabled: true, intervalMs: 250, requestTimeoutMs: 500, staleHeartbeatMs: 1000, cooldownMs: 1000, taskAgeMs: 60000 } } };
    await writeFile(configPath, JSON.stringify(config));
    child = spawn(process.execPath, [fixtureEntry, '--config', configPath, '--runtime-file', runtimePath, '--instance-id', instanceId], {
      cwd: fixtureBridge, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEAM_RELAY_BOT_TOKEN: 'synthetic-recovery-im-only', SUPER_AGENT_CONTROL_TOKEN: secret } });
    ownedControllers.add(child.pid);
    child.stdout.setEncoding('utf8').on('data', part => { output += part; }); child.stderr.setEncoding('utf8').on('data', part => { output += part; });
    childExited = new Promise((done, no) => { child.once('error', no); child.once('exit', done); });
    const metadata = await cim(child.pid);
    assert.ok(metadata && await ownedProcess(child.pid));
    const record = { pid: child.pid, executable: metadata.executable, creation_ticks: metadata.creation_ticks,
      config_path: configPath, runtime_file: runtimePath, instance_id: instanceId, bridge_path: fixtureEntry, started_at: new Date().toISOString() };
    await writeFile(recordPath, JSON.stringify(record));
    const initial = await waitFor(async () => { const status = await json(runtimePath); return status?.status === 'listening' ? status : null; }, 'Initial fixture controller did not become ready');
    originalWatchdog = initial.watchdogPid; assert.ok(originalWatchdog && alive(originalWatchdog));
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/api/supervisor/snapshot`, { headers: { Authorization: 'Bearer ' + secret } })).json();
    assert.equal(snapshot.active, 0); assert.equal(snapshot.tasks.length, 0, 'Never crash a controller which may own a task');
    assert.equal(await readFile(legacy, 'utf8'), legacyBytes);
    // Terminate this one idle controller via its owned process handle; keep its Watchdog alive.
    assert.equal(child.kill('SIGKILL'), true); await childExited;
    assert.ok(alive(originalWatchdog), 'Independent Watchdog exited with its controller');
    const recovered = await waitFor(async () => {
      const status = await json(runtimePath);
      if (status?.pid && status.pid !== child.pid && status.status === 'listening') { ownedControllers.add(status.pid); return status; }
      return null;
    }, 'Independent Watchdog did not recover the crashed controller', 22000);
    const updated = await waitFor(async () => { const item = await json(recordPath); return item?.pid === recovered.pid ? item : null; }, 'Recovered controller did not refresh managed process identity', 8000);
    const current = await ownedProcess(recovered.pid); assert.ok(current);
    const ticks = /"creation_ticks"\s*:\s*(?:"(\d+)"|(\d+))/u.exec(await readFile(recordPath, 'utf8'));
    assert.equal(ticks?.[1] ?? ticks?.[2], current.creation_ticks); assert.equal(updated.executable.toLowerCase(), current.executable.toLowerCase());
    assert.equal(recovered.instanceId, instanceId); assert.equal(recovered.configPath, configPath);
    const owner = await json(ownerPath); assert.equal(owner.pid, originalWatchdog, 'Recovery started a second Watchdog');
    assert.equal(recovered.watchdogPid, originalWatchdog, 'Runtime must report the reused external Watchdog');
    const supervision = await json(join(root, 'environment/data/super/watchdog-state.json'));
    assert.equal(supervision.watchdog.restarts.length, 1); assert.equal(supervision.watchdog.restarts[0].pid, recovered.pid);
    assert.ok((await readdir(join(root, 'environment/data/startup'))).some(name => name.includes('.crashed-')));
    const probes = await Promise.all((await readdir(audit)).map(name => json(join(audit, name))));
    assert.equal(probes.length, 2, 'Only initial and recovered version probes are permitted');
    assert.ok(probes.every(item => !item.im && !item.control && !item.bundle), 'A restart credential reached the fake DSH process');
    assert.equal(await readFile(legacy, 'utf8'), legacyBytes);
    await writeFile(runtimePath + '.stop', JSON.stringify({ instanceId }));
    await waitFor(() => !alive(recovered.pid) && !alive(originalWatchdog), 'Recovered service did not stop by the original nonce', 12000);
    assert.equal((await json(runtimePath)).status, 'stopped');
  } catch (cause) {
    failed = true; await evidence(); cause.message += '\nSynthetic crash fixture: ' + root + '\n' + output.slice(-3000); throw cause;
  }
});
