import test from 'node:test';
import assert from 'node:assert/strict';
import { QaSource, DEFAULT_QA_SOURCE_LIMITS } from '../qa-source.mjs';

const binding = { sourceId: 'qa-demo', projectId: '7', conversationId: 'chat-demo' };
const row = (id, extras = {}) => ({ id, pId: 7, no: `DEMO-${id}`, title: 'Example', status: 'open', openedAt: '2026-01-01T00:00:00Z', ...extras });
function fixture(extras = {}) {
  const f = { rows: [row(1), row(2)], files: { 1: [], 2: [] }, calls: [] };
  f.adapter = { listIssues: async args => { f.calls.push(['list', args]); return { data: f.rows.slice((args.pageIndex - 1) * args.pageSize, args.pageIndex * args.pageSize), count: f.rows.length }; },
    listFiles: async issue => { f.calls.push(['files', issue.id]); return f.files[issue.id] ?? []; }, ...extras.adapter };
  f.source = new QaSource({ binding, now: () => '2026-11-20T02:00:00Z', ...extras, adapter: f.adapter, limits: { pageSize: 1, ...extras.limits } });
  return f;
}

test('full first baseline emits nothing and subsequent unchanged scans remain quiet', async () => {
  const f = fixture();
  const first = await f.source.poll();
  assert.deepEqual(first.triggers, []); assert.equal(Object.keys(first.checkpoint.seen).length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'list').length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'files').length, 2);
  assert.deepEqual((await f.source.poll(first.checkpoint)).triggers, []);
});

test('new issue produces a deterministic service trigger without a fake human or URLs', async () => {
  const f = fixture(), baseline = (await f.source.poll()).checkpoint;
  f.rows.push(row(3, { url: 'https://discard.example.invalid', sender: { id: 'human' } })); f.files[3] = [{ id: 44, url: 'https://discard.example.invalid/file' }];
  const result = await f.source.poll(baseline), repeated = await f.source.poll(baseline), [trigger] = result.triggers;
  assert.equal(trigger.sourceKind, 'qa'); assert.equal(trigger.eventKind, 'issue.created');
  assert.equal(trigger.externalIssueId, '3'); assert.equal(trigger.externalIssueNo, 'DEMO-3'); assert.equal(trigger.conversationId, binding.conversationId);
  assert.deepEqual(trigger.issue.attachments, [{ id: '44' }]);
  assert.equal(repeated.triggers[0].triggerId, trigger.triggerId); assert.match(trigger.sourceRevision, /^[a-f0-9]{64}$/u);
  assert.ok(!JSON.stringify(trigger).includes('discard')); assert.ok(!Object.hasOwn(trigger, 'sender'));
  assert.deepEqual((await f.source.poll(result.checkpoint)).triggers, []);
});

test('late attachments change the same issue revision while attachment ordering is stable', async () => {
  const f = fixture(), first = (await f.source.poll()).checkpoint;
  f.files[1] = [{ id: 11 }, { id: 9 }];
  const second = await f.source.poll(first), trigger = second.triggers[0];
  assert.equal(trigger.eventKind, 'issue.attachments_changed'); assert.equal(trigger.externalIssueId, '1');
  f.files[1].reverse();
  assert.deepEqual((await f.source.poll(second.checkpoint)).triggers, []);
});

test('metadata changes, close and reopen preserve independently meaningful revisions', async () => {
  const f = fixture(); let checkpoint = (await f.source.poll()).checkpoint;
  f.rows[0].description = 'New details';
  let result = await f.source.poll(checkpoint); assert.equal(result.triggers[0].eventKind, 'issue.updated'); checkpoint = result.checkpoint;
  f.rows[0].status = 'close';
  result = await f.source.poll(checkpoint); assert.equal(result.triggers[0].eventKind, 'issue.closed'); checkpoint = result.checkpoint;
  f.rows[0].status = 'reopen';
  result = await f.source.poll(checkpoint); assert.equal(result.triggers[0].eventKind, 'issue.updated');
  assert.equal(new Set([checkpoint.seen['1'].sourceRevision, result.triggers[0].sourceRevision]).size, 2);
});

test('newly discovered closed records are recorded without creating historical work', async () => {
  const f = fixture(), baseline = (await f.source.poll()).checkpoint;
  for (const [index, status] of ['close', 'invalid', 'noneedfix'].entries()) f.rows.push(row(index + 3, { status }));
  const result = await f.source.poll(baseline);
  assert.deepEqual(result.triggers, []); assert.equal(Object.keys(result.checkpoint.seen).length, 5);
});

test('a failed first scan and failed later scan never mutate or return a checkpoint', async () => {
  const f = fixture(); let baseline = (await f.source.poll()).checkpoint;
  const before = structuredClone(baseline), original = f.adapter.listIssues;
  f.adapter.listIssues = async args => { if (args.pageIndex === 2) throw new Error('Synthetic page failure'); return original(args); };
  await assert.rejects(f.source.poll(), /Synthetic page failure/u);
  await assert.rejects(f.source.poll(baseline), /Synthetic page failure/u);
  assert.deepEqual(baseline, before);
});

