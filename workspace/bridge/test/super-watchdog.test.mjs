import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SemanticWatchdog, parseWatchdogDecision, controllerClient, restartRegisteredController, startWatchdog, verifyWatchdogRecovery } from '../super-watchdog.mjs';

const clone = value => structuredClone(value);
const iso = value => new Date(value).toISOString();
const task = (id = 'task-1', extra = {}) => ({ id, status: 'running', summary: 'Fix a synthetic calculator',
  instructions: 'Return a+b and pass the unchanged calculator tests.', attempt: 1, startedAt: iso(1), updatedAt: iso(1),
  progress: { at: iso(100), summary: 'Inspected the implementation.', tools: ['read_file'], diff: '', tests: 'Not yet run' }, ...extra });
const decision = (id, action = 'observe', extra = {}) => JSON.stringify({ taskId: id, action, reason: 'The actual diff and tests show meaningful progress.', ...extra });

function fixture(extra = {}) {
  let time = 10000;
  const saved = [], requests = [], prompts = [];
  const value = { generation: 'controller-a', heartbeat: iso(time), tasks: [task()] };
  const config = { intervalMs: 10, taskAgeMs: 100, cooldownMs: 100, staleHeartbeatMs: 1000, ...extra.config };
  const watchdog = new SemanticWatchdog({ config, state: extra.state, now: () => time,
    snapshot: extra.snapshot ?? (async () => clone(value)),
    classify: async prompt => { prompts.push(prompt); return extra.classify ? extra.classify(prompt) : decision('task-1'); },
    act: async action => { requests.push(clone(action)); return extra.act?.(action) ?? { accepted: true }; },
    save: async state => { saved.push(clone(state)); await extra.save?.(state); } });
  return { watchdog, value, saved, requests, prompts, advance(ms) { time += ms; value.heartbeat = iso(time); }, now: () => time };
}

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-watchdog-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function httpFixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function until(condition, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await condition()) return; await new Promise(done => setTimeout(done, 20)); }
  throw new Error('Synthetic Watchdog condition did not occur.');
}

test('semantic assessment receives bounded actual goal/diff/tests and does not equate process activity with success', async () => {
  const f = fixture();
  f.value.tasks[0].progress.evidence = 'x'.repeat(10000);
  f.value.tasks[0].progress.events = [{ type: 'tool', text: 'pytest calculator: 1 failing assertion' }];
  f.value.tasks[0].progress.bytes = 1400;
  const result = await f.watchdog.tick();
  assert.equal(result.assessed, 1); assert.equal(result.actions.length, 1); assert.equal(result.actions[0].action, 'observe');
  const prompt = f.prompts[0], data = JSON.parse(prompt.split('\n').at(-1));
  assert.equal(data.goal, f.value.tasks[0].instructions);
  assert.equal(data.progress.tests, 'Not yet run'); assert.equal(data.progress.evidence.length, 5000);
  assert.ok(data.progress.events.includes('1 failing assertion')); assert.equal(data.progress.observedBytes, 1400);
  assert.ok(prompt.includes('活动频繁不等于有进展')); assert.ok(prompt.includes('不执行命令'));
  assert.equal(f.saved.at(-1).assessments['task-1'].decision.action, 'observe');
  assert.equal(f.requests[0].action, 'observe');
});

test('strict semantic output rejects cross-task, infrastructure, arbitrary fields and malformed commands', () => {
  for (const raw of ['{}', 'not json', '```json\n{}', decision('task-2'), decision('task-1', 'run_shell'),
    decision('task-1', 'restart_controller'), decision('task-1', 'steer'), decision('task-1', 'pause', { command: 'arbitrary' }),
    decision('task-1', 'observe', { instruction: 'x'.repeat(2401) }), JSON.stringify({ taskId: 'task-1', action: 'observe', reason: '' })])
    assert.throws(() => parseWatchdogDecision(raw, task()));
  assert.equal(parseWatchdogDecision('```json\n' + decision('task-1') + '\n```', task()).action, 'observe');
});

