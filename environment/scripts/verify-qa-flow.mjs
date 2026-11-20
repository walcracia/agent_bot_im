import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { ImApi } from '../../workspace/bridge/core.mjs';
import { StateStore } from '../../workspace/bridge/state.mjs';
import { SuperCoordinator } from '../../workspace/bridge/super-coordinator.mjs';
import { SuperRouter } from '../../workspace/bridge/super-router.mjs';

const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { base, main, other, statePath, accounts } = fixture;
const real = new ImApi(base, accounts.dsh.token), admin = new ImApi(base, accounts.admin.token), outsider = new ImApi(base, accounts.outsider.token);
const checks = [], stats = { workerRuns: 0, fakeModelReservations: 0, realModelCalls: 0, codeCalls: 0, lostAcks: 0, conflicts: 0 };
let clock = Date.parse('2026-11-20T02:00:00Z'), coordinator, store;
const now = () => new Date(clock).toISOString();
const tick = () => { clock += 61000; };
const row = id => ({ id: String(id), projectId: '7', no: `DEMO-${id}`, title: 'Synthetic issue', status: 'open',
  description: 'Synthetic only 日期 2026-11-20 时间 10:00-10:15 时区 UTC+08:00', openedAt: '2026-11-20T01:00:00Z' });
const rows = [row(1)], files = new Map();
const adapter = {
  listIssues: async ({ pageIndex, pageSize }) => ({ data: rows.slice((pageIndex - 1) * pageSize, pageIndex * pageSize), count: rows.length }),
  listFiles: async issue => files.get(issue.id) ?? [],
  getIssue: async ({ issueId, no }) => structuredClone(rows.find(issue => issueId ? issue.id === String(issueId) : issue.no === no) ?? null),
};
let loseAck = true, conflict = true;
const api = { request: (...args) => real.request(...args), reply: async (event, text, suffix) => {
  if (conflict && text.includes('Synthetic report DEMO-4')) {
    conflict = false; stats.conflicts++;
    await real.reply(event, 'Synthetic conflicting prior message', suffix);
  }
  const result = await real.reply(event, text, suffix);
  if (loseAck && text.includes('Synthetic report DEMO-2')) { loseAck = false; stats.lostAcks++; throw new Error('Synthetic acknowledgement lost after HTTP commit'); }
  return result;
} };
const worker = { run: async (snapshot, { signal, beforeModel }) => {
  signal.throwIfAborted(); stats.workerRuns++; await beforeModel(); stats.fakeModelReservations++;
  return { status: 'completed', inputRevision: snapshot.inputRevision, text: `Synthetic report ${snapshot.externalIssueNo}`, report: { synthetic: true }, manifest: { synthetic: true } };
}, close: async () => {} };
const deniedCode = async () => { stats.codeCalls++; throw new Error('Coding pool must remain unused'); };
const pool = { prepare: deniedCode, start: deniedCode, input: deniedCode, cancel: deniedCode, close: async () => {} };
async function open() {
  store = new StateStore(statePath); await store.lock();
  const state = await store.read('synthetic-qa-flow');
  coordinator = new SuperCoordinator({ state, store, config: { projectId: 'synthetic-code-disabled', codeEnabled: false, maxWorkers: 1,
    conversationIds: [main], senderIds: [accounts.admin.user.id], botUsername: 'dsh' }, api, bot: accounts.dsh.user,
    router: new SuperRouter({ projectId: 'synthetic', classify: deniedCode }), pool, now,
    triage: { adapter, worker, options: { sourceId: 'qa-demo', pollMilliseconds: 1000, maxConcurrent: 1, totalModelCalls: 10, dailyModelCalls: 10,
      bindings: [{ sourceId: 'qa-demo', projectId: '7', projectCode: 'DEMO', conversationId: main }] } } });
  // Deterministic fault windows; every route, pump, persistence and HTTP method below is production code.
  coordinator.kick = () => {};
  await coordinator.initialize();
  await coordinator.ingestIm([], await real.request('/api/conversations'));
}
async function close() {
  await coordinator?.close(); coordinator = null;
  await store?.unlock(); store = null;
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  throw new Error('Synthetic phase timed out');
}
async function scan() { tick(); await coordinator.triage.pollSources(); await coordinator.routePending(); }
async function execute() { await coordinator.pump(); await until(() => coordinator.active.size === 0); await coordinator.writes; }
const tasks = () => Object.values(coordinator.data.tasks);
const outboxFor = id => Object.values(coordinator.data.outbox).find(item => item.taskId === id && item.category === 'result');
const messages = () => admin.request(`/api/conversations/${main}/messages?limit=100`);
const taskFor = no => tasks().find(task => task.externalIssueNo === no);
async function expectDenied(promise) { await assert.rejects(promise, /HTTP 403/u); }

