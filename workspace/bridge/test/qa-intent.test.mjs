import test from 'node:test';
import assert from 'node:assert/strict';
import { isQaCandidate, parseQaIntents, QaIntentRouter } from '../qa-intent.mjs';

const binding = (extra = {}) => ({ sourceId: 'qa', projectId: 'p13', projectCode: 'T13JVP', conversationId: 'chat', enabled: true, ...extra });
const task = (extra = {}) => ({ id: 'T000001', kind: 'log-triage', sourceId: 'qa', projectId: 'p13', conversationId: 'chat', externalIssueNo: 'T13JVP-219', status: 'running', ...extra });
const event = (id, text, conversation_id = 'chat') => ({ id, text, conversation_id });
const context = (extra = {}) => ({ bindings: [binding()], tasks: [task()], ...extra });
const answer = (eventId, kind, extra = {}) => ({ eventId, kind, projectCode: null, issueNo: null, taskId: null, days: 7, question: '', ...extra });
const noModel = () => new QaIntentRouter({ classify: () => { throw new Error('No model expected.'); } });

test('the real user question queries recent QA issues without invoking an analysis or classifier', async () => {
  const [result] = await noModel().route([event(147, 'T13JVP最近没有bug么')], context());
  assert.deepEqual(result, answer(147, 'recent_issues', { projectCode: 'T13JVP' }));
});

test('recent questions accept ordinary wording, default one project and an explicit day range', async () => {
  const messages = ['有新缺陷吗？', '帮我查一下最近30天的Bug', 'T13JVP最近bug怎么样', '今天有没有新bug', '近一年有多少bug'];
  const results = await noModel().route(messages.map((text, index) => event(index, text)), context());
  assert.deepEqual(results.map(({ kind, days }) => [kind, days]), [['recent_issues', 7], ['recent_issues', 30], ['recent_issues', 7], ['recent_issues', 1], ['recent_issues', 365]]);
  assert.ok(results.every(result => result.taskId === null && result.issueNo === null));
});

test('analysis progress stays a read-only status query with optional original task or issue', async () => {
  const messages = ['分析进度怎么样了', 'T13JVP-219分析到哪了', '#T000001分析好没', '怎么还没结果'];
  const results = await noModel().route(messages.map((text, index) => event(index, text)), context());
  assert.ok(results.every(result => result.kind === 'analysis_status'));
  assert.equal(results[1].issueNo, 'T13JVP-219'); assert.equal(results[2].taskId, 'T000001');
});

test('only an explicit analysis request with one original issue number authorizes analyse_issue', async () => {
  const messages = ['麻烦帮我分析一下 T13JVP-219 的日志', '请排查 t13jvp-219', 'T13JVP-219分析一下', '能帮我分析一下 T13JVP-219 吗？', '能不能帮我分析T13JVP-219'];
  const results = await noModel().route(messages.map((text, index) => event(index, text)), context());
  assert.ok(results.every(result => result.kind === 'analyse_issue' && result.issueNo === 'T13JVP-219' && result.taskId === null));
  const [missing] = await noModel().route([event(9, '请分析T13JVP的日志')], context());
  assert.equal(missing.kind, 'clarify'); assert.match(missing.question, /编号/u);
});

test('negation and questions about progress or causes never start analysis', async () => {
  const messages = ['不要分析T13JVP-219', 'T13JVP-219为什么失败', '请告诉我T13JVP-219分析到哪了', 'T13JVP-219分析好了吗？', '不用再排查T13JVP-219', '能帮我看看T13JVP-219分析结果吗'];
  const results = await new QaIntentRouter().route(messages.map((text, index) => event(index, text)), context());
  assert.ok(results.every(result => result.kind !== 'analyse_issue'));
});

test('optional fault dates never become a recent-query time gate for analysis or progress', async () => {
  const messages = ['请分析T13JVP-219昨天的日志', '能帮我分析一下T13JVP-219在2026-11-19的日志吗？', 'T13JVP-219昨天的分析进度怎么样'];
  const results = await noModel().route(messages.map((text, index) => event(index, text)), context());
  assert.deepEqual(results.map(result => result.kind), ['analyse_issue', 'analyse_issue', 'analysis_status']);
});

test('non-QA work and disabled or foreign conversations remain available to BusinessRouter', async () => {
  for (const text of ['你好', '新任务：核对这些单据', '帮我分析这份财报']) {
    assert.equal(isQaCandidate(event(1, text), context()), false);
    assert.equal((await noModel().route([event(1, text)], context()))[0].kind, 'not_qa');
  }
  assert.equal(isQaCandidate(event(1, '最近有Bug吗', 'other'), context()), false);
  assert.equal(isQaCandidate(event(1, '最近有Bug吗'), context({ bindings: [binding({ enabled: false })] })), false);
  assert.equal(isQaCandidate(event(1, '最近有Bug吗'), context({ bindings: [binding({ enabled: undefined })] })), false);
});

