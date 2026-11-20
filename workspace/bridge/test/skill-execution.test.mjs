import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SkillExecutionService, createSkillBackendRegistry, TRIAGE_SKILL_ID } from '../skill-execution.mjs';
import { renderReport } from '../triage-report.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const LOG = '2026-11-20 10:00:00 ERROR timeout\n2026-11-20 10:00:01 retry\n';
const proof = { agentSessions: 1, providerRequests: 3, toolCalls: 4, skillLoaded: true, proofValidated: true };
const report = () => ({ conclusion: '日志中存在超时记录，具体原因仍待验证。', confidence: 'high', responsibility: '网络环境',
  evidence: [{ id: 'E0001', interpretation: '存在超时记录。' }], timeline: [{ id: 'E0001', event: '记录超时。' }],
  alternatives: ['需要核对服务状态。'], nextSteps: ['补充其他端的记录。'], limitations: ['初排无法确定完整因果。'] });
async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-skill-service-'));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, 'attempt', 'logs'), skillRoot = join(root, 'skill');
  await mkdir(directory, { recursive: true }); await mkdir(skillRoot); await writeFile(join(directory, 'demo.log'), LOG);
  const payload = { taskId: 'T000001', inputRevision: 2, mode: 'preliminary', skill: { version: '1.3.2' },
    issue: { no: 'DEMO-42', title: '升级超时' }, window: { mode: 'preliminary', date: null }, limitations: ['故障时间未知。'],
    evidence: [{ id: 'E0001', file: 'demo.log', line: 1, text: LOG.split('\n')[0], sha256: digest(LOG), time: '2026-11-20 10:00:00', aligned: false }] };
  const request = { taskId: 'T000001', inputRevision: 2, skillId: TRIAGE_SKILL_ID, parameters: { mode: payload.mode, window: payload.window },
    inputFiles: [{ path: 'demo.log', name: 'demo.log', sha256: digest(LOG), bytes: Buffer.byteLength(LOG) }], executionContext: { directory, skillRoot, payload } };
  let calls = 0, seen;
  const service = new SkillExecutionService({ backend: 'dsh', root, runner: { runSkill: async (value, options) => {
    calls++; seen = value; return runner ? runner(value, options) : { result: JSON.stringify(report()), execution: { ...proof } };
  } } });
  return { root, directory, skillRoot, payload, request, service, calls: () => calls, seen: () => seen };
}

test('one real adapter contract produces only two service-owned, exact-hash report artifacts', async t => {
  const f = await fixture(t); let admission = 0;
  const result = await f.service.execute(f.request, { beforeExecute: () => { admission++; } });
  assert.equal(admission, 1); assert.equal(f.calls(), 1); assert.equal(result.schemaVersion, 1); assert.equal(result.backend, 'dsh');
  assert.equal(result.taskId, 'T000001'); assert.equal(result.inputRevision, 2); assert.equal(result.skillId, TRIAGE_SKILL_ID);
  assert.equal(result.result.confidence, 'low'); assert.equal(result.result.responsibility, '待验证');
  assert.deepEqual(result.execution, { backend: 'dsh', ...proof });
  assert.deepEqual(result.files.map(file => file.name), ['report.json', '报告.txt']);
  for (const file of result.files) {
    const bytes = await readFile(file.pathPrivate); assert.equal(file.size, bytes.length); assert.equal(file.sha256, digest(bytes));
    assert.ok(!file.pathPrivate.startsWith(f.directory + '/'));
    if (file.name === 'report.json') assert.deepEqual(JSON.parse(bytes), result.result);
    else assert.equal(bytes.toString('utf8').trimEnd(), renderReport(result.result, f.payload));
  }
  assert.equal(Object.isFrozen(f.seen()), true); assert.equal(Object.isFrozen(f.seen().executionContext.payload), true);
  assert.equal((await readdir(f.directory)).length, 1);
});

test('a proved budget-limited partial execution keeps partial status and honest exact-hash artifacts', async t => {
  const f = await fixture(t, async () => ({ status: 'partial', result: report(), execution: { ...proof, providerRequests: 6, toolCalls: 11 } }));
  const result = await f.service.execute(f.request);
  assert.equal(f.calls(), 1); assert.equal(result.status, 'partial');
  assert.equal(result.result.confidence, 'low'); assert.equal(result.result.responsibility, '待验证');
  assert.ok(result.result.limitations.some(value => value.includes('程序初排') && value.includes('非模型终稿')));
  assert.equal(result.execution.providerRequests, 6); assert.equal(result.execution.toolCalls, 11);
  assert.deepEqual(result.files.map(file => file.name), ['report.json', '报告.txt']);
  for (const file of result.files) {
    const bytes = await readFile(file.pathPrivate); assert.equal(digest(bytes), file.sha256); assert.equal(bytes.length, file.size);
    if (file.name === 'report.json') assert.deepEqual(JSON.parse(bytes), result.result);
    else assert.equal(bytes.toString('utf8').trimEnd(), renderReport(result.result, f.payload));
  }
});

