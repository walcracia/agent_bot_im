import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, lstat, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE',
  'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'OS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']);
const contained = (root, file) => { const rest = relative(root, file); return rest && !isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + sep); };
function absolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/u.test(value)) throw new Error(`${name} must be an explicit absolute path.`);
  return resolve(value);
}
export class HermesInvocationError extends Error {
  constructor(message, { kind = 'hermes-failed', sessionId, processTreeStopped = false, runDirectory, cause } = {}) {
    super(message, { cause }); this.name = 'HermesInvocationError'; Object.assign(this, { kind, sessionId, processTreeStopped, runDirectory });
  }
}
function childEnvironment(home) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowedEnvironment.has(name.toUpperCase()))),
    HERMES_HOME: home, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds).unref());
async function nativeSkills(home, paths, ids) {
  if (!paths.length && !ids.length) return [];
  const missing = () => new HermesInvocationError('Hermes skills must map to an existing SKILL.md inside this dataHome/skills; configure external skills explicitly before registering them.',
    { kind: 'hermes-skill-mapping-required', processTreeStopped: true });
  let root;
  try { root = await realpath(join(home, 'skills')); } catch { throw missing(); }
  const names = [];
  for (const input of [...paths.map(path => ({ path })), ...ids.map(id => ({ id }))]) {
    let candidate;
    if (input.path !== undefined) {
      if (typeof input.path !== 'string' || !isAbsolute(input.path) || /[\0\r\n]/u.test(input.path)) throw missing();
      candidate = input.path;
    } else {
      const id = input.id;
      if (typeof id !== 'string' || !id.trim() || isAbsolute(id) || /[:\\,\0\r\n]/u.test(id)
        || id.split('/').some(part => !part || part === '.' || part === '..')) throw missing();
      candidate = join(root, id, 'SKILL.md');
    }
    try {
      const path = await realpath(candidate);
      if (!contained(root, path) || basename(path).toLowerCase() !== 'skill.md' || !(await lstat(path)).isFile()) throw missing();
      names.push(relative(root, dirname(path)).split(sep).join('/'));
    } catch { throw missing(); }
  }
  return [...new Set(names)];
}
async function withinTaskEdit(cwd, toolCall) {
  if (toolCall?.kind !== 'edit') return false;
  const edits = (toolCall.content ?? []).filter(item => item?.type === 'diff');
  if (!edits.length) return false;
  for (const edit of edits) {
    if (typeof edit.path !== 'string' || /[\0\r\n]/u.test(edit.path)) return false;
    const path = resolve(cwd, edit.path);
    if (!contained(cwd, path)) return false;
    let at = cwd;
    for (const part of relative(cwd, path).split(sep)) {
      at = join(at, part);
      const info = await lstat(at).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info?.isSymbolicLink()) return false;
    }
  }
  return true;
}

/** Native Hermes ACP client, using this installation's stored provider setup.
 * Current Hermes delegates execution to its profile gateway. We own only the
 * ACP viewer process: killing it is never proof that an admitted Agent stopped.
 * Cancellation waits for the original session/prompt terminal response. No
 * analysis wall-clock/turn budget or implicit rerun is added here.
 */
