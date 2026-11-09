import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../core.mjs';
import { recoveryCommand } from '../recovery.mjs';

const human = { id: 'human', username: 'alice', is_bot: false };
const bot = { id: 'bot', username: 'dsh', is_bot: true };
const original = { id: 4, conversation_id: 'group', sender: human, text: 'Fix the current project task.', attachment: null };
const command = (id, text = '继续修正', extra = {}) => ({ ...original, id, text, ...extra });

function fixture(extra = {}) {
  const config = { executor: 'installed-headless', triggerMode: 'auto', botUsername: 'dsh', conversationIds: ['group', 'other'],
    senderIds: [human.id], harness: { cwd: 'synthetic-project', runTimeoutMs: 7200000 } };
  const state = { version: 1, identity: 'synthetic', cursor: 3, sessions: { group: 'original-logical-session' },
    current: { phase: 'uncertain', event: original, routing: { summary: 'Original task', instructions: 'Preserve and finish', context: [] }, noticeSent: true }, ...extra };
  const events = [], replies = new Map(), sessions = [], prompts = [];
  const stats = { runs: 0, classified: 0, writes: 0, abortedPreparations: 0, leaseHeld: false, failStartedWrites: 0,
    failRun: false, failPreparation: false, loseContinue: false, loseFinal: false, loseCancel: false, losePause: false };
  let lastId = 6, snapshot;
  const conversation = { id: 'group', members: [human, bot], is_direct: false };
  const api = {
    async request(route) {
      if (route === '/api/conversations') return [{ ...conversation, last_message: { id: Math.max(lastId, ...events.map(e => e.id)) } }, { id: 'other', members: [human, bot], is_direct: false }];
      if (route.startsWith('/api/agent/events')) return { events: events.filter(e => e.id > Number(new URLSearchParams(route.split('?')[1]).get('after'))) };
      if (route.includes('/messages?')) return [original];
      throw new Error('Unexpected synthetic route ' + route);
    },
    async reply(event, text, suffix) {
      const key = event.id + '-' + suffix;
      if (!replies.has(key)) replies.set(key, { id: ++lastId, text, suffix, eventId: event.id });
      for (const [prefix, flag] of [['continue-', 'loseContinue'], ['0', 'loseFinal'], ['cancel-', 'loseCancel'], ['pause-', 'losePause']]) {
        if (suffix.startsWith(prefix) && stats[flag]) { stats[flag] = false; throw new Error('Synthetic lost acknowledgement'); }
      }
      return replies.get(key);
    },
  };
  const store = { async write(value) {
    stats.writes++;
    if (value.current?.phase === 'started' && stats.failStartedWrites > 0) {
      stats.failStartedWrites--; const error = new Error('Synthetic started-state rename EPERM'); error.code = 'EPERM'; throw error;
    }
    snapshot = structuredClone(value);
  } };
  const executor = {
    async start() { if (stats.failPreparation) throw new Error('Synthetic unavailable executor'); },
    async classify() { stats.classified++; return JSON.stringify({ action: 'ignore', summary: 'Synthetic ignore', instructions: '', evidenceIds: [] }); },
    async session(id, restore) {
      if (stats.leaseHeld) throw new Error('Synthetic prepared lease was not released');
      sessions.push({ id, restore }); stats.leaseHeld = true;
      let invoked = false;
      return {
        abortPreparation: async () => { if (invoked) return false; invoked = true; stats.abortedPreparations++; stats.leaseHeld = false; return true; },
        run: async blocks => {
          invoked = true;
          try {
            stats.runs++; prompts.push(blocks[0].text);
            stats.onRun?.();
            if (stats.failRun) { const error = new Error('Private synthetic diagnostic'); error.kind = 'timeout'; error.processTreeStopped = true; throw error; }
            return { finishReason: 'completed', finalResponse: 'Synthetic finished' };
          } finally { stats.leaseHeld = false; }
        },
      };
    },
  };
  const create = value => new Bridge({ config, state: value, api, store, executor, bot });
  const bridge = create(state);
  return { bridge, state, config, events, replies, stats, sessions, prompts, conversation, create, snapshot: () => snapshot };
}

