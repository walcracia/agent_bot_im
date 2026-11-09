import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { TaskWorkerPool, validTaskId } from './super-worker.mjs';
import { replaceOwnedFile } from './file-replace.mjs';
import { GitDelivery } from './super-github.mjs';

const exec = promisify(execFile);
const equal = (a, b) => { const aa = Buffer.from(String(a)), bb = Buffer.from(String(b)); return aa.length === bb.length && timingSafeEqual(aa, bb); };
export function taskToolToken(secret, taskId) { return createHmac('sha256', secret).update('team-relay-tools:' + taskId).digest('hex'); }
function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
async function body(request) {
  let count = 0; const chunks = [];
  for await (const chunk of request) { count += chunk.length; if (count > 1500000) throw error('Request too large.', 413); chunks.push(chunk); }
  try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!data || Array.isArray(data) || typeof data !== 'object') throw 0; return data; }
  catch { throw error('Expected JSON object.'); }
}
async function containedFile(workspace, name, writing = false) {
  if (typeof name !== 'string' || !name || name.length > 1000 || isAbsolute(name) || /[\0\r\n]/.test(name)) throw error('Expected a project-relative path.');
  const pieces = name.replaceAll('\\', '/').split('/');
  if (pieces.some(part => part === '..' || part.toLowerCase() === '.git' || part.toLowerCase() === '.env' || part.toLowerCase().startsWith('.env.')) || name.includes(':')) throw error('Forbidden project path.');
  const path = resolve(workspace, name);
  const within = target => { const rel = relative(workspace, target); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); };
  if (!within(path)) throw error('Path escaped task workspace.');
  if (path === workspace && !writing) return path;
  const parent = await realpath(dirname(path));
  if (!within(parent)) throw error('Parent link escaped task workspace.');
  try { if (!within(await realpath(path))) throw error('Link escaped task workspace.'); }
  catch (cause) { if (cause.code !== 'ENOENT' || !writing) throw cause; }
  return path;
}

