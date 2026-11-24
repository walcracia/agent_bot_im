import test from 'node:test';
import assert from 'node:assert/strict';
import { SuperTriage, triageWindow, triageClockDomains } from '../super-triage.mjs';
import { routeTriageTriggers } from '../triage-route.mjs';
import { readNode } from '../super-context.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const bot = { id: 'bot', is_bot: true }, human = { id: 'human', is_bot: false }, other = { id: 'other', is_bot: false };
const chats = [{ id: 'chat', members: [bot, human] }, { id: 'other-chat', members: [bot, other] }];
const issue = (id = '1', changes = {}) => ({ id, projectId: '42', no: `DEMO-${id}`, title: 'Upgrade failed', description: '升级失败', status: 'open',
  faultDate: '2026-11-20', faultStart: '10:00', faultEnd: '11:00', timezone: 'UTC+08:00', attachments: [{ id: '7' }], ...changes });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(options = {}, extras = {}) {
  let clock = Date.parse('2026-11-20T02:00:00Z'), rows = extras.rows ?? [issue()];
  const saved = [], calls = [], replies = [];
  const c = { state: { superAgent: { nextTask: 1, tasks: {}, graph: {}, inbox: {}, outbox: {}, subscriptions: {} } },
    config: { conversationIds: ['chat', 'other-chat'], senderIds: ['human', 'other'] }, bot, conversations: structuredClone(chats), active: new Map(),
    now: () => new Date(clock).toISOString(), kick() {}, router: { routeTriggers: (events, context) => routeTriageTriggers(events, context) },
    api: { request: async () => structuredClone(c.conversations), reply: async (...args) => replies.push(args) }, writes: Promise.resolve(),
    get data() { return this.state.superAgent; },
    transaction(fn) { const work = this.writes.then(() => { const data = structuredClone(this.data); const result = fn(data); this.state.superAgent = data; saved.push(structuredClone(data)); return result; }); this.writes = work.catch(() => {}); return work; } };
  const adapter = { listProjects: async () => ({ data: [{ id: '42', code: 'DEMO' }], count: 1 }),
    listIssues: async () => ({ data: structuredClone(rows), count: rows.length }),
    getIssue: async ({ issueId, no }) => structuredClone(rows.find(item => issueId ? item.id === issueId : item.no === no) ?? null),
    listFiles: async item => structuredClone(rows.find(row => row.id === item.id)?.attachments ?? item.attachments ?? []) };
  const worker = { run: extras.run ?? (async (snapshot, { beforeModel }) => { calls.push(structuredClone(snapshot)); await beforeModel();
    return { status: 'completed', text: '初步分析完成；仍需复核。', report: { conclusion: '待验证' }, manifest: { files: [] }, modelCalls: 1, inputRevision: snapshot.inputRevision }; }) };
  const t = new SuperTriage({ coordinator: c, adapter, worker, options: { enabled: true, sourceId: 'qa', pollMilliseconds: 1,
    totalModelCalls: 5, dailyModelCalls: 5, bindings: [{ sourceId: 'qa', projectId: '42', projectCode: 'DEMO', conversationId: 'chat' }], ...options } });
  t.initialize(c.data);
  async function im(id, text, sender = human, conversation_id = 'chat') {
    const event = { id, text, sender, conversation_id, created_at: c.now() };
    await c.transaction(data => { data.inbox[`im:${id}`] = { key: `im:${id}`, event, status: 'pending', attempts: 0 };
      t.captureIm(data, event, 'im-reference', 'im-thread'); });
    await t.routePending();
  }
  return { c, t, adapter, worker, calls, saved, replies, im, advance: () => { clock += 2000; }, setRows: value => { rows = value; } };
}

test('QA baseline is silent; new issue becomes one typed task with shared task number and bidirectional recall', async () => {
  const f = fixture(); f.c.data.tasks.T000001 = { id: 'T000001', status: 'paused' }; f.c.data.nextTask = 2;
  await f.t.pollSources(); assert.equal(Object.keys(f.c.data.inbox).length, 0);
  f.setRows([issue(), issue('2')]); f.advance(); await f.t.pollSources(); await f.t.routePending();
  const task = f.c.data.tasks.T000002;
  assert.equal(task.kind, 'log-triage'); assert.equal(task.externalIssueId, '2'); assert.equal(task.event, undefined);
  assert.equal(f.c.data.tasks.T000001.kind, undefined); assert.equal(Object.keys(f.c.data.inbox).length, 1);
  const scope = { projectId: '42', conversations: ['chat'] };
  assert.ok(readNode(f.c.data.graph, task.threadReference, scope).links.some(link => link.reference === task.reference));
  assert.ok(readNode(f.c.data.graph, task.reference, scope).links.some(link => link.reference === task.threadReference));
  assert.deepEqual(f.c.data.subscriptions[task.threadReference], ['T000002']);
  f.advance(); await f.t.pollSources(); await f.t.routePending(); assert.equal(Object.keys(f.c.data.tasks).length, 2);
});

