import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { InstalledHeadlessExecutor } from './installed-headless.mjs';
import { triageModelEnvironment } from './triage-model.mjs';
import { dshModelPatch, dshModelSelection } from './dsh-model-selection.mjs';

const absolute = value => {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/u.test(value)) throw new Error('DSH paths must be explicit absolute paths.');
  return resolve(value);
};
const nativeId = value => /^session-[A-Za-z0-9_-]+$/u.test(value ?? '');
const failure = (message, cause) => Object.assign(new Error(message, { cause }), { kind: cause?.kind ?? 'dsh-execution-failed', processTreeStopped: cause?.processTreeStopped === true });

async function resourcePatch(skillPaths, mcpServers, cwd) {
  if (!Array.isArray(skillPaths) || !Array.isArray(mcpServers)) throw failure('DSH skills and MCP servers must be trusted arrays.');
  const roots = [];
  for (const path of skillPaths) {
    const info = await lstat(absolute(path));
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw failure('DSH skill path must be a regular file or directory.');
    const canonical = await realpath(path);
    roots.push(info.isFile() ? dirname(canonical) : canonical);
  }
  const rows = ['- id: skill\n  disabled: false', '- id: tool-skill\n  disabled: false',
    '- id: skill-filesystem\n  disabled: false\n  config:\n    includeDefaultRoots: false\n    watch: false\n    customSkillDirs: ' + JSON.stringify([...new Set(roots)])];
  const names = new Set(), insert = [];
  for (const server of mcpServers) {
    if (!server || typeof server !== 'object' || Array.isArray(server) || Object.keys(server).some(key => !['name', 'command', 'args', 'env'].includes(key))
      || !/^[A-Za-z0-9_-]{1,32}$/u.test(server.name ?? '') || names.has(server.name)
      || !Array.isArray(server.args ?? []) || (server.args ?? []).some(value => typeof value !== 'string' || value.includes('\0'))
      || server.env !== undefined && (!server.env || typeof server.env !== 'object' || Array.isArray(server.env)
        || Object.entries(server.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || /^(?:IM_|TEAM_RELAY_|SUPER_AGENT_|GITHUB_|GH_|DSH_)/iu.test(key)
          || typeof value !== 'string' || value.includes('\0')))) throw failure('Invalid trusted DSH MCP configuration.');
    names.add(server.name);
    const config = { serverName: server.name, transport: 'stdio', command: absolute(server.command), args: server.args ?? [], env: server.env ?? {}, cwd,
      failOnStartupError: true, expandTemplates: false, startupTimeoutMs: 30000 };
    insert.push('    - id: teamplay-worker-mcp-' + server.name + '\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n'
      + Object.entries(config).map(([key, value]) => '        ' + key + ': ' + JSON.stringify(value)).join('\n'));
  }
  if (insert.length) rows.push('- insert:\n' + insert.join('\n'));
  return rows.join('\n') + '\n';
}

async function observeUsage(invocation, started) {
  const usage = { elapsedMs: Date.now() - started, modelTurns: 0, toolCalls: 0, toolCallsByName: {} };
  if (!invocation?.runDirectory) return usage;
  let steps = 0, sampled = 0, buffer = '', tokenKeys;
  const tokens = {};
  const stream = createReadStream(join(invocation.runDirectory, 'events.jsonl'), { encoding: 'utf8' });
  const observe = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line.replace(/^\uFEFF/u, ''));
      if (event.type === 'tool_call') { usage.toolCalls++; if (typeof event.tool === 'string') usage.toolCallsByName[event.tool] = (usage.toolCallsByName[event.tool] ?? 0) + 1; }
      if (event.type !== 'status') return;
      if (event.phase === 'step_start') usage.modelTurns++;
      if (event.phase !== 'step_end') return;
      steps++;
      if (Number.isSafeInteger(event.usage?.inputTokens) && Number.isSafeInteger(event.usage?.outputTokens)) {
        sampled++;
        const keys = new Set(Object.entries(event.usage).filter(([, value]) => Number.isSafeInteger(value) && value >= 0).map(([key]) => key));
        tokenKeys ??= new Set(keys);
        for (const key of tokenKeys) if (!keys.has(key)) tokenKeys.delete(key);
        for (const key of keys) tokens[key] = (tokens[key] ?? 0) + event.usage[key];
      }
  };
  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        observe(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      }
    }
    if (buffer.trim()) observe(buffer);
    if (steps > 0 && sampled === steps) usage.tokens = Object.fromEntries([...tokenKeys].map(key => [key, tokens[key]]));
    else if (invocation.usage?.tokens) usage.tokens = invocation.usage.tokens;
  } catch { /* Native runner remains authoritative; never invent an unreported token count. */ }
  finally { stream.destroy(); }
  return usage;
}

