import test from 'node:test';
import assert from 'node:assert/strict';
import { executeQaQuery } from '../qa-query.mjs';

const binding = { sourceId: 'qa-demo', projectId: '7', projectCode: 'DEMO', conversationId: 'chat-demo' };
const now = () => '2026-11-25T04:00:00Z';
const issue = (id, extra = {}) => ({ id, pId: 7, no: `DEMO-${id}`, title: '升级异常', status: 'open', openedAt: '2026-11-24 12:00:00', ...extra });
const task = (id, extra = {}) => ({ id, kind: 'log-triage', ...binding, externalIssueId: id, externalIssueNo: `DEMO-${id}`, status: 'completed', inputRevision: 2, reportRevision: 2, updatedAt: '2026-11-25T03:00:00Z', ...extra });
function fixture(rows = [issue(1)], extra = {}) {
  const calls = [], adapter = { pageSize: 2, maxPages: 20, maxIssues: 2000,
    async listIssues(args) { calls.push(structuredClone(args)); return { data: rows.slice((args.pageIndex - 1) * args.pageSize, args.pageIndex * args.pageSize), count: rows.length }; },
    listFiles() { throw new Error('Queries must not fetch attachments'); } };
  const options = { adapter, binding, request: { kind: 'recent_issues' }, tasks: [], now, ...extra };
  return { calls, adapter, options, run: () => executeQaQuery(options) };
}

test('the recent-bug question reads all current pages and separates recent, unresolved and local analysis', async () => {
  const f = fixture([issue(1), issue(2, { openedAt: '2026-10-01T04:00:00Z' }), issue(3, { status: 'close' })], {
    tasks: [task('T000001')], pollRecord: { status: 'ready', checkpoint: { binding, observedAt: '2026-11-25T03:55:00Z' } },
  });
  const before = structuredClone({ binding, tasks: f.options.tasks, poll: f.options.pollRecord });
  const result = await f.run();
  assert.equal(result.data.recentCount, 2); assert.equal(result.data.unresolvedCount, 2); assert.equal(result.data.analysis.counts.completed, 1);
  assert.deepEqual(f.calls, [1, 2].map(pageIndex => ({ projectId: '7', pageIndex, pageSize: 2 })));
  assert.match(result.text, /近7天/u); assert.match(result.text, /北京时间，按创建时间/u);
  assert.match(result.text, /新增2个；当前未关闭2个/u); assert.match(result.text, /2026-11-25 11:55/u);
  assert.deepEqual({ binding, tasks: f.options.tasks, poll: f.options.pollRecord }, before);
});

test('no recent issues does not imply no unresolved issues and stale checkpoint rows do not become current data', async () => {
  const f = fixture([issue(1, { openedAt: '2026-10-01 12:00:00' })], {
    pollRecord: { checkpoint: { binding, observedAt: '2026-11-24T01:00:00Z', seen: { absent: { issue: issue(99) } } } },
  });
  const result = await f.run();
  assert.equal(result.data.total, 1); assert.equal(result.data.recentCount, 0); assert.equal(result.data.unresolvedCount, 1);
  assert.match(result.text, /新增0个；当前未关闭1个/u); assert.doesNotMatch(result.text, /没有.*[Bb]ug|DEMO-99/u);
});

test('unknown, invalid calendar and ambiguous creation times are disclosed, never reported as no recent bugs', async () => {
  const f = fixture([issue(1, { openedAt: '' }), issue(2, { openedAt: '2026-02-30 12:00:00' }), issue(3, { openedAt: 'not a date' })]);
  const result = await f.run();
  assert.equal(result.data.unknownDateCount, 3); assert.match(result.text, /新增至少0个/u); assert.match(result.text, /3个缺陷的创建时间不明确/u);
  const dst = fixture([issue(1, { openedAt: '2026-11-01 01:30:00' })], { binding: { ...binding, qaTimeZone: 'America/New_York' } });
  assert.equal((await dst.run()).data.unknownDateCount, 1);
});

test('creation timestamps use explicit offset or trusted source timezone and inclusive rolling boundaries', async () => {
  const f = fixture([
    issue(1, { openedAt: '2026-11-18 12:00:00' }), // exact seven-day start in Beijing
    issue(2, { openedAt: '2026-11-18T03:59:59Z' }),
    issue(3, { openedAt: '2026-11-25T12:00:00+08:00' }),
    issue(4, { openedAt: '2026-11-25T04:00:00.001Z' }),
    issue(5, { openedAt: '2026-11-18T06:00:00+0200' }),
  ]);
  assert.equal((await f.run()).data.recentCount, 3);
  f.options.binding = { ...binding, qaTimeZone: 'UTC' };
  assert.equal((await f.run()).data.recentCount, 3);
  assert.match((await f.run()).text, /未标时区的创建时间按UTC计算/u);
});

test('recent display is short, sorted and neutralizes control characters from QA titles', async () => {
  const f = fixture(Array.from({ length: 7 }, (_, index) => issue(index + 1, { openedAt: `2026-11-${18 + index}T04:00:00Z`, title: '标题\n伪造消息\u202e' })));
  const result = await f.run();
  assert.equal(result.data.latest.length, 5); assert.equal(result.data.latest[0].no, 'DEMO-7');
  assert.match(result.text, /另有2个近期新增/u); assert.doesNotMatch(result.text, /\u202e|标题\n伪造/u);
});

