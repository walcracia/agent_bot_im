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
const data = result => { assert.notEqual(result.isError, true); return JSON.parse(result.content[0].text); };

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
  assert.equal(result.selectedBytes, 16000000); assert.equal(result.omittedCount, 1); assert.equal(result.coverage, 'partial');
  assert.deepEqual(result.selectedFiles, selected);
  const stageName = (await readdir(f.root)).find(name => name.startsWith('parser-inputs-'));
  assert.ok(stageName);
  for (const file of selected) {
    assert.equal(digest(await readFile(join(f.directory, file.path))), file.sha256);
    assert.equal(digest(await readFile(join(f.root, stageName, file.path))), file.sha256);
  }
  assert.deepEqual((await f.proof()).parserScope.selectedFiles, selected);
  assert.equal((await f.proof()).parserRan, true); assert.equal((await f.proof()).parserProcess.exitCode, 0);
});

test('oversized default and explicit choices fail without consuming the unique parser execution', async t => {
  const f = await fixture(t, async context => {
    const chunk = await addChunk(context, 'large/com.carota.log', 16000001);
    chunk.evidence.id = 'E0002'; context.payload.evidence = [chunk.evidence];
  });
  const { call } = await handlerFor(f);
  for (const files of [[], ['example.log', 'example.log'], ['../escape.log'], ['C:/outside.log'], ['a', 'b', 'c', 'd'], ['not-listed.log']]) {
    assert.equal((await call('run_parser', { files })).isError, true);
  }
  assert.match((await call('run_parser')).content[0].text, /NO_ELIGIBLE_INPUT/u);
  assert.match((await call('run_parser', { files: ['large/com.carota.log'] })).content[0].text, /PARSER_INPUT_LIMIT/u);
  assert.equal((await f.proof()).parserRan, false); assert.equal((await f.proof()).parserProcess, undefined);
  const result = data(await call('run_parser', { files: ['example.log'] }));
  assert.deepEqual(result.selectedFiles.map(file => file.path), ['example.log']); assert.equal(result.omittedCount, 1);
  assert.equal((await f.proof()).parserRan, true);
});

test('default parser choice follows evidence order while skipping files that cannot fit the scope budget', async t => {
  const f = await fixture(t, async context => {
    const original = context.payload.evidence[0], chunk = await addChunk(context, 'large/com.carota.log', 16000001);
    chunk.evidence.id = 'E0002'; context.payload.evidence = [chunk.evidence, original];
  });
  const { call } = await handlerFor(f), result = data(await call('run_parser'));
  assert.deepEqual(result.selectedFiles.map(file => file.path), ['example.log']);
  assert.equal(result.coverage, 'partial'); assert.equal(result.omittedCount, 1);
});

test('parser hints match the exact staged relative path rather than another file with the same basename', () => {
  const directory = join(tmpdir(), 'synthetic-parser-scope');
  const evidence = [{ id: 'E0001', file: 'com.carota.log', line: 1 }, { id: 'E0002', file: 'nested/com.carota.log', line: 1 }, { id: 'E0003', file: 'other/com.carota.log', line: 1 }];
  const parser = { findings: [{ summary: 'Synthetic nested finding', evidence: [{ file: join(directory, 'nested/com.carota.log'), line: 1 }] }] };
  const files = [{ path: 'com.carota.log' }, { path: 'nested/com.carota.log' }];
  assert.deepEqual(scopedParserHints(parser, directory, files, evidence), [{ summary: 'Synthetic nested finding', evidenceIds: ['E0002'] }]);
});

test('attempt count is durable, unknown evidence never reads files and the session call budget cannot expand', async t => {
  const f = await fixture(t), { call } = await handlerFor(f, { calls: 2 });
  assert.equal((await call('read_evidence', { ids: ['E9999'] })).isError, true);
  assert.equal((await f.proof()).toolCalls, 1);
  data(await call('list_inputs'));
  assert.match((await call('read_evidence', { ids: ['E0001'] })).content[0].text, /CALL_LIMIT/u);
  assert.equal((await f.proof()).toolCalls, 2); assert.deepEqual((await f.proof()).evidenceReadIds, []);
});

