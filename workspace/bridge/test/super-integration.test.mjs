import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SuperCoordinator } from '../super-coordinator.mjs';
import { reference } from '../super-context.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const bot = { id: 'bot', username: 'dsh', is_bot: true }, person = { id: 'human', username: 'alice', is_bot: false };
const conversations = [{ id: 'c1', members: [bot, person] }];
const event = (id, text) => ({ id, text, conversation_id: 'c1', sender: person, created_at: '2026-11-09T08:00:00Z' });
async function until(predicate, message) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await predicate()) return; await delay(5); }
  assert.fail(message);
}

async function fixture(t, { delayedStart = false, delivery } = {}) {
  const ready = deferred(), completed = deferred(); let started = false;
  const f = { received: [], cancelledBeforeStart: 0, cancelled: 0, starts: 0, startEntered: false, ready, completed };
  if (!delayedStart) ready.resolve();
  const pool = {
    prepare: async task => ({ workspace: '/synthetic/worktrees/' + task.id, branch: 'codex/' + task.id }),
    start: async task => {
      f.startEntered = true; f.starts++; f.initialInputs = task.inputs;
      await ready.promise; started = true;
      return { completion: completed.promise };
    },
    input: async (id, input) => { if (!started) throw new Error('Native worker is not admitted yet'); f.received.push(input); return { accepted: true }; },
    cancel: async () => {
      if (!started) { f.cancelledBeforeStart++; return { processTreeStopped: true }; }
      f.cancelled++; started = false;
      const error = new Error('Owned test worker stopped'); error.processTreeStopped = true; completed.reject(error);
      return { processTreeStopped: true };
    },
    close: async () => { ready.resolve(); completed.reject(Object.assign(new Error('closed'), { processTreeStopped: true })); },
  };
  const config = { projectId: 'p1', conversationIds: ['c1'], senderIds: ['human'], maxWorkers: 2 };
  const store = { write: async () => {} }, api = { request: async () => conversations, reply: async () => ({ id: 99 }) };
  const router = { route: async events => events.map(item => ({ eventId: item.id, action: 'new', taskId: null,
    summary: 'Fix a synthetic issue', instructions: item.text })) };
  f.coordinator = new SuperCoordinator({ state: { cursor: 0 }, store, config, api, bot, router, pool, delivery });
  await f.coordinator.initialize();
  await f.coordinator.ingestIm([], conversations);
  t.after(() => f.coordinator.close());
  f.launch = async () => {
    await f.coordinator.ingestIm([event(1, 'Fix the synthetic bug')], conversations);
    await f.coordinator.routePending();
    await until(() => f.startEntered, 'Worker start was not reached');
  };
  return f;
}

test('stop accepted during native launch is honored after admission rather than treating idle as final cancellation', async t => {
  const f = await fixture(t, { delayedStart: true }); await f.launch();
  await f.coordinator.ingestIm([event(2, '取消任务 #T000001')], conversations);
  f.ready.resolve();
  await until(() => f.coordinator.active.size === 0, 'Stopped launch remained active');
  assert.equal(f.coordinator.data.tasks.T000001.status, 'cancelled');
  assert.equal(f.cancelled, 1, 'Native process admitted after the control must still be stopped');
});

test('followup accepted during launch is durably delivered after admission without failing the task', async t => {
  const f = await fixture(t, { delayedStart: true }); await f.launch();
  await f.coordinator.ingestIm([event(2, '#T000001 also cover empty input')], conversations);
  f.ready.resolve();
  await until(() => f.received.some(input => input.id === 'im:2'), 'Persisted launch-time followup was not reconciled to the worker');
  assert.notEqual(f.coordinator.data.tasks.T000001.status, 'paused');
  f.completed.resolve({ finalResponse: 'done' });
  await until(() => f.coordinator.active.size === 0, 'Worker did not settle');
  assert.equal(f.coordinator.data.tasks.T000001.status, 'completed');
});

test('PR merge during execution remains merged after the owned process is stopped', async t => {
  const f = await fixture(t); await f.launch();
  const threadId = 'github:owner/project:pr:7';
  await f.coordinator.transaction(data => { data.subscriptions[threadId] = ['T000001']; });
  await f.coordinator.ingestGithub({ events: [{ id: 'merged:7', kind: 'closed', source: 'github', taskId: 'T000001',
    threadId, text: 'Merged', at: '2026-11-09T08:05:00Z', meta: { merged: true } }], cursor: { version: 1 } });
  await until(() => f.coordinator.active.size === 0, 'Merged task execution did not stop');
  assert.equal(f.coordinator.data.tasks.T000001.status, 'merged');
  assert.equal(f.cancelled, 1);
});

