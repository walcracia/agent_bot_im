import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LogTriageWorker, TriageWorkerError, inspectTriageInputs, verifySkill } from '../log-triage-worker.mjs';
import { validateModelReport, renderReport, redact, collectEvidence, buildModelPayload } from '../triage-report.mjs';
import { createHash } from 'node:crypto';
import { createTriageToolHandler, TRIAGE_SKILL_ID } from '../triage-tools.mjs';
import { SkillExecutionService } from '../skill-execution.mjs';
import { mapPluginReport } from '../triage-plugin-recipe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PYTHON = process.env.IM_TEST_PYTHON || join(ROOT, 'environment/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const REAL_SKILL = process.env.TRIAGE_REAL_SKILL_ROOT || join(ROOT, 'environment/tools/ota-log-triage-1.3.2');
const LOG = '2026-11-20 09:59:00 CloudTransmitter before\n2026-11-20 10:00:00 CloudTransmitter ERROR timeout token=private-token https://private.example/log.zip\n2026-11-20 10:01:00 CloudTransmitter after\n';
const snapshot = changes => ({ id: 'T000001', inputRevision: 2, issue: { id: 42, no: 'DEMO-42', title: '升级失败', description: '升级显示超时，需要对照日志。' },
  fileIds: [1], window: { date: '2026-11-20', from: '10:00', to: '10:00', timeZone: 'Asia/Shanghai' }, clockDomains: { ota: 'Asia/Shanghai' }, ...changes });
const modelReport = payload => ({ conclusion: '日志显示时间窗口内出现超时，根因待验证。', confidence: 'low', responsibility: '待验证',
  evidence: [{ id: payload.evidence[0].id, interpretation: '窗口内记录超时。' }], timeline: [{ id: payload.evidence[0].id, event: '发现超时记录。' }],
  alternatives: ['需要进一步核对网络或服务状态。'], nextSteps: ['补充同时间段的上下游证据。'], limitations: ['现有证据不足以确认最终根因。'] });

async function fixture(t, { data = LOG, name = 'com.carota.log', response, realSkill = false, limits = {}, model, metadata = {}, parserSource } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'teamplay-triage-'));
  t.after(async () => {
    assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(directory.includes(sep + 'teamplay-triage-'));
    await rm(directory, { recursive: true, force: true });
  });
  const parser = join(directory, 'parser.cjs');
  await writeFile(parser, parserSource ?? "console.log(JSON.stringify({findings:[],filesUsed:[],verdict:null,suggestions:[]}));\n");
  let requests = 0;
  const server = createServer((req, res) => { requests++; if (response) response(req, res); else { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(data); } });
  server.listen(0, '127.0.0.1'); await new Promise(resolveReady => server.once('listening', resolveReady));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let modelCalls = 0, seen;
  const worker = new LogTriageWorker({ root: join(directory, 'runs'), skillRoot: REAL_SKILL, python: PYTHON,
    adapter: { getFile: async () => ({ url: origin + '/file', name, ...metadata }) }, downloadOrigins: [origin], limits,
    ...(realSkill ? {} : { verifySkill: async () => ({ parser, rules: 'Synthetic parser/rules fixture; no real parser claim.' }) }),
    model: async (payload, options) => { modelCalls++; seen = payload; return model ? model(payload, options) : modelReport(payload); } });
  return { worker, directory, origin, server, calls: () => modelCalls, seen: () => seen, requests: () => requests };
}

test('zero total timeout and a service-verified dynamic source line reach the final Worker report and usage', async t => {
  const data = Array.from({ length: 300 }, (_, index) => `2026-11-20 10:00:00 CAROTA CORE VER state ${index + 1}`).join('\n');
  const f = await fixture(t, { data, limits: { runTimeoutMs: 0 } });
  f.worker.executionService = new SkillExecutionService({ root: f.directory, runner: { runSkill: async request => {
    await new Promise(resolve => setTimeout(resolve, 25));
    const file = request.inputFiles[0], actual = await readFile(join(request.executionContext.directory, file.path), 'utf8');
    const entry = { id: 'E9999', file: file.path, line: 201, text: actual.split('\n')[200], sha256: file.sha256,
      time: '2026-11-20 10:00:00', aligned: false, inRequestedWindow: null };
    return { evidence: [entry], result: { conclusion: 'Actual source record checked', confidence: 'high', responsibility: '待验证',
      evidence: [{ id: entry.id, interpretation: 'Observed line 201' }], timeline: [{ id: entry.id, event: 'Recorded state' }], alternatives: [], nextSteps: ['Review source'], limitations: [] },
      execution: { backend: 'dsh', agentSessions: 1, providerRequests: 41, toolCalls: 140, skillLoaded: true, proofValidated: true,
        usage: { elapsedMs: 25, providerRequests: 41, toolCalls: 140, toolCallsByName: { read_evidence: 1 }, evidenceReadCalls: 1, evidenceLines: 1, parserRuns: 8 } } };
  } } });
  const result = await f.worker.run(snapshot({ window: {} }), { beforeModel: async () => {} });
  assert.equal(result.status, 'completed'); assert.equal(result.execution.providerRequests, 41); assert.equal(result.execution.usage.evidenceLines, 1);
  assert.ok(result.report.evidenceIndex.some(item => item.id === 'E9999' && item.line === 201)); assert.match(result.text, /com\.carota\.log:201/u);
  assert.equal(result.report.confidence, 'high'); assert.equal(result.files.length, 2);
});

