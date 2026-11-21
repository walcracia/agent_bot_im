import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, access, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createTriageToolHandler, scopedParserHints, TRIAGE_SKILL_ID } from '../triage-tools.mjs';

const modulePath = fileURLToPath(new URL('../triage-tools.mjs', import.meta.url));
const skillRoot = fileURLToPath(new URL('../../../environment/tools/ota-log-triage-1.3.2', import.meta.url));
const digest = text => createHash('sha256').update(text).digest('hex');
const log = '2026-11-20 10:00:00 CAROTA CORE VER 1.0 ERROR update failed\n';
async function fixture(t, change) {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-triage-tools-')), directory = join(root, 'logs');
  t.after(() => rm(root, { recursive: true, force: true })); await mkdir(directory);
  await writeFile(join(directory, 'example.log'), log);
  const context = { skillId: TRIAGE_SKILL_ID, taskId: 'T000001', inputRevision: 1, skillRoot, directory, proofPath: join(root, 'proof.json'),
    files: [{ path: 'example.log', bytes: Buffer.byteLength(log), sha256: digest(log) }],
    payload: { evidence: [{ id: 'E0001', file: 'example.log', line: 1, text: log.trim(), time: '2026-11-20 10:00:00', timeZone: 'unconfirmed', aligned: false, sha256: digest(log) }] } };
  await change?.(context, root);
  const contextFile = join(root, 'context.json'); await writeFile(contextFile, JSON.stringify(context));
  return { root, directory, context, contextFile, proof: async () => JSON.parse(await readFile(context.proofPath, 'utf8')) };
}
async function handlerFor(f, limits) {
  const handler = await createTriageToolHandler({ contextFile: f.contextFile, limits }); let id = 0;
  const request = (method, params) => handler({ jsonrpc: '2.0', id: ++id, method, params });
  await request('initialize', {});
  return { request, call: async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result };
}
const data = result => { assert.notEqual(result.isError, true, result.content?.[0]?.text); return JSON.parse(result.content[0].text); };

async function stdio(t, f, { initialize = true } = {}) {
  const child = spawn(process.execPath, [modulePath], { env: { TEAMPLAY_TRIAGE_CONTEXT_FILE: f.contextFile }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let id = 0, stderr = '';
  const closed = new Promise(resolve => child.once('close', code => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Synthetic stdio closed')); } resolve(code); }));
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line), item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); item.resolve(message); }
  });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(new Error('Synthetic stdio timeout')); }, 5000);
    pending.set(key, { timer, resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
  });
  t.after(async () => { child.stdin.end(); const timeout = setTimeout(() => child.kill('SIGKILL'), 2000); try { await closed; } finally { clearTimeout(timeout); } assert.equal(stderr, ''); });
  if (initialize) await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
  return { request, child, closed, call: async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result };
}

test('real stdio exposes exactly four read-only tools and exits naturally after stdin closes', async t => {
  const f = await fixture(t), client = await stdio(t, f);
  const tools = (await client.request('tools/list', {})).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['load_skill', 'list_inputs', 'read_evidence', 'run_parser']);
  const list = data(await client.call('list_inputs'));
  assert.deepEqual(list.files, f.context.files); assert.equal(list.evidence[0].id, 'E0001'); assert.ok(!Object.hasOwn(list.evidence[0], 'text'));
  assert.ok(!JSON.stringify(list).includes(f.root));
  client.child.stdin.end(); assert.equal(await client.closed, 0);
});

test('modern SDK discovery probe can respawn a legacy stdio server without consuming task proof or budget', async t => {
  const f = await fixture(t), probe = await stdio(t, f, { initialize: false });
  const response = await probe.request('server/discover', { _meta: { protocolVersion: '2026-07-28' } });
  assert.equal(response.error.code, -32601);
  await assert.rejects(access(f.context.proofPath), { code: 'ENOENT' });
  probe.child.stdin.end(); assert.equal(await probe.closed, 0);
  const legacy = await stdio(t, f);
  assert.equal((await legacy.request('tools/list')).result.tools.length, 4);
  data(await legacy.call('list_inputs'));
  assert.equal((await f.proof()).toolCalls, 1);
  await assert.rejects(createTriageToolHandler({ contextFile: f.contextFile }), { code: 'TRIAGE_TOOL_EXISTING_PROOF' });
});

