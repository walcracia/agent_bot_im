import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceOwnedFile } from '../file-replace.mjs';

const bridgePath = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const fixturesByTest = new WeakMap();
const windowsTest = (name, callback) => test(name, {
  skip: process.platform !== 'win32' ? 'Installed CLI process fixture requires Windows PowerShell.' : false,
  timeout: 45000,
}, async t => {
  try { await callback(t); }
  catch (error) {
    for (const fixture of fixturesByTest.get(t) ?? []) fixture.preserve = true;
    throw error;
  }
});
const human = { id: 'human-1', username: 'alice', display_name: 'Test member', is_bot: false };
const bot = { id: 'bot-1', username: 'dsh', display_name: 'Test bot', is_bot: true };
const oldEvent = { id: 40, conversation_id: 'group-1', sender: human, text: 'Old discussion that must not be replayed.', attachment: null };

// Synthetic protocol fixture only. No installed DSH, saved authentication or model is used.
const fakeCli = String.raw`
if ($args -contains '--version') {
  [IO.File]::AppendAllText((Join-Path (Get-Location).Path 'versions.txt'), 'version' + [Environment]::NewLine)
  if (Test-Path -LiteralPath (Join-Path (Get-Location).Path 'fail-version')) { $global:LASTEXITCODE = 7; Write-Output 'synthetic version failure'; return }
  $global:LASTEXITCODE = 0
  Write-Output 'fake-startup-dsh 0.2.2-test'
  return
}
$prompt = $input | Out-String
$marker = @{ tokenSeen = [bool](Test-Path Env:\TEAM_RELAY_BOT_TOKEN); permission = $args[[Array]::IndexOf($args, '--permission-mode') + 1] } | ConvertTo-Json -Compress
[IO.File]::AppendAllText((Join-Path (Get-Location).Path 'classifications.jsonl'), $marker + [Environment]::NewLine)
if ($prompt -match 'MODE_DELAY') { Start-Sleep -Milliseconds 1200 }
if ($prompt -match 'MODE_WORKER_DELAY' -and $marker -notmatch 'read-only') {
  [IO.File]::WriteAllText((Join-Path (Get-Location).Path 'worker-in-flight'), 'synthetic worker started')
  Start-Sleep -Milliseconds 1200
}
$id = 'session-synthetic-startup'
@{ type = 'session'; sessionId = $id } | ConvertTo-Json -Compress
$answer = @{ action = 'ignore'; summary = 'Synthetic discussion'; instructions = ''; evidenceIds = @() } | ConvertTo-Json -Depth 6 -Compress
if ($prompt -match 'MODE_WORKER_DELAY') {
  if ($marker -match 'read-only') { $answer = @{ action = 'code_task'; summary = 'Synthetic task'; instructions = 'MODE_WORKER_DELAY finish the synthetic task'; evidenceIds = @(1) } | ConvertTo-Json -Depth 6 -Compress }
  else { $answer = 'Synthetic task completed' }
}
@{ type = 'final'; sessionId = $id; reason = @{ kind = 'completed' }; text = $answer } | ConvertTo-Json -Depth 6 -Compress
$global:LASTEXITCODE = 0
`;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function waitFor(check, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await delay(35);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function replaceJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
  // The listener may briefly hold its previous stop request without Windows
  // delete-sharing. Keep fixture publication atomic and bounded; never bypass
  // the stale-instance assertions or replace a failed write with success.
  try { await replaceOwnedFile(temporary, path, undefined, { backoffMilliseconds: [25, 50, 100, 200, 400, 800, 1000, 1500, 2000, 2000] }); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay startup process '));
  const evidence = { preserve: false };
  const fixtures = fixturesByTest.get(t) ?? [];
  fixtures.push(evidence); fixturesByTest.set(t, fixtures);
  const cwd = join(directory, 'project workspace');
  await mkdir(cwd);
  const cliPath = join(directory, 'synthetic cli.ps1');
  await writeFile(cliPath, fakeCli);
  if (options.versionFails) await writeFile(join(cwd, 'fail-version'), 'synthetic');
  const calls = [];
  const replies = [];
  const events = options.oldEvent ? [oldEvent] : [];
  const members = options.members ?? [human, bot];
  let releaseMe;
  const meGate = options.holdMe ? new Promise(resolve => { releaseMe = resolve; }) : Promise.resolve();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      calls.push(url.pathname);
      if (url.pathname === '/api/me') await meGate;
      if (options.badToken || request.headers.authorization !== 'Bearer synthetic-startup-secret') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ detail: 'Do not leak synthetic-startup-secret into runtime diagnostics' }));
        return;
      }
      let result;
      if (url.pathname === '/api/me') result = bot;
      else if (url.pathname === '/api/conversations') result = [{ id: 'group-1', title: 'Synthetic project', is_direct: false, members, last_message: options.oldEvent ? oldEvent : null }];
      else if (url.pathname === '/api/users') result = [human, bot];
      else if (url.pathname === '/api/agent/events') result = { events: events.filter(event => event.id > Number(url.searchParams.get('after'))), cursor: Number(url.searchParams.get('after')) };
      else if (url.pathname === '/api/conversations/group-1/messages') {
        if (request.method === 'GET') result = events.filter(event => event.id < Number(url.searchParams.get('before') ?? Infinity));
        else {
          let body = '';
          for await (const part of request) body += part;
          replies.push(JSON.parse(body));
          result = { id: 500 + replies.length };
        }
      }
      else { response.writeHead(404); response.end('{}'); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch { response.writeHead(500); response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const configPath = join(directory, 'bridge config.json');
  const statePath = join(directory, 'state.json');
  const runtimePath = join(directory, 'runtime.json');
  const instanceId = randomUUID();
  const config = {
    executor: 'installed-headless', triggerMode: 'auto', baseUrl,
    tokenEnv: 'TEAM_RELAY_BOT_TOKEN', botUsername: 'dsh', conversationIds: ['group-1'], senderIds: ['human-1'],
    statePath, pollMilliseconds: 250, contextMessages: 20, contextCharacters: 12000,
    harness: { cwd, cliPath, runsPath: join(directory, 'private runs'), sessionMapPath: join(directory, 'sessions.json'),
      auth: 'environment', permissionMode: 'workspace-write', powershellPath: process.env.TEAM_RELAY_TEST_POWERSHELL ?? 'pwsh', runTimeoutMs: 15000 },
    ...options.config,
  };
  if (options.current) await writeFile(statePath, JSON.stringify({ version: 1, identity: `${baseUrl}|${bot.id}`, cursor: 0, sessions: {}, autoInitialized: true, current: options.current }));
  if (options.stateLock) await writeFile(`${statePath}.lock`, JSON.stringify({ pid: 2147483646, evidence: 'must remain untouched' }));
  if (options.oldStop) await writeFile(`${runtimePath}.stop`, JSON.stringify({ instanceId: randomUUID() }));
  if (options.oldRuntime) await writeFile(runtimePath, JSON.stringify(options.oldRuntime));
  await writeFile(configPath, JSON.stringify(config));
  const childArguments = options.preRuntimeExit
    ? ['--input-type=module', '-e', "process.stderr.write('synthetic pre-runtime exit'); process.exit(9);"]
    : [bridgePath, '--config', configPath, '--runtime-file', runtimePath, '--instance-id', instanceId];
  const child = spawn(process.execPath, childArguments, {
    cwd: directory, env: { ...process.env, TEAM_RELAY_BOT_TOKEN: 'synthetic-startup-secret' }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', text => { output += text; });
  child.stderr.setEncoding('utf8').on('data', text => { output += text; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const diagnostics = async stage => {
    const safeRead = async path => {
      try { return await readFile(path, 'utf8'); }
      catch (error) { return { code: error.code, message: error.message }; }
    };
    const runs = [];
    for (const name of await readdir(config.harness.runsPath).catch(() => [])) {
      const path = join(config.harness.runsPath, name);
      runs.push({ name, run: await safeRead(join(path, 'run.json')), result: await safeRead(join(path, 'result.json')), stderr: await safeRead(join(path, 'stderr.log')) });
    }
    const snapshot = { stage, directory, at: new Date().toISOString(), child: { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode },
      runtime: await safeRead(runtimePath), state: await safeRead(statePath), calls: [...calls], output, runs };
    await writeFile(join(directory, `diagnostics-${stage}.json`), JSON.stringify(snapshot, null, 2));
    return snapshot;
  };
  const stop = async () => {
    await replaceJson(`${runtimePath}.stop`, { instanceId });
    let timer;
    try {
      return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Synthetic bridge did not stop. ${output}`)), 12000); })]);
    } finally { clearTimeout(timer); }
  };
  t.after(async () => {
    if (evidence.preserve) await diagnostics('before-cleanup');
    releaseMe?.();
    try { if (child.exitCode === null && child.signalCode === null) await stop(); }
    catch { child.kill(); await exited.catch(() => {}); }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (evidence.preserve) {
      await diagnostics('after-cleanup');
      t.diagnostic(`Failed synthetic fixture preserved at ${directory}`);
    } else await rm(directory, { recursive: true, force: true });
  });
  return { directory, cwd, cliPath, configPath, statePath, runtimePath, instanceId, config, calls, events, replies, child, exited, stop,
    acknowledgeExpectedDiagnostic: () => { evidence.preserve = false; },
    releaseMe: () => releaseMe?.(), output: () => output,
    ready: async () => {
      try {
        return await waitFor(async () => {
          const runtime = await json(runtimePath);
          if (runtime?.status === 'failed' || child.exitCode !== null || child.signalCode !== null) throw new Error('Managed startup failed or exited before readiness.');
          return runtime?.status === 'listening' ? runtime : null;
        }, 'managed listening');
      } catch (error) {
        evidence.preserve = true;
        const snapshot = await diagnostics('readiness-failure');
        error.message += `\nManaged fixture diagnostics: ${JSON.stringify(snapshot)}`;
        throw error;
      }
    },
    modelCalls: async () => {
      try { return (await readFile(join(cwd, 'classifications.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
  };
}

windowsTest('managed readiness waits for zero-model CLI, IM checks and initial cursor; idle stop releases the state lock', async t => {
  const f = await fixture(t, { holdMe: true, oldEvent: true });
  await waitFor(() => f.calls.includes('/api/me'), 'held identity request');
  assert.equal((await json(f.runtimePath)).status, 'starting');
  assert.equal((await readFile(join(f.cwd, 'versions.txt'), 'utf8')).trim(), 'version');
  assert.deepEqual(await f.modelCalls(), []);
  f.releaseMe();
  const runtime = await f.ready();
  assert.equal(runtime.instanceId, f.instanceId);
  assert.equal(runtime.pid, f.child.pid);
  assert.equal(runtime.configPath, f.configPath);
  const state = await json(f.statePath);
  assert.equal(state.autoInitialized, true);
  assert.equal(state.cursor, oldEvent.id);
  assert.deepEqual(await f.modelCalls(), []);
  assert.equal((await f.stop()).code, 0);
  assert.equal((await json(f.runtimePath)).status, 'stopped');
  await assert.rejects(readFile(`${f.statePath}.lock`), { code: 'ENOENT' });
});

windowsTest('bad bot authentication fails without listening or leaking the token/HTTP body', async t => {
  const f = await fixture(t, { badToken: true });
  assert.notEqual((await f.exited).code, 0);
  const runtime = await json(f.runtimePath);
  assert.equal(runtime.status, 'failed');
  assert.doesNotMatch(JSON.stringify(runtime), /synthetic-startup-secret|Do not leak/);
  assert.doesNotMatch(f.output(), /"status"\s*:\s*"listening"/);
  assert.deepEqual(await f.modelCalls(), []);
});

windowsTest('a child exiting before runtime initialization fails promptly with inspectable diagnostics', async t => {
  const f = await fixture(t, { preRuntimeExit: true });
  await assert.rejects(f.ready(), error => {
    assert.match(error.message, /exited before readiness/);
    assert.match(error.message, /synthetic pre-runtime exit/);
    assert.match(error.message, /"exitCode":9/);
    return true;
  });
  const evidence = await json(join(f.directory, 'diagnostics-readiness-failure.json'));
  assert.equal(evidence.child.exitCode, 9);
  assert.equal(evidence.runtime.code, 'ENOENT');
  assert.deepEqual(evidence.calls, []);
  // This failure was deliberately induced and fully asserted; unexpected failures stay preserved.
  f.acknowledgeExpectedDiagnostic();
});

windowsTest('managed startup refuses a missing group, removed bot and invalid authorized sender', async t => {
  for (const options of [
    { config: { conversationIds: ['unjoined-group'] } },
    { members: [human] },
    { config: { senderIds: ['unknown-member'] } },
    { config: { senderIds: [bot.id] } },
  ]) {
    const f = await fixture(t, options);
    assert.notEqual((await f.exited).code, 0);
    assert.equal((await json(f.runtimePath)).status, 'failed');
    assert.doesNotMatch(f.output(), /"status"\s*:\s*"listening"/);
    assert.deepEqual(await f.modelCalls(), []);
  }
});

windowsTest('a stale stop request from another instance cannot stop the listener', async t => {
  const f = await fixture(t, { oldStop: true });
  await f.ready();
  await delay(650);
  assert.equal(f.child.exitCode, null);
  assert.equal((await json(f.runtimePath)).status, 'listening');
  assert.equal((await f.stop()).code, 0);
});

windowsTest('stop during classification finishes that event and does not admit the next event from the same batch', async t => {
  const f = await fixture(t);
  await f.ready();
  f.events.push(
    { id: 1, conversation_id: 'group-1', sender: human, text: 'MODE_DELAY first current discussion.', attachment: null },
    { id: 2, conversation_id: 'group-1', sender: human, text: 'Second discussion must remain for the next explicit start.', attachment: null },
  );
  await waitFor(async () => (await f.modelCalls()).length === 1, 'first classifier in flight');
  const stopped = f.stop();
  assert.equal((await stopped).code, 0);
  assert.deepEqual(await f.modelCalls(), [{ tokenSeen: false, permission: 'read-only' }]);
  assert.equal((await json(f.statePath)).cursor, 1);
  assert.equal((await json(f.statePath)).current, null);
  assert.equal((await json(f.runtimePath)).status, 'stopped');
  await assert.rejects(readFile(`${f.statePath}.lock`), { code: 'ENOENT' });
});

windowsTest('stop during a synthetic code worker allows the result reply and cursor commit before exiting', async t => {
  const f = await fixture(t);
  await f.ready();
  f.events.push({ id: 1, conversation_id: 'group-1', sender: human, text: 'MODE_WORKER_DELAY fix and verify this synthetic task.', attachment: null });
  await waitFor(async () => {
    try { return await readFile(join(f.cwd, 'worker-in-flight')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, 'synthetic worker in flight');
  assert.equal((await json(f.statePath)).current.phase, 'started');
  assert.equal((await f.stop()).code, 0);
  assert.deepEqual(await f.modelCalls(), [
    { tokenSeen: false, permission: 'read-only' },
    { tokenSeen: false, permission: 'workspace-write' },
  ]);
  assert.equal(f.replies.length, 2);
  assert.equal(f.replies[1].text, 'Synthetic task completed');
  assert.equal((await json(f.statePath)).cursor, 1);
  assert.equal((await json(f.statePath)).current, null);
  await assert.rejects(readFile(`${f.statePath}.lock`), { code: 'ENOENT' });
});

windowsTest('started, uncertain and routing_failed restart online paused without automatically rerunning', async t => {
  for (const phase of ['started', 'uncertain', 'routing_failed']) {
    const f = await fixture(t, { current: { phase, event: { ...oldEvent, id: 1 } } });
    const runtime = await f.ready();
    assert.equal(runtime.taskStatus, 'paused');
    assert.equal(runtime.pendingEventId, 1);
    assert.equal(f.child.exitCode, null);
    const state = await json(f.statePath);
    assert.equal(state.current.event.id, 1);
    assert.equal(state.cursor, 0);
    assert.deepEqual(await f.modelCalls(), []);
    assert.equal((await f.stop()).code, 0);
    await assert.rejects(readFile(`${f.statePath}.lock`), { code: 'ENOENT' });
  }
});

windowsTest('failed native version probe cannot claim readiness or make model calls', async t => {
  const f = await fixture(t, { versionFails: true });
  assert.notEqual((await f.exited).code, 0);
  assert.equal((await json(f.runtimePath)).status, 'failed');
  assert.equal(f.calls.includes('/api/me'), false);
  assert.deepEqual(await f.modelCalls(), []);
});

windowsTest('a preexisting state lock is preserved rather than cleaned during startup', async t => {
  const f = await fixture(t, { stateLock: true });
  assert.notEqual((await f.exited).code, 0);
  assert.equal((await json(f.runtimePath)).status, 'failed');
  assert.deepEqual(await json(`${f.statePath}.lock`), { pid: 2147483646, evidence: 'must remain untouched' });
  assert.deepEqual(await f.modelCalls(), []);
});

windowsTest('an existing runtime file is never overwritten to impersonate another managed instance', async t => {
  const owner = { instanceId: randomUUID(), pid: 2147483646, status: 'listening', configPath: 'other-config' };
  const f = await fixture(t, { oldRuntime: owner });
  assert.notEqual((await f.exited).code, 0);
  assert.deepEqual(await json(f.runtimePath), owner);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.modelCalls(), []);
});
