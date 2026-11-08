import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rename, unlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstalledHeadlessExecutor } from '../installed-headless.mjs';

const installedTest = (name, callback) => test(name, { skip: process.platform !== 'win32' ? 'Installed Desktop protocol fixture requires Windows PowerShell.' : false }, callback);

// Protocol fixture, not a model: run the real portable PowerShell supervisor
// against a script that emits the documented native JSONL outcomes.
const fakeCli = String.raw`
if ($args -contains '--version') { $global:LASTEXITCODE = 0; Write-Output 'fake-dsh 0.2.2-test'; return }
$prompt = $input | Out-String
$id = 'session-new'
$index = [Array]::IndexOf($args, '--session-id')
if ($index -ge 0) { $id = $args[$index + 1] }
$permissionIndex = [Array]::IndexOf($args, '--permission-mode')
$permission = $args[$permissionIndex + 1]
$tokenSeen = Test-Path Env:\TEAM_RELAY_BOT_TOKEN
$global:LASTEXITCODE = 0
@{ type = 'session'; sessionId = $id } | ConvertTo-Json -Compress
if ($prompt -match 'MODE_HANG') {
    $process = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120') -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText((Join-Path (Get-Location).Path 'child.pid'), [string]$process.Id)
    Start-Sleep -Seconds 120
    return
}
if ($prompt -match 'MODE_NO_FINAL') { return }
if ($prompt -match 'MODE_DELAY') { Start-Sleep -Milliseconds 700 }
if ($prompt -match 'MODE_MALFORMED') { Write-Output '{not-json'; return }
if ($prompt -match 'MODE_ERROR') { @{ type = 'error'; code = 'synthetic-model-error' } | ConvertTo-Json -Compress }
$finalId = if ($prompt -match 'MODE_MISMATCH') { 'session-wrong' } else { $id }
$answer = @{ permission = $permission; tokenSeen = [bool]$tokenSeen; sessionId = $id; receivedText = $prompt.Trim() } | ConvertTo-Json -Compress
@{ type = 'final'; sessionId = $finalId; reason = @{ kind = 'completed' }; text = $answer } | ConvertTo-Json -Depth 6 -Compress
if ($prompt -match 'MODE_AFTER_FINAL') { @{ type = 'note'; text = 'late event' } | ConvertTo-Json -Compress }
if ($prompt -match 'MODE_NONZERO') { $global:LASTEXITCODE = 7 }
`;

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay installed protocol '));
  const cwd = join(directory, 'project workspace');
  await mkdir(cwd);
  const cliPath = join(directory, 'fake cli.ps1');
  await writeFile(cliPath, fakeCli);
  const options = { cwd, cliPath, runsPath: join(directory, 'private runs'), sessionMapPath: join(directory, 'state', 'sessions.json'),
    auth: 'environment', permissionMode: 'workspace-write', powershellPath: process.env.TEAM_RELAY_TEST_POWERSHELL ?? 'pwsh', runTimeoutMs: 30000,
    env: { ...process.env, TEAM_RELAY_BOT_TOKEN: 'synthetic-token-must-not-reach-cli' }, ...extra };
  const executor = new InstalledHeadlessExecutor(options);
  t.after(async () => { await executor.close(); await rm(directory, { recursive: true, force: true }); });
  return { executor, directory, cwd, options };
}

async function runMetadata(options) {
  return Promise.all((await readdir(options.runsPath)).map(async name => JSON.parse(await readFile(join(options.runsPath, name, 'run.json'), 'utf8'))));
}

function assertFinishedMetadata(metadata, status) {
  assert.equal(metadata.status, status);
  assert.equal(metadata.sessionId, 'session-new');
  assert.ok(Number.isFinite(Date.parse(metadata.finishedUtc)));
  assert.ok(Date.parse(metadata.finishedUtc) >= Date.parse(metadata.startedUtc));
}

installedTest('installed version handshake is zero-model and classifier permissions are always read-only', async t => {
  const { executor, options } = await fixture(t, { permissionMode: 'danger-full-access' });
  const info = await executor.handshake();
  assert.equal(info.cliVersion, 'fake-dsh 0.2.2-test');
  assert.equal(info.modelRequests, 0);
  const answer = JSON.parse(await executor.classify('Classify the synthetic discussion.'));
  assert.equal(answer.permission, 'read-only');
  assert.equal(answer.tokenSeen, false);
  await assert.rejects(readFile(options.sessionMapPath), { code: 'ENOENT' });
});

