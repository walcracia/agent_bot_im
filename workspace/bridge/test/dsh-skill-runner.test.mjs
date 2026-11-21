import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, SKILL_TOOL_NAMES } from '../triage-skill-plugin.mjs';
import { DshSkillRunner, skillTaskPrompt, parseSkillReport } from '../dsh-skill-runner.mjs';

async function fixture(t, executionLimits) {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-skill-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const callbacks = {}, guards = [];
  const ctx = { tools: { guard: guard => guards.push(guard), definitions: () => SKILL_TOOL_NAMES.map(name => ({ name })) }, on: (name, callback) => callbacks[name] = callback };
  const receiptPath = join(root, 'provider.json');
  apply(ctx, { receiptPath, executionLimits });
  return { root, callbacks, guards, receiptPath };
}
const options = () => ({ tools: SKILL_TOOL_NAMES.map(name => ({ name })), maxTokens: 2400, messages: [{ role: 'user', content: 'Synthetic test' }] });
async function drain(stream) { for await (const _ of stream) { /* consume policy */ } }

test('skill Agent can use only four task tools; missing scoped restriction fails closed', async t => {
  const f = await fixture(t);
  let restricted;
  await f.callbacks['agent/created']({ agent: { ctx: { tools: { restrict: value => restricted = value } } } });
  assert.deepEqual(restricted.allow, SKILL_TOOL_NAMES);
  for (const name of SKILL_TOOL_NAMES) assert.equal(f.guards[0]({ name }), undefined);
  assert.match(f.guards[0]({ name: 'bash' }), /only/u);
  await assert.rejects(f.callbacks['agent/created']({ agent: { ctx: {} } }));
});

test('skill isolation remains enforced while old generation/input/output caps become observations', async t => {
  const f = await fixture(t, { modelRequests: 6, toolCalls: 12, inputCharacters: 120000, maxTokens: 2400 });
  let calls = 0;
  const next = async function* () { calls++; yield { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }; };
  for (const mutation of [
    value => value.tools.push({ name: 'bash' }), value => value.tools.pop(),
  ]) {
    const value = options(); mutation(value);
    await assert.rejects(drain(f.callbacks['llm/stream'](value, next)));
  }
  assert.equal(calls, 0);
  const value = options(); value.maxTokens = 99999; value.messages = [{ role: 'user', content: 'X'.repeat(400001) }];
  for (let n = 0; n < 35; n++) await drain(f.callbacks['llm/stream'](value, next));
  assert.equal(calls, 35); assert.equal(value.maxTokens, 99999);
  assert.equal(f.callbacks['agent/request'], undefined);
  const proof = JSON.parse(await readFile(f.receiptPath, 'utf8'));
  assert.equal(proof.requests, 35); assert.equal(proof.guard, true); assert.equal(proof.inputCharacters.length, 35);
  assert.ok(proof.inputCharacters.every(size => size > 384000)); assert.equal(proof.limits, undefined);
  assert.deepEqual(proof.usage.tokens, { inputTokens: 3500, outputTokens: 700, totalTokens: 4200 });
});

const request = () => ({ taskId: 'T000001', inputRevision: 1, skillId: 'ota-log-triage@1.3.2', parameters: { mode: 'preliminary' },
  inputFiles: [{ path: 'test.log', bytes: 10, sha256: 'a'.repeat(64) }],
  executionContext: { directory: '/trusted/input', skillRoot: '/trusted/skill', payload: { mode: 'preliminary', issue: { no: 'DEMO-42', title: '合成测试' },
    evidence: [{ id: 'E0001', file: 'test.log', line: 1, text: 'Synthetic first line', sha256: 'a'.repeat(64) }], limitations: [] } } });
const strictReport = (id = 'E0001') => ({ conclusion: '保留原文："{业务返回}" 与反斜线 \\ 均属于结论。', confidence: 'high', responsibility: '合成服务',
  evidence: [{ id, interpretation: '真实读取的合成记录。' }], timeline: [{ id: 'E0001', event: '合成事件。' }],
  alternatives: [], nextSteps: ['按技能结论继续核查。'], limitations: [] });

test('a natural introduction followed by one strict report preserves all eight original fields', () => {
  const report = strictReport();
  assert.deepEqual(parseSkillReport('已完成日志核对，报告如下。\n' + JSON.stringify(report)), report);
  assert.deepEqual(parseSkillReport(JSON.stringify(report)), report);
  assert.strictEqual(parseSkillReport(report), report);
});

test('an introduction and complete multiline json fence are accepted without confusing quoted braces or log objects', () => {
  const report = strictReport();
  const text = '已按技能完成分析。普通日志对象 {"event":"synthetic"} 不是报告。\n```json\n' + JSON.stringify(report, null, 2) + '\n```\n以上为原始判断。';
  assert.deepEqual(parseSkillReport(text), report);
  assert.throws(() => parseSkillReport(text + '\n' + JSON.stringify(report)), /multiple report objects/u);
});