/** Uniform Worker facade around the existing owned-process/native-session adapter. */
export class DshExecutor {
  constructor({ command, dataHome, runsPath, model, provider, reasoningEffort, harness = {}, executorFactory }) {
    this.command = absolute(command); this.runsPath = absolute(runsPath);
    this.dataHome = dataHome === undefined ? undefined : absolute(dataHome);
    this.selection = dshModelSelection({ ...harness.modelSelection, ...(model ? { model } : {}), ...(provider ? { provider } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
    Object.assign(this, { harness, executorFactory }); this.active = new Set();
  }

  async run({ taskId, cwd, prompt, sessionId, skillPaths = [], mcpServers = [] }, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.closed) throw failure('DSH executor is closed.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(taskId ?? '') || typeof prompt !== 'string' || !prompt.trim()) throw failure('Invalid DSH execution request.');
    if (sessionId !== undefined && !nativeId(sessionId)) throw failure('Invalid native DSH session ID.');
    cwd = await realpath(absolute(cwd));
    if (!(await lstat(cwd)).isDirectory()) throw failure('DSH working directory is missing.');
    const taskRoot = join(this.runsPath, taskId), sessionMapPath = join(taskRoot, 'sessions.json'), logicalId = `teamplay:${taskId}`;
    const resources = await resourcePatch(skillPaths, mcpServers, cwd);
    await mkdir(taskRoot, { recursive: true, mode: 0o700 });
    const patches = [...(this.harness.extraPatches ?? [])].map(absolute);
    const resourcePath = join(taskRoot, `resources-${randomUUID()}.patch.yml`);
    await writeFile(resourcePath, resources, { flag: 'wx', mode: 0o600 }); patches.push(resourcePath);
    if (Object.keys(this.selection).length) {
      const patch = join(taskRoot, `model-${randomUUID()}.patch.yml`);
      await writeFile(patch, dshModelPatch(this.selection), { flag: 'wx', mode: 0o600 });
      patches.push(patch);
    }
    const env = triageModelEnvironment(this.harness.env ?? process.env);
    if (this.dataHome) env.DSH_HOME = this.dataHome;
    const options = { ...this.harness, cwd, cliPath: this.command, runsPath: join(taskRoot, 'native-runs'), sessionMapPath,
      auth: 'stored', permissionMode: 'workspace-write', runTimeoutMs: 0, classificationTimeoutMs: 0, env, extraPatches: patches };
    const executor = this.executorFactory ? this.executorFactory(options) : new InstalledHeadlessExecutor(options);
    this.active.add(executor);
    let closeJob, outcome, native, cause, stopped = false, launched = false;
    const started = Date.now();
    const close = () => { closeJob ??= executor.close(); closeJob.catch(() => {}); return closeJob; };
    signal?.addEventListener('abort', close, { once: true });
    try {
      await executor.start(); signal?.throwIfAborted();
      const mapped = Object.hasOwn(executor.map.sessions, logicalId) ? executor.map.sessions[logicalId].nativeSessionId : undefined;
      if (sessionId !== undefined ? mapped !== sessionId : mapped !== undefined) throw failure('DSH task already has another or unrequested native session; explicitly resume its exact ID.');
      const session = await executor.session(logicalId, sessionId !== undefined);
      signal?.throwIfAborted(); launched = true;
      outcome = await session.run([{ type: 'text', text: prompt }], { id: taskId });
      signal?.throwIfAborted();
      native = executor.lastInvocation;
      if (outcome?.finishReason !== 'completed' || typeof outcome.finalResponse !== 'string' || !outcome.finalResponse.trim()
        || !native?.completed || native.launcherExited !== true || native.nativeExitCode !== 0 || native.finalReason !== 'completed'
        || !nativeId(native.sessionId) || sessionId !== undefined && sessionId !== native.sessionId
        || executor.map.sessions[logicalId]?.nativeSessionId !== native.sessionId) throw failure('DSH native completion or exact session identity was not verified.');
    } catch (error) { cause = error; }
    finally {
      signal?.removeEventListener('abort', close);
      try { await close(); stopped = !launched || executor.lastInvocation?.processTreeStopped === true; this.active.delete(executor); }
      catch (error) { cause = error; }
    }
    native ??= executor.lastInvocation;
    const usage = await observeUsage(native, started);
    if (cause) {
      const error = failure(signal?.aborted ? 'DSH task was cancelled.' : cause.message, cause);
      if (signal?.aborted) error.kind = 'cancelled';
      error.processTreeStopped = stopped && (cause.processTreeStopped === true || native?.processTreeStopped === true || !launched);
      error.usage = usage; error.sessionId = native?.sessionId ?? executor.map?.sessions?.[logicalId]?.nativeSessionId;
      error.runDirectory = native?.runDirectory; throw error;
    }
    const result = { backend: 'dsh', sessionId: native.sessionId, text: outcome.finalResponse, completed: true, usage };
    await writeFile(join(taskRoot, `receipt-${Date.now()}-${randomUUID()}.json`), JSON.stringify({ ...result, cwd, logicalId, runDirectory: native.runDirectory, nativeExitCode: native.nativeExitCode }, null, 2), { flag: 'wx', mode: 0o600 });
    return result;
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.active].map(executor => executor.close()));
  }
}