installedTest('worker preserves literal task text and native session mapping across new executor instances', async t => {
  const { executor, options, cwd } = await fixture(t);
  const text = 'Do not interpret shell syntax: $(Get-Date); `quoted`; 演示';
  const first = await executor.session('team-relay-example', false);
  const result = await first.run([{ type: 'text', text }], { id: 14 });
  const answer = JSON.parse(result.finalResponse);
  assert.equal(result.finishReason, 'completed');
  assert.equal(answer.permission, 'workspace-write');
  assert.equal(answer.receivedText, text);
  assert.equal(answer.tokenSeen, false);
  const map = JSON.parse(await readFile(options.sessionMapPath, 'utf8'));
  assert.equal(map.cwd, cwd);
  assert.equal(map.sessions['team-relay-example'].nativeSessionId, 'session-new');
  const metadata = await runMetadata(options);
  assert.equal(metadata.length, 1);
  assertFinishedMetadata(metadata[0], 'completed');
  await executor.close();
  const restored = new InstalledHeadlessExecutor(options);
  t.after(() => restored.close());
  const session = await restored.session('team-relay-example', true);
  const next = await session.run([{ type: 'text', text: 'Continue in the same project.' }]);
  assert.equal(JSON.parse(next.finalResponse).sessionId, 'session-new');
  await assert.rejects(restored.session('team-relay-example', false), /explicitly restore/);
  await assert.rejects(restored.session('team-relay-missing', true), /mapping is missing/);
});

installedTest('partial native run records opening ID but does not claim completion', async t => {
  const { executor, options } = await fixture(t);
  const session = await executor.session('team-relay-partial', false);
  await assert.rejects(session.run([{ type: 'text', text: 'MODE_NO_FINAL' }]), /did not complete/);
  const map = JSON.parse(await readFile(options.sessionMapPath, 'utf8'));
  assert.equal(map.sessions['team-relay-partial'].nativeSessionId, 'session-new');
  const metadata = await runMetadata(options);
  assert.equal(metadata.length, 1);
  assertFinishedMetadata(metadata[0], 'failed');
  const resumed = await executor.session('team-relay-partial', true);
  assert.equal((await resumed.run([{ type: 'text', text: 'Explicit operator retry.' }])).finishReason, 'completed');
});

installedTest('malformed, mismatched, error, nonzero and post-final JSONL all fail closed', async t => {
  const { executor } = await fixture(t);
  for (const mode of ['MODE_MALFORMED', 'MODE_MISMATCH', 'MODE_ERROR', 'MODE_NONZERO', 'MODE_AFTER_FINAL']) {
    await assert.rejects(executor.classify(mode), /did not complete/);
  }
});

installedTest('session map rejects another workspace and launch options are validated', async t => {
  const { options, cwd } = await fixture(t);
  const wrong = join(cwd, 'other'); await mkdir(wrong);
  await mkdir(join(options.sessionMapPath, '..'), { recursive: true });
  await writeFile(options.sessionMapPath, JSON.stringify({ version: 1, cwd: wrong, sessions: {} }));
  await assert.rejects(new InstalledHeadlessExecutor(options).start(), /another cwd/);
  await assert.rejects(new InstalledHeadlessExecutor({ ...options, cwd: 'relative' }).start(), /absolute path/);
  await assert.rejects(new InstalledHeadlessExecutor({ ...options, auth: 'from-chat' }).start(), /auth/);
  await assert.rejects(new InstalledHeadlessExecutor({ ...options, permissionMode: 'from-chat' }).start(), /permissionMode/);
  await assert.rejects(new InstalledHeadlessExecutor({ ...options, runTimeoutMs: 0 }).start(), /runTimeoutMs/);
});

