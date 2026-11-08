import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../core.mjs';

const human = { id: 'u1', username: 'alice', is_bot: false };
const event = { id: 12, conversation_id: 'c1', sender: human, text: '人数统计总是少一位，需要修复并验证。', attachment: null };
const conversation = { id: 'c1', title: 'Project', is_direct: false };

function fixture() {
  const state = { cursor: 0, current: null, sessions: {} };
  const stats = { classified: 0, runs: 0, replies: [], loseFinal: false, invalid: false, workerFails: false, prompt: '' };
  const config = { triggerMode: 'auto', conversationIds: ['c1'], senderIds: ['u1'], botUsername: 'dsh', harness: { cwd: 'test' } };
  const api = {
    async request(route) {
      if (route === '/api/conversations') return [conversation];
      if (route.includes('/messages?')) return [{ ...event, id: 11, text: '这里讨论的是当前项目的统计函数。' }, event];
      if (route.startsWith('/api/agent/events')) return { events: state.cursor ? [] : [event] };
      throw new Error(`Unexpected route: ${route}`);
    },
    async reply(input, text, suffix) {
      stats.replies.push({ event: input.id, text, suffix });
      if (suffix === '0' && stats.loseFinal) { stats.loseFinal = false; throw new Error('Lost acknowledgement'); }
    },
  };
  const executor = {
    async classify() {
      stats.classified++;
      return stats.invalid ? '{"action":"code_task"}' : JSON.stringify({ action: 'code_task', summary: '修正统计函数', instructions: '修正统计并运行相应测试', evidenceIds: [event.id] });
    },
    async start() {},
    async session() { return { run: async blocks => { stats.runs++; stats.prompt = blocks[0].text; if (stats.workerFails) throw new Error('Internal private diagnostic'); return { finalResponse: '已修改，测试通过。', finishReason: 'completed' }; } }; },
  };
  const bridge = new Bridge({ config, api, state, store: { async write() {} }, executor, bot: { id: 'bot' } });
  return { bridge, state, stats, config };
}

test('ordinary discussion creates one task with bounded discussion context and durable result replay', async () => {
  const { bridge, state, stats } = fixture();
  stats.loseFinal = true;
  await assert.rejects(bridge.poll(), /Lost acknowledgement/);
  assert.equal(state.current.phase, 'reply');
  assert.equal(stats.classified, 1);
  assert.equal(stats.runs, 1);
  assert.match(stats.prompt, /当前项目的统计函数/);
  await bridge.poll();
  assert.equal(stats.classified, 1);
  assert.equal(stats.runs, 1);
  assert.equal(state.cursor, event.id);
  assert.equal(state.current, null);
  assert.equal(stats.replies.filter(reply => reply.suffix === 'accepted').length, 1);
});

test('invalid semantic decision stops before worker and requires explicit routing retry', async () => {
  const { bridge, state, stats } = fixture();
  stats.invalid = true;
  await assert.rejects(bridge.poll(), /Task decision/);
  assert.equal(state.current.phase, 'routing_failed');
  assert.equal(stats.runs, 0);
  await assert.rejects(bridge.resolveCurrent(), /routing.*failed/);
  await assert.rejects(bridge.poll(), /requires operator resolution/);
  assert.equal(stats.classified, 1);
  stats.invalid = false;
  await bridge.resolveCurrent(String(event.id));
  await bridge.poll();
  assert.equal(stats.classified, 2);
  assert.equal(stats.runs, 1);
  assert.equal(state.cursor, event.id);
});

test('automatic mode does not promote an unauthorized author into a task', async () => {
  const { bridge, state, stats, config } = fixture();
  config.senderIds = [];
  await bridge.poll();
  assert.equal(stats.classified, 0);
  assert.equal(stats.runs, 0);
  assert.equal(state.cursor, event.id);
});

test('a stopped code worker leaves uncertain state and a concise recovery notice without leaking diagnostics', async () => {
  const { bridge, state, stats } = fixture();
  stats.workerFails = true;
  await assert.rejects(bridge.poll(), /interrupted/);
  assert.equal(state.current.phase, 'uncertain');
  const notice = stats.replies.find(reply => reply.suffix === 'execution-error');
  assert.ok(notice);
  assert.doesNotMatch(notice.text, /Internal private/);
  await assert.rejects(bridge.poll(), /requires operator resolution/);
  assert.equal(stats.classified, 1);
  assert.equal(stats.runs, 1);
});
