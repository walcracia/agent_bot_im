import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TaskWorkerPool, CloudTaskWorkerPool, git } from '../super-worker.mjs';
import { apply as inboxPlugin, inputKey } from '../super-inbox-plugin.mjs';
import { createTaskDaemon, RemoteTaskWorkerPool, taskToolToken } from '../super-daemon.mjs';
import { createMcpHandler } from '../super-mcp.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check) { for (let count = 0; count < 100; count++) { if (await check()) return; await sleep(30); } throw new Error('Condition not reached.'); }
function fakeExecutor(record) {
  return { map: { sessions: {} }, async start() {}, async close() { this.release?.(); },
    async session() { return { run: async () => { await new Promise(resolve => { this.release = resolve; }); return { finalResponse: 'fixture result', finishReason: 'completed' }; } }; } };
}
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay super workers '));
  const repositoryPath = join(root, 'repository'); await mkdir(repositoryPath);
  await git(repositoryPath, ['init', '-b', 'main']);
  await git(repositoryPath, ['config', 'user.name', 'Synthetic Test']); await git(repositoryPath, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(repositoryPath, 'source.txt'), 'base source');
  await git(repositoryPath, ['add', 'source.txt']); await git(repositoryPath, ['commit', '-m', 'fixture']);
  const options = { repositoryPath, worktreesPath: join(root, 'worktrees'), runsPath: join(root, 'runs'), sessionMapsPath: join(root, 'sessions'), executorFactory: fakeExecutor, ...overrides };
  const pool = new TaskWorkerPool(options);
  t.after(async () => { await pool.close(); const resolved = await import('node:fs/promises').then(fs => fs.realpath(root)); assert.ok(resolved.startsWith(tmpdir())); await rm(root, { recursive: true, force: true }); });
  return { root, repositoryPath, options, pool };
}

test('workers return before completion and use two independent real Git worktrees', async t => {
  const { pool, repositoryPath } = await fixture(t);
  const a = await pool.prepare({ id: 'T000001' }), b = await pool.prepare({ id: 'T000002' });
  assert.notEqual(a.workspace, b.workspace); assert.equal(a.branch, 'codex/super/T000001');
  const first = await pool.start({ id: 'T000001', summary: 'first' });
  const second = await pool.start({ id: 'T000002', summary: 'second' });
  await eventually(() => pool.records.get('T000001').executor.release && pool.records.get('T000002').executor.release);
  assert.equal((await pool.inspect('T000001')).running, true); assert.equal((await pool.inspect('T000002')).running, true);
  await writeFile(join(a.workspace, 'source.txt'), 'changed first');
  assert.equal(await readFile(join(b.workspace, 'source.txt'), 'utf8'), 'base source');
  assert.equal(await readFile(join(repositoryPath, 'source.txt'), 'utf8'), 'base source');
  await writeFile(join(a.workspace, 'new-feature.py'), 'VALUE = 1\n');
  const newProgress = (await pool.inspect('T000001')).diff;
  assert.match(newProgress, /new-feature\.py/);
  await writeFile(join(a.workspace, 'new-feature.py'), 'VALUE = 2\n');
  assert.notEqual((await pool.inspect('T000001')).diff, newProgress, 'Progress must change when an untracked source file is edited again.');
  await pool.cancel('T000001'); await first.completion;
  assert.equal((await pool.inspect('T000002')).running, true);
  pool.records.get('T000002').executor.release(); await second.completion;
  await assert.rejects(pool.prepare({ id: '../escape' }), /Invalid task/);
});

