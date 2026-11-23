import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiExecutor, registerPiSessionDirectory } from '../pi-executor.mjs';

async function setup(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-pi-'));
  const cwd = join(root, 'work'), dataHome = join(root, 'auth'), runsPath = join(root, 'runs');
  await mkdir(cwd); await mkdir(dataHome);
  t.after(() => rm(root, { recursive: true, force: true }));
  const invocations = [];
  function spawn(command, args, options) {
    const child = new EventEmitter(); child.pid = 42; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const get = flag => args[args.indexOf(flag) + 1];
    const sessionId = args.includes('--session-id') ? get('--session-id') : JSON.parse(requireHeader(get('--session'))).id;
    const nativeFile = args.includes('--session') ? get('--session') : join(get('--session-dir'), `native-${sessionId}.jsonl`);
    const state = { sessionId: settings.wrongSession ? 'wrong-session' : sessionId, sessionFile: nativeFile, isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
    const invocation = { command, args, options, commands: [], child, nativeFile, taskPrompt: null }; invocations.push(invocation);
    const emit = event => child.stdout.write(JSON.stringify(event) + '\n');
    let tokens = 0;
    const reply = (event, data) => emit({ type: 'response', id: event.id, command: event.type, success: true, data });
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const event = JSON.parse(chunk.toString().trim()); invocation.commands.push(event);
        if (event.type === 'get_state') reply(event, state);
        else if (event.type === 'get_session_stats') reply(event, { tokens: { input: tokens, output: tokens / 2, total: tokens * 1.5 } });
        else if (event.type === 'clear_queue') reply(event, { steering: [], followUp: [] });
        else if (event.type === 'abort') { state.isStreaming = false; reply(event); emit({ type: 'agent_settled', aborted: true }); }
        else if (event.type === 'prompt') {
          invocation.taskPrompt = event.message; state.isStreaming = true;
          mkdirSync(get('--session-dir'), { recursive: true }); writeFileSync(nativeFile, JSON.stringify({ type: 'session', id: sessionId, cwd: options.cwd }) + '\n');
          reply(event, { disposition: 'started' }); settings.onPrompt?.(invocation);
          if (!settings.hold) {
            emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
            emit({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'one' });
            tokens = 20;
            emit({ type: 'message_end', message: { role: 'assistant', stopReason: settings.stopReason ?? 'stop', content: [{ type: 'text', text: 'Done\u2028原文' }] } });
            state.isStreaming = false; emit({ type: 'agent_settled', aborted: false });
          }
        }
        callback();
      },
      final(callback) { callback(); queueMicrotask(() => { child.stdout.end(); child.emit('close', 0, null); }); },
    });
    return child;
  }
  const executor = new PiExecutor({ command: process.execPath, dataHome, runsPath, spawn });
  return { executor, cwd, dataHome, runsPath, invocations };
}
function requireHeader(file) { return readFileSync(file, 'utf8').split('\n')[0]; }

test('Pi waits for native settled/final text, uses JSON stdin and preserves exact session on resume', async t => {
  const f = await setup(t);
  const prompt = '读取 fixture.json，保留 $() 和 `literal`\n第二行';
  const first = await f.executor.run({ taskId: 'T123456', cwd: f.cwd, prompt });
  assert.equal(first.backend, 'pi'); assert.equal(first.completed, true); assert.equal(first.text, 'Done\u2028原文');
  assert.equal(first.usage.modelTurns, 1); assert.equal(first.usage.toolCalls, 1); assert.equal(first.usage.tokens.totalTokens, 30);
  const one = f.invocations[0]; assert.equal(one.taskPrompt, prompt); assert.equal(one.options.shell, false);
  assert.ok(!one.args.includes(prompt)); assert.ok(one.args.includes('--no-mcp')); assert.ok(one.args.includes('--no-extensions'));
  assert.equal(one.options.env.PI_CODING_AGENT_DIR, f.dataHome); assert.ok(!Object.keys(one.options.env).some(key => /^(QA_|GITHUB_|TEAM_RELAY_)/u.test(key)));
  const mapping = JSON.parse(await readFile(join(f.runsPath, 'T123456', `session-${first.sessionId}.json`), 'utf8'));
  assert.equal(mapping.sessionFile, one.nativeFile);
  assert.equal(one.args[one.args.indexOf('--name') + 1], '同频 · T123456');
  const folders = await readdir(join(f.dataHome, 'sessions'));
  assert.equal(folders.length, 1);
  const registered = join(f.dataHome, 'sessions', folders[0]);
  assert.equal(await realpath(registered), await realpath(join(f.runsPath, 'T123456', 'sessions')));
  assert.equal(await readFile(join(registered, (await readdir(registered))[0]), 'utf8'), await readFile(one.nativeFile, 'utf8'));
  const second = await f.executor.run({ taskId: 'T123456', cwd: f.cwd, prompt: '继续检查', sessionId: first.sessionId });
  assert.equal(second.sessionId, first.sessionId);
  const two = f.invocations[1]; assert.ok(two.args.includes('--session')); assert.ok(!two.args.includes('--continue')); assert.ok(!two.args.includes('--resume'));
  assert.deepEqual(await readdir(join(f.dataHome, 'sessions')), folders);
});