test('the original plugin recipe owns all evidence selection and its full report survives the Worker without a second model', async t => {
  const f = await fixture(t); let calls = 0;
  const runner = { recipe: 'chery-qa-plugin', async runSkill(request) {
    calls++; assert.deepEqual(request.executionContext.payload.evidence, []);
    const file = request.inputFiles[0], actual = await readFile(join(request.executionContext.directory, file.path), 'utf8');
    const evidence = [{ id: 'E0001', file: file.path, line: 2, text: redact(actual.split('\n')[1]), sha256: file.sha256, time: '', aligned: false }];
    const sourceReport = `# OTA 日志分析报告\n\n【结论】\n责任方：服务连接；置信度：中。\n保持原模型判断。\n\n【依据】\n${file.path}:2 超时记录。\n\n【时间线】\n${file.path}:2 出现超时。\n\n【其他可能】\n需要核对服务。\n\n【下一步】\n联系维护者。`;
    return { result: mapPluginReport(sourceReport, evidence), sourceReport, evidence,
      execution: { backend: 'dsh', recipe: this.recipe, agentSessions: 1, providerRequests: 1, toolCalls: 0, skillLoaded: true, proofValidated: true,
        usage: { providerRequests: 1, toolCalls: 0, parserRuns: 1 } } };
  } };
  f.worker.executionService = new SkillExecutionService({ root: f.directory, runner });
  const result = await f.worker.run(snapshot({ window: {} }));
  assert.equal(calls, 1); assert.equal(f.calls(), 0); assert.equal(result.status, 'completed');
  assert.equal(result.manifest.preparation.kind, 'chery-qa-plugin'); assert.equal(result.execution.toolCalls, 0);
  assert.ok(result.text.startsWith(result.report.sourceReport)); assert.ok(result.report.conclusion.includes('保持原模型判断。'));
});

test('an explicit symptom is passed intact to the skill service beyond the former 4000 character slice', async t => {
  const f = await fixture(t), symptom = '合成现象。'.repeat(1200) + '末尾关键补充';
  let received;
  f.worker.executionService = { async execute(request, { beforeExecute }) {
    received = request.parameters.symptom; await beforeExecute(); return serviceResult(request);
  } };
  const result = await f.worker.run(snapshot({ descriptionOverride: symptom }));
  assert.equal(result.status, 'completed'); assert.equal(received, symptom); assert.ok(received.endsWith('末尾关键补充'));
});

test('missing logs wait; missing description/timezone/date stays preliminary and openedAt never supplies fault date', async t => {
  const f = await fixture(t);
  const missingLog = await f.worker.run(snapshot({ fileIds: [] })); assert.equal(missingLog.status, 'waiting_log');
  const noDate = snapshot({ window: { from: '10:00', to: '10:01', timeZone: 'Asia/Shanghai' } }); noDate.issue.openedAt = '2026-11-20T02:00:00Z';
  const preliminary = await f.worker.run(noDate);
  assert.equal(preliminary.status, 'completed'); assert.equal(preliminary.report.mode, 'preliminary');
  assert.equal(preliminary.report.window.date, null); assert.match(preliminary.text, /日志分析/);
  const noDescription = snapshot(); delete noDescription.issue.description;
  assert.equal((await f.worker.run(noDescription)).status, 'completed');
  assert.equal(inspectTriageInputs(snapshot({ window: { date: '2026-02-30', from: '10:00', to: '10:01', timeZone: 'UTC' } })).status, 'waiting_input');
  assert.equal(f.requests(), 2); assert.equal(f.calls(), 2);
});

test('synthetic parser path: exact revision, windowed numbered evidence, redaction and report survive one guarded model call', async t => {
  const f = await fixture(t); let guard = 0;
  const result = await f.worker.run(snapshot(), { beforeModel: async () => { guard++; } });
  assert.equal(result.status, 'completed'); assert.equal(result.inputRevision, 2); assert.equal(result.modelCalls, 1);
  assert.equal(f.calls(), 1); assert.equal(guard, 1);
  const evidence = f.seen().evidence;
  assert.equal(evidence.length, 1); assert.equal(evidence[0].line, 2); assert.equal(evidence[0].time, '2026-11-20T02:00:00.000Z');
  assert.match(evidence[0].text, /已隐藏/); assert.ok(!JSON.stringify(f.seen()).includes('private-token'));
  assert.ok(!JSON.stringify(f.seen()).includes('private.example')); assert.equal(f.seen().issue.no, 'DEMO-42');
  assert.match(result.text, /日志分析/); assert.match(result.text, /com.carota.log:2/); assert.equal(result.manifest.attachments[0].bytes, Buffer.byteLength(LOG));
  assert.match(result.manifest.attachments[0].sha256, /^[a-f0-9]{64}$/);
});

