import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { triageModelEnvironment } from './triage-model.mjs';

const inside = (root, path) => { const part = relative(root, path); return part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const absolute = value => {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/u.test(value)) throw new Error('Pi paths must be explicit absolute paths.');
  return resolve(value);
};
const idle = state => state?.isStreaming === false && state?.isCompacting !== true && (state?.pendingMessageCount ?? 0) === 0;
const failure = (message, kind = 'pi-execution-failed', stopped = false) => Object.assign(new Error(message), { kind, processTreeStopped: stopped });
const elapsed = (promise, milliseconds, message) => {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(failure(message)), milliseconds); })]).finally(() => clearTimeout(timer));
};
const tokenDifference = (before, after) => Object.fromEntries(Object.entries({ inputTokens: 'input', outputTokens: 'output', cacheReadTokens: 'cacheRead', cacheWriteTokens: 'cacheWrite', totalTokens: 'total' })
  .filter(([, source]) => Number.isFinite(after?.tokens?.[source]) && after.tokens[source] >= (before?.tokens?.[source] ?? 0))
  .map(([key, source]) => [key, after.tokens[source] - (before?.tokens?.[source] ?? 0)]));

/** Pi Desktop scans dataHome/sessions/<directory>/*.jsonl, including directory
 * links. Register the original task directory, never a copied transcript or a
 * second session. The task-owned file and resume mapping stay authoritative. */