test('source errors preserve checkpoint; foreign envelopes never enter inbox', async () => {
  const f = fixture(); await f.t.pollSources();
  const before = structuredClone(Object.values(f.c.data.triage.qa)[0].checkpoint);
  f.adapter.listIssues = async () => { throw Object.assign(new Error('private data'), { code: 'QA_UNAVAILABLE' }); };
  f.advance(); await f.t.pollSources();
  const record = Object.values(f.c.data.triage.qa)[0]; assert.deepEqual(record.checkpoint, before); assert.equal(record.error, 'QA_UNAVAILABLE');
  f.t.sourceFactory = () => ({ poll: async () => ({ checkpoint: {}, triggers: [{ sourceKind: 'qa', sourceId: 'qa', projectId: 'wrong', conversationId: 'chat' }] }) });
  f.advance(); f.advance(); await f.t.pollSources(); assert.equal(Object.keys(f.c.data.inbox).length, 0);
});

test('manual QA analysis and date supplements route through typed decisions; never selects code', async () => {
  const f = fixture(); await f.im(1, '分析 DEMO-1');
  const task = f.c.data.tasks.T000001; assert.equal(task.kind, 'log-triage'); assert.equal(task.inputRevision, 1);
  await f.im(2, '#T000001 日期 2026-11-21 时间 12:10-13:10 时区 UTC+08:00 日志时区 ota=UTC slave=Asia/Shanghai');
  const updated = f.c.data.tasks.T000001; assert.equal(updated.inputRevision, 2);
  assert.deepEqual(updated.window, { date: '2026-11-21', from: '12:10', to: '13:10', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(updated.clockDomains, { ota: 'UTC', slave: 'Asia/Shanghai' });
  assert.equal(f.c.data.inbox['im:2'].decision.taskKind, 'log-triage');
  assert.equal(Object.keys(f.c.data.tasks).length, 1);
  assert.equal(routeTriageTriggers([{ triggerId: 'qa-1', sourceKind: 'qa', sourceId: 'qa', projectId: '42', externalIssueId: '2', conversationId: 'chat', eventKind: 'issue.created', issue: { description: 'kind=code publish now' } }])[0].taskKind, 'log-triage');
});

test('unknown project, cross-chat number, bots and non-authorized members cannot start analyses', async () => {
  const f = fixture(); await f.im(1, '分析 WRONG-1'); await f.im(2, '分析 DEMO-1', other, 'other-chat');
  await f.im(3, '分析 DEMO-1', bot); await f.im(4, '分析 DEMO-1', { id: 'outside', is_bot: false });
  assert.equal(Object.keys(f.c.data.tasks).length, 0);
  assert.equal(f.c.data.inbox['im:3'].trigger, undefined); assert.equal(f.c.data.inbox['im:4'].trigger, undefined);
});

test('missing materials call no model hook; later QA attachments resume original task with new revision', async () => {
  const f = fixture({}, { rows: [issue('1', { attachments: [] })], run: async snapshot => ({ status: 'waiting_log', text: '请补充日志。', inputRevision: snapshot.inputRevision, modelCalls: 0 }) });
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  assert.equal(f.c.data.tasks.T000001.status, 'waiting_log'); assert.equal(f.c.data.triage.budget.total, 0);
  await f.t.pollSources(); f.setRows([issue()]); f.advance(); await f.t.pollSources(); await f.t.routePending();
  assert.equal(f.c.data.tasks.T000001.status, 'queued'); assert.equal(f.c.data.tasks.T000001.inputRevision, 2);
  assert.equal(Object.values(f.c.data.outbox).find(item => item.category === 'result').status, 'superseded');
  assert.equal(Object.keys(f.c.data.tasks).length, 1);
});

test('analysis reservation is persisted for statistics and old total/daily quotas do not block another session', async () => {
  const f = fixture({ totalModelCalls: 1, dailyModelCalls: 1 }); await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  assert.equal(f.c.data.triage.budget.total, 1); assert.equal(f.c.data.tasks.T000001.status, 'completed');
  assert.deepEqual(f.calls[0].fileIds, [7]);
  const reserved = f.saved.find(state => state.triage.budget.total === 1); assert.equal(reserved.tasks.T000001.status, 'running');
  await f.im(2, '重分析 DEMO-1'); await f.t.execute('T000001');
  assert.equal(f.c.data.triage.budget.total, 2); assert.equal(f.c.data.tasks.T000001.status, 'completed');
  const zero = fixture({ totalModelCalls: 0, dailyModelCalls: 0 }, { run: async snapshot => ({ status: 'waiting_input', text: '需要故障时间。', inputRevision: snapshot.inputRevision }) });
  await zero.im(1, '分析 DEMO-1'); await zero.t.execute('T000001'); assert.equal(zero.c.data.tasks.T000001.status, 'waiting_input');
});

test('only a confirmed pre-model quota pause resumes automatically and old history remains intact', async () => {
  const f = fixture({ totalModelCalls: 0, dailyModelCalls: 0 }); await f.im(1, '分析 DEMO-1');
  const task = f.c.data.tasks.T000001;
  Object.assign(task, { status: 'paused', error: 'TRIAGE_MODEL_BUDGET', lastRunStopped: true, uncertain: false,
    failure: { phase: 'before-model', modelStarted: false, processTreeStopped: true }, attempt: 1 });
  f.c.data.triage.budget.total = 100; f.c.data.triage.budget.days['2026-11-20'] = 100;
  f.c.data.triage.budget.reservations['older:1'] = { taskId: 'older', attempt: 1 };
  const preserved = structuredClone(f.c.data.triage.budget);
  for (const [id, changes] of [['T000002', { error: 'TRIAGE_FAILED' }], ['T000003', { uncertain: true }], ['T000004', { status: 'cancelled' }]])
    f.c.data.tasks[id] = { ...structuredClone(task), id, ...changes };
  f.t.initialize(f.c.data);
  assert.equal(task.status, 'queued'); assert.equal(task.quotaRecovery.previousError, 'TRIAGE_MODEL_BUDGET');
  assert.equal(f.c.data.tasks.T000002.status, 'paused'); assert.equal(f.c.data.tasks.T000003.status, 'paused'); assert.equal(f.c.data.tasks.T000004.status, 'cancelled');
  assert.deepEqual(f.c.data.triage.budget, preserved);
  await f.t.execute('T000001'); assert.equal(f.c.data.tasks.T000001.status, 'completed'); assert.equal(f.c.data.triage.budget.total, 101);
});

test('completed analysis usage stays in the task and attempt without a separate chat message', async () => {
  const usage = { elapsedMs: 123000, providerRequests: 18, toolCalls: 105, toolCallsByName: { read_evidence: 70, run_parser: 9 },
    evidenceReadCalls: 70, evidenceLines: 2700, parserRuns: 9, tokens: { input: 100000, output: 7000 } };
  const f = fixture({ totalModelCalls: 0, dailyModelCalls: 0 }, { run: async (snapshot, { beforeModel }) => {
    await beforeModel(); return { status: 'completed', text: 'Skill原结论', inputRevision: snapshot.inputRevision, modelCalls: 1, execution: { usage } };
  } });
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  const task = f.c.data.tasks.T000001;
  assert.equal(task.status, 'completed'); assert.deepEqual(task.usage, usage); assert.deepEqual(task.usageByAttempt[1], usage);
  f.t.initialize(f.c.data); assert.deepEqual(f.c.data.tasks.T000001.usageByAttempt[1], usage);
  assert.equal(Object.values(f.c.data.outbox).filter(item => item.category === 'usage').length, 0);
});

test('a failed analysis retains observed usage and necessary error information without claiming a final skill result', async () => {
  const usage = { elapsedMs: 4200, providerRequests: 2, toolCalls: 7, evidenceReadCalls: 3, evidenceLines: 80, parserRuns: 1 };
  const f = fixture({}, { run: async (_snapshot, { beforeModel }) => { await beforeModel(); throw Object.assign(new Error('Synthetic transport failure'),
    { modelStarted: true, processTreeStopped: true, usage }); } });
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  assert.equal(f.c.data.tasks.T000001.status, 'paused'); assert.deepEqual(f.c.data.tasks.T000001.usage, usage);
  assert.equal(Object.values(f.c.data.outbox).filter(item => item.category === 'result').length, 0);
  assert.equal(Object.values(f.c.data.outbox).filter(item => item.category === 'usage').length, 0);
  assert.ok(Object.values(f.c.data.outbox).some(item => item.category === 'notice' && /已暂停/u.test(item.text)));
});

test('download pauses give a safe recovery action and retain the private failure receipt', async () => {
  const root = resolve(tmpdir(), 'teamplay-download-receipts'), receipt = join(root, 'attempt-owned', 'failure.json');
  const f = fixture({}, { run: async () => { throw Object.assign(new Error('Never show token=private-secret https://private.example/file'), {
    code: 'TRIAGE_DOWNLOAD_TIMEOUT', kind: 'download-timeout', phase: 'download', modelStarted: false, processTreeStopped: true, failureReceiptPath: receipt }); } });
  f.t.worker.root = root;
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  const task = f.c.data.tasks.T000001;
  assert.equal(task.status, 'paused'); assert.equal(task.error, 'TRIAGE_DOWNLOAD_TIMEOUT'); assert.equal(task.uncertain, false);
  assert.equal(task.failure.receiptPathPrivate, receipt);
  const notice = Object.values(f.c.data.outbox).find(item => item.category === 'notice' && /分析已暂停/u.test(item.text));
  assert.match(notice.text, /公司网络/u); assert.match(notice.text, /继续分析 #T000001/u);
  for (const value of ['private-secret', 'private.example', receipt, 'TRIAGE_DOWNLOAD_TIMEOUT']) assert.ok(!notice.text.includes(value));
  assert.equal(f.c.data.triage.budget.total, 0);
});

test('an unavailable attachment explains the required replacement without leaking HTTP internals', async () => {
  const f = fixture({}, { run: async () => { throw Object.assign(new Error('private provider body'), {
    code: 'TRIAGE_DOWNLOAD_HTTP', httpStatus: 404, phase: 'download', modelStarted: false, processTreeStopped: true }); } });
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  assert.equal(f.c.data.tasks.T000001.failure.httpStatus, 404);
  const notice = Object.values(f.c.data.outbox).find(item => item.category === 'notice' && /分析已暂停/u.test(item.text));
  assert.match(notice.text, /重新上传日志/u); assert.match(notice.text, /继续分析 #T000001/u); assert.doesNotMatch(notice.text, /404|HTTP|private/u);
});

test('a new revision during worker execution is retained, old report is saved but not sent, next attempt uses newest input', async () => {
  const start = deferred(), finish = deferred();
  const f = fixture({}, { run: async (snapshot, { beforeModel }) => { await beforeModel(); start.resolve(); await finish.promise;
    return { status: 'completed', text: 'old version', inputRevision: snapshot.inputRevision, modelCalls: 1 }; } });
  await f.im(1, '分析 DEMO-1'); const executing = f.t.execute('T000001'); await start.promise;
  await f.im(2, '#T000001 问题说明 新增的故障描述'); finish.resolve(); await executing;
  const task = f.c.data.tasks.T000001; assert.equal(task.inputRevision, 2); assert.equal(task.status, 'queued');
  assert.equal(task.issue.description, '新增的故障描述'); assert.equal(task.reports[1].text, 'old version');
  assert.equal(Object.values(f.c.data.outbox).filter(item => item.category === 'result').length, 0);
});

test('new input before model admission skips paid call and queues newest revision', async () => {
  const before = deferred(), resume = deferred(); let invoked = 0;
  const f = fixture({}, { run: async (snapshot, { beforeModel }) => { before.resolve(); await resume.promise; await beforeModel(); invoked++;
    return { status: 'completed', text: 'done', inputRevision: snapshot.inputRevision }; } });
  await f.im(1, '分析 DEMO-1'); const executing = f.t.execute('T000001'); await before.promise;
  await f.im(2, '#T000001 时间 12:00-12:30'); resume.resolve(); await executing;
  assert.equal(invoked, 0); assert.equal(f.c.data.triage.budget.total, 0); assert.equal(f.c.data.tasks.T000001.status, 'queued');
});

test('report outbox remains immutable across restart/lost ACK; revisions and binding revocation gate sending', async () => {
  const f = fixture(); await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  const item = structuredClone(Object.values(f.c.data.outbox).find(value => value.category === 'result'));
  assert.equal(f.t.beforeSend(item, chats), 'send');
  f.t.initialize(f.c.data); assert.deepEqual(f.c.data.outbox[item.key], item); assert.equal(f.c.data.triage.budget.total, 1);
  assert.equal(f.t.beforeSend({ ...item, text: 'changed with same key' }, chats), 'pause');
  await f.im(2, '#T000001 问题说明 更正故障现象'); assert.equal(f.t.beforeSend(item, chats), 'drop');
  assert.equal(f.c.data.outbox[item.key].status, 'superseded');
  f.c.data.triage.bindings[0].enabled = false; assert.equal(f.t.beforeSend(item, chats), 'pause');
});

test('restart pauses ambiguous running work and removed configuration cannot resurrect ghost bindings', async () => {
  const f = fixture(); await f.im(1, '分析 DEMO-1'); const task = f.c.data.tasks.T000001; task.status = 'running';
  f.t.initialize(f.c.data); assert.equal(task.status, 'paused'); assert.equal(task.uncertain, true); assert.equal(task.lastRunStopped, false);
  f.t.options.bindings = []; f.t.initialize(f.c.data); assert.equal(f.c.data.triage.bindings[0].enabled, false);
  assert.equal(f.t.authorized(task, chats), false); assert.equal(f.t.eligible(task), false);
});

test('admin chat binding requires both allowlists, exact unique project, one conversation; unbind persists', async () => {
  const f = fixture({ allowChatProjectBinding: true, adminSenderIds: ['human'] });
  await f.im(1, '停止跟踪项目 DEMO'); assert.equal(f.c.data.triage.bindings[0].enabled, false);
  const confirmation = Object.values(f.c.data.outbox).find(item => item.controlAck); assert.equal(f.t.beforeSend(confirmation, chats), 'send');
  f.t.initialize(f.c.data); assert.equal(f.c.data.triage.bindings[0].enabled, false);
  await f.im(2, '跟踪项目 DEMO'); assert.equal(f.c.data.triage.bindings[0].enabled, true);
  await f.im(3, '跟踪项目 DEMO', other, 'other-chat'); assert.equal(f.c.data.triage.bindings[0].conversationId, 'chat');
  assert.equal(f.c.data.inbox['im:3'].decision.action, 'ignore');
});

test('cancel waits for worker termination and does not emit a success report', async () => {
  const start = deferred();
  const f = fixture({}, { run: async (snapshot, { signal }) => { start.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { processTreeStopped: true })), { once: true })); } });
  await f.im(1, '分析 DEMO-1'); const run = f.t.execute('T000001'); await start.promise;
  const result = await f.t.cancel('T000001'); await run;
  assert.equal(result.processTreeStopped, true); assert.equal(f.c.data.tasks.T000001.status, 'cancelled');
  assert.equal(Object.values(f.c.data.outbox).filter(item => item.category === 'result').length, 0);
});

