import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../triage-plugin-direct.mjs';
import { DshSkillRunner } from '../dsh-skill-runner.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const source = ['# OTA 日志分析报告', '', '【结论】', '责任方：合成服务；置信度：中。', '合成响应导致操作失败。', '',
  '【依据】', '1. app.log:1 — 合成响应为失败。', '', '【时间线】', '1. app.log:1 — 10:00 出现失败。', '',
  '【其他可能】', '暂无其他证据。', '', '【下一步】', '核对合成服务。'].join('\n');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-plugin-direct-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['requestPath', 'receiptPath', 'sourceReportPath'].map(key => [key, join(root, key + '.json')]));
  const input = { recipe: 'chery-qa-plugin', taskId: 'T000001', inputRevision: 1, maxTokens: 6000, system: 'original system', user: 'original user' };
  await writeFile(paths.requestPath, JSON.stringify(input));
  return { root, paths, input };
}
async function collect(stream) { const result = []; for await (const value of stream) result.push(value); return result; }

test('direct recipe dispatches the original plugin envelope once through prepareCall and preserves its stream/report', async t => {
  const f = await fixture(t), callbacks = {}, guards = [];
  let prepared = 0, outerDispatches = 0, innerDispatches = 0, observed, scoped;
  const provider = { async *stream(options) {
    innerDispatches++; observed = options;
    yield { type: 'text-delta', text: source };
    yield { type: 'finish', reason: { kind: 'completed' }, usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } };
  } };
  const llm = { prepareCall: async (config, signal, configure) => {
    prepared++;
    assert.equal(config.maxTokens, undefined); assert.equal(config.model, 'selected-model'); assert.equal(config.reasoningEffort, 'high');
    const controls = configure({ reasoningEffort: config.reasoningEffort }, { defaultMaxTokens: 256000, reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }] } });
    return { config: { ...config, ...controls }, stream: options => callbacks['llm/stream'](options, () => provider.stream(options)) };
  } };
  const ctx = { llm, tools: { guard: guard => guards.push(guard) }, on: (event, callback) => callbacks[event] = callback,
    get: name => name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'selected-provider', model: 'selected-model' }) } : undefined };
  apply(ctx, f.paths);
  callbacks['agent/created']({ agent: { ctx: { tools: { restrict: value => scoped = value } } } });
  assert.deepEqual(scoped, { allow: [] }); assert.match(guards[0]({ name: 'bash' }), /do not execute/u);
  const outer = { messages: [{ role: 'user', content: 'transport text must not reach model' }], tools: [], maxTokens: 1234 };
  const next = async function* () { outerDispatches++; };
  const chunks = await collect(callbacks['llm/stream'](outer, next));
  assert.equal(prepared, 1); assert.equal(innerDispatches, 1); assert.equal(outerDispatches, 0);
  assert.equal(observed.system, f.input.system); assert.equal(observed.messages.length, 1);
  assert.deepEqual(observed.messages[0], { role: 'user', content: [{ type: 'text', text: f.input.user }], source: { kind: 'chery-qa' } });
  assert.equal(observed.reasoningEffort, 'high'); assert.equal(observed.maxTokens, 256000);
  assert.equal(observed.tools, undefined); assert.equal(observed.temperature, undefined); assert.equal(observed.topP, undefined);
  assert.equal(chunks[0].text, source); assert.equal(await readFile(f.paths.sourceReportPath, 'utf8'), source);
  const receipt = JSON.parse(await readFile(f.paths.receiptPath, 'utf8'));
  assert.equal(receipt.completed, true); assert.equal(receipt.tools, 0); assert.equal(receipt.requests, 1);
  assert.equal(receipt.reasoningEffort, 'high'); assert.equal(receipt.maxTokens, 256000);
  assert.equal(receipt.recipeMaxTokens, 6000); assert.equal(receipt.maxTokensSource, 'native-model-default');
  assert.equal(receipt.sourceReportSha256, hash(source)); assert.equal(receipt.systemSha256, hash(f.input.system));
  assert.deepEqual(receipt.usage.tokens, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  assert.deepEqual(await collect(callbacks['llm/stream'](outer, next)), chunks);
  assert.equal(prepared, 1); assert.equal(innerDispatches, 1); assert.equal(outerDispatches, 0);
});

