import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { controlSecret, recoverManagedRuntime, reusableWatchdog, stopWatchdog } from '../super-lifecycle.mjs';
import { ManagedRuntime } from '../managed-runtime.mjs';
import { SuperStore } from '../super-store.mjs';
import { createControlServer } from '../super-agent.mjs';
import { restartRegisteredController } from '../super-watchdog.mjs';
import { SuperCoordinator } from '../super-coordinator.mjs';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-super-lifecycle-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function until(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 15)); }
  assert.fail('Synthetic lifecycle condition did not occur.');
}
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'close'); return child.pid;
}
async function runtimeFixture(t) {
  const directory = await temporary(t), runtimePath = join(directory, 'runtime.json');
  const runtime = new ManagedRuntime(runtimePath, randomUUID(), join(directory, 'config.json'));
  const owner = { ...runtime.record, executablePath: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), pid: await deadPid(), status: 'listening' };
  await writeFile(runtimePath, JSON.stringify(owner));
  return { directory, runtimePath, runtime, owner };
}

test('controller secret persists across restarts and malformed or short configured credentials fail closed', async t => {
  const directory = await temporary(t), path = join(directory, 'controller.secret');
  const value = await controlSecret(path);
  assert.match(value, /^[a-f0-9]{64}$/); assert.equal(await controlSecret(path), value);
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => controlSecret(path))), Array(8).fill(value));
  await assert.rejects(controlSecret(path, 'short'), /Invalid controller credential/);
  await assert.rejects(controlSecret(path, 'with whitespace '.repeat(4)), /Invalid controller credential/);
  assert.equal(await controlSecret(path, 's'.repeat(64)), 's'.repeat(64));
  assert.equal(await controlSecret(path), value, 'A process-specific environment override must not overwrite the saved credential');
  await writeFile(path, 'partial-file');
  await assert.rejects(controlSecret(path), /Invalid saved controller credential/);
});

test('managed controller recovers a verified dead runtime and preserves its previous record before starting', async t => {
  const { directory, runtimePath, runtime, owner } = await runtimeFixture(t);
  await recoverManagedRuntime(runtime);
  await assert.rejects(access(runtimePath), { code: 'ENOENT' });
  const archived = (await readdir(directory)).filter(name => name.includes('.crashed-'));
  assert.equal(archived.length, 1); assert.deepEqual(JSON.parse(await readFile(join(directory, archived[0]), 'utf8')), owner);
  await runtime.start(() => {}); await runtime.finish(false);
  assert.equal(JSON.parse(await readFile(runtimePath, 'utf8')).status, 'stopped');
});

test('explicit stop and intentional stopped state win over automatic managed recovery', async t => {
  for (const status of ['stopping', 'stopped']) {
    const f = await runtimeFixture(t); f.owner.status = status; await writeFile(f.runtimePath, JSON.stringify(f.owner));
    await assert.rejects(recoverManagedRuntime(f.runtime), /intentionally stopped/);
    assert.equal(JSON.parse(await readFile(f.runtimePath, 'utf8')).status, status);
  }
  const f = await runtimeFixture(t);
  await writeFile(f.runtime.stopPath, JSON.stringify({ instanceId: f.owner.instanceId }));
  await assert.rejects(recoverManagedRuntime(f.runtime), /explicit stop request/);
  assert.equal((await readdir(f.directory)).filter(name => name.includes('.crashed-')).length, 0);
});

test('managed recovery rejects live PIDs and nonce, executable or argument mismatches', async t => {
  const f = await runtimeFixture(t);
  for (const changes of [{ pid: process.pid }, { instanceId: randomUUID() }, { executablePath: 'another executable' }, { args: ['different-entrypoint'] }, { cwd: f.directory }]) {
    const record = { ...f.owner, ...changes }; await writeFile(f.runtimePath, JSON.stringify(record));
    await assert.rejects(recoverManagedRuntime(f.runtime), /exists|mismatch/);
    assert.deepEqual(JSON.parse(await readFile(f.runtimePath, 'utf8')), record);
  }
});

test('super state reclaims only a dead controller lease and serializes competing recoveries', async t => {
  const directory = await temporary(t), path = join(directory, 'controller-state.json'), workerLock = join(directory, 'worker.lock');
  await writeFile(path + '.lock', JSON.stringify({ pid: await deadPid() }));
  await writeFile(workerLock, 'unconfirmed-native-worker-lease');
  const stores = [new SuperStore(path), new SuperStore(path)];
  const results = await Promise.allSettled(stores.map(store => store.lock()));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(await readFile(workerLock, 'utf8'), 'unconfirmed-native-worker-lease');
  for (let i = 0; i < results.length; i++) if (results[i].status === 'fulfilled') await stores[i].unlock();
  await writeFile(path + '.lock', JSON.stringify({ pid: process.pid }));
  await assert.rejects(new SuperStore(path).lock(), /still alive/);
  assert.equal(JSON.parse(await readFile(path + '.lock', 'utf8')).pid, process.pid);
});

