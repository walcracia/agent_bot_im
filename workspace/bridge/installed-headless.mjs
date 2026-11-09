import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceOwnedFile } from './file-replace.mjs';

const RUNNER = fileURLToPath(new URL('./installed-runner.ps1', import.meta.url));
const NATIVE_SESSION = /^session-[A-Za-z0-9_-]+$/;
const PERMISSIONS = new Set(['read-only', 'workspace-write', 'danger-full-access']);

export class DshInvocationError extends Error {
  constructor(message, { kind, processTreeStopped = false, timeoutMs, runDirectory, cause } = {}) {
    super(message, { cause });
    this.name = 'DshInvocationError';
    Object.assign(this, { kind, processTreeStopped, timeoutMs, runDirectory });
  }
}

function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`${label} must be an explicit absolute path.`);
  return resolve(value);
}

function scrubEnvironment(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (['TEAM_RELAY_BOT_TOKEN', 'SUPER_AGENT_CONTROL_TOKEN', 'SUPER_AGENT_DAEMON_TOKEN', 'SUPER_AGENT_ENVIRONMENT_TOKEN'].includes(key.toUpperCase())) delete env[key];
  return env;
}

/** Installed Desktop CLI adapter. It owns fresh headless processes, never a Desktop chat. */
export class InstalledHeadlessExecutor {
  constructor(options, report) {
    this.options = options;
    this.report = report;
    this.active = new Set();
    this.closed = false;
    this.saveQueue = Promise.resolve();
  }

  async start() {
    if (this.closed) throw new Error('Installed DSH executor is closed.');
    if (this.terminationUnconfirmed) throw new DshInvocationError('A previous DSH process tree could not be confirmed stopped; inspect its local run before resuming.', { kind: 'termination-failed' });
    if (this.ready) return;
    this.starting ??= this.prepare().catch(error => { this.starting = undefined; throw error; });
    await this.starting;
  }