test('clock domains are explicit per log type and invalid domain input never silently mutates evidence', async () => {
  assert.deepEqual(triageWindow('日期 2026-11-20 时间 01:00-02:00 时区 UTC+08:00'), { date: '2026-11-20', from: '01:00', to: '02:00', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(triageClockDomains('日志时区 ota=UTC qnx-uds=Asia/Shanghai'), { ota: 'UTC', 'qnx-uds': 'Asia/Shanghai' });
  assert.throws(() => triageClockDomains('日志时区 unknown=UTC'));
  const f = fixture({ clockDomains: { ota: 'UTC' } }); await f.im(1, '分析 DEMO-1');
  await f.im(2, '#T000001 日志时区 slave=Not/AZone'); assert.deepEqual(f.c.data.tasks.T000001.clockDomains, { ota: 'UTC' });
  assert.equal(f.c.data.tasks.T000001.inputRevision, 1);
});

test('zero-model preliminary reports persist and send without consuming a model budget', async () => {
  const f = fixture({ totalModelCalls: 0, dailyModelCalls: 0 }, { rows: [issue('1', { description: '' })], run: async snapshot => ({
    status: 'completed', text: '缺少时间信息，以下仅为初排线索。', modelCalls: 0, inputRevision: snapshot.inputRevision,
    report: { mode: 'preliminary', limitations: ['故障时间不明'] }, manifest: { files: [] } }) });
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  assert.equal(f.c.data.tasks.T000001.status, 'completed'); assert.equal(f.c.data.triage.budget.total, 0);
  const item = Object.values(f.c.data.outbox).find(item => item.category === 'result');
  assert.match(item.text, /分析版本 1/u); assert.equal(f.t.beforeSend(item, chats), 'send');
  assert.equal(item.clientId, 'dsh-supervisor-super-' + (await import('node:crypto')).createHash('sha256').update(item.key).digest('hex').slice(0, 32));
});

test('an operator stop cannot fabricate termination proof after interrupted-state recovery', async () => {
  const f = fixture(); await f.im(1, '分析 DEMO-1'); f.c.data.tasks.T000001.status = 'running';
  f.t.initialize(f.c.data); const result = await f.t.cancel('T000001');
  assert.equal(result.processTreeStopped, false); assert.equal(f.c.data.tasks.T000001.uncertain, true);
  assert.equal(f.c.data.tasks.T000001.status, 'paused');
  await f.im(2, '继续分析 #T000001'); assert.equal(f.c.data.tasks.T000001.status, 'paused');
});

test('manual description and clock corrections survive later QA attachments in the same task', async () => {
  const f = fixture(); await f.im(1, '分析 DEMO-1'); await f.im(2, '#T000001 问题说明 设备持续重启 日志时区 slave=Asia/Shanghai');
  await f.t.pollSources(); f.setRows([issue('1', { attachments: [{ id: '7' }, { id: '8' }] })]);
  f.advance(); await f.t.pollSources(); await f.t.routePending();
  const task = f.c.data.tasks.T000001;
  assert.equal(task.issue.description, '设备持续重启'); assert.deepEqual(task.fileIds, ['7', '8']);
  assert.equal(task.clockDomains.slave, 'Asia/Shanghai'); assert.equal(task.inputRevision, 3);
});

test('retracking establishes a new silent baseline instead of analysing issues created while untracked', async () => {
  const f = fixture({ allowChatProjectBinding: true, adminSenderIds: ['human'] }); await f.t.pollSources();
  await f.im(1, '停止跟踪项目 DEMO'); f.setRows([issue(), issue('2')]);
  await f.im(2, '跟踪项目 DEMO'); f.advance(); await f.t.pollSources(); await f.t.routePending();
  assert.equal(Object.keys(f.c.data.tasks).length, 0);
  const source = Object.values(f.c.data.triage.qa)[0]; assert.ok(source.checkpoint.seen['2']);
});

test('explicit reanalysis reopens safely stopped historical work in the same task, without bypassing budgets', async () => {
  const f = fixture(); await f.im(1, '分析 DEMO-1'); await f.im(2, '取消任务 #T000001');
  assert.equal(f.c.data.tasks.T000001.status, 'cancelled');
  await f.im(3, '重新分析 DEMO-1');
  assert.equal(Object.keys(f.c.data.tasks).length, 1); assert.equal(f.c.data.tasks.T000001.status, 'queued');
  assert.equal(f.c.data.tasks.T000001.inputRevision, 2); assert.equal(f.c.data.tasks.T000001.stopRequested, false);
  assert.equal(f.c.data.triage.budget.total, 0);
});

test('continuing a completed analysis cannot pay again or replace a report under its existing outbox key', async () => {
  const f = fixture(); await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  const originalTask = structuredClone(f.c.data.tasks.T000001);
  const originalResult = structuredClone(Object.values(f.c.data.outbox).find(item => item.category === 'result'));
  await f.im(2, '继续分析 #T000001'); await f.t.execute('T000001');
  const task = f.c.data.tasks.T000001;
  assert.equal(task.status, 'completed'); assert.equal(task.attempt, originalTask.attempt);
  assert.equal(task.inputRevision, originalTask.inputRevision); assert.deepEqual(task.reports, originalTask.reports);
  assert.equal(f.calls.length, 1); assert.equal(f.c.data.triage.budget.total, 1);
  assert.deepEqual(f.c.data.outbox[originalResult.key], originalResult);
  assert.ok(Object.values(f.c.data.outbox).some(item => /重新分析 DEMO-1/u.test(item.text)));
});

test('resume requires confirmed termination and a prior waiting output receives a fresh revision', async () => {
  const f = fixture({}, { run: async snapshot => ({ status: 'waiting_log', text: '请补充日志。', inputRevision: snapshot.inputRevision, modelCalls: 0 }) });
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  const originalResult = structuredClone(Object.values(f.c.data.outbox).find(item => item.category === 'result'));
  f.c.data.tasks.T000001.lastRunStopped = false;
  await f.im(2, '继续分析 #T000001');
  assert.equal(f.c.data.tasks.T000001.status, 'waiting_log'); assert.equal(f.c.data.tasks.T000001.inputRevision, 1);
  f.c.data.tasks.T000001.lastRunStopped = true;
  await f.im(3, '继续分析 #T000001');
  const task = f.c.data.tasks.T000001;
  assert.equal(task.status, 'queued'); assert.equal(task.inputRevision, 2);
  assert.equal(task.reports[1].text, '请补充日志。'); assert.equal(f.c.data.outbox[originalResult.key].status, 'superseded');
  await f.t.execute('T000001');
  assert.equal(f.c.data.tasks.T000001.reportRevision, 2); assert.equal(f.c.data.triage.budget.total, 0);
  assert.equal(Object.values(f.c.data.outbox).find(item => item.category === 'result' && item.reportRevision === 2).status, 'pending');
});

test('private artifact paths remain in the ledger but cannot enter report context nodes', async () => {
  const file = { name: '报告.txt', mime: 'text/plain', size: 6, sha256: 'a'.repeat(64), pathPrivate: 'D:/private-triage/reports/报告.txt' };
  const f = fixture({}, { run: async (snapshot, { beforeModel }) => { await beforeModel(); return {
    status: 'completed', text: '初排完成。', modelCalls: 1, inputRevision: snapshot.inputRevision,
    report: { conclusion: '待验证' }, manifest: { files: [] }, files: [file], execution: { backend: 'dsh' },
  }; } });
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  const task = f.c.data.tasks.T000001;
  assert.equal(task.files[0].pathPrivate, file.pathPrivate); assert.equal(task.reports[1].files[0].pathPrivate, file.pathPrivate);
  const artifact = Object.values(f.c.data.outbox).find(item => item.category === 'artifact');
  assert.equal(artifact.artifact.pathPrivate, file.pathPrivate);
  const context = readNode(f.c.data.graph, task.resultReference, { projectId: '42', conversations: ['chat'], limit: 12000 });
  assert.doesNotMatch(context.text, /pathPrivate|private-triage/u);
  assert.deepEqual(JSON.parse(context.text).files, [{ name: file.name, mime: file.mime, size: file.size, sha256: file.sha256 }]);
});

const partialResult = revision => ({ status: 'partial', inputRevision: revision, modelCalls: 1,
  text: '助手未完成完整判断；以下为已核对线索的程序初排，并非模型终稿。',
  report: { confidence: 'low', responsibility: '待验证', limitations: ['未完成模型终稿。'] },
  manifest: { inputRevision: revision, files: [] },
  files: [{ name: 'report.json', mime: 'application/json', size: 90, sha256: 'a'.repeat(64), pathPrivate: 'D:/private-triage/report.json' },
    { name: '报告.txt', mime: 'text/plain', size: 120, sha256: 'b'.repeat(64), pathPrivate: 'D:/private-triage/报告.txt' }],
  execution: { backend: 'dsh', agentSessions: 1, providerRequests: 6, toolCalls: 11, skillLoaded: true, proofValidated: true },
});
async function recoverableFixture() {
  const f = fixture({}, { run: async (_snapshot, { beforeModel }) => { await beforeModel();
    throw Object.assign(new Error('budget stopped'), { code: 'TRIAGE_MODEL_STOPPED', kind: 'budget', phase: 'model', modelStarted: true, processTreeStopped: false }); } });
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001'); return f;
}

test('normal partial work publishes only its original conclusion and one full-text report attachment', async () => {
  const f = fixture({}, { run: async (snapshot, { beforeModel }) => { await beforeModel(); return partialResult(snapshot.inputRevision); } });
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  const task = f.c.data.tasks.T000001;
  assert.equal(task.status, 'partial'); assert.equal(task.reports[1].status, 'partial'); assert.equal(f.c.data.triage.budget.total, 1);
  const outputs = Object.values(f.c.data.outbox).filter(item => ['result', 'artifact'].includes(item.category));
  assert.equal(outputs.filter(item => item.category === 'artifact').length, 1); assert.equal(outputs.filter(item => item.category === 'result').length, 0);
  for (const item of outputs) assert.equal(f.t.beforeSend(item, chats), 'send');
  await f.im(2, '继续分析 #T000001'); assert.equal(f.c.data.tasks.T000001.status, 'partial');
});

test('local recovered partial uses original attempt and revision, preserves failure and charges no new execution', async () => {
  const f = await recoverableFixture();
  const old = structuredClone(f.c.data.tasks.T000001), budget = structuredClone(f.c.data.triage.budget);
  assert.equal(old.status, 'paused'); assert.equal(old.uncertain, true);
  await f.t.publishRecovered('T000001', partialResult(1), { attempt: 1, inputRevision: 1, processTreeStopped: true });
  const task = f.c.data.tasks.T000001;
  assert.equal(task.status, 'partial'); assert.equal(task.lastRunStopped, true); assert.equal(task.uncertain, false);
  assert.equal(task.attempt, old.attempt); assert.equal(task.inputRevision, old.inputRevision); assert.equal(task.reportRevision, 1);
  assert.equal(task.error, old.error); assert.deepEqual(task.failure, old.failure); assert.deepEqual(f.c.data.triage.budget, budget);
  assert.equal(Object.values(f.c.data.outbox).filter(item => item.category === 'artifact').length, 1);
  const node = readNode(f.c.data.graph, task.resultReference, { projectId: '42', conversations: ['chat'], limit: 12000 });
  assert.doesNotMatch(node.text, /pathPrivate|private-triage/u);
  await assert.rejects(f.t.publishRecovered('T000001', partialResult(1), { attempt: 1, inputRevision: 1, processTreeStopped: true }), { code: 'TRIAGE_RECOVERY_STATE' });
});

test('an already completed native skill report publishes on its original reservation without another execution', async () => {
  const f = await recoverableFixture(), budget = structuredClone(f.c.data.triage.budget);
  const result = { ...partialResult(1), status: 'completed', text: '模型的完整报告。', report: { conclusion: '模型原有判断。', confidence: 'medium', responsibility: '模型原有倾向' } };
  await f.t.publishRecovered('T000001', result, { attempt: 1, inputRevision: 1, processTreeStopped: true });
  const task = f.c.data.tasks.T000001;
  assert.equal(task.status, 'completed'); assert.equal(task.recovery.status, 'completed');
  assert.deepEqual(task.report, result.report); assert.deepEqual(f.c.data.triage.budget, budget);
  assert.equal(task.attempt, 1); assert.equal(task.reportRevision, 1);
  assert.equal(Object.values(f.c.data.outbox).filter(item => item.category === 'artifact').length, 1);
});

test('recovered publishing refuses fake proof, wrong revision, missing or void reservation and live execution', async () => {
  for (const variation of ['proof', 'skill', 'result-status', 'no-files', 'wrong-revision', 'wrong-attempt', 'no-stop', 'no-reservation', 'void', 'void-status', 'not-reserved', 'active', 'runs', 'revoked']) {
    const f = await recoverableFixture(), result = partialResult(1), options = { attempt: 1, inputRevision: 1, processTreeStopped: true };
    if (variation === 'proof') result.execution.proofValidated = false;
    if (variation === 'skill') result.execution.skillLoaded = false;
    if (variation === 'result-status') result.status = 'invented';
    if (variation === 'no-files') result.files = [];
    if (variation === 'wrong-revision') { options.inputRevision = 2; result.inputRevision = 2; }
    if (variation === 'wrong-attempt') options.attempt = 2;
    if (variation === 'no-stop') options.processTreeStopped = false;
    if (variation === 'no-reservation') delete f.c.data.triage.budget.reservations['T000001:1'];
    if (variation === 'void') f.c.data.triage.budget.reservations['T000001:1'].void = true;
    if (variation === 'void-status') f.c.data.triage.budget.reservations['T000001:1'].status = 'void_before_provider';
    if (variation === 'not-reserved') f.c.data.tasks.T000001.modelReserved = false;
    if (variation === 'active') f.c.active.set('T000001', {});
    if (variation === 'runs') f.t.runs.set('T000001', {});
    if (variation === 'revoked') f.c.conversations[0].members = [human];
    await assert.rejects(f.t.publishRecovered('T000001', result, options), variation);
    assert.equal(f.c.data.tasks.T000001.status, 'paused'); assert.equal(f.c.data.tasks.T000001.uncertain, true);
    assert.equal(Object.values(f.c.data.outbox).filter(item => item.category === 'artifact').length, 0);
  }
});

test('recovered historical proofs ignore removed quotas and support reports above the old small-file cap', async () => {
  const policy = { modelRequests: 12, toolCalls: 32, inputCharacters: 192000, maxTokens: 4096 };
  const f = await recoverableFixture(), result = partialResult(1);
  result.execution = { ...result.execution, providerRequests: 120, toolCalls: 320, limits: policy };
  result.files[0].size = 250000;
  await f.t.publishRecovered('T000001', result, { attempt: 1, inputRevision: 1, processTreeStopped: true });
  assert.ok(!Object.hasOwn(f.c.data.tasks.T000001.execution, 'limits'));
  assert.equal(f.c.data.tasks.T000001.execution.providerRequests, 120); assert.equal(f.c.data.tasks.T000001.execution.toolCalls, 320);
  assert.equal(f.c.data.tasks.T000001.files[0].size, 250000);
});

test('successful analyses emit one conclusion-and-text-file message without accepted, full report, JSON or usage chatter', async () => {
  for (const conclusion of ['Skill原结论，保留原意。', '原结论'.repeat(4000)]) {
    const report = { conclusion, responsibility: 'Skill原责任方', confidence: 'medium', evidence: [{ id: 'E0001', interpretation: '原依据' }],
      timeline: [{ id: 'E0001', event: '原事件' }], alternatives: ['原其他可能'], nextSteps: ['原建议'], limitations: ['原缺口'] };
    const f = fixture({}, { run: async (snapshot, { beforeModel }) => { await beforeModel(); return { ...partialResult(snapshot.inputRevision), status: 'completed',
      text: '完整依据、时间线、用量只在报告下载中展示。' + conclusion, report }; } });
    await f.im(1, '分析 DEMO-1'); assert.equal(Object.keys(f.c.data.outbox).length, 0);
    await f.t.execute('T000001');
    const messages = Object.values(f.c.data.outbox); assert.equal(messages.length, 1);
    const [message] = messages;
    assert.equal(message.category, 'artifact'); assert.equal(message.artifact.name, '报告.txt'); assert.match(message.text, /^DEMO-1\n责任方：Skill原责任方；置信度：中/u);
    assert.ok(!message.text.includes('完整依据')); assert.equal(f.c.data.tasks.T000001.files.length, 2);
    assert.equal(f.c.data.tasks.T000001.report.conclusion, conclusion);
    if (conclusion.length > 10000) { assert.ok(message.text.length <= 10000); assert.match(message.text, /…完整内容见报告$/u); }
    else assert.ok(message.text.endsWith(conclusion));
    await f.im(2, '分析 DEMO-1'); assert.equal(Object.values(f.c.data.outbox).length, 1);
  }
});

test('local presentation refresh preserves the original model fields, session usage and reservations while replacing old output with one text attachment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-presentation-'));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const report = { conclusion: '模型既有完整结论，不作重新判断。', confidence: 'medium', responsibility: '模型既有责任方', evidence: [{ id: 'E0001', interpretation: '原依据' }],
    timeline: [{ id: 'E0001', event: '原事件' }], alternatives: ['原其他可能'], nextSteps: ['原下一步'], limitations: ['原缺口'] };
  const usage = { elapsedMs: 123000, providerRequests: 8, toolCalls: 20, evidenceReadCalls: 5, evidenceLines: 200, parserRuns: 3 };
  const f = fixture({ root }, { run: async (snapshot, { beforeModel }) => { await beforeModel(); return { ...partialResult(snapshot.inputRevision), status: 'completed', report,
    text: '原完整报告', execution: { ...partialResult(1).execution, providerRequests: 8, toolCalls: 20, usage } }; } });
  await f.im(1, '分析 DEMO-1'); await f.t.execute('T000001');
  const before = structuredClone(f.c.data.tasks.T000001), accounting = structuredClone(f.c.data.triage.budget);
  for (const [key, category] of [['old-result', 'result'], ['old-json', 'artifact'], ['old-usage', 'usage']])
    f.c.data.outbox[key] = { key, taskId: before.id, reportRevision: 1, category, status: 'sent' };
  const text = '原完整报告\n' + report.conclusion + '\n本次用量：耗时2分3秒，模型8次，工具20次。', files = [];
  for (const [name, mime, content] of [['report.json', 'application/json', JSON.stringify(report)], ['报告.txt', 'text/plain', text + '\n']]) {
    const bytes = Buffer.from(content), pathPrivate = join(root, name); await writeFile(pathPrivate, bytes);
    files.push({ name, mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), pathPrivate });
  }
  const result = { status: 'completed', inputRevision: 1, modelCalls: 1, report, text, files, execution: before.execution, manifest: before.manifest };
  await f.t.refreshPresentation(before.id, result, { inputRevision: 1 });
  const task = f.c.data.tasks.T000001;
  assert.equal(task.status, 'completed'); assert.equal(task.attempt, before.attempt); assert.equal(task.inputRevision, before.inputRevision); assert.equal(task.reportRevision, before.reportRevision);
  assert.deepEqual(task.report, before.report); assert.deepEqual(task.execution, before.execution); assert.deepEqual(task.usage, before.usage); assert.deepEqual(f.c.data.triage.budget, accounting);
  const live = Object.values(f.c.data.outbox).filter(item => item.status !== 'superseded');
  assert.equal(live.length, 1); assert.equal(live[0].artifact.name, '报告.txt'); assert.ok(live[0].text.endsWith(report.conclusion));
  assert.equal(await readFile(live[0].artifact.pathPrivate, 'utf8'), text + '\n');
  const key = live[0].key; await f.t.refreshPresentation(before.id, result, { inputRevision: 1 });
  assert.deepEqual(Object.values(f.c.data.outbox).filter(item => item.status !== 'superseded').map(item => item.key), [key]);
});
