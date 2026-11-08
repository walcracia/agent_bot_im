// Explicit live-model acceptance driver; never imported by the default test suite.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge, ImApi } from './core.mjs';
import { StateStore } from './state.mjs';
import { InstalledHeadlessExecutor } from './installed-headless.mjs';

const configPath = process.argv[2];
if (!configPath) throw new Error('Pass an isolated live-acceptance config file.');
const setup = JSON.parse(await fs.readFile(configPath, 'utf8'));
const { baseUrl, bot, eventId, priorMessageId, cwd, output, cliPath } = setup;
const api = new ImApi(baseUrl, process.env.TEAM_RELAY_BOT_TOKEN);
const options = { cwd, cliPath, runsPath: path.join(output, 'runs'), sessionMapPath: path.join(output, 'sessions.json'), auth: 'stored', permissionMode: 'danger-full-access', runTimeoutMs: 180000 };
const config = { baseUrl, projectName: 'agent-bot-im isolated acceptance fixture', triggerMode: 'auto', botUsername: bot.username,
  conversationIds: [setup.conversationId], senderIds: [setup.senderId], contextMessages: 20, contextCharacters: 12000, harness: { cwd } };
const store = new StateStore(path.join(output, 'bridge-state.json'));
let executor, restarted;
const counts = { classifierCalls: 0, workerCalls: 0 };
await store.lock();
try {
  let state = await store.read(`${baseUrl}|${bot.id}`);
  state.cursor = priorMessageId; state.autoInitialized = true;
  await store.write(state);
  executor = new InstalledHeadlessExecutor(options);
  const classify = executor.classify.bind(executor), session = executor.session.bind(executor);
  executor.classify = async prompt => { assert.equal(++counts.classifierCalls, 1, 'Live classifier call budget exceeded'); return classify(prompt); };
  executor.session = async (...args) => {
    const handle = await session(...args);
    return { run: async (...runArgs) => { assert.equal(++counts.workerCalls, 1, 'Live worker call budget exceeded'); return handle.run(...runArgs); } };
  };
  let lost = false;
  const realReply = api.reply.bind(api);
  api.reply = async (event, text, suffix) => {
    const result = await realReply(event, text, suffix);
    if (event.id === eventId && suffix === '0' && !lost) { lost = true; throw new Error('ACCEPTANCE_LOST_REPLY_ACK'); }
    return result;
  };
  const bridge = new Bridge({ config, api, store, state, executor, bot });
  await assert.rejects(bridge.poll(), /ACCEPTANCE_LOST_REPLY_ACK/);
  assert.equal(state.current.phase, 'reply');
  assert.equal(counts.classifierCalls, 1);
  assert.equal(counts.workerCalls, 1);
  await executor.close();
  // A new executor and reloaded durable state resend only the saved result.
  restarted = new InstalledHeadlessExecutor(options);
  restarted.classify = async () => { throw new Error('Restart must not reclassify'); };
  restarted.session = async () => { throw new Error('Restart must not rerun the worker'); };
  state = await store.read(`${baseUrl}|${bot.id}`);
  await new Bridge({ config, api, store, state, executor: restarted, bot }).poll();
  assert.equal(state.current, null);
  assert.equal(state.cursor, eventId);
  const messages = await api.request(`/api/conversations/${setup.conversationId}/messages?limit=100`);
  const final = messages.filter(message => message.client_id === `dsh-${eventId}-0`);
  assert.equal(final.length, 1);
  assert.ok(final[0].text.trim());
  await fs.writeFile(path.join(output, 'flow-result.json'), JSON.stringify({ live: true, ...counts, finalReplyCount: final.length, cursor: state.cursor, cachedReplyRecoveredWithoutModel: true, sourceEventHadMention: false }, null, 2));
  console.log('Real automatic IM → installed DSH worker → one cached IM reply completed.');
} finally {
  await executor?.close(); await restarted?.close(); await store.unlock();
}