test('real pinned skill, fixed parser and evidence calls create an atomic identity-bound proof', async t => {
  await access(join(skillRoot, 'integrity.json'));
  const f = await fixture(t), client = await stdio(t, f);
  const skill = data(await client.call('load_skill', { skillId: TRIAGE_SKILL_ID }));
  assert.equal(skill.version, '1.3.2'); assert.ok(skill.rules.length > 19000 && skill.rules.length <= 24000);
  const evidence = data(await client.call('read_evidence', { ids: ['E0001'] })); assert.equal(evidence.evidence[0].text, log.trim());
  const parser = data(await client.call('run_parser')); assert.ok(Array.isArray(parser.hints)); assert.ok(JSON.stringify(parser).length <= 8000);
  const proof = await f.proof();
  assert.equal(proof.toolCalls, 3); assert.equal(proof.counter, 3); assert.equal(proof.taskId, 'T000001'); assert.equal(proof.inputRevision, 1);
  assert.equal(proof.skillId, TRIAGE_SKILL_ID); assert.equal(proof.skillLoaded, true); assert.equal(proof.parserRan, true);
  assert.deepEqual(proof.evidenceReadIds, ['E0001']); assert.deepEqual(proof.tools, ['load_skill', 'read_evidence', 'run_parser']);
  assert.equal(proof.parserProcess.status, 'stopped'); assert.equal(proof.parserProcess.exitCode, 0);
  assert.throws(() => process.kill(proof.parserProcess.pid, 0), { code: 'ESRCH' });
  assert.ok(proof.returnedCharacters < 128000); assert.equal(proof.parserRunCount, 1);
  const again = data(await client.call('run_parser')); assert.equal(again.cacheHit, true);
  assert.equal((await f.proof()).toolCalls, 4); assert.equal((await f.proof()).parserRunCount, 1);
});

test('model arguments cannot select commands, paths, another skill or extra capabilities', async t => {
  const f = await fixture(t), { call } = await handlerFor(f);
  for (const [name, args] of [
    ['load_skill', { skillId: 'other@1.0.0' }], ['load_skill', { skillId: TRIAGE_SKILL_ID, path: '../other' }],
    ['run_parser', { command: process.execPath, args: ['-e', 'throw new Error()'] }],
    ['run_parser', { directory: '../other' }], ['list_inputs', { contextFile: '../other' }],
    ['read_evidence', { ids: ['E0001'], path: 'C:/private' }], ['read_evidence', { ids: ['../secret'] }],
    ['read_evidence', { ids: ['E0001', 'E0001'] }], ['read_evidence', { ids: Array.from({ length: 16 }, (_, i) => 'E' + String(i).padStart(4, '0')) }],
    ['execute_command', { command: 'echo injected' }],
  ]) assert.equal((await call(name, args)).isError, true);
  const proof = await f.proof(); assert.equal(proof.toolCalls, 10); assert.equal(proof.skillLoaded, false); assert.equal(proof.parserRan, false); assert.deepEqual(proof.evidenceReadIds, []);
});

async function addChunk(context, path, bytes, marker = 'chunk') {
  const first = `2026-11-20 10:00:00 CAROTA CORE VER 1.0 INFO Synthetic ${marker}`;
  const body = first + '\n' + 'synthetic padding line\n'.repeat(Math.ceil((bytes - first.length - 1) / 23)).slice(0, bytes - first.length - 1);
  // repeat padding may be shorter if its literal length changes; enforce the exact byte fixture.
  const content = body.padEnd(bytes, 'x');
  await mkdir(join(context.directory, path, '..'), { recursive: true });
  await writeFile(join(context.directory, path), content);
  const file = { path, bytes: Buffer.byteLength(content), sha256: digest(content) };
  context.files.push(file);
  return { file, evidence: { id: 'E' + String(context.payload.evidence.length + 1).padStart(4, '0'), file: path, line: 1, text: first,
    time: '2026-11-20 10:00:00', timeZone: 'unconfirmed', sha256: file.sha256 } };
}

test('real fixed parser stages three chunks at the 16 MB boundary and preserves directory names and source hashes', async t => {
  const selected = [];
  const f = await fixture(t, async context => {
    context.payload.evidence = [];
    for (const [index, bytes] of [5000000, 5000000, 6000000].entries()) {
      const chunk = await addChunk(context, `chunk-${index}/com.carota.log`, bytes, String(index));
      selected.push(chunk.file); context.payload.evidence.push(chunk.evidence);
    }
  });
  const { call } = await handlerFor(f);
  const result = data(await call('run_parser', { files: selected.map(file => file.path) }));
  assert.equal(result.selectedBytes, 16000000); assert.equal(result.omittedCount, 1); assert.equal(result.coverage, 'selected-files');
  assert.deepEqual(result.selectedFiles, selected);
  const stageName = (await readdir(f.root)).find(name => name.startsWith('parser-inputs-'));
  assert.ok(stageName);
  for (const file of selected) {
    assert.equal(digest(await readFile(join(f.directory, file.path))), file.sha256);
    assert.equal(digest(await readFile(join(f.root, stageName, file.path))), file.sha256);
  }
  assert.deepEqual(result.batches[0].files, selected);
  assert.equal((await f.proof()).parserRan, true); assert.equal((await f.proof()).parserProcess.exitCode, 0);
});