test('native inbox sends same-task input once and confirms actual session consumption', async t => {
  const { pool } = await fixture(t);
  await pool.prepare({ id: 'T000003' });
  const record = pool.records.get('T000003');
  assert.equal((await pool.input('T000003', { id: 'message-4', text: 'use blue' })).queued, true);
  await pool.input('T000003', { id: 'message-4', text: 'use blue' });
  await assert.rejects(pool.input('T000003', { id: 'message-4', text: 'use red' }), /reused/);
  const callbacks = {}, events = [], messages = [];
  const ctx = { on(name, callback) { callbacks[name] = callback; return () => {}; } };
  const session = { header: {}, get seq() { return events.length; }, eventAt(i) { return events[i]; } };
  const agent = { id: 'session-native-fixture', session, steer(message) {
    messages.push(message); const event = { type: 'user/message', seq: events.length, data: message }; events.push(event); callbacks['session/event'](session, event);
  } };
  inboxPlugin(ctx, { inboxPath: record.inboxPath }); t.after(() => callbacks.dispose());
  callbacks['agent/created']({ agent });
  await eventually(async () => (await pool.inspect('T000003')).inputs.length === 1);
  assert.equal(messages.length, 1); assert.match(messages[0].content[0].text, /use blue/);
  assert.equal((await pool.input('T000003', { id: 'message-4', text: 'use blue' })).delivered, true);
  assert.equal((await pool.inspect('T000003')).inputs[0].nativeSequence, 0);
  await sleep(220); assert.equal(messages.length, 1);
  callbacks.dispose();
  const restored = {}; inboxPlugin({ on(name, cb) { restored[name] = cb; } }, { inboxPath: record.inboxPath }); t.after(() => restored.dispose());
  restored['agent/created']({ agent }); await sleep(180); assert.equal(messages.length, 1);
});

test('unconfirmed task termination never returns a successful cancellation proof', async t => {
  const { pool } = await fixture(t, { executorFactory: record => ({ ...fakeExecutor(record), async close() { throw Object.assign(new Error('not proven'), { kind: 'termination-failed', processTreeStopped: false }); } }) });
  await pool.prepare({ id: 'T000004' }); const record = pool.records.get('T000004');
  record.executor = pool.options.executorFactory(record);
  await assert.rejects(pool.cancel(record.id), cause => cause.processTreeStopped === false);
  record.executor = null;
});