export async function registerPiSessionDirectory({ dataHome, nativeRoot, taskId }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(taskId ?? '')) throw failure('Invalid Pi task ID for session registration.');
  nativeRoot = await realpath(absolute(nativeRoot));
  if (!(await lstat(nativeRoot)).isDirectory()) throw failure('Pi native session directory is missing.');
  const catalog = join(absolute(dataHome), 'sessions');
  await mkdir(catalog, { recursive: true, mode: 0o700 });
  const catalogInfo = await lstat(catalog);
  if (!catalogInfo.isDirectory() || catalogInfo.isSymbolicLink()) throw failure('Pi session catalog must be a regular directory.');
  const fingerprint = createHash('sha256').update(process.platform === 'win32' ? nativeRoot.toLowerCase() : nativeRoot).digest('hex').slice(0, 16);
  const directory = join(catalog, `--TeamPlay-${taskId}-${fingerprint}--`);
  try { await symlink(nativeRoot, directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
  if (!(await lstat(directory)).isSymbolicLink() || !samePath(await realpath(directory), nativeRoot))
    throw failure('Pi session registration conflicts with an existing directory.');
  return directory;
}

/** A task owns this RPC child and exact native session; no Desktop/private HTTP API. */
export class PiExecutor {
  constructor({ command, dataHome, runsPath, model, provider, spawn: spawnProcess = spawn }) {
    this.command = absolute(command); this.dataHome = absolute(dataHome); this.runsPath = absolute(runsPath);
    if (provider !== undefined && !/^[A-Za-z0-9_.-]+$/u.test(provider) || model !== undefined && (typeof model !== 'string' || !model || /[\0\r\n]/u.test(model))) throw new Error('Invalid trusted Pi model selection.');
    if (provider && !model) throw new Error('Pi provider requires a model.');
    Object.assign(this, { model, provider, spawnProcess }); this.active = new Map();
  }

  async run({ taskId, cwd, prompt, sessionId, skillPaths = [], mcpServers }, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.closed) throw failure('Pi executor is closed.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(taskId ?? '') || typeof prompt !== 'string' || !prompt.trim()
      || !Array.isArray(skillPaths)) throw failure('Invalid Pi execution request.');
    cwd = await realpath(absolute(cwd));
    if (!(await lstat(cwd)).isDirectory()) throw failure('Pi working directory is missing.');
    const taskRoot = join(this.runsPath, taskId), nativeRoot = join(taskRoot, 'sessions');
    await mkdir(nativeRoot, { recursive: true, mode: 0o700 });
    const restoring = sessionId !== undefined;
    sessionId ??= randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(sessionId)) throw failure('Invalid Pi session ID.');
    const mapPath = join(taskRoot, `session-${sessionId}.json`);
    let nativeFile;
    if (restoring) {
      const map = JSON.parse(await readFile(mapPath, 'utf8'));
      if (map.taskId !== taskId || map.sessionId !== sessionId || !samePath(map.cwd, cwd) || !inside(nativeRoot, absolute(map.sessionFile))) throw failure('Pi session mapping belongs to another task or directory.');
      nativeFile = await realpath(map.sessionFile);
      if (!inside(await realpath(nativeRoot), nativeFile) || !(await lstat(nativeFile)).isFile()) throw failure('Pi session file is missing.');
      const header = JSON.parse((await readFile(nativeFile, 'utf8')).split('\n')[0]);
      if (header.type !== 'session' || header.id !== sessionId || !samePath(await realpath(header.cwd), cwd)) throw failure('Pi native session identity changed.');
    }
    await registerPiSessionDirectory({ dataHome: this.dataHome, nativeRoot, taskId });
    for (const path of skillPaths) if (!(await lstat(absolute(path))).isFile() && !(await lstat(path)).isDirectory()) throw failure('Pi skill path is missing.');
    const cleanupMcp = await this.prepareMcp(cwd, mcpServers);
    const args = ['--offline', '--mode', 'rpc', '--session-dir', nativeRoot, '--name', `同频 · ${taskId}`, '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates'];
    args.push(...(restoring ? ['--session', nativeFile] : ['--session-id', sessionId]));
    args.push(...(mcpServers ? ['-e', 'builtin:mcp', '--approve'] : ['--no-mcp', '--no-approve']));
    for (const path of skillPaths) args.push('--skill', absolute(path));
    if (this.model) args.push('--model', this.model);
    if (this.provider) args.push('--provider', this.provider);
    const env = { ...triageModelEnvironment(), PI_CODING_AGENT_DIR: this.dataHome, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
    const started = Date.now();
    const eventsPath = join(taskRoot, `events-${Date.now()}-${randomUUID()}.jsonl`);
    let logQueue = Promise.resolve();
    let child;
    try { child = this.spawnProcess(this.command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (cause) { await cleanupMcp(); throw failure('Pi process did not start.'); }
    let buffer = '', sequence = 0, lastAssistant, nativeState, settled = false, cancelled = false, stopped = false, toolCalls = 0, modelTurns = 0, exitStatus;
    const pending = new Map();
    let settleResolve, settleReject, exitResolve;
    const settledEvent = new Promise((resolveEvent, reject) => { settleResolve = resolveEvent; settleReject = reject; });
    settledEvent.catch(() => {});
    const exited = new Promise(resolveExit => { exitResolve = resolveExit; });
    const rejectAll = cause => { for (const item of pending.values()) item.reject(cause); pending.clear(); settleReject(cause); };
    child.once('error', () => rejectAll(failure('Pi process could not be started.')));
    child.once('close', (code, nativeSignal) => { exitStatus = { code, signal: nativeSignal }; exitResolve(exitStatus); rejectAll(failure('Pi process exited before its RPC operation finished.')); });
    child.stdin.on('error', () => rejectAll(failure('Pi RPC input closed.')));
    child.stderr.on('data', () => {}); // Diagnostics may contain private file contents or credentials.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/u, ''); buffer = buffer.slice(index + 1);
        if (!line) continue;
        logQueue = logQueue.then(() => appendFile(eventsPath, line + '\n', { mode: 0o600 }));
        logQueue.catch(() => {});
        let event;
        try { event = JSON.parse(line); } catch { rejectAll(failure('Pi emitted invalid RPC JSON.')); child.stdin.end(); return; }
        if (event.type === 'response') {
          const item = pending.get(event.id); if (!item) continue;
          pending.delete(event.id);
          event.success ? item.resolve(event.data) : item.reject(failure(`Pi RPC ${item.type} failed.`));
        } else if (event.type === 'message_start' && event.message?.role === 'assistant') modelTurns++;
        else if (event.type === 'message_end' && event.message?.role === 'assistant') lastAssistant = event.message;
        else if (event.type === 'tool_execution_start') toolCalls++;
        else if (event.type === 'agent_settled') { settled = true; cancelled = event.aborted === true; settleResolve(event); }
      }
    });
    const request = (type, values = {}) => new Promise((resolveRequest, reject) => {
      if (exitStatus || child.stdin.destroyed || child.stdin.writableEnded) { reject(failure('Pi RPC process is no longer writable.')); return; }
      const id = `pi-${++sequence}`;
      pending.set(id, { resolve: resolveRequest, reject, type });
      child.stdin.write(JSON.stringify({ id, type, ...values }) + '\n', error => { if (error) { pending.delete(id); reject(failure('Pi RPC input closed.')); } });
    });
    let cancelJob;
    const cancel = () => {
      cancelJob ??= (async () => {
        await request('clear_queue'); await request('abort');
        const state = await request('get_state');
        if (!idle(state) || state.sessionId !== sessionId) throw failure('Pi cancellation did not confirm the owned session was idle.');
        child.stdin.end();
        const exit = await elapsed(exited, 30000, 'Pi did not exit after cancellation.');
        stopped = exit.code === 0;
        if (!stopped) throw failure('Pi cancellation exit was not clean.');
      })();
      cancelJob.catch(() => {});
      return cancelJob;
    };
    this.active.set(child, cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      nativeState = await elapsed(request('get_state'), 30000, 'Pi RPC startup was not ready.');
      if (!idle(nativeState) || nativeState.sessionId !== sessionId || !isAbsolute(nativeState.sessionFile ?? '') || !inside(nativeRoot, nativeState.sessionFile)
        || restoring && !samePath(nativeState.sessionFile, nativeFile)) throw failure('Pi returned another native session.');
      nativeFile = nativeState.sessionFile;
      const mapping = { taskId, cwd, sessionId, sessionFile: nativeFile };
      if (!restoring) await writeFile(mapPath, JSON.stringify(mapping, null, 2), { flag: 'wx', mode: 0o600 });
      const before = await request('get_session_stats');
      signal?.throwIfAborted();
      const accepted = await request('prompt', { message: prompt });
      if (!['started', 'queued'].includes(accepted?.disposition)) throw failure('Pi did not start an Agent run for this prompt.');
      await settledEvent;
      if (signal?.aborted || cancelled) throw failure('Pi task was cancelled.', 'cancelled');
      if (!settled || lastAssistant?.stopReason !== 'stop') throw failure('Pi did not finish with a successful final assistant message.');
      const text = (lastAssistant.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
      if (!text.trim()) throw failure('Pi final assistant text is empty.');
      nativeState = await request('get_state');
      if (!idle(nativeState) || nativeState.sessionId !== sessionId) throw failure('Pi completion did not confirm the owned session was idle.');
      const after = await request('get_session_stats');
      child.stdin.end();
      const exit = await elapsed(exited, 30000, 'Pi did not exit after completion.');
      if (exit.code !== 0) throw failure('Pi native process did not exit successfully.');
      stopped = true;
      await logQueue;
      const usage = { elapsedMs: Date.now() - started, modelTurns, toolCalls, tokens: tokenDifference(before, after) };
      const result = { backend: 'pi', sessionId, text, completed: true, usage };
      await writeFile(join(taskRoot, `receipt-${Date.now()}-${randomUUID()}.json`), JSON.stringify({ ...result, cwd, sessionFile: nativeFile, nativeExitCode: exit.code, agentSettled: true }, null, 2), { mode: 0o600 });
      return result;
    } catch (cause) {
      if (!stopped && !exitStatus) { try { await elapsed(cancel(), 35000, 'Pi stop could not be confirmed.'); } catch { /* Keep process identity and native session for inspection. */ } }
      const error = failure(signal?.aborted ? 'Pi task was cancelled.' : cause.message, signal?.aborted ? 'cancelled' : cause.kind, stopped);
      error.sessionId = sessionId; error.processId = child.pid; error.eventsPath = eventsPath;
      error.usage = { elapsedMs: Date.now() - started, modelTurns, toolCalls }; throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (stopped) this.active.delete(child);
      await logQueue.catch(() => {});
      if (stopped || exitStatus) await cleanupMcp();
    }
  }

  async prepareMcp(cwd, servers) {
    if (servers === undefined) return async () => {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers) || Object.entries(servers).some(([name, value]) => !/^[A-Za-z0-9_-]+$/u.test(name)
      || !value || typeof value !== 'object' || Array.isArray(value) || !(typeof value.command === 'string' || typeof value.url === 'string'))) throw failure('Invalid trusted Pi MCP configuration.');
    // Pi defaults to codemode exposure. This task disables unrelated extensions,
    // so its small, explicitly selected MCP set must be declared directly.
    if (Object.values(servers).some(server => server.exposure !== undefined && server.exposure !== 'direct'
      || server.toolExposure && Object.values(server.toolExposure).some(exposure => exposure !== 'direct')))
      throw failure('This Pi Worker adapter supports only direct MCP tool exposure.');
    servers = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, { ...server, exposure: server.exposure ?? 'direct' }]));
    const directory = join(cwd, '.pi'), file = join(directory, 'mcp.json');
    const local = await lstat(directory).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
    if (local && (!local.isDirectory() || local.isSymbolicLink())) throw failure('Pi MCP directory must be a regular directory.');
    const user = JSON.parse(await readFile(join(this.dataHome, 'mcp.json'), 'utf8').catch(cause => { if (cause.code === 'ENOENT') return '{}'; throw cause; }));
    const disabled = Object.fromEntries(Object.keys(user.mcpServers ?? {}).map(name => [name, { enabled: false }]));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ mcpServers: { ...disabled, ...servers } }, null, 2), { flag: 'wx', mode: 0o600 });
    return async () => { await unlink(file); };
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.active.values()].map(cancel => cancel()));
  }
}