test('production runner uses the direct recipe with no Agent tools, preserves source prose and verifies the native receipt', async t => {
  const f = await fixture(t);
  const evidence = [{ id: 'E0001', file: 'app.log', line: 1, sha256: 'a'.repeat(64), text: 'Synthetic failure' }];
  let sessions = 0, options;
  const runner = new DshSkillRunner({ root: f.root, harness: { modelSelection: { provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high' }, env: { GH_TOKEN: 'secret' } },
    prepareAnalysis: async () => ({ ...f.input, evidence, proof: { skillLoaded: true, parserRuns: 1, evidenceReadCalls: 2 } }),
    executorFactory: config => ({
      lastInvocation: { completed: true, launcherExited: true, nativeExitCode: 0, finalReason: 'completed', sessionId: 'session-synthetic', processTreeStopped: true },
      classify: async () => {
        sessions++; options = config;
        const input = JSON.parse(await readFile(join(config.cwd, 'plugin-request.json'), 'utf8'));
        assert.equal(input.modelSelection.reasoningEffort, 'high');
        await writeFile(join(config.cwd, 'plugin-report.md'), source);
        await writeFile(join(config.cwd, 'plugin-receipt.json'), JSON.stringify({ recipe: 'chery-qa-plugin', taskId: 'T000001', inputRevision: 1,
          guard: true, tools: 0, source: 'chery-qa', requests: 1, completed: true, systemSha256: hash(input.system), userSha256: hash(input.user),
          sourceReportSha256: hash(source), recipeMaxTokens: 6000, maxTokens: 256000, reasoningEffort: 'high', maxTokensSource: 'native-model-default',
          provider: 'selected-provider', model: 'selected-model', usage: { tokens: { inputTokens: 10 } } }));
        return source;
      }, close: async () => {},
    }) });
  assert.equal(runner.recipe, 'chery-qa-plugin');
  const result = await runner.runSkill({ taskId: 'T000001', inputRevision: 1, skillId: 'ota-log-triage@1.3.2', parameters: {},
    inputFiles: [], executionContext: { directory: '/trusted/inputs', skillRoot: '/trusted/skill', payload: {} } });
  assert.equal(sessions, 1); assert.equal(result.sourceReport, source); assert.equal(result.execution.recipe, 'chery-qa-plugin');
  assert.equal(result.execution.toolCalls, 0); assert.equal(result.execution.usage.parserRuns, 1);
  assert.equal(result.execution.usage.evidenceLines, 1); assert.equal(result.execution.usage.evidenceReadCalls, 2);
  assert.equal(result.result.conclusion, '责任方：合成服务；置信度：中。\n合成响应导致操作失败。');
  assert.deepEqual(result.evidence, evidence); assert.equal(options.env.GH_TOKEN, undefined);
  assert.equal(options.runTimeoutMs, 0); assert.equal(options.classificationTimeoutMs, 0);
  const patch = await readFile(options.extraPatches[0], 'utf8');
  assert.match(patch, /triage-plugin-direct/u); assert.match(patch, /reasoningEffort: "high"/u);
  assert.doesNotMatch(patch, /dsh-mcp-client|triage-tools|maxTokens/u);
  await runner.close();
});

test('direct recipe refuses a model without High support before provider dispatch', async t => {
  const f = await fixture(t), callbacks = {};
  let dispatched = 0;
  const llm = { prepareCall: async (config, signal, configure) => {
    const controls = configure({}, { defaultMaxTokens: 256000, reasoning: { efforts: [{ id: 'off' }, { id: 'xhigh' }] } });
    return { config: { ...config, ...controls }, stream: async function* () { dispatched++; } };
  } };
  apply({ tools: { guard() {} }, on: (name, callback) => callbacks[name] = callback,
    get: name => name === 'llm' ? llm : { currentSelection: () => ({ provider: 'selected-provider', model: 'selected-model' }) } }, f.paths);
  await assert.rejects(collect(callbacks['llm/stream']({}, async function* () {})), /does not support reasoning effort high/u);
  const receipt = JSON.parse(await readFile(f.paths.receiptPath, 'utf8'));
  assert.equal(dispatched, 0); assert.equal(receipt.requests, 0); assert.equal(receipt.completed, false);
});