test('host path redaction covers spaces, drive/UNC/file URLs and home/tmp roots while keeping device paths', () => {
  const hostPaths = [String.raw`C:\Users\synthetic windows\AppData\Private\trace.log`,
    'D:/syntheticforward/private.log', String.raw`\\syntheticserver\syntheticshare\private folder\trace.log`,
    '//syntheticunixshare/private/log.txt', '/Users/syntheticmac/private.log', '/home/syntheticlinux/private.log',
    '/tmp/synthetictmp/trace.log', '/var/tmp/syntheticvartmp/trace.log', 'file:///home/syntheticfile/private.log',
    String.raw`C:\Users\synthetic (private) [folder]\trace.log`, '/home/synthetic (private) [folder]/trace.log'];
  for (const path of hostPaths) {
    assert.equal(redact(`"${path}"`), '"[本机路径已隐藏]"');
    assert.equal(redact(redact(path)), redact(path));
  }
  const devicePaths = '/data/ota/update.log\n/var/log/slave-da.log\n/opt/ota/bin\nrelative/com.carota.log';
  assert.equal(redact(devicePaths), devicePaths);
  assert.equal(redact('unrelated /homeward/file /tmpfile /data/home/team.log'), 'unrelated /homeward/file /tmpfile /data/home/team.log');
});

test('REAL parser synthetic host paths are hidden in evidence and every model output field without changing original file/line/hash', { skip: !existsSync(REAL_SKILL) }, async t => {
  const paths = [String.raw`C:\Users\syntheticwindows\private folder\trace.log`, 'D:/syntheticforward/trace.log',
    String.raw`\\syntheticserver\syntheticshare\trace.log`, '/Users/syntheticmac/private.log', '/home/syntheticlinux/private.log',
    '/tmp/synthetictmp/trace.log', '/var/tmp/syntheticvartmp/trace.log'];
  const data = '2026-11-20 09:59:00 CloudTransmitter before\n'
    + paths.map(path => `2026-11-20 10:00:00 CloudTransmitter ERROR reading "${path}" device=/data/ota/update.log`).join('\n') + '\n';
  const expectedHash = createHash('sha256').update(data).digest('hex');
  const f = await fixture(t, { data, realSkill: true, model: payload => {
    const raw = modelReport(payload), prose = paths.map(path => `"${path}"`).join('; ') + '; /data/ota/update.log';
    return { ...raw, conclusion: prose, responsibility: paths[0], evidence: [{ id: payload.evidence[0].id, interpretation: prose }],
      timeline: [{ id: payload.evidence[0].id, event: prose }], alternatives: [prose], nextSteps: [prose], limitations: [prose] };
  } });
  const result = await f.worker.run(snapshot());
  assert.equal(result.status, 'completed'); assert.equal(f.calls(), 1);
  const publicOutput = JSON.stringify({ payload: f.seen(), text: result.text, report: result.report });
  for (const privatePart of ['syntheticwindows', 'syntheticforward', 'syntheticserver', 'syntheticshare', 'syntheticmac', 'syntheticlinux', 'synthetictmp', 'syntheticvartmp'])
    assert.ok(!publicOutput.includes(privatePart), `${privatePart} must not leave the worker`);
  assert.match(result.text, /本机路径已隐藏/); assert.match(result.text, /\/data\/ota\/update.log/);
  assert.deepEqual(result.report.evidenceIndex.map(item => item.line), paths.map((_path, index) => index + 2));
  assert.ok(result.report.evidenceIndex.every(item => item.file === 'input-001/com.carota.log' && item.sha256 === expectedHash));
  assert.equal(result.manifest.attachments[0].sha256, expectedHash);
  assert.equal(result.manifest.files[0].sha256, expectedHash);
  assert.equal(result.manifest.attachments[0].bytes, Buffer.byteLength(data));
});

test('UTC clocks align; unspecified log clocks preserve raw preliminary time and empty windows give a zero-model preliminary report', async t => {
  const utc = await fixture(t, { data: '2026-11-20 02:00:00 Starting slave-da ERROR failed\n', name: 'slave-da.log' });
  const result = await utc.worker.run(snapshot({ clockDomains: { slave: 'UTC' } })); assert.equal(result.status, 'completed');
  assert.equal(utc.seen().evidence[0].time, '2026-11-20T02:00:00.000Z');
  const unknown = await fixture(t); const initial = await unknown.worker.run(snapshot({ clockDomains: {} }));
  assert.equal(initial.status, 'completed'); assert.equal(initial.report.mode, 'preliminary'); assert.equal(unknown.calls(), 1);
  assert.equal(unknown.seen().evidence[0].aligned, false); assert.equal(unknown.seen().evidence[0].inRequestedWindow, null);
  assert.match(unknown.seen().evidence[0].time, /^2026-11-20 09:59:00$/);
  const empty = await fixture(t, { data: '2026-11-20 09:00:00 CloudTransmitter outside\n' });
  const noEvidence = await empty.worker.run(snapshot()); assert.equal(noEvidence.status, 'completed');
  assert.equal(noEvidence.modelCalls, 0); assert.equal(empty.calls(), 0); assert.match(noEvidence.text, /不代表系统没有故障/);
});