async function daemonFixture(t) {
  const data = await fixture(t);
  const token = 'fixture-control-' + 'x'.repeat(40);
  const { server } = createTaskDaemon({ ...data.options, pool: data.pool, token, commands: { test: { file: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'] } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, body, auth = token) => fetch(url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ...data, token, url, call };
}

test('remote tools enforce task credentials, traversal checks and compare-before-write', async t => {
  const { token, call, root, options } = await daemonFixture(t);
  assert.equal((await call('/prepare', { taskId: 'T000005' }, 'wrong')).status, 401);
  const prepared = await (await call('/prepare', { taskId: 'T000005' })).json();
  const toolToken = taskToolToken(token, 'T000005'); assert.equal(prepared.toolToken, toolToken);
  assert.equal((await call('/tools/read', { taskId: 'T000006', path: 'source.txt' }, toolToken)).status, 401);
  assert.equal((await call('/tools/read', { taskId: 'T000005', path: '../source.txt' }, toolToken)).status, 400);
  assert.equal((await call('/tools/read', { taskId: 'T000005', path: '.git' }, toolToken)).status, 400);
  const read = await (await call('/tools/read', { taskId: 'T000005', path: 'source.txt', limit: 4 }, toolToken)).json();
  assert.equal(read.text, 'base'); assert.equal(read.nextOffset, 4);
  const originalHash = createHash('sha256').update('base source').digest('hex');
  assert.equal((await call('/tools/write', { taskId: 'T000005', path: 'source.txt', text: 'updated', expectedSha256: 'wrong' }, toolToken)).status, 409);
  assert.equal((await call('/tools/write', { taskId: 'T000005', path: 'source.txt', text: 'updated', expectedSha256: originalHash }, toolToken)).status, 200);
  assert.equal(await readFile(join(prepared.workspace, 'source.txt'), 'utf8'), 'updated');
  assert.equal((await call('/tools/exec', { taskId: 'T000005', command: 'not-configured', args: [] }, toolToken)).status, 403);
  const executed = await (await call('/tools/exec', { taskId: 'T000005', command: 'test', args: [] }, toolToken)).json();
  assert.equal(executed.code, 0); assert.equal(executed.stdout, prepared.workspace);
  await writeFile(join(options.runsPath, 'tasks', 'T000005', 'tool-command.json'), JSON.stringify({ status: 'running', pid: 123, at: 'synthetic crashed daemon' }));
  const interrupted = await (await call('/tools/exec', { taskId: 'T000005', command: 'test', args: [] }, toolToken)).json();
  assert.equal(interrupted.failed, true); assert.match(interrupted.error, /not confirmed stopped/);
  assert.equal((await call('/tools/write', { taskId: 'T000005', path: 'source.txt', text: 'should not write' }, toolToken)).status, 409);
  assert.equal((await call('/cancel', { taskId: 'T000005' })).status, 409, 'A restarted daemon must not fabricate stop proof for an unknown old command.');
});

test('MCP proxy talks to actual HTTP tools and fixes caller task scope', async t => {
  const { token, call, url } = await daemonFixture(t);
  const prepared = await (await call('/prepare', { taskId: 'T000007' })).json();
  const handle = createMcpHandler({ url, token: prepared.toolToken, taskId: 'T000007' });
  assert.equal((await handle({ id: 1, method: 'initialize' })).result.serverInfo.name, 'team-relay-environment');
  assert.equal((await handle({ id: 2, method: 'tools/list' })).result.tools.length, 3);
  const read = await handle({ id: 3, method: 'tools/call', params: { name: 'read', arguments: { path: 'source.txt', taskId: 'T000008' } } });
  assert.equal(JSON.parse(read.result.content[0].text).text, 'base source');
  assert.equal((await handle({ id: 4, method: 'tools/call', params: { name: 'unknown', arguments: {} } })).error.code, -32602);
  assert.throws(() => createMcpHandler({ url: 'http://remote.invalid', token, taskId: 'T000007' }), /HTTPS/);
});

test('context MCP advertises and forwards continuation windows without changing task scope', async t => {
  let received, authorization;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    received = JSON.parse(text); authorization = request.headers.authorization;
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ text: 'next page', nextLinks: { linkOffset: 80 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const handle = createMcpHandler({ contextUrl: 'http://127.0.0.1:' + server.address().port + '/api/context/read', contextToken: 'synthetic-scoped-context', taskId: 'T000013' });
  const tools = (await handle({ id: 1, method: 'tools/list' })).result.tools;
  assert.equal(tools[0].inputSchema.properties.limit.maximum, 12000);
  assert.equal(tools[0].inputSchema.properties.linkOffset.minimum, 0);
  const result = await handle({ id: 2, method: 'tools/call', params: { name: 'context_read', arguments: { reference: 'thread:example', offset: 10, limit: 6000, linkOffset: 40, taskId: 'T999999' } } });
  assert.equal(received.taskId, 'T000013'); assert.equal(received.linkOffset, 40); assert.equal(received.offset, 10); assert.equal(authorization, 'Bearer synthetic-scoped-context');
  assert.equal(JSON.parse(result.result.content[0].text).nextLinks.linkOffset, 80);
});

test('remote native proxy starts without waiting and observes only one task run', async t => {
  const { token, call, url, pool } = await daemonFixture(t);
  const remote = new RemoteTaskWorkerPool({ url, token, pollMs: 30 }); t.after(() => remote.close());
  await remote.prepare({ id: 'T000009' });
  const first = await remote.start({ id: 'T000009', summary: 'remote test', attempt: 1 });
  assert.equal((await remote.inspect('T000009')).worker.running, true);
  assert.equal((await call('/start', { task: { id: 'T000009', summary: 'same', attempt: 1 } })).status, 202);
  await eventually(() => pool.records.get('T000009').executor.release);
  pool.records.get('T000009').executor.release();
  assert.equal((await first.completion).finishReason, 'completed');
});

test('cloud worker keeps an empty controller cwd and mounts remote MCP instead of local filesystem tools', async t => {
  const { token, url, options, root } = await daemonFixture(t);
  const cloud = new CloudTaskWorkerPool({ ...options, runsPath: join(root, 'cloud-runs'), sessionMapsPath: join(root, 'cloud-sessions'), daemon: { url, token } });
  t.after(() => cloud.close());
  const prepared = await cloud.prepare({ id: 'T000010' });
  assert.equal(prepared.executionMode, 'remote-tools');
  assert.notEqual(prepared.workspace, prepared.environmentWorkspace); assert.deepEqual(await readdir(prepared.workspace), []);
  const run = await cloud.start({ id: 'T000010', summary: 'cloud fixture', contextUrl: url + '/api/context/read', contextToken: 'task-context-fixture' });
  await eventually(() => cloud.records.get('T000010').executor.release);
  const patch = await readFile(join(cloud.records.get('T000010').controlPath, 'inbox.patch.yml'), 'utf8');
  assert.match(patch, /tool-fs\n  disabled: true/); assert.match(patch, /dsh-mcp-client/); assert.ok(!patch.includes(token));
  cloud.records.get('T000010').executor.release(); assert.equal((await run.completion).finishReason, 'completed');
});

test('actual PowerShell pool launcher reports progress, passes inbox overlay and cancels only one worker', { skip: process.platform !== 'win32' }, async t => {
  const data = await fixture(t, { executorFactory: undefined });
  const cliPath = join(data.root, 'fake-dsh.ps1');
  await writeFile(cliPath, String.raw`
$text = $input | Out-String
$id = 'session-' + (Split-Path (Get-Location).Path -Leaf)
$idx = [Array]::IndexOf($args,'--session-id')
if ($idx -ge 0) { $id = $args[$idx + 1] }
@{ type='session'; sessionId=$id } | ConvertTo-Json -Compress
@{ type='tool'; name='synthetic-check' } | ConvertTo-Json -Compress
if ($text -match 'MODE_HANG') { Start-Sleep -Seconds 120; return }
Start-Sleep -Milliseconds 600
$global:LASTEXITCODE=0
$answer = @{ overlay=($args -contains '--patch'); masterSeen=(Test-Path Env:\SUPER_AGENT_CONTROL_TOKEN); botSeen=(Test-Path Env:\TEAM_RELAY_BOT_TOKEN); restartSeen=(Test-Path Env:\SUPER_AGENT_RESTART_TOKEN_BUNDLE); customSeen=(Test-Path Env:\CUSTOM_DAEMON_TOKEN) } | ConvertTo-Json -Compress
@{ type='final'; sessionId=$id; text=$answer; reason=@{kind='completed'} } | ConvertTo-Json -Depth 4 -Compress
`);
  data.pool.options.tokenEnv = 'CUSTOM_DAEMON_TOKEN';
  data.pool.options.harness = { cliPath, auth: 'environment', runTimeoutMs: 30000, env: { ...process.env, TEAM_RELAY_BOT_TOKEN: 'synthetic-im', SUPER_AGENT_CONTROL_TOKEN: 'synthetic-master', SUPER_AGENT_RESTART_TOKEN_BUNDLE: 'synthetic-restart-only', CUSTOM_DAEMON_TOKEN: 'synthetic-daemon-only' } };
  const progress = [];
  const first = await data.pool.start({ id: 'T000011', instructions: 'MODE_HANG' }, { onProgress: event => progress.push(event) });
  const second = await data.pool.start({ id: 'T000012', instructions: 'finish' });
  await eventually(() => progress.some(item => item.events?.some(event => event.type === 'tool')));
  assert.equal((await data.pool.cancel('T000011')).processTreeStopped, true);
  await assert.rejects(first.completion, error => error.kind === 'cancelled' && error.processTreeStopped === true);
  const result = await second.completion;
  assert.deepEqual(JSON.parse(result.finalResponse), { overlay: true, masterSeen: false, botSeen: false, restartSeen: false, customSeen: false });
  const original = await readFile(join(data.options.sessionMapsPath, 'T000011.json'), 'utf8');
  assert.match(original, /session-T000011/);
  const resumed = await data.pool.start({ id: 'T000011', instructions: 'finish', attempt: 2 });
  assert.equal((await resumed.completion).finishReason, 'completed');
  assert.equal(await readFile(join(data.options.sessionMapsPath, 'T000011.json'), 'utf8'), original);
});
