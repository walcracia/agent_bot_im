import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { replaceOwnedFile } from '../file-replace.mjs';
import { startWatchdog } from '../super-watchdog.mjs';

const WINDOWS = { skip: process.platform !== 'win32' ? 'Windows FileStream delete-sharing behavior.' : false };
const LONG_SHARING = { backoffMilliseconds: [25, 50, 100, 200, 400, 800, 1000, 1500, 2000, 2000] };

async function until(condition, message, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await condition()) return; await delay(15); }
  assert.fail(message);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-file-sharing-')), cleanup = [];
  t.after(async () => {
    const failures = [];
    for (const action of cleanup.reverse()) { try { await action(); } catch (error) { failures.push(error); } }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, 'File sharing fixture cleanup failed.');
  });
  return { directory, cleanup: action => cleanup.push(action) };
}

/** The handle really denies delete-sharing. Paths stay data in the child's
 * environment; they are never interpolated into an evaluated shell string. */
async function holdReadOnly(f, target, milliseconds = 3200) {
  const ready = join(f.directory, 'reader-ready.json'), released = join(f.directory, 'reader-released.json');
  const script = String.raw`
$ErrorActionPreference='Stop'
$stream=[IO.File]::Open($env:RELAY_TEST_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
  [IO.File]::WriteAllText($env:RELAY_TEST_READY,(@{pid=$PID;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress))
  Start-Sleep -Milliseconds ([int]$env:RELAY_TEST_HOLD_MS)
} finally {
  $stream.Dispose()
  [IO.File]::WriteAllText($env:RELAY_TEST_RELEASED,(@{pid=$PID;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress))
}
`;
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, RELAY_TEST_TARGET: target, RELAY_TEST_READY: ready, RELAY_TEST_RELEASED: released, RELAY_TEST_HOLD_MS: String(milliseconds) },
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  f.cleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(); // Only the precise fixture child owned above.
    await closed;
  });
  await until(async () => {
    if (child.exitCode !== null) throw new Error('Owned FileStream holder exited before ready: ' + stderr);
    try { return JSON.parse(await readFile(ready, 'utf8')).pid === child.pid; }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }, 'FileStream holder did not acquire its target.');
  return { child, closed, async duration() {
    const first = JSON.parse(await readFile(ready, 'utf8')), last = JSON.parse(await readFile(released, 'utf8'));
    assert.equal(first.pid, child.pid); assert.equal(last.pid, child.pid);
    return Date.parse(last.at) - Date.parse(first.at);
  } };
}

test('optional sharing budget is finite and non-sharing errors never wait or retry', async t => {
  const f = await fixture(t), source = join(f.directory, 'missing.tmp'), target = join(f.directory, 'target.json');
  await writeFile(target, 'original');
  let checks = 0;
  await assert.rejects(replaceOwnedFile(source, target, async () => { checks++; }, LONG_SHARING), { code: 'ENOENT' });
  assert.equal(checks, 1);
  assert.equal(await readFile(target, 'utf8'), 'original');
  for (const backoff of [[0], [-1], [Infinity], [2001], Array(6).fill(2000), Array(21).fill(1), 'unbounded'])
    await assert.rejects(replaceOwnedFile(source, target, async () => {}, { backoffMilliseconds: backoff }), /backoff|budget/);
});

test('actual Windows FileStream blocks replacement for over two seconds, then the extended owner budget commits atomically', WINDOWS, async t => {
  const f = await fixture(t), source = join(f.directory, 'owner.new.json'), target = join(f.directory, 'owner.json');
  await writeFile(target, '{"generation":"previous"}'); await writeFile(source, '{"generation":"current"}');
  const held = await holdReadOnly(f, target);
  let checks = 0;
  const replacement = replaceOwnedFile(source, target, async () => { checks++; }, LONG_SHARING);
  const committed = replacement.then(() => true); // Attach immediately so a genuine failure cannot become an unhandled rejection.
  assert.equal(await readFile(target, 'utf8'), '{"generation":"previous"}');
  const [code] = await held.closed; assert.equal(code, 0);
  await committed;
  assert.ok(await held.duration() >= 3000, 'The real Windows handle must remain locked beyond the previous retry budget.');
  assert.ok(checks >= 2, 'Ownership must be rechecked while retrying the denied rename.');
  assert.equal(await readFile(target, 'utf8'), '{"generation":"current"}');
  await assert.rejects(access(source), { code: 'ENOENT' });
});