test('streamed download ignores retired size quotas while metadata hashes and origins remain verified', async t => {
  const large = await fixture(t, { data: LOG, limits: { maxFileBytes: 30, maxDownloadBytes: 30 } });
  assert.equal((await large.worker.run(snapshot())).status, 'completed');
  const badHash = await fixture(t, { metadata: { md5: '0'.repeat(32) } });
  await assert.rejects(badHash.worker.run(snapshot())); assert.equal(badHash.calls(), 0);
  let redirect;
  const redirected = await fixture(t, { response: (_req, res) => { res.writeHead(302, { location: redirect }); res.end(); } });
  redirect = redirected.origin.replace('127.0.0.1', 'localhost') + '/target';
  await assert.rejects(redirected.worker.run(snapshot()), e => !e.modelStarted && e.phase === 'download'); assert.equal(redirected.requests(), 1);
});
function zip(entries) {
  return execFileSync(PYTHON, ['-c', "import sys,json,io,zipfile,stat; b=io.BytesIO(); z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED); entries=json.loads(sys.argv[1]); [(z.writestr(x[0],x[1])) for x in entries]; z.close(); sys.stdout.buffer.write(b.getvalue())", JSON.stringify(entries)], { windowsHide: true });
}
test('streamed ZIP accepts dense legitimate input while refusing traversal, drive paths and case collisions', async t => {
  for (const entries of [[['com.carota.log', LOG]], [['com.carota.log', 'A'.repeat(20000)]]]) {
    const safe = await fixture(t, { name: 'logs.zip', data: zip(entries), limits: { maxCompressionRatio: 1, maxExpandedBytes: 10, maxExpandedFileBytes: 10, maxExtractedFiles: 0 } });
    assert.equal((await safe.worker.run(snapshot())).status, 'completed');
  }
  for (const entries of [[['../escape.txt', LOG]], [['C:\\escape.txt', LOG]], [['A.log', LOG], ['a.log', LOG]]]) {
    const attack = await fixture(t, { name: 'logs.zip', data: zip(entries) });
    await assert.rejects(attack.worker.run(snapshot()), e => e.phase === 'extract' && !e.modelStarted && e.processTreeStopped); assert.equal(attack.calls(), 0);
  }
});
test('safe and nested ZIPs leave exactly their leaf manifest and initialize the real strict skill tool handler', async t => {
  const nested = execFileSync(PYTHON, ['-c', `import sys,io,zipfile
inner=io.BytesIO()
with zipfile.ZipFile(inner,'w',zipfile.ZIP_DEFLATED) as z: z.writestr('nested/com.carota.log',sys.argv[1])
outer=io.BytesIO()
with zipfile.ZipFile(outer,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('inner.zip',inner.getvalue()); z.writestr('side.log',sys.argv[1])
sys.stdout.buffer.write(outer.getvalue())`, LOG], { windowsHide: true });
  for (const bytes of [zip([['com.carota.log', LOG]]), nested]) {
    const f = await fixture(t, { name: 'logs.zip', data: bytes });
    let calls = 0;
    f.worker.executionService = { async execute(request, { beforeExecute }) {
      calls++;
      const directory = request.executionContext.directory;
      const leaves = [];
      const walk = async (path, prefix = '') => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(join(path, entry.name), prefix + entry.name + '/');
          else { assert.equal(entry.isFile(), true); leaves.push(prefix + entry.name); }
        }
      };
      await walk(directory);
      assert.deepEqual(leaves.sort(), request.inputFiles.map(file => file.path).sort());
      assert.ok(!leaves.some(path => path.endsWith('.zip')));
      const runRoot = dirname(directory), original = await readFile(join(runRoot, 'download-1'));
      assert.deepEqual(original, bytes);
      const contextFile = join(runRoot, 'tool-context.json');
      await writeFile(contextFile, JSON.stringify({ skillId: TRIAGE_SKILL_ID, taskId: request.taskId, inputRevision: request.inputRevision,
        skillRoot: request.executionContext.skillRoot, directory, files: request.inputFiles, payload: request.executionContext.payload,
        proofPath: join(runRoot, 'tool-proof.json') }));
      const handler = await createTriageToolHandler({ contextFile });
      const initialized = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      assert.ok(initialized.result);
      const listed = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_inputs', arguments: {} } });
      assert.notEqual(listed.result.isError, true);
      assert.deepEqual(JSON.parse(listed.result.content[0].text).files, request.inputFiles);
      await beforeExecute();
      return serviceResult(request);
    } };
    const result = await f.worker.run(snapshot());
    assert.equal(result.status, 'completed'); assert.equal(calls, 1); assert.equal(f.calls(), 0);
    assert.equal(result.manifest.attachments[0].sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.manifest.attachments[0].bytes, bytes.length);
  }
});

test('tar/gzip are expanded under budget and archive symlinks/special files are rejected', async t => {
  const bytes = kind => execFileSync(PYTHON, ['-c', `import sys,io,tarfile,gzip,zipfile,stat
b=io.BytesIO(); kind=sys.argv[1]; data=sys.argv[2].encode()
if kind=='gz': b.write(gzip.compress(data))
elif kind=='zip-link':
 z=zipfile.ZipFile(b,'w'); i=zipfile.ZipInfo('link.log'); i.create_system=3; i.external_attr=(stat.S_IFLNK|0o777)<<16; z.writestr(i,'../../outside'); z.close()
else:
 t=tarfile.open(fileobj=b,mode='w:gz'); i=tarfile.TarInfo('com.carota.log'); i.size=len(data)
 if kind=='tar-link': i.type=tarfile.SYMTYPE; i.linkname='../../outside'; i.size=0; t.addfile(i)
 elif kind=='tar-special': i.type=tarfile.FIFOTYPE; i.size=0; t.addfile(i)
 else: t.addfile(i,io.BytesIO(data))
 t.close()
sys.stdout.buffer.write(b.getvalue())`, kind, LOG], { windowsHide: true });
  for (const kind of ['gz', 'tar']) {
    const f = await fixture(t, { name: kind === 'gz' ? 'com.carota.log.gz' : 'logs.tar.gz', data: bytes(kind) });
    assert.equal((await f.worker.run(snapshot())).status, 'completed');
  }
  for (const kind of ['zip-link', 'tar-link', 'tar-special']) {
    const f = await fixture(t, { name: kind === 'zip-link' ? 'logs.zip' : 'logs.tar.gz', data: bytes(kind) });
    await assert.rejects(f.worker.run(snapshot()), e => e.phase === 'extract' && !e.modelStarted && e.processTreeStopped);
  }
});

