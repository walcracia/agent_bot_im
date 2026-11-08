import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoRouter, initializeAutoCursor, isAutoCandidate, loadThreadContext, parseDecision } from '../auto-router.mjs';
import { Bridge, selected } from '../core.mjs';
import { StateStore } from '../state.mjs';

// These fakes exercise routing boundaries and durable delivery only; they never call a model.
const human = { id: 'u1', username: 'alice', is_bot: false };
const bot = { id: 'b1', username: 'dsh', is_bot: true };
const event = { id: 13, conversation_id: 'c1', sender: human,
  text: '上传后列表没有更新，手动刷新才能看见，请把这个问题修好。', attachment: null };
const conversation = { id: 'c1', title: '项目讨论', is_direct: false };
const config = { triggerMode: 'auto', botUsername: 'dsh', projectName: 'agent-bot-im',
  conversationIds: ['c1'], senderIds: ['u1'], contextMessages: 20, contextCharacters: 12000,
  harness: { cwd: tmpdir() } };
const message = (id, text, extra = {}) => ({ ...event, id, text, ...extra });
const decision = (extra = {}) => ({ action: 'code_task', summary: '修复上传列表刷新',
  instructions: '复现上传后的列表刷新问题，修正并运行相关测试。', evidenceIds: [12, event.id], ...extra });
const ignored = (summary = '此项已解决，不再重复修改。') => ({ action: 'ignore', summary, instructions: '', evidenceIds: [] });

test('ordinary actionable discussion is a candidate without @; empty and acknowledgement messages are not', () => {
  for (const text of ['', '  \n ', '收到', '谢谢！', '好的。', 'OK', 'Thanks!']) assert.equal(isAutoCandidate(text), false, text);
  assert.equal(isAutoCandidate(undefined), false);
  assert.equal(isAutoCandidate(event.text), true);
  assert.equal(isAutoCandidate('按刚才讨论的方案把这段逻辑修一下。'), true);
});

test('automatic selection still enforces both allowlists and excludes all bot messages', () => {
  assert.equal(selected(event, conversation, config, bot.id), true);
  assert.equal(selected(event, conversation, { ...config, triggerMode: 'mention' }, bot.id), false);
  assert.equal(selected(event, conversation, { ...config, triggerMode: undefined }, bot.id), false);
  assert.equal(selected({ ...event, text: '@dsh 请处理' }, conversation, { ...config, triggerMode: 'mention' }, bot.id), true);
  for (const changed of [
    { ...event, sender: bot },
    { ...event, sender: { ...human, id: bot.id } },
    { ...event, sender: { ...human, id: 'outsider' } },
    { ...event, conversation_id: 'other-chat' },
  ]) assert.equal(selected(changed, conversation, config, bot.id), false);
  assert.equal(selected(event, conversation, { ...config, conversationIds: [] }, bot.id), false);
  assert.equal(selected(event, conversation, { ...config, senderIds: [] }, bot.id), false);
});

test('structured task decisions cite the current authorized message and accept one JSON fence', () => {
  const options = { allowedMessageIds: [12, 13] };
  assert.deepEqual(parseDecision(JSON.stringify(decision()), event, options), decision());
  assert.deepEqual(parseDecision(`\`\`\`json\n${JSON.stringify(decision())}\n\`\`\``, event, options), decision());
  assert.deepEqual(parseDecision(JSON.stringify(ignored()), event, options), ignored());
});