export class HermesExecutor {
  constructor({ command, dataHome, runsPath, model, provider } = {}) {
    const commandParts = typeof command === 'string' ? [command] : command;
    if (!Array.isArray(commandParts) || !commandParts.length || commandParts.some(part => typeof part !== 'string' || /[\0\r\n]/u.test(part)))
      throw new Error('Hermes command must be an executable or an argv array.');
    this.command = absolute(commandParts[0], 'command'); this.args = commandParts.slice(1);
    this.dataHome = absolute(dataHome, 'dataHome'); this.runsPath = absolute(runsPath, 'runsPath');
    if (model !== undefined && (typeof model !== 'string' || !model.trim() || /[\0\r\n]/u.test(model))) throw new Error('Invalid Hermes model.');
    if (provider !== undefined && (typeof provider !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(provider))) throw new Error('Invalid Hermes provider.');
    if (provider && !model) throw new Error('A provider override requires an explicit model.');
    this.model = model; this.provider = provider; this.active = new Set(); this.closed = false;
  }
  async run({ taskId, cwd, prompt, sessionId, skillPaths = [], skillIds = [], mcpServers = [] } = {}, { signal } = {}) {
    if (this.closed) throw new Error('Hermes executor is closed.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(taskId ?? '') || typeof prompt !== 'string' || !prompt.trim()) throw new Error('Invalid Hermes task.');
    if (sessionId !== undefined && (!SESSION_ID.test(sessionId) || sessionId === 'latest')) throw new Error('Hermes resume needs an exact session ID.');
    if (!Array.isArray(skillPaths) || !Array.isArray(skillIds) || !Array.isArray(mcpServers)) throw new Error('Invalid Hermes capabilities.');
    let selectedSkills = await nativeSkills(this.dataHome, skillPaths, skillIds);
    const taskCwd = await realpath(absolute(cwd, 'cwd'));
    if (!(await lstat(taskCwd)).isDirectory() || !(await lstat(this.dataHome)).isDirectory()) throw new Error('Hermes task/home directories are missing.');
    const sessionsPath = join(this.runsPath, 'sessions'); await mkdir(sessionsPath, { recursive: true, mode: 0o700 });
    let sessionReceipt;
    if (sessionId) {
      sessionReceipt = JSON.parse(await readFile(join(sessionsPath, hash(sessionId) + '.json'), 'utf8'));
      if (sessionReceipt.sessionId !== sessionId || sessionReceipt.taskId !== taskId || sessionReceipt.cwd !== taskCwd
        || sessionReceipt.dataHome !== this.dataHome || sessionReceipt.command !== this.command
        || JSON.stringify(sessionReceipt.args ?? []) !== JSON.stringify(this.args)) throw new Error('Hermes session does not belong to this task/workspace.');
      if (selectedSkills.length && JSON.stringify(selectedSkills) !== JSON.stringify(sessionReceipt.skillIds ?? [])) throw new Error('Hermes resume cannot replace the native session skills.');
      selectedSkills = sessionReceipt.skillIds ?? [];
    }
    signal?.throwIfAborted();
    const runDirectory = join(this.runsPath, taskId + '-' + randomUUID()); await mkdir(runDirectory, { mode: 0o700 });
    const eventPath = join(runDirectory, 'protocol.jsonl'); await writeFile(eventPath, '', { flag: 'wx', mode: 0o600 });
    await writeFile(join(runDirectory, 'request.json'), JSON.stringify({ taskId, cwd: taskCwd, prompt, sessionId, skillPaths, skillIds, mcpServers }), { flag: 'wx', mode: 0o600 });
    const aborter = new AbortController(), handle = { aborter, done: null }; this.active.add(handle);
    const onExternalAbort = () => aborter.abort(signal.reason); signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (signal?.aborted) aborter.abort(signal.reason);
    handle.done = this.#invoke({ taskId, taskCwd, prompt, sessionId, sessionsPath, mcpServers, skillIds: selectedSkills, runDirectory, eventPath, signal: aborter.signal });
    try { return await handle.done; }
    finally { signal?.removeEventListener('abort', onExternalAbort); this.active.delete(handle); }
  }
  async #bootstrapSkills({ taskCwd, skillIds, runDirectory, signal }) {
    // ACP session/new has no skills field. The official CLI freezes --skills
    // into a new session; /version is a native control and invokes no model.
    // ACP then loads that exact session for execution and cancellation.
    const queryFile = join(runDirectory, 'skill-bootstrap-query.txt');
    await writeFile(queryFile, '/version\n', { flag: 'wx', mode: 0o600 });
    const args = [...this.args, 'chat', '--format', 'stream-json', '--query-file', queryFile, '--in', taskCwd, '--source', 'tool',
      ...skillIds.flatMap(id => ['--skills', id]), ...(this.model ? ['--model', this.model] : []), ...(this.provider ? ['--provider', this.provider] : [])];
    const log = join(runDirectory, 'skill-bootstrap.jsonl'); await writeFile(log, '', { flag: 'wx', mode: 0o600 });
    const child = spawn(this.command, args, { cwd: taskCwd, windowsHide: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment(this.dataHome) });
    let output = '', terminal, error;
    const abort = () => { error ??= signal.reason ?? new Error('Skill bootstrap was cancelled.'); child.kill(); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { error ??= new Error('Hermes skill bootstrap startup did not complete.'); child.kill(); }, 45000);
    timer.unref();
    const exited = new Promise(resolveExited => {
      child.on('error', cause => { error ??= cause; });
      child.on('close', code => resolveExited(code));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      output += text; let newline;
      while ((newline = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, newline).trim(); output = output.slice(newline + 1); if (!line) continue;
        appendFileSync(log, line + '\n');
        try { const value = JSON.parse(line); if (value.type === 'result') terminal = value; } catch { error ??= new Error('Hermes skill bootstrap returned invalid JSONL.'); }
      }
    });
    child.stderr.on('data', bytes => appendFileSync(join(runDirectory, 'skill-bootstrap.stderr.txt'), bytes, { mode: 0o600 }));
    if (signal.aborted) abort();
    const code = await exited; clearTimeout(timer); signal.removeEventListener('abort', abort);
    if (error) throw error;
    if (code !== 0 || terminal?.exit_code !== 0 || !SESSION_ID.test(terminal?.session_id ?? '')) throw new Error('Hermes did not create the native preloaded skill session.');
    await writeFile(join(runDirectory, 'skill-bootstrap-receipt.json'), JSON.stringify({ skillIds, sessionId: terminal.session_id,
      control: '/version', modelPromptsSent: 0, exitCode: code }), { flag: 'wx', mode: 0o600 });
    return terminal.session_id;
  }
  async #invoke({ taskId, taskCwd, prompt, sessionId, sessionsPath, mcpServers, skillIds, runDirectory, eventPath, signal }) {
    let child, nativeSession = sessionId, failure, promptStarted = false, terminalSeen = false, terminalReason, exitResult, cancellationSent = false;
    const started = Date.now(), pending = new Map(), toolIds = new Set(), messages = new Map();
    let nextId = 0, currentMessage = 0, currentToolBoundary = false, terminalUsage, lastMessage;
    const log = (direction, value) => appendFileSync(eventPath, JSON.stringify({ direction, value }) + '\n', { mode: 0o600 });
    const usage = () => ({ elapsedMs: Date.now() - started, toolCalls: toolIds.size,
      ...(terminalUsage?.inputTokens === undefined ? {} : { inputTokens: terminalUsage.inputTokens }),
      ...(terminalUsage?.outputTokens === undefined ? {} : { outputTokens: terminalUsage.outputTokens }),
      ...(terminalUsage?.totalTokens === undefined ? {} : { totalTokens: terminalUsage.totalTokens }) });
    const send = value => { log('send', value); child.stdin.write(JSON.stringify(value) + '\n'); };
    const cancel = () => {
      if (!promptStarted && signal.aborted) {
        for (const job of pending.values()) job.reject(signal.reason ?? new Error('Hermes startup was cancelled.'));
        pending.clear();
        return;
      }
      if (promptStarted && nativeSession && !terminalSeen && !cancellationSent) {
        cancellationSent = true; send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: nativeSession } });
      }
    };
    const request = (method, params, startup = false) => new Promise((resolveResult, reject) => {
      const id = ++nextId;
      const timer = startup ? setTimeout(() => { pending.delete(id); reject(new Error('Hermes protocol startup did not complete.')); }, 45000) : null;
      timer?.unref?.();
      pending.set(id, { resolve: value => { clearTimeout(timer); resolveResult(value); }, reject: cause => { clearTimeout(timer); reject(cause); } });
      send({ jsonrpc: '2.0', id, method, params });
    });
    const clientRequest = async value => {
      if (value.method === 'session/request_permission') {
        const params = value.params ?? {}, allow = params.sessionId === nativeSession
          && params.options?.some(item => item.optionId === 'allow_once') && await withinTaskEdit(taskCwd, params.toolCall);
        send({ jsonrpc: '2.0', id: value.id, result: { outcome: allow ? { outcome: 'selected', optionId: 'allow_once' } : { outcome: 'cancelled' } } });
      } else send({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Client capability is not supported.' } });
    };
    const receive = value => {
      log('receive', value);
      if (value.method && Object.hasOwn(value, 'id')) { clientRequest(value).catch(cause => { failure ??= cause; cancel(); }); return; }
      if (Object.hasOwn(value, 'id')) {
        const job = pending.get(value.id); if (!job) return; pending.delete(value.id);
        if (value.error) job.reject(Object.assign(new Error('Hermes rejected a native protocol request.'), { nativeCode: value.error.code }));
        else job.resolve(value.result);
        return;
      }
      if (value.method !== 'session/update' || !promptStarted || value.params?.sessionId !== nativeSession) return;
      const update = value.params.update;
      if (update?.sessionUpdate === 'tool_call') { toolIds.add(update.toolCallId); currentToolBoundary = true; }
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
        const messageId = update.messageId ?? update.message_id;
        if (!messageId && currentToolBoundary) currentMessage++;
        currentToolBoundary = false;
        const key = messageId ?? 'unlabelled-' + currentMessage;
        messages.set(key, (messages.get(key) ?? '') + update.content.text);
        lastMessage = key;
      }
    };
    try {
      signal.throwIfAborted();
      if (!sessionId && skillIds.length) {
        nativeSession = await this.#bootstrapSkills({ taskCwd, skillIds, runDirectory, signal });
        await writeFile(join(sessionsPath, hash(nativeSession) + '.json'), JSON.stringify({ sessionId: nativeSession, taskId, cwd: taskCwd,
          dataHome: this.dataHome, command: this.command, args: this.args, skillIds }), { flag: 'wx', mode: 0o600 });
        sessionId = nativeSession;
      }
      signal.throwIfAborted();
      child = spawn(this.command, [...this.args, 'acp'], { cwd: taskCwd, windowsHide: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment(this.dataHome) });
      let output = '';
      const exited = new Promise(resolveExited => {
        child.on('error', cause => { failure ??= cause; });
        child.on('close', (code, exitSignal) => {
          exitResult = { code, signal: exitSignal }; resolveExited(exitResult);
          for (const job of pending.values()) job.reject(new Error('Hermes viewer exited before the protocol response.'));
          pending.clear();
        });
      });
      child.stdin.on('error', cause => { failure ??= cause; });
      child.stderr.on('data', bytes => log('stderr', bytes.toString('utf8')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', text => {
        output += text;
        let newline;
        while ((newline = output.indexOf('\n')) !== -1) {
          const line = output.slice(0, newline).trim(); output = output.slice(newline + 1); if (!line) continue;
          try { receive(JSON.parse(line)); } catch (cause) { failure ??= cause; cancel(); }
        }
      });
      signal.addEventListener('abort', cancel, { once: true });
      const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'teamplay', version: '0.5.0' } }, true);
      if (init?.protocolVersion !== 1) throw new Error('Unsupported Hermes ACP protocol.');
      signal.throwIfAborted();
      if (sessionId) {
        if (!init.agentCapabilities?.loadSession) throw new Error('This Hermes does not support native session load.');
        const loaded = await request('session/load', { cwd: taskCwd, sessionId, mcpServers }, true);
        if (!loaded || loaded.sessionId !== undefined && loaded.sessionId !== sessionId) throw new Error('Hermes did not load the exact native session.');
      } else {
        const created = await request('session/new', { cwd: taskCwd, mcpServers }, true);
        nativeSession = created?.sessionId;
        if (!SESSION_ID.test(nativeSession ?? '')) throw new Error('Hermes did not return a native session ID.');
        await writeFile(join(sessionsPath, hash(nativeSession) + '.json'), JSON.stringify({ sessionId: nativeSession, taskId, cwd: taskCwd,
          dataHome: this.dataHome, command: this.command, args: this.args, skillIds }), { flag: 'wx', mode: 0o600 });
      }
      if (this.model) await request('session/set_model', { sessionId: nativeSession, modelId: this.provider ? this.provider + ':' + this.model : this.model }, true);
      signal.throwIfAborted();
      {
        // Hermes handles /title through its native rename mutation, before the
        // model admission path. Keep the real acp/tool provenance: Desktop's
        // All/Automation history lists it even though Recents filters it out.
        const title = `同频 · ${taskId}`;
        const renamed = await request('session/prompt', { sessionId: nativeSession, prompt: [{ type: 'text', text: `/title ${title}` }] }, true);
        if (renamed?.stopReason !== 'end_turn') throw new Error('Hermes did not complete the native session title command.');
        await writeFile(join(runDirectory, 'session-title.json'), JSON.stringify({ sessionId: nativeSession, title, control: '/title', modelPromptsSent: 0 }), { flag: 'wx', mode: 0o600 });
      }
      signal.throwIfAborted();
      promptStarted = true;
      const terminal = await request('session/prompt', { sessionId: nativeSession, prompt: [{ type: 'text', text: prompt }] });
      terminalSeen = true; terminalReason = terminal?.stopReason; terminalUsage = terminal?.usage;
      if (signal.aborted || terminalReason === 'cancelled') throw new HermesInvocationError('Hermes task was cancelled.', { kind: 'cancelled' });
      if (terminalReason !== 'end_turn') throw new Error('Hermes did not complete its native prompt.');
      if (failure) throw failure;
      const text = messages.get(lastMessage)?.trim();
      if (!text || currentToolBoundary) throw new Error('Hermes completed without final assistant text.');
      child.stdin.end();
      await Promise.race([exited, delay(5000)]);
      if (!exitResult) { child.kill(); await exited; }
      if (exitResult.code !== 0) throw new Error('Hermes viewer did not exit normally.');
      const result = { backend: 'hermes', sessionId: nativeSession, text, completed: true, usage: usage() };
      await writeFile(join(runDirectory, 'result.json'), JSON.stringify({ ...result, nativeTerminal: terminalReason, viewerExit: exitResult }), { flag: 'wx', mode: 0o600 });
      return result;
    } catch (cause) {
      failure = cause;
      cancel();
      const error = cause instanceof HermesInvocationError ? cause : new HermesInvocationError('Hermes execution did not complete; native records were retained.', {
        kind: signal.aborted ? 'cancelled' : 'hermes-failed', cause });
      error.sessionId = nativeSession; error.processTreeStopped = !promptStarted || terminalSeen; error.runDirectory = runDirectory; error.usage = usage();
      await writeFile(join(runDirectory, 'failure.json'), JSON.stringify({ kind: error.kind, sessionId: nativeSession, promptStarted,
        nativeTerminal: terminalReason, nativeTerminalSeen: terminalSeen, processTreeStopped: error.processTreeStopped, usage: error.usage }), { flag: 'wx', mode: 0o600 });
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (child && !exitResult) {
        child.stdin.end();
        const done = new Promise(resolveExited => child.once('close', resolveExited));
        await Promise.race([done, delay(1500)]);
        if (!exitResult) { child.kill(); await done; }
      }
    }
  }
  async close() {
    this.closed = true;
    const active = [...this.active]; for (const item of active) item.aborter.abort(new Error('Hermes executor is closing.'));
    await Promise.allSettled(active.map(item => item.done));
  }
}