test('recovery controls are exact bounded phrases, with optional bot mention and punctuation', () => {
  for (const text of ['继续', '继续修正', '继续任务', '恢复任务', '重试任务', '@dsh 继续修正。', '@dsh，继续！'])
    assert.equal(recoveryCommand(text, 'dsh'), 'resume', text);
  for (const text of ['取消任务', '跳过任务', '@dsh 取消任务。']) assert.equal(recoveryCommand(text, 'dsh'), 'cancel');
  for (const text of ['继续讨论', '不要继续修正', '“继续修正”', '继续修正并删除文件', '@other 继续', '@dshx 继续', '', null])
    assert.equal(recoveryCommand(text, 'dsh'), null, String(text));
});

test('restart prepares a started task as paused without running, retaining older offline continue messages', async () => {
  const f = fixture(); f.state.current.phase = 'started'; f.events.push(command(7));
  await f.bridge.prepareChatRecovery(); await f.bridge.prepareChatRecovery();
  assert.equal(f.state.current.phase, 'uncertain'); assert.equal(f.bridge.taskStatus(), 'paused');
  assert.equal(f.state.cursor, 3); assert.equal(f.state.recoveryCursor, 4); assert.equal(f.stats.runs, 0);
  assert.equal(f.replies.size, 1);
  await f.bridge.poll();
  assert.equal(f.stats.runs, 1); assert.deepEqual(f.sessions, [{ id: 'original-logical-session', restore: true }]);
  assert.match(f.prompts[0], /Git diff/); assert.match(f.prompts[0], /不要 reset/); assert.match(f.prompts[0], /Fix the current project task/);
});

test('lost restart pause notice acknowledgement keeps preparation online and retries the same notice', async () => {
  const f = fixture(); f.stats.losePause = true;
  await f.bridge.prepareChatRecovery();
  assert.equal(f.bridge.taskStatus(), 'paused'); assert.equal(f.stats.runs, 0);
  assert.equal(f.state.current.pauseNotice.sent, false);
  await f.bridge.prepareChatRecovery();
  assert.equal(f.state.current.pauseNotice.sent, true); assert.equal(f.replies.size, 1); assert.equal(f.stats.runs, 0);
});

test('offline repeated continues authorize only one attempt and are not classified later', async () => {
  const f = fixture(); f.events.push(command(7), command(8));
  await f.bridge.poll();
  assert.equal(f.stats.runs, 1); assert.equal(f.state.cursor, 4); assert.equal(f.state.current, null);
  await f.bridge.poll();
  assert.equal(f.state.cursor, 8); assert.equal(f.stats.runs, 1); assert.equal(f.stats.classified, 0);
  assert.equal([...f.replies.values()].filter(r => r.suffix === 'no-paused-task').length, 0);
});

test('an admitted active worker reports running rather than paused', async () => {
  const f = fixture(); f.events.push(command(7));
  f.stats.onRun = () => { assert.equal(f.bridge.taskStatus(), 'running'); assert.equal(f.bridge.isPaused(), false); };
  await f.bridge.poll(); assert.equal(f.bridge.taskStatus(), 'ready');
});

test('the latest authorized control in the visible batch can cancel an earlier continue', async () => {
  const f = fixture(); f.events.push(command(7), command(8, '取消任务'));
  await f.bridge.poll();
  assert.equal(f.state.current, null); assert.equal(f.stats.runs, 0);
  assert.ok([...f.replies.values()].some(r => r.suffix === 'cancel-8'));
});

test('the latest authorized continue can supersede an earlier cancellation', async () => {
  const f = fixture(); f.events.push(command(7, '取消任务'), command(8));
  await f.bridge.poll();
  assert.equal(f.state.current, null); assert.equal(f.stats.runs, 1);
  assert.equal([...f.replies.values()].filter(r => r.suffix.startsWith('cancel-')).length, 0);
});

test('lost continue notice acknowledgement replays its stable notice before one worker admission', async () => {
  const f = fixture(); f.events.push(command(7)); f.stats.loseContinue = true;
  await assert.rejects(f.bridge.poll(), /lost acknowledgement/);
  assert.equal(f.state.current.phase, 'pending'); assert.equal(f.stats.runs, 0);
  const resumed = f.create(f.snapshot()); await resumed.poll();
  assert.equal(f.stats.runs, 1); assert.equal(resumed.state.current, null);
  assert.equal([...f.replies.values()].filter(r => r.suffix === 'continue-1').length, 1);
});