test('partial never bypasses execution proof, final input hashes or strict report validation', async t => {
  for (const kind of ['proof', 'input', 'report', 'status']) {
    const f = await fixture(t, async request => {
      if (kind === 'input') await writeFile(join(request.executionContext.directory, 'demo.log'), 'tampered');
      return { status: kind === 'status' ? 'fake-success' : 'partial',
        result: kind === 'report' ? { ...report(), evidence: [{ id: 'E9999', interpretation: 'fake' }] } : report(),
        execution: { ...proof, proofValidated: kind !== 'proof' } };
    });
    await assert.rejects(f.service.execute(f.request)); assert.equal(f.calls(), 1);
  }
});

test('unknown skills, backend names and unregistered optional backends fail before execution', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.execute({ ...f.request, skillId: 'shell-anything' }), { code: 'SKILL_NOT_ALLOWED' });
  for (const backend of ['unknown', 'pi', 'hermes', 'opencode']) assert.throws(() => new SkillExecutionService({ backend, root: f.root, runner: {} }), { code: 'SKILL_BACKEND_UNAVAILABLE' });
  assert.equal(f.calls(), 0); assert.throws(() => createSkillBackendRegistry({ shell: () => ({}) }), { code: 'SKILL_BACKEND_REGISTRATION_INVALID' });
});

test('an explicitly configured alternate factory is required and uses the identical validated protocol', async t => {
  const f = await fixture(t); let dispatched = 0;
  const service = new SkillExecutionService({ backend: 'pi', root: f.root, backendFactories: { pi: () => ({ runSkill: async () => {
    dispatched++; return { result: report(), execution: { ...proof, backend: 'pi' } };
  } }) } });
  const result = await service.execute(f.request); assert.equal(dispatched, 1); assert.equal(result.backend, 'pi');
  assert.equal(result.execution.backend, 'pi');
});

test('business identity, private context identity and parameters cannot disagree', async t => {
  const f = await fixture(t);
  const cases = [
    { ...f.request, inputRevision: 0 }, { ...f.request, taskId: '../private' },
    { ...f.request, executionContext: { ...f.request.executionContext, payload: { ...f.payload, taskId: 'T999999' } } },
    { ...f.request, parameters: { mode: 'windowed' } },
    { ...f.request, executionContext: { ...f.request.executionContext, payload: { ...f.payload, skill: { version: 'unverified' } } } },
  ];
  for (const value of cases) await assert.rejects(f.service.execute(value));
  assert.equal(f.calls(), 0);
});

test('relative files, actual byte counts, hashes, duplicates and size budgets are enforced before admission', async t => {
  const f = await fixture(t); let admissions = 0;
  const file = f.request.inputFiles[0];
  for (const inputFiles of [[{ ...file, path: '../escape' }], [{ ...file, path: 'C:/outside' }], [{ ...file, path: 'sub\\demo.log' }],
    [{ ...file, sha256: '0'.repeat(64) }], [{ ...file, bytes: file.bytes + 1 }], [file, file], [{ ...file, bytes: 64000001 }]]) {
    await assert.rejects(f.service.execute({ ...f.request, inputFiles }, { beforeExecute: () => admissions++ }));
  }
  assert.equal(admissions, 0); assert.equal(f.calls(), 0);
});

test('the execution directory and output directory cannot escape the trusted root or overlap inputs', async t => {
  const f = await fixture(t);
  for (const executionContext of [
    { ...f.request.executionContext, directory: tmpdir() },
    { ...f.request.executionContext, outputDirectory: tmpdir() },
    { ...f.request.executionContext, outputDirectory: join(f.directory, 'output') },
    { ...f.request.executionContext, proofPath: join(f.directory, 'proof.json') },
  ]) await assert.rejects(f.service.execute({ ...f.request, executionContext }));
  assert.equal(f.calls(), 0);
});

test('symbolic directory and hardlinked files are refused', async t => {
  const f = await fixture(t); const linked = join(f.root, 'linked');
  await symlink(f.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.execute({ ...f.request, executionContext: { ...f.request.executionContext, directory: linked } }));
  await link(join(f.directory, 'demo.log'), join(f.root, 'hardlinked.log'));
  await assert.rejects(f.service.execute(f.request)); assert.equal(f.calls(), 0);
});

test('a payload cannot invent a line, its text, a file hash or duplicate evidence id', async t => {
  const f = await fixture(t); const evidence = f.payload.evidence[0];
  for (const values of [[{ ...evidence, line: 500 }], [{ ...evidence, text: 'invented error' }],
    [{ ...evidence, sha256: '0'.repeat(64) }], [evidence, evidence]]) {
    await assert.rejects(f.service.execute({ ...f.request, executionContext: { ...f.request.executionContext, payload: { ...f.payload, evidence: values } } }));
  }
  assert.equal(f.calls(), 0);
});