test('one semantic correction is allowed per attempt and another requested correction pauses safely', async () => {
  const f = fixture({ classify: async () => decision('task-1', 'steer', { instruction: 'Compare the diff with the existing tests before further edits.' }) });
  await f.watchdog.tick();
  assert.equal(f.requests[0].action, 'steer'); assert.equal(f.requests[0].generation, 'controller-a');
  await f.watchdog.tick(); assert.equal(f.prompts.length, 1);
  f.advance(100); await f.watchdog.tick();
  assert.equal(f.requests[1].action, 'pause'); assert.equal(f.prompts.length, 2);
  f.value.tasks[0].attempt = 2; f.advance(100); await f.watchdog.tick();
  assert.equal(f.requests[2].action, 'steer');
});

test('uncertain, paused, failed and completed tasks are never automatically resumed', async () => {
  const f = fixture();
  f.value.tasks = ['uncertain', 'paused', 'failed', 'completed'].map((status, i) => task('task-' + i, { status }));
  assert.equal((await f.watchdog.tick()).assessed, 0);
  assert.equal(f.prompts.length, 0); assert.equal(f.requests.length, 0);
});

test('a lost action acknowledgement survives restart and retries one stable id without a second model run', async () => {
  let lose = true;
  const f = fixture({ classify: async () => decision('task-1', 'pause'), act: async () => {
    if (lose) { lose = false; throw new Error('Synthetic acknowledgement loss after acceptance.'); }
    return { accepted: true };
  } });
  assert.equal((await f.watchdog.tick()).status, 'degraded');
  assert.equal(f.saved.at(-1).pending.length, 1);
  const restored = fixture({ state: clone(f.saved.at(-1)) });
  await restored.watchdog.tick();
  assert.equal(restored.prompts.length, 0);
  assert.equal(restored.requests[0].id, f.requests[0].id);
  assert.equal(restored.saved.at(-1).pending.length, 0);
});

test('a controller generation or task attempt change discards queued stale interventions', async () => {
  for (const change of ['generation', 'attempt']) {
    const f = fixture({ classify: async () => decision('task-1', 'pause'), act: async () => { throw new Error('Synthetic lost ack'); } });
    await f.watchdog.tick();
    const restored = fixture({ state: clone(f.saved.at(-1)) });
    if (change === 'generation') restored.value.generation = 'controller-b'; else restored.value.tasks[0].attempt = 2;
    restored.value.tasks[0].status = 'paused';
    await restored.watchdog.tick();
    assert.equal(restored.requests.length, 0); assert.equal(restored.saved.at(-1).pending.length, 0);
    assert.ok(restored.saved.at(-1).diagnostics.some(item => item.code === 'stale_action'));
  }
});

test('stale heartbeat sends only a controller notice and never delivers a pending task steer', async () => {
  const f = fixture({ classify: async () => decision('task-1', 'steer', { instruction: 'Review the actual test evidence.' }),
    act: async () => { throw new Error('Synthetic lost acknowledgement'); } });
  await f.watchdog.tick();
  const restored = fixture({ state: clone(f.saved.at(-1)) });
  restored.value.heartbeat = iso(1);
  const result = await restored.watchdog.tick();
  assert.equal(result.status, 'needs_attention'); assert.equal(restored.prompts.length, 0);
  assert.deepEqual(restored.requests.map(item => item.taskId), [null]);
  assert.equal(restored.saved.at(-1).pending.filter(item => item.taskId === 'task-1').length, 1);
});

test('model failures are bounded, back off, notify and block further requests after the configured budget', async () => {
  const f = fixture({ config: { maxConsecutiveModelFailures: 2 }, classify: async () => { throw new Error('Private model credential details must not be logged.'); } });
  await f.watchdog.tick(); await f.watchdog.tick(); assert.equal(f.prompts.length, 1);
  f.advance(100); assert.equal((await f.watchdog.tick()).status, 'needs_attention');
  f.advance(100000); await f.watchdog.tick();
  assert.equal(f.prompts.length, 2); assert.equal(f.watchdog.state.modelBlocked, true);
  assert.equal(f.requests[0].taskId, null); assert.equal(f.requests[0].action, 'notify');
  assert.ok(!JSON.stringify(f.saved).includes('Private model credential'));
});