test('lost final acknowledgement replays saved result after restart without running again', async () => {
  const f = fixture(); f.events.push(command(7)); f.stats.loseFinal = true;
  await assert.rejects(f.bridge.poll(), /lost acknowledgement/);
  assert.equal(f.state.current.phase, 'reply'); assert.equal(f.stats.runs, 1);
  const resumed = f.create(f.snapshot()); await resumed.poll();
  assert.equal(f.stats.runs, 1); assert.equal(resumed.state.current, null);
  assert.equal([...f.replies.values()].filter(r => r.suffix === '0').length, 1);
});

test('a second timeout stays paused and old duplicate commands cannot authorize another attempt', async () => {
  const f = fixture(); f.events.push(command(7), command(8)); f.stats.failRun = true;
  await assert.rejects(f.bridge.poll(), /interrupted/);
  assert.equal(f.stats.runs, 1); assert.equal(f.bridge.taskStatus(), 'paused');
  const paused = [...f.replies.values()].find(r => r.suffix === 'pause-1');
  assert.match(paused.text, /2小时/); assert.doesNotMatch(paused.text, /Private synthetic/);
  const restarted = f.create(f.snapshot()); await restarted.poll();
  assert.equal(f.stats.runs, 1);
  const newId = f.state.recoveryCursor + 2; f.events.push(command(newId)); f.stats.failRun = false;
  await restarted.poll(); assert.equal(f.stats.runs, 2);
});

test('same-group ordinary messages receive one recovery hint while tasks remain paused', async () => {
  const f = fixture(); f.events.push(command(7, '继续讨论'));
  await f.bridge.poll(); await f.bridge.poll();
  assert.equal(f.stats.runs, 0); assert.equal(f.stats.classified, 0); assert.equal(f.state.cursor, 3);
  assert.equal([...f.replies.values()].filter(r => r.suffix === 'recovery-help').length, 1);
});

test('unauthorized, bot and another bound group cannot resume the paused task', async () => {
  const f = fixture(); f.events.push(command(7, '继续修正', { sender: { id: 'outsider', is_bot: false } }),
    command(8, '继续修正', { sender: bot }), command(9, '继续修正', { conversation_id: 'other' }));
  await f.bridge.poll();
  assert.equal(f.stats.runs, 0); assert.equal(f.state.current.phase, 'uncertain');
  assert.equal([...f.replies.values()].filter(r => r.suffix.startsWith('continue-')).length, 0);
});

test('revoked original author cannot be resumed by an otherwise authorized colleague', async () => {
  const f = fixture(); const colleague = { id: 'colleague', is_bot: false };
  f.config.senderIds = [colleague.id]; f.conversation.members.push(colleague); f.events.push(command(7, '继续', { sender: colleague }));
  await f.bridge.poll();
  assert.equal(f.stats.runs, 0); assert.equal(f.state.current.phase, 'uncertain');
  assert.ok([...f.replies.values()].some(r => r.suffix === 'recovery-blocked'));
});

test('a persisted unconfirmed process termination blocks recovery even after a new bridge is created', async () => {
  const f = fixture(); f.state.current.failure = { kind: 'termination-failed', processTreeStopped: false }; f.events.push(command(7));
  await f.bridge.poll(); const restarted = f.create(f.snapshot()); await restarted.poll();
  assert.equal(f.stats.runs, 0); assert.equal(restarted.state.current.failure.processTreeStopped, false);
});

test('an unconfirmed classifier termination pauses with a local-check message rather than inviting retry', async () => {
  const f = fixture(); f.state.current = { phase: 'routing_failed', event: original, failure: { processTreeStopped: false } };
  await f.bridge.prepareChatRecovery();
  const text = [...f.replies.values()][0].text;
  assert.match(text, /尚未确认退出/); assert.doesNotMatch(text, /发送.*继续修正/);
  f.events.push(command(8)); await f.bridge.poll(); assert.equal(f.stats.classified, 0); assert.equal(f.stats.runs, 0);
});

test('missing original session mapping never silently degrades to a new session on later continues', async () => {
  const f = fixture({ sessions: {} }); f.events.push(command(7));
  await assert.rejects(f.bridge.poll(), /mapping is missing/);
  assert.equal(f.state.current.phase, 'uncertain'); assert.equal(f.stats.runs, 0);
  const later = f.state.recoveryCursor + 2; f.events.push(command(later));
  await assert.rejects(f.bridge.poll(), /mapping is missing/);
  assert.equal(f.sessions.length, 0); assert.equal(f.stats.runs, 0);
});