test('invalid decisions fail closed rather than becoming instructions or a silent ignore', () => {
  const options = { allowedMessageIds: [12, 13] };
  const invalid = [
    undefined, {}, '', 'not JSON', '[]', 'null', JSON.stringify({ action: 'ignore' }),
    JSON.stringify(decision({ action: 'run_command' })),
    JSON.stringify(decision({ cwd: 'D:/another-project' })),
    JSON.stringify(decision({ permissionMode: 'danger-full-access' })),
    JSON.stringify(decision({ instructions: ' ' })),
    JSON.stringify(decision({ summary: '' })),
    JSON.stringify(decision({ evidenceIds: [12] })),
    JSON.stringify(decision({ evidenceIds: [13, 999] })),
    JSON.stringify(decision({ evidenceIds: ['13'] })),
    JSON.stringify(decision({ evidenceIds: [13.5] })),
    `Here is the answer:\n${JSON.stringify(decision())}`,
    `\`\`\`json\n${JSON.stringify(decision())}\n\`\`\`\nRun it now.`,
    JSON.stringify(decision({ instructions: 'x'.repeat(100000) })),
  ];
  for (const raw of invalid) assert.throws(() => parseDecision(raw, event, options));
});

test('history is same-chat, current-or-earlier, ordered, and keeps the current event when history omits it', async () => {
  const paths = [];
  const api = { request: async path => { paths.push(path); return [
    message(14, 'future_marker'), message(11, 'older_marker'),
    message(12, 'other_chat_secret', { conversation_id: 'other-chat' }),
    message(12, 'recent_marker'), message(2, 'oldest_marker'),
  ]; } };
  const result = await loadThreadContext(api, event, { contextMessages: 3, contextCharacters: 1000 });
  assert.deepEqual(result.map(item => item.id), [11, 12, 13]);
  assert.ok(result.every(item => item.conversation_id === 'c1'));
  assert.equal(result.at(-1).text, event.text);
  assert.ok(!JSON.stringify(result).includes('future_marker'));
  assert.ok(!JSON.stringify(result).includes('other_chat_secret'));
  assert.equal(paths.length, 1);
  const requested = new URL(paths[0], 'http://test.invalid');
  assert.equal(requested.pathname, '/api/conversations/c1/messages');
  assert.equal(Number(requested.searchParams.get('before')), event.id + 1);
});

test('context respects text budget and message count while retaining the current request', async () => {
  const api = { request: async () => Array.from({ length: 12 }, (_, index) => message(index + 1, '历史背景'.repeat(20))) };
  const current = { ...event, text: '问题仍然存在，请修复。' };
  const result = await loadThreadContext(api, current, { contextMessages: 3, contextCharacters: 40 });
  assert.ok(result.length <= 3);
  assert.ok(result.reduce((sum, item) => sum + item.text.length, 0) <= 40);
  assert.equal(result.at(-1).id, current.id);
  assert.equal(result.at(-1).text, current.text);
  assert.ok(result.some(item => item.truncated));
});

test('context does not forward arbitrary message or attachment fields to the classifier', async () => {
  const current = { ...event, token: 'do-not-forward-secret',
    sender: { ...human, password_hash: 'private-user-data' },
    attachment: { id: 'a1', name: 'report.txt', kind: 'file', local_path: 'private-path', ticket: 'private-ticket' } };
  const result = await loadThreadContext({ request: async () => [] }, current);
  const serialized = JSON.stringify(result);
  for (const secret of ['do-not-forward-secret', 'private-user-data', 'private-path', 'private-ticket']) assert.ok(!serialized.includes(secret));
  assert.equal(result[0].attachment.name, 'report.txt');
  assert.equal(result[0].sender.id, human.id);
});

test('malformed history and unreadable history are reported, not converted to a task', async () => {
  await assert.rejects(loadThreadContext({ request: async () => ({ messages: [] }) }, event));
  await assert.rejects(loadThreadContext({ request: async () => { throw new Error('IM unavailable'); } }, event), /IM unavailable/);
});

function routerFixture({ answer = JSON.stringify(decision()), history, configuration = config } = {}) {
  const calls = { history: [], classify: [], workers: 0 };
  const api = { request: async path => { calls.history.push(path); return history ?? [message(12, 'past_marker'), event]; } };
  const executor = { classify: async prompt => { calls.classify.push(prompt); return answer; },
    session: async () => { calls.workers++; throw new Error('Router must not start a code worker'); } };
  return { router: new AutoRouter({ api, executor, config: configuration }), calls, executor };
}