async function liveWatchdog(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-super-lifecycle-')), statePath = join(directory, 'watchdog.json'), configPath = join(directory, 'watchdog-config.json');
  const token = 'synthetic-lifecycle-controller-token-'.repeat(2);
  const http = createServer((_request, response) => { response.end(JSON.stringify({ generation: 'synthetic-live-controller', heartbeat: new Date().toISOString(), tasks: [] })); });
  let child, closed;
  t.after(async () => {
    try {
      if (child?.exitCode === null && child.signalCode === null) { if (child.connected) child.send({ type: 'stop-watchdog' }); else child.kill(); }
      if (closed) await closed;
    } finally {
      http.closeAllConnections(); await new Promise(done => http.close(done));
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
      await rm(directory, { recursive: true, force: true });
    }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const controllerUrl = `http://127.0.0.1:${http.address().port}`;
  const cwd = join(directory, 'readonly-cwd'); await mkdir(cwd);
  const cliPath = join(directory, 'unused-dsh.ps1'); await writeFile(cliPath, '# This fixture never invokes a model.');
  await writeFile(configPath, JSON.stringify({ controllerUrl, statePath, intervalMs: 20,
    harness: { cwd, cliPath, runsPath: join(directory, 'runs'), sessionMapPath: join(directory, 'sessions.json') } }));
  child = spawn(process.execPath, [fileURLToPath(new URL('../super-watchdog.mjs', import.meta.url)), '--config', configPath], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, SUPER_AGENT_CONTROL_TOKEN: token },
  });
  closed = once(child, 'close'); let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ownerPath = statePath + '.runtime.json';
  await until(async () => { if (child.exitCode !== null) throw new Error('Watchdog fixture exited: ' + stderr); try { return JSON.parse(await readFile(ownerPath, 'utf8')).status === 'observing'; } catch { return false; } });
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  return { directory, statePath, ownerPath, owner, token, controllerUrl, child, closed };
}

test('reusable independent Watchdog requires same controller, same secret and a genuine fresh heartbeat', async t => {
  const f = await liveWatchdog(t), expected = { token: f.token, controllerUrl: f.controllerUrl, statePath: f.statePath };
  assert.equal((await reusableWatchdog(f.ownerPath, expected)).pid, f.child.pid);
  await assert.rejects(reusableWatchdog(f.ownerPath, { ...expected, token: 'different-secret' }), /verified/);
  await assert.rejects(reusableWatchdog(f.ownerPath, { ...expected, controllerUrl: 'http://127.0.0.1:1' }), /verified/);
  await assert.rejects(reusableWatchdog(f.ownerPath, { ...expected, statePath: join(f.directory, 'another-state.json') }), /verified/);
  // No metadata edits: supplying a different observation time deterministically checks stale/future claims.
  const heartbeat = Date.parse(f.owner.heartbeat);
  await assert.rejects(reusableWatchdog(f.ownerPath, { ...expected, now: heartbeat + 100000 }), /verified/);
  await assert.rejects(reusableWatchdog(f.ownerPath, { ...expected, now: heartbeat - 100000 }), /verified|future/);
});

test('root lifecycle gracefully stops a reused independent Watchdog through its registered nonce', async t => {
  const f = await liveWatchdog(t);
  assert.equal(await stopWatchdog(f.ownerPath, null, 5000), true);
  const [code] = await f.closed; assert.equal(code, 0);
  assert.equal(JSON.parse(await readFile(f.ownerPath, 'utf8')).status, 'stopped');
  assert.equal(await reusableWatchdog(f.ownerPath, { token: f.token, controllerUrl: f.controllerUrl, statePath: f.statePath }), null);
  await assert.rejects(access(f.statePath + '.lock'), { code: 'ENOENT' });
});

test('stale Watchdog metadata cannot substitute another live Node PID or forge its arguments and creation time', async t => {
  const f = await liveWatchdog(t), stalePath = join(f.directory, 'stale-owner.json');
  const expected = { token: f.token, controllerUrl: f.controllerUrl, statePath: f.statePath };
  assert.notEqual(process.pid, f.owner.pid);
  // The replacement PID really exists and uses the same Node executable. Only
  // a real OS argument/creation-time query can distinguish it from this record.
  await writeFile(stalePath, JSON.stringify({ ...f.owner, pid: process.pid }));
  await assert.rejects(reusableWatchdog(stalePath, expected), /process identity could not be verified/);
  await writeFile(stalePath, JSON.stringify({ ...f.owner, args: [f.owner.args[0], '--config', join(f.directory, 'another-config.json')] }));
  await assert.rejects(reusableWatchdog(stalePath, expected), /process identity could not be verified/);
  if (process.platform === 'win32') {
    await writeFile(stalePath, JSON.stringify({ ...f.owner, startedAt: new Date(Date.parse(f.owner.startedAt) + 60000).toISOString() }));
    await assert.rejects(reusableWatchdog(stalePath, expected), /process identity could not be verified/);
  }
  assert.doesNotThrow(() => process.kill(f.owner.pid, 0), 'Identity refusal must never terminate the genuine supervisor');
});

