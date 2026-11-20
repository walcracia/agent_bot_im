import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, SKILL_TOOL_NAMES } from '../triage-skill-plugin.mjs';
import { DshSkillRunner, skillTaskPrompt } from '../dsh-skill-runner.mjs';

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

test('skill provider/tool/input budgets are checked before provider dispatch', async t => {
  const f = await fixture(t, { modelRequests: 6, toolCalls: 12, inputCharacters: 120000, maxTokens: 2400 });
  let calls = 0;
  const next = async function* () { calls++; yield {}; };
  for (const mutation of [
    value => value.tools.push({ name: 'bash' }), value => value.tools.pop(), value => value.maxTokens = 2401,
    value => value.messages = [{ text: 'x'.repeat(120001) }],
  ]) {
    const value = options(); mutation(value);
    await assert.rejects(drain(f.callbacks['llm/stream'](value, next)));
  }
  assert.equal(calls, 0);
  for (let n = 0; n < 6; n++) await drain(f.callbacks['llm/stream'](options(), next));
  await assert.rejects(drain(f.callbacks['llm/stream'](options(), next)));
  assert.equal(calls, 6);
  const proof = JSON.parse(await readFile(f.receiptPath, 'utf8'));
  assert.equal(proof.requests, 6); assert.equal(proof.guard, true); assert.equal(proof.inputCharacters.length, 6);
});

const request = () => ({ taskId: 'T000001', inputRevision: 1, skillId: 'ota-log-triage@1.3.2', parameters: { mode: 'preliminary' },
  inputFiles: [{ path: 'test.log', bytes: 10, sha256: 'a'.repeat(64) }],
  executionContext: { directory: '/trusted/input', skillRoot: '/trusted/skill', payload: { mode: 'preliminary', issue: { title: '合成测试' }, limitations: [] } } });

test('DSH runner must prove actual skill/parser/evidence calls and unread references cannot pass', async t => {
  const f = await fixture(t);
  let invalid = false, seen;
  const runner = new DshSkillRunner({ root: f.root, harness: { cliPath: '/trusted/cli', env: { GH_TOKEN: 'excluded' }, modelSelection: { provider: 'selected-provider', model: 'selected-model' } },
    executorFactory: config => ({
      classify: async prompt => {
        seen = config; assert.match(prompt, /load_skill/u);
        const context = JSON.parse(await readFile(join(config.cwd, 'task-context.json'), 'utf8'));
        assert.equal(context.taskId, 'T000001');
        await writeFile(join(config.cwd, 'provider-proof.json'), JSON.stringify({ requests: 3, tools: SKILL_TOOL_NAMES, guard: true, inputCharacters: [2000, 23000, 29000] }));
        await writeFile(context.proofPath, JSON.stringify({ taskId: context.taskId, inputRevision: 1, skillId: context.skillId,
          toolCalls: 4, skillLoaded: true, parserRan: true, evidenceReadIds: ['E0001'] }));
        return JSON.stringify({ evidence: [{ id: invalid ? 'E9999' : 'E0001' }], timeline: [{ id: 'E0001' }] });
      }, close: async () => {},
    }) });
  const result = await runner.runSkill(request());
  assert.equal(result.execution.providerRequests, 3); assert.equal(result.execution.proofValidated, true);
  assert.equal(seen.permissionMode, 'read-only'); assert.equal(seen.env.GH_TOKEN, undefined);
  const patch = await readFile(seen.extraPatches[0], 'utf8');
  assert.match(patch, /dsh-mcp-client/u); assert.match(patch, /TEAMPLAY_TRIAGE_CONTEXT_FILE/u);
  assert.match(patch, /agent-default-model/u); assert.match(patch, /selected-provider/u); assert.match(patch, /selected-model/u);
  invalid = true;
  await assert.rejects(runner.runSkill(request()), error => error.modelStarted === true);
  await runner.close();
});

test('task prompt contains skill identity and optional business parameters without host paths', () => {
  const prompt = skillTaskPrompt(request());
  assert.match(prompt, /ota-log-triage@1.3.2/u); assert.match(prompt, /故障时间可选/u);
  assert.doesNotMatch(prompt, /\/trusted\//u);
});

test('default generation policy admits twelve steps and exposes its actual trusted limits', async t => {
  const f = await fixture(t); let calls = 0;
  const next = async function* () { calls++; yield {}; };
  const requestOptions = options(); requestOptions.maxTokens = 4096;
  for (let index = 0; index < 12; index++) await drain(f.callbacks['llm/stream'](requestOptions, next));
  await assert.rejects(drain(f.callbacks['llm/stream'](requestOptions, next)));
  const proof = JSON.parse(await readFile(f.receiptPath, 'utf8'));
  assert.equal(calls, 12); assert.deepEqual(proof.limits, { modelRequests: 12, toolCalls: 32, inputCharacters: 192000, maxTokens: 4096 });
});