try {
  await open(); await scan();
  assert.equal(tasks().length, 0); assert.equal(stats.workerRuns, 0);
  assert.equal(Object.keys(coordinator.data.triage.qa).length, 1);
  checks.push('Full synthetic QA baseline persisted with zero historical tasks');

  rows.push(row(2)); files.set('2', [{ id: '22' }]); await scan();
  let task = taskFor('DEMO-2'); assert.equal(task.id, 'T000001'); assert.equal(task.kind, 'log-triage');
  assert.equal(Object.values(coordinator.data.inbox).find(item => item.trigger?.externalIssueId === '2').decision.taskKind, 'log-triage');
  await execute(); assert.equal(taskFor('DEMO-2').status, 'completed');
  await coordinator.flushOutbox();
  assert.equal(outboxFor(task.id).status, 'pending'); assert.equal(stats.workerRuns, 1);
  assert.equal((await messages()).filter(message => message.text.includes('Synthetic report DEMO-2')).length, 1);
  checks.push('Typed QA route used unified task and real HTTP committed report despite lost acknowledgement');

  await close(); tick(); await open();
  assert.equal(taskFor('DEMO-2').id, 'T000001'); assert.equal(taskFor('DEMO-2').status, 'completed');
  await coordinator.flushOutbox(); await execute();
  assert.equal(outboxFor('T000001').status, 'sent'); assert.equal(stats.workerRuns, 1);
  const firstMessages = await messages();
  assert.equal(firstMessages.filter(message => message.text.includes('Synthetic report DEMO-2')).length, 1);
  assert.equal(new Set(firstMessages.map(message => message.client_id)).size, firstMessages.length);
  checks.push('Fresh StateStore restart replayed same report identity without another worker or model reservation');

  const count = tasks().length;
  await coordinator.ingestIm(firstMessages, await real.request('/api/conversations')); await coordinator.routePending();
  assert.equal(tasks().length, count); assert.equal(stats.workerRuns, 1);
  assert.equal((await real.request('/api/agent/events?after=0')).events.length, 0);
  await expectDenied(real.request(`/api/conversations/${other}/messages`));
  await expectDenied(outsider.request(`/api/conversations/${main}/messages`));
  checks.push('Bot replies did not return as work; other chat and outsider received no protected data');

  rows.push(row(3)); await scan();
  const cancelled = taskFor('DEMO-3');
  await admin.request(`/api/conversations/${main}/messages`, { text: `取消任务 #${cancelled.id}`, client_id: 'synthetic-cancel' });
  const events = await real.request(`/api/agent/events?after=${coordinator.state.cursor}`);
  await coordinator.ingestIm(events.events, await real.request('/api/conversations')); await coordinator.routePending(); await execute();
  assert.equal(taskFor('DEMO-3').status, 'cancelled'); assert.equal(stats.workerRuns, 1);
  checks.push('Real authorized chat cancellation stopped queued typed work before any model reservation');

  rows.push(row(4)); await scan(); await execute(); await coordinator.flushOutbox();
  const conflicted = taskFor('DEMO-4'); assert.equal(outboxFor(conflicted.id).status, 'paused');
  await coordinator.flushOutbox(); assert.equal(stats.workerRuns, 2); assert.equal(stats.conflicts, 1);
  assert.equal((await messages()).filter(message => message.text === 'Synthetic conflicting prior message').length, 1);
  checks.push('Real SQLite idempotency conflict returned HTTP 409 and paused retained report without rerunning work');

  rows.push(row(5)); await scan(); await execute();
  const revoked = taskFor('DEMO-5');
  const input = createInterface({ input: process.stdin });
  const approved = new Promise(resolve => input.once('line', resolve));
  process.stdout.write(JSON.stringify({ control: 'revoke_bot' }) + '\n');
  assert.equal(await approved, 'continue'); input.close();
  await coordinator.flushOutbox();
  assert.equal(outboxFor(revoked.id).status, 'paused');
  assert.equal((await messages()).filter(message => message.text.includes('Synthetic report DEMO-5')).length, 0);
  await expectDenied(real.request(`/api/conversations/${main}/messages`));
  checks.push('Actual temporary membership withdrawal paused sending and left retained report inaccessible to removed bot');

  assert.equal(stats.codeCalls, 0); assert.equal(stats.realModelCalls, 0);
  assert.equal(coordinator.data.triage.budget.total, stats.fakeModelReservations);
  const finalMessages = await messages();
  assert.equal(new Set(finalMessages.map(message => `${message.sender.id}:${message.client_id}`)).size, finalMessages.length);
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(persisted.superAgent.tasks[revoked.id].reportText, 'Synthetic report DEMO-5');
  const typedTasks = tasks().length; assert.equal(typedTasks, 4);
  checks.push('Persisted ledger retained reports, exact model reservations and unique message identities; coding pool unused');
  await close();
  process.stdout.write(JSON.stringify({ type: 'result', result: { checks, statistics: { ...stats, typedTasks, uniqueMessages: finalMessages.length, persistedRestarts: 1 } } }) + '\n');
} catch (cause) {
  await close().catch(() => {});
  // Synthetic fixture identifiers are harmless; suppress network/session bodies and all credentials.
  process.stderr.write(`${cause.name}: ${cause.message}\n`);
  process.exitCode = 1;
}