test('successful CI observation updates delivery without starting a new code worker', async t => {
  let syncs = 0;
  const delivery = { deliver: async () => { throw new Error('No initial code delivery expected'); },
    sync: async task => { syncs++; return { ...task.delivery, merged: true }; } };
  const f = await fixture(t, { delivery }), c = f.coordinator, threadId = 'github:owner/project:pr:7';
  await c.transaction(data => {
    const task = { id: 'T000001', projectId: 'p1', conversationId: 'c1', event: event(1, 'old completed work'),
      summary: 'A ready pull request', instructions: 'Fix', status: 'ready', attempt: 1, inputs: [],
      reference: reference('task', 'T000001'), threadReference: reference('thread', 'im:c1'),
      delivery: { number: 7, url: 'https://github.com/owner/project/pull/7', threadId, head: 'a'.repeat(40) } };
    data.tasks[task.id] = task; data.subscriptions[threadId] = [task.id]; c.taskNode(data, task);
  });
  const ci = { id: 'ci:success', source: 'github', taskId: 'T000001', threadId, kind: 'ci', text: 'test success',
    at: '2026-11-09T08:10:00Z', meta: { head: 'a'.repeat(40), status: 'completed', conclusion: 'success' } };
  await c.ingestGithub({ events: [ci], cursor: { version: 1 } });
  await until(() => syncs > 0, 'Successful CI never reevaluated the delivery policy');
  assert.equal(f.starts, 0);
  const observed = c.data.tasks.T000001.lastCheck?.reference;
  assert.ok(observed && c.data.graph[observed]?.text.includes('ci:success'), 'Successful CI must remain reachable as task evidence');
  await c.ingestGithub({ events: [ci], cursor: { version: 1 } });
  assert.equal(syncs, 1, 'Repeated CI must not duplicate delivery');
});

test('trusted PR approval reevaluates merge without starting fresh coding work', async t => {
  let syncs = 0;
  const delivery = { sync: async task => { syncs++; return { ...task.delivery, merged: true }; } };
  const f = await fixture(t, { delivery }), c = f.coordinator, threadId = 'github:owner/project:pr:7';
  await c.transaction(data => {
    const task = { id: 'T000001', projectId: 'p1', conversationId: 'c1', event: event(1, 'old completed work'),
      summary: 'Reviewed pull request', instructions: 'Fix', status: 'ready', attempt: 1, inputs: [],
      reference: reference('task', 'T000001'), threadReference: reference('thread', 'im:c1'),
      delivery: { number: 7, url: 'https://github.com/owner/project/pull/7', threadId, head: 'a'.repeat(40) } };
    data.tasks[task.id] = task; data.subscriptions[threadId] = [task.id]; c.taskNode(data, task);
  });
  await c.ingestGithub({ events: [{ id: 'review:approved', source: 'github', taskId: 'T000001', threadId,
    kind: 'review', text: 'Looks good', at: '2026-11-09T08:10:00Z',
    meta: { state: 'APPROVED', commit: 'a'.repeat(40), head: 'a'.repeat(40) } }], cursor: { version: 1 } });
  await until(() => syncs > 0, 'PR approval did not reevaluate merge');
  assert.equal(f.starts, 0, 'Approving the task must not start it again');
});

test('old-head CI stays as evidence and repeated failures of the same head request only one repair', async t => {
  const f = await fixture(t), c = f.coordinator, threadId = 'github:owner/project:pr:7';
  await c.transaction(data => {
    const task = { id: 'T000001', projectId: 'p1', conversationId: 'c1', event: event(1, 'old completed work'),
      summary: 'Check feedback', instructions: 'Fix', status: 'ready', attempt: 1, inputs: [],
      reference: reference('task', 'T000001'), threadReference: reference('thread', 'im:c1'),
      delivery: { number: 7, url: 'https://github.com/owner/project/pull/7', threadId, head: 'b'.repeat(40) } };
    data.tasks[task.id] = task; data.subscriptions[threadId] = [task.id]; c.taskNode(data, task);
  });
  const ci = (id, head) => ({ id, source: 'github', taskId: 'T000001', threadId, kind: 'ci', text: 'test failure',
    at: '2026-11-09T08:10:00Z', meta: { head, status: 'completed', conclusion: 'failure' } });
  await c.ingestGithub({ events: [ci('old', 'a'.repeat(40))], cursor: { version: 1 } });
  assert.equal(f.starts, 0); assert.equal(c.data.tasks.T000001.inputs.length, 0);
  assert.ok(c.data.graph[c.data.tasks.T000001.lastCheck.reference].text.includes('old'));
  await c.ingestGithub({ events: [ci('fresh', 'b'.repeat(40))], cursor: { version: 1 } });
  await until(() => f.startEntered, 'Fresh head failure never reached its worker');
  await c.ingestGithub({ events: [ci('retry-same-head', 'b'.repeat(40))], cursor: { version: 1 } });
  assert.equal(c.data.tasks.T000001.autoRepairs, 1);
  assert.equal(c.data.tasks.T000001.inputs.length, 1);
  assert.equal(f.starts, 1);
});
