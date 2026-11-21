import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { buildPluginAnalysisInput, buildPluginPrompt, preparePluginAnalysis, mapPluginReport } from '../triage-plugin-recipe.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const docs = ['skill main', 'guide rules', 'time alignment', 'glossary', 'vehicle', 'component'];
const originalPath = join(homedir(), '.dsh/profiles/desktop/node_modules/@local/chery-qa/index.js');
const skillRoot = resolve('environment/tools/ota-log-triage-1.3.2');
const exists = path => access(path).then(() => true, () => false);
const report = `# OTA 日志分析报告

说明：保留模型自己的说明。

## 【结论】
责任方：**通信组件**；置信度：**中**。

保持这一段的原句及格式，不作改写。

## 【依据】
1. \`Android/demo.log:2-3\` — 日志中记录连接失败。

## 【时间线】
- 10:00：连接失败，随后重试。

## 【其他可能】
尚需核对对端是否启动。

## 【下一步】
检查对端服务。`;
const evidence = [1, 2, 3].map(line => ({ id: 'E' + String(line).padStart(4, '0'),
  file: 'input-001/contents/Android/demo.log', pluginFile: 'Android/demo.log', line,
  sha256: 'a'.repeat(64), text: 'sample', time: '', aligned: false }));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-plugin-recipe-'));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const file = 'Android/demo.log', path = join(root, file);
  await mkdir(dirname(path), { recursive: true });
  const lines = Array.from({ length: 470 }, (_, index) => `${index} ${index % 4 === 0 ? 'strategy_not_found' : 'context'} ${'字'.repeat(210)}`);
  await writeFile(path, lines.join('\n'));
  const base = { verdict: { top: { party: 'demo', confidence: '中', hits: 120 } },
    findings: Array.from({ length: 80 }, (_, index) => ({ category: 'demo category', party: 'demo', confidence: '中', summary: 'found ' + index,
      evidence: [{ file, line: index + 2, detail: 'detail ' + index }, { file, line: index + 2, detail: 'duplicate coordinate' }] })),
    filesUsed: [{ file, type: 'ota' }], filesExcluded: 0, suggestions: ['next'], window: { date: null, from: null, to: null }, effort: 'mid' };
  return { root, file, lines, base };
}

function originalFunctions(source) {
  const start = source.indexOf('  async function evidenceSnippets(');
  const end = source.indexOf('  async function pickModel(', start);
  const route = source.indexOf("route('/chery-qa/api/triage/analyze'");
  const systemStart = source.indexOf('    const system = [', route);
  const promptEnd = source.indexOf('    const promptChars = ', systemStart);
  assert.ok(start > 0 && end > start && systemStart > 0 && promptEnd > systemStart, 'Installed reference recipe changed; re-audit before adapting it.');
  const code = source.slice(start, end) + '\nasync function reference({ baseDir, base, docs, symptom, effort }) {'
    + 'const level = EFFORT_LEVELS[effort]; const evidence = await evidenceSnippets(baseDir, base, level.evidence);'
    + 'const keyLines = await keyLineHits(baseDir, base, level.keyLines);'
    + "const [skill, guide, align] = [docs[0], level.docs[1] ? docs[1] : '', level.docs[2] ? docs[2] : ''];"
    + source.slice(systemStart, promptEnd) + '\nreturn {system,user,snippets:evidence,keyLines};}\nglobalThis.reference=reference;';
  return vm.runInNewContext(code + '\nreference;', { readFile, join });
}

test('the installed original selection and prompts match byte for byte at all three effort levels', async t => {
  if (!await exists(originalPath)) { t.skip('Original desktop plugin is not installed on this machine.'); return; }
  const f = await fixture(t), original = originalFunctions(await readFile(originalPath, 'utf8'));
  for (const effort of ['low', 'mid', 'high']) {
    const input = { baseDir: f.root, base: f.base, docs, symptom: '', effort };
    const expected = await original(input), actual = await buildPluginAnalysisInput(input);
    assert.equal(actual.system, expected.system); assert.equal(actual.user, expected.user);
    assert.equal(JSON.stringify(actual.snippets), JSON.stringify(expected.snippets));
    assert.equal(JSON.stringify(actual.keyLines), JSON.stringify(expected.keyLines));
    assert.equal(actual.snippets.length, { low: 16, mid: 44, high: 80 }[effort]);
    assert.equal(actual.keyLines.length, { low: 24, mid: 60, high: 118 }[effort]);
  }
});

