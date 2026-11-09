import { createHash, randomUUID } from 'node:crypto';
import { inlineContext, putNode, readNode, reference } from './super-context.mjs';
import { taskControl } from './super-router.mjs';
import { attachmentInput } from './core.mjs';

const RUNNING = new Set(['preparing', 'running', 'interrupting', 'delivering']);
const TERMINAL = new Set(['completed', 'cancelled', 'closed', 'merged']);
const labels = { queued: '排队中', preparing: '准备中', running: '处理中', interrupting: '正在停止', paused: '已暂停',
  delivering: '正在交付', ready: '等待评审', completed: '已完成', cancelled: '已停止', closed: '已关闭', merged: '已合并' };
const stamp = () => new Date().toISOString();

export class SuperCoordinator {
  constructor({ state, store, config, api, bot, router, pool, delivery, release, now = stamp }) {
    Object.assign(this, { state, store, config, api, bot, router, pool, delivery, release, now });
    this.generation = randomUUID(); this.writes = Promise.resolve(); this.active = new Map();
    this.outgoing = false; this.routing = false; this.pumping = false; this.stopping = false;
    this.releases = new Map();
  }
  get data() { return this.state.superAgent; }
  async transaction(change) {
    const work = this.writes.then(async () => {
      const next = structuredClone(this.state);
      const result = await change(next.superAgent, next);
      await this.store.write(next); this.state = next;
      return result;
    });
    this.writes = work.catch(() => {});
    return work;
  }
  async initialize() {
    if (this.state.current) throw new Error('Legacy task is unresolved. Preserve it and finish explicit migration before enabling Super-agent.');
    if (this.data && this.data.version !== 3) throw new Error('Unsupported Super-agent state; preserve it.');
    await this.transaction((data, state) => {
      data ??= state.superAgent = { version: 3, nextTask: 1, tasks: {}, graph: {}, inbox: {}, outbox: {}, subscriptions: {}, actions: {}, sources: {} };
      data.generation = this.generation; data.heartbeat = this.now();
      for (const task of Object.values(data.tasks)) {
        if (task.releaseStatus === 'running') task.releaseStatus = 'recovering';
        if (RUNNING.has(task.status)) {
          task.status = 'paused'; task.error = '协调器在执行期间重启。保留原会话与修改，先核对执行端，再明确继续。';
          task.uncertain = true; task.updatedAt = this.now();
          this.enqueue(data, task.event, `#${task.id} 执行被中断，已有修改和会话保留。核对后发送“继续修正 #${task.id}”。`, `restart-${task.id}-${task.attempt}`);
        }
      }
      for (const item of Object.values(data.inbox)) if (item.status === 'routing') item.status = 'pending';
    });
    this.kick();
  }
  enqueue(data, event, text, key) {
    if (data.outbox[key]) return;
    data.outbox[key] = { key, event: { id: event.id, conversation_id: event.conversation_id }, text: String(text).slice(0, 9000), status: 'pending', attempts: 0, at: this.now() };
  }
  authorized(event, conversations) {
    const conversation = conversations.find(item => item.id === event.conversation_id);
    return event.sender && !event.sender.is_bot && event.sender.id !== this.bot.id
      && this.config.conversationIds.includes(event.conversation_id) && this.config.senderIds.includes(event.sender.id)
      && conversation?.members?.some(member => member.id === this.bot.id && member.is_bot)
      && conversation.members.some(member => member.id === event.sender.id && !member.is_bot);
  }
  taskNode(data, task) {
    putNode(data.graph, { id: task.reference, kind: 'task', projectId: task.projectId, conversations: [task.conversationId],
      text: JSON.stringify({ id: task.id, summary: task.summary, instructions: task.instructions, status: task.status, progress: task.progress, delivery: task.delivery }),
      links: [task.threadReference, ...(task.prThreadReference ? [task.prThreadReference] : []), ...(task.relatedTaskIds ?? []).map(id => data.tasks[id]?.reference).filter(Boolean), ...task.inputs.map(input => input.reference), ...(task.resultReference ? [task.resultReference] : [])], at: task.updatedAt });
  }
  async ingestIm(events, conversations) {
    this.conversations = structuredClone(conversations);
    const fast = [];
    await this.transaction((data, state) => {
      for (const event of events) {
        if (!Number.isSafeInteger(event.id) || event.id <= state.cursor) continue;
        if (this.authorized(event, conversations)) {
          const key = `im:${event.id}`;
          if (!data.inbox[key]) {
            const ref = reference('trigger', key), thread = reference('thread', `im:${event.conversation_id}`);
            putNode(data.graph, { id: ref, kind: 'trigger', projectId: this.config.projectId, conversations: [event.conversation_id], text: JSON.stringify(event), links: [thread], meta: { eventId: event.id } });
            const prior = data.graph[thread];
            putNode(data.graph, { id: thread, kind: 'thread', projectId: this.config.projectId, conversations: [event.conversation_id],
              text: `IM conversation ${event.conversation_id}`, links: [...(prior?.links ?? []), ref] });
            data.inbox[key] = { key, event, reference: ref, threadReference: thread, status: 'pending', attempts: 0 };
            const own = Object.values(data.tasks).filter(task => task.conversationId === event.conversation_id);
            const control = taskControl(event.text, own);
            const explicit = /(?:^|\s)#(T\d{6,})(?=\s|[，,:：]|$)/iu.exec(event.text);
            if (control) fast.push({ eventId: event.id, ...control });
            else if (explicit && own.some(task => task.id === explicit[1].toUpperCase())) fast.push({ eventId: event.id, action: 'followup', taskId: explicit[1].toUpperCase(), instructions: event.text });
          }
        }
        state.cursor = event.id;
      }
      data.heartbeat = this.now();
    });
    const revoked = Object.values(this.data.tasks).filter(task => !TERMINAL.has(task.status) && task.status !== 'paused' && !this.authorized(task.event, conversations));
    for (const task of revoked) {
      await this.transaction(data => { const current = data.tasks[task.id]; current.stopRequested = true; current.pauseRequested = true;
        current.status = this.active.has(task.id) ? 'interrupting' : 'paused'; current.error = '原任务成员或会话授权已失效。'; });
      this.stopTask(task.id, 'Task authorization revoked').catch(error => this.pause(task.id, error));
    }
    for (const decision of fast) await this.applyDecision(`im:${decision.eventId}`, decision);
    this.kick();
  }
  async routePending() {
    if (this.routing || this.stopping) return;
    this.routing = true;
    try {
      const batch = Object.values(this.data.inbox).filter(item => item.status === 'pending').slice(0, this.config.routerBatchSize ?? 8);
      if (!batch.length) return;
      await this.transaction(data => { for (const item of batch) if (data.inbox[item.key].status === 'pending') data.inbox[item.key].status = 'routing'; });
      const conversations = [...new Set(batch.map(item => item.event.conversation_id))];
      const tasks = Object.values(this.data.tasks).filter(task => conversations.includes(task.conversationId)).slice(-80);
      const context = inlineContext(this.data.graph, [...batch.map(item => item.threadReference), ...tasks.slice(-12).map(task => task.reference)], { projectId: this.config.projectId, conversations });
      let decisions;
      try { decisions = await this.router.route(batch.map(item => item.event), { tasks, context }); }
      catch (error) {
        await this.transaction(data => {
          for (const item of batch) {
            const entry = data.inbox[item.key]; if (entry.status !== 'routing') continue;
            entry.status = 'failed'; entry.error = String(error.message).slice(0, 500); entry.attempts++;
            this.enqueue(data, item.event, '这条任务暂时未能识别，尚未开始改代码。可以补充明确需求后重发；其他任务继续处理。', `route-failed-${item.key}`);
          }
        }); return;
      }
      for (const decision of decisions) await this.applyDecision(`im:${decision.eventId}`, decision);
    } finally { this.routing = false; }
  }
  async applyDecision(key, decision) {
    let input, target, control;
    await this.transaction(data => {
      const entry = data.inbox[key];
      if (!entry || entry.status === 'routed') return;
      const event = entry.event;
      let task = decision.taskId ? data.tasks[decision.taskId] : null;
      if (decision.taskId && (!task || task.conversationId !== event.conversation_id)) {
        this.enqueue(data, event, '当前聊天中找不到该任务。发送“任务列表”查看可操作的编号。', `unknown-${key}`);
        entry.status = 'routed'; entry.decision = { action: 'unavailable' }; return;
      }
      if (decision.action === 'attach' && task) {
        const other = data.tasks[decision.relatedTaskId];
        if (!other || other.id === task.id || other.projectId !== task.projectId || other.conversationId !== task.conversationId) {
          this.enqueue(data, event, '只能关联当前聊天中的两项不同任务。', `attach-invalid-${key}`);
        } else {
          task.relatedTaskIds = [...new Set([...(task.relatedTaskIds ?? []), other.id])];
          other.relatedTaskIds = [...new Set([...(other.relatedTaskIds ?? []), task.id])];
          for (const linked of [task, other]) if (linked.delivery?.threadId) data.subscriptions[linked.delivery.threadId] = [...new Set([...(data.subscriptions[linked.delivery.threadId] ?? []), task.id, other.id])];
          this.taskNode(data, other);
          this.enqueue(data, event, `已关联 #${task.id} 和 #${other.id}，后续相关反馈将共享为上下文。`, `attach-${key}`);
        }
      } else if (decision.action === 'new') {
        const id = 'T' + String(data.nextTask++).padStart(6, '0');
        task = { id, projectId: this.config.projectId, conversationId: event.conversation_id, event,
          summary: decision.summary, instructions: decision.instructions, status: 'queued', attempt: 0, inputs: [],
          reference: reference('task', id), threadReference: entry.threadReference, createdAt: this.now(), updatedAt: this.now() };
        data.tasks[id] = task; data.subscriptions[entry.reference] = [id];
        input = { id: key, source: 'im', text: event.text, at: event.created_at, reference: entry.reference };
        task.inputs.push(input);
        this.enqueue(data, event, `已接到任务 #${id}：${task.summary}。`, `accepted-${id}`);
      } else if (decision.action === 'followup' && task) {
        input = { id: key, source: 'im', text: decision.instructions || event.text, at: event.created_at, reference: entry.reference };
        if (!task.inputs.some(item => item.id === input.id)) task.inputs.push(input);
        task.updatedAt = this.now(); target = task.id;
        task.autoRepairs = 0;
        if (['completed', 'ready', 'paused'].includes(task.status)) { task.status = 'queued'; task.uncertain = false; }
        if (['closed', 'merged', 'cancelled'].includes(task.status)) {
          task.status = 'paused'; task.error = '任务已结束。明确继续后再执行新补充。';
        }
        data.subscriptions[entry.reference] = [...new Set([...(data.subscriptions[entry.reference] ?? []), task.id])];
        this.enqueue(data, event, `补充已加入 #${task.id}。`, `input-${key}`);
      } else if (decision.action === 'stop' && task) {
        target = task.id; control = 'stop'; task.stopRequested = true; task.pauseRequested = false; task.updatedAt = this.now();
        task.status = this.active.has(task.id) ? 'interrupting' : 'cancelled';
        this.enqueue(data, event, `正在停止 #${task.id}，已有代码和记录会保留。`, `stop-${key}`);
      } else if (decision.action === 'resume' && task) {
        if (this.active.has(task.id)) this.enqueue(data, event, `#${task.id} 正在处理，无需重复继续。`, `resume-active-${key}`);
        else if (['paused', 'ready', 'cancelled', 'completed'].includes(task.status)) {
          task.status = 'queued'; task.stopRequested = false; task.pauseRequested = false; task.uncertain = false; task.updatedAt = this.now();
          task.inputs.push({ id: key, source: 'im', text: '继续原任务，先核对已有改动和完成步骤，保留文件，不重复执行已完成操作。', reference: entry.reference, at: event.created_at });
          this.enqueue(data, event, `正在接续 #${task.id}。`, `resume-${key}`);
        }
      } else if (decision.action === 'status') {
        const list = task ? [task] : Object.values(data.tasks).filter(item => item.conversationId === event.conversation_id).slice(-12);
        this.enqueue(data, event, list.length ? list.map(item => `#${item.id} ${labels[item.status] ?? item.status} · ${item.summary}${item.error ? `\n${item.error}` : ''}${item.watchdog?.reason ? `\n监督：${item.watchdog.reason}` : ''}${item.delivery?.url ? `\n${item.delivery.url}` : ''}`).join('\n') : '当前没有任务。', `status-${key}`);
      } else if (decision.action === 'details' && task) {
        this.enqueue(data, event, `#${task.id} ${labels[task.status]}\n${task.error ?? task.result ?? '任务仍在处理。'}${task.assessment?.reason ? `\n监督记录：${task.assessment.reason}` : ''}${task.watchdog?.reason ? `\n暂停原因：${task.watchdog.reason}` : ''}${task.delivery?.url ? `\n${task.delivery.url}` : ''}${task.releaseError ? `\n发布：${task.releaseError}` : ''}${task.diagnosticPath || task.releaseDiagnosticPath ? `\n本机运行记录：${task.diagnosticPath ?? task.releaseDiagnosticPath}` : ''}`, `details-${key}`);
      } else if (decision.action === 'ambiguous') {
        this.enqueue(data, event, '请带上任务编号，例如“取消任务 #T000001”或“继续修正 #T000001”。发送“任务列表”可查看编号。', `ambiguous-${key}`);
      }
      if (task) this.taskNode(data, task);
      entry.status = 'routed'; entry.decision = { action: decision.action, taskId: task?.id ?? null }; entry.routedAt = this.now();
    });
    if (control) this.stopTask(target).catch(error => this.pause(target, error));
    else if (target && input && this.active.get(target)?.started) this.pool.input(target, input).catch(error => this.inputFailure(target, error));
    this.kick();
  }
  kick() {
    if (this.stopping) return;
    this.pump().catch(error => { this.lastError = String(error.message); });
    this.flushOutbox().catch(error => { this.lastError = String(error.message); });
    for (const task of Object.values(this.data.tasks)) if (task.status === 'merged') this.queueRelease(task.id);
  }
  async pump() {
    if (this.pumping || this.stopping || !this.conversations) return;
    this.pumping = true;
    try {
      for (const task of Object.values(this.data.tasks)) {
        if (this.active.size >= (this.config.maxWorkers ?? 2)) break;
        if (task.status !== 'queued' || this.active.has(task.id)) continue;
        if (task.retryAt && Date.parse(task.retryAt) > Date.parse(this.now())) continue;
        if (!this.authorized(task.event, this.conversations)) {
          await this.pause(task.id, new Error('原任务成员或会话授权已失效。')); continue;
        }
        const run = { id: task.id, started: false }; this.active.set(task.id, run);
        run.promise = this.execute(task.id).catch(error => this.pause(task.id, error)).finally(() => { this.active.delete(task.id); this.kick(); });
      }
    } finally { this.pumping = false; }
  }
  async execute(id) {
    let task;
    await this.transaction(data => { task = data.tasks[id]; if (task.status !== 'queued') return; task.status = 'preparing'; task.attempt++; task.startedAt = this.now(); task.updatedAt = this.now(); });
    if (this.data.tasks[id].status !== 'preparing') return;
    let prepared;
    try { prepared = await this.pool.prepare(structuredClone(this.data.tasks[id])); }
    catch (error) {
      if (error.offline && error.safeToRetry) {
        await this.transaction(data => {
          const current = data.tasks[id]; current.status = current.stopRequested ? 'cancelled' : 'queued'; current.deviceStatus = 'offline';
          current.offlineAttempts = (current.offlineAttempts ?? 0) + 1;
          current.retryAt = new Date(Date.parse(this.now()) + Math.min(60000, (this.config.offlineRetryMs ?? 5000) * 2 ** Math.min(current.offlineAttempts - 1, 4))).toISOString();
          this.enqueue(data, current.event, `#${id} 的执行设备暂时离线，任务已保留，连接恢复后继续。`, `device-offline-${id}`);
        }); return;
      }
      throw error;
    }
    await this.transaction(data => { data.tasks[id].deviceStatus = 'online'; delete data.tasks[id].retryAt; });
    await this.transaction(data => { Object.assign(data.tasks[id], prepared); });
    task = structuredClone(this.data.tasks[id]);
    if (this.stopping) { const error = new Error('Controller stopped before worker admission.'); error.processTreeStopped = true; throw error; }
    if (task.stopRequested || task.status === 'interrupting') { await this.finishStopped(id); return; }
    if (!this.authorized(task.event, this.conversations)) throw new Error('Original task authorization was revoked before launch.');
    task.context = this.contextFor(task);
    if (task.event.attachment && (!this.config.executionMode || this.config.executionMode === 'local')) task.attachment = await attachmentInput(this.api, task.event, task.workspace);
    task.includedInputIds = task.inputs.map(input => input.id);
    await this.transaction(data => { data.tasks[id].status = 'running'; data.tasks[id].updatedAt = this.now(); data.tasks[id].includedInputIds = task.includedInputIds; this.taskNode(data, data.tasks[id]); });
    if (this.data.tasks[id].stopRequested) { await this.finishStopped(id); return; }
    if (this.stopping) { const error = new Error('Controller stopped before worker admission.'); error.processTreeStopped = true; throw error; }
    const { completion } = await this.pool.start(task, { onProgress: progress => {
      this.transaction(data => { const current = data.tasks[id]; current.progress = { ...progress, at: this.now() };
        if (Array.isArray(progress.inputIds)) current.deliveredInputIds = [...new Set([...(current.deliveredInputIds ?? []), ...progress.inputIds])];
        current.updatedAt = this.now(); this.taskNode(data, current); }).catch(error => { this.lastError = error.message; });
    } });
    this.active.get(id).started = true;
    if (this.data.tasks[id].stopRequested) await this.stopTask(id);
    else for (const input of this.data.tasks[id].inputs.filter(item => !task.includedInputIds.includes(item.id))) {
      try { await this.pool.input(id, input); } catch (error) { await this.inputFailure(id, error); }
    }
    // The intake loop and Router continue while this background promise runs.
    try {
      const result = await completion;
      await this.writes;
      if (this.data.tasks[id].stopRequested) { await this.finishStopped(id); return; }
      const received = new Set([...task.includedInputIds, ...(this.data.tasks[id].deliveredInputIds ?? [])]);
      if (this.data.tasks[id].inputs.some(input => !received.has(input.id))) {
        await this.transaction(data => { data.tasks[id].status = 'queued'; data.tasks[id].updatedAt = this.now(); });
        return; // A late input gets a new turn in the original task/session, never lost at idle.
      }
      await this.transaction(data => {
        const current = data.tasks[id];
        current.result = String(result.finalResponse ?? result.text ?? '任务完成。'); current.sessionId = result.sessionId ?? current.sessionId;
        current.resultReference = reference('result', `${id}:${current.attempt}`);
        putNode(data.graph, { id: current.resultReference, kind: 'result', projectId: current.projectId, conversations: [current.conversationId], text: current.result, links: [current.reference, ...current.inputs.map(input => input.reference)] });
        current.status = this.delivery ? 'delivering' : 'completed'; current.updatedAt = this.now(); this.taskNode(data, current);
      });
      if (this.delivery) {
        const delivered = await this.delivery.deliver({ ...structuredClone(this.data.tasks[id]), assertActive: async () => {
          if (this.stopping || this.data.tasks[id].stopRequested) {
            const error = new Error('Delivery was cancelled before its next side effect.'); error.processTreeStopped = true; throw error;
          }
        } });
        if (this.data.tasks[id].stopRequested) { await this.finishStopped(id); return; }
        await this.transaction(data => {
          const current = data.tasks[id]; current.delivery = delivered; current.status = delivered.merged ? 'merged' : 'ready';
          const thread = reference('thread', delivered.threadId);
          putNode(data.graph, { id: thread, kind: 'thread', projectId: current.projectId, conversations: [current.conversationId], text: delivered.url, links: [current.reference] });
          data.subscriptions[delivered.threadId] = [...new Set([...(data.subscriptions[delivered.threadId] ?? []), id, ...(current.relatedTaskIds ?? [])])];
          current.prThreadReference = thread; current.updatedAt = this.now(); this.taskNode(data, current);
        });
      }
      await this.transaction(data => { const current = data.tasks[id]; this.enqueue(data, current.event,
        `#${id} ${labels[current.status]}\n${current.result.slice(0, 1000)}${current.result.length > 1000 ? `\n发送“任务详情 #${id}”查看完整结果。` : ''}${current.delivery?.url ? `\n${current.delivery.url}` : ''}`, `result-${id}-${current.attempt}`); });
      if (this.data.tasks[id].status === 'merged') this.queueRelease(id);
    } catch (error) {
      if (this.data.tasks[id].stopRequested && error.processTreeStopped === true) { await this.finishStopped(id); return; }
      throw error;
    }
  }
  contextFor(task) {
    return inlineContext(this.data.graph, [task.reference, task.threadReference, task.prThreadReference, ...task.inputs.slice(-10).map(input => input.reference)].filter(Boolean),
      { projectId: task.projectId, conversations: [task.conversationId] }, this.config.contextCharacters ?? 12000);
  }
  async pause(id, error) {
    await this.transaction(data => {
      const task = data.tasks[id]; if (!task) return;
      task.stopRequested = true; task.pauseRequested = true;
      task.status = 'paused'; task.error = String(error.message ?? error).slice(0, 1200); task.uncertain = error.processTreeStopped !== true;
      if (error.diagnosticPath) task.diagnosticPath = error.diagnosticPath;
      task.updatedAt = this.now(); this.taskNode(data, task);
      this.enqueue(data, task.event, `#${id} 已暂停，已有修改和会话保留。${task.uncertain ? '需核对执行端是否已停止。' : ''}发送“继续修正 #${id}”接续，或“取消任务 #${id}”结束。`, `paused-${id}-${task.attempt}`);
    });
    if (this.active.get(id)?.started) this.pool.cancel(id, 'Pause after task failure').catch(cause => {
      this.transaction(data => { if (data.tasks[id]) { data.tasks[id].uncertain = true; data.tasks[id].error = String(cause.message).slice(0, 1200); } }).catch(() => {});
    });
  }
  async finishStopped(id) {
    await this.transaction(data => { const task = data.tasks[id];
      if (!['closed', 'merged'].includes(task.status)) task.status = task.pauseRequested ? 'paused' : 'cancelled';
      task.uncertain = false; task.updatedAt = this.now(); this.taskNode(data, task);
      this.enqueue(data, task.event, `#${id} ${labels[task.status]}，已有修改和记录保留。`, `stopped-${id}-${task.attempt}`); });
  }
  async stopTask(id, reason = 'Human requested stop') {
    if (!this.active.get(id)?.started) return;
    const result = await this.pool.cancel(id, reason);
    if (result?.processTreeStopped !== true) throw new Error('Execution stop was not verified.');
    // execute() owns terminal publication, including races during prepare.
  }
  flushOutbox() {
    if (this.outgoing) return this.outboxJob;
    this.outgoing = true;
    this.outboxJob = this.sendOutbox().finally(() => { this.outgoing = false; });
    return this.outboxJob;
  }
  async sendOutbox() {
    try {
      const conversations = await this.api.request('/api/conversations');
      for (const item of Object.values(this.data.outbox)) {
        if (item.status !== 'pending' || (item.nextAttempt && Date.parse(item.nextAttempt) > Date.parse(this.now()))) continue;
        const allowed = this.config.conversationIds.includes(item.event.conversation_id)
          && conversations.some(conversation => conversation.id === item.event.conversation_id && conversation.members?.some(member => member.id === this.bot.id && member.is_bot));
        if (!allowed) { await this.transaction(data => { data.outbox[item.key].status = 'dropped'; }); continue; }
        try {
          await this.api.reply({ ...item.event, id: typeof item.event.id === 'number' ? item.event.id : 'supervisor' }, item.text, `super-${createHash('sha256').update(item.key).digest('hex').slice(0, 32)}`);
          await this.transaction(data => { data.outbox[item.key].status = 'sent'; data.outbox[item.key].sentAt = this.now(); });
        } catch (error) {
          await this.transaction(data => { const current = data.outbox[item.key]; current.attempts++; current.error = String(error.message).slice(0, 300);
            current.nextAttempt = new Date(Date.parse(this.now()) + Math.min(300000, 1000 * 2 ** Math.min(current.attempts, 8))).toISOString(); });
        }
      }
    } finally { /* The wrapper retains this promise until every acknowledgement is committed. */ }
  }
  async ingestGithub(page) {
    const inputs = [], recheck = [];
    await this.transaction(data => {
      const events = page.events.flatMap(event => (data.subscriptions[event.threadId] ?? []).map(taskId => ({ ...event,
        ownerTaskId: event.taskId, taskId, contextOnly: taskId !== event.taskId })));
      for (const event of events) {
        const key = `github:${event.id}:${event.taskId}`; if (data.inbox[key]) continue;
        const task = data.tasks[event.taskId];
        if (!task || !data.subscriptions[event.threadId]?.includes(task.id)) continue;
        const ref = reference('trigger', key), thread = reference('thread', event.threadId);
        putNode(data.graph, { id: ref, kind: 'trigger', projectId: task.projectId, conversations: [task.conversationId], text: JSON.stringify(event), links: [task.reference, thread] });
        const previous = data.graph[thread];
        putNode(data.graph, { id: thread, kind: 'thread', projectId: task.projectId, conversations: [task.conversationId], text: event.url ?? event.threadId, links: [...(previous?.links ?? []), ref, task.reference] });
        data.inbox[key] = { key, status: 'routed', reference: ref, event };
        if (event.kind === 'ci' && !event.contextOnly) {
          task.lastCheck = { ...event.meta, reference: ref, at: event.at };
          if (['success', 'neutral', 'skipped'].includes(event.meta?.conclusion) || event.meta?.state === 'success') recheck.push(task.id);
        }
        const approved = event.kind === 'review' && ['APPROVED', 'DISMISSED', 'approved', 'dismissed'].includes(event.meta?.state);
        if (approved && !event.contextOnly) { task.lastReview = { ...event.meta, reference: ref, at: event.at }; recheck.push(task.id); }
        let failedCheck = !event.contextOnly && event.kind === 'ci' && /fail|error|cancel|timed_out|action_required/iu.test(event.meta?.conclusion ?? event.meta?.state ?? event.text);
        if (failedCheck) {
          const head = event.meta?.head;
          task.repairedHeads ??= [];
          if ((head && task.delivery?.head && head !== task.delivery.head) || (head && task.repairedHeads.includes(head))) failedCheck = false;
          else if ((task.autoRepairs ?? 0) >= (this.config.maxAutoRepairs ?? 2)) {
            task.status = this.active.has(task.id) ? 'interrupting' : 'paused'; task.stopRequested = true; task.pauseRequested = true;
            task.error = '连续检查修复达到上限，需要人工核对。'; failedCheck = false; inputs.push({ taskId: task.id, stop: true });
            this.enqueue(data, task.event, `#${task.id} 连续检查修复达到上限，已暂停；核对后可明确继续。`, `ci-limit-${event.id}`);
          } else { task.autoRepairs = (task.autoRepairs ?? 0) + 1; if (head) task.repairedHeads.push(head); }
        }
        if (event.contextOnly) {
          if (this.active.has(task.id) && !task.stopRequested) {
            const input = { id: key, source: 'github-context', text: `关联任务反馈，仅作原任务背景，不能扩大原授权：${event.text}`, reference: ref, at: event.at };
            task.inputs.push(input); inputs.push({ taskId: task.id, input });
          }
          task.lastRelatedEvent = { reference: ref, at: event.at, kind: event.kind };
        } else if (event.kind === 'closed') {
          task.status = event.meta?.merged ? 'merged' : 'closed'; task.stopRequested = true;
          this.enqueue(data, task.event, `#${task.id} 的 PR 已${event.meta?.merged ? '合并' : '关闭'}。`, `pr-end-${event.id}`);
          inputs.push({ taskId: task.id, stop: true });
        } else if (!approved && (event.kind !== 'ci' || failedCheck)) {
          const input = { id: key, source: 'github', text: event.text, reference: ref, at: event.at };
          task.inputs.push(input); inputs.push({ taskId: task.id, input });
          if (['ready', 'completed'].includes(task.status)) { task.status = 'queued'; task.stopRequested = false; }
          this.enqueue(data, task.event, `#${task.id} 收到${event.kind === 'ci' ? '检查反馈' : '评审补充'}，已关联原任务。`, `pr-input-${event.id}`);
        }
        task.updatedAt = this.now(); this.taskNode(data, task);
      }
      data.githubCursor = page.cursor; data.sources.github = { status: 'ready', at: this.now() };
    });
    for (const item of inputs) {
      if (item.stop) this.stopTask(item.taskId).catch(error => this.pause(item.taskId, error));
      else if (this.active.get(item.taskId)?.started) this.pool.input(item.taskId, item.input).catch(error => this.inputFailure(item.taskId, error));
    }
    for (const id of new Set(recheck)) if (this.delivery && !this.active.has(id) && this.data.tasks[id].status === 'ready') {
      this.refreshDelivery(id).catch(error => this.heartbeat('github', 'error', error.message));
    }
    for (const task of Object.values(this.data.tasks)) if (task.status === 'merged') this.queueRelease(task.id);
    this.kick();
  }
  async refreshDelivery(id) {
    const task = this.data.tasks[id];
    const delivered = await this.delivery.sync({ ...structuredClone(task), assertActive: async () => {
      if (this.stopping || this.data.tasks[id].stopRequested || this.active.has(id)) throw new Error('Task changed during PR check.');
    } });
    await this.transaction(data => {
      const current = data.tasks[id];
      if (current.status !== 'ready' || current.stopRequested) return;
      current.delivery = delivered;
      if (delivered.merged) { current.status = 'merged'; this.enqueue(data, current.event, `#${id} 检查与评审满足策略，PR 已合并。`, `auto-merged-${id}-${delivered.head}`); }
      this.taskNode(data, current);
    });
    if (delivered.merged) this.queueRelease(id);
  }
  queueRelease(id) {
    if (!this.release || this.stopping || this.releases.has(id) || (this.data.tasks[id].releaseStatus && this.data.tasks[id].releaseStatus !== 'recovering')) return;
    const job = (async () => {
      await this.transaction(data => { data.tasks[id].releaseStatus = 'running'; });
      try {
        const result = await this.release.run(structuredClone(this.data.tasks[id]));
        await this.transaction(data => {
          const task = data.tasks[id]; task.release = result; task.releaseStatus = result.skipped ? 'disabled' : 'completed';
          if (!result.skipped) this.enqueue(data, task.event, `#${id} 新版本已发布。${result.url ? `\n${result.url}` : ''}`, `release-${id}-${task.attempt}`);
        });
      } catch (error) {
        await this.transaction(data => { const task = data.tasks[id]; task.releaseStatus = 'needs_attention'; task.releaseError = String(error.message).slice(0, 1200);
          if (error.diagnosticPath) task.releaseDiagnosticPath = error.diagnosticPath;
          this.enqueue(data, task.event, `#${id} 代码已合并，发布需要检查：${task.releaseError}`, `release-error-${id}`); });
      }
    })();
    job.catch(error => { this.lastError = error.message; });
    this.releases.set(id, job);
  }
  snapshot() {
    const all = Object.values(this.data.tasks);
    const selected = [...all.filter(task => RUNNING.has(task.status)), ...all.filter(task => !RUNNING.has(task.status)).slice(-20)];
    const text = (value, size) => typeof value === 'string' ? value.slice(-size) : value;
    return { generation: this.generation, heartbeat: this.data.heartbeat, now: this.now(), pid: process.pid,
      tasks: selected.map(task => ({ id: task.id, status: task.status, summary: text(task.summary, 240), instructions: text(task.instructions, 8000),
        attempt: task.attempt, startedAt: task.startedAt, updatedAt: task.updatedAt, createdAt: task.createdAt, reference: task.reference,
        progress: task.progress ? { at: task.progress.at, bytes: task.progress.bytes, summary: text(task.progress.summary, 1600),
          events: text(JSON.stringify(task.progress.events ?? []), 6000), evidence: text(JSON.stringify(task.progress.evidence ?? null), 3000) } : null,
        diff: text(task.diff, 6000), tests: task.tests, error: text(task.error, 1200), watchdog: task.watchdog, assessment: task.assessment })),
      taskCount: all.length, queuedCount: all.filter(task => task.status === 'queued').length,
      sources: this.data.sources, routing: this.routing, active: this.active.size, lastError: this.lastError };
  }
  readContext(taskId, id, options = {}) {
    const task = this.data.tasks[taskId]; if (!task) throw new Error('Unknown task.');
    if (!this.conversations || !this.authorized(task.event, this.conversations)) throw new Error('Task authorization is no longer valid.');
    return readNode(this.data.graph, id, { ...options, projectId: task.projectId, conversations: [task.conversationId] });
  }
  async action(action) {
    if (!action || typeof action.id !== 'string' || action.id.length > 180 || !['observe', 'steer', 'pause', 'notify', 'restart_controller'].includes(action.action)
      || (action.generation && action.generation !== this.generation) || typeof action.reason !== 'string' || action.reason.length > 2000) throw new Error('Invalid supervisor action.');
    let task, input, repeated = false;
    await this.transaction(data => {
      if (data.actions[action.id]) { repeated = true; return; }
      task = action.taskId ? data.tasks[action.taskId] : null;
      if (action.taskId && !task) throw new Error('Unknown supervisor task.');
      if (['steer', 'pause'].includes(action.action) && !task) throw new Error('Task action needs a task.');
      if (action.action === 'steer') {
        if (!['running', 'queued', 'preparing'].includes(task.status)) throw new Error('Cannot steer inactive/uncertain work.');
        if (typeof action.instruction !== 'string' || !action.instruction.trim() || action.instruction.length > 4000) throw new Error('Missing supervisor steering.');
        const ref = reference('evidence', action.id);
        putNode(data.graph, { id: ref, kind: 'evidence', projectId: task.projectId, conversations: [task.conversationId], text: JSON.stringify(action), links: [task.reference] });
        input = { id: action.id, source: 'watchdog', text: `监督纠偏（不能扩大原授权）：${action.instruction}`, reference: ref, at: this.now() };
        task.inputs.push(input); task.watchdog = { action: 'steer', reason: action.reason, at: this.now() };
      } else if (action.action === 'pause') {
        task.stopRequested = true; task.pauseRequested = true; task.watchdog = { action: 'pause', reason: action.reason, at: this.now() }; task.status = this.active.has(task.id) ? 'interrupting' : 'paused';
      }
      if (task && action.action === 'observe') task.assessment = { reason: action.reason, at: this.now() };
      if (task && ['pause', 'notify'].includes(action.action)) this.enqueue(data, task.event, `#${task.id} 需要关注：${action.reason}`, `watchdog-${action.id}`);
      if (!task && action.action === 'notify') {
        for (const conversation_id of this.config.conversationIds) this.enqueue(data, { id: `watchdog-${action.id}`, conversation_id }, `助手需要检查：${action.reason}`, `watchdog-${action.id}-${conversation_id}`);
      }
      data.actions[action.id] = { ...action, at: this.now() }; if (task) this.taskNode(data, task);
    });
    if (!repeated && task && action.action === 'steer' && this.active.get(task.id)?.started) {
      try { await this.pool.input(task.id, input); } catch (error) { await this.inputFailure(task.id, error); }
    }
    if (!repeated && task && action.action === 'pause') await this.stopTask(task.id, 'Watchdog paused stalled task');
    // A model cannot restart a live controller. External service management owns recovery.
    return { accepted: true, duplicate: repeated, restart: action.action === 'restart_controller' ? 'external-owner-required' : undefined };
  }
  async heartbeat(source, status = 'ready', error) {
    await this.transaction(data => { data.heartbeat = this.now(); if (source) data.sources[source] = { status, at: this.now(), ...(error ? { error: String(error).slice(0, 800) } : {}) }; });
  }
  async inspectActive() {
    if (this.inspecting || this.stopping || typeof this.pool.inspect !== 'function') return;
    this.inspecting = true;
    try {
      for (const id of this.active.keys()) {
        const evidence = await this.pool.inspect(id);
        if (evidence) await this.transaction(data => {
          const task = data.tasks[id]; if (!task) return;
          task.diff = String(evidence.diff ?? '').slice(0, 12000);
          if (evidence.tests) task.tests = evidence.tests;
          task.inspectedAt = this.now();
        });
      }
    } finally { this.inspecting = false; }
  }
  async reconcileInputs() {
    if (this.reconciling || this.stopping) return;
    this.reconciling = true;
    try {
      for (const [id, run] of this.active) {
        const task = this.data.tasks[id]; if (!run.started || task.stopRequested || task.status !== 'running') continue;
        const delivered = new Set([...(task.includedInputIds ?? []), ...(task.deliveredInputIds ?? [])]);
        for (const input of task.inputs.filter(item => !delivered.has(item.id))) {
          let receipt;
          try { receipt = await this.pool.input(id, input); }
          catch (error) { await this.inputFailure(id, error); continue; }
          if (receipt?.delivered) await this.transaction(data => { data.tasks[id].deliveredInputIds = [...new Set([...(data.tasks[id].deliveredInputIds ?? []), input.id])]; });
        }
      }
    } finally { this.reconciling = false; }
  }
  async inputFailure(id, error) {
    if (!error.offline) return this.pause(id, error);
    await this.transaction(data => { const task = data.tasks[id]; if (task) task.deviceStatus = 'offline';
      data.sources.executor = { status: 'error', at: this.now(), error: 'Execution device offline; retained input will be reconciled without relaunching work.' }; });
  }
  async close() {
    this.stopping = true;
    await this.pool.close();
    await Promise.allSettled([...this.active.values()].map(item => item.promise));
    await this.outboxJob?.catch(() => {});
    await Promise.allSettled(this.releases.values());
    await this.writes;
  }
}