installedTest('timeout terminates the owned worker tree and preserves its native session for inspection', async t => {
  const { executor, options, cwd } = await fixture(t, { runTimeoutMs: 4000 });
  const session = await executor.session('team-relay-timeout', false);
  const failed = assert.rejects(session.run([{ type: 'text', text: 'MODE_HANG' }]), /timed out/);
  let map;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { map = JSON.parse(await readFile(options.sessionMapPath, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(map?.sessions['team-relay-timeout'].nativeSessionId, 'session-new');
  await assert.rejects(executor.classify('Must not start concurrently.'), /already owns/);
  await failed;
  const pid = Number(await readFile(join(cwd, 'child.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

installedTest('different state files still share one canonical workspace worker lease', async t => {
  const { executor, options, directory, cwd } = await fixture(t);
  const other = new InstalledHeadlessExecutor({ ...options, cwd: cwd.toUpperCase(), runsPath: join(directory, 'other runs'), sessionMapPath: join(directory, 'other-state.json') });
  t.after(() => other.close());
  const first = await executor.session('team-relay-first', false);
  await assert.rejects(other.session('team-relay-second', false), /workspace is busy/);
  // Read-only classification is not blocked by a prepared code-worker lease.
  assert.equal(JSON.parse(await other.classify('Read-only classification.')).permission, 'read-only');
  await first.run([{ type: 'text', text: 'First isolated worker.' }]);
  const second = await other.session('team-relay-second', false);
  assert.equal((await second.run([{ type: 'text', text: 'Next isolated worker.' }])).finishReason, 'completed');
  await assert.rejects(readFile(executor.workspaceLockPath), { code: 'ENOENT' });
});

installedTest('prepared-session close and invalid worker input release only their own lease', async t => {
  const { executor, options, directory } = await fixture(t);
  await executor.session('team-relay-prepared', false);
  await assert.rejects(executor.classify('A prepared worker must keep its local dispatch reservation.'), /prepared DSH worker/);
  await executor.close();
  const other = new InstalledHeadlessExecutor({ ...options, runsPath: join(directory, 'next runs'), sessionMapPath: join(directory, 'next-state.json') });
  t.after(() => other.close());
  const invalid = await other.session('team-relay-invalid', false);
  await assert.rejects(invalid.run([{ type: 'unsupported' }]), /Unsupported DSH prompt/);
  const next = await other.session('team-relay-next', false);
  await other.close();
  await assert.rejects(next.run([{ type: 'text', text: 'Closed before dispatch.' }]), /consumed/);
  await assert.rejects(readFile(other.workspaceLockPath), { code: 'ENOENT' });
});

installedTest('workers in different canonical workspaces can run concurrently', async t => {
  const { executor, options, directory } = await fixture(t);
  const otherCwd = join(directory, 'second workspace'); await mkdir(otherCwd);
  const other = new InstalledHeadlessExecutor({ ...options, cwd: otherCwd, runsPath: join(directory, 'second runs'), sessionMapPath: join(directory, 'second-state.json') });
  t.after(() => other.close());
  const first = await executor.session('team-relay-one', false);
  const second = await other.session('team-relay-two', false);
  await Promise.all([first.run([{ type: 'text', text: 'MODE_DELAY first' }]), second.run([{ type: 'text', text: 'MODE_DELAY second' }])]);
  const [a] = await runMetadata(options), [b] = await runMetadata(other.options);
  assert.ok(Math.max(Date.parse(a.startedUtc), Date.parse(b.startedUtc)) < Math.min(Date.parse(a.finishedUtc), Date.parse(b.finishedUtc)));
  assert.notEqual(executor.workspaceLockPath, other.workspaceLockPath);
});

installedTest('concurrent first invocations atomically reserve one local launcher', async t => {
  const { executor, options } = await fixture(t);
  const results = await Promise.allSettled([executor.classify('MODE_DELAY one'), executor.classify('MODE_DELAY two')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /already owns/);
  assert.equal((await runMetadata(options)).length, 1);
});

installedTest('concurrent first session preparations reserve one local worker lease', async t => {
  const { executor } = await fixture(t);
  const results = await Promise.allSettled([executor.session('team-relay-one', false), executor.session('team-relay-two', false)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /already owns/);
  await executor.close();
  await assert.rejects(readFile(executor.workspaceLockPath), { code: 'ENOENT' });
});

installedTest('workspace lease excludes another process and is released on its clean close', async t => {
  const { executor, options, directory } = await fixture(t);
  const script = join(directory, 'lease-owner.mjs');
  await writeFile(script, `import {InstalledHeadlessExecutor} from ${JSON.stringify(new URL('../installed-headless.mjs', import.meta.url).href)};
const executor = new InstalledHeadlessExecutor(JSON.parse(process.argv[2]));
await executor.session('team-relay-child', false);
console.log('lease-ready');
let timeout;
await new Promise(resolve => { process.stdin.once('data',resolve); process.stdin.once('end',resolve); timeout=setTimeout(resolve,10000); });
clearTimeout(timeout);
await executor.close();
`);
  const child = spawn(process.execPath, [script, JSON.stringify(options)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const [buffer] = await once(child.stdout, 'data');
    assert.match(buffer.toString(), /lease-ready/);
    await assert.rejects(executor.session('team-relay-parent', false), /workspace is busy/);
  } finally { child.stdin.end('close\n'); await exited; }
  await executor.session('team-relay-parent', false);
  await executor.close();
  await assert.rejects(readFile(executor.workspaceLockPath), { code: 'ENOENT' });
});

installedTest('existing stale locks and replacement owners are never removed automatically', async t => {
  const { executor } = await fixture(t);
  await executor.start();
  await mkdir(join(executor.workspaceLockPath, '..'), { recursive: true });
  const stale = JSON.stringify({ pid: 2147483647, cwd: executor.cwd, nonce: 'synthetic-stale-owner' });
  await writeFile(executor.workspaceLockPath, stale, { flag: 'wx' });
  try {
    await assert.rejects(executor.session('team-relay-stale', false), /never removed automatically/);
    assert.equal(await readFile(executor.workspaceLockPath, 'utf8'), stale);
  } finally { await unlink(executor.workspaceLockPath); }
  await executor.session('team-relay-owner', false);
  const original = `${executor.workspaceLockPath}.synthetic-original`;
  await rename(executor.workspaceLockPath, original);
  const replacement = JSON.stringify({ pid: process.pid, cwd: executor.cwd, nonce: 'synthetic-replacement-owner' });
  await writeFile(executor.workspaceLockPath, replacement, { flag: 'wx' });
  try {
    await assert.rejects(executor.close(), /refusing to remove another owner/);
    assert.equal(await readFile(executor.workspaceLockPath, 'utf8'), replacement);
  } finally { await unlink(executor.workspaceLockPath); await unlink(original); }
});
