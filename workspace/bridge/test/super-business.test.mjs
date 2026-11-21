import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { SuperBusiness } from '../super-business.mjs';
import { WorkerRegistry } from '../worker-registry.mjs';
import { BusinessRouter } from '../business-router.mjs';
import { putNode, reference } from '../super-context.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const human = { id: 'human', is_bot: false }, bot = { id: 'bot', is_bot: true };
const chats = [{ id: 'chat', members: [human, bot] }];
const event = (id, text, extra = {}) => ({ id, text, conversation_id: 'chat', sender: human, ...extra });
async function until(predicate) { for (let n = 0; n < 300; n++) { if (predicate()) return; await delay(5); } assert.fail('Business task did not reach expected state.'); }
async function fixture(t, { run, state, resources, request } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'teamplay-business-')), calls = [], saved = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new WorkerRegistry({ agents: [{ id: 'test-agent', label: '已配置执行器', capabilities: ['data'], available: true, description: 'Synthetic data executor' }],
    workers: [{ id: 'data', label: '数据整理', description: 'Organize supplied business data', allowedAgents: ['test-agent'], requiredCapabilities: ['data'], skills: ['data-summary'], mcp: ['business-source'] }] });
  const executor = { run: async (input, options) => { calls.push(input); return run ? run(input, options, calls.length) : { completed: true, backend: 'test-agent', sessionId: 'native-one', text: '华东：12\n华南：8', usage: { elapsedMs: 1500, modelTurns: 1, toolCalls: 2 } }; }, close: async () => {} };
  const c = { state: state ?? { superAgent: { version: 3, tasks: {}, inbox: {}, outbox: {}, graph: {}, subscriptions: {} } }, config: { projectId: 'p' },
    conversations: structuredClone(chats), bot, stopping: false, writes: Promise.resolve(), now: () => new Date().toISOString(),
    get data() { return this.state.superAgent; },
    authorized(message, conversations) { return message.sender?.id === human.id && !message.sender.is_bot && message.conversation_id === 'chat'
      && conversations.some(chat => chat.id === 'chat' && chat.members.some(member => member.id === human.id) && chat.members.some(member => member.id === bot.id && member.is_bot)); },
    transaction(change) { const job = this.writes.then(async () => { const next = structuredClone(this.state); const result = await change(next.superAgent, next); this.state = next; saved.push(structuredClone(next)); return result; }); this.writes = job.catch(() => {}); return job; },
    api: { baseUrl: 'http://127.0.0.1', request: async (...args) => request ? request(...args) : structuredClone(chats) },
  };
  const router = new BusinessRouter({ registry, classify: async prompt => JSON.stringify(JSON.parse(prompt.split('\n').at(-1)).events.map(item => ({ eventId: item.id,
    action: 'new', taskId: null, workerId: 'data', agentId: 'test-agent', summary: '整理地区数据', instructions: '根据本消息材料按地区整理业务数据。' }))) });
  const business = new SuperBusiness({ coordinator: c, options: { root, workerResources: resources }, registry, router, executors: new Map([['test-agent', executor]]) });
  await c.transaction(data => business.initialize(data));
  t.after(() => business.close());
  const intake = async message => {
    await c.transaction(data => {
      const key = 'im:' + message.id; if (data.inbox[key]) return;
      const ref = reference('trigger', key), thread = reference('thread', 'business-test:chat');
      putNode(data.graph, { id: ref, kind: 'trigger', projectId: 'p', conversations: ['chat'], text: message.text, links: [thread] });
      putNode(data.graph, { id: thread, kind: 'thread', projectId: 'p', conversations: ['chat'], text: 'Synthetic chat', links: [ref] });
      data.inbox[key] = { key, event: message, status: 'pending' };
      assert.equal(business.captureIm(data, message, ref, thread), true);
    });
    await business.routePending();
  };
  return { root, c, business, registry, calls, saved, intake };
}

test('a natural business request is routed and returns one verified local TXT plus original result without extra progress messages', async t => {
  const f = await fixture(t);
  await f.intake(event(1, '帮我按地区整理这份业务数据'));
  await until(() => f.c.data.tasks.B000001?.status === 'completed');
  const task = f.c.data.tasks.B000001;
  assert.deepEqual([task.kind, task.workerId, task.agentId, task.sessionId], ['business', 'data', 'test-agent', 'native-one']);
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].cwd.startsWith(f.root)); assert.equal(task.cwd, f.calls[0].cwd);
  const deliveries = Object.values(f.c.data.outbox); assert.equal(deliveries.length, 1);
  const item = deliveries[0]; assert.equal(item.kind, 'business'); assert.equal(item.category, 'artifact'); assert.equal(item.text, '华东：12\n华南：8');
  const bytes = await readFile(item.artifact.pathPrivate);
  assert.equal(hash(bytes), item.artifact.sha256); assert.equal(bytes.length, item.artifact.size); assert.equal(item.artifact.name, '报告.txt');
  assert.match(bytes.toString('utf8'), /^华东：12\n华南：8\n\n本次用量/u); assert.match(bytes.toString('utf8'), /工具：2次/u);
  assert.equal(f.business.beforeSend(item, chats), 'send');
  assert.equal(f.business.beforeSend({ ...item, text: 'Changed result' }, chats), 'pause');
  assert.equal(f.business.beforeSend(item, [{ id: 'chat', members: [bot] }]), 'pause');
  assert.doesNotMatch(f.c.data.graph[task.resultReference].text, /pathPrivate|teamplay-business/u);
  await f.intake(event(1, 'Replayed event')); assert.equal(f.calls.length, 1);
});