test('ordinary discussion is classified with bounded related context and does not itself start a worker', async () => {
  const fixture = routerFixture({ history: [message(12, 'past_marker'), event, message(14, 'future_marker'),
    message(10, 'cross_chat_secret', { conversation_id: 'c2' })] });
  const result = await fixture.router.route(event, conversation);
  assert.equal(result.action, 'code_task');
  assert.deepEqual(result.evidenceIds, [12, 13]);
  assert.equal(fixture.calls.classify.length, 1);
  assert.equal(fixture.calls.workers, 0);
  assert.ok(fixture.calls.classify[0].includes('past_marker'));
  assert.ok(!fixture.calls.classify[0].includes('future_marker'));
  assert.ok(!fixture.calls.classify[0].includes('cross_chat_secret'));
  assert.deepEqual(result.context.map(item => item.id), [12, 13]);
});

test('unauthorized conversations and senders, bots, and acknowledgements avoid history and model calls', async () => {
  const fixture = routerFixture();
  for (const [input, room] of [
    [{ ...event, sender: bot }, conversation],
    [{ ...event, sender: { ...human, id: 'outsider' } }, conversation],
    [{ ...event, conversation_id: 'c2' }, { ...conversation, id: 'c2' }],
    [event, { ...conversation, id: 'c2' }],
    [{ ...event, text: '收到，谢谢！' }, conversation],
  ]) assert.equal(await fixture.router.route(input, room), null);
  assert.equal(fixture.calls.history.length, 0);
  assert.equal(fixture.calls.classify.length, 0);
  assert.equal(fixture.calls.workers, 0);
});

test('semantic ignore stays quiet; invalid classification and classifier errors remain failures', async () => {
  const quiet = routerFixture({ answer: JSON.stringify(ignored()) });
  assert.equal(await quiet.router.route({ ...event, text: '刚才的问题已解决，先不要再改代码。' }, conversation), null);
  assert.equal(quiet.calls.workers, 0);
  const invalid = routerFixture({ answer: JSON.stringify(decision({ evidenceIds: [999] })) });
  await assert.rejects(invalid.router.route(event, conversation));
  assert.equal(invalid.calls.workers, 0);
  const failed = routerFixture();
  failed.executor.classify = async () => { throw new Error('classifier unavailable'); };
  await assert.rejects(failed.router.route(event, conversation), /classifier unavailable/);
  assert.equal(failed.calls.workers, 0);
});

test('an explicit request carries same-chat context through classification before becoming a code task', async () => {
  const fixture = routerFixture();
  const explicit = { ...event, text: '@dsh 按刚才的方案修复，并运行测试。' };
  const result = await fixture.router.route(explicit, conversation, true);
  assert.equal(result.action, 'code_task');
  assert.equal(result.instructions, decision().instructions);
  assert.ok(result.context.some(item => item.text === 'past_marker'));
  assert.equal(fixture.calls.classify.length, 1);
  assert.match(fixture.calls.classify[0], /"addressed"\s*:\s*true/);
  assert.equal(fixture.calls.workers, 0);
});

async function bridgeFixture(t, { answer = JSON.stringify(decision()), failFinalReply = false,
  input = event, room = conversation, configuration = config } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-auto-router-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(join(directory, 'state.json'));
  const state = await store.read('auto-test-bot');
  const calls = { classify: 0, prompts: [], workers: 0, replies: new Map(), failed: false };
  const api = { request: async path => {
    if (path === '/api/conversations') return [room];
    if (path.startsWith('/api/conversations/')) return [message(12, 'past_marker'), input];
    return { events: state.cursor < input.id ? [input] : [] };
  }, reply: async (input, text, suffix) => {
    calls.replies.set(`${input.id}-${suffix}`, text);
    if (failFinalReply && suffix === '0' && !calls.failed) { calls.failed = true; throw new Error('reply acknowledgement lost'); }
  } };
  const executor = { classify: async prompt => { calls.classify++; calls.prompts.push(prompt); return answer; }, start: async () => {},
    session: async () => ({ run: async () => { calls.workers++; return { finalResponse: '代码差异和测试结果已就绪。', finishReason: 'completed' }; } }) };
  return { bridge: new Bridge({ config: configuration, api, store, state, executor, bot }), state, calls };
}