test('manifest integrity is pinned, not replaceable with another locally consistent manifest', { skip: !existsSync(REAL_SKILL) }, async t => {
  await verifySkill(REAL_SKILL);
  const f = await fixture(t), copy = join(f.directory, 'skill'); await cp(REAL_SKILL, copy, { recursive: true });
  await writeFile(join(copy, 'scripts/triage.js'), 'console.log("tampered");');
  await assert.rejects(verifySkill(copy), /digest changed/);
  const integrity = JSON.parse(await readFile(join(copy, 'integrity.json'), 'utf8'));
  integrity.files['scripts/triage.js'] = '0'.repeat(64); await writeFile(join(copy, 'integrity.json'), JSON.stringify(integrity));
  await assert.rejects(verifySkill(copy), /manifest digest changed/);
});

test('REAL pinned 1.3.2 parser on synthetic logs plus FAKE model validates actual CLI/schema without business data', { skip: !existsSync(REAL_SKILL) }, async t => {
  const f = await fixture(t, { realSkill: true });
  const result = await f.worker.run(snapshot()); assert.equal(result.status, 'completed'); assert.equal(f.calls(), 1);
  assert.equal(result.manifest.skillVersion, '1.3.2'); assert.equal(result.report.evidenceIndex[0].line, 2);
});

test('model cannot fabricate file/line references and report strings remain bounded', async t => {
  const f = await fixture(t, { model: payload => ({ ...modelReport(payload), evidence: [{ id: 'E9999', interpretation: 'invented' }] }) });
  await assert.rejects(f.worker.run(snapshot()), e => e.phase === 'report' && e.modelStarted && e.processTreeStopped); assert.equal(f.calls(), 1);
});

test('beforeModel revision/permission/budget rejection preserves error code and invokes zero model calls', async t => {
  const f = await fixture(t);
  await assert.rejects(f.worker.run(snapshot(), { beforeModel: () => { const e = new Error('revision changed'); e.code = 'TRIAGE_INPUT_CHANGED'; throw e; } }),
    e => e.phase === 'before-model' && !e.modelStarted && e.code === 'TRIAGE_INPUT_CHANGED' && e.cause?.code === 'TRIAGE_INPUT_CHANGED');
  assert.equal(f.calls(), 0);
});