test('multiple projects require clarification unless the original message names a bound project', async () => {
  const scoped = context({ bindings: [binding(), binding({ projectId: 'p2', projectCode: 'E03' })] });
  const results = await noModel().route([event(1, '最近有没有bug'), event(2, 'E03最近有什么bug'), event(3, 'OTHER最近有没有bug'), event(4, '请分析OTHER-20')], scoped);
  assert.deepEqual(results.map(result => result.kind), ['clarify', 'recent_issues', 'clarify', 'clarify']);
  assert.equal(results[1].projectCode, 'E03');
  const [selected] = await noModel().route([event(5, '#T000001分析到哪了')], scoped);
  assert.equal(selected.kind, 'analysis_status'); assert.equal(selected.projectCode, 'T13JVP');
});

test('ambiguous identifiers and invalid ranges ask a question instead of batching or resetting the range', async () => {
  const messages = ['请分析T13JVP-219和T13JVP-220', '#T000001 #T000002分析怎么样', '#T000099分析到哪了', '最近0天有bug吗', '最近366天有bug吗', '昨天有没有bug', '本月新缺陷', '2026-11-01到2026-11-20有bug吗', '最近三天有bug吗'];
  const results = await noModel().route(messages.map((text, index) => event(index, text)), context());
  assert.ok(results.every(result => result.kind === 'clarify' && result.question.length > 0));
});

test('an unrecognized QA candidate clarifies without a classifier', async () => {
  const [result] = await new QaIntentRouter().route([event(1, '日志这事儿请跟我说说')], context());
  assert.equal(result.kind, 'clarify'); assert.ok(result.question);
});

test('remaining natural expressions use a read-only typed classifier with only same-chat scope', async () => {
  let envelope, prompt;
  const router = new QaIntentRouter({ classify: async value => {
    prompt = value; envelope = JSON.parse(value.split('\n').at(-1));
    return JSON.stringify([answer(1, 'analysis_status', { projectCode: 'T13JVP' })]);
  } });
  const scoped = context({ bindings: [binding(), binding({ projectCode: 'SECRET', conversationId: 'other' })], tasks: [task(), task({ id: 'T000009', conversationId: 'other' })] });
  const [result] = await router.route([event(1, '日志这事儿请跟我说说')], scoped);
  assert.equal(result.kind, 'analysis_status'); assert.match(prompt, /只读QA意图/u);
  assert.deepEqual(envelope.bindings.map(value => value.projectCode), ['T13JVP']);
  assert.deepEqual(envelope.tasks.map(value => value.id), ['T000001']);
});

test('invalid or unknown classification produces one clarification rather than silence or work', async () => {
  for (const value of ['not JSON', JSON.stringify([answer(1, 'execute')]), JSON.stringify([answer(1, 'analysis_status', { projectCode: 'T13JVP', command: 'ignored' })])]) {
    const [result] = await new QaIntentRouter({ classify: async () => value }).route([event(1, '日志这事儿请跟我说说')], context());
    assert.equal(result.kind, 'clarify');
  }
});

test('a final not_qa classification lets a log parser development request reach BusinessRouter', async () => {
  const [result] = await new QaIntentRouter({ classify: async () => JSON.stringify([answer(1, 'not_qa')]) }).route([event(1, '新任务：写一个日志解析器')], context());
  assert.equal(result.kind, 'not_qa');
});

test('strict parsing refuses invented projects, issues, task targets and execution upgrades', () => {
  const input = [event(1, 'T13JVP最近没有bug么')], scoped = context();
  for (const result of [
    answer(1, 'recent_issues', { projectCode: 'OTHER' }),
    answer(1, 'analysis_status', { projectCode: 'T13JVP', issueNo: 'T13JVP-99' }),
    answer(1, 'analysis_status', { projectCode: 'T13JVP', taskId: 'T000001' }),
    answer(1, 'analyse_issue', { projectCode: 'T13JVP', issueNo: 'T13JVP-219' }),
    answer(1, 'recent_issues', { projectCode: 'T13JVP', days: 366 }),
  ]) assert.throws(() => parseQaIntents(JSON.stringify([result]), input, scoped));
  for (const text of ['不要分析T13JVP-219', 'T13JVP-219为什么失败']) {
    assert.throws(() => parseQaIntents(JSON.stringify([answer(1, 'analyse_issue', { projectCode: 'T13JVP', issueNo: 'T13JVP-219' })]), [event(1, text)], scoped));
  }
});

test('a model cannot select a log task from another project even in the same chat', () => {
  const scoped = context({ tasks: [task({ projectId: 'other' })] });
  assert.throws(() => parseQaIntents(JSON.stringify([answer(1, 'analysis_status', { projectCode: 'T13JVP', taskId: 'T000001' })]), [event(1, '#T000001日志情况')], scoped));
});

test('parser preserves input order and requires exactly one decision per event', () => {
  const events = [event(1, '日志情况'), event(2, '日志进展')];
  const parsed = parseQaIntents(JSON.stringify([answer(2, 'analysis_status', { projectCode: 'T13JVP' }), answer(1, 'recent_issues', { projectCode: 'T13JVP' })]), events, context());
  assert.deepEqual(parsed.map(result => result.eventId), [1, 2]);
  assert.throws(() => parseQaIntents(JSON.stringify([answer(1, 'not_qa'), answer(1, 'not_qa')]), events, context()));
});