test('per-tick budget and least-recent assessment prevent starvation, concurrent ticks coalesce', async () => {
  let resolveModel;
  const f = fixture({ config: { maxAssessmentsPerTick: 2 }, classify: prompt => {
    const data = JSON.parse(prompt.split('\n').at(-1));
    if (!resolveModel) return new Promise(done => { resolveModel = () => done(decision(data.id)); });
    return decision(data.id);
  } });
  f.value.tasks = [task('task-1'), task('task-2'), task('task-3'), task('task-4')];
  const first = f.watchdog.tick(), concurrent = f.watchdog.tick();
  assert.equal(first, concurrent);
  await until(() => resolveModel); resolveModel(); await first;
  assert.equal(f.prompts.length, 2);
  await f.watchdog.tick();
  assert.equal(f.prompts.length, 4);
  assert.deepEqual(f.prompts.map(prompt => JSON.parse(prompt.split('\n').at(-1)).id), ['task-1', 'task-2', 'task-3', 'task-4']);
});

test('controller and source failures produce persisted diagnostics without running work', async () => {
  const down = fixture({ snapshot: async () => { throw new Error('Bearer synthetic-private-token'); } });
  assert.equal((await down.watchdog.tick()).status, 'needs_attention');
  assert.equal(down.prompts.length, 0); assert.ok(!JSON.stringify(down.saved).includes('synthetic-private-token'));
  const source = fixture(); source.value.tasks = []; source.value.sources = { github: { status: 'offline' } };
  assert.equal((await source.watchdog.tick()).status, 'degraded');
  await source.watchdog.tick();
  assert.equal(source.requests.length, 1); assert.equal(source.requests[0].taskId, null);
});

test('malformed/oversized controller snapshots and prototype-like task ids fail closed', async () => {
  for (const change of [s => { s.tasks.push(clone(s.tasks[0])); }, s => { s.tasks[0].id = '__proto__'; },
    s => { s.generation = {}; }, s => { s.heartbeat = 'invalid'; }, s => { s.tasks[0].progress.summary = 'x'.repeat(1050000); }]) {
    const f = fixture(); change(f.value);
    assert.equal((await f.watchdog.tick()).status, 'needs_attention'); assert.equal(f.prompts.length, 0);
  }
});

test('real HTTP snapshot/actions use bearer and reject non-HTTPS remote hosts and redirects', async t => {
  const requests = [];
  const http = await httpFixture(t, async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-watchdog-control');
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body });
    if (request.url === '/api/supervisor/snapshot') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ generation: 'g', heartbeat: iso(Date.now()), tasks: [] })); }
    else { response.setHeader('Content-Type', 'application/json'); response.end('{"accepted":true}'); }
  });
  const client = controllerClient({ controllerUrl: http.url, token: 'synthetic-watchdog-control' });
  assert.equal((await client.snapshot()).generation, 'g'); await client.act({ id: 'a', taskId: null, action: 'notify', reason: 'Synthetic health check' });
  assert.deepEqual(requests.map(item => [item.method, item.url]), [['GET', '/api/supervisor/snapshot'], ['POST', '/api/supervisor/actions']]);
  assert.equal(JSON.parse(requests[1].body).id, 'a');
  assert.throws(() => controllerClient({ controllerUrl: 'http://example.com', token: 'x' }), /HTTPS/);
  assert.throws(() => controllerClient({ controllerUrl: http.url + '/path', token: 'x' }), /origin/);
  const redirect = await httpFixture(t, (_request, response) => { response.writeHead(302, { location: http.url }); response.end(); });
  await assert.rejects(controllerClient({ controllerUrl: redirect.url, token: 'synthetic' }).snapshot());
});