  async prepare() {
    this.cwd = await realpath(absolute(this.options.cwd, 'cwd'));
    const workspaceKey = process.platform === 'win32' ? this.cwd.toLowerCase() : this.cwd;
    this.workspaceLockPath = join(tmpdir(), 'team-relay-dsh-workspaces', `${createHash('sha256').update(workspaceKey).digest('hex')}.lock`);
    this.cliPath = absolute(this.options.cliPath, 'cliPath');
    this.runsPath = absolute(this.options.runsPath, 'runsPath');
    this.sessionMapPath = absolute(this.options.sessionMapPath, 'sessionMapPath');
    this.runnerPath = absolute(this.options.runnerPath ?? RUNNER, 'runnerPath');
    for (const path of [this.cliPath, this.runnerPath]) {
      await access(path, constants.R_OK);
      if (!(await stat(path)).isFile()) throw new Error('DSH CLI and runner must be files.');
    }
    if (!(await stat(this.cwd)).isDirectory()) throw new Error('DSH cwd must be a directory.');
    this.auth = this.options.auth ?? 'stored';
    this.permissionMode = this.options.permissionMode ?? 'danger-full-access';
    this.runTimeoutMs = this.options.runTimeoutMs ?? 7200000;
    this.classificationTimeoutMs = this.options.classificationTimeoutMs ?? Math.min(this.runTimeoutMs, 120000);
    if (!['stored', 'environment'].includes(this.auth)) throw new Error('auth must be stored or environment.');
    if (!PERMISSIONS.has(this.permissionMode)) throw new Error('Invalid worker permissionMode.');
    if (!Number.isSafeInteger(this.runTimeoutMs) || this.runTimeoutMs < 100 || this.runTimeoutMs > 86400000) throw new Error('runTimeoutMs must be 100..86400000.');
    if (!Number.isSafeInteger(this.classificationTimeoutMs) || this.classificationTimeoutMs < 100 || this.classificationTimeoutMs > 86400000) throw new Error('classificationTimeoutMs must be 100..86400000.');
    this.map = { version: 1, cwd: this.cwd, sessions: {} };
    try { this.map = JSON.parse(await readFile(this.sessionMapPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read DSH session map; preserving it for inspection.'); }
    if (this.map.version !== 1 || this.map.cwd !== this.cwd || !this.map.sessions || Array.isArray(this.map.sessions) || typeof this.map.sessions !== 'object') throw new Error('DSH session map belongs to another cwd or is invalid.');
    for (const [logical, entry] of Object.entries(this.map.sessions)) {
      this.validateLogical(logical);
      if (!entry || !NATIVE_SESSION.test(entry.nativeSessionId) || entry.cwd !== this.cwd) throw new Error('Invalid stored native DSH session.');
    }
    await mkdir(this.runsPath, { recursive: true });
    this.ready = true;
  }

  async acquireWorkerLease() {
    if (this.closed) throw new Error('Installed DSH executor is closed.');
    if (this.preparingLease || this.workerLease) throw new Error('This executor already owns a prepared DSH worker session.');
    this.preparingLease = this.createWorkerLease();
    try { return await this.preparingLease; }
    finally { this.preparingLease = undefined; }
  }

  async createWorkerLease() {
    await mkdir(dirname(this.workspaceLockPath), { recursive: true, mode: 0o700 });
    let handle;
    try { handle = await open(this.workspaceLockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = 'unknown';
      try {
        const owner = JSON.parse(await readFile(this.workspaceLockPath, 'utf8'));
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) pid = String(owner.pid);
      } catch { /* Partial or stale locks are preserved, just as live ones are. */ }
      throw new Error(`DSH workspace is busy (lock pid ${pid}). Existing locks are never removed automatically. Confirm all related processes have stopped before inspecting ${this.workspaceLockPath}.`);
    }
    try {
      await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, cwd: this.cwd, nonce: randomUUID(), createdUtc: new Date().toISOString() }));
      await handle.sync();
      const lease = { handle, path: this.workspaceLockPath, released: false };
      this.workerLease = lease;
      if (this.closed) {
        await this.releaseWorkerLease(lease);
        throw new Error('Installed DSH executor closed while preparing its workspace lease.');
      }
      return lease;
    } catch (error) {
      // A failed initial write retains its partial lock rather than exposing the
      // workspace to another worker whose predecessor is not yet understood.
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async releaseWorkerLease(lease) {
    if (!lease || lease.released) return;
    if (lease.terminationUnconfirmed) return;
    if ([...this.active].some(active => active.workerLease === lease)) return;
    lease.release ??= this.finishWorkerLease(lease);
    await lease.release;
  }

  async finishWorkerLease(lease) {
    try {
      const mine = await lease.handle.stat({ bigint: true });
      let current;
      try { current = await lstat(lease.path, { bigint: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current) {
        if (mine.dev !== current.dev || mine.ino !== current.ino) throw new Error('DSH workspace lock was replaced; refusing to remove another owner\'s lock.');
        // Keep our descriptor open until the exact file has been unlinked.
        await unlink(lease.path);
      }
    } finally {
      await lease.handle.close();
      lease.released = true;
      if (this.workerLease === lease) this.workerLease = undefined;
    }
  }

  validateLogical(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid logical DSH session ID.');
  }

  async saveSession(logical, nativeSessionId) {
    if (!logical) return;
    if (!NATIVE_SESSION.test(nativeSessionId)) throw new Error('Invalid opening DSH session ID.');
    const existing = Object.hasOwn(this.map.sessions, logical) ? this.map.sessions[logical] : null;
    if (existing && existing.nativeSessionId !== nativeSessionId) throw new Error('DSH changed the requested native session; refusing to replace its mapping.');
    if (existing) return;
    if (Object.values(this.map.sessions).some(entry => entry.nativeSessionId === nativeSessionId)) throw new Error('Native DSH session already belongs to another logical conversation.');
    this.map.sessions[logical] = { nativeSessionId, cwd: this.cwd };
    this.saveQueue = this.saveQueue.then(async () => {
      await mkdir(dirname(this.sessionMapPath), { recursive: true });
      const temporary = `${this.sessionMapPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.map, null, 2), { flag: 'wx', mode: 0o600, flush: true });
      await replaceOwnedFile(temporary, this.sessionMapPath);
    });
    await this.saveQueue;
  }

  async handshake() {
    await this.start();
    const result = await this.invoke({ versionOnly: true });
    return { protocol: 'installed-headless-jsonl', cliVersion: result.version, cwd: this.cwd, modelRequests: 0 };
  }

  async classify(prompt) {
    await this.start();
    if (this.workerLease || this.preparingLease) throw new Error('This executor already owns a prepared DSH worker session.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Classifier prompt must be text.');
    const result = await this.invoke({ prompt, permissionMode: 'read-only', kind: 'classifier' });
    return result.finalResponse;
  }

  async session(logicalId, restore) {
    await this.start();
    if (this.invoking || this.active.size) throw new Error('This DSH executor already owns a running invocation.');
    this.validateLogical(logicalId);
    const mapped = Object.hasOwn(this.map.sessions, logicalId);
    if (restore && !mapped) throw new Error('Native DSH session mapping is missing; inspect saved run logs before retrying.');
    if (!restore && mapped) throw new Error('Logical DSH session already exists; explicitly restore it instead of replacing it.');
    const lease = await this.acquireWorkerLease();
    let used = false;
    return {
      abortPreparation: async () => {
        if (used) return false;
        // Consume the handle before awaiting cleanup so run/abort cannot race.
        used = true;
        await this.releaseWorkerLease(lease);
        return true;
      },
      run: async (blocks, event) => {
        if (used || lease.released) throw new Error('Prepared DSH session lease was consumed; obtain another session handle before running again.');
        used = true;
        try {
          if (!Array.isArray(blocks) || !blocks.length || blocks.some(block => !block || !['text', 'image'].includes(block.type) || (block.type === 'text' && typeof block.text !== 'string'))) throw new Error('Unsupported DSH prompt blocks.');
          // Core supplies checked attachment local_path in the text envelope. Headless CLI
          // receives text and reads those local files; it does not receive inline base64 images.
          const prompt = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
          if (!prompt.trim()) throw new Error('Headless DSH needs a text task with any attachment paths.');
          lease.run = this.invoke({ prompt, logicalId, permissionMode: this.permissionMode, kind: 'worker', eventId: event?.id, workerLease: lease });
          return await lease.run;
        } finally { await this.releaseWorkerLease(lease); }
      },
    };
  }

  async invoke(spec) {
    if (this.invoking || this.active.size) throw new Error('This DSH executor already owns a running invocation.');
    this.invoking = true;
    try { return await this.runInvocation(spec); }
    finally { this.invoking = false; }
  }

  async stopOwnedProcessTree(child, closed, runDirectory) {
    const unconfirmed = cause => new DshInvocationError(`Could not prove the owned DSH process tree stopped. Inspect ${runDirectory}; do not start another worker.`, {
      kind: 'termination-failed', processTreeStopped: false, runDirectory, cause,
    });
    // A closed launcher alone does not establish whether descendants survived.
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw unconfirmed();
    if (process.platform === 'win32') {
      const killed = await new Promise(resolveKill => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', error => resolveKill({ error }));
        killer.once('close', code => resolveKill({ code }));
      });
      if (killed.error || killed.code !== 0) throw unconfirmed(killed.error);
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { throw unconfirmed(error); }
    }
    let timer;
    const exited = await Promise.race([closed.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 5000); })]);
    clearTimeout(timer);
    if (!exited) throw unconfirmed();
    return { processTreeStopped: true };
  }

  async runInvocation({ prompt, logicalId, permissionMode = 'read-only', kind = 'version', versionOnly = false, eventId, workerLease }) {
    if (this.closed) throw new Error('Installed DSH executor is closed.');
    if (this.active.size) throw new Error('This DSH executor already owns a running invocation.');
    const runDirectory = join(this.runsPath, `${kind}-${randomUUID()}`);
    const startedUtc = new Date().toISOString();
    const timeoutMs = versionOnly ? Math.min(this.runTimeoutMs, 30000) : kind === 'classifier' ? this.classificationTimeoutMs : this.runTimeoutMs;
    await mkdir(runDirectory, { mode: 0o700 });
    const taskFile = join(runDirectory, 'task.txt');
    if (!versionOnly) await writeFile(taskFile, prompt, { flag: 'wx', mode: 0o600 });
    const nativeSessionId = logicalId && Object.hasOwn(this.map.sessions, logicalId) ? this.map.sessions[logicalId].nativeSessionId : undefined;
    await writeFile(join(runDirectory, 'bridge-run.json'), JSON.stringify({ kind, logicalId, nativeSessionId, cwd: this.cwd, eventId, timeoutMs }), { flag: 'wx', mode: 0o600 });
    const args = ['-NoProfile', '-NonInteractive', '-File', this.runnerPath, '-Workspace', this.cwd, '-CliPath', this.cliPath, '-RunDirectory', runDirectory];
    if (versionOnly) args.push('-VersionOnly');
    else {
      args.push('-TaskFile', taskFile, '-Auth', this.auth, '-PermissionMode', permissionMode);
      if (nativeSessionId) args.push('-SessionId', nativeSessionId);
      if (this.options.extraPatches?.length) args.push('-ExtraPatchesJson', JSON.stringify(this.options.extraPatches.map(patch => absolute(patch, 'extraPatch'))));
    }
    const env = scrubEnvironment(this.options.env ?? process.env);
    if (this.closed) throw new Error('Installed DSH executor was closed before process launch.');
    const child = spawn(this.options.powershellPath ?? 'pwsh', args, {
      cwd: this.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError, timedOut = false, cancelled = false, mappingError, stopping, processTreeStopped = false, failure, completed = false;
    let diagnostic = '';
    child.stdout.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
    const closed = new Promise(resolveClose => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => resolveClose({ code, signal }));
    });
    const stop = () => {
      if (!stopping) {
        this.terminationUnconfirmed = true;
        if (workerLease) workerLease.terminationUnconfirmed = true;
        stopping = this.stopOwnedProcessTree(child, closed, runDirectory).then(proof => {
          if (proof?.processTreeStopped !== true) throw new DshInvocationError(`Owned DSH termination lacks a verified process-tree result. Inspect ${runDirectory}.`, { kind: 'termination-failed', runDirectory });
          processTreeStopped = true;
          this.terminationUnconfirmed = false;
          if (workerLease) workerLease.terminationUnconfirmed = false;
        });
      }
      return stopping;
    };
    const active = { stop: async () => { cancelled = true; await stop(); }, closed, workerLease, runDirectory, pid: child.pid };
    this.active.add(active);
    closed.then(() => this.active.delete(active));
    const captureOpening = async () => {
      if (!logicalId || mappingError) return;
      let handle;
      try {
        handle = await open(join(runDirectory, 'events.jsonl'), 'r');
        const buffer = Buffer.alloc(65536);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const newline = buffer.indexOf(10, 0);
        if (newline < 0 || newline >= bytesRead) return;
        const event = JSON.parse(buffer.subarray(0, newline).toString('utf8').replace(/^\uFEFF/, ''));
        if (event.type !== 'session' || !NATIVE_SESSION.test(event.sessionId)) return;
        if (nativeSessionId && event.sessionId !== nativeSessionId) throw new Error('Resumed DSH session opening differs from its mapping.');
        await this.saveSession(logicalId, event.sessionId);
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) mappingError = error;
      } finally { await handle?.close(); }
    };
    let capture = Promise.resolve(), observedBytes = 0;
    const observeProgress = async () => {
      await captureOpening();
      if (typeof this.options.onProgress !== 'function') return;
      let handle;
      try {
        handle = await open(join(runDirectory, 'events.jsonl'), 'r');
        const details = await handle.stat();
        if (details.size <= observedBytes) return;
        const buffer = Buffer.alloc(Math.min(16384, details.size - observedBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(observedBytes, details.size - buffer.length));
        observedBytes = details.size;
        const events = buffer.subarray(0, bytesRead).toString('utf8').split('\n').flatMap(line => {
          try { const entry = JSON.parse(line); return [{ type: String(entry.type).slice(0, 80), text: String(entry.text ?? entry.name ?? entry.toolName ?? '').slice(0, 800) }]; }
          catch { return []; }
        }).slice(-8);
        await this.options.onProgress({ at: new Date().toISOString(), bytes: observedBytes, events, runDirectory });
      } catch { /* Progress is advisory; the durable completion result remains authoritative. */ }
      finally { await handle?.close(); }
    };
    const interval = setInterval(() => { capture = capture.then(observeProgress); }, 100);
    let stopFailed;
    const terminationFailure = new Promise((_, reject) => { stopFailed = reject; });
    const timeout = setTimeout(() => { timedOut = true; stop().catch(stopFailed); }, timeoutMs);
    try {
      const result = await Promise.race([closed, terminationFailure]);
      if (stopping) await stopping;
      clearInterval(interval); clearTimeout(timeout);
      await capture; await observeProgress(); await this.saveQueue;
      if (spawnError) throw new Error(`Unable to run installed DSH launcher (${spawnError.code ?? 'process error'}).`);
      if (timedOut || cancelled) throw new DshInvocationError(`DSH invocation ${timedOut ? 'timed out' : 'was cancelled'}; owned process tree stopped. Inspect ${runDirectory}.`, {
        kind: timedOut ? 'timeout' : 'cancelled', processTreeStopped, timeoutMs, runDirectory,
      });
      if (mappingError) throw mappingError;
      let summary;
      try { summary = JSON.parse(await readFile(join(runDirectory, 'result.json'), 'utf8')); }
      catch { throw new Error(`DSH runner did not produce a verified result. Inspect ${runDirectory}.`); }
      if (versionOnly) {
        if (result.code !== 0 || summary.completed !== true || typeof summary.version !== 'string' || !summary.version.trim()) throw new Error(`Installed DSH version probe failed. Inspect ${runDirectory}.`);
        completed = true;
        return { version: summary.version };
      }
      if (result.code !== 0 || summary.completed !== true || summary.nativeExitCode !== 0 || summary.finalReason !== 'completed' || !NATIVE_SESSION.test(summary.sessionId)) throw new Error(`Installed DSH run did not complete. Inspect ${runDirectory}.`);
      if (nativeSessionId && summary.sessionId !== nativeSessionId) throw new Error('DSH final session differs from its saved mapping.');
      await this.saveSession(logicalId, summary.sessionId);
      const finalResponse = await readFile(join(runDirectory, 'answer.txt'), 'utf8');
      completed = true;
      return { finalResponse, finishReason: 'completed' };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      clearInterval(interval); clearTimeout(timeout);
      if (child.exitCode !== null || child.signalCode !== null || spawnError) this.active.delete(active);
      // Keep raw events and diagnostics local; never include them in an IM reply.
      diagnostic = '';
      // This bridge-owned sidecar records interruption even if the force-stopped
      // PowerShell runner could not replace its initial run.json status.
      await writeFile(join(runDirectory, 'bridge-supervision.json'), JSON.stringify({
        version: 1, kind, status: completed ? 'completed' : failure?.kind === 'timeout' ? 'timed_out' : failure?.kind === 'cancelled' ? 'cancelled' : 'failed',
        failureKind: completed ? null : failure?.kind ?? 'execution-failed', startedUtc, finishedUtc: new Date().toISOString(),
        timeoutMs, launcherPid: child.pid ?? null, launcherExited: child.exitCode !== null || child.signalCode !== null || Boolean(spawnError),
        ...(timedOut || cancelled || this.terminationUnconfirmed ? { processTreeStopped } : {}),
      }, null, 2), { flag: 'wx', mode: 0o600, flush: true });
    }
  }

  async close() {
    this.closed = true;
    await this.starting?.catch(() => {});
    await this.preparingLease?.catch(() => {});
    await Promise.all([...this.active].map(active => active.stop()));
    await this.workerLease?.run?.catch(() => {});
    if (this.terminationUnconfirmed) throw new DshInvocationError('DSH shutdown could not confirm all owned processes stopped; workspace lease is retained for inspection.', { kind: 'termination-failed' });
    await this.releaseWorkerLease(this.workerLease);
    await this.saveQueue;
  }
}
