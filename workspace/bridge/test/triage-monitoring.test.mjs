import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTriageToolHandler, TRIAGE_SKILL_ID } from '../triage-tools.mjs';
import { SkillExecutionService } from '../skill-execution.mjs';
import { validateModelReport, buildModelPayload, renderUsage } from '../triage-report.mjs';
const skillRoot = fileURLToPath(new URL('../../../environment/tools/ota-log-triage-1.3.2', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-monitoring-')), directory = join(root, 'logs');
  t.after(() => rm(root, { recursive: true, force: true })); await mkdir(directory);
  const text = Array.from({ length: 250 }, (_, index) => `2026-11-20 10:00:00 CAROTA CORE VER state ${index + 1}`).join('\n');
  const files = [];
  for (let index = 0; index < 7; index++) { const path = `com.carota-${index}.log`; await writeFile(join(directory, path), text); files.push({ path, bytes: Buffer.byteLength(text), sha256: hash(text) }); }
  const payload = { taskId: 'T000001', inputRevision: 1, mode: 'preliminary', skill: { version: '1.3.2' },
    issue: { no: 'DEMO-1', title: 'Synthetic monitoring' }, window: { mode: 'preliminary' }, limitations: [],
    evidence: [{ id: 'E0001', file: files[0].path, line: 1, text: text.split('\n')[0], sha256: files[0].sha256, time: '2026-11-20 10:00:00', aligned: false }] };
  return { root, directory, files, payload };
}
async function tools(f, request) {
  const contextFile = join(f.root, 'context.json'), proofPath = join(f.root, 'proof.json');
  await writeFile(contextFile, JSON.stringify({ taskId: 'T000001', inputRevision: 1, skillId: TRIAGE_SKILL_ID, directory: f.directory,
    files: f.files, skillRoot, payload: request?.executionContext.payload ?? f.payload, proofPath,
    toolLimits: { calls: 1, returnedCharacters: 1, evidenceCharacters: 1, parserRuns: 1 } }));
  const handler = await createTriageToolHandler({ contextFile }); let id = 0;
  await handler({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: {} });
  const call = async (name, args = {}) => { const answer = await handler({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    assert.notEqual(answer.result?.isError, true, answer.result?.content?.[0]?.text); return JSON.parse(answer.result.content[0].text); };
  return { call, proof: async () => JSON.parse(await readFile(proofPath, 'utf8')) };
}
test('pages reach original lines outside the entry sample and old cumulative tool/read/parser limits are statistics only', async t => {
  const f = await fixture(t), client = await tools(f);
  await client.call('load_skill', { skillId: TRIAGE_SKILL_ID });
  const page = await client.call('read_evidence', { file: f.files[0].path, fromLine: 201, pageSize: 100 });
  assert.equal(page.evidence.length, 50); assert.equal(page.evidence[0].line, 201); assert.equal(page.nextLine, null);
  assert.notEqual(page.evidence[0].id, 'E0001'); assert.equal(page.evidence[0].sha256, f.files[0].sha256);
  for (let index = 0; index < 105; index++) await client.call('read_evidence', { file: f.files[0].path, fromLine: 201, pageSize: 100 });
  const parsed = await client.call('run_parser', { files: f.files.map(file => file.path) }); assert.equal(parsed.batches.length, 3);
  for (let index = 0; index < 10; index++) await client.call('run_parser', { files: f.files.map(file => file.path) });
  const proof = await client.proof();
  assert.ok(proof.toolCalls > 96); assert.equal(proof.evidenceReadCalls, 106); assert.equal(proof.evidenceLines, 5300);
  assert.equal(proof.parserRuns, 11); assert.equal(proof.parserBatchRuns, 3);
  assert.ok(proof.evidenceCatalog.some(item => item.line === 201)); assert.ok(!Object.hasOwn(proof, 'limits'));
});
test('a real new page flows through the service into referenced report artifacts without another model or an evidence-count cap', async t => {
  const f = await fixture(t);
  const service = new SkillExecutionService({ root: f.root, runner: { runSkill: async request => {
    const client = await tools(f, request); await client.call('load_skill', { skillId: TRIAGE_SKILL_ID });
    await client.call('run_parser', { files: f.files.map(file => file.path) });
    const page = await client.call('read_evidence', { file: f.files[0].path, fromLine: 201, pageSize: 100 }), id = page.evidence[0].id;
    return { result: { conclusion: 'Synthetic independent report', confidence: 'high', responsibility: '待验证',
      evidence: page.evidence.map(item => ({ id: item.id, interpretation: 'Actual newly read line' })), timeline: [{ id, event: 'Observed record' }],
      alternatives: [], nextSteps: ['Inspect actual source'], limitations: [] }, evidence: page.evidence,
      execution: { backend: 'dsh', agentSessions: 1, providerRequests: 41, toolCalls: 140, skillLoaded: true, proofValidated: true,
        usage: { providerRequests: 41, toolCalls: 140, elapsedMs: 1, evidenceReadCalls: 1, evidenceLines: 50, parserRuns: 1, toolCallsByName: { read_evidence: 1, run_parser: 1 } } } };
  } } });
  const result = await service.execute({ taskId: 'T000001', inputRevision: 1, skillId: TRIAGE_SKILL_ID, parameters: {}, inputFiles: f.files,
    executionContext: { directory: f.directory, skillRoot, payload: f.payload } });
  assert.equal(result.status, 'completed'); assert.equal(result.result.evidence.length, 50); assert.equal(result.execution.providerRequests, 41);
  assert.ok(result.evidence.some(item => item.line === 201)); assert.equal(result.execution.usage.evidenceLines, 50);
  const content = await readFile(result.files.find(file => file.name === '报告.txt').pathPrivate, 'utf8'); assert.match(content, /com\.carota-0\.log:201/u);
  assert.match(content, /本次用量/u); assert.match(content, /模型：41次；工具：140次/u); assert.match(content, /共50行/u);
  const json = JSON.parse(await readFile(result.files.find(file => file.name === 'report.json').pathPrivate, 'utf8'));
  assert.equal(Object.hasOwn(json, 'usage'), false); assert.equal(Object.keys(json).length, 8);
});

test('usage is short Chinese text and only an explicitly supplied report usage adds its appendix', () => {
  const text = renderUsage({ elapsedMs: 65001, providerRequests: 17, toolCalls: 30, evidenceReadCalls: 9, evidenceLines: 500, parserRuns: 3 });
  assert.equal(text, '耗时：1分5秒\n模型：17次；工具：30次\n读日志：9次，共500行；解析：3次');
});
test('report and prompt strings and evidence references have no old cumulative display cap', () => {
  const evidence = Array.from({ length: 300 }, (_, index) => ({ id: `E${String(index + 1).padStart(4, '0')}`, text: 'source', file: 'app.log', line: index + 1 }));
  const payload = buildModelPayload({ snapshot: { id: 'T000001', inputRevision: 1, issue: { no: 'DEMO-1' } }, window: { mode: 'preliminary' }, evidence,
    parserSummary: [], rules: 'fixed', limitations: [], maxCharacters: 1 });
  const result = validateModelReport({ conclusion: '中'.repeat(60000), confidence: 'high', responsibility: '待验证',
    evidence: evidence.map(item => ({ id: item.id, interpretation: 'source' })), timeline: evidence.map(item => ({ id: item.id, event: 'record' })),
    alternatives: [], nextSteps: ['next'], limitations: [] }, payload);
  assert.equal(result.evidence.length, 300); assert.equal(result.conclusion.length, 60000); assert.equal(payload.evidence.length, 300);
});