test('failed resume preparation pauses instead of entering an automatic retry loop', async () => {
  const f = fixture(); f.events.push(command(7)); f.stats.failPreparation = true;
  await assert.rejects(f.bridge.poll(), /unavailable executor/);
  assert.equal(f.state.current.phase, 'uncertain'); assert.equal(f.state.current.failure.stage, 'preparation');
  await f.bridge.poll(); assert.equal(f.stats.runs, 0);
});

test('a failed started-state write releases unused preparation and removes only its new logical reservation', async () => {
  const f = fixture({ sessions: {}, current: { phase: 'pending', event: original, noticeSent: true } });
  f.stats.failStartedWrites = 1;
  await assert.rejects(f.bridge.poll(), /rename EPERM/);
  assert.equal(f.stats.runs, 0); assert.equal(f.stats.abortedPreparations, 1); assert.equal(f.stats.leaseHeld, false);
  assert.deepEqual(f.state.sessions, {}); assert.equal(f.state.current.phase, 'uncertain');
  assert.equal(f.state.current.failure.stage, 'preparation');
  f.events.push(command(f.state.recoveryCursor + 2)); await f.bridge.poll();
  assert.equal(f.stats.runs, 1); assert.equal(f.state.current, null);
  assert.equal(f.sessions.length, 2); assert.ok(f.sessions.every(session => !session.restore));
});

test('failed resumed started-state write preserves the original session and a later continue restores it', async () => {
  const f = fixture(); f.events.push(command(7)); f.stats.failStartedWrites = 1;
  await assert.rejects(f.bridge.poll(), /rename EPERM/);
  assert.equal(f.stats.runs, 0); assert.equal(f.stats.abortedPreparations, 1); assert.equal(f.stats.leaseHeld, false);
  assert.equal(f.state.sessions.group, 'original-logical-session');
  assert.equal(f.state.current.resume.requiresExistingSession, true);
  f.events.push(command(f.state.recoveryCursor + 2)); await f.bridge.poll();
  assert.equal(f.stats.runs, 1); assert.equal(f.state.current, null);
  assert.ok(f.sessions.every(session => session.id === 'original-logical-session' && session.restore));
});

test('a worker that was actually invoked keeps its mapping and never takes preparation cleanup', async () => {
  const f = fixture(); f.events.push(command(7)); f.stats.failRun = true;
  await assert.rejects(f.bridge.poll(), /interrupted/);
  assert.equal(f.stats.runs, 1); assert.equal(f.stats.abortedPreparations, 0);
  assert.equal(f.state.sessions.group, 'original-logical-session'); assert.equal(f.state.current.failure.stage, 'worker');
});

test('cancel survives a lost acknowledgement, preserves code/session state and unlocks new tasks', async () => {
  const f = fixture(); f.events.push(command(7, '取消任务')); f.stats.loseCancel = true;
  await assert.rejects(f.bridge.poll(), /lost acknowledgement/);
  assert.equal(f.state.current.cancelRequest.commandId, 7);
  const restarted = f.create(f.snapshot()); await restarted.poll();
  assert.equal(restarted.state.current, null); assert.equal(restarted.state.cursor, 4); assert.equal(f.stats.runs, 0);
  assert.equal(restarted.state.sessions.group, 'original-logical-session');
  f.events.push(command(20, 'A different ordinary discussion.')); await restarted.poll();
  assert.equal(f.stats.classified, 1); assert.equal(f.stats.runs, 0);
});

test('a control command without a paused task returns useful feedback without model classification', async () => {
  const f = fixture({ current: null, cursor: 4 }); f.events.push(command(7));
  await f.bridge.poll();
  assert.equal(f.stats.classified, 0); assert.equal(f.stats.runs, 0);
  assert.ok([...f.replies.values()].some(r => r.suffix === 'no-paused-task'));
});

test('routing failure resumes the same original event through classification only on explicit continue', async () => {
  const f = fixture(); f.state.current = { phase: 'routing_failed', event: original };
  await f.bridge.prepareChatRecovery(); assert.equal(f.stats.classified, 0);
  f.events.push(command(8)); await f.bridge.poll();
  assert.equal(f.stats.classified, 1); assert.equal(f.stats.runs, 0); assert.equal(f.state.current, null);
});