test('a source above one parser batch is processed in multiple stages without rejecting the source', async t => {
  const f = await fixture(t, async context => { const chunk = await addChunk(context, 'large/com.carota.log', 16000001); chunk.evidence.id = 'E0002'; context.payload.evidence.push(chunk.evidence); });
  const { call } = await handlerFor(f);
  for (const files of [[], ['example.log', 'example.log'], ['../escape.log'], ['C:/outside.log'], ['not-listed.log']]) assert.equal((await call('run_parser', { files })).isError, true);
  const result = data(await call('run_parser')); assert.equal(result.selectedFiles.length, 2); assert.ok(result.batches.length >= 2);
  assert.equal(result.omittedCount, 0); assert.equal((await f.proof()).parserRan, true);
});
test('default parser selection includes all manifest files rather than skipping a larger source', async t => {
  const f = await fixture(t, async context => { const chunk = await addChunk(context, 'large/com.carota.log', 16000001); chunk.evidence.id = 'E0002'; context.payload.evidence.push(chunk.evidence); });
  const { call } = await handlerFor(f), result = data(await call('run_parser'));
  assert.deepEqual(result.selectedFiles.map(file => file.path), ['example.log', 'large/com.carota.log']); assert.equal(result.omittedCount, 0); assert.equal(result.coverage, 'all-selected-files');
});
test('parser hints match the exact staged relative path rather than another file with the same basename', () => {
  const directory = join(tmpdir(), 'synthetic-parser-scope');
  const evidence = [{ id: 'E0001', file: 'com.carota.log', line: 1 }, { id: 'E0002', file: 'nested/com.carota.log', line: 1 }, { id: 'E0003', file: 'other/com.carota.log', line: 1 }];
  const parser = { findings: [{ summary: 'Synthetic nested finding', evidence: [{ file: join(directory, 'nested/com.carota.log'), line: 1 }] }] };
  const files = [{ path: 'com.carota.log' }, { path: 'nested/com.carota.log' }];
  assert.deepEqual(scopedParserHints(parser, directory, files, evidence), [{ summary: 'Synthetic nested finding', evidenceIds: ['E0002'] }]);
});

test('attempt accounting remains durable and unknown IDs remain denied without activating retired call quotas', async t => {
  const f = await fixture(t), { call } = await handlerFor(f, { calls: 2 });
  assert.equal((await call('read_evidence', { ids: ['E9999'] })).isError, true); assert.equal((await f.proof()).toolCalls, 1);
  data(await call('list_inputs')); data(await call('read_evidence', { ids: ['E0001'] }));
  assert.equal((await f.proof()).toolCalls, 3); assert.deepEqual((await f.proof()).evidenceReadIds, ['E0001']);
});
test('retired return and evidence budgets do not suppress skill loading or repeated source reads', async t => {
  const f = await fixture(t), { call } = await handlerFor(f, { returnedCharacters: 1, evidenceCharacters: 1 });
  assert.ok(data(await call('load_skill', { skillId: TRIAGE_SKILL_ID })).rules.length > 19000);
  assert.equal(data(await call('read_evidence', { ids: ['E0001'] })).evidence.length, 1);
  assert.equal(data(await call('read_evidence', { ids: ['E0001'] })).evidence.length, 1);
  const proof = await f.proof(); assert.equal(proof.skillLoaded, true); assert.equal(proof.evidenceReadCalls, 2); assert.equal(proof.evidenceLines, 2);
});
test('modified, unlisted and hard-linked input files are rejected before parser access', async t => {
  for (const change of [
    async f => writeFile(join(f.directory, 'example.log'), log + 'changed'),
    async f => writeFile(join(f.directory, 'unlisted.log'), 'extra'),
    async f => link(join(f.directory, 'example.log'), join(f.root, 'hardlink.log')),
  ]) {
    const f = await fixture(t), handler = await handlerFor(f); await change(f);
    assert.equal((await handler.call('run_parser')).isError, true); assert.equal((await f.proof()).parserRan, false);
  }
});