test('prompt material is not discarded because of the retired cumulative character quota', async t => {
  const data = Array.from({ length: 100 }, (_, i) => '2026-11-20 10:00:00 CloudTransmitter ERROR ' + 'X'.repeat(550)).join('\n');
  const f = await fixture(t, { data, limits: { maxInputCharacters: 10000 } });
  assert.equal((await f.worker.run(snapshot())).status, 'completed'); assert.ok(JSON.stringify(f.seen()).length > 10000); assert.equal(f.seen().evidence.length, 60);
});
test('a late ERROR after 1300 ordinary lines reaches the model with its real line/file/hash and early context', async t => {
  const data = Array.from({ length: 1300 }, (_value, index) => `2026-11-20 10:00:00 CloudTransmitter normal startup ${index + 1}`).join('\n')
    + '\n2026-11-20 10:00:00 CloudTransmitter ERROR synthetic-late-failure\n';
  const f = await fixture(t, { data });
  const result = await f.worker.run(snapshot());
  assert.equal(result.status, 'completed'); assert.equal(f.calls(), 1);
  const evidence = f.seen().evidence, late = evidence.find(item => item.text.includes('synthetic-late-failure'));
  assert.ok(late); assert.equal(late.line, 1301); assert.equal(late.file, 'input-001/com.carota.log');
  assert.equal(late.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(evidence.length, 60);
  for (let line = 1; line <= 40; line++) assert.ok(evidence.some(item => item.line === line));
});

test('late anomaly replacement keeps exactly the candidate cap and first forty anchors without expanding the scan', async t => {
  const f = await fixture(t);
  const data = [...Array.from({ length: 1300 }, (_value, index) => `normal ${index + 1}`),
    ...Array.from({ length: 1300 }, (_value, index) => `ERROR synthetic ${index + 1}`)].join('\n');
  const path = 'com.carota.log', sha256 = createHash('sha256').update(data).digest('hex');
  await writeFile(join(f.directory, path), data);
  const result = await collectEvidence({ directory: f.directory, files: [{ path, sha256 }], window: { mode: 'preliminary' },
    limits: { ...f.worker.limits, maxEvidence: 1200 } });
  assert.equal(result.scanned, 2600); assert.equal(result.evidence.length, 1200);
  assert.deepEqual(result.evidence.filter(item => !item.text.startsWith('ERROR')).map(item => item.line), Array.from({ length: 40 }, (_value, index) => index + 1));
  assert.equal(result.evidence.filter(item => item.text.startsWith('ERROR')).length, 1160);
  assert.ok(result.evidence.every(item => item.sha256 === sha256 && item.file === path));
  assert.equal(f.calls(), 0);
});

test('the entry catalog and parser references are preserved when the former prompt quota is smaller than the material', () => {
  const evidence = Array.from({ length: 80 }, (_, index) => ({ id: 'E' + String(index + 1).padStart(4, '0'), file: 'app.log', line: index + 1, text: 'X'.repeat(900), aligned: false }));
  const payload = buildModelPayload({ snapshot: snapshot(), window: { mode: 'preliminary' }, evidence, parserSummary: [{ summary: 'actual source', evidenceIds: ['E0080'] }], rules: 'fixed rules', limitations: [], maxCharacters: 1 });
  assert.equal(payload.evidence.length, 80); assert.equal(payload.parserSummary[0].evidenceIds[0], 'E0080'); assert.ok(JSON.stringify(payload).length > 48000);
});
test('cancellation before work is zero-call and unconfirmed model cancellation becomes uncertain rather than retrying', async t => {
  const before = await fixture(t), cancel = new AbortController(); cancel.abort();
  await assert.rejects(before.worker.run(snapshot(), { signal: cancel.signal }), e => !e.modelStarted); assert.equal(before.requests(), 0);
  const duringModel = new AbortController();
  const hung = await fixture(t, { model: () => { duringModel.abort(); return new Promise(() => {}); }, limits: { terminationGraceMs: 100 } });
  await assert.rejects(hung.worker.run(snapshot(), { signal: duringModel.signal }), e => e.kind === 'model-uncertain' && e.modelStarted && !e.processTreeStopped);
  assert.equal(hung.calls(), 1);
});

test('parser timeout waits for actual child termination and never calls the report model', async t => {
  const f = await fixture(t, { parserSource: 'setInterval(() => {}, 1000);', limits: { parserTimeoutMs: 400 } });
  await assert.rejects(f.worker.run(snapshot()), e => e.kind === 'parser-timeout' && e.phase === 'parser' && e.processTreeStopped && !e.modelStarted);
  assert.equal(f.calls(), 0);
});

test('opaque attachments still return an honest zero-model preliminary report; supplied invalid timezone is not guessed', async t => {
  const f = await fixture(t, { name: 'screenshot.png', data: Buffer.from([137, 80, 78, 71, 13, 10]) });
  const out = await f.worker.run(snapshot({ window: undefined }));
  assert.equal(out.status, 'completed'); assert.equal(out.modelCalls, 0); assert.equal(out.report.mode, 'preliminary');
  assert.match(out.text, /未识别到可分析的文本日志/); assert.equal(f.calls(), 0);
  assert.equal(inspectTriageInputs(snapshot({ window: { timeZone: 'not-a-zone' } })).status, 'waiting_input');
});

async function serviceResult(request, { partial = false, judgement = {}, usage } = {}) {
  const payload = request.executionContext.payload;
  const result = validateModelReport({ ...modelReport(payload), ...judgement }, payload);
  if (partial) {
    result.conclusion = '助手未完成完整判断，当前只提供已核对的日志线索，根因待验证。';
    result.confidence = 'low'; result.responsibility = '待验证';
    result.limitations.push('达到阅读上限，未形成完整判断，本次未追加模型调用。');
  }
  const files = [];
  for (const [name, mime, content] of [['report.json', 'application/json', JSON.stringify(result, null, 2)],
    ['报告.txt', 'text/plain', renderReport(result, payload, usage)]]) {
    const pathPrivate = join(request.executionContext.outputDirectory, name);
    const bytes = Buffer.from(content); await writeFile(pathPrivate, bytes, { flag: 'wx' });
    files.push({ name, mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), pathPrivate });
  }
  return { status: partial ? 'partial' : 'completed', result, files, execution: { backend: 'dsh', agentSessions: 1,
    providerRequests: partial ? 6 : 3, toolCalls: partial ? 11 : 4, skillLoaded: true, proofValidated: true, ...(usage ? { usage } : {}) } };
}