test('missing or excessive actual Agent proof is rejected after adapter execution', async t => {
  const f = await fixture(t);
  for (const execution of [{}, { ...proof, skillLoaded: false }, { ...proof, proofValidated: false }, { ...proof, providerRequests: 33 },
    { ...proof, toolCalls: 2 }, { ...proof, toolCalls: 97 }, { ...proof, agentSessions: 2 }, { ...proof, backend: 'pi' }]) {
    f.service.runner = { runSkill: async () => ({ result: report(), execution }) };
    await assert.rejects(f.service.execute(f.request), error => error.code === 'SKILL_EXECUTION_PROOF_INVALID' && error.modelStarted);
  }
});

test('trusted declared execution policy is preserved and both declared and hard proof bounds are enforced', async t => {
  const policy = { modelRequests: 12, toolCalls: 32, inputCharacters: 192000, maxTokens: 4096 };
  const configured = await fixture(t, async () => ({ result: report(), execution: { ...proof, providerRequests: 12, toolCalls: 32, limits: policy } }));
  assert.deepEqual((await configured.service.execute(configured.request)).execution.limits, policy);
  const hard = await fixture(t, async () => ({ result: report(), execution: { ...proof, providerRequests: 32, toolCalls: 96,
    limits: { modelRequests: 32, toolCalls: 96, inputCharacters: 384000, maxTokens: 8192 } } }));
  assert.equal((await hard.service.execute(hard.request)).execution.toolCalls, 96);
  const legacy = await fixture(t, async () => ({ result: report(), execution: { ...proof, providerRequests: 32, toolCalls: 96 } }));
  assert.equal((await legacy.service.execute(legacy.request)).execution.providerRequests, 32);
  for (const execution of [
    { ...proof, providerRequests: 13, limits: policy }, { ...proof, toolCalls: 33, limits: policy },
    ...Object.entries({ modelRequests: 33, toolCalls: 97, inputCharacters: 384001, maxTokens: 8193 }).map(([key, value]) => ({ ...proof, limits: { ...policy, [key]: value } })),
    { ...proof, limits: { ...policy, toolCalls: 0 } }, { ...proof, limits: { modelRequests: 12 } },
    { ...proof, limits: { ...policy, arbitraryPath: 'D:/private' } },
  ]) {
    const f = await fixture(t, async () => ({ result: report(), execution }));
    await assert.rejects(f.service.execute(f.request), { code: 'SKILL_EXECUTION_PROOF_INVALID' });
  }
});

test('strict report fields and evidence references are checked; model-provided output paths are ignored', async t => {
  const f = await fixture(t); const bad = report(); bad.evidence[0].id = 'E9999';
  f.service.runner = { runSkill: async () => ({ result: bad, execution: proof }) };
  await assert.rejects(f.service.execute(f.request));
  f.service.runner = { runSkill: async () => ({ result: { ...report(), files: ['/private'] }, execution: proof }) };
  await assert.rejects(f.service.execute(f.request));
  f.service.runner = { runSkill: async () => ({ result: report(), execution: proof, files: [{ path: '/private', name: 'secrets.txt' }] }) };
  const result = await f.service.execute(f.request); assert.deepEqual(result.files.map(file => file.name), ['report.json', '报告.txt']);
});

test('mutating an input during Agent execution invalidates the final report and its manifests', async t => {
  const f = await fixture(t, async request => {
    await writeFile(join(request.executionContext.directory, 'demo.log'), LOG.replace('ERROR', 'FATAL'));
    return { result: report(), execution: proof };
  });
  await assert.rejects(f.service.execute(f.request), error => error.code === 'SKILL_INPUT_CHANGED' && error.modelStarted);
});

test('a reserved report name cannot be overwritten, even by a runner writing during execution', async t => {
  const f = await fixture(t); const output = join(f.root, 'reserved'); await mkdir(output);
  await writeFile(join(output, 'report.json'), 'previous record');
  await assert.rejects(f.service.execute({ ...f.request, executionContext: { ...f.request.executionContext, outputDirectory: output } }), { code: 'SKILL_OUTPUT_EXISTS' });
  assert.equal(f.calls(), 0); assert.equal(await readFile(join(output, 'report.json'), 'utf8'), 'previous record');
});

test('beforeExecute denial and an already-aborted request cannot start a backend', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.execute(f.request, { beforeExecute: () => { throw Object.assign(new Error('budget'), { code: 'TRIAGE_MODEL_BUDGET' }); } }),
    error => error.code === 'TRIAGE_MODEL_BUDGET' && !error.modelStarted);
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  await assert.rejects(f.service.execute(f.request, { signal: controller.signal }), error => !error.modelStarted);
  assert.equal(f.calls(), 0);
});

test('uncertain backend failure preserves unknown execution state; it never retries the Agent', async t => {
  const f = await fixture(t, () => { throw Object.assign(new Error('private provider detail'), { modelStarted: true, processTreeStopped: false }); });
  await assert.rejects(f.service.execute(f.request), error => error.modelStarted && error.processTreeStopped === false && error.message === 'SKILL_EXECUTION_FAILED');
  assert.equal(f.calls(), 1);
});