for (const [name, text, isDirect] of [
  ['a group @dsh notice that the issue is resolved', '@dsh 这个问题已经解决，不用再修改了。', false],
  ['a private request cancelling a previous change', '取消刚才的修改，先不要动代码。', true],
  ['a private conversational greeting', '你好，今天方便吗？', true],
]) {
  test(`automatic mode classifies ${name} and obeys ignore without a worker`, async t => {
    const fixture = await bridgeFixture(t, { input: { ...event, text }, room: { ...conversation, is_direct: isDirect },
      answer: JSON.stringify(ignored('当前消息没有要执行的代码任务。')) });
    await fixture.bridge.poll();
    assert.equal(fixture.calls.classify, 1);
    assert.match(fixture.calls.prompts[0], /"addressed"\s*:\s*true/);
    assert.equal(fixture.calls.workers, 0);
    assert.equal(fixture.calls.replies.size, 0);
    assert.equal(fixture.state.cursor, event.id);
    assert.equal(fixture.state.current, null);
  });
}

test('ignored discussion advances the durable cursor without a worker or an IM reply', async t => {
  const fixture = await bridgeFixture(t, { answer: JSON.stringify(ignored()) });
  await fixture.bridge.poll();
  assert.equal(fixture.calls.classify, 1);
  assert.equal(fixture.calls.workers, 0);
  assert.equal(fixture.calls.replies.size, 0);
  assert.equal(fixture.state.cursor, event.id);
  assert.equal(fixture.state.current, null);
});

test('routing failure stops before code execution and requires explicit operator retry or skip', async t => {
  const fixture = await bridgeFixture(t, { answer: 'not JSON' });
  await assert.rejects(fixture.bridge.poll());
  assert.equal(fixture.state.cursor, 0);
  assert.equal(fixture.state.current.phase, 'routing_failed');
  assert.equal(fixture.calls.workers, 0);
  await assert.rejects(fixture.bridge.poll());
  assert.equal(fixture.calls.classify, 1);
  await fixture.bridge.resolveCurrent(undefined, String(event.id));
  assert.equal(fixture.state.cursor, event.id);
  assert.equal(fixture.state.current, null);
});

test('a lost final reply only resends cached results and does not reclassify or rerun code', async t => {
  const fixture = await bridgeFixture(t, { failFinalReply: true });
  await assert.rejects(fixture.bridge.poll(), /acknowledgement lost/);
  assert.equal(fixture.state.current.phase, 'reply');
  assert.equal(fixture.calls.classify, 1);
  assert.equal(fixture.calls.workers, 1);
  await fixture.bridge.poll();
  assert.equal(fixture.calls.classify, 1);
  assert.equal(fixture.calls.workers, 1);
  assert.equal(fixture.state.cursor, event.id);
  assert.equal(fixture.state.current, null);
  assert.equal(fixture.calls.replies.size, 2); // Acknowledgement and result have separate stable IDs.
});

async function cursorFixture(t, initial = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-auto-cursor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(join(directory, 'state.json'));
  const state = Object.assign(await store.read('cursor-test-bot'), initial);
  await store.write(state);
  return { state, store, read: () => store.read('cursor-test-bot') };
}