test('duplicate IDs, changing totals and empty intermediate pages fail closed', async () => {
  for (const [kind, code] of [['duplicate', 'QA_DUPLICATE_ISSUE'], ['count', 'QA_SCAN_CHANGED'], ['empty', 'QA_INCOMPLETE_PAGE']]) {
    const f = fixture({ adapter: { listIssues: async ({ pageIndex }) => ({ data: kind === 'empty' && pageIndex === 2 ? [] : [row(kind === 'duplicate' ? 1 : pageIndex)], count: kind === 'count' && pageIndex === 2 ? 3 : 2 }) } });
    await assert.rejects(f.source.poll(), { code });
  }
});

test('project and checkpoint ownership boundaries are checked before admitting a trigger', async () => {
  const f = fixture(), baseline = (await f.source.poll()).checkpoint;
  f.rows[0].pId = 8;
  await assert.rejects(f.source.poll(baseline), { code: 'QA_PROJECT_MISMATCH' });
  for (const key of ['sourceId', 'projectId', 'conversationId']) {
    const changed = structuredClone(baseline); changed.binding[key] += '-elsewhere';
    await assert.rejects(f.source.poll(changed), { code: 'QA_INVALID_CHECKPOINT' });
  }
});

test('absent issue is retained and cannot replay as created on reappearance', async () => {
  const f = fixture(), baseline = (await f.source.poll()).checkpoint;
  const absent = f.rows.pop(), removed = await f.source.poll(baseline);
  assert.deepEqual(removed.triggers, []); assert.ok(removed.checkpoint.seen['2']);
  f.rows.push(absent);
  assert.deepEqual((await f.source.poll(removed.checkpoint)).triggers, []);
});

test('all source budgets reject excess work instead of truncating a successful checkpoint', async () => {
  for (const [limits, setup, code] of [
    [{ maxIssues: 1 }, () => {}, 'QA_ISSUE_LIMIT'],
    [{ maxPages: 1 }, () => {}, 'QA_PAGE_LIMIT'],
    [{ maxCalls: 1 }, () => {}, 'QA_CALL_LIMIT'],
    [{ maxAttachments: 1 }, f => { f.files[1] = [1, 2]; }, 'QA_ATTACHMENT_LIMIT'],
    [{ maxTextBytes: 20 }, () => {}, 'QA_ISSUE_TEXT_LIMIT'],
    [{ maxCheckpointIssues: 1 }, () => {}, 'QA_CHECKPOINT_LIMIT'],
  ]) {
    const f = fixture({ limits }); setup(f);
    await assert.rejects(f.source.poll(), { code });
  }
  assert.equal(DEFAULT_QA_SOURCE_LIMITS.pageSize, 100); assert.equal(DEFAULT_QA_SOURCE_LIMITS.maxIssues, 2000);
});

test('duplicate attachments fail and missing fault time stays missing', async () => {
  const f = fixture(); f.files[1] = [{ id: 5 }, { id: 5 }];
  await assert.rejects(f.source.poll(), { code: 'QA_DUPLICATE_FILE' });
  f.files[1] = [];
  const baseline = await f.source.poll();
  assert.equal(baseline.checkpoint.seen['1'].issue.openedAt, '2026-01-01T00:00:00Z');
  assert.ok(!Object.hasOwn(baseline.checkpoint.seen['1'].issue, 'faultDate'));
});

test('checkpoint corruption is rejected and string IDs cannot mutate prototype state', async () => {
  const f = fixture(), baseline = (await f.source.poll()).checkpoint;
  baseline.seen['1'].issue.title = 'Tampered';
  await assert.rejects(f.source.poll(baseline), { code: 'QA_INVALID_CHECKPOINT' });
  f.rows = [row('__proto__')]; f.files = Object.create(null);
  const checkpoint = (await f.source.poll()).checkpoint;
  assert.ok(Object.hasOwn(checkpoint.seen, '__proto__'));
  assert.equal(Object.getPrototypeOf(checkpoint.seen), Object.prototype);
  assert.deepEqual((await f.source.poll(JSON.parse(JSON.stringify(checkpoint)))).triggers, []);
});

test('scan wall time and cancellation bound the whole scan without advancing baseline', async t => {
  const f = fixture(), controller = new AbortController();
  controller.abort(new Error('Synthetic cancellation'));
  await assert.rejects(f.source.poll(null, { signal: controller.signal }), /Synthetic cancellation/u);
  assert.equal(f.calls.length, 0);
  let elapsed = 1000;
  t.mock.method(Date, 'now', () => elapsed);
  f.adapter.listIssues = async () => { elapsed += 2; return { data: [], count: 0 }; };
  await assert.rejects(f.source.poll(null, { timeoutMs: 1 }), { code: 'QA_SCAN_TIMEOUT' });
  await assert.rejects(f.source.poll(null, { timeoutMs: 0 }), { code: 'QA_INVALID_SCAN_TIMEOUT' });
});
