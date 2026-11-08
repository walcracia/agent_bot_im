import { readFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from './state.mjs';
import { Bridge, ImApi } from './core.mjs';
import { OfficialExecutor } from './harness.mjs';
import { InstalledHeadlessExecutor } from './installed-headless.mjs';
import { initializeAutoCursor } from './auto-router.mjs';

const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'config.local.json' }, handshake: { type: 'boolean' },
  once: { type: 'boolean' }, 'retry-event': { type: 'string' }, 'skip-event': { type: 'string' },
} });
const configPath = resolve(values.config), configDirectory = dirname(configPath);
const config = JSON.parse(await readFile(configPath, 'utf8'));
for (const field of ['statePath']) {
  if (typeof config[field] !== 'string' || !config[field]) throw new Error(`Missing ${field}.`);
  config[field] = resolve(configDirectory, config[field]);
}
for (const field of ['dshHome', 'cwd', 'dshBin', 'cliPath', 'runsPath', 'sessionMapPath']) {
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
  if (!Number.isSafeInteger(config[name]) || config[name] < 1 || config[name] > maximum) throw new Error(`Invalid ${name}.`);
}
if (!config.botUsername || !/^[a-zA-Z0-9_.-]+$/.test(config.botUsername)) throw new Error('Invalid botUsername.');
const base = new URL(config.baseUrl);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/')
  throw new Error('baseUrl must be an HTTP(S) origin without credentials/path.');
if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  throw new Error('Remote IM connections require HTTPS.');
config.baseUrl = base.origin;
if (![config.conversationIds, config.senderIds].every(list => Array.isArray(list) && list.every(id => typeof id === 'string')))
  throw new Error('conversationIds and senderIds must be explicit string arrays.');
if (!Number.isSafeInteger(config.pollMilliseconds) || config.pollMilliseconds < 250 || config.pollMilliseconds > 3600000)
  throw new Error('pollMilliseconds must be 250..3600000.');
if (config.executor === 'official-sdk') {
  await mkdir(config.harness.dshHome, { recursive: true });
  await mkdir(config.harness.cwd, { recursive: true });
} else if (!(await stat(config.harness.cwd)).isDirectory()) throw new Error('Installed DSH requires an existing project directory.');
const harnessEnvironment = { ...process.env };
for (const key of Object.keys(harnessEnvironment)) {
  if (key.toLowerCase() === (config.tokenEnv ?? 'TEAM_RELAY_BOT_TOKEN').toLowerCase()) delete harnessEnvironment[key];
}
const Executor = config.executor === 'installed-headless' ? InstalledHeadlessExecutor : OfficialExecutor;
const executor = new Executor({ ...config.harness, env: harnessEnvironment }, async (text, suffix) => {
  if (executor.activeEvent) await api.reply(executor.activeEvent, text.slice(0, 9000), suffix);
});
let store, api;
let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
try {
  if (config.executor === 'installed-headless') await executor.start();
  if (values.handshake) {
    console.log(JSON.stringify(await executor.handshake()));
  } else {
    const token = process.env[config.tokenEnv ?? 'TEAM_RELAY_BOT_TOKEN'];
    if (!token) throw new Error(`Set bot token in ${config.tokenEnv ?? 'TEAM_RELAY_BOT_TOKEN'}.`);
    api = new ImApi(config.baseUrl, token);
    const bot = await api.request('/api/me');
    if (!bot.is_bot || bot.username !== config.botUsername) throw new Error('Token is not the configured bot account.');
    store = new StateStore(config.statePath); await store.lock();
    const state = await store.read(`${config.baseUrl}|${bot.id}`);
    await initializeAutoCursor(api, state, store, config);
    const bridge = new Bridge({ config, api, store, state, executor, bot });
    await bridge.resolveCurrent(values['retry-event'], values['skip-event']);
    console.log(JSON.stringify({ status: 'listening', cursor: state.cursor, conversations: config.conversationIds.length,
      authorizedSenders: config.senderIds.length, executor: config.executor, triggerMode: config.triggerMode }));
    let failures = 0;
    do {
      try {
        const processed = await bridge.poll(); failures = 0;
        if (processed) console.log(JSON.stringify({ status: 'processed', count: processed, cursor: state.cursor }));
      } catch (error) {
        // Ambiguous execution is an operator boundary, not a retry loop.
        if (['started', 'uncertain', 'routing_failed'].includes(state.current?.phase) || values.once) throw error;
        failures++;
        console.error(JSON.stringify({ status: 'retrying', error: error.message, failures }));
      }
      if (values.once || stopping) break;
      await delay(Math.min(60000, config.pollMilliseconds * 2 ** Math.min(failures, 5)));
    } while (!stopping);
  }
} finally {
  await executor.close();
  await store?.unlock();
}