test('verified partial service results preserve partial status and both strict artifacts without a second admission or model', async t => {
  const f = await fixture(t); let serviceCalls = 0, admissions = 0, runDirectory;
  f.worker.executionService = { async execute(request, { beforeExecute }) {
    serviceCalls++; await beforeExecute(); runDirectory = dirname(request.executionContext.directory);
    return serviceResult(request, { partial: true });
  } };
  const result = await f.worker.run(snapshot(), { beforeModel() { admissions++; } });
  assert.equal(result.status, 'partial'); assert.equal(result.modelCalls, 1);
  assert.equal(serviceCalls, 1); assert.equal(admissions, 1); assert.equal(f.calls(), 0);
  assert.equal(result.execution.providerRequests, 6); assert.equal(result.execution.toolCalls, 11);
  assert.equal(result.report.confidence, 'low'); assert.equal(result.report.responsibility, '待验证');
  assert.match(result.text, /助手未完成完整判断/); assert.match(result.text, /达到阅读上限/);
  assert.equal(result.files.length, 2); assert.equal(result.manifest.outputs.length, 2);
  for (const file of result.files) {
    const bytes = await readFile(file.pathPrivate);
    assert.equal(bytes.length, file.size); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  assert.equal(JSON.parse(await readFile(join(runDirectory, 'report.json'), 'utf8')).status, 'partial');
});

test('partial status cannot bypass strict report references, artifact hashes or real proof validation', async t => {
  for (const altered of ['reference', 'sha256', 'proof']) {
    const f = await fixture(t); let serviceCalls = 0, admissions = 0;
    f.worker.executionService = { async execute(request, { beforeExecute }) {
      serviceCalls++; await beforeExecute();
      const result = await serviceResult(request, { partial: true });
      if (altered === 'reference') result.result.evidence[0].id = 'E9999';
      else if (altered === 'sha256') result.files[0].sha256 = '0'.repeat(64);
      else result.execution.proofValidated = false;
      return result;
    } };
    await assert.rejects(f.worker.run(snapshot(), { beforeModel() { admissions++; } }), error => error.phase === 'report'
      && error.modelStarted === true && error.processTreeStopped === true);
    assert.equal(serviceCalls, 1); assert.equal(admissions, 1); assert.equal(f.calls(), 0);
  }
});

const PREPARATION_PARSER = String.raw`
const fs = require('node:fs'), path = require('node:path'), root = process.argv[2], files = [];
function walk(directory) { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const name=path.join(directory,item.name); if(item.isDirectory())walk(name); else files.push(name); } }
walk(root);
if(files.length>3 || files.reduce((sum,file)=>sum+fs.statSync(file).size,0)>16000000 || !process.execArgv.includes('--max-old-space-size=512')) throw Error('Unbounded preparation');
const findings=files.map(file=>({summary:'Synthetic parser-located evidence',evidence:[{file,line:fs.readFileSync(file,'utf8').split('\n').findIndex(line=>line.includes('ERROR'))+1}]}));
console.log(JSON.stringify({findings,filesUsed:files.map(file=>({file,type:'synthetic'}))}));
`;

test('skill execution prepares bounded parser evidence then receives pinned skill/actual inputs after the durable guard', async t => {
  const f = await fixture(t, { parserSource: PREPARATION_PARSER }), order = [];
  let runDirectory;
  f.worker.executionService = { async execute(request, { signal, beforeExecute }) {
    order.push('validate'); assert.equal(signal.aborted, false);
    runDirectory = dirname(request.executionContext.directory);
    const manifest = JSON.parse(await readFile(join(runDirectory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.preparation.agentProof, false); assert.equal(manifest.preparation.parserBatches.length, 1);
    assert.equal(manifest.preparation.parserBatches[0].status, 'completed');
    assert.equal(manifest.preparation.findingCount, 1);
    assert.equal(request.executionContext.payload.parserSummary.length, 1);
    const cited = request.executionContext.payload.parserSummary[0].evidenceIds;
    assert.ok(cited.some(id => request.executionContext.payload.evidence.find(item => item.id === id)?.line === 2));
    assert.ok(request.executionContext.payload.limitations.some(text => text.includes('由助手选择有限日志解析')));
    assert.equal(request.skillId, 'ota-log-triage@1.3.2'); assert.equal(request.taskId, 'T000001'); assert.equal(request.inputRevision, 2);
    assert.equal(request.parameters.mode, 'windowed'); assert.equal(request.parameters.window.timeZone, 'Asia/Shanghai');
    assert.ok(request.inputFiles.length > 0);
    for (const input of request.inputFiles) {
      const bytes = await readFile(join(request.executionContext.directory, input.path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), input.sha256);
    }
    await beforeExecute(); order.push('execute');
    return serviceResult(request);
  } };
  const result = await f.worker.run(snapshot(), { beforeModel() { order.push('before'); } });
  assert.deepEqual(order, ['validate', 'before', 'execute']); assert.equal(f.calls(), 0);
  assert.equal(result.status, 'completed'); assert.equal(result.modelCalls, 1); assert.equal(result.execution.providerRequests, 3);
  assert.equal(result.files.length, 2); assert.equal(result.manifest.outputs.length, 2);
  assert.ok(result.manifest.outputs.every(file => !Object.hasOwn(file, 'pathPrivate')));
  assert.ok(!result.text.includes('providerRequests') && !result.text.includes('skillLoaded'));
  assert.match(result.text, /现有证据不足以确认最终根因/); assert.equal(result.manifest.preparation.coverage, 'partial');
});

test('preparation balances OTA/slave/QNX/DE files across no more than four small batches and keeps original relative names and hashes', async t => {
  const entries = [];
  for (let index = 0; index < 4; index++) for (const [kind, name, marker] of [
    ['ota', 'com.carota.log', 'CloudTransmitter'], ['slave', 'slave-da.log', 'Starting slave-da'],
    ['qnx', 'tp_client.log', 'tpclient_main.c'], ['de', 'de.log', 'guds_ssmgr.c'],
  ]) entries.push([`${kind}-${index}/${name}`, `2026-11-20 10:00:00 ${marker} ERROR synthetic evidence ${index}\n`]);
  const original = new Map(entries.map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')]));
  const f = await fixture(t, { name: 'logs.zip', data: zip(entries), parserSource: PREPARATION_PARSER });
  f.worker.executionService = { async execute(request, { beforeExecute }) {
    const manifest = JSON.parse(await readFile(join(dirname(request.executionContext.directory), 'manifest.json'), 'utf8'));
    const preparation = manifest.preparation;
    assert.equal(preparation.parserBatches.length, 4); assert.equal(preparation.selectedFiles, 12); assert.equal(preparation.omittedFiles, 4);
    assert.equal(preparation.agentProof, false); assert.equal(preparation.coverage, 'partial');
    const selected = preparation.parserBatches.flatMap(batch => batch.files);
    for (const batch of preparation.parserBatches) { assert.ok(batch.files.length <= 3); assert.ok(batch.bytes <= 16000000); assert.equal(batch.status, 'completed'); }
    for (const kind of ['ota', 'slave', 'qnx', 'de']) assert.equal(selected.filter(file => file.path.includes('/' + kind + '-')).length, 3);
    for (const file of selected) {
      const originalName = [...original.keys()].find(name => file.path.endsWith('/' + name));
      assert.equal(file.sha256, original.get(originalName));
      assert.equal(createHash('sha256').update(await readFile(join(request.executionContext.directory, file.path))).digest('hex'), file.sha256);
    }
    assert.ok(request.executionContext.payload.parserSummary.length > 0);
    await beforeExecute(); return serviceResult(request);
  } };
  const result = await f.worker.run(snapshot());
  assert.equal(result.status, 'completed'); assert.equal(f.calls(), 0); assert.equal(result.manifest.preparation.parserBatches.length, 4);
});

test('missing fault time preserves an evidence-based model judgement in legacy and verified service reports', async t => {
  const judgement = { confidence: 'medium', responsibility: '服务端返回码需优先核对' };
  const legacy = await fixture(t, { model: payload => ({ ...modelReport(payload), ...judgement }) });
  const direct = await legacy.worker.run(snapshot({ window: undefined }));
  assert.equal(direct.report.mode, 'preliminary'); assert.equal(direct.report.confidence, 'medium'); assert.equal(direct.report.responsibility, judgement.responsibility);
  const service = await fixture(t);
  service.worker.executionService = { async execute(request, { beforeExecute }) { await beforeExecute(); return serviceResult(request, { judgement }); } };
  const result = await service.worker.run(snapshot({ window: undefined }));
  assert.equal(result.status, 'completed'); assert.equal(result.report.mode, 'preliminary'); assert.equal(result.report.confidence, 'medium');
  assert.equal(result.report.responsibility, judgement.responsibility); assert.equal(result.files.length, 2);
});

test('unverified skill execution proof and out-of-scope artifacts still prevent completion', async t => {
  for (const altered of ['proof', 'path']) {
    const f = await fixture(t);
    f.worker.executionService = { async execute(request, { beforeExecute }) {
      await beforeExecute(); const result = await serviceResult(request);
      if (altered === 'proof') result.execution.skillLoaded = false;
      else result.files[0].pathPrivate = join(request.executionContext.directory, request.inputFiles[0].path);
      return result;
    } };
    await assert.rejects(f.worker.run(snapshot()), e => e.phase === 'report' && e.modelStarted && e.processTreeStopped);
  }
});
test('verified execution can exceed the former six-request pilot policy within the hard count limits', async t => {
  for (const [providerRequests, toolCalls] of [[7, 20], [32, 96]]) {
    const f = await fixture(t); let admitted = 0, serviceCalls = 0;
    f.worker.executionService = { async execute(request, { beforeExecute }) {
      serviceCalls++; await beforeExecute();
      const result = await serviceResult(request);
      Object.assign(result.execution, { providerRequests, toolCalls });
      return result;
    } };
    const result = await f.worker.run(snapshot(), { beforeModel() { admitted++; } });
    assert.equal(result.status, 'completed'); assert.equal(result.modelCalls, 1);
    assert.equal(result.execution.providerRequests, providerRequests); assert.equal(result.execution.toolCalls, toolCalls);
    assert.equal(serviceCalls, 1); assert.equal(admitted, 1); assert.equal(f.calls(), 0);
  }
});

test('verified execution counts are statistics and a retired declared policy does not reject completed work', async t => {
  const f = await fixture(t);
  const usage = { elapsedMs: 7, providerRequests: 41, toolCalls: 140, evidenceReadCalls: 99, evidenceLines: 9000, parserRuns: 12, toolCallsByName: { read_evidence: 99 } };
  f.worker.executionService = { async execute(request, { beforeExecute }) {
    await beforeExecute(); const result = await serviceResult(request, { usage });
    Object.assign(result.execution, { providerRequests: 41, toolCalls: 140, limits: { modelRequests: 1, toolCalls: 1 },
      usage });
    return result;
  } };
  const result = await f.worker.run(snapshot()); assert.equal(result.status, 'completed'); assert.equal(result.execution.providerRequests, 41);
  assert.equal(result.execution.usage.evidenceLines, 9000); assert.equal(Object.hasOwn(result.execution, 'limits'), false);
});
test('real execution-service validation rejects changed input before reserving budget or starting a backend', async t => {
  const f = await fixture(t); let admitted = 0, runnerCalls = 0;
  const service = new SkillExecutionService({ root: f.worker.root, runner: { async runSkill() { runnerCalls++; throw new Error('must not start'); } } });
  f.worker.executionService = { root: service.root, execute(request, options) {
    return service.execute({ ...request, inputFiles: request.inputFiles.map(file => ({ ...file, sha256: '0'.repeat(64) })) }, options);
  } };
  await assert.rejects(f.worker.run(snapshot(), { beforeModel() { admitted++; } }), error => error.code === 'SKILL_INPUT_CHANGED'
    && error.phase === 'service-validation' && error.modelStarted === false && error.processTreeStopped === true);
  assert.equal(admitted, 0); assert.equal(runnerCalls, 0); assert.equal(f.calls(), 0);
});
