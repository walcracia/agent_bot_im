import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from './state.mjs';
import { Bridge, ImApi } from './core.mjs';
import { OfficialExecutor } from './harness.mjs';

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
for (const field of ['dshHome', 'cwd', 'dshBin']) {
  if (config.harness?.[field]) config.harness[field] = resolve(configDirectory, config.harness[field]);
}
if (!config.harness?.dshHome || !config.harness?.cwd) throw new Error('Explicit dshHome and executor cwd are required.');
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
await mkdir(config.harness.dshHome, { recursive: true });
await mkdir(config.harness.cwd, { recursive: true });
const harnessEnvironment = { ...process.env };
for (const key of Object.keys(harnessEnvironment)) {
  if (key.toLowerCase() === (config.tokenEnv ?? 'TEAM_RELAY_BOT_TOKEN').toLowerCase()) delete harnessEnvironment[key];
}
const executor = new OfficialExecutor({ ...config.harness, env: harnessEnvironment }, async (text, suffix) => {
  if (executor.activeEvent) await api.reply(executor.activeEvent, text.slice(0, 9000), suffix);
});
let store, api;
let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
try {
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
    const bridge = new Bridge({ config, api, store, state, executor, bot });
    await bridge.resolveCurrent(values['retry-event'], values['skip-event']);
    console.log(JSON.stringify({ status: 'listening', cursor: state.cursor, conversations: config.conversationIds.length,
      authorizedSenders: config.senderIds.length, executor: 'official-dsh-sdk' }));
    let failures = 0;
    do {
      try {
        const processed = await bridge.poll(); failures = 0;
        if (processed) console.log(JSON.stringify({ status: 'processed', count: processed, cursor: state.cursor }));
      } catch (error) {
        // Ambiguous execution is an operator boundary, not a retry loop.
        if (['started', 'uncertain'].includes(state.current?.phase) || values.once) throw error;
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
