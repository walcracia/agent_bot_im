import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshExecutor } from '../dsh-executor.mjs';

const fakeCli = String.raw`
if ($args -contains '--version') { $global:LASTEXITCODE = 0; Write-Output 'fake-dsh 0.2.2-test'; return }
$prompt = ($input | Out-String).Trim()
$id = 'session-uniform-fixture'
$index = [Array]::IndexOf($args, '--session-id')
if ($index -ge 0) { $id = $args[$index + 1] }
$permissionIndex = [Array]::IndexOf($args, '--permission-mode')
$permission = $args[$permissionIndex + 1]
$global:LASTEXITCODE = 0
@{ type = 'session'; sessionId = $id } | ConvertTo-Json -Compress
@{ type = 'status'; phase = 'step_start'; step = 1 } | ConvertTo-Json -Compress
if ($prompt -eq 'MODE_WAIT') {
  [IO.File]::WriteAllText((Join-Path (Get-Location).Path 'started.txt'), 'yes')
  Start-Sleep -Seconds 120
  return
}
@{ type = 'tool_call'; callId = 'call-one'; tool = 'read'; input = @{} } | ConvertTo-Json -Compress
@{ type = 'status'; phase = 'step_end'; step = 1; usage = @{ inputTokens = 12; outputTokens = 3; totalTokens = 15 } } | ConvertTo-Json -Compress
$answer = @{ permission = $permission; privateEnvSeen = [bool]((Test-Path Env:QA_TEST_KEY) -or (Test-Path Env:TEAM_RELAY_BOT_TOKEN)); text = $prompt; native = $id } | ConvertTo-Json -Compress
@{ type = 'final'; sessionId = $id; reason = @{ kind = 'completed' }; text = $answer } | ConvertTo-Json -Depth 6 -Compress
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-uniform-dsh-')), cwd = join(root, 'workspace'), runsPath = join(root, 'runs');
  await mkdir(cwd);
  const command = join(root, 'fake-cli.ps1'); await writeFile(command, fakeCli);
  const executor = new DshExecutor({ command, runsPath, provider: 'fixture-provider', model: 'fixture-model',
    harness: { env: { ...process.env, QA_TEST_KEY: 'fixture-only-secret', TEAM_RELAY_BOT_TOKEN: 'fixture-only-secret' } } });
  t.after(async () => { await executor.close(); await rm(root, { recursive: true, force: true }); });
  return { executor, cwd, runsPath };
}
const windows = { skip: process.platform !== 'win32' ? 'The reused DSH supervisor requires Windows PowerShell.' : false };

test('uniform DSH Worker completes in workspace-write and restores the exact native session', windows, async t => {
  const f = await fixture(t), prompt = '保留原文 $(Get-Date); `literal`';
  const first = await f.executor.run({ taskId: 'T850001', cwd: f.cwd, prompt });
  assert.equal(first.backend, 'dsh'); assert.equal(first.completed, true); assert.equal(first.sessionId, 'session-uniform-fixture');
  assert.deepEqual(first.usage.tokens, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  assert.equal(first.usage.modelTurns, 1); assert.equal(first.usage.toolCalls, 1);
  assert.deepEqual(JSON.parse(first.text), { permission: 'workspace-write', privateEnvSeen: false, text: prompt, native: first.sessionId });
  const taskRoot = join(f.runsPath, 'T850001');
  const map = JSON.parse(await readFile(join(taskRoot, 'sessions.json'), 'utf8'));
  assert.equal(map.sessions['teamplay:T850001'].nativeSessionId, first.sessionId);
  const second = await f.executor.run({ taskId: 'T850001', cwd: f.cwd, prompt: '继续', sessionId: first.sessionId });
  assert.equal(second.sessionId, first.sessionId);
  const folders = await readdir(join(taskRoot, 'native-runs'));
  const spec = JSON.parse(await readFile(join(taskRoot, 'native-runs', folders[0], 'bridge-run.json'), 'utf8'));
  assert.equal(spec.timeoutMs, 0);
  const patches = (await readdir(taskRoot)).filter(name => name.startsWith('model-') && name.endsWith('.patch.yml'));
  const patch = await readFile(join(taskRoot, patches[0]), 'utf8');
  assert.match(patch, /fixture-provider/u); assert.match(patch, /fixture-model/u);
  assert.match(patch, /reasoningEffort: "high"/u);
  await assert.rejects(f.executor.run({ taskId: 'T850001', cwd: f.cwd, prompt: '不得换会话' }), /explicitly resume/u);
  await assert.rejects(f.executor.run({ taskId: 'T850001', cwd: f.cwd, prompt: '不得换会话', sessionId: 'session-other' }), /exact ID/u);
});

test('uniform DSH cancellation waits for owned-process termination proof', windows, async t => {
  const f = await fixture(t), controller = new AbortController();
  const run = f.executor.run({ taskId: 'T850002', cwd: f.cwd, prompt: 'MODE_WAIT' }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    for (let count = 0; count < 150; count++) {
      if (await readFile(join(f.cwd, 'started.txt'), 'utf8').catch(() => null)) { controller.abort(); break; }
      await new Promise(resolveWait => setTimeout(resolveWait, 40));
    }
    await assert.rejects(run, error => error.kind === 'cancelled' && error.processTreeStopped === true);
  } finally { clearTimeout(timer); }
});

test('uniform DSH mounts explicit native Skill and MCP plugins through task-only patches', windows, async t => {
  const f = await fixture(t);
  const skill = join(f.cwd, 'skills'); await mkdir(skill);
  await writeFile(join(skill, 'SKILL.md'), '---\nname: sum-fixture\ndescription: Sum fixture input using the calculator.\n---\nUse the calculator.\n');
  await f.executor.run({ taskId: 'T850003', cwd: f.cwd, prompt: '工作', skillPaths: [skill],
    mcpServers: [{ name: 'calculator', command: process.execPath, args: ['fixture.mjs'], env: { FIXTURE_LABEL: 'test-only' } }] });
  const root = join(f.runsPath, 'T850003'), paths = (await readdir(root)).filter(name => name.startsWith('resources-'));
  const patch = await readFile(join(root, paths[0]), 'utf8');
  assert.match(patch, /id: skill-filesystem/u); assert.match(patch, /includeDefaultRoots: false/u); assert.match(patch, /customSkillDirs:/u);
  assert.ok(patch.includes(JSON.stringify(skill))); assert.match(patch, /@deepseek-ai\/dsh-mcp-client/u);
  assert.match(patch, /serverName: "calculator"/u); assert.match(patch, /transport: "stdio"/u); assert.match(patch, /FIXTURE_LABEL/u);
  await assert.rejects(f.executor.run({ taskId: 'T850004', cwd: f.cwd, prompt: '工作', mcpServers: [{ name: 'bad', command: process.execPath, env: { TEAM_RELAY_BOT_TOKEN: 'never-forward' } }] }), /Invalid trusted DSH MCP/u);
  await assert.rejects(f.executor.run({ taskId: 'T850004', cwd: f.cwd, prompt: '工作', mcpServers: [{ name: 'bad', command: 'from-prompt' }] }), /explicit absolute paths/u);
});
