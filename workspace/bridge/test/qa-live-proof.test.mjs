import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { hashFile, runtimeSourceIdentity, validateQaLiveReceipt, verifyQaReceiptFile, findQaNative, qaStatePath, readQaTaskIssue } from '../../../environment/scripts/qa-live-proof.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-qa-gate-'));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  for (const directory of ['server', 'bridge', 'client', 'desktop']) await mkdir(join(root, 'workspace', directory), { recursive: true });
  await writeFile(join(root, 'workspace/package.json'), JSON.stringify({ version: '0.5.4' }));
  await writeFile(join(root, 'workspace/bridge/source.mjs'), 'export const actual = 1;');
  const identity = await runtimeSourceIdentity(root), now = new Date().toISOString(), taskId = 'T000001', runId = randomUUID();
  const report = '【结论】\n原结论。\n【依据】\n日志证据。';
  const data = {
    'trigger': { runId, ...identity, messageId: 90, qa: { authorized: true, fileIds: ['10', '20'] } },
    'listener': { startedAt: new Date(Date.parse(identity.newestBridgeSourceModifiedAt) + 1).toISOString(), status: 'listening', processIdentityVerified: true,
      identitySource: 'Get-ImSavedProcess', executable: process.execPath, creationTicks: '123456' },
    'route': { triggerId: 'im:90', status: 'routed', decision: { taskKind: 'log-triage', taskId, action: 'followup' } },
    'original-plugin': 'original installed plugin fixture',
    'plugin-request': { taskId, inputRevision: 2, recipe: 'chery-qa-plugin', system: 'original system', user: 'original user' },
    'plugin-preparation': { system: 'original system', user: 'original user', proof: { skillLoaded: true, parserRuns: 1 }, evidence: [{ line: 1 }] },
    'plugin-receipt': { taskId, inputRevision: 2, recipe: 'chery-qa-plugin', completed: true, model: 'qwen4-max', reasoningEffort: 'high', requests: 1, tools: 0, finishReason: 'stop' },
    'plugin-report': report,
    'native-result': { completed: true, nativeExitCode: 0, finalReason: 'completed', sessionId: 'session-native-fixture' },
    'native-supervision': { status: 'completed', launcherExited: true, startedUtc: now },
    'manifest': { inputRevision: 2, attachments: [] },
    'download-input': 'real ZIP bytes fixture',
    'download-image': 'real PNG bytes fixture',
    'downloaded-report': report + '\n\n本次用量\n模型：1次',
  };
  const proofFiles = [];
  for (const [role, value] of Object.entries(data)) {
    const file = join(root, role + '.fixture');
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
    proofFiles.push({ role: role === 'download-image' ? 'download-input' : role, path: file, sha256: await hashFile(file) });
  }
  const entry = role => proofFiles.find(item => item.role === role);
  const digest = async text => { const file = join(root, 'digest.fixture'); await writeFile(file, text); return hashFile(file); };
  data['plugin-receipt'].systemSha256 = await digest(data['plugin-request'].system);
  data['plugin-receipt'].userSha256 = await digest(data['plugin-request'].user);
  data['plugin-receipt'].sourceReportSha256 = entry('plugin-report').sha256;
  data.manifest.attachments = await Promise.all(proofFiles.filter(item => item.role === 'download-input').map(async (item, index) => ({ id: index ? '20' : '10', bytes: (await readFile(item.path)).length, sha256: item.sha256 })));
  for (const role of ['plugin-receipt', 'manifest']) { await writeFile(entry(role).path, JSON.stringify(data[role])); entry(role).sha256 = await hashFile(entry(role).path); }
  const receipt = { schemaVersion: 1, kind: 'qa-live-acceptance', status: 'passed', ...identity, runId, startedAt: now, completedAt: now,
    taskId, beforeRevision: 1, beforeAttempt: 1, inputRevision: 2, attempt: 2, triggerMessageId: 90, model: 'qwen4-max', reasoningEffort: 'high',
    nativeSessionId: 'session-native-fixture', nativeExitCode: 0, providerRequests: 1, downloadBytes: (await readFile(entry('downloaded-report').path)).length,
    downloadSha256: entry('downloaded-report').sha256, originalPluginSha256: entry('original-plugin').sha256,
    checks: Object.fromEntries(['currentListenerLoaded', 'authorizedQaRead', 'realTriggerRouted', 'freshRevision', 'downloadHashes', 'originalPluginPrompt', 'nativeCompleted', 'qwen4High',
      'oneConclusionAndTxt', 'memberAuthenticatedDownload', 'originalReportPreserved'].map(name => [name, true])), proofFiles };
  const file = join(root, 'receipt.json'); await writeFile(file, JSON.stringify(receipt));
  return { root, identity, receipt, file, data, entry };
}