test('ownership changing during a Windows sharing wait aborts before the handle is released', WINDOWS, async t => {
  const f = await fixture(t), source = join(f.directory, 'owner.new.json'), target = join(f.directory, 'owner.json'), lease = join(f.directory, 'lease.json');
  await writeFile(source, 'current'); await writeFile(target, 'previous'); await writeFile(lease, 'original-owner');
  const held = await holdReadOnly(f, target);
  let checks = 0, changed = false;
  const replacement = replaceOwnedFile(source, target, async () => {
    checks++;
    if (await readFile(lease, 'utf8') !== 'original-owner') throw new Error('Fixture lease ownership changed.');
    if (!changed) { changed = true; await writeFile(lease, 'different-owner'); }
  }, LONG_SHARING);
  await assert.rejects(replacement, /lease ownership changed/);
  assert.equal(checks, 2, 'The first retry must fail ownership validation instead of waiting the full sharing budget.');
  assert.equal(held.child.exitCode, null, 'Ownership refusal must happen before the unrelated sharing handle closes.');
  assert.equal(await readFile(target, 'utf8'), 'previous'); assert.equal(await readFile(source, 'utf8'), 'current');
  await held.closed;
});

test('a real Watchdog survives a multi-second owner metadata reader and publishes a fresh heartbeat after release', WINDOWS, async t => {
  const f = await fixture(t), statePath = join(f.directory, 'watchdog.json');
  const server = createServer((_request, response) => { response.end(JSON.stringify({ generation: 'sharing-test', heartbeat: new Date().toISOString(), tasks: [] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  f.cleanup(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const service = await startWatchdog({ statePath, controllerUrl: `http://127.0.0.1:${server.address().port}`, intervalMs: 20 }, {
    env: { SUPER_AGENT_CONTROL_TOKEN: 'synthetic-sharing-test-token' }, classify: async () => assert.fail('An empty snapshot must not invoke a model'),
  });
  let finished = false, failure;
  service.completion.then(() => { finished = true; }, error => { finished = true; failure = error; });
  f.cleanup(() => service.stop());
  await until(async () => {
    try { return JSON.parse(await readFile(service.ownerPath, 'utf8')).status === 'observing'; }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }, 'Watchdog did not initially publish its owner.');
  const held = await holdReadOnly(f, service.ownerPath), frozen = JSON.parse(await readFile(service.ownerPath, 'utf8'));
  await delay(2200);
  assert.equal(finished, false, failure?.message ?? 'Supervision stopped during a temporary sharing denial.');
  assert.equal(JSON.parse(await readFile(service.ownerPath, 'utf8')).nonce, frozen.nonce);
  const [code] = await held.closed; assert.equal(code, 0); assert.ok(await held.duration() >= 3000);
  await until(async () => {
    if (failure) throw failure;
    const current = JSON.parse(await readFile(service.ownerPath, 'utf8'));
    return current.nonce === frozen.nonce && current.status === 'observing' && Date.parse(current.heartbeat) > Date.parse(frozen.heartbeat);
  }, 'Watchdog never published a real fresh heartbeat after the reader released it.');
  assert.equal(finished, false);
  await service.stop();
  assert.equal(JSON.parse(await readFile(service.ownerPath, 'utf8')).status, 'stopped');
  await assert.rejects(access(statePath + '.lock'), { code: 'ENOENT' });
});