test('registered Watchdog recovery does not launch after a matching stop marker or stopped status', async t => {
  const directory = await temporary(t), runtimePath = join(directory, 'registered.json');
  const registered = { runtimePath, instanceId: randomUUID(), executablePath: process.execPath, args: ['-e', 'process.exit(0)'], cwd: directory };
  const owner = { ...registered, pid: await deadPid(), status: 'listening' };
  await writeFile(runtimePath, JSON.stringify(owner));
  await writeFile(runtimePath + '.stop', JSON.stringify({ instanceId: owner.instanceId }));
  let launches = 0;
  assert.equal((await restartRegisteredController(registered, {}, { launch: () => { launches++; } })).reason, 'explicit_stop');
  await writeFile(runtimePath, JSON.stringify({ ...owner, status: 'stopped' }));
  assert.equal((await restartRegisteredController(registered, {}, { launch: () => { launches++; } })).reason, 'intentionally_stopped');
  assert.equal(launches, 0);
});

test('control server separates supervisor and task bearer capabilities and forwards context pagination', async t => {
  const secret = 'c'.repeat(64), taskToken = id => /^T\d{6}$/.test(id) ? createHmac('sha256', secret).update(id).digest('hex') : '';
  const calls = [], coordinator = { snapshot: () => ({ generation: 'g', tasks: [] }), action: async () => ({ accepted: true }),
    readContext: (id, reference, options) => { calls.push({ id, reference, ...options }); return { reference, ...options }; } };
  const control = createControlServer(coordinator, { token: secret, taskTokenFor: taskToken, port: 0 });
  const address = await control.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(() => control.close());
  const call = (route, bearer, body) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const input = { taskId: 'T000001', reference: 'thread:test', offset: 5, limit: 123, linkOffset: 40 };
  assert.equal((await call('/api/context/read', '', { ...input, taskId: 'invalid' })).status, 403);
  assert.equal((await call('/api/context/read', secret, input)).status, 403);
  assert.equal((await call('/api/context/read', taskToken('T000002'), input)).status, 403);
  assert.equal((await call('/api/supervisor/snapshot', taskToken('T000001'))).status, 403);
  assert.equal((await call('/api/supervisor/snapshot', secret)).status, 200);
  const response = await call('/api/context/read', taskToken('T000001'), input);
  assert.equal(response.status, 200); assert.equal((await response.json()).linkOffset, 40);
  assert.deepEqual(calls, [{ id: 'T000001', reference: 'thread:test', offset: 5, limit: 123, linkOffset: 40 }]);
});

test('supervisor snapshot retains older active tasks and bounds facts independently of long chat history', () => {
  const tasks = {}, now = new Date().toISOString();
  for (let i = 1; i <= 125; i++) {
    const id = 'T' + String(i).padStart(6, '0');
    tasks[id] = { id, status: i === 1 ? 'running' : 'completed', summary: 'Synthetic task', instructions: 'Fix the synthetic issue',
      attempt: 1, createdAt: now, startedAt: now, updatedAt: now,
      event: { text: 'synthetic chat'.repeat(2000) }, inputs: Array.from({ length: 6 }, () => ({ text: 'x'.repeat(30000) })),
      progress: { at: now, summary: 'Actual tool event', events: [{ type: 'tool', text: 'pytest' }] } };
  }
  const coordinator = new SuperCoordinator({ state: { superAgent: { heartbeat: now, tasks, sources: {} } } });
  const snapshot = coordinator.snapshot();
  assert.ok(snapshot.tasks.some(task => task.id === 'T000001'), 'A still-running task cannot disappear merely because later tasks finished');
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 1048576, 'Supervision facts must fit the independent Watchdog budget');
});

test('task context denies foreign conversation material and revalidates human and bot membership', () => {
  const bot = { id: 'bot', is_bot: true }, person = { id: 'human', is_bot: false };
  const stored = { id: 'T000001', projectId: 'p', conversationId: 'c1', event: { conversation_id: 'c1', sender: person } };
  const graph = {
    own: { id: 'own', kind: 'trigger', projectId: 'p', conversations: ['c1'], text: 'Own synthetic context', links: [] },
    foreign: { id: 'foreign', kind: 'trigger', projectId: 'p', conversations: ['c2'], text: 'Other synthetic context', links: [] },
  };
  const coordinator = new SuperCoordinator({ state: { superAgent: { tasks: { T000001: stored }, graph } }, bot,
    config: { conversationIds: ['c1', 'c2'], senderIds: ['human'] } });
  coordinator.conversations = [{ id: 'c1', members: [bot, person] }, { id: 'c2', members: [bot, person] }];
  assert.equal(coordinator.readContext('T000001', 'own').text, 'Own synthetic context');
  assert.throws(() => coordinator.readContext('T000001', 'foreign'), /authorized task scope/);
  coordinator.conversations[0].members = [bot];
  assert.throws(() => coordinator.readContext('T000001', 'own'), /authorization is no longer valid/);
  coordinator.conversations[0].members = [person];
  assert.throws(() => coordinator.readContext('T000001', 'own'), /authorization is no longer valid/);
});
