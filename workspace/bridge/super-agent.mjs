import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ImApi } from './core.mjs';
import { InstalledHeadlessExecutor } from './installed-headless.mjs';
import { ManagedRuntime, validateManagedBinding } from './managed-runtime.mjs';
import { SuperStore } from './super-store.mjs';
import { SuperRouter } from './super-router.mjs';
import { SuperCoordinator } from './super-coordinator.mjs';
import { controlSecret, recoverManagedRuntime, reusableWatchdog, stopWatchdog } from './super-lifecycle.mjs';

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length < 24 || b.length < 24) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function jsonBody(request) {
  let text = '';
  for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 131072) throw new Error('Request too large.'); }
  return JSON.parse(text || '{}');
}

export function createControlServer(coordinator, { token, taskTokenFor, host = '127.0.0.1', port = 18202 }) {
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const supplied = request.headers.authorization?.replace(/^Bearer /u, '');
      if (path === '/api/context/read' && request.method === 'POST') {
        const body = await jsonBody(request);
        if (!sameSecret(supplied, taskTokenFor(body.taskId))) { response.writeHead(403); response.end('{"error":"forbidden"}'); return; }
        response.end(JSON.stringify(coordinator.readContext(body.taskId, body.reference, { offset: body.offset ?? 0, limit: body.limit ?? 6000, linkOffset: body.linkOffset ?? 0 }))); return;
      }
      if (!sameSecret(supplied, token)) { response.writeHead(403); response.end('{"error":"forbidden"}'); return; }
      if (path === '/api/supervisor/snapshot' && request.method === 'GET') response.end(JSON.stringify(coordinator.snapshot()));
      else if (path === '/api/supervisor/actions' && request.method === 'POST') response.end(JSON.stringify(await coordinator.action(await jsonBody(request))));
      else { response.writeHead(404); response.end('{"error":"not_found"}'); }
    } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: String(error.message).slice(0, 500) })); }
  });
  return { server, async start() { await new Promise((yes, no) => { server.once('error', no); server.listen(port, host, yes); }); return server.address(); },
    async close() { await new Promise(resolveClose => server.close(resolveClose)); } };
}