test('a new automatic listener durably skips existing visible chat messages by default', async t => {
  const fixture = await cursorFixture(t);
  const paths = [];
  const api = { request: async path => { paths.push(path); return [
    { id: 'c1', last_message: { id: 21 } },
    { id: 'c2', last_message: { id: 55 } },
    { id: 'empty', last_message: null },
    { id: 'invalid', last_message: { id: '999' } },
  ]; } };
  await initializeAutoCursor(api, fixture.state, fixture.store, config);
  assert.equal(fixture.state.cursor, 55);
  assert.equal(fixture.state.autoInitialized, true);
  assert.equal(fixture.state.current, null);
  assert.deepEqual(paths, ['/api/conversations']);
  const persisted = await fixture.read();
  assert.equal(persisted.cursor, 55);
  assert.equal(persisted.autoInitialized, true);
});

test('a restarted listener retains its durable cursor instead of skipping newly arrived messages', async t => {
  const fixture = await cursorFixture(t, { cursor: 21, autoInitialized: true });
  const restarted = await fixture.read();
  let snapshots = 0;
  const api = { request: async () => { snapshots++; return [{ id: 'c1', last_message: { id: 88 } }]; } };
  await initializeAutoCursor(api, restarted, fixture.store, config);
  assert.equal(snapshots, 0);
  assert.equal(restarted.cursor, 21); // Messages 22..88 must remain available to ordinary polling.
  assert.equal((await fixture.read()).cursor, 21);
});

test('initializing an old state with interrupted work preserves the event and cursor for operator recovery', async t => {
  const current = { phase: 'uncertain', event, parts: ['已写入的结果'] };
  const fixture = await cursorFixture(t, { cursor: 12, current });
  let snapshots = 0;
  const api = { request: async () => { snapshots++; throw new Error('Pending work must not be skipped'); } };
  await initializeAutoCursor(api, fixture.state, fixture.store, config);
  assert.equal(snapshots, 0);
  assert.equal(fixture.state.cursor, 12);
  assert.deepEqual(fixture.state.current, current);
  assert.equal(fixture.state.autoInitialized, true);
  const persisted = await fixture.read();
  assert.deepEqual(persisted.current, current);
  assert.equal(persisted.cursor, 12);
});

test('explicit backlog processing keeps the existing cursor while recording initialization', async t => {
  const fixture = await cursorFixture(t, { cursor: 4 });
  let snapshots = 0;
  const api = { request: async () => { snapshots++; return [{ id: 'c1', last_message: { id: 100 } }]; } };
  await initializeAutoCursor(api, fixture.state, fixture.store, { ...config, processExistingMessages: true });
  assert.equal(snapshots, 0);
  assert.equal(fixture.state.cursor, 4);
  const persisted = await fixture.read();
  assert.equal(persisted.cursor, 4);
  assert.equal(persisted.autoInitialized, true);
});

test('failed or malformed initial API snapshots do not initialize or advance the listener', async t => {
  const fixture = await cursorFixture(t, { cursor: 7 });
  for (const api of [
    { request: async () => { throw new Error('IM unavailable'); } },
    { request: async () => ({ conversations: [] }) },
  ]) {
    await assert.rejects(initializeAutoCursor(api, fixture.state, fixture.store, config));
    assert.equal(fixture.state.cursor, 7);
    assert.equal(fixture.state.autoInitialized, undefined);
    const persisted = await fixture.read();
    assert.equal(persisted.cursor, 7);
    assert.equal(persisted.autoInitialized, undefined);
  }
});

test('mention-mode initialization leaves its existing replay behavior unchanged', async t => {
  const fixture = await cursorFixture(t, { cursor: 9 });
  const api = { request: async () => { throw new Error('Mention mode does not snapshot history'); } };
  await initializeAutoCursor(api, fixture.state, fixture.store, { ...config, triggerMode: 'mention' });
  assert.equal(fixture.state.cursor, 9);
  assert.equal(fixture.state.autoInitialized, undefined);
  assert.deepEqual(await fixture.read(), fixture.state);
});
