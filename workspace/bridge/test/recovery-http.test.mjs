import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bridgePath = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const syntheticToken = 'synthetic-recovery-http-token';
const human = { id: 'human-1', username: 'alice', display_name: 'Synthetic member', is_bot: false };
const stranger = { id: 'human-2', username: 'outsider', display_name: 'Unauthorized member', is_bot: false };
const bot = { id: 'bot-1', username: 'dsh', display_name: 'Synthetic bot', is_bot: true };
const fixtures = new WeakMap();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const windowsTest = (name, fn) => test(name, {
  skip: process.platform !== 'win32' ? 'Installed fake CLI process needs Windows PowerShell.' : false,
  timeout: 90000,
}, async t => {
  try { await fn(t); }
  catch (error) { for (const f of fixtures.get(t) ?? []) f.preserve = true; throw error; }
});

// This is a synthetic native-protocol program. It never loads DSH or a model.
// First attempts leave a real fixture file then hang until the owned tree timeout.
// The next --session-id invocation must preserve that file and return a result.
const fakeCli = String.raw`
if ($args -contains '--version') { $global:LASTEXITCODE = 0; Write-Output 'fake-recovery-dsh 0.2.2-test'; return }
$prompt = $input | Out-String
$permission = $args[[Array]::IndexOf($args, '--permission-mode') + 1]
$sessionIndex = [Array]::IndexOf($args, '--session-id')
$sessionId = if ($sessionIndex -ge 0) { $args[$sessionIndex + 1] } else { 'session-recovery-original' }
$eventId = 0
if ($prompt -match '"event_id"\s*:\s*(\d+)') { $eventId = [int]$Matches[1] }
$marker = @{ sessionId = $sessionId; restored = ($sessionIndex -ge 0); permission = $permission; tokenSeen = [bool](Test-Path Env:\TEAM_RELAY_BOT_TOKEN); eventId = $eventId }
@{ type = 'session'; sessionId = $sessionId } | ConvertTo-Json -Compress
if ($permission -eq 'read-only') {
  [IO.File]::AppendAllText((Join-Path (Get-Location).Path 'classifier-calls.jsonl'), ($marker | ConvertTo-Json -Compress) + [Environment]::NewLine)
  $current = 1
  if ($prompt -match '"currentMessageId"\s*:\s*(\d+)') { $current = [int]$Matches[1] }
  $answer = @{ action = 'code_task'; summary = 'Synthetic recovery task'; instructions = 'Keep existing partial changes and finish the synthetic task'; evidenceIds = @($current) } | ConvertTo-Json -Depth 6 -Compress
} else {
  $countPath = Join-Path (Get-Location).Path 'worker-count.txt'
  $count = if (Test-Path -LiteralPath $countPath) { [int][IO.File]::ReadAllText($countPath) + 1 } else { 1 }
  [IO.File]::WriteAllText($countPath, [string]$count)
  $marker.count = $count
  [IO.File]::AppendAllText((Join-Path (Get-Location).Path 'worker-calls.jsonl'), ($marker | ConvertTo-Json -Compress) + [Environment]::NewLine)
  $partialPath = Join-Path (Get-Location).Path 'partial-change.txt'
  if (!(Test-Path -LiteralPath $partialPath)) { [IO.File]::WriteAllText($partialPath, 'synthetic partial change must survive') }
  $hangAttempts = [int][IO.File]::ReadAllText((Join-Path (Get-Location).Path 'hang-attempts.txt'))
  if ($count -le $hangAttempts -and $prompt -notmatch 'SYNTHETIC_NEW_TASK') { Start-Sleep -Seconds 30 }
  $preserved = [IO.File]::ReadAllText($partialPath) -eq 'synthetic partial change must survive'
  if (!$preserved) { throw 'Partial change was not preserved.' }
  [IO.File]::WriteAllText((Join-Path (Get-Location).Path 'completed.txt'), 'synthetic completed')
  $answer = 'Synthetic recovered task completed; partial change preserved.'
}
@{ type = 'final'; sessionId = $sessionId; reason = @{ kind = 'completed' }; text = $answer } | ConvertTo-Json -Depth 6 -Compress
$global:LASTEXITCODE = 0
`;

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function lines(path) {
  try { return (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function replaceJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

async function fixture(t, { hangAttempts = 1, seedPhase, loseReplyOnce = false, phasePublishFault = false, statePublishFault = false, prepostedContinue = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay recovery http '));
  const f = { preserve: false, directory, generation: 0, output: '', child: null };
  const owned = fixtures.get(t) ?? []; owned.push(f); fixtures.set(t, owned);
  const cwd = join(directory, 'project workspace');
  await mkdir(cwd);
  await writeFile(join(cwd, 'hang-attempts.txt'), String(hangAttempts));
  const cliPath = join(directory, 'synthetic cli.ps1');
  await writeFile(cliPath, fakeCli);
  const faultPreload = join(directory, 'phase publication fault.mjs');
  if (phasePublishFault || statePublishFault) await writeFile(faultPreload, String.raw`
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.promises.rename, readFile = fs.promises.readFile, writeFile = fs.promises.writeFile;
let fired = false;
fs.promises.rename = async (...args) => {
  if (!fired && String(args[1]) === process.env.TEAM_RELAY_TEST_PHASE_RUNTIME) {
    const value = JSON.parse(await readFile(args[0], 'utf8'));
    if (value.status === 'listening' && value.taskStatus === 'running') {
      fired = true;
      await writeFile(process.env.TEAM_RELAY_TEST_PHASE_MARKER, 'running publication failed exactly once');
      throw Object.assign(new Error('synthetic noncritical phase publication failure'), { code: 'EIO' });
    }
  }
  if (!fired && String(args[1]) === process.env.TEAM_RELAY_TEST_STATE_FAULT_PATH) {
    const value = JSON.parse(await readFile(args[0], 'utf8'));
    if (value.current?.phase === 'started' && value.current?.resume) {
      fired = true;
      await writeFile(process.env.TEAM_RELAY_TEST_STATE_FAULT_MARKER, 'resumed started ledger failed exactly once');
      throw Object.assign(new Error('synthetic resumed started ledger publication failure'), { code: 'EIO' });
    }
  }
  return rename(...args);
};
syncBuiltinESMExports();
`);
  const statePath = join(directory, 'bridge state.json');
  const mapPath = join(directory, 'native sessions.json');
  const configPath = join(directory, 'bridge config.json');
  const all = [], replies = [], calls = [];
  const replyByClient = new Map();
  let nextId = 1, lostReply = false;
  const send = (text, sender = human, conversationId = 'group-1') => {
    const event = { id: nextId++, conversation_id: conversationId, sender, text, attachment: null,
      client_id: `synthetic-${randomUUID()}`, created_at: new Date().toISOString() };
    all.push(event); return event;
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      calls.push({ method: request.method, path: url.pathname });
      if (request.headers.authorization !== `Bearer ${syntheticToken}`) {
        response.writeHead(401); response.end('{}'); return;
      }
      let result;
      if (url.pathname === '/api/me') result = bot;
      else if (url.pathname === '/api/users') result = [human, stranger, bot];
      else if (url.pathname === '/api/conversations') result = ['group-1', 'group-2'].map(id => ({
        id, title: `Synthetic ${id}`, is_direct: false, members: [human, stranger, bot],
        last_message: all.filter(event => event.conversation_id === id).at(-1) ?? null,
      }));
      else if (url.pathname === '/api/agent/events') {
        // Include adversarial bot events so the bridge's own guard is exercised too.
        const events = all.filter(event => event.id > Number(url.searchParams.get('after'))).slice(0, Number(url.searchParams.get('limit') ?? 50));
        result = { events, cursor: events.at(-1)?.id ?? Number(url.searchParams.get('after')) };
      } else if (/^\/api\/conversations\/group-[12]\/messages$/.test(url.pathname)) {
        const conversationId = url.pathname.split('/')[3];
        if (request.method === 'GET') result = all.filter(event => event.conversation_id === conversationId && event.id < Number(url.searchParams.get('before') ?? Infinity)).slice(-Number(url.searchParams.get('limit') ?? 50));
        else {
          let body = ''; for await (const part of request) body += part;
          const input = JSON.parse(body);
          let message = replyByClient.get(input.client_id);
          if (!message) {
            message = { ...send(input.text, bot, conversationId), client_id: input.client_id };
            all[all.length - 1] = message;
            replyByClient.set(input.client_id, message); replies.push(message);
          }
          if (loseReplyOnce && !lostReply && /^正在接续原任务/.test(input.text)) {
            lostReply = true; response.writeHead(503); response.end('{}'); return;
          }
          result = message;
        }
      } else { response.writeHead(404); response.end('{}'); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const config = { executor: 'installed-headless', triggerMode: 'auto', baseUrl, tokenEnv: 'TEAM_RELAY_BOT_TOKEN', botUsername: 'dsh',
    conversationIds: ['group-1', 'group-2'], senderIds: [human.id], statePath, pollMilliseconds: 250, contextMessages: 20, contextCharacters: 12000,
    harness: { cwd, cliPath, runsPath: join(directory, 'private runs'), sessionMapPath: mapPath, auth: 'environment',
      permissionMode: 'workspace-write', powershellPath: process.env.TEAM_RELAY_TEST_POWERSHELL ?? 'pwsh', runTimeoutMs: 3500, classificationTimeoutMs: 12000 } };
  await writeFile(configPath, JSON.stringify(config));
  if (seedPhase) {
    const event = send('Synthetic original interrupted code task.');
    const logical = 'synthetic-original-task';
    await writeFile(statePath, JSON.stringify({ version: 1, identity: `${baseUrl}|${bot.id}`, cursor: 0, autoInitialized: true,
      sessions: seedPhase === 'routing_failed' ? {} : { 'group-1': logical }, current: { phase: seedPhase, event, routing: { summary: 'Synthetic task', instructions: 'Keep existing partial change and continue', context: [] } } }));
    if (seedPhase !== 'routing_failed') await writeFile(mapPath, JSON.stringify({ version: 1, cwd, sessions: { [logical]: { nativeSessionId: 'session-recovery-original', cwd } } }));
    await writeFile(join(cwd, 'partial-change.txt'), 'synthetic partial change must survive');
    if (prepostedContinue) send('继续任务');
  }
  const diagnostics = async stage => {
    const record = { stage, directory, at: new Date().toISOString(), child: f.child ? { pid: f.child.pid, code: f.child.exitCode, signal: f.child.signalCode } : null,
      runtime: f.runtimePath ? await json(f.runtimePath).catch(error => ({ error: error.message })) : null,
      state: await json(statePath).catch(error => ({ error: error.message })), output: f.output, calls,
      workers: await lines(join(cwd, 'worker-calls.jsonl')), classifiers: await lines(join(cwd, 'classifier-calls.jsonl')),
      runNames: await readdir(config.harness.runsPath).catch(() => []), replies };
    await writeFile(join(directory, `diagnostics-${stage}.json`), JSON.stringify(record, null, 2)); return record;
  };
  const wait = async (check, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    try {
      while (Date.now() < deadline) {
        if (f.child && (f.child.exitCode !== null || f.child.signalCode !== null)) throw new Error('Synthetic bridge exited unexpectedly.');
        const value = await check(); if (value) return value;
        await delay(40);
      }
      throw new Error(`Timed out waiting for ${label}`);
    } catch (error) {
      f.preserve = true; error.message += `\nRecovery diagnostics: ${JSON.stringify(await diagnostics('failure'))}`; throw error;
    }
  };
  const start = async () => {
    if (f.child && f.child.exitCode === null && f.child.signalCode === null) throw new Error('Fixture already has a live listener.');
    f.generation++; f.instanceId = randomUUID(); f.runtimePath = join(directory, `runtime-${f.generation}.json`);
    const preload = phasePublishFault || statePublishFault ? ['--import', pathToFileURL(faultPreload).href] : [];
    f.child = spawn(process.execPath, [...preload, bridgePath, '--config', configPath, '--runtime-file', f.runtimePath, '--instance-id', f.instanceId], {
      cwd: directory, env: { ...process.env, TEAM_RELAY_BOT_TOKEN: syntheticToken,
        ...(phasePublishFault ? { TEAM_RELAY_TEST_PHASE_RUNTIME: f.runtimePath, TEAM_RELAY_TEST_PHASE_MARKER: join(directory, 'phase-fault-fired.txt') } : {}),
        ...(statePublishFault ? { TEAM_RELAY_TEST_STATE_FAULT_PATH: statePath, TEAM_RELAY_TEST_STATE_FAULT_MARKER: join(directory, 'state-fault-fired.txt') } : {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    f.child.stdout.setEncoding('utf8').on('data', text => { f.output += text; });
    f.child.stderr.setEncoding('utf8').on('data', text => { f.output += text; });
    f.exited = new Promise((resolve, reject) => { f.child.once('error', reject); f.child.once('exit', (code, signal) => resolve({ code, signal })); });
    return wait(async () => { const record = await json(f.runtimePath); return record?.status === 'listening' ? record : null; }, 'listening transport');
  };
  const stop = async () => {
    if (!f.child || f.child.exitCode !== null || f.child.signalCode !== null) return;
    await replaceJson(`${f.runtimePath}.stop`, { instanceId: f.instanceId });
    let timer;
    try {
      const result = await Promise.race([f.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic listener did not stop.')), 15000); })]);
      assert.equal(result.code, 0); return result;
    } finally { clearTimeout(timer); }
  };
  t.after(async () => {
    if (f.preserve) await diagnostics('before-cleanup');
    try { await stop(); }
    catch (error) {
      f.preserve = true;
      if (f.child?.exitCode === null && f.child.signalCode === null) {
        await new Promise(resolveKill => { const kill = spawn('taskkill.exe', ['/PID', String(f.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); kill.once('error', resolveKill); kill.once('close', resolveKill); });
        await f.exited.catch(() => {});
      }
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (f.preserve) { await diagnostics('after-cleanup'); t.diagnostic(`Failed synthetic recovery fixture preserved at ${directory}`); }
    else {
      const tail = relative(resolve(tmpdir()), resolve(directory));
      if (!tail || tail.startsWith(`..${sep}`) || tail === '..' || dirname(directory) !== resolve(tmpdir()) || !tail.startsWith('relay recovery http ')) throw new Error('Unsafe fixture cleanup path.');
      await rm(directory, { recursive: true, force: true });
    }
  });
  Object.assign(f, { cwd, config, statePath, mapPath, all, replies, send, start, stop, wait,
    state: () => json(statePath), runtime: () => json(f.runtimePath),
    workers: () => lines(join(cwd, 'worker-calls.jsonl')), classifiers: () => lines(join(cwd, 'classifier-calls.jsonl')),
    paused: () => wait(async () => { const state = await json(statePath), runtime = await json(f.runtimePath); return state?.current?.pauseNotice?.sent && ['uncertain', 'routing_failed'].includes(state.current.phase) && runtime?.taskStatus === 'paused' ? state : null; }, 'paused task with online listener and delivered recovery guidance'),
  });
  await start(); return f;
}

windowsTest('worker timeout keeps transport online; authorized chat continue resumes native session and preserves actual partial file', async t => {
  const f = await fixture(t);
  const original = f.send('Please fix this synthetic code task.');
  await f.paused();
  assert.equal((await f.state()).current.event.id, original.id);
  assert.equal((await f.runtime()).status, 'listening');
  assert.equal((await f.workers()).length, 1);
  assert.equal((await f.classifiers()).length, 1);
  assert.equal(await readFile(join(f.cwd, 'partial-change.txt'), 'utf8'), 'synthetic partial change must survive');
  await delay(650);
  assert.equal((await f.workers()).length, 1, 'No automatic retry while paused');
  const command = f.send('继续修正');
  await f.wait(async () => !(await f.state()).current && (await f.workers()).length === 2, 'one successful explicit continuation');
  const calls = await f.workers();
  assert.equal(calls[1].restored, true);
  assert.equal(calls[1].sessionId, calls[0].sessionId);
  assert.equal(calls[1].tokenSeen, false);
  assert.equal((await f.classifiers()).length, 1, 'Resume command must bypass task classification');
  assert.ok(f.replies.some(message => /Synthetic recovered task completed/.test(message.text)));
  await f.wait(async () => (await f.state()).cursor >= command.id, 'consumed recovery command cursor');
  await f.stop();
  await f.start();
  await delay(700);
  assert.equal((await f.workers()).length, 2, 'Restart must not replay consumed recovery command');
  assert.equal(await readFile(join(f.cwd, 'partial-change.txt'), 'utf8'), 'synthetic partial change must survive');
});

windowsTest('cross-group, unauthorized, bot and ordinary discussion cannot resume a paused task; authorized ordinary message gets guidance', async t => {
  const f = await fixture(t, { seedPhase: 'uncertain', hangAttempts: 0 });
  await f.paused();
  const previousReplies = f.replies.length;
  f.send('继续修正', human, 'group-2');
  f.send('继续修正', stranger);
  f.send('继续修正', bot);
  f.send('继续讨论');
  await f.wait(() => f.replies.slice(previousReplies).some(message => /继续修正/.test(message.text) && /取消任务/.test(message.text)), 'recovery guidance for new ordinary message');
  await delay(700);
  assert.equal((await f.workers()).length, 0);
  assert.equal((await f.classifiers()).length, 0);
  f.send('@dsh 继续修正。');
  await f.wait(async () => !(await f.state()).current && (await f.workers()).length === 1, 'authorized same-group control');
  assert.equal((await f.workers())[0].restored, true);
});

windowsTest('duplicate pre-attempt resume commands cannot trigger another attempt after a second timeout', async t => {
  const f = await fixture(t, { hangAttempts: 2 });
  f.send('Please fix the synthetic code task.');
  await f.paused();
  f.send('继续修正');
  f.send('继续修正');
  await f.wait(async () => (await f.workers()).length === 2, 'single admitted resume attempt');
  await f.paused();
  await delay(900);
  assert.equal((await f.workers()).length, 2, 'Old duplicate command must not resume the second failure');
  assert.equal((await f.runtime()).status, 'listening');
  f.send('恢复任务');
  await f.wait(async () => !(await f.state()).current && (await f.workers()).length === 3, 'fresh explicit resume after second timeout');
  assert.equal((await f.classifiers()).length, 1);
});

windowsTest('cancel releases paused task while preserving partial change and permits a subsequent new code request', async t => {
  const f = await fixture(t, { seedPhase: 'uncertain', hangAttempts: 0 });
  await f.paused();
  f.send('取消任务');
  await f.wait(async () => !(await f.state()).current, 'explicit cancellation');
  assert.equal((await f.workers()).length, 0);
  assert.equal(await readFile(join(f.cwd, 'partial-change.txt'), 'utf8'), 'synthetic partial change must survive');
  f.send('Please implement SYNTHETIC_NEW_TASK and verify it.');
  await f.wait(async () => (await f.workers()).length === 1 && !(await f.state()).current, 'subsequent new code task');
  assert.equal((await f.classifiers()).length, 1);
});

windowsTest('a restored uncertain listener stays online and recovers an already posted continue command only once', async t => {
  const f = await fixture(t, { seedPhase: 'uncertain', hangAttempts: 0, prepostedContinue: true });
  await f.wait(async () => (await f.workers()).length === 1 && !(await f.state()).current, 'preposted recovery after restart');
  assert.equal((await f.workers())[0].restored, true);
  assert.equal((await f.classifiers()).length, 0);
  await delay(700);
  assert.equal((await f.workers()).length, 1);
});

windowsTest('lost continuation acknowledgement retries only the notice and launches one restored worker', async t => {
  const f = await fixture(t, { seedPhase: 'uncertain', hangAttempts: 0, loseReplyOnce: true });
  await f.paused();
  f.send('继续修正');
  await f.wait(async () => (await f.workers()).length === 1 && !(await f.state()).current, 'continuation after lost HTTP acknowledgement');
  assert.equal((await f.workers())[0].restored, true);
  assert.equal(f.replies.filter(message => /^正在接续原任务/.test(message.text)).length, 1);
  assert.equal((await f.classifiers()).length, 0);
});

windowsTest('routing failure restart stays paused and classifies only after explicit same-chat recovery', async t => {
  const f = await fixture(t, { seedPhase: 'routing_failed', hangAttempts: 0 });
  await f.paused();
  assert.equal((await f.classifiers()).length, 0);
  f.send('重试任务');
  await f.wait(async () => (await f.workers()).length === 1 && !(await f.state()).current, 'explicit rerouting after recovery');
  assert.equal((await f.classifiers()).length, 1);
  assert.equal((await f.workers())[0].restored, false);
});

windowsTest('one failed noncritical running status publication neither interrupts work nor poisons later runtime updates', async t => {
  const f = await fixture(t, { hangAttempts: 0, phasePublishFault: true });
  f.send('Please complete this synthetic code task.');
  await f.wait(async () => (await f.runtime()).taskStatus === 'running', 'runtime recovery after injected phase publication error');
  await f.wait(async () => (await f.workers()).length === 1 && !(await f.state()).current && (await f.runtime()).taskStatus === 'ready', 'completed task with fresh ready status');
  assert.equal(await readFile(join(f.directory, 'phase-fault-fired.txt'), 'utf8'), 'running publication failed exactly once');
  assert.match(f.output, /synthetic noncritical phase publication failure/);
  assert.equal((await f.workers()).length, 1);
  assert.equal((await f.classifiers()).length, 1);
  assert.equal((await f.runtime()).status, 'listening');
  assert.equal(await readFile(join(f.cwd, 'completed.txt'), 'utf8'), 'synthetic completed');
});

windowsTest('failed resumed started ledger write aborts only preparation and a fresh continue restores the original session', async t => {
  const f = await fixture(t, { seedPhase: 'uncertain', hangAttempts: 0, statePublishFault: true });
  await f.paused();
  f.send('继续修正');
  await f.wait(async () => {
    const state = await f.state();
    try { await readFile(join(f.directory, 'state-fault-fired.txt')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    return state.current?.phase === 'uncertain' && state.current?.attempt >= 1 && state.current?.pauseNotice?.sent
      && (await f.runtime()).taskStatus === 'paused';
  }, 'paused recovery after failed durable started admission');
  assert.equal((await f.workers()).length, 0, 'A worker cannot start before its started ledger is durable');
  assert.equal((await f.classifiers()).length, 0);
  assert.equal((await f.runtime()).status, 'listening');
  assert.equal(await readFile(join(f.cwd, 'partial-change.txt'), 'utf8'), 'synthetic partial change must survive');
  await delay(650);
  assert.equal((await f.workers()).length, 0, 'A failed prepared admission cannot retry itself');
  f.send('继续修正');
  await f.wait(async () => (await f.workers()).length === 1 && !(await f.state()).current, 'fresh authorized continuation after aborting unstarted preparation');
  const [worker] = await f.workers();
  assert.equal(worker.restored, true);
  assert.equal(worker.sessionId, 'session-recovery-original');
  assert.equal((await f.classifiers()).length, 0);
  assert.equal((await f.runtime()).status, 'listening');
});
