import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SuperCoordinator } from '../super-coordinator.mjs';
import { SuperRouter, parseRoutes, taskControl } from '../super-router.mjs';
import { putNode, readNode, reference } from '../super-context.mjs';
import { createControlServer } from '../super-agent.mjs';

const bot = { id: 'bot', username: 'dsh', is_bot: true }, human = { id: 'human', is_bot: false };
const conversations = [{ id: 'chat', members: [bot, human] }];
const event = (id, text, sender = human, conversation_id = 'chat') => ({ id, text, sender, conversation_id, created_at: new Date().toISOString() });
async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(5); } assert.fail('Condition timed out.'); }
async function fixture(t, extras = {}) {
  const runs = new Map(), replies = [], saved = [], starts = [];
  const pool = { prepare: async task => ({ workspace: '/work/' + task.id, branch: 'codex/super/' + task.id }),
    start: async (task, { onProgress }) => {
      let resolve, reject; const completion = new Promise((yes, no) => { resolve = yes; reject = no; }); completion.catch(() => {});
      runs.set(task.id, { resolve, reject, onProgress }); starts.push(task.id); return { completion };
    }, input: async (id, input) => { await runs.get(id).onProgress({ inputIds: [input.id], summary: 'Consumed input' }); return { delivered: true }; },
    cancel: async id => { runs.get(id)?.reject(Object.assign(new Error('stopped'), { processTreeStopped: true })); return { processTreeStopped: true }; },
    close: async () => { for (const run of runs.values()) run.reject(Object.assign(new Error('closed'), { processTreeStopped: true })); },
    inspect: async () => ({ diff: 'one file changed' }), ...extras.pool };
  const c = new SuperCoordinator({ state: extras.state ?? { cursor: 0 }, store: { write: async value => saved.push(structuredClone(value)) },
    config: { projectId: 'p', conversationIds: ['chat'], senderIds: ['human'], maxWorkers: 2 }, api: { request: async () => conversations,
      reply: async (message, text, id) => { replies.push({ message, text, id }); if (extras.reply) return extras.reply(message, text, id); return { id: 99 }; } },
    bot, pool, delivery: extras.delivery, release: extras.release,
    router: { route: async events => events.map(item => ({ eventId: item.id, action: 'new', summary: item.text, instructions: item.text })) } });
  await c.initialize(); await c.ingestIm([], conversations);
  t.after(() => c.close()); return { c, runs, replies, saved, starts };
}

test('two workers run concurrently, third queues, and intake handles stop while workers are unresolved', async t => {
  const f = await fixture(t);
  await f.c.ingestIm([event(1, 'Fix first'), event(2, 'Fix second'), event(3, 'Fix third')], conversations);
  await f.c.routePending(); await until(() => f.starts.length === 2);
  assert.equal(f.c.data.tasks.T000003.status, 'queued');
  await f.c.ingestIm([event(4, '取消任务 #T000001')], conversations);
  await until(() => f.starts.length === 3);
  assert.equal(f.c.data.tasks.T000001.status, 'cancelled');
  assert.equal(f.c.data.tasks.T000002.status, 'running');
});

test('unauthorized members, bots and other conversations cannot form tasks', async t => {
  const f = await fixture(t);
  await f.c.ingestIm([event(1, 'Fix', bot), event(2, 'Fix', { id: 'outsider', is_bot: false }), event(3, 'Fix', human, 'elsewhere')], conversations);
  await f.c.routePending(); assert.equal(Object.keys(f.c.data.tasks).length, 0); assert.equal(f.c.state.cursor, 3);
});

test('event replay and lost reply acknowledgement cannot repeat a worker', async t => {
  let fails = true;
  const f = await fixture(t, { reply: async () => { if (fails) { fails = false; throw new Error('Acknowledgement lost'); } return { id: 100 }; } });
  await f.c.ingestIm([event(1, 'Fix')], conversations); await f.c.routePending(); await until(() => f.starts.length === 1);
  await f.c.ingestIm([event(1, 'Fix')], conversations);
  f.runs.get('T000001').resolve({ finalResponse: 'fixed' }); await until(() => f.c.active.size === 0);
  for (const item of Object.values(f.c.data.outbox)) item.nextAttempt = null;
  await f.c.flushOutbox(); assert.equal(f.starts.length, 1);
  assert.equal(new Set(f.replies.filter(item => /已接到任务/u.test(item.text)).map(item => item.id)).size, 1);
});