test('QA uses the Super Agent ledger relative to config even when a legacy bridge ledger also exists', () => {
  const configPath = resolve('environment/config/bridge-installed.local.json');
  const config = { statePath: '../../environment/data/bridge-installed/state.json', superAgent: { enabled: true, statePath: '../data/qa-pilot/state.json' } };
  assert.equal(qaStatePath(config, configPath), resolve(dirname(configPath), '../data/qa-pilot/state.json'));
  assert.notEqual(qaStatePath(config, configPath), resolve(dirname(configPath), config.statePath));
  assert.equal(qaStatePath({ ...config, superAgent: { enabled: true } }, configPath), resolve(dirname(configPath), '../data/super-agent/state.json'));
});

test('QA preflight queries by project/no and verifies returned IDs without sending the backend issueId filter', async () => {
  const task = { projectId: '446', externalIssueNo: 'DEMO-229', externalIssueId: '20648' }, binding = { projectId: '446' };
  const issue = { id: '20648', projectId: '446', no: 'DEMO-229' };
  const adapter = { async getIssue(query) { assert.deepEqual(query, { projectId: '446', no: 'DEMO-229' }); return issue; } };
  assert.equal(await readQaTaskIssue(adapter, task, binding), issue);
  await assert.rejects(readQaTaskIssue({ getIssue: async () => null }, task, binding), /未找到准确问题编号/u);
  await assert.rejects(readQaTaskIssue({ getIssue: async () => ({ ...issue, id: 'another' }) }, task, binding), /问题ID/u);
});

test('QA delivery checker reopens native model/exit records and all ZIP/PNG/report hashes (synthetic contract only)', async t => {
  const f = await fixture(t), result = await verifyQaReceiptFile(f.file, { root: f.root });
  assert.equal(result.status, 'passed'); assert.equal(result.model, 'qwen4-max');
  await writeFile(f.entry('downloaded-report').path, 'changed report');
  await assert.rejects(verifyQaReceiptFile(f.file, { root: f.root }), /凭证文件已变化/u);
});

test('QA delivery refuses older versions, changed runtime bytes, missing phases and old revisions', async t => {
  const f = await fixture(t);
  assert.throws(() => validateQaLiveReceipt({ ...f.receipt, version: '0.5.1' }, f.identity), /其他产品版本/u);
  assert.throws(() => validateQaLiveReceipt({ ...f.receipt, inputRevision: 1 }, f.identity));
  assert.throws(() => validateQaLiveReceipt({ ...f.receipt, checks: { ...f.receipt.checks, memberAuthenticatedDownload: false } }, f.identity), /memberAuthenticatedDownload/u);
  await writeFile(join(f.root, 'workspace/bridge/source.mjs'), 'export const actual = 2;');
  await assert.rejects(verifyQaReceiptFile(f.file, { root: f.root }), /产品源已变化/u);
});

test('QA delivery rejects a claimed High receipt when the linked native call used another effort', async t => {
  const f = await fixture(t), model = f.entry('plugin-receipt');
  await writeFile(model.path, JSON.stringify({ ...f.data['plugin-receipt'], reasoningEffort: 'max' }));
  model.sha256 = await hashFile(model.path); await writeFile(f.file, JSON.stringify(f.receipt));
  await assert.rejects(verifyQaReceiptFile(f.file, { root: f.root }), /high/u);
});

test('QA native discovery follows the real InstalledHeadlessExecutor classifier directory convention', async t => {
  const f = await fixture(t), directory = join(f.root, 'agent-runs', 'skill-native'), nativeRoot = join(directory, 'runs', 'classifier-native');
  await mkdir(nativeRoot, { recursive: true });
  await writeFile(join(directory, 'plugin-request.json'), JSON.stringify(f.data['plugin-request']));
  await writeFile(join(directory, 'plugin-receipt.json'), JSON.stringify(f.data['plugin-receipt']));
  await writeFile(join(nativeRoot, 'result.json'), JSON.stringify(f.data['native-result']));
  await writeFile(join(nativeRoot, 'bridge-supervision.json'), JSON.stringify(f.data['native-supervision']));
  const found = await findQaNative(f.root, { id: 'T000001', inputRevision: 2 }, f.receipt.startedAt);
  assert.equal(found.nativeRoot, nativeRoot);
});