export function normalizeConfig(config, configPath) {
  const base = dirname(configPath), superConfig = config.superAgent;
  if (!superConfig?.enabled) throw new Error('Super-agent mode is not enabled.');
  if (config.executor !== 'installed-headless' || config.triggerMode !== 'auto') throw new Error('Super-agent requires installed-headless automatic routing.');
  const url = new URL(config.baseUrl);
  if (url.pathname !== '/' || url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)
    || (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('IM origin requires HTTPS or loopback.');
  config.baseUrl = url.origin;
  for (const field of ['cwd', 'cliPath', 'runnerPath', 'runsPath', 'sessionMapPath']) if (config.harness[field]) config.harness[field] = resolve(base, config.harness[field]);
  config.statePath = resolve(base, superConfig.statePath ?? '../data/super-agent/state.json');
  superConfig.repositoryPath = resolve(base, superConfig.repositoryPath ?? config.harness.cwd);
  for (const [field, fallback] of [['worktreesPath', '../tools/super-agent/worktrees'], ['runsPath', '../logs/super-agent'], ['sessionMapsPath', '../data/super-agent/sessions']]) superConfig[field] = resolve(base, superConfig[field] ?? fallback);
  if (superConfig.release?.enabled) {
    for (const [field, fallback] of [['repositoryPath', superConfig.repositoryPath], ['worktreesPath', '../build/super-releases'], ['statePath', '../data/super-agent/releases.json']]) superConfig.release[field] = resolve(base, superConfig.release[field] ?? fallback);
  }
  superConfig.projectId ??= 'agent-bot-im'; superConfig.maxWorkers ??= 2;
  if (superConfig.initialCursor !== undefined && (!Number.isSafeInteger(superConfig.initialCursor) || superConfig.initialCursor < 0)) throw new Error('Invalid migration cursor.');
  if (!/^[A-Za-z0-9_.-]{1,80}$/u.test(superConfig.projectId) || !Number.isSafeInteger(superConfig.maxWorkers) || superConfig.maxWorkers < 1 || superConfig.maxWorkers > 8) throw new Error('Invalid project/concurrency configuration.');
  superConfig.controlPort ??= 18202;
  if (!Number.isSafeInteger(superConfig.controlPort) || superConfig.controlPort < 1 || superConfig.controlPort > 65535) throw new Error('Invalid control port.');
  if (!Number.isSafeInteger(config.pollMilliseconds) || config.pollMilliseconds < 250 || config.pollMilliseconds > 60000) throw new Error('Invalid polling interval.');
  if (superConfig.controlHost && !['127.0.0.1', '::1'].includes(superConfig.controlHost)) throw new Error('Expose the control API through an authenticated TLS reverse proxy, not a public plaintext bind.');
  return config;
}

export async function runSuperAgent({ config, configPath, values = {} }) {
  normalizeConfig(config, configPath);
  if (values['retry-event'] || values['skip-event']) throw new Error('Use task-scoped IM controls in Super-agent mode.');
  const options = config.superAgent;
  const controlHost = options.controlHost ?? '127.0.0.1';
  const controlOrigin = `http://${controlHost.includes(':') ? `[${controlHost}]` : controlHost}:${options.controlPort}`;
  let token = process.env[config.tokenEnv ?? 'TEAM_RELAY_BOT_TOKEN'];
  if (!token && process.platform === 'win32' && config.startup?.enabled) {
    try {
      const result = await promisify(execFile)(config.harness.powershellPath ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('./super-credential.ps1', import.meta.url)), '-ConfigPath', configPath], { windowsHide: true, timeout: 15000, maxBuffer: 16384 });
      token = result.stdout.trim();
    } catch { throw new Error('Stored assistant binding could not be restored for controller recovery.'); }
  }
  if (!token) throw new Error('IM assistant credential is missing.');
  const api = new ImApi(config.baseUrl, token), bot = await api.request('/api/me');
  if (!bot.is_bot || bot.username !== config.botUsername) throw new Error('IM assistant identity mismatch.');
  await validateManagedBinding(api, bot, config);
  const store = new SuperStore(config.statePath);
  let coordinator, control, classifier, watchdog, watchdogOwnerPath, launchWatchdog, watchdogIdentity, runtime, runtimeStarted = false, stopping = false, failed = false, heartbeatTimer, routingJob, githubJob, inspectJob, inputJob;
  let watchdogRestarts = 0, nextWatchdogCheck = 0, managedRecovered = false;
  const secret = await controlSecret(join(dirname(config.statePath), 'controller.secret'), process.env.SUPER_AGENT_CONTROL_TOKEN);
  const taskTokenFor = id => typeof id === 'string' && /^T\d{6,}$/u.test(id) ? createHmac('sha256', secret).update(id).digest('hex') : '';
  const stop = () => { stopping = true; if (coordinator) coordinator.stopping = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (values['runtime-file']) {
      runtime = new ManagedRuntime(values['runtime-file'], values['instance-id'], configPath);
      managedRecovered = Boolean(await recoverManagedRuntime(runtime));
      await runtime.start(stop); runtimeStarted = true;
    }
    await store.lock();
    const state = await store.read(`${config.baseUrl}|${bot.id}|super-agent-v3`);
    const scrubbed = { ...process.env };
    const privateNames = ['TEAM_RELAY_BOT_TOKEN', 'SUPER_AGENT_CONTROL_TOKEN', 'SUPER_AGENT_RESTART_TOKEN_BUNDLE', config.tokenEnv, options.daemon?.tokenEnv, 'SUPER_AGENT_DAEMON_TOKEN'].filter(Boolean).map(value => value.toUpperCase());
    for (const name of Object.keys(scrubbed)) if (privateNames.includes(name.toUpperCase())) delete scrubbed[name];
    classifier = new InstalledHeadlessExecutor({ ...config.harness, env: scrubbed, runsPath: join(options.runsPath, 'router'), sessionMapPath: join(options.sessionMapsPath, 'router.json') });
    const handshake = await classifier.handshake();
    if (values.handshake) { console.log(JSON.stringify(handshake)); return; }
    const workers = await import('./super-worker.mjs');
    const contextUrl = `${controlOrigin}/api/context/read`;
    let pool;
    const poolOptions = { ...options, harness: { ...config.harness, env: scrubbed }, contextUrl, contextTokenFor: taskTokenFor,
      daemon: options.daemon ? { ...options.daemon, token: process.env[options.daemon.tokenEnv ?? 'SUPER_AGENT_DAEMON_TOKEN'] } : undefined };
    if (options.executionMode === 'remote-native') {
      const { RemoteTaskWorkerPool } = await import('./super-daemon.mjs'); pool = new RemoteTaskWorkerPool({ ...poolOptions, ...poolOptions.daemon });
    } else if (options.executionMode === 'remote-tools') pool = new workers.CloudTaskWorkerPool(poolOptions);
    else pool = new workers.TaskWorkerPool(poolOptions);
    const { GitDelivery, GitHubSource } = await import('./super-github.mjs');
    const github = options.github?.enabled ? new GitHubSource(options.github) : null;
    const delivery = options.github?.enabled ? (options.executionMode === 'remote-tools' || options.executionMode === 'remote-native' ? { deliver: task => pool.deliver(task), sync: task => pool.deliver(task) } : new GitDelivery(options.github)) : null;
    const release = options.release?.enabled ? new (await import('./super-release.mjs')).ReleasePipeline(options.release) : null;
    coordinator = new SuperCoordinator({ state, store, config: { ...config, ...options }, api, bot,
      router: new SuperRouter({ projectId: options.projectId, classify: prompt => classifier.classify(prompt) }), pool, delivery, release });
    if (!state.superAgent && options.initialCursor !== undefined) state.cursor = Math.max(state.cursor, options.initialCursor);
    if (!state.superAgent && options.initialCursor === undefined && options.processExistingMessages !== true) {
      const conversations = await api.request('/api/conversations');
      state.cursor = Math.max(state.cursor, ...conversations.filter(item => config.conversationIds.includes(item.id)).map(item => item.last_message?.id ?? 0));
    }
    await coordinator.initialize();
    control = createControlServer(coordinator, { token: secret, taskTokenFor, host: options.controlHost, port: options.controlPort });
    await control.start();
    if (options.watchdog?.enabled !== false) {
      const path = join(dirname(config.statePath), `watchdog-${coordinator.generation}.json`);
      await mkdir(dirname(path), { recursive: true });
      const watchdogConfig = { ...options.watchdog, controllerUrl: controlOrigin,
        tokenEnv: 'SUPER_AGENT_CONTROL_TOKEN', statePath: join(dirname(config.statePath), 'watchdog-state.json'),
        harness: { ...config.harness, runsPath: join(options.runsPath, 'watchdog'), sessionMapPath: join(options.sessionMapsPath, 'watchdog.json') } };
      watchdogOwnerPath = watchdogConfig.ownerPath ?? watchdogConfig.statePath + '.runtime.json';
      if (runtime) {
        await runtime.publish('starting', { executablePath: process.execPath, args: process.argv.slice(1), cwd: process.cwd() });
        watchdogConfig.restart = { runtimePath: runtime.path, instanceId: runtime.record.instanceId, executablePath: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), cooldownMs: 60000, maxRestarts: 3,
          credentialEnvNames: [config.tokenEnv ?? 'TEAM_RELAY_BOT_TOKEN', ...(options.daemon ? [options.daemon.tokenEnv ?? 'SUPER_AGENT_DAEMON_TOKEN'] : [])] };
      }
      const reusable = await reusableWatchdog(watchdogOwnerPath, { token: secret, controllerUrl: watchdogConfig.controllerUrl, statePath: watchdogConfig.statePath });
      watchdogIdentity = { token: secret, controllerUrl: watchdogConfig.controllerUrl, statePath: watchdogConfig.statePath };
      await writeFile(path, JSON.stringify(watchdogConfig, null, 2), { mode: 0o600 });
      launchWatchdog = () => {
        const restartCredentials = { [config.tokenEnv ?? 'TEAM_RELAY_BOT_TOKEN']: token };
        if (options.daemon) restartCredentials[options.daemon.tokenEnv ?? 'SUPER_AGENT_DAEMON_TOKEN'] = poolOptions.daemon.token;
        const child = spawn(process.execPath, [fileURLToPath(new URL('./super-watchdog.mjs', import.meta.url)), '--config', path],
          { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...scrubbed, SUPER_AGENT_CONTROL_TOKEN: secret, SUPER_AGENT_RESTART_TOKEN_BUNDLE: JSON.stringify(restartCredentials) } });
        child.on('error', error => coordinator.heartbeat('watchdog', 'error', error.message).catch(() => {}));
        child.on('exit', (code, signal) => { if (!stopping) coordinator.heartbeat('watchdog', 'error', `Watchdog exited ${code ?? signal}`).catch(() => {}); });
        return child;
      };
      if (!reusable) {
        watchdog = launchWatchdog();
        const deadline = Date.now() + 15000;
        let ready = false;
        while (Date.now() < deadline) {
          if (watchdog.exitCode !== null) throw new Error('Watchdog exited before readiness; inspect local diagnostics.');
          try { ready = Boolean(await reusableWatchdog(watchdogOwnerPath, { token: secret, controllerUrl: watchdogConfig.controllerUrl, statePath: watchdogConfig.statePath })); } catch { /* Complete ownership publication may still be in progress. */ }
          if (ready) break;
          await delay(100);
        }
        if (!ready) throw new Error('Watchdog ownership/readiness was not confirmed.');
      }
    }
    const publish = () => runtime?.publish('listening', { mode: 'super-agent', taskStatus: coordinator.active.size ? 'running' : 'ready',
      activeTasks: coordinator.active.size, pendingTasks: Object.values(coordinator.data.tasks).filter(task => task.status === 'queued').length,
      controlPort: options.controlPort, watchdogPid: watchdog?.pid ?? null, generation: coordinator.generation });
    await publish(); console.log(JSON.stringify({ status: 'listening', mode: 'super-agent', maxWorkers: options.maxWorkers, controlPort: options.controlPort }));
    if (managedRecovered && config.startup?.enabled && process.platform === 'win32') {
      await promisify(execFile)(config.harness.powershellPath ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('./super-register.ps1', import.meta.url)), '-ControllerPid', String(process.pid), '-ConfigPath', configPath,
        '-RuntimeFile', runtime.path, '-InstanceId', runtime.record.instanceId], { windowsHide: true, timeout: 15000, maxBuffer: 16384 });
    }
    heartbeatTimer = setInterval(() => { coordinator.heartbeat().then(publish).catch(error => { console.error(JSON.stringify({ status: 'heartbeat-warning', error: error.message })); }); }, 5000);
    let githubPolling = false, lastGithub = 0, lastInspection = 0;
    while (!stopping) {
      if (runtime) await runtime.checkStop();
      if (stopping) break;
      try {
        const conversations = await api.request('/api/conversations');
        if (stopping) break;
        const page = await api.request('/api/agent/events?after=' + coordinator.state.cursor + '&limit=50');
        if (stopping) break;
        await coordinator.ingestIm(page.events, conversations);
        await coordinator.heartbeat('im');
      } catch (error) { await coordinator.heartbeat('im', 'error', error.message); }
      if (!coordinator.routing) routingJob = coordinator.routePending().catch(error => console.error(JSON.stringify({ status: 'router-warning', error: error.message })));
      coordinator.kick();
      if (launchWatchdog && Date.now() >= nextWatchdogCheck && !stopping) {
        nextWatchdogCheck = Date.now() + 30000;
        try {
          const owner = await reusableWatchdog(watchdogOwnerPath, watchdogIdentity);
          if (!owner && watchdogRestarts < 3) {
            watchdogRestarts++; watchdog = launchWatchdog();
            await coordinator.heartbeat('watchdog', 'starting');
          } else if (!owner) await coordinator.heartbeat('watchdog', 'error', 'Watchdog restart budget exhausted; inspect its process evidence.');
          else await coordinator.heartbeat('watchdog');
        } catch (error) { await coordinator.heartbeat('watchdog', 'error', error.message); }
      }
      if (!coordinator.reconciling) inputJob = coordinator.reconcileInputs().catch(error => console.error(JSON.stringify({ status: 'input-warning', error: error.message })));
      if (Date.now() - lastInspection >= 30000) { lastInspection = Date.now(); inspectJob = coordinator.inspectActive().catch(error => console.error(JSON.stringify({ status: 'inspection-warning', error: error.message }))); }
      if (github && !githubPolling && Date.now() - lastGithub >= (options.github.pollMilliseconds ?? 15000)) {
        githubPolling = true; lastGithub = Date.now();
        const bindings = Object.values(coordinator.data.tasks).filter(task => task.delivery?.number && !['closed', 'merged', 'cancelled'].includes(task.status))
          .map(task => ({ taskId: task.id, number: task.delivery.number, conversationId: task.conversationId }));
        githubJob = github.poll(bindings, coordinator.data.githubCursor).then(page => coordinator.ingestGithub(page))
          .catch(error => coordinator.heartbeat('github', 'error', error.message)).finally(() => { githubPolling = false; });
      }
      if (values.once) break;
      await delay(config.pollMilliseconds);
    }
  } catch (error) { failed = true; throw error; }
  finally {
    stopping = true; clearInterval(heartbeatTimer);
    // Watchdog owns only read-only invocations; allow its signal handler to reap them.
    if (!failed && watchdogOwnerPath && !await stopWatchdog(watchdogOwnerPath, watchdog)) console.error('Watchdog shutdown not confirmed; preserve its lease for inspection.');
    if (failed && watchdog?.connected) watchdog.disconnect(); // The independent recovery loop must survive a controller failure.
    if (coordinator) coordinator.stopping = true;
    await classifier?.close(); await Promise.allSettled([routingJob, githubJob, inspectJob, inputJob]);
    await coordinator?.close(); await control?.close(); await store.unlock();
    if (runtimeStarted) await runtime.finish(failed);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