test('a followup received during execution stays on the original native session and only publishes the latest completed revision', async t => {
  const waiting = [];
  const f = await fixture(t, { run: (input, _options, number) => new Promise(resolve => waiting.push(() => resolve({ completed: true,
    backend: 'test-agent', sessionId: input.sessionId ?? 'native-one', text: number === 1 ? 'First result' : 'Result including regional comparison' }))) });
  await f.intake(event(1, '请整理数据')); await until(() => f.calls.length === 1);
  await f.intake(event(2, '#B000001 加上地区同比'));
  assert.equal(f.c.data.tasks.B000001.inputRevision, 2); assert.equal(f.c.data.tasks.B000001.status, 'running');
  waiting[0](); await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].sessionId, 'native-one'); assert.equal(f.calls[1].cwd, f.calls[0].cwd);
  const input = JSON.parse(f.calls[1].prompt.split('\n').at(-1));
  assert.deepEqual(input.inputs.map(item => item.id), ['im:2']); assert.equal(input.inputs[0].text, '#B000001 加上地区同比');
  waiting[1](); await until(() => f.c.data.tasks.B000001.status === 'completed');
  const task = f.c.data.tasks.B000001, deliveries = Object.values(f.c.data.outbox);
  assert.equal(task.reportRevision, 2); assert.equal(Object.keys(task.results).length, 2);
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].text, 'Result including regional comparison');
});

test('stopping a running task waits for its adapter termination and does not emit a completed artifact', async t => {
  let aborted = false;
  const f = await fixture(t, { run: (_input, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('Stopped synthetic Agent'), { kind: 'cancelled', processTreeStopped: true, sessionId: 'native-one' })); }, { once: true });
  }) });
  await f.intake(event(1, '请整理数据')); await until(() => f.calls.length === 1);
  await f.intake(event(2, '停止任务 #B000001'));
  assert.equal(aborted, true); assert.equal(f.c.data.tasks.B000001.status, 'cancelled'); assert.equal(f.c.data.tasks.B000001.uncertain, false);
  assert.equal(f.c.data.tasks.B000001.lastRunStopped, true); assert.equal(f.business.runs.size, 0);
  assert.ok(Object.values(f.c.data.outbox).every(item => item.category !== 'artifact'));
});

test('restart retains an interrupted native task as uncertain and explicit resume cannot create a replacement session', async t => {
  const initial = await fixture(t, { run: () => { assert.fail('Uncertain historical work must not be executed.'); } });
  const old = { id: 'B000001', kind: 'business', projectId: 'p', conversationId: 'chat', event: event(1, 'Historical task'),
    workerId: 'data', agentId: 'test-agent', summary: '历史业务任务', instructions: '整理', status: 'running', attempt: 1, inputRevision: 1,
    inputs: [], consumedInputIds: [], results: {}, sessionId: 'native-original', reference: reference('task', 'business:B000001'), threadReference: reference('thread', 'old') };
  await initial.c.transaction(data => { data.tasks[old.id] = structuredClone(old); initial.business.initialize(data); });
  initial.business.kick(); await delay(5);
  assert.equal(initial.c.data.tasks.B000001.status, 'paused'); assert.equal(initial.c.data.tasks.B000001.uncertain, true);
  await initial.intake(event(2, '继续任务 #B000001'));
  assert.equal(initial.calls.length, 0); assert.equal(initial.c.data.tasks.B000001.sessionId, 'native-original');
  assert.equal(initial.c.data.tasks.B000001.status, 'paused'); assert.match(Object.values(initial.c.data.outbox)[0].text, /尚未确认结束/u);
});

test('same-message attachment bytes are downloaded and hash checked while trusted skill/MCP mappings bypass the model prompt', async t => {
  const content = Buffer.from('地区,数量\n华东,12\n华南,8'), server = createServer((_request, response) => { response.writeHead(200); response.end(content); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const resource = { data: { agents: { 'test-agent': { skillPaths: [join(tmpdir(), 'configured-skill.md')], mcpServers: [{ name: 'private-business', token: 'synthetic-secret' }] } } } };
  const f = await fixture(t, { resources: resource, request: async path => path.includes('/ticket') ? { url: baseUrl + '/download' } : structuredClone(chats) });
  f.c.api.baseUrl = baseUrl;
  await f.intake(event(1, '请整理本消息的附件', { attachment: { id: 'attachment1', name: 'sales.csv', size: content.length, sha256: hash(content), kind: 'file', mime: 'text/csv' } }));
  await until(() => f.c.data.tasks.B000001?.status === 'completed');
  const input = f.calls[0], payload = JSON.parse(input.prompt.split('\n').at(-1)), attached = payload.inputs[0].attachment;
  assert.deepEqual(await readFile(attached.local_path), content); assert.equal(attached.sha256, hash(content));
  assert.deepEqual(input.mcpServers, resource.data.agents['test-agent'].mcpServers);
  assert.deepEqual(input.skillPaths, resource.data.agents['test-agent'].skillPaths);
  assert.doesNotMatch(input.prompt, /synthetic-secret|configured-skill\.md/u);
});