test('restart preserves an in-flight task as paused and does not invoke a model or create replacement work', async t => {
  const f = await fixture(t); await f.c.ingestIm([event(1, 'Fix')], conversations); await f.c.routePending(); await until(() => f.starts.length === 1);
  const state = structuredClone(f.c.state);
  const recovered = await fixture(t, { state });
  assert.equal(recovered.c.data.tasks.T000001.status, 'paused'); assert.equal(recovered.starts.length, 0);
  assert.equal(recovered.c.data.tasks.T000001.workspace, '/work/T000001');
});

test('attempt start time remains stable while activity is published for semantic supervision', async t => {
  const f = await fixture(t); await f.c.ingestIm([event(1, 'Fix')], conversations); await f.c.routePending(); await until(() => f.starts.length === 1);
  const start = f.c.data.tasks.T000001.startedAt;
  await f.runs.get('T000001').onProgress({ events: [{ type: 'tool', name: 'same tool' }] }); await f.c.writes;
  assert.ok(start); assert.equal(f.c.data.tasks.T000001.startedAt, start);
});

test('context reference graph offers text and link continuation without crossing projects/conversations', () => {
  const graph = {}, links = [];
  for (let i = 0; i < 45; i++) { const id = reference('trigger', i); links.push(id); putNode(graph, { id, kind: 'trigger', projectId: 'p', conversations: ['a'], text: 'message ' + i }); }
  putNode(graph, { id: 'root', kind: 'thread', projectId: 'p', conversations: ['a'], text: 'a'.repeat(9000), links });
  putNode(graph, { id: 'secret', kind: 'trigger', projectId: 'other', conversations: ['a'], text: 'private' });
  graph.root.links.push('secret');
  const scope = { projectId: 'p', conversations: ['a'], limit: 1000 };
  const first = readNode(graph, 'root', scope); assert.equal(first.next.offset, 1000); assert.equal(first.links.length, 40);
  assert.equal(readNode(graph, 'root', { ...scope, ...first.nextLinks }).links.length, 5);
  assert.throws(() => readNode(graph, 'secret', scope)); assert.throws(() => readNode(graph, 'root', { ...scope, conversations: ['b'] }));
});

test('Router rejects foreign task IDs, repeated events and arbitrary policy fields', () => {
  const events = [event(1, 'Fix')], tasks = [{ id: 'T000001', conversationId: 'different' }];
  assert.throws(() => parseRoutes(JSON.stringify([{ eventId: 1, action: 'followup', taskId: 'T000001', summary: '', instructions: 'do it' }]), events, tasks));
  assert.throws(() => parseRoutes(JSON.stringify([{ eventId: 1, action: 'new', taskId: null, summary: 'Fix', instructions: 'Fix', cwd: '/other' }]), events, []));
  assert.equal(taskControl('继续讨论', []), null);
  assert.equal(taskControl('取消任务', [{ id: 'T000001', status: 'running' }, { id: 'T000002', status: 'running' }]).action, 'ambiguous');
});

test('fast task controls and explicit followups do not wait for a semantic classifier', async () => {
  let called = false;
  const router = new SuperRouter({ projectId: 'p', classify: async () => { called = true; throw new Error('Must not call'); } });
  const tasks = [{ id: 'T000001', conversationId: 'chat', status: 'running' }];
  const result = await router.route([event(1, '停止任务 #T000001'), event(2, '#T000001 cover empty input')], { tasks, context: [] });
  assert.equal(called, false); assert.deepEqual(result.map(item => item.action), ['stop', 'followup']);
});

test('task recall capability cannot access supervisor endpoints or a different task', async t => {
  const f = await fixture(t); await f.c.ingestIm([event(1, 'Fix')], conversations); await f.c.routePending(); await until(() => f.starts.length === 1);
  const master = 'm'.repeat(64), taskToken = 't'.repeat(64), api = createControlServer(f.c, { port: 0, token: master, taskTokenFor: id => id === 'T000001' ? taskToken : '' });
  const address = await api.start(); t.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base + '/api/supervisor/snapshot', { headers: { Authorization: 'Bearer ' + taskToken } })).status, 403);
  const body = { taskId: 'T000001', reference: f.c.data.tasks.T000001.reference };
  const read = await fetch(base + '/api/context/read', { method: 'POST', headers: { Authorization: 'Bearer ' + taskToken }, body: JSON.stringify(body) });
  assert.equal(read.status, 200);
  assert.equal((await fetch(base + '/api/context/read', { method: 'POST', headers: { Authorization: 'Bearer ' }, body: JSON.stringify({ taskId: 'invalid', reference: 'x' }) })).status, 403);
});

