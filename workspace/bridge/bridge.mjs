import { readFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from './state.mjs';
import { Bridge, ImApi } from './core.mjs';
import { OfficialExecutor } from './harness.mjs';
import { InstalledHeadlessExecutor } from './installed-headless.mjs';
import { initializeAutoCursor } from './auto-router.mjs';
import { ManagedRuntime, validateManagedBinding } from './managed-runtime.mjs';

const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'config.local.json' }, handshake: { type: 'boolean' },
  once: { type: 'boolean' }, 'retry-event': { type: 'string' }, 'skip-event': { type: 'string' },
  'runtime-file': { type: 'string' }, 'instance-id': { type: 'string' },
} });
const configPath = resolve(values.config), configDirectory = dirname(configPath);
if (Boolean(values['runtime-file']) !== Boolean(values['instance-id'])) throw new Error('runtime-file and instance-id must be specified together.');
if (values['runtime-file'] && (values.handshake || values.once)) throw new Error('Managed startup requires a persistent listener.');
const runtime = values['runtime-file'] ? new ManagedRuntime(values['runtime-file'], values['instance-id'], configPath) : null;
let store, api, executor, failure, runtimeStarted = false, stopping = false;
const sleepAbort = new AbortController();
const requestStop = () => { stopping = true; sleepAbort.abort(); };
const shouldStop = async () => { if (runtime) await runtime.checkStop(); return stopping; };
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
try {
  if (runtime) { await runtime.start(requestStop); runtimeStarted = true; }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (typeof config.statePath !== 'string' || !config.statePath) throw new Error('Missing statePath.');
  config.statePath = resolve(configDirectory, config.statePath);
  for (const field of ['dshHome', 'cwd', 'dshBin', 'cliPath', 'runsPath', 'sessionMapPath', 'runnerPath']) {
    if (config.harness?.[field]) config.harness[field] = resolve(configDirectory, config.harness[field]);
  }
  config.executor ??= 'official-sdk';
  config.triggerMode ??= 'mention';
  if (!['official-sdk', 'installed-headless'].includes(config.executor)) throw new Error('Unknown executor.');
  if (!['mention', 'auto'].includes(config.triggerMode)) throw new Error('triggerMode must be mention or auto.');
  if (!config.harness?.cwd || (config.executor === 'official-sdk' && !config.harness.dshHome)) throw new Error('Explicit executor cwd and SDK dshHome are required.');
  if (config.triggerMode === 'auto' && config.executor !== 'installed-headless') throw new Error('Automatic routing requires the installed-headless executor.');
  for (const [name, fallback, maximum] of [['contextMessages', 20, 50], ['contextCharacters', 12000, 24000]]) {
    config[name] ??= fallback;
    if (!Number.isSafeInteger(config[name]) || config[name] < 1 || config[name] > maximum) throw new Error('Invalid ' + name + '.');
  }
  if (!config.botUsername || !/^[a-zA-Z0-9_.-]+$/.test(config.botUsername)) throw new Error('Invalid botUsername.');
  const base = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('baseUrl must be an HTTP(S) origin without credentials/path/query/fragment.');
  if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Remote IM connections require HTTPS.');
  config.baseUrl = base.origin;
  if (![config.conversationIds, config.senderIds].every(list => Array.isArray(list) && list.every(id => typeof id === 'string')))
    throw new Error('conversationIds and senderIds must be explicit string arrays.');
  if (!Number.isSafeInteger(config.pollMilliseconds) || config.pollMilliseconds < 250 || config.pollMilliseconds > 3600000) throw new Error('pollMilliseconds must be 250..3600000.');
  if (config.executor === 'official-sdk') {
    await mkdir(config.harness.dshHome, { recursive: true });
    await mkdir(config.harness.cwd, { recursive: true });
  } else if (!(await stat(config.harness.cwd)).isDirectory()) throw new Error('Installed DSH requires an existing project directory.');
  const harnessEnvironment = { ...process.env };
  for (const key of Object.keys(harnessEnvironment)) {
    if (key.toLowerCase() === (config.tokenEnv ?? 'TEAM_RELAY_BOT_TOKEN').toLowerCase()) delete harnessEnvironment[key];
  }
  const Executor = config.executor === 'installed-headless' ? InstalledHeadlessExecutor : OfficialExecutor;
  executor = new Executor({ ...config.harness, env: harnessEnvironment }, async (text, suffix) => {
    if (executor.activeEvent) await api.reply(executor.activeEvent, text.slice(0, 9000), suffix);
  });
  if (config.executor === 'installed-headless') await executor.start();
  if (runtime) {
    if (config.executor !== 'installed-headless' || config.triggerMode !== 'auto') throw new Error('Managed startup requires installed-headless automatic routing.');
    await executor.handshake(); // Installed CLI version only; no model request on startup.
  }
  if (values.handshake) {
    console.log(JSON.stringify(await executor.handshake()));
  } else {
    const token = process.env[config.tokenEnv ?? 'TEAM_RELAY_BOT_TOKEN'];
    if (!token) throw new Error('Set bot token in ' + (config.tokenEnv ?? 'TEAM_RELAY_BOT_TOKEN') + '.');
    api = new ImApi(config.baseUrl, token);
    const bot = await api.request('/api/me');
    if (!bot.is_bot || bot.username !== config.botUsername) throw new Error('Token is not the configured bot account.');
    if (runtime) {
      await validateManagedBinding(api, bot, config);
    }
    store = new StateStore(config.statePath); await store.lock();
    const state = await store.read(config.baseUrl + '|' + bot.id);
    await initializeAutoCursor(api, state, store, config);
    const bridge = new Bridge({ config, api, store, state, executor, bot, shouldStop });
    let transportReady = false, publishedTask;
    const taskDetails = () => ({ taskStatus: bridge.taskStatus(), pendingEventId: state.current?.event?.id ?? null });
    const publishTask = async () => {
      if (!runtime || !transportReady || stopping) return;
      const details = taskDetails(), identity = JSON.stringify(details);
      if (identity !== publishedTask) {
        try { await runtime.publish('listening', details); publishedTask = identity; }
        catch (error) {
          // The task ledger was already committed. A display/status-file error
          // must not strand a prepared worker lease before model admission.
          console.error(JSON.stringify({ status: 'runtime-status-warning', error: String(error.message).slice(0, 1000) }));
        }
      }
    };
    const writeState = store.write.bind(store);
    store.write = async value => { await writeState(value); await publishTask(); };
    if (values['retry-event'] || values['skip-event'] || !bridge.supportsChatRecovery) {
      await bridge.resolveCurrent(values['retry-event'], values['skip-event']);
    } else { await bridge.prepareChatRecovery(); }
    if (!(await shouldStop())) {
      const ready = { cursor: state.cursor, conversations: config.conversationIds.length,
        authorizedSenders: config.senderIds.length, executor: config.executor, triggerMode: config.triggerMode, ...taskDetails() };
      await runtime?.publish('listening', ready);
      transportReady = true; publishedTask = JSON.stringify(taskDetails());
      console.log(JSON.stringify({ status: 'listening', ...ready }));
    }
    let failures = 0;
    while (!(await shouldStop())) {
      try {
        const processed = await bridge.poll(); failures = 0;
        if (processed) console.log(JSON.stringify({ status: 'processed', count: processed, cursor: state.cursor }));
      } catch (error) {
        if (values.once) throw error;
        if (bridge.supportsChatRecovery && bridge.isPaused()) {
          failures = 0;
          console.error(JSON.stringify({ status: 'task-paused', eventId: state.current.event.id, phase: state.current.phase,
            error: String(error.message).slice(0, 1000), cause: error.cause ? String(error.cause.message).slice(0, 1000) : undefined }));
        } else {
          if (['started', 'uncertain', 'routing_failed'].includes(state.current?.phase)) throw error;
          failures++;
          console.error(JSON.stringify({ status: 'retrying', error: error.message, failures }));
        }
      }
      await publishTask();
      if (values.once || await shouldStop()) break;
      try { await delay(Math.min(60000, config.pollMilliseconds * 2 ** Math.min(failures, 5)), undefined, { signal: sleepAbort.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
  }
} catch (error) {
  failure = error;
  throw error;
} finally {
  try { await executor?.close(); await store?.unlock(); }
  catch (error) { failure = error; throw error; }
  finally { if (runtimeStarted) await runtime.finish(Boolean(failure)); }
}