test('return budget prevents false proof and repeated evidence does not consume the evidence budget again', async t => {
  const f = await fixture(t), { call } = await handlerFor(f, { returnedCharacters: 400 });
  assert.match((await call('load_skill', { skillId: TRIAGE_SKILL_ID })).content[0].text, /RETURN_BUDGET/u);
  assert.equal((await f.proof()).skillLoaded, false);
  const second = await fixture(t), length = JSON.stringify({ evidence: second.context.payload.evidence }).length;
  const limited = await handlerFor(second, { evidenceCharacters: length + 5 });
  data(await limited.call('read_evidence', { ids: ['E0001'] }));
  const duplicate = data(await limited.call('read_evidence', { ids: ['E0001'] }));
  assert.deepEqual(duplicate.evidence, []); assert.equal(duplicate.alreadyProvided[0].id, 'E0001');
  assert.ok(!Object.hasOwn(duplicate.alreadyProvided[0], 'text'));
  assert.equal((await second.proof()).evidenceCharacters, length);
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

test('fixed parser timeout is counted and reaped, with cached errors preventing another identical run', async t => {
  const f = await fixture(t), { call } = await handlerFor(f, { parserTimeoutMs: 1 });
  const result = await call('run_parser'); assert.match(result.content[0].text, /PARSER_TIMEOUT/u);
  assert.equal((await f.proof()).toolCalls, 1); assert.equal((await f.proof()).parserRan, false);
  assert.equal((await f.proof()).parserProcess.status, 'stopped');
  const again = await call('run_parser'); assert.match(again.content[0].text, /PARSER_TIMEOUT/u);
  assert.equal(JSON.parse(again.content[0].text).cachedError, true); assert.equal((await f.proof()).parserRunCount, 1);
});

test('concurrent tool requests serialize durable accounting and proof output', async t => {
  const f = await fixture(t), { call } = await handlerFor(f);
  const results = await Promise.all(Array.from({ length: 5 }, () => call('read_evidence', { ids: ['E0001'] })));
  results.forEach(data); const proof = await f.proof();
  assert.equal(proof.toolCalls, 5); assert.deepEqual(proof.evidenceReadIds, ['E0001']); assert.equal(proof.tools.length, 5);
});

test('trusted context limits use the expanded defaults and fixed hard caps, while wire limits remain forbidden', async t => {
  const defaults = await fixture(t), normal = await handlerFor(defaults);
  data(await normal.call('list_inputs'));
  assert.deepEqual((await defaults.proof()).limits, { calls: 32, returnedCharacters: 128000, evidenceCharacters: 96000, parserRuns: 4,
    skillCharacters: 24000, parserCharacters: 8000, parserTimeoutMs: 60000 });
  const trusted = await fixture(t, context => { context.toolLimits = { calls: 96, returnedCharacters: 384000, evidenceCharacters: 256000, parserRuns: 8 }; });
  const high = await handlerFor(trusted), result = data(await high.call('list_inputs'));
  assert.equal(result.budget.remainingCalls, 95); assert.equal(result.budget.remainingParserRuns, 8);
  assert.equal((await high.call('list_inputs', { toolLimits: { calls: 1000 } })).isError, true);
  assert.equal((await trusted.proof()).limits.calls, 96);
  for (const toolLimits of [{ calls: 97 }, { returnedCharacters: 384001 }, { evidenceCharacters: 256001 }, { parserRuns: 9 }, { parserRuns: 0 }, { calls: 1.5 }, { parserTimeoutMs: 1 }, { command: 'other' }, []]) {
    const invalid = await fixture(t, context => { context.toolLimits = toolLimits; });
    await assert.rejects(createTriageToolHandler({ contextFile: invalid.contextFile }), { code: 'TRIAGE_TOOL_LIMITS' });
  }
});

test('one read returns 60 real evidence lines, and repeated IDs send only an index without duplicate evidence charges', async t => {
  const f = await fixture(t, async context => {
    const lines = Array.from({ length: 60 }, (_, index) => `2026-11-20 10:00:00 INFO synthetic line ${index} ${'a'.repeat(450)}`);
    const text = lines.join('\n') + '\n'; await writeFile(join(context.directory, 'example.log'), text);
    context.files = [{ path: 'example.log', bytes: Buffer.byteLength(text), sha256: digest(text) }];
    context.payload.evidence = lines.map((text, index) => ({ id: 'E' + String(index + 1).padStart(4, '0'), file: 'example.log', line: index + 1,
      text, time: '2026-11-20 10:00:00', timeZone: 'unconfirmed', sha256: digest(lines.join('\n') + '\n') }));
  });
  const { call } = await handlerFor(f), ids = f.context.payload.evidence.map(item => item.id);
  const firstRaw = await call('read_evidence', { ids }), first = data(firstRaw), afterFirst = await f.proof();
  assert.equal(first.evidence.length, 60); assert.deepEqual(first.alreadyProvided, []);
  const repeatedRaw = await call('read_evidence', { ids }), repeated = data(repeatedRaw), afterRepeated = await f.proof();
  assert.deepEqual(repeated.evidence, []); assert.equal(repeated.alreadyProvided.length, 60);
  assert.ok(repeated.alreadyProvided.every(item => !Object.hasOwn(item, 'text')));
  assert.equal(afterRepeated.evidenceCharacters, afterFirst.evidenceCharacters);
  assert.equal(afterRepeated.returnedCharacters, firstRaw.content[0].text.length + repeatedRaw.content[0].text.length);
  assert.equal(repeated.budget.remainingCharacters, afterRepeated.limits.returnedCharacters - afterRepeated.returnedCharacters);
  assert.equal(repeated.budget.remainingEvidenceCharacters, afterRepeated.limits.evidenceCharacters - afterRepeated.evidenceCharacters);
  assert.equal((await call('read_evidence', { ids: [...ids, 'E0061'] })).isError, true);
});

test('parser scopes cache by file path and hash regardless of order, with four distinct real runs allowed', async t => {
  const files = [];
  const f = await fixture(t, async context => {
    for (const directory of ['a', 'b', 'c', 'd']) files.push((await addChunk(context, directory + '/com.carota.log', 1000, directory)).file.path);
  });
  const { call } = await handlerFor(f);
  const first = data(await call('run_parser', { files: files.slice(0, 2) }));
  const pid = (await f.proof()).parserProcess.pid;
  const repeated = data(await call('run_parser', { files: files.slice(0, 2).reverse() }));
  assert.equal(first.cacheHit, false); assert.equal(repeated.cacheHit, true); assert.deepEqual(repeated.hints, first.hints); assert.deepEqual(repeated.selectedFiles, first.selectedFiles);
  assert.equal((await f.proof()).parserRunCount, 1); assert.equal((await f.proof()).parserProcess.pid, pid);
  for (const file of [files[2], files[3], 'example.log']) data(await call('run_parser', { files: [file] }));
  assert.equal((await f.proof()).parserRunCount, 4); assert.equal((await f.proof()).parserScopes.length, 4);
  assert.equal((await readdir(f.root)).filter(name => name.startsWith('parser-inputs-')).length, 4);
  assert.match((await call('run_parser', { files: [files[0]] })).content[0].text, /PARSER_RUN_LIMIT/u);
  const cachedAfterLimit = data(await call('run_parser', { files: files.slice(0, 2) }));
  assert.equal(cachedAfterLimit.cacheHit, true); assert.equal(cachedAfterLimit.budget.remainingParserRuns, 0); assert.match(cachedAfterLimit.guidance, /完成报告/u);
});

test('failed parser scopes consume real-run budget and cache errors without retrying the child', async t => {
  const f = await fixture(t, async context => { await addChunk(context, 'other/com.carota.log', 1000); });
  const { call } = await handlerFor(f, { parserRuns: 2, parserTimeoutMs: 1 });
  assert.equal((await call('run_parser', { files: ['example.log'] })).isError, true);
  const pid = (await f.proof()).parserProcess.pid;
  const again = await call('run_parser', { files: ['example.log'] });
  assert.equal(JSON.parse(again.content[0].text).cachedError, true); assert.equal((await f.proof()).parserRunCount, 1); assert.equal((await f.proof()).parserProcess.pid, pid);
  assert.equal((await call('run_parser', { files: ['other/com.carota.log'] })).isError, true);
  assert.match((await call('run_parser', { files: ['example.log', 'other/com.carota.log'] })).content[0].text, /PARSER_RUN_LIMIT/u);
  const proof = await f.proof(); assert.equal(proof.parserRunCount, 2); assert.equal(proof.parserRan, false); assert.ok(proof.parserScopes.every(scope => scope.status === 'failed'));
});

test('all tool result text including budget metadata and safe errors is included in the returned-character counter', async t => {
  const f = await fixture(t), { call } = await handlerFor(f, { calls: 3 }); let total = 0;
  for (const [name, args] of [['list_inputs', {}], ['read_evidence', { ids: ['E9999'] }], ['read_evidence', { ids: ['E0001'] }]]) {
    const result = await call(name, args); total += result.content[0].text.length;
    const value = JSON.parse(result.content[0].text), proof = await f.proof();
    assert.equal(proof.returnedCharacters, total); assert.equal(value.budget.remainingCharacters, proof.limits.returnedCharacters - total);
  }
  const proof = await f.proof(); assert.equal(proof.counter, 3); assert.equal(proof.evidenceReadIds.length, 1);
});