/** One preconfigured BYOM project. Never accepts project/CLI/auth overrides from callers. */
export function createTaskDaemon(options) {
  const secret = options.token ?? process.env[options.tokenEnv ?? 'SUPER_AGENT_DAEMON_TOKEN'];
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Daemon token must contain at least 32 characters.');
  const pool = options.pool ?? new TaskWorkerPool({ ...options, refreshBase: options.refreshBase ?? Boolean(options.github?.enabled),
    baseBranch: options.github?.base ?? 'main', versioning: options.github?.versioning });
  const delivery = options.github?.enabled ? new GitDelivery(options.github) : null;
  const jobs = new Map();
  const toolQueue = new Map();
  const counts = new Map();
  const stoppedTasks = new Set();
  const activations = new Map();
  const jobPath = (taskId, attempt) => join(resolve(options.runsPath), 'tasks', taskId, `remote-job-${attempt}.json`);
  const saveJob = async (taskId, attempt, job) => {
    const path = jobPath(taskId, attempt), temporary = path + '.' + randomUUID() + '.tmp';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(job), { flag: 'wx', mode: 0o600, flush: true });
    await replaceOwnedFile(temporary, path);
  };
  const readJob = async (taskId, attempt) => {
    try {
      const stored = JSON.parse(await readFile(jobPath(taskId, attempt), 'utf8'));
      if (stored.status === 'running') return { status: 'failed', error: { kind: 'interrupted', processTreeStopped: false, message: 'Daemon restarted during a worker attempt; inspect the original process before explicitly resuming.' } };
      return stored;
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; return null; }
  };
  const commandsRunning = new Map();
  const commandRecordPath = taskId => join(resolve(options.runsPath), 'tasks', taskId, 'tool-command.json');
  const commandRecord = async taskId => {
    try { return JSON.parse(await readFile(commandRecordPath(taskId), 'utf8')); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; return null; }
  };
  const saveCommand = async (taskId, record) => {
    const path = commandRecordPath(taskId), temporary = path + '.' + randomUUID() + '.tmp';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600, flush: true });
    await replaceOwnedFile(temporary, path);
  };
  const assertCommandsSettled = async taskId => {
    const prior = await commandRecord(taskId);
    if (prior && ['prepared', 'running', 'termination-failed'].includes(prior.status)) throw error('Previous environment command is not confirmed stopped; inspect it locally before resuming.', 409);
  };
  const stopCommand = async taskId => {
    const running = commandsRunning.get(taskId);
    if (!running) { await assertCommandsSettled(taskId); return; }
    if (running.child.exitCode !== null || running.child.signalCode !== null) { await running.closed; return; }
    if (process.platform === 'win32') {
      await exec('taskkill.exe', ['/PID', String(running.child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } else process.kill(-running.child.pid, 'SIGKILL');
    await running.closed;
    await saveCommand(taskId, { status: 'stopped', processTreeStopped: true, at: new Date().toISOString() });
  };
  const maxWorkers = options.maxWorkers ?? 4;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const send = (status, data) => { response.writeHead(status); response.end(JSON.stringify(data)); };
    try {
      if (request.method !== 'POST') throw error('POST required.', 405);
      const address = new URL(request.url, 'http://local');
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const data = await body(request);
      const taskId = data.taskId ?? data.task?.id;
      if (!validTaskId(taskId)) throw error('Invalid task ID.');
      if (data.attempt !== undefined && (!Number.isSafeInteger(data.attempt) || data.attempt < 0)) throw error('Invalid attempt.');
      const control = equal(token, secret);
      if (!control && (!address.pathname.startsWith('/tools/') || !equal(token, taskToolToken(secret, taskId)))) throw error('Unauthorized.', 401);
      if (address.pathname === '/prepare' || address.pathname === '/tools/prepare') {
        if (!control) throw error('Control credential required.', 403);
        const metadata = await pool.prepare({ id: taskId, speculative: data.speculative === true });
        return send(200, { ...metadata, toolToken: taskToolToken(secret, taskId) });
      }
      if (address.pathname === '/activate') {
        if (!control) throw error('Control credential required.', 403);
        const attempt = data.attempt ?? 0;
        if (!Number.isSafeInteger(attempt) || attempt < 0) throw error('Invalid attempt.');
        const record = pool.records.get(taskId);
        if (!record || record.running) throw error('Environment unavailable.', 409);
        await assertCommandsSettled(taskId);
        const last = activations.get(taskId);
        if (last !== undefined && attempt <= last && stoppedTasks.has(taskId)) throw error('Stopped attempt cannot be reactivated.', 409);
        activations.set(taskId, attempt); stoppedTasks.delete(taskId);
        record.status = 'ready'; await pool.persist(record);
        return send(200, { active: true });
      }
      if (address.pathname === '/start') {
        if (!control) throw error('Control credential required.', 403);
        const task = { id: taskId, summary: data.task.summary, instructions: data.task.instructions, inputs: data.task.inputs,
          context: data.task.context, attempt: data.task.attempt, event: data.task.event, reference: data.task.reference, speculative: data.task.speculative === true };
        if (!Number.isSafeInteger(task.attempt ?? 0) || (task.attempt ?? 0) < 0) throw error('Invalid attempt.');
        // Authenticated duplicate requests never launch another turn, even after a lost response.
        const key = taskId + ':' + String(task.attempt ?? 0);
        const stored = jobs.has(key) ? null : await readJob(taskId, task.attempt ?? 0);
        if (stored) jobs.set(key, stored);
        if (!jobs.has(key)) {
          if (commandsRunning.has(taskId)) throw error('A previous environment command is not confirmed stopped.', 409);
          await assertCommandsSettled(taskId);
          if ([...jobs.values()].filter(job => job.status === 'running').length >= maxWorkers) throw error('Worker limit reached.', 409);
          const job = { status: 'running', progress: null };
          jobs.set(key, job); stoppedTasks.delete(taskId);
          try {
            await saveJob(taskId, task.attempt ?? 0, job);
            const handle = await pool.start(task, { onProgress: progress => { job.progress = progress; } });
            handle.completion.then(result => Object.assign(job, { status: 'completed', result }), cause => Object.assign(job, {
              status: 'failed', error: { message: String(cause.message).slice(0, 600), kind: cause.kind, processTreeStopped: cause.processTreeStopped },
            })).then(() => saveJob(taskId, task.attempt ?? 0, job)).catch(() => {});
          } catch (cause) { Object.assign(job, { status: 'failed', error: { message: cause.message } }); throw cause; }
        }
        return send(202, { taskId, attempt: task.attempt ?? 0 });
      }
      if (address.pathname === '/inspect') {
        const job = jobs.get(taskId + ':' + String(data.attempt ?? 0)) ?? await readJob(taskId, data.attempt ?? 0);
        return send(200, { job: job ?? null, worker: await pool.inspect(taskId) });
      }
      if (address.pathname === '/input') return send(200, await pool.input(taskId, data.input));
      if (address.pathname === '/cancel') { stoppedTasks.add(taskId); await stopCommand(taskId); return send(200, await pool.cancel(taskId, 'remote-user')); }
      if (address.pathname === '/delivery') {
        if (!control || !options.github) throw error('Git delivery is not configured.', 403);
        const metadata = await pool.inspect(taskId);
        if (!metadata || metadata.running) throw error('Task is missing or still running.', 409);
        return send(200, await delivery.deliver({ id: taskId, workspace: metadata.workspace, branch: metadata.branch,
            speculative: data.task?.speculative === true, resumeClosedPr: data.task?.resumeClosedPr === true, baseCommit: metadata.baseCommit,
          summary: data.task?.summary, instructions: data.task?.instructions, result: data.task?.result,
          assertActive: async () => { if (stoppedTasks.has(taskId) || pool.records.get(taskId)?.status === 'cancelled') throw error('Task was stopped.', 409); } }));
      }
      if (!address.pathname.startsWith('/tools/')) throw error('Unknown endpoint.', 404);
      let metadata = await pool.inspect(taskId);
      if (!metadata) {
        // A tool request after daemon restart may restore only an already-recorded task, never create one.
        try { await stat(join(resolve(options.runsPath), 'tasks', taskId, 'task.json')); } catch { throw error('Unknown task.', 404); }
        await pool.prepare({ id: taskId }); metadata = await pool.inspect(taskId);
      }
      const workspace = metadata.workspace;
      if (stoppedTasks.has(taskId) || metadata.status === 'cancelled') throw error('Task was stopped.', 409);
      if (address.pathname === '/tools/read') {
        const path = await containedFile(workspace, data.path);
        const info = await stat(path);
        if (info.isDirectory()) return send(200, { entries: (await readdir(path)).slice(0, 1000) });
        const offset = data.offset ?? 0, limit = Math.min(data.limit ?? 60000, 100000);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw error('Invalid read window.');
        const handle = await open(path, 'r');
        try { const buffer = Buffer.alloc(Math.min(limit, Math.max(0, info.size - offset))); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); return send(200, { text: buffer.subarray(0, bytesRead).toString('utf8'), size: info.size,
          ...(offset === 0 && bytesRead === info.size ? { sha256: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex') } : {}),
          nextOffset: offset + bytesRead < info.size ? offset + bytesRead : null }); }
        finally { await handle.close(); }
      }
      if (address.pathname === '/tools/write') {
        await assertCommandsSettled(taskId);
        if (typeof data.text !== 'string' || Buffer.byteLength(data.text) > 1000000) throw error('Invalid file content.');
        const path = await containedFile(workspace, data.path, true);
        const operation = async () => {
          if (data.expectedSha256 !== undefined) {
            let current = null;
            try { current = createHash('sha256').update(await readFile(path)).digest('hex'); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
            if (current !== data.expectedSha256) throw error('File changed; read it again.', 409);
          }
          const temporary = path + '.super-' + randomUUID() + '.tmp';
          await writeFile(temporary, data.text, { flag: 'wx', mode: 0o600, flush: true });
          await rename(temporary, path);
          return { sha256: createHash('sha256').update(data.text).digest('hex') };
        };
        const next = (toolQueue.get(path) ?? Promise.resolve()).catch(() => {}).then(operation);
        toolQueue.set(path, next);
        next.finally(() => { if (toolQueue.get(path) === next) toolQueue.delete(path); }).catch(() => {});
        return send(200, await next);
      }
      if (address.pathname === '/tools/exec') {
        const command = options.commands?.[data.command];
        if (!command || typeof command.file !== 'string') throw error('Command is not configured.', 403);
        if ((counts.get(taskId) ?? 0) >= 1) throw error('A task command is still running.', 409);
        if (!Array.isArray(data.args ?? []) || data.args?.some(arg => typeof arg !== 'string' || arg.length > 1000 || /[\0\r\n]/.test(arg)) || (data.args?.length ?? 0) > 40) throw error('Invalid command arguments.');
        if (command.allowArgs !== true && data.args?.length) throw error('Additional command arguments are disabled.', 403);
        counts.set(taskId, 1);
        try {
          await assertCommandsSettled(taskId);
          await saveCommand(taskId, { status: 'prepared', command: data.command, at: new Date().toISOString() });
          const pending = exec(command.file, [...command.args ?? [], ...data.args ?? []], { cwd: workspace, shell: false, windowsHide: true, detached: process.platform !== 'win32',
            timeout: 0, maxBuffer: 256000, env: command.env ?? {} });
          pending.catch(() => {}); // A ledger-write failure must not leave an unobserved rejection.
          const closed = new Promise(resolveClose => pending.child.once('close', resolveClose));
          commandsRunning.set(taskId, { child: pending.child, closed });
          let stopFailed;
          let executionResult;
          const terminationFailure = new Promise((_, reject) => { stopFailed = reject; });
          const timer = setTimeout(() => { stopCommand(taskId).catch(stopFailed); }, Math.min(command.timeoutMs ?? 120000, 300000));
          try {
            await saveCommand(taskId, { status: 'running', command: data.command, pid: pending.child.pid, at: new Date().toISOString() });
            const result = await Promise.race([pending, terminationFailure]); executionResult = { code: 0, stdout: result.stdout, stderr: result.stderr };
          } finally {
            clearTimeout(timer);
            const exited = pending.child.exitCode !== null || pending.child.signalCode !== null || !pending.child.pid;
            if (exited) { commandsRunning.delete(taskId); await saveCommand(taskId, { status: 'finished', at: new Date().toISOString() }); }
            else await saveCommand(taskId, { status: 'termination-failed', pid: pending.child.pid, at: new Date().toISOString() });
          }
          return send(200, executionResult);
        } catch (cause) { return send(200, { code: typeof cause.code === 'number' ? cause.code : null, stdout: String(cause.stdout ?? '').slice(-100000), stderr: String(cause.stderr ?? '').slice(-100000), error: cause.status ? cause.message : null, failed: true, killed: Boolean(cause.killed) }); }
        finally { if (!commandsRunning.has(taskId)) counts.delete(taskId); }
      }
      throw error('Unknown tool endpoint.', 404);
    } catch (cause) { if (!response.headersSent) send(cause.status ?? 500, { error: cause.status ? cause.message : 'Daemon operation failed; inspect local diagnostics.' }); }
  });
  server.on('close', () => { Promise.allSettled([...commandsRunning.keys()].map(stopCommand)).then(() => pool.close()).catch(() => {}); });
  return { server, pool };
}

export class RemoteTaskWorkerPool {
  constructor(options) {
    this.options = options; this.jobs = new Map(); this.closed = false;
    const url = new URL(options.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Remote worker requires HTTPS.');
  }
  async call(path, data) {
    let response;
    try { response = await fetch(new URL(path, this.options.url), { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + (this.options.token ?? process.env[this.options.tokenEnv]), 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(30000) }); }
    catch (cause) { throw Object.assign(new Error('Execution device is offline.', { cause }), { offline: true, safeToRetry: path === '/prepare' }); }
    if (!response.ok) throw new Error('Remote worker HTTP ' + response.status);
    return response.json();
  }
  async prepare(task) { return this.call('/prepare', { taskId: task.id, speculative: task.speculative === true }); }
  async start(task, { onProgress } = {}) {
    try { await this.call('/start', { task }); }
    catch (error) { if (!error.offline) throw error; } // Query this durable attempt, never blindly start a replacement.
    const poll = async () => {
      let last;
      while (!this.closed) {
        let state;
        try { state = await this.call('/inspect', { taskId: task.id, attempt: task.attempt ?? 0 }); }
        catch (error) { if (!error.offline) throw error; await new Promise(done => setTimeout(done, this.options.pollMs ?? 1000)); continue; }
        if (state.job?.progress && JSON.stringify(state.job.progress) !== last) { last = JSON.stringify(state.job.progress); await onProgress?.(state.job.progress); }
        if (state.job?.status === 'completed') return state.job.result;
        if (state.job?.status === 'failed') throw Object.assign(new Error(state.job.error.message), state.job.error);
        if (!state.job) throw new Error('Remote worker lost its job record; preserve task and inspect before resuming.');
        await new Promise(resolveWait => setTimeout(resolveWait, this.options.pollMs ?? 500));
      }
      throw new Error('Remote worker connection closed.');
    };
    const completion = poll(); completion.catch(() => {}); this.jobs.set(task.id, completion);
    completion.finally(() => { if (this.jobs.get(task.id) === completion) this.jobs.delete(task.id); }).catch(() => {});
    return { completion };
  }
  input(taskId, input) { return this.call('/input', { taskId, input }); }
  cancel(taskId, reason) { return this.call('/cancel', { taskId, reason }); }
  async inspect(taskId) { const result = await this.call('/inspect', { taskId }); return { ...result.worker, job: result.job, worker: result.worker }; }
  async deliver(task) { return this.call('/delivery', { taskId: task.id, task: { id: task.id, summary: task.summary, instructions: task.instructions, result: task.result, attempt: task.attempt, speculative: task.speculative === true, resumeClosedPr: task.resumeClosedPr === true } }); }
  async close() {
    const pending = [...this.jobs.values()];
    const stops = await Promise.allSettled([...this.jobs.keys()].map(id => this.cancel(id, 'controller-shutdown')));
    this.closed = true; await Promise.allSettled(pending);
    const failed = stops.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configPath = resolve(process.argv[2]);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  for (const key of ['repositoryPath', 'worktreesPath', 'runsPath', 'sessionMapsPath']) if (config[key]) config[key] = resolve(dirname(configPath), config[key]);
  for (const key of ['cliPath', 'runnerPath']) if (config.harness?.[key]) config.harness[key] = resolve(dirname(configPath), config.harness[key]);
  const host = config.host ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && config.behindTlsProxy !== true) throw new Error('Non-loopback daemon requires an explicitly configured TLS proxy.');
  const { server } = createTaskDaemon(config);
  server.listen(config.port ?? 18203, host, () => process.stdout.write('Super-agent execution daemon ready.\n'));
}