test('context paths, evidence provenance, duplicate IDs and existing proof fail closed', async t => {
  for (const change of [
    context => { context.files[0].path = '../escape.log'; },
    context => { context.files[0].path = 'C:/escape.log'; },
    context => { context.payload.evidence[0].text = 'Invented evidence'; },
    context => { context.payload.evidence.push({ ...context.payload.evidence[0] }); },
    context => { context.payload.evidence[0].sha256 = '0'.repeat(64); },
    context => { context.proofPath = join(context.directory, 'proof.json'); },
    async context => writeFile(context.proofPath, '{}'),
  ]) {
    const f = await fixture(t, change);
    await assert.rejects(createTriageToolHandler({ contextFile: f.contextFile }));
  }
});

test('directory junctions or symlinks cannot expand the log allowlist', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'other.log'), 'other');
  await symlink(outside, join(f.directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createTriageToolHandler({ contextFile: f.contextFile }), { code: 'TRIAGE_TOOL_LINK' });
});

test('the fixed parser completes without an inherited artificial elapsed quota and repeated scope uses its cache', async t => {
  const f = await fixture(t), { call } = await handlerFor(f, { parserTimeoutMs: 1 });
  const first = data(await call('run_parser')); const next = data(await call('run_parser'));
  assert.equal(first.cacheHit, false); assert.equal(next.cacheHit, true);
  const proof = await f.proof(); assert.equal(proof.parserRuns, 2); assert.equal(proof.parserBatchRuns, 1); assert.equal(proof.parserProcess.status, 'stopped');
});
test('concurrent tool requests serialize durable accounting and proof output', async t => {
  const f = await fixture(t), { call } = await handlerFor(f);
  const results = await Promise.all(Array.from({ length: 5 }, () => call('read_evidence', { ids: ['E0001'] })));
  results.forEach(data); const proof = await f.proof();
  assert.equal(proof.toolCalls, 5); assert.deepEqual(proof.evidenceReadIds, ['E0001']); assert.equal(proof.tools.length, 5);
});

test('old context quota fields are inert and the model cannot change host execution capabilities', async t => {
  const f = await fixture(t, context => { context.toolLimits = { calls: 1, returnedCharacters: 1, evidenceCharacters: 1, parserRuns: 1 }; });
  const { call } = await handlerFor(f); data(await call('list_inputs')); data(await call('list_inputs'));
  assert.equal((await call('list_inputs', { calls: 100000 })).isError, true);
  assert.equal((await f.proof()).toolCalls, 3);
});
test('one page returns real evidence lines and repeated reads report actual returned lines', async t => {
  const f = await fixture(t, async context => {
    const text = Array.from({ length: 60 }, (_, i) => '2026-11-20 10:00:00 CAROTA CORE VER row ' + (i + 1)).join('\n');
    await writeFile(join(context.directory, 'example.log'), text); context.files[0] = { path: 'example.log', bytes: Buffer.byteLength(text), sha256: digest(text) };
    context.payload.evidence = text.split('\n').map((line, i) => ({ id: 'E' + String(i + 1).padStart(4, '0'), file: 'example.log', line: i + 1, text: line, sha256: digest(text) }));
  });
  const { call } = await handlerFor(f), ids = f.context.payload.evidence.map(item => item.id);
  assert.equal(data(await call('read_evidence', { ids })).evidence.length, 60); assert.equal(data(await call('read_evidence', { ids })).evidence.length, 60);
  const proof = await f.proof(); assert.equal(proof.evidenceLines, 120); assert.equal(proof.evidenceReadIds.length, 60);
});
test('parser scopes retain path and hash cache identity without a session run quota', async t => {
  const f = await fixture(t, async context => { for (let i = 0; i < 6; i++) await addChunk(context, 'scope-' + i + '/com.carota.log', 512); });
  const { call } = await handlerFor(f);
  for (let i = 0; i < 6; i++) assert.equal(data(await call('run_parser', { files: ['scope-' + i + '/com.carota.log'] })).cacheHit, false);
  assert.equal(data(await call('run_parser', { files: ['scope-5/com.carota.log'] })).cacheHit, true);
  const proof = await f.proof(); assert.equal(proof.parserRuns, 7); assert.equal(proof.parserBatchRuns, 6);
});
// Superseded quota-only scenario; cross-page monitoring coverage is in triage-monitoring.test.mjs.
test('returned-character statistics include the delivered page metadata without an exhaustion gate', async t => {
  const f = await fixture(t), { call } = await handlerFor(f); let count = 0;
  for (let i = 0; i < 12; i++) { const result = await call('list_inputs'); count += result.content[0].text.length; }
  assert.equal((await f.proof()).returnedCharacters, count); assert.equal((await f.proof()).toolCalls, 12);
});