test('Pi catalog registration refuses a conflicting directory and leaves original sessions untouched', async t => {
  const f = await setup(t), nativeRoot = join(f.runsPath, 'original'); await mkdir(nativeRoot, { recursive: true });
  const original = join(nativeRoot, 'native.jsonl'); await writeFile(original, 'original native history\n');
  const registration = await registerPiSessionDirectory({ dataHome: f.dataHome, nativeRoot, taskId: 'BCATALOG' });
  await (await import('node:fs/promises')).unlink(registration); await mkdir(registration);
  await assert.rejects(registerPiSessionDirectory({ dataHome: f.dataHome, nativeRoot, taskId: 'BCATALOG' }), /conflicts/u);
  assert.equal(await readFile(original, 'utf8'), 'original native history\n');
});

test('Pi cancellation clears queued work then aborts and confirms native idle/exit', async t => {
  const signal = new AbortController(); const f = await setup(t, { hold: true, onPrompt: () => signal.abort() });
  await assert.rejects(f.executor.run({ taskId: 'T123457', cwd: f.cwd, prompt: '工作' }, { signal: signal.signal }), error => error.kind === 'cancelled' && error.processTreeStopped === true);
  const types = f.invocations[0].commands.map(command => command.type);
  assert.ok(types.indexOf('clear_queue') < types.indexOf('abort'));
  assert.equal(types.at(-1), 'get_state');
});

test('Pi does not report accepted prompts or failed assistant output as completed', async t => {
  const f = await setup(t, { stopReason: 'error' });
  await assert.rejects(f.executor.run({ taskId: 'T123458', cwd: f.cwd, prompt: '工作' }), /successful final assistant/u);
  assert.ok(f.invocations[0].commands.some(command => command.type === 'abort'));
});

test('Pi rejects a different native session before sending business input', async t => {
  const f = await setup(t, { wrongSession: true });
  await assert.rejects(f.executor.run({ taskId: 'T123459', cwd: f.cwd, prompt: '工作' }), /another native session/u);
  assert.ok(!f.invocations[0].commands.some(command => command.type === 'prompt'));
});

test('Pi loads only explicit skills and task MCP servers without changing user configuration', async t => {
  let observed;
  const f = await setup(t, { onPrompt: invocation => { observed = JSON.parse(readFileSync(join(invocation.options.cwd, '.pi', 'mcp.json'), 'utf8')); } });
  const globalMcp = JSON.stringify({ mcpServers: { personal: { command: 'unused-personal-tool' } } });
  await (await import('node:fs/promises')).writeFile(join(f.dataHome, 'mcp.json'), globalMcp);
  const skill = join(f.cwd, 'SKILL.md');
  await (await import('node:fs/promises')).writeFile(skill, '---\nname: sum-fixture\ndescription: Sum input numbers.\n---\nRead the input and write the sum.\n');
  const servers = { task: { command: 'trusted-task-tool', args: ['--stdio'] } };
  await f.executor.run({ taskId: 'T123460', cwd: f.cwd, prompt: '/skill:sum-fixture fixture.json', skillPaths: [skill], mcpServers: servers });
  assert.deepEqual(observed, { mcpServers: { personal: { enabled: false }, task: { ...servers.task, exposure: 'direct' } } });
  const args = f.invocations[0].args;
  assert.equal(args[args.indexOf('--skill') + 1], skill);
  assert.equal(args[args.indexOf('-e') + 1], 'builtin:mcp'); assert.ok(args.includes('--no-extensions')); assert.ok(args.includes('--no-skills'));
  assert.equal(await readFile(join(f.dataHome, 'mcp.json'), 'utf8'), globalMcp);
  await assert.rejects(readFile(join(f.cwd, '.pi', 'mcp.json')), { code: 'ENOENT' });
});

test('Pi preserves explicit direct exposure and refuses modes needing disabled extensions before launch', async t => {
  let observed;
  const f = await setup(t, { onPrompt: invocation => { observed = JSON.parse(readFileSync(join(invocation.options.cwd, '.pi', 'mcp.json'), 'utf8')); } });
  const server = { command: 'trusted-task-tool', exposure: 'direct' };
  await f.executor.run({ taskId: 'T123461', cwd: f.cwd, prompt: '工作', mcpServers: { task: server } });
  assert.deepEqual(observed.mcpServers.task, server);
  for (const exposure of ['codemode', 'deferred']) await assert.rejects(f.executor.run({ taskId: 'T123462', cwd: f.cwd, prompt: '工作',
    mcpServers: { task: { ...server, exposure } } }), /only direct MCP/u);
  assert.equal(f.invocations.length, 1);
});