test('DSH runner verifies native/skill proof and returns dynamic read evidence and observed use beyond former caps', async t => {
  const f = await fixture(t);
  let invalid = false, seen;
  const runner = new DshSkillRunner({ recipe: 'legacy-four-tools', root: f.root, harness: { cliPath: '/trusted/cli', env: { GH_TOKEN: 'excluded' }, modelSelection: { provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'off' } },
    executorFactory: config => ({
      lastInvocation: { completed: true, launcherExited: true, nativeExitCode: 0, finalReason: 'completed', sessionId: 'session-synthetic', processTreeStopped: true },
      classify: async prompt => {
        seen = config; assert.match(prompt, /load_skill/u);
        const context = JSON.parse(await readFile(join(config.cwd, 'task-context.json'), 'utf8'));
        assert.equal(context.taskId, 'T000001');
        assert.equal(context.toolLimits, undefined);
        await writeFile(join(config.cwd, 'provider-proof.json'), JSON.stringify({ requests: 41, tools: SKILL_TOOL_NAMES, guard: true, inputCharacters: Array(41).fill(500000) }));
        await writeFile(context.proofPath, JSON.stringify({ taskId: context.taskId, inputRevision: 1, skillId: context.skillId,
          toolCalls: 140, skillLoaded: true, parserRan: true, evidenceReadIds: ['E0001', 'E0002'],
          evidenceCatalog: [{ id: 'E0002', file: 'test.log', line: 2, text: 'Synthetic paged line', sha256: 'a'.repeat(64) }],
          toolCallsByName: { load_skill: 1, list_inputs: 1, read_evidence: 130, run_parser: 8 }, evidenceReadCalls: 130, evidenceLines: 5000, parserRuns: 8 }));
        return '已完成核对，报告如下。\n```json\n' + JSON.stringify(strictReport(invalid ? 'E9999' : 'E0002'), null, 2) + '\n```';
      }, close: async () => {},
    }) });
  const result = await runner.runSkill(request());
  assert.equal(result.execution.providerRequests, 41); assert.equal(result.execution.proofValidated, true);
  assert.equal(result.execution.toolCalls, 140); assert.equal(result.execution.limits, undefined);
  assert.deepEqual(result.evidence.map(item => item.id), ['E0001', 'E0002']);
  assert.equal(result.execution.usage.providerRequests, 41); assert.equal(result.execution.usage.toolCalls, 140);
  assert.equal(result.execution.usage.evidenceLines, 5000); assert.equal(result.execution.usage.parserRuns, 8);
  assert.equal(result.execution.usage.evidenceReadCalls, 130);
  assert.equal(seen.runTimeoutMs, 0); assert.equal(seen.classificationTimeoutMs, 0);
  assert.equal(seen.permissionMode, 'read-only'); assert.equal(seen.env.GH_TOKEN, undefined);
  const patch = await readFile(seen.extraPatches[0], 'utf8');
  assert.match(patch, /dsh-mcp-client/u); assert.match(patch, /TEAMPLAY_TRIAGE_CONTEXT_FILE/u);
  assert.match(patch, /agent-default-model/u); assert.match(patch, /selected-provider/u); assert.match(patch, /selected-model/u);
  assert.match(patch, /reasoningEffort: "off"/u);
  assert.doesNotMatch(patch, /executionLimits|maxTokens/u);
  invalid = true;
  await assert.rejects(runner.runSkill(request()), error => error.modelStarted === true);
  await runner.close();
});

test('task prompt contains skill identity and optional business parameters without host paths', () => {
  const prompt = skillTaskPrompt(request());
  assert.match(prompt, /ota-log-triage@1.3.2/u); assert.match(prompt, /故障时间可选/u);
  assert.match(prompt, /本业务约定只覆盖skill/u); assert.match(prompt, /八个JSON字段/u);
  assert.match(prompt, /不额外添加业务判断要求/u);
  assert.doesNotMatch(prompt, /\/trusted\//u);
  assert.doesNotMatch(prompt, /合成测试/u); // QA context is for tracking; no implicit symptom is added to the skill.
  assert.doesNotMatch(prompt, /本次最多|至多60|剩余额度|预算|字符上限/u);
});

test('failed Agent execution retains observed use without creating a budget partial or starting another Agent', async t => {
  const f = await fixture(t); let sessions = 0;
  const runner = new DshSkillRunner({ recipe: 'legacy-four-tools', root: f.root, harness: {}, executorFactory: config => ({
    lastInvocation: { completed: false, launcherExited: true, processTreeStopped: true },
    classify: async () => {
      sessions++;
      const context = JSON.parse(await readFile(join(config.cwd, 'task-context.json'), 'utf8'));
      await writeFile(join(config.cwd, 'provider-proof.json'), JSON.stringify({ requests: 50, tools: SKILL_TOOL_NAMES, guard: true, inputCharacters: Array(50).fill(500000) }));
      await writeFile(context.proofPath, JSON.stringify({ toolCalls: 200, evidenceReadCalls: 150, evidenceLines: 10000, parserRuns: 15 }));
      throw Object.assign(new Error('Synthetic provider error'), { kind: 'provider-error' });
    }, close: async () => {},
  }) });
  await assert.rejects(runner.runSkill(request()), error => error.kind === 'provider-error' && error.processTreeStopped === true
    && error.usage.providerRequests === 50 && error.usage.toolCalls === 200 && error.usage.parserRuns === 15);
  assert.equal(sessions, 1); await runner.close();
});