test('HTTP oversized replies and failed status do not get treated as healthy snapshots', async t => {
  const http = await httpFixture(t, (request, response) => {
    if (request.headers.authorization === 'Bearer fail') { response.writeHead(401); response.end('{}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('x'.repeat(100)); response.end('x'.repeat(100));
  });
  await assert.rejects(controllerClient({ controllerUrl: http.url, token: 'fail' }).snapshot(), /HTTP 401/);
  await assert.rejects(controllerClient({ controllerUrl: http.url, token: 'ok', maxSnapshotBytes: 150 }).snapshot(), /budget/);
});

test('independent service persists state under an exclusive lock and restores its pending diagnostics', async t => {
  const directory = await temporary(t), path = join(directory, 'watchdog.json');
  const http = await httpFixture(t, (_request, response) => { response.end(JSON.stringify({ generation: 'g', heartbeat: iso(Date.now()), tasks: [] })); });
  const config = { controllerUrl: http.url, statePath: path, intervalMs: 10 };
  const dependencies = { env: { SUPER_AGENT_CONTROL_TOKEN: 'synthetic' }, classify: async () => { throw new Error('No task should be classified'); } };
  const service = await startWatchdog(config, dependencies);
  t.after(() => service.stop());
  await until(async () => { try { return JSON.parse(await readFile(path, 'utf8')).watchdog.status === 'observing'; } catch { return false; } });
  await assert.rejects(startWatchdog(config, dependencies), /Another bridge|lease owner is still alive/);
  await service.stop();
  await assert.rejects(access(path + '.lock'), { code: 'ENOENT' });
  const restored = await startWatchdog(config, dependencies); await restored.stop();
});

test('owner metadata stays fresh during assessment, hides the token and accepts only nonce-matched external stop', async t => {
  const directory = await temporary(t), statePath = join(directory, 'watchdog.json');
  let resolveModel;
  const http = await httpFixture(t, async (request, response) => {
    if (request.method === 'GET') response.end(JSON.stringify({ generation: 'g', heartbeat: iso(Date.now()), tasks: [task()] }));
    else { for await (const _chunk of request) { /* consume the bounded synthetic body */ } response.end('{"accepted":true}'); }
  });
  const service = await startWatchdog({ controllerUrl: http.url, statePath, intervalMs: 20, taskAgeMs: 1 }, {
    env: { SUPER_AGENT_CONTROL_TOKEN: 'synthetic-owner-token' }, classify: async () => new Promise(done => { resolveModel = () => done(decision('task-1')); }),
  });
  let finished = false; service.completion.then(() => { finished = true; });
  t.after(async () => { resolveModel?.(); await service.stop(); });
  await until(() => resolveModel);
  const first = JSON.parse(await readFile(service.ownerPath, 'utf8'));
  assert.equal(first.pid, process.pid); assert.equal(first.status, 'assessing');
  assert.equal(first.tokenHash, createHash('sha256').update('synthetic-owner-token').digest('hex'));
  assert.ok(!JSON.stringify(first).includes('synthetic-owner-token'));
  await writeFile(service.ownerPath + '.stop', JSON.stringify({ pid: first.pid, nonce: 'old-owner' }));
  await until(async () => Date.parse(JSON.parse(await readFile(service.ownerPath, 'utf8')).heartbeat) > Date.parse(first.heartbeat));
  assert.equal(finished, false);
  resolveModel();
  await writeFile(service.ownerPath + '.stop', JSON.stringify({ pid: first.pid, nonce: first.nonce }));
  await service.completion;
  const final = JSON.parse(await readFile(service.ownerPath, 'utf8'));
  assert.equal(final.status, 'stopped'); assert.equal(final.nonce, first.nonce);
  await assert.rejects(access(statePath + '.lock'), { code: 'ENOENT' });
});

test('registered recovery persists its reservation and launches only a fixed dead-PID registration', async t => {
  const directory = await temporary(t), runtimePath = join(directory, 'controller.json');
  const registration = { runtimePath, instanceId: '12345678-1234-1234-1234-123456789abc', executablePath: process.execPath,
    args: ['-e', 'process.exit(0)'], cwd: directory, maxRestarts: 1, cooldownMs: 1000 };
  await writeFile(runtimePath, JSON.stringify({ ...registration, pid: 900000001 }));
  const calls = [], saved = [], state = {}, children = [];
  const result = await restartRegisteredController(registration, state, {
    kill(pid, signal) { calls.push([pid, signal]); const error = new Error('No such synthetic PID'); error.code = 'ESRCH'; throw error; },
    save: async value => { saved.push(clone(value)); },
    launch(...args) { const child = spawn(...args); children.push(once(child, 'close')); return child; },
  });
  await Promise.all(children);
  assert.equal(result.restarted, true); assert.deepEqual(calls, [[900000001, 0]]);
  assert.equal(saved[0].restarts[0].status, 'reserved'); assert.equal(saved[1].restarts[0].status, 'started');
  assert.equal((await restartRegisteredController(registration, state)).reason, 'restart_budget');
  const alive = await restartRegisteredController(registration, {}, { kill() {} });
  assert.equal(alive.reason, 'registered_pid_still_exists');
  const denied = await restartRegisteredController(registration, {}, { kill() { const error = new Error('Unknown PID identity'); error.code = 'EPERM'; throw error; } });
  assert.equal(denied.reason, 'process_identity_unconfirmed');
  await writeFile(runtimePath, JSON.stringify({ ...registration, instanceId: 'replaced', pid: 900000001 }));
  assert.equal((await restartRegisteredController(registration, {})).reason, 'registration_mismatch');
});

test('a failed persisted restart reservation prevents process launch', async t => {
  const directory = await temporary(t), runtimePath = join(directory, 'controller.json');
  const registration = { runtimePath, instanceId: '12345678-1234-1234-1234-123456789abc', executablePath: process.execPath, args: ['-v'], cwd: directory };
  await writeFile(runtimePath, JSON.stringify({ ...registration, pid: 900000001 }));
  let launches = 0;
  await assert.rejects(restartRegisteredController(registration, {}, {
    kill() { const error = new Error('Absent'); error.code = 'ESRCH'; throw error; },
    save: async () => { throw new Error('Synthetic durable state failure'); }, launch() { launches++; },
  }), /durable state failure/);
  assert.equal(launches, 0);
});

test('dead Watchdog recovery requires identity and completed native proof, never only a missing Node PID', async t => {
  const directory = await temporary(t), statePath = join(directory, 'watchdog.json'), runsPath = join(directory, 'runs');
  const token = 'synthetic-recovery-token', controllerUrl = 'http://127.0.0.1:18202';
  await writeFile(statePath + '.lock', JSON.stringify({ pid: 900000001 }));
  const owner = { pid: 900000001, nonce: 'saved-owner', statePath, controllerUrl, executablePath: process.execPath,
    tokenHash: createHash('sha256').update(token).digest('hex') };
  await writeFile(statePath + '.runtime.json', JSON.stringify(owner));
  const options = { statePath, runsPath, controllerUrl, token };
  const absent = { kill() { const error = new Error('Synthetic absent PID'); error.code = 'ESRCH'; throw error; } };
  await verifyWatchdogRecovery(options, absent);
  const path = join(runsPath, 'classifier-synthetic'); await mkdir(path, { recursive: true });
  await writeFile(join(path, 'bridge-run.json'), JSON.stringify({ kind: 'classifier' }));
  await assert.rejects(verifyWatchdogRecovery(options, absent), /orphan Watchdog classifier/);
  await writeFile(join(path, 'run.json'), JSON.stringify({ status: 'running', supervisorPid: 900000002 }));
  await assert.rejects(verifyWatchdogRecovery(options, absent), /orphan Watchdog classifier/);
  await writeFile(join(path, 'run.json'), JSON.stringify({ status: 'completed', supervisorPid: 900000002, finishedUtc: iso(Date.now()) }));
  await verifyWatchdogRecovery(options, absent);
  await assert.rejects(verifyWatchdogRecovery(options, { kill(pid) { if (pid === 900000002) return; absent.kill(); } }), /launcher still exists/);
  await writeFile(join(path, 'bridge-supervision.json'), JSON.stringify({ status: 'cancelled', processTreeStopped: true }));
  await verifyWatchdogRecovery(options, absent);
  await assert.rejects(verifyWatchdogRecovery({ ...options, token: 'changed' }, absent), /identity differs/);
  await assert.rejects(verifyWatchdogRecovery(options, { kill() {} }), /still alive/);
  assert.equal(JSON.parse(await readFile(statePath + '.lock', 'utf8')).pid, 900000001, 'The proof phase never deletes a process lease');
});

test('service safely recovers a dead supervisor with no admitted classifier and retains its own persistent state', async t => {
  const directory = await temporary(t), statePath = join(directory, 'watchdog.json'), runsPath = join(directory, 'runs');
  const token = 'synthetic-safe-recovery', oldPid = 900000001;
  const http = await httpFixture(t, (_request, response) => { response.end(JSON.stringify({ generation: 'g', heartbeat: iso(Date.now()), tasks: [] })); });
  await writeFile(statePath + '.lock', JSON.stringify({ pid: oldPid }));
  await writeFile(statePath + '.runtime.json', JSON.stringify({ pid: oldPid, nonce: 'old', executablePath: process.execPath, statePath, controllerUrl: http.url,
    tokenHash: createHash('sha256').update(token).digest('hex') }));
  const service = await startWatchdog({ statePath, controllerUrl: http.url, intervalMs: 20, harness: { runsPath } }, {
    env: { SUPER_AGENT_CONTROL_TOKEN: token }, classify: async () => assert.fail('Empty snapshot must not call a model'),
  });
  await service.stop();
  await assert.rejects(access(statePath + '.lock'), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(statePath + '.runtime.json', 'utf8')).status, 'stopped');
});

test('standalone Watchdog runs in another process with read-only DSH and no inherited control token', { skip: process.platform !== 'win32' }, async t => {
  const directory = await temporary(t), cwd = join(directory, 'readonly project'); await mkdir(cwd);
  const cliPath = join(directory, 'fake watchdog.ps1');
  await writeFile(cliPath, String.raw`
if ($args -contains '--version') { $global:LASTEXITCODE=0; Write-Output 'fake-watchdog 0.3-test'; return }
$prompt=($input | Out-String).Trim()
$task=($prompt -split "\n")[-1] | ConvertFrom-Json
$i=[Array]::IndexOf($args, '--permission-mode')
$permission=$args[$i+1]
$seen=Test-Path Env:SUPER_AGENT_CONTROL_TOKEN
$seenCustom=Test-Path Env:CUSTOM_SUPERVISOR_TOKEN
$seenRestart=Test-Path Env:SUPER_AGENT_RESTART_TOKEN_BUNDLE
$answer=@{taskId=$task.id; action='notify'; reason="permission=$permission,controlTokenSeen=$seen,customTokenSeen=$seenCustom,restartTokenSeen=$seenRestart"} | ConvertTo-Json -Compress
$global:LASTEXITCODE=0
@{type='session'; sessionId='session-watchdog-test'} | ConvertTo-Json -Compress
@{type='final'; sessionId='session-watchdog-test'; reason=@{kind='completed'}; text=$answer} | ConvertTo-Json -Depth 5 -Compress
`);
  const actions = [];
  const http = await httpFixture(t, async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-child-controller-token');
    if (request.method === 'GET') { response.end(JSON.stringify({ generation: 'standalone', heartbeat: iso(Date.now()), tasks: [task()] })); return; }
    let body = ''; for await (const chunk of request) body += chunk; actions.push(JSON.parse(body)); response.end('{"accepted":true}');
  });
  const configPath = join(directory, 'config.json'), statePath = join(directory, 'watchdog.json');
  await writeFile(configPath, JSON.stringify({ controllerUrl: http.url, tokenEnv: 'CUSTOM_SUPERVISOR_TOKEN', statePath, intervalMs: 50, taskAgeMs: 1,
    harness: { cwd, cliPath, runsPath: join(directory, 'runs'), sessionMapPath: join(directory, 'sessions.json'),
      auth: 'environment', powershellPath: process.env.TEAM_RELAY_TEST_POWERSHELL ?? 'pwsh', classificationTimeoutMs: 15000 } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../super-watchdog.mjs', import.meta.url)), '--config', configPath], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, CUSTOM_SUPERVISOR_TOKEN: 'synthetic-child-controller-token', SUPER_AGENT_CONTROL_TOKEN: 'synthetic-unused-token', SUPER_AGENT_RESTART_TOKEN_BUNDLE: '{"TEAM_RELAY_BOT_TOKEN":"synthetic-restart-only"}' },
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null) { if (child.connected) child.send({ type: 'stop-watchdog' }); else child.kill(); } await closed; });
  await until(() => { if (child.exitCode !== null) throw new Error('Watchdog child failed: ' + stderr); return actions.length > 0; }, 20000);
  assert.equal(actions[0].reason, 'permission=read-only,controlTokenSeen=False,customTokenSeen=False,restartTokenSeen=False');
  child.send({ type: 'stop-watchdog' });
  const [exit] = await closed; assert.equal(exit, 0, stderr);
  await assert.rejects(access(statePath + '.lock'), { code: 'ENOENT' });
});

