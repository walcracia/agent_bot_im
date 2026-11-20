import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { collectEvidence, redact, parserHints, buildModelPayload, renderReport, validateModelReport } from '../triage-report.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const defaults = { maxScanLines: 200000, maxScanCharacters: 16000000, maxEvidenceCandidates: 1200, maxEvidence: 60, maxLineCharacters: 600 };
async function fixture(t, input) {
  const directory = await mkdtemp(join(tmpdir(), 'teamplay-evidence-'));
  t.after(async () => { assert.equal(dirname(directory), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const files = [];
  for (const [path, text] of Object.entries(input)) {
    await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), text);
    files.push({ path, bytes: Buffer.byteLength(text), sha256: sha(text) });
  }
  return { directory, files, input };
}

test('address redaction preserves service environment and business/RPC semantics without credentials or downloads', () => {
  const value = 'https://operator:password@api-ota-staging-eu.example/upgrade/check?token=hidden#secret http://10.0.0.9:4000/ https://files.example/attachments/log.zip?sig=private';
  const safe = redact(value);
  assert.match(safe, /https:\/\/api-ota-staging-eu\.example\/upgrade\/check/u);
  assert.match(safe, /http:\/\/10\.0\.0\.9:4000/u);
  assert.doesNotMatch(safe, /operator|password|token|secret|attachments|log\.zip|sig=|files\.example/u);
  assert.equal(redact(safe), safe);
  assert.equal(redact('https://api-ota-uat.example/task/verify/private-object?api_key=secret'), 'https://api-ota-uat.example/task/verify');
  assert.equal(redact('https://files.example/private-key.json'), '[地址已隐藏]');
});

test('large early DoIP noise cannot hide cloud business responses or independent RPC failures', async t => {
  const noise = Array.from({ length: 5000 }, (_, i) => `2026-11-20 10:00:00 DoIP ERROR retry ${i}`).join('\n');
  const ota = '2026-11-20 10:00:01 CloudTransmitter https://api-ota-stg-eu.example/upgrade/check?VIN=private code=43021 no_upgrade_available\n2026-11-20 10:00:02 RpcUnit connect failed ECONNREFUSED\n';
  const f = await fixture(t, { '000-DoIP.log': noise, 'com.carota.ota.log': ota, 'slave-da.log': '2026-11-20 10:00:03 Starting slave-da\n' });
  const result = await collectEvidence({ ...f, window: { mode: 'preliminary' }, limits: { ...defaults, maxScanCharacters: 18000, maxScanLines: 400 } });
  assert.ok(result.evidence.some(item => item.text.includes('code=43021')));
  assert.ok(result.evidence.some(item => item.text.includes('ECONNREFUSED')));
  assert.ok(result.evidence.some(item => item.file === 'slave-da.log'));
  assert.ok(result.evidence.some(item => item.file === '000-DoIP.log'));
  assert.ok(result.evidence.length <= 60); assert.ok(result.scanned <= 400);
  assert.ok(result.evidence.every(item => item.aligned === false && item.inRequestedWindow === null));
  for (const item of result.evidence) {
    assert.equal(item.sha256, f.files.find(file => file.path === item.file).sha256);
    assert.equal(item.text, redact(f.input[item.file].split('\n')[item.line - 1]).slice(0, 600));
  }
});

test('late business and RPC failures survive many earlier successes with quoted signing and session secrets hidden', async t => {
  const successes = Array.from({ length: 1300 }, (_, index) =>
    `2026-11-20 10:00:00 CloudTransmitter response {"code":20000,"msg":"success","sequence":${index}}`);
  const business = '2026-11-20 10:00:01 CloudTransmitter https://api-ota-staging-eu.example/upgrade/check {"code":43021,"msg":"policy_not_found","signKey":"synthetic-signing-value","token":"synthetic-session-value"}';
  const rpc = '2026-11-20 10:00:02 JsonRpcClient RPC connect failed ECONNREFUSED http://10.0.0.9:4000/';
  const f = await fixture(t, { 'com.carota.ota.log': [...successes, business, rpc].join('\n'),
    'slave-da.log': '2026-11-20 10:00:00 Starting slave-da\n', 'DoIP.log': '2026-11-20 10:00:00 DoIP ERROR retry\n' });
  const parserFindings = [{ evidence: Array.from({ length: 30 }, (_, index) => ({ file: 'com.carota.ota.log', line: index + 1 })) }];
  const result = await collectEvidence({ ...f, parserFindings, window: { mode: 'preliminary' }, limits: defaults });
  const cloud = result.evidence.find(item => item.file === 'com.carota.ota.log' && item.line === 1301);
  const local = result.evidence.find(item => item.file === 'com.carota.ota.log' && item.line === 1302);
  assert.ok(cloud); assert.ok(local); assert.match(cloud.text, /"code":43021/u); assert.match(cloud.text, /policy_not_found/u);
  assert.match(cloud.text, /api-ota-staging-eu\.example\/upgrade\/check/u); assert.match(local.text, /RPC connect failed ECONNREFUSED/u);
  assert.ok(cloud.text.includes('signKey') && cloud.text.includes('已隐藏'));
  assert.ok(!JSON.stringify(result.evidence).includes('synthetic-signing-value'));
  assert.ok(!JSON.stringify(result.evidence).includes('synthetic-session-value'));
  assert.equal(redact(cloud.text), cloud.text); assert.equal(cloud.sha256, f.files[0].sha256);
  assert.ok(result.evidence.length <= 60);
});

test('parser references promote actual source lines and two context lines, never parser prose or foreign paths', async t => {
  const rows = Array.from({ length: 180 }, (_, i) => `2026-11-20 10:00:00 ordinary state ${i + 1}`);
  rows[119] = '2026-11-20 10:00:00 component state changed';
  const f = await fixture(t, { 'app.log': rows.join('\n') });
  const parserFindings = [{ summary: 'invented conclusion is not log evidence', evidence: [
    { file: 'app.log', line: 120 }, { file: join(f.directory, 'app.log'), line: 120 },
    { file: join(f.directory, '..', 'foreign.log'), line: 1 }, { file: 'app.log', line: 999999 },
  ] }];
  const result = await collectEvidence({ ...f, parserFindings, window: { mode: 'preliminary' }, limits: { ...defaults, maxEvidence: 8, maxEvidenceCandidates: 8 } });
  for (const line of [118, 119, 120, 121, 122]) assert.ok(result.evidence.some(item => item.line === line), `actual context line ${line}`);
  assert.equal(new Set(result.evidence.map(item => item.file + ':' + item.line)).size, result.evidence.length);
  assert.doesNotMatch(JSON.stringify(result.evidence), /invented|foreign/u);
  const hints = parserHints({ findings: [{ summary: 'verified state', evidence: [{ file: 'app.log', line: 120 }] }] }, result.evidence);
  assert.equal(hints.length, 1); assert.ok(hints[0].evidenceIds.includes(result.evidence.find(item => item.line === 120).id));
});

test('parser references still obey the explicit fault window and retain real timestamp provenance', async t => {
  const text = '2026-11-20 09:00:00 CloudTransmitter code=43021\n2026-11-20 10:00:00 CloudTransmitter code=43021\n';
  const f = await fixture(t, { 'com.carota.ota.log': text });
  const window = { mode: 'windowed', startEpochMs: Date.parse('2026-11-20T10:00:00Z'), endEpochMs: Date.parse('2026-11-20T10:01:00Z') };
  const result = await collectEvidence({ ...f, window, clockDomains: { ota: 'UTC' }, limits: defaults,
    parserFindings: [{ evidence: [{ file: 'com.carota.ota.log', line: 1 }, { file: 'com.carota.ota.log', line: 2 }] }] });
  assert.deepEqual(result.evidence.map(item => item.line), [2]);
  assert.equal(result.evidence[0].time, '2026-11-20T10:00:00.000Z'); assert.equal(result.evidence[0].timestampSourceLine, 2);
  assert.equal(result.evidence[0].inRequestedWindow, true);
});

test('balanced selection remains verifiable within the same aggregate prefix scan budget', async t => {
  const input = Object.fromEntries(Array.from({ length: 7 }, (_, file) => [`${file}-app.log`, Array.from({ length: 1000 }, (_, i) => `2026-11-20 10:00:00 ordinary ${file}:${i}`).join('\n')]));
  const f = await fixture(t, input), limits = { ...defaults, maxScanLines: 240, maxScanCharacters: 14000 };
  const result = await collectEvidence({ ...f, window: { mode: 'preliminary' }, limits,
    parserFindings: [{ evidence: [{ file: '6-app.log', line: 30 }] }] });
  let lines = 0, characters = 0;
  for (const file of f.files) {
    const selected = result.evidence.filter(item => item.file === file.path);
    const last = selected.length ? Math.max(...selected.map(item => item.line)) : 0;
    lines += last; characters += input[file.path].split('\n').slice(0, last).reduce((sum, line) => sum + line.length, 0);
  }
  assert.ok(result.evidence.some(item => item.file === '6-app.log' && item.line === 30));
  assert.ok(new Set(result.evidence.map(item => item.file)).size >= 4);
  assert.ok(lines <= limits.maxScanLines); assert.ok(characters <= limits.maxScanCharacters);
  assert.ok(result.scanned <= limits.maxScanLines);
});

test('context trimming preserves verified parser references and meaningful business responses', async t => {
  const f = await fixture(t, { 'com.carota.ota.log': Array.from({ length: 80 }, (_, i) => `2026-11-20 10:00:00 ${i === 69 ? 'CloudTransmitter code=43021 no_upgrade_available' : 'ordinary ' + 'x'.repeat(200)}`).join('\n') });
  const result = await collectEvidence({ ...f, window: { mode: 'preliminary' }, limits: defaults, parserFindings: [{ evidence: [{ file: 'com.carota.ota.log', line: 70 }] }] });
  const critical = result.evidence.find(item => item.line === 70);
  const payload = buildModelPayload({ snapshot: { id: 'T000001', inputRevision: 1, issue: { no: 'DEMO-1', title: '升级检查异常' } },
    window: { mode: 'preliminary' }, evidence: result.evidence, parserSummary: [{ summary: 'business response', evidenceIds: [critical.id] }], rules: 'fixed rules', limitations: [], maxCharacters: 10000 });
  assert.ok(payload.evidence.some(item => item.id === critical.id)); assert.equal(payload.parserSummary.length, 1);
});

test('completed model report rendering preserves its judgment and own limitations with neutral material metadata', () => {
  const payload = { mode: 'preliminary', inputRevision: 2, issue: { no: 'DEMO-1' }, window: { date: null },
    evidence: [{ id: 'E0001', file: 'app.log', line: 9, time: '2026-11-20 10:00:00' }], limitations: ['program-only note must not be appended'] };
  const report = { conclusion: '模型独立给出的判断。', confidence: 'high', responsibility: '模型判定的责任方',
    evidence: [{ id: 'E0001', interpretation: '模型对实际证据的解释。' }], timeline: [{ id: 'E0001', event: '模型整理的事件。' }],
    alternatives: [], nextSteps: ['模型建议。'], limitations: ['模型自己说明的缺口。'] };
  const text = renderReport(report, payload);
  assert.match(text, /^DEMO-1 日志分析/u); assert.match(text, /模型判定的责任方；置信度：高/u);
  assert.match(text, /模型自己说明的缺口/u); assert.match(text, /app\.log:9/u);
  assert.doesNotMatch(text, /初排|不作跨时钟|program-only|未经复核|暂无足够证据/u);
});

test('a complete skill report may cite 37 verified lines without truncating the native result', () => {
  const evidence = Array.from({ length: 37 }, (_, i) => ({ id: `E${String(i + 1).padStart(4, '0')}`, interpretation: '模型对该行的解释。' }));
  const report = { conclusion: '模型原有完整判断。', confidence: 'medium', responsibility: '模型原有倾向', evidence,
    timeline: [{ id: 'E0001', event: '实际事件。' }], alternatives: [], nextSteps: ['核对配置。'], limitations: [] };
  assert.deepEqual(validateModelReport(JSON.stringify(report), { evidence }), report);
});