test('standard recipe keeps global verdict, document order and source context without adding an IM diagnostic prompt', async t => {
  const f = await fixture(t);
  const input = await buildPluginAnalysisInput({ baseDir: f.root, base: f.base, docs, symptom: '显式现象' });
  assert.equal(input.snippets.length, 44); assert.equal(input.keyLines.length, 60);
  assert.match(input.user, /CLI 启发式初判/); assert.match(input.user, /"hits": 120/);
  assert.match(input.user, /## 4\. 缺陷现象[^\n]*\n显式现象/u);
  assert.match(input.user, /### Android\/demo.log @ L2\n/u);
  assert.ok(input.snippets[0].text.startsWith('     1 | 0 strategy_not_found'));
  assert.ok(!input.user.includes('E0001')); assert.ok(!input.user.includes('Super Agent'));
  assert.ok(input.user.indexOf('skill main') < input.user.indexOf('guide rules'));
});

test('full plugin report is mapped mechanically while preserving conclusion wording and real source citations', () => {
  const mapped = mapPluginReport(report, evidence);
  assert.equal(mapped.conclusion, '责任方：**通信组件**；置信度：**中**。\n\n保持这一段的原句及格式，不作改写。');
  assert.equal(mapped.responsibility, '通信组件'); assert.equal(mapped.confidence, 'medium');
  assert.deepEqual(mapped.evidence.map(item => item.id), ['E0002', 'E0003']);
  assert.equal(mapped.timeline[0].event, '- 10:00：连接失败，随后重试。');
  assert.deepEqual(mapped.nextSteps, ['检查对端服务。']); assert.deepEqual(mapped.limitations, []);
  assert.deepEqual(Object.keys(mapped).sort(), ['conclusion', 'confidence', 'responsibility', 'evidence', 'timeline', 'alternatives', 'nextSteps', 'limitations'].sort());
  assert.throws(() => mapPluginReport(report.replace('demo.log:2-3', 'demo.log:200-203'), evidence), { code: 'PLUGIN_REPORT_EVIDENCE_MISSING' });
});

test('report mapping accepts same-line headings, explicit timeline references and model confidence punctuation', () => {
  const text = report.replace('## 【结论】\n', '**【结论】** ').replace('置信度：**中**', '置信度：**高**')
    .replace('- 10:00：连接失败，随后重试。', '- `demo.log:L3`：重试。');
  const mapped = mapPluginReport(text, evidence);
  assert.equal(mapped.confidence, 'high'); assert.equal(mapped.timeline[0].id, 'E0003');
  assert.equal(mapped.timeline[0].event, '- `demo.log:L3`：重试。');
});

test('whole-target CLI keeps the fixed parser default effort and resolves attachment wrapper paths for actual source proof', async t => {
  if (!await exists(join(skillRoot, 'integrity.json'))) { t.skip('Pinned skill is not installed on this machine.'); return; }
  const f = await fixture(t), directory = join(f.root, 'material');
  const path = 'input-001/contents/Android/own_logs/com.carota.demo.log';
  const log = '2026-11-20 10:00:00 [RpcUnit] CAROTA CORE VER 1.0\n'
    + '2026-11-20 10:00:01 [RpcUnit] getUpdateStatus failed (attempt 1/60): Failed to connect to /192.168.55.11:51020\n';
  await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), log);
  const request = { taskId: 'TDEMO', inputRevision: 1, skillId: 'ota-log-triage@1.3.2', parameters: {},
    inputFiles: [{ path, bytes: Buffer.byteLength(log), sha256: digest(log) }],
    executionContext: { directory, skillRoot, payload: { evidence: [] } } };
  const prepared = await preparePluginAnalysis(request);
  assert.equal(prepared.recipe, 'chery-qa-plugin'); assert.equal(prepared.effort, 'mid'); assert.equal(prepared.maxTokens, 6000);
  assert.equal(prepared.base.effort, 'mid'); assert.equal(prepared.proof.parserRuns, 1);
  assert.equal(prepared.proof.systemSha256, digest(prepared.system)); assert.equal(prepared.proof.userSha256, digest(prepared.user));
  assert.ok(prepared.base.filesUsed.some(file => file.file === 'Android/own_logs/com.carota.demo.log'));
  assert.ok(prepared.evidence.length > 0);
  assert.ok(prepared.evidence.every(item => item.file === path && item.sha256 === digest(log)));
  assert.ok(prepared.evidence.some(item => item.line === 2 && item.text.includes('Failed to connect')));
  assert.ok(prepared.user.includes('Android/own_logs/com.carota.demo.log'));
  assert.ok(!prepared.user.includes('input-001/contents'));
});