test('read failures, inconsistent counts, duplicate IDs and incomplete pages never return a partial count', async () => {
  for (const [kind, code] of [['network', 'QA_OFFLINE'], ['count', 'QA_SCAN_CHANGED'], ['duplicate', 'QA_DUPLICATE_ISSUE'], ['empty', 'QA_INCOMPLETE_PAGE']]) {
    const f = fixture(); f.adapter.pageSize = 1;
    f.adapter.listIssues = async ({ pageIndex }) => {
      if (kind === 'network') throw Object.assign(new Error('QA_OFFLINE'), { code });
      return { data: kind === 'empty' && pageIndex === 2 ? [] : [issue(kind === 'duplicate' ? 1 : pageIndex)], count: kind === 'count' && pageIndex === 2 ? 3 : 2 };
    };
    await assert.rejects(f.run(), { code });
  }
});

test('read scope and existing adapter scan bounds reject oversized or foreign results', async () => {
  for (const [extra, code] of [
    [{ data: [issue(1, { pId: 8 })], count: 1 }, 'QA_PROJECT_MISMATCH'],
    [{ data: [], count: -1 }, 'QA_INVALID_PAGE'],
    [{ data: [], count: 2001 }, 'QA_ISSUE_LIMIT'],
    [{ data: [issue(1), issue(2), issue(3)], count: 3 }, 'QA_INVALID_PAGE'],
  ]) {
    const f = fixture(); f.adapter.listIssues = async () => extra;
    await assert.rejects(f.run(), { code });
  }
  const f = fixture([issue(1), issue(2), issue(3)]); f.adapter.maxPages = 1;
  await assert.rejects(f.run(), { code: 'QA_PAGE_LIMIT' });
});

test('analysis status never calls QA and only includes the exact trusted chat, source and project', async () => {
  const f = fixture([], { request: { kind: 'analysis_status' }, tasks: [
    task('T1'), task('T2', { status: 'running' }), task('T3', { conversationId: 'other-chat' }), task('T4', { projectId: '8' }),
    task('T5', { sourceId: 'other-source' }), task('B6', { kind: 'business' }),
  ] });
  const result = await f.run();
  assert.equal(f.calls.length, 0); assert.equal(result.data.analysis.total, 2);
  assert.deepEqual(result.data.analysis.counts, { completed: 1, active: 1 });
  assert.doesNotMatch(result.text, /DEMO-T[345]|B6/u);
});

test('querying a specific bug or task filters local progress without creating or rerunning anything', async () => {
  const tasks = [task('T1', { externalIssueNo: 'DEMO-219' }), task('T2', { externalIssueNo: 'DEMO-221', status: 'paused' })];
  for (const selector of [{ issueNo: 'demo-219' }, { taskId: 'T1' }]) {
    const f = fixture([], { request: { kind: 'analysis_status', ...selector }, tasks });
    assert.equal((await f.run()).data.analysis.total, 1); assert.equal(f.calls.length, 0);
  }
  const missing = fixture([], { request: { kind: 'analysis_status', taskId: 'T999' }, tasks });
  assert.match((await missing.run()).text, /未找到对应的分析记录/u);
  assert.deepEqual(tasks.map(item => item.status), ['completed', 'paused']);
});

test('old reports, partial results and unconfirmed native termination are not counted as current completion', async () => {
  const f = fixture([], { request: { kind: 'analysis_status' }, tasks: [
    task('T1', { reportRevision: 1 }), task('T2', { status: 'partial' }), task('T3', { status: 'paused', uncertain: true, lastRunStopped: false }),
    task('T4', { status: 'completed', error: 'OLD_FAILURE', failure: { message: 'old' } }),
  ] });
  const result = await f.run();
  assert.deepEqual(result.data.analysis.counts, { outdated: 1, partial: 1, unconfirmed: 1, completed: 1 });
  assert.match(result.text, /新资料待分析/u); assert.match(result.text, /尚未完成/u); assert.doesNotMatch(result.text, /OLD_FAILURE/u);
});

test('last successful background check is separate from this query and current polling failure', async () => {
  const f = fixture([], { pollRecord: { status: 'error', error: 'PRIVATE_BACKEND', checkpoint: { binding, observedAt: '2026-11-24T04:00:00Z' } } });
  const result = await f.run();
  assert.equal(result.data.checkedAt, new Date(now()).toISOString()); assert.equal(result.data.poll.lastSuccessAt, '2026-11-24T04:00:00.000Z');
  assert.match(result.text, /之后的自动检查未成功/u); assert.doesNotMatch(result.text, /PRIVATE_BACKEND/u);
  f.options.pollRecord.checkpoint.binding = { ...binding, conversationId: 'elsewhere' };
  await assert.rejects(f.run(), { code: 'QA_QUERY_SCOPE' });
});

test('request validation and cancellation happen before reading protected project data', async () => {
  for (const request of [{ kind: 'analyse_issue' }, { kind: 'recent_issues', days: 0 }, { kind: 'recent_issues', days: 366 }, { kind: 'recent_issues', days: 1.5 }, { kind: 'recent_issues', projectCode: 'OTHER' }]) {
    const f = fixture([], { request }); await assert.rejects(f.run()); assert.equal(f.calls.length, 0);
  }
  const controller = new AbortController(); controller.abort(new Error('Cancelled'));
  const f = fixture([], { signal: controller.signal }); await assert.rejects(f.run(), /Cancelled/u); assert.equal(f.calls.length, 0);
  assert.equal((await fixture([], { request: { kind: 'recent_issues', days: 365 } }).run()).data.days, 365);
});