test('an abruptly orphaned read-only invocation is never rerun without native completion proof', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-watchdog-orphan-'));
  const cwd = join(directory, 'readonly project'), runsPath = join(directory, 'runs'); await mkdir(cwd);
  const cliPath = join(directory, 'fake slow classifier.ps1');
  await writeFile(cliPath, String.raw`
$prompt=($input | Out-String).Trim()
$task=($prompt -split "\n")[-1] | ConvertFrom-Json
$global:LASTEXITCODE=0
@{type='session'; sessionId='session-watchdog-orphan-test'} | ConvertTo-Json -Compress
Start-Sleep -Seconds 3
$answer=@{taskId=$task.id; action='observe'; reason='Synthetic classifier completed naturally.'} | ConvertTo-Json -Compress
@{type='final'; sessionId='session-watchdog-orphan-test'; reason=@{kind='completed'}; text=$answer} | ConvertTo-Json -Depth 5 -Compress
`);
  const token = 'synthetic-watchdog-orphan-token';
  const http = createServer(async (request, response) => {
    if (request.method === 'GET') response.end(JSON.stringify({ generation: 'orphan-proof', heartbeat: iso(Date.now()), tasks: [task()] }));
    else { for await (const _chunk of request) { /* consume */ } response.end('{"accepted":true}'); }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const controllerUrl = `http://127.0.0.1:${http.address().port}`, statePath = join(directory, 'state.json');
  const config = { controllerUrl, statePath, intervalMs: 10000, taskAgeMs: 1, harness: { cwd, cliPath, runsPath,
    sessionMapPath: join(directory, 'sessions.json'), auth: 'environment', classificationTimeoutMs: 15000 } };
  const configPath = join(directory, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../super-watchdog.mjs', import.meta.url)), '--config', configPath], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, SUPER_AGENT_CONTROL_TOKEN: token },
  });
  const closed = once(child, 'close'); let runDirectory, nativePid;
  const nativeGone = async () => {
    if (!nativePid) return true;
    try { process.kill(nativePid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  };
  t.after(async () => {
    try {
      if (child.exitCode === null) child.kill('SIGKILL'); await closed;
      await until(nativeGone, 10000);
    } finally {
      http.closeAllConnections(); await new Promise(done => http.close(done));
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); await rm(directory, { recursive: true, force: true });
    }
  });
  await until(async () => {
    try {
      const names = await readdir(runsPath); runDirectory = names.length ? join(runsPath, names[0]) : undefined;
      if (!runDirectory) return false;
      const native = JSON.parse(await readFile(join(runDirectory, 'run.json'), 'utf8'));
      nativePid = native.supervisorPid;
      return native.status === 'running';
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  });
  child.kill('SIGKILL'); await closed;
  let classifications = 0;
  const dependencies = { env: { SUPER_AGENT_CONTROL_TOKEN: token }, classify: async () => { classifications++; return decision('task-1'); } };
  await assert.rejects(startWatchdog(config, dependencies), /orphan Watchdog classifier/);
  assert.equal(classifications, 0, 'A second supervisor must not issue a model request beside the orphan');
  assert.equal(JSON.parse(await readFile(statePath + '.lock', 'utf8')).pid, child.pid, 'Unknown native effects retain the original supervisor lease');
});
