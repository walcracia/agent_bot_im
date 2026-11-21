import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessRouter, parseBusinessRoutes } from '../business-router.mjs';
import { WorkerRegistry } from '../worker-registry.mjs';

const registry = (available = true) => new WorkerRegistry({
  agents: [
    { id: 'dsh', label: 'DSH', description: 'Configured coding and plugin session', capabilities: ['code', 'skill'], available: true },
    { id: 'pi', label: 'Pi', description: 'Configured business data session', capabilities: ['data', 'mcp'], available },
  ],
  workers: [
    { id: 'coding', label: '代码处理', description: 'Modify supplied project code and verify', allowedAgents: ['dsh'], requiredCapabilities: ['code'] },
    { id: 'data', label: '数据查询整理', description: 'Query registered business sources and organize returned data', allowedAgents: ['pi'], requiredCapabilities: ['data'], mcp: ['qa-server'] },
  ],
});
const event = (id, text, conversation_id = 'chat') => ({ id, text, conversation_id });
const task = (extra = {}) => ({ id: 'B000001', kind: 'business', conversationId: 'chat', workerId: 'data', agentId: 'pi', status: 'paused', ...extra });
const route = (eventId, action, extra = {}) => ({ eventId, action, taskId: null, workerId: null, agentId: null, summary: '', instructions: '', ...extra });

test('a bare business reference is a status lookup regardless of letter case and starts no new work', async () => {
  const router = new BusinessRouter({ registry: registry(), classify: () => { throw new Error('No model needed'); } });
  for (const text of ['#B000001', '#b000001', '#b000001，', '#B000001,', '#B000001.']) {
    const [result] = await router.route([event(7, text)], { tasks: [task({ status: 'completed' })] });
    assert.equal(result.action, 'status'); assert.equal(result.taskId, 'B000001'); assert.equal(result.agentId, null);
  }
});

test('semantic candidate input covers data, MCP and code requests and keeps ordinary greetings off the classifier', async () => {
  let input, calls = 0;
  const router = new BusinessRouter({ registry: registry(), classify: async prompt => {
    calls++; input = prompt;
    return JSON.stringify([
      route(2, 'new', { workerId: 'data', agentId: 'pi', summary: '统计业务数据', instructions: '读取已登记来源，按地区整理本月销量。' }),
      route(3, 'new', { workerId: 'coding', agentId: 'dsh', summary: '修复总计', instructions: '修复项目总计少一项，并验证。' }),
    ]);
  } });
  const result = await router.route([event(1, '你好'), event(2, '帮我从业务系统读取本月销量，按地区整理'), event(3, '帮我修复总计少一项的问题')]);
  assert.equal(calls, 1); assert.deepEqual(result.map(item => [item.eventId, item.action, item.workerId, item.agentId]), [
    [1, 'ignore', null, null], [2, 'new', 'data', 'pi'], [3, 'new', 'coding', 'dsh'],
  ]);
  assert.match(input, /MCP或Skill/u); assert.match(input, /根据登记的实际用途/u);
  const envelope = JSON.parse(input.split('\n').at(-1));
  assert.deepEqual(envelope.events.map(item => item.id), [2, 3]);
  assert.deepEqual(envelope.registry.workers.find(worker => worker.id === 'data').availableAgents, ['pi']);
});

test('explicit B-task controls and followups keep the original binding without classification or retargeting another chat', async () => {
  const router = new BusinessRouter({ registry: registry(), classify: async () => { assert.fail('An explicit task control must not classify.'); } });
  const result = await router.route([event(1, '#B000001 加上地区同比'), event(2, '继续 #B000001'), event(3, '停止任务 #B000001'),
    event(4, '任务状态 #B000001'), event(5, '#B000002 加上明细'), event(6, '谢谢')], { tasks: [task(), task({ id: 'B000002', conversationId: 'elsewhere' })] });
  assert.deepEqual(result.map(item => item.action), ['followup', 'resume', 'stop', 'status', 'need_info', 'ignore']);
  for (const item of result.slice(0, 2)) assert.deepEqual([item.taskId, item.workerId, item.agentId], ['B000001', 'data', 'pi']);
  assert.equal(result[2].taskId, 'B000001'); assert.equal(result[2].workerId, null); assert.equal(result[2].agentId, null);
  assert.equal(result[4].taskId, null);
});

test('an unavailable original executor requires information and never silently switches to another Agent', async () => {
  const router = new BusinessRouter({ registry: registry(false), classify: async () => { assert.fail('An explicit task has an existing binding.'); } });
  const tasks = [task()], before = structuredClone(tasks);
  const result = await router.route([event(1, '#B000001 请补充'), event(2, '继续任务 #B000001'), event(3, '取消任务 #B000001')], { tasks });
  assert.deepEqual(result.map(item => item.action), ['need_info', 'need_info', 'stop']);
  assert.ok(result.every(item => item.workerId === null && item.agentId === null && item.taskId === 'B000001'));
  assert.deepEqual(tasks, before);
});

test('the model may report missing registered capability instead of inventing an executor', async () => {
  const router = new BusinessRouter({ registry: new WorkerRegistry(), classify: async () => JSON.stringify([
    route(1, 'need_info', { summary: '尚未接入数据查询', instructions: '还没有可用的数据查询执行器，请先接入。' }),
  ]) });
  assert.equal((await router.route([event(1, '帮我读取订单并统计')]))[0].action, 'need_info');
});

test('AI output cannot select foreign tasks, unready or unauthorized executors, extra command fields, or change a task binding', () => {
  const events = [event(1, '请处理')], tasks = [task(), task({ id: 'B000002', conversationId: 'elsewhere' }), task({ id: 'B000003', kind: 'log-triage' })];
  const valid = route(1, 'new', { workerId: 'data', agentId: 'pi', summary: '查询', instructions: '读取数据' });
  for (const changed of [
    { ...valid, command: 'run arbitrary commands' }, { ...valid, agentId: 'invented' }, { ...valid, workerId: 'coding', agentId: 'pi' },
    { ...valid, action: 'followup', taskId: 'B000002' }, { ...valid, action: 'followup', taskId: 'B000003' },
    { ...valid, action: 'followup', taskId: 'B000001', workerId: 'coding', agentId: 'dsh' }, { ...valid, taskId: 'B000001' },
  ]) assert.throws(() => parseBusinessRoutes(JSON.stringify([changed]), events, tasks, registry()));
  assert.throws(() => parseBusinessRoutes(JSON.stringify([valid]), events, tasks, registry(false)));
  assert.deepEqual(parseBusinessRoutes(JSON.stringify([valid]), events, tasks, registry()), [valid]);
});

test('routing output is complete, unique and reordered to the incoming message order', () => {
  const events = [event(1, 'one'), event(2, 'two')], decisions = [route(2, 'ignore'), route(1, 'ignore')];
  assert.deepEqual(parseBusinessRoutes(JSON.stringify(decisions), events, [], registry()).map(item => item.eventId), [1, 2]);
  assert.throws(() => parseBusinessRoutes(JSON.stringify([decisions[0]]), events, [], registry()));
  assert.throws(() => parseBusinessRoutes(JSON.stringify([decisions[0], decisions[0]]), events, [], registry()));
  assert.throws(() => parseBusinessRoutes(JSON.stringify([{ ...route(1, 'ignore'), instructions: 'perform a task' }]), [events[0]], [], registry()));
});