test('confirmed merge triggers the separate release pipeline once and reports its verified URL', async t => {
  let releases = 0;
  const f = await fixture(t, { delivery: { deliver: async () => ({ merged: true, number: 7, url: 'https://github.com/owner/repo/pull/7', head: 'a'.repeat(40), threadId: 'github:owner/repo:pr:7' }) },
    release: { run: async task => { releases++; assert.equal(task.status, 'merged'); return { url: 'https://github.com/owner/repo/releases/tag/v1.0.0' }; } } });
  await f.c.ingestIm([event(1, 'Fix')], conversations); await f.c.routePending(); await until(() => f.starts.length === 1);
  f.runs.get('T000001').resolve({ finalResponse: 'done' });
  await until(() => f.c.data.tasks.T000001.releaseStatus === 'completed'); f.c.kick(); await delay(10);
  assert.equal(releases, 1); assert.equal(f.c.data.tasks.T000001.status, 'merged');
});

test('uncertain artifact build preserves merged code and needs attention without automatically rebuilding', async t => {
  let releases = 0;
  const f = await fixture(t, { delivery: { deliver: async () => ({ merged: true, number: 7, url: 'https://github.com/owner/repo/pull/7', head: 'a'.repeat(40), threadId: 'github:owner/repo:pr:7' }) },
    release: { run: async () => { releases++; throw new Error('Previous build outcome is uncertain'); } } });
  await f.c.ingestIm([event(1, 'Fix')], conversations); await f.c.routePending(); await until(() => f.starts.length === 1);
  f.runs.get('T000001').resolve({ finalResponse: 'done' });
  await until(() => f.c.data.tasks.T000001.releaseStatus === 'needs_attention'); f.c.kick(); await delay(10);
  assert.equal(releases, 1); assert.equal(f.c.data.tasks.T000001.status, 'merged');
});

test('revoking the task author stops only that worker and denies future task context reads', async t => {
  const f = await fixture(t); await f.c.ingestIm([event(1, 'Fix')], conversations); await f.c.routePending(); await until(() => f.starts.length === 1);
  await f.c.ingestIm([], [{ id: 'chat', members: [bot] }]); await until(() => f.c.active.size === 0);
  assert.equal(f.c.data.tasks.T000001.status, 'paused');
  assert.throws(() => f.c.readContext('T000001', f.c.data.tasks.T000001.reference));
});

test('linked task threads fan out feedback as context and a related PR closing does not end another task', async t => {
  const f = await fixture(t);
  await f.c.ingestIm([event(1, 'Fix first'), event(2, 'Fix second')], conversations); await f.c.routePending(); await until(() => f.starts.length === 2);
  const threadId = 'github:owner/repo:pr:7';
  await f.c.transaction(data => { data.tasks.T000001.delivery = { number: 7, threadId }; data.subscriptions[threadId] = ['T000001']; });
  await f.c.ingestIm([event(3, '关联任务 #T000001 #T000002')], conversations);
  assert.deepEqual(f.c.data.subscriptions[threadId], ['T000001', 'T000002']);
  const comment = { id: 'comment-7', source: 'github', taskId: 'T000001', threadId, kind: 'comment', text: 'Please handle the empty case', at: new Date().toISOString() };
  await f.c.ingestGithub({ events: [comment], cursor: {} });
  await f.c.ingestGithub({ events: [comment], cursor: {} });
  assert.equal(f.c.data.tasks.T000001.inputs.filter(input => input.source === 'github').length, 1);
  assert.equal(f.c.data.tasks.T000002.inputs.filter(input => input.source === 'github-context').length, 1);
  await f.c.ingestGithub({ events: [{ ...comment, id: 'closed-7', kind: 'closed', text: 'Merged', meta: { merged: true } }], cursor: {} });
  await until(() => !f.c.active.has('T000001'));
  assert.equal(f.c.data.tasks.T000001.status, 'merged'); assert.equal(f.c.data.tasks.T000002.status, 'running');
});

test('an offline device retains unadmitted work in the queue and reconnects without losing the task identity', async t => {
  let offline = true;
  const f = await fixture(t, { pool: { prepare: async task => {
    if (offline) throw Object.assign(new Error('device offline'), { offline: true, safeToRetry: true });
    return { workspace: '/work/' + task.id, branch: 'codex/super/' + task.id };
  } } });
  await f.c.ingestIm([event(1, 'Fix on a remote device')], conversations); await f.c.routePending();
  await until(() => f.c.data.tasks.T000001.deviceStatus === 'offline' && f.c.active.size === 0);
  assert.equal(f.starts.length, 0); assert.equal(f.c.data.tasks.T000001.status, 'queued');
  offline = false; await f.c.transaction(data => { data.tasks.T000001.retryAt = null; }); f.c.kick();
  await until(() => f.starts.length === 1); assert.equal(f.starts[0], 'T000001');
});
