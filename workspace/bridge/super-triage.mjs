import { createHash } from 'node:crypto';
import { reference, putNode } from './super-context.mjs';
import { QaSource } from './qa-source.mjs';
import { routeTriageTriggers } from './triage-route.mjs';
import { validateExecutionProof } from './skill-execution.mjs';

const kind = task => task?.kind === 'log-triage';
const same = (a, b) => String(a) === String(b);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const bindingKey = b => hash([String(b.sourceId), String(b.projectId), String(b.conversationId)]);
const issueKey = t => hash([String(t.sourceId), String(t.projectId), String(t.externalIssueId), String(t.conversationId)]);
const fail = code => Object.assign(new Error(code), { code });
const busy = new Set(['preparing', 'running', 'analysing', 'validating', 'interrupting']);
const safeError = cause => /^[A-Z][A-Z0-9_]{2,100}$/u.test(cause?.code ?? '') ? cause.code : 'TRIAGE_FAILED';
const textParts = text => String(text).match(/[\s\S]{1,3000}/gu) ?? [''];
const normalizeZone = text => /^(?:UTC\+08:00|UTC\+8|GMT\+08:00)$/iu.test(text) ? 'Asia/Shanghai'
  : /^(?:UTC\+00:00|UTC|GMT)$/iu.test(text) ? 'UTC' : text;
const CLOCK_TYPES = new Set(['ota', 'slave', 'qnx-uds', 'de', 'other']);
const validZone = value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } };
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function validRecovered(result) {
  try { validateExecutionProof(result?.execution, result?.execution?.backend); } catch { return false; }
  return ['completed', 'partial'].includes(result?.status) && result.modelCalls === 1 && typeof result.text === 'string' && result.text.length > 0
    && record(result.report) && record(result.manifest) && Array.isArray(result.files) && result.files.length === 2
    && new Set(result.files.map(file => file?.name)).size === 2
    && result.files.every(file => record(file) && ['report.json', '报告.txt'].includes(file.name)
      && file.mime === (file.name === 'report.json' ? 'application/json' : 'text/plain')
      && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 200000
      && /^[a-f0-9]{64}$/u.test(file.sha256 ?? '') && typeof file.pathPrivate === 'string' && file.pathPrivate.length > 0);
}

export function triageClockDomains(text = '') {
  if (!text.includes('日志时区')) return {};
  const section = text.slice(text.indexOf('日志时区') + 4).trim();
  const result = {};
  for (const match of section.matchAll(/([a-z-]+)=([^\s，,。]+)/gu)) {
    const zone = normalizeZone(match[2]);
    if (!CLOCK_TYPES.has(match[1]) || !validZone(zone)) throw fail('TRIAGE_CLOCK_DOMAIN_INVALID');
    result[match[1]] = zone;
  }
  if (!Object.keys(result).length) throw fail('TRIAGE_CLOCK_DOMAIN_INVALID');
  return result;
}

export function triageWindow(text = '') {
  const result = {};
  const date = /(?:故障)?日期\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/u.exec(text);
  const time = /时间\s*[:：]?\s*(\d{2}:\d{2})\s*[-–~～至]\s*(\d{2}:\d{2})/u.exec(text);
  const zone = /时区\s*[:：]?\s*([A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+|(?:UTC|GMT)(?:[+-]\d{1,2}(?::\d{2})?)?)(?=\s|[，,。]|$)/u.exec(text);
  if (date) result.date = date[1];
  if (time) Object.assign(result, { from: time[1], to: time[2] });
  if (zone) result.timeZone = normalizeZone(zone[1]);
  return result;
}

/** Coordination only: no Git operations, shell, model calls or Desktop private HTTP routes. */
export class SuperTriage {
  constructor({ coordinator, adapter, sourceFactory, worker, options = {} }) {
    this.c = coordinator; this.adapter = adapter; this.worker = worker;
    this.options = { enabled: true, sourceId: 'qa', bindings: [], adminSenderIds: [], maxWorkers: 1,
      pollMilliseconds: 60000, totalModelCalls: 1, dailyModelCalls: 1, ...options };
    this.options.maxWorkers = options.maxConcurrent ?? options.maxWorkers ?? 1;
    this.sourceFactory = sourceFactory ?? (settings => new QaSource(settings));
    this.runs = new Map(); this.polling = false; this.routing = false; this.stopping = false;
    for (const name of ['totalModelCalls', 'dailyModelCalls', 'maxWorkers', 'pollMilliseconds'])
      if (!Number.isSafeInteger(this.options[name]) || this.options[name] < (name.endsWith('ModelCalls') ? 0 : 1)) throw fail('TRIAGE_INVALID_BUDGET');
    for (const [type, zone] of Object.entries(this.options.clockDomains ?? {}))
      if (!CLOCK_TYPES.has(type) || !validZone(zone)) throw fail('TRIAGE_CLOCK_DOMAIN_INVALID');
  }
  get data() { return this.c.data; }
  now() { return this.c.now(); }
  initialize(data) {
    data.triage ??= { version: 1, bindings: [], qa: {}, issueTasks: {}, budget: { total: 0, days: {}, reservations: {} } };
    const state = data.triage;
    if (state.version !== 1 || !Array.isArray(state.bindings) || !state.qa || !state.issueTasks || !state.budget) throw fail('TRIAGE_INVALID_STATE');
    state.budget.days ??= {}; state.budget.reservations ??= {}; state.budget.total ??= 0;
    if (!Number.isSafeInteger(state.budget.total) || state.budget.total < 0 || Array.isArray(state.budget.days)
      || Array.isArray(state.budget.reservations) || Object.values(state.budget.days).some(value => !Number.isSafeInteger(value) || value < 0)) throw fail('TRIAGE_INVALID_STATE');
    const configured = new Map(this.options.bindings.map(value => [bindingKey(value), value]));
    for (const binding of state.bindings) {
      const current = configured.get(bindingKey(binding));
      if (binding.origin === 'chat') {
        if (!this.options.allowChatProjectBinding || !this.options.adminSenderIds.some(id => same(id, binding.createdBy))) binding.enabled = false;
      } else if (!current) binding.enabled = false;
      else { Object.assign(binding, current, { origin: 'config', enabled: !binding.manuallyDisabled }); configured.delete(bindingKey(binding)); }
    }
    for (const binding of configured.values()) state.bindings.push({ ...binding, origin: 'config', enabled: true });
    for (const task of Object.values(data.tasks)) if (kind(task)) {
      task.inputs ??= []; task.reports ??= {}; task.inputRevision ??= 1;
      if (busy.has(task.status)) {
        task.status = 'paused'; task.uncertain = true; task.lastRunStopped = false;
        task.error = 'TRIAGE_INTERRUPTED'; task.updatedAt = this.now();
      }
    }
  }
  #bindings(data = this.data) { return data.triage.bindings.filter(binding => binding.enabled && this.options.enabled); }
  #binding(task, data = this.data) { return this.#bindings(data).find(binding => same(binding.sourceId, task.sourceId) && same(binding.projectId, task.projectId) && same(binding.conversationId, task.conversationId)); }
  #chatAllowed(conversationId, conversations) {
    return this.options.enabled && this.c.config.conversationIds.some(id => same(id, conversationId))
      && conversations?.some(chat => same(chat.id, conversationId) && chat.members?.some(member => same(member.id, this.c.bot.id) && member.is_bot));
  }
  #humanAllowed(senderId, conversationId, conversations) {
    return this.#chatAllowed(conversationId, conversations) && this.c.config.senderIds.some(id => same(id, senderId))
      && conversations.some(chat => same(chat.id, conversationId) && chat.members?.some(member => same(member.id, senderId) && !member.is_bot));
  }
  authorized(task, conversations = this.c.conversations) {
    return kind(task) && Boolean(this.#binding(task)) && this.#chatAllowed(task.conversationId, conversations)
      && (!task.requesterId || this.#humanAllowed(task.requesterId, task.conversationId, conversations));
  }
  eligible(task) {
    return !this.stopping && !this.c.stopping && kind(task) && task.status === 'queued' && !task.stopRequested && !task.uncertain
      && [...this.c.active.values()].filter(run => kind(this.data.tasks[run.id])).length < this.options.maxWorkers;
  }
  captureIm(data, event, originalReference, originalThread) {
    if (!this.options.enabled || !this.#humanAllowed(event.sender?.id, event.conversation_id, this.c.conversations)) return false;
    const value = String(event.text ?? '').trim().replace(/^@[A-Za-z0-9_.-]+\s+/u, '').replace(/[。！!]+$/u, '');
    const bind = /^(跟踪项目|停止跟踪项目)\s+([A-Za-z0-9][A-Za-z0-9_-]{0,79})$/u.exec(value);
    const pasted = /^([A-Za-z][A-Za-z0-9_-]{0,79}-\d+)$/u.exec(value);
    const request = /^(分析|重新分析|重分析)\s+([A-Za-z][A-Za-z0-9_-]{0,79}-\d+)(?=\s|$)([\s\S]*)$/u.exec(value)
      ?? (pasted ? [value, '分析', pasted[1], ''] : null);
    const control = /^(分析详情|任务状态|状态|取消任务|停止任务|暂停任务|继续分析|继续修正|继续任务|继续)\s+#?(T\d{6,})$/iu.exec(value);
    const follow = /^#(T\d{6,})(?=\s|$)([\s\S]*)$/iu.exec(value);
    const selected = (control?.[2] ?? follow?.[1])?.toUpperCase();
    const own = selected && data.tasks[selected];
    if (!bind && !request && (!kind(own) || !same(own.conversationId, event.conversation_id))) return false;
    const entry = data.inbox[`im:${event.id}`];
    if (!entry) throw fail('TRIAGE_MISSING_INTAKE');
    const action = bind ? (bind[1] === '跟踪项目' ? 'bind' : 'unbind') : control
      ? /详情/u.test(control[1]) ? 'details' : /状态/u.test(control[1]) ? 'status' : /取消|停止|暂停/u.test(control[1]) ? 'stop' : 'resume'
      : request ? /重新|重分析/u.test(request[1]) ? 'reanalyse' : 'request' : 'followup';
    entry.trigger = { triggerId: `im:${event.id}`, sourceKind: 'im', eventKind: 'analysis.requested', request: action,
      conversationId: event.conversation_id, requesterId: event.sender.id, observedAt: event.created_at ?? this.now(),
      text: value.slice(0, 8000), window: triageWindow(value), originalReference, originalThread,
      ...(selected ? { taskId: selected } : {}), ...(bind ? { projectCode: bind[2] } : {}),
      ...(request ? { issueNo: request[2] } : {}) };
    const description = /问题说明\s*[:：]?\s*([\s\S]*?)(?=\s+(?:日期|时间|时区|日志时区)\s|$)/u.exec(value)?.[1]?.trim();
    if (description) entry.trigger.description = description;
    try { entry.trigger.clockDomains = triageClockDomains(value); }
    catch { entry.trigger.inputError = 'clock_domains'; }
    return true;
  }
  #recordTrigger(data, trigger) {
    const ref = reference('trigger', 'triage:' + trigger.triggerId);
    const qaThread = reference('thread', `qa:${trigger.sourceId}:${trigger.projectId}:${trigger.externalIssueId}:${trigger.conversationId}`);
    const imThread = trigger.sourceKind === 'im' ? reference('thread', `triage-im:${trigger.sourceId}:${trigger.projectId}:${trigger.conversationId}:${trigger.triggerId}`) : null;
    const scope = { projectId: String(trigger.projectId), conversations: [trigger.conversationId] };
    putNode(data.graph, { id: ref, kind: 'trigger', ...scope, text: JSON.stringify(trigger), links: [qaThread, ...(imThread ? [imThread] : [])] });
    for (const id of [qaThread, imThread].filter(Boolean)) putNode(data.graph, { id, kind: 'thread', ...scope,
      text: id === qaThread ? `QA ${trigger.externalIssueNo || trigger.externalIssueId}` : '日志分析请求', links: [...(data.graph[id]?.links ?? []), ref] });
    return { reference: ref, threadReference: qaThread, imThreadReference: imThread };
  }
  async pollSources() {
    if (this.polling || this.stopping || !this.options.enabled) return;
    this.polling = true;
    try {
      const conversations = await this.c.api.request('/api/conversations'); this.c.conversations = structuredClone(conversations);
      for (const binding of this.#bindings()) {
        if (!this.#chatAllowed(binding.conversationId, conversations)) continue;
        const key = bindingKey(binding), record = this.data.triage.qa[key];
        if (record?.nextPollAt && Date.parse(record.nextPollAt) > Date.parse(this.now())) continue;
        try {
          const source = this.sourceFactory({ binding: structuredClone(binding), adapter: this.adapter, limits: this.options.sourceLimits, now: () => new Date(this.now()) });
          const page = await source.poll(record?.checkpoint ?? null);
          if (!page || !Array.isArray(page.triggers) || !page.checkpoint) throw fail('TRIAGE_INVALID_SOURCE_PAGE');
          for (const trigger of page.triggers) if (trigger.sourceKind !== 'qa' || !same(trigger.sourceId, binding.sourceId)
            || !same(trigger.projectId, binding.projectId) || !same(trigger.conversationId, binding.conversationId)
            || typeof trigger.triggerId !== 'string' || trigger.triggerId.length > 1600 || !trigger.issue || !same(trigger.issue.projectId, binding.projectId)
            || !same(trigger.issue.id, trigger.externalIssueId)) throw fail('TRIAGE_SOURCE_SCOPE');
          await this.c.transaction(data => {
            if (!this.#binding({ ...binding, kind: 'log-triage' }, data)) return;
            for (const trigger of page.triggers) if (!data.inbox[trigger.triggerId]) data.inbox[trigger.triggerId] = {
              key: trigger.triggerId, trigger: structuredClone(trigger), ...this.#recordTrigger(data, trigger), status: 'pending', attempts: 0 };
            data.triage.qa[key] = { checkpoint: page.checkpoint, status: 'ready', failures: 0,
              nextPollAt: new Date(Date.parse(this.now()) + this.options.pollMilliseconds).toISOString() };
          });
        } catch (cause) {
          await this.c.transaction(data => {
            const previous = data.triage.qa[key] ?? {};
            data.triage.qa[key] = { ...previous, status: 'error', error: safeError(cause), failures: (previous.failures ?? 0) + 1,
              nextPollAt: new Date(Date.parse(this.now()) + Math.min(300000, this.options.pollMilliseconds * 2 ** Math.min(previous.failures ?? 0, 4))).toISOString() };
          });
        }
      }
    } finally { this.polling = false; }
  }
  async #resolve(trigger) {
    const result = structuredClone(trigger);
    if (trigger.sourceKind !== 'im') return result;
    if (['bind', 'unbind'].includes(trigger.request)) return result;
    const task = trigger.taskId ? this.data.tasks[trigger.taskId] : null;
    let binding;
    if (task && kind(task) && same(task.conversationId, trigger.conversationId)) {
      binding = this.#binding(task);
      if (binding) Object.assign(result, { sourceId: task.sourceId, projectId: task.projectId, externalIssueId: task.externalIssueId,
        externalIssueNo: task.externalIssueNo, issue: structuredClone(task.issue) });
    } else if (trigger.issueNo) {
      const matches = this.#bindings().filter(item => same(item.conversationId, trigger.conversationId)
        && trigger.issueNo.toUpperCase().startsWith(String(item.projectCode).toUpperCase() + '-'));
      if (matches.length !== 1) return result;
      binding = matches[0];
      const issue = await this.adapter.getIssue({ projectId: binding.projectId, no: trigger.issueNo });
      if (!issue || !same(issue.projectId, binding.projectId) || issue.no !== trigger.issueNo) return result;
      issue.attachments = await this.adapter.listFiles(issue);
      Object.assign(result, { sourceId: binding.sourceId, projectId: String(binding.projectId), externalIssueId: String(issue.id), externalIssueNo: issue.no, issue });
    }
    return result;
  }
  async routePending() {
    if (this.routing || this.stopping || !this.options.enabled) return;
    this.routing = true;
    try {
      const batch = Object.values(this.data.inbox).filter(item => item.trigger && item.status === 'pending').slice(0, 8);
      for (const original of batch) {
        await this.c.transaction(data => { if (data.inbox[original.key]?.status === 'pending') data.inbox[original.key].status = 'routing'; });
        try {
          const trigger = await this.#resolve(original.trigger);
          if (['bind', 'unbind'].includes(trigger.request)) { await this.#changeBinding(original.key, trigger); continue; }
          const decisions = await (this.c.router.routeTriggers?.([trigger], { tasks: Object.values(this.data.tasks), context: [] })
            ?? routeTriageTriggers([trigger], { tasks: Object.values(this.data.tasks) }));
          if (!Array.isArray(decisions) || decisions.length !== 1) throw fail('TRIAGE_INVALID_ROUTE');
          await this.#apply(original.key, trigger, decisions[0]);
        } catch (cause) {
          await this.c.transaction(data => {
            const item = data.inbox[original.key]; if (!item || item.status === 'routed') return;
            item.status = 'failed'; item.error = safeError(cause); item.attempts++;
            if (item.trigger.sourceKind === 'im') this.#notice(data, item.trigger, '暂时无法读取该问题，记录已保留，请稍后重新请求。', `triage-route-failed:${item.key}`);
          });
        }
      }
      this.c.kick();
    } finally { this.routing = false; }
  }
  #notice(data, trigger, text, key) {
    this.#outbox(data, { key, text, conversationId: trigger.conversationId, requesterId: trigger.requesterId, controlAck: true });
  }
  #outbox(data, { key, text, conversationId, taskId, revision, category = 'result', requesterId, controlAck = false }) {
    for (const [part, body] of textParts(text).entries()) {
      const itemKey = `${key}:${part}`;
      if (data.outbox[itemKey]) continue;
      data.outbox[itemKey] = { key: itemKey, kind: 'log-triage', taskId, reportRevision: revision, category, controlAck,
        requesterId, event: { id: 'triage', conversation_id: conversationId }, text: body, bodyHash: hash(body),
        clientId: `dsh-supervisor-super-${hash(itemKey).slice(0, 32)}`, status: 'pending', attempts: 0, at: this.now() };
    }
  }
  #taskNode(data, task) {
    putNode(data.graph, { id: task.reference, kind: 'task', projectId: String(task.projectId), conversations: [task.conversationId],
      text: JSON.stringify({ id: task.id, kind: task.kind, issueNo: task.externalIssueNo, status: task.status, inputRevision: task.inputRevision, reportRevision: task.reportRevision }),
      links: [...new Set([task.threadReference, ...(task.imThreadReferences ?? []), ...task.sourceReferences, ...(task.resultReference ? [task.resultReference] : [])])], at: this.now() });
    for (const thread of [task.threadReference, ...(task.imThreadReferences ?? [])]) {
      const old = data.graph[thread]; if (old) old.links = [...new Set([...old.links, task.reference])];
      data.subscriptions[thread] = [...new Set([...(data.subscriptions[thread] ?? []), task.id])];
    }
  }
  #supersede(data, task) {
    for (const item of Object.values(data.outbox)) if (item.kind === 'log-triage' && item.taskId === task.id && ['result', 'artifact'].includes(item.category)
      && ['pending', 'paused'].includes(item.status) && item.reportRevision < task.inputRevision) item.status = 'superseded';
  }
  async #apply(key, trigger, decision) {
    let cancel, stoppedTask;
    await this.c.transaction(data => {
      const entry = data.inbox[key]; if (!entry || entry.status === 'routed') return;
      if (decision.triggerId !== trigger.triggerId || decision.taskKind !== 'log-triage'
        || Object.keys(decision).some(field => !['triggerId', 'taskKind', 'action', 'taskId', 'summary', 'reason'].includes(field))
        || !['new', 'followup', 'ignore', 'need_info', 'status', 'details', 'stop', 'resume'].includes(decision.action)) throw fail('TRIAGE_INVALID_ROUTE');
      const task = decision.taskId ? data.tasks[decision.taskId] : null;
      if (task && (!kind(task) || !same(task.conversationId, trigger.conversationId))) throw fail('TRIAGE_ROUTE_SCOPE');
      if (task && trigger.issue && (!same(task.sourceId, trigger.sourceId) || !same(task.projectId, trigger.projectId)
        || !same(task.externalIssueId, trigger.externalIssueId))) throw fail('TRIAGE_ROUTE_SCOPE');
      if (trigger.sourceKind === 'im' && !this.#humanAllowed(trigger.requesterId, trigger.conversationId, this.c.conversations)) throw fail('TRIAGE_AUTH_REVOKED');
      if (trigger.issue && !this.#binding({ ...trigger, kind: 'log-triage' }, data)) throw fail('TRIAGE_BINDING_REVOKED');
      entry.status = 'routed'; entry.decision = structuredClone(decision);
      if (decision.action === 'ignore') return;
      if (trigger.inputError) { this.#notice(data, trigger, '日志时区格式不正确，请按日志类型填写有效时区。', `triage-input:${key}`); return; }
      if (decision.action === 'need_info') { this.#notice(data, trigger, '请指定当前聊天已跟踪的准确问题编号。', `triage-info:${key}`); return; }
      if (['status', 'details'].includes(decision.action)) {
        if (!task || !this.authorized(task)) throw fail('TRIAGE_AUTH_REVOKED');
        const body = decision.action === 'details' ? task.reportText || '尚无完整分析，等待补充资料或完成分析。'
          : `${task.externalIssueNo}：${({ queued: '排队中', preparing: '正在检查日志', running: '正在分析', waiting_input: '需要补充', waiting_log: '等待日志', paused: '已暂停', completed: '分析完成', partial: '已有初排线索', cancelled: '已停止' })[task.status] || '处理中'}。`;
        this.#outbox(data, { key: `triage-details:${key}`, text: `#${task.id} · 分析版本 ${task.reportRevision || '尚未生成'}\n${body}`, conversationId: task.conversationId,
          taskId: task.id, revision: task.reportRevision, category: 'details', requesterId: trigger.requesterId }); return;
      }
      if (decision.action === 'stop') {
        if (!task) return;
        stoppedTask = task.id;
        task.stopRequested = true; task.updatedAt = this.now();
        if (this.runs.has(task.id)) { task.status = 'interrupting'; cancel = task.id; }
        else if (task.uncertain && task.lastRunStopped !== true) task.status = 'paused';
        else { task.status = 'cancelled'; task.uncertain = false; task.lastRunStopped = true; }
        for (const item of Object.values(data.outbox)) if (item.taskId === task.id && item.category === 'result' && item.status === 'pending') item.status = 'superseded';
        this.#taskNode(data, task); return;
      }
      if (decision.action === 'resume') {
        if (!task) return;
        if (['completed', 'partial'].includes(task.status)) {
          this.#notice(data, trigger, `#${task.id} ${task.status === 'partial' ? '本轮已有初排线索，尚未形成完整判断' : '已分析完成'}。如需再次检查，请发送“重新分析 ${task.externalIssueNo}”。`, `triage-resume-completed:${key}`); return;
        }
        if (this.runs.has(task.id) || !['paused', 'waiting_input', 'waiting_log', 'cancelled'].includes(task.status)) {
          this.#notice(data, trigger, `#${task.id} 正在处理中，无需重复继续。`, `triage-resume-active:${key}`); return;
        }
        if (task.lastRunStopped !== true) {
          this.#notice(data, trigger, '上次分析的停止状态尚未确认，请先由管理员检查。', `triage-uncertain:${key}`); return;
        }
        // A previous waiting/result output owns its immutable outbox keys. An
        // explicit new attempt must not replace that report under the same key.
        if (Object.hasOwn(task.reports, task.inputRevision)) { task.inputRevision++; this.#supersede(data, task); }
        task.status = 'queued'; task.stopRequested = false; task.pauseRequested = false; task.uncertain = false; task.updatedAt = this.now(); this.#taskNode(data, task);
        this.#notice(data, trigger, `#${task.id} 已继续排队，保留原有资料和分析记录。`, `triage-resume:${key}`); return;
      }
      const graph = this.#recordTrigger(data, trigger);
      Object.assign(entry, graph); entry.trigger = structuredClone(trigger);
      const linked = data.triage.issueTasks[issueKey(trigger)];
      let current = task || (linked && data.tasks[linked]);
      if (current && (!kind(current) || !same(current.conversationId, trigger.conversationId))) throw fail('TRIAGE_ROUTE_SCOPE');
      if (!current) {
        const id = 'T' + String(data.nextTask++).padStart(6, '0');
        current = data.tasks[id] = { id, kind: 'log-triage', sourceId: trigger.sourceId, projectId: String(trigger.projectId),
          conversationId: trigger.conversationId, externalIssueId: String(trigger.externalIssueId), externalIssueNo: trigger.externalIssueNo,
          externalIssueKey: issueKey(trigger), reference: reference('task', id), threadReference: graph.threadReference,
          imThreadReferences: [], sourceReferences: [], inputs: [], inputRevision: 0, reportRevision: 0, reports: {}, status: 'queued', attempt: 0,
          summary: `日志分析 ${trigger.externalIssueNo || trigger.externalIssueId}`, createdAt: this.now(), updatedAt: this.now() };
        data.triage.issueTasks[issueKey(trigger)] = id;
        this.#outbox(data, { key: `triage-accepted:${id}`, text: `${trigger.externalIssueNo || trigger.externalIssueId} 已收到，正在检查日志资料。#${id}`,
          conversationId: current.conversationId, taskId: id, category: 'notice' });
      }
      if (trigger.sourceKind === 'im') current.requesterId = trigger.requesterId;
      if (trigger.request === 'reanalyse' && !this.runs.has(current.id) && (!current.uncertain || current.lastRunStopped === true)) {
        current.stopRequested = false; current.pauseRequested = false; current.uncertain = false;
      }
      const issue = structuredClone(trigger.issue);
      if (trigger.description) current.descriptionOverride = trigger.description;
      if (current.descriptionOverride) issue.description = current.descriptionOverride;
      current.windowOverride = { ...current.windowOverride, ...trigger.window };
      const provided = { ...triageWindow(issue.description ?? ''), ...(issue.faultDate ? { date: issue.faultDate } : {}),
        ...(issue.faultStart ? { from: issue.faultStart } : {}), ...(issue.faultEnd ? { to: issue.faultEnd } : {}),
        ...(issue.timezone ? { timeZone: normalizeZone(issue.timezone) } : {}), ...current.windowOverride };
      const clockDomains = { ...this.options.clockDomains, ...current.clockDomains, ...trigger.clockDomains };
      const fingerprint = hash({ id: issue.id, no: issue.no, title: issue.title, description: issue.description,
        attachments: (issue.attachments ?? []).map(file => String(file.id)).sort(), window: provided, clockDomains });
      const changed = current.inputFingerprint !== fingerprint || trigger.request === 'reanalyse';
      current.sourceReferences = [...new Set([...current.sourceReferences, graph.reference])];
      if (graph.imThreadReference) current.imThreadReferences = [...new Set([...current.imThreadReferences, graph.imThreadReference])];
      if (!current.inputs.some(input => input.id === key)) current.inputs.push({ id: key, source: trigger.sourceKind, reference: graph.reference, text: trigger.text ?? '', at: trigger.observedAt });
      if (changed) {
        current.issue = issue; current.fileIds = (issue.attachments ?? []).map(file => String(file.id)); current.window = provided;
        current.clockDomains = clockDomains;
        current.inputFingerprint = fingerprint; current.inputRevision++; current.updatedAt = this.now();
        this.#supersede(data, current);
        if (!this.runs.has(current.id) && !current.uncertain && !current.stopRequested) current.status = 'queued';
      } else if (trigger.sourceKind === 'im' && current.reportText) {
        this.#outbox(data, { key: `triage-cached:${key}`, text: `#${current.id} · 分析版本 ${current.reportRevision}\n${current.reportText}`, conversationId: current.conversationId,
          taskId: current.id, revision: current.reportRevision, category: 'details', requesterId: trigger.requesterId });
      }
      data.subscriptions[graph.reference] = [current.id]; this.#taskNode(data, current);
    });
    if (cancel) await this.cancel(cancel, 'Stopped by an authorized trigger');
    if (stoppedTask) await this.c.transaction(data => {
      const task = data.tasks[stoppedTask];
      this.#outbox(data, { key: `triage-stop:${key}`, text: task.status === 'cancelled'
        ? `#${task.id} 分析已停止，已有资料和记录保留。`
        : `#${task.id} 已暂停，上次分析的停止状态仍需管理员检查。`,
      conversationId: task.conversationId, taskId: task.id, revision: task.inputRevision, category: 'notice' });
    });
  }
  async #changeBinding(key, trigger) {
    const admin = () => this.options.allowChatProjectBinding && this.options.adminSenderIds.some(id => same(id, trigger.requesterId))
      && this.#humanAllowed(trigger.requesterId, trigger.conversationId, this.c.conversations);
    if (!admin()) {
      await this.c.transaction(data => { data.inbox[key].status = 'routed'; data.inbox[key].decision = { action: 'ignore', reason: 'administrator_required' };
        this.#notice(data, trigger, '只有管理员可以更改跟踪项目。', `triage-admin:${key}`); }); return;
    }
    const response = await this.adapter.listProjects({ search: trigger.projectCode });
    const matches = response?.data?.filter(project => String(project.code).toUpperCase() === trigger.projectCode.toUpperCase()) ?? [];
    if (matches.length !== 1 || response.count > response.data.length) throw fail('TRIAGE_AMBIGUOUS_PROJECT');
    const project = matches[0];
    await this.c.transaction(data => {
      if (!admin()) throw fail('TRIAGE_AUTH_REVOKED');
      const existing = data.triage.bindings.find(binding => same(binding.sourceId, this.options.sourceId) && same(binding.projectId, project.id));
      if (trigger.request === 'bind' && existing?.enabled && !same(existing.conversationId, trigger.conversationId)) throw fail('TRIAGE_PROJECT_ALREADY_BOUND');
      if (existing && !same(existing.conversationId, trigger.conversationId)) throw fail('TRIAGE_BINDING_SCOPE');
      const binding = existing ?? { sourceId: this.options.sourceId, projectId: String(project.id), projectCode: project.code,
        conversationId: trigger.conversationId, origin: 'chat', createdBy: trigger.requesterId };
      if (!existing) data.triage.bindings.push(binding);
      const starting = trigger.request === 'bind' && !binding.enabled;
      binding.enabled = trigger.request === 'bind'; binding.manuallyDisabled = !binding.enabled;
      if (starting && data.triage.qa[bindingKey(binding)]) {
        const prior = data.triage.qa[bindingKey(binding)];
        data.triage.qa[bindingKey(binding)] = { previousCheckpoint: prior.checkpoint ?? prior.previousCheckpoint,
          checkpoint: null, status: 'baselining', failures: 0 };
      }
      data.inbox[key].status = 'routed'; data.inbox[key].decision = { action: trigger.request, taskKind: 'log-triage', projectId: String(project.id) };
      this.#notice(data, trigger, binding.enabled ? `已开始跟踪项目 ${project.code}，先建立历史清单，之后只分析新问题。` : `已停止跟踪项目 ${project.code}。`, `triage-binding:${key}`);
    });
  }
  async execute(id) {
    if (this.runs.has(id)) return this.runs.get(id).promise;
    const run = { controller: new AbortController(), modelReserved: false };
    this.runs.set(id, run);
    run.promise = this.#execute(id, run).finally(() => this.runs.delete(id));
    return run.promise;
  }
  #storeResult(data, task, snapshot, result) {
    const id = task.id;
    const stored = { inputRevision: snapshot.inputRevision, attempt: snapshot.attempt, report: result.report ?? null, manifest: result.manifest ?? null,
      files: result.files ?? [], execution: result.execution ?? null,
      text: String(result.text ?? ''), status: result.status, at: this.now() };
    task.reports[snapshot.inputRevision] = stored;
    if (task.inputRevision !== snapshot.inputRevision) { task.status = 'queued'; task.updatedAt = this.now(); this.#taskNode(data, task); return; }
    task.status = result.status; task.reportRevision = snapshot.inputRevision;
    task.report = result.report ?? null; task.manifest = result.manifest ?? null; task.reportText = stored.text; task.updatedAt = this.now();
    task.files = stored.files; task.execution = stored.execution;
    task.resultReference = reference('result', `triage:${id}:${snapshot.inputRevision}`);
    putNode(data.graph, { id: task.resultReference, kind: 'result', projectId: String(task.projectId), conversations: [task.conversationId],
      text: JSON.stringify({ ...stored, files: stored.files.map(({ pathPrivate, ...file }) => file) }), links: [task.reference, ...task.sourceReferences] });
    this.#outbox(data, { key: `triage-result:${id}:${snapshot.inputRevision}`, text: `#${id} · 分析版本 ${snapshot.inputRevision}\n${stored.text}`,
      conversationId: task.conversationId, taskId: id, revision: snapshot.inputRevision });
    for (const file of stored.files) {
      const key = `triage-file:${id}:${snapshot.inputRevision}:${file.sha256}`;
      this.#outbox(data, { key, text: `#${id} · 分析版本 ${snapshot.inputRevision} · ${file.name}`,
        conversationId: task.conversationId, taskId: id, revision: snapshot.inputRevision, category: 'artifact' });
      data.outbox[`${key}:0`].artifact = structuredClone(file);
    }
    this.#taskNode(data, task);
  }
  /** Local operator recovery only; this is deliberately absent from HTTP/chat controls. */
  async publishRecovered(id, result, { attempt, inputRevision, processTreeStopped } = {}) {
    if (processTreeStopped !== true || !Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(inputRevision) || inputRevision < 1
      || result?.inputRevision !== inputRevision || !validRecovered(result)) throw fail('TRIAGE_RECOVERY_INVALID');
    result = structuredClone(result);
    result.execution = validateExecutionProof(result.execution, result.execution.backend);
    const conversations = await this.c.api.request('/api/conversations'); this.c.conversations = structuredClone(conversations);
    await this.c.transaction(data => {
      const task = data.tasks[id], reservation = data.triage.budget.reservations[`${id}:${attempt}`];
      if (!kind(task) || task.status !== 'paused' || task.uncertain !== true || task.stopRequested
        || this.c.active.has(id) || this.runs.has(id) || task.attempt !== attempt || task.inputRevision !== inputRevision
        || task.includedRevision !== inputRevision || task.modelReserved !== true) throw fail('TRIAGE_RECOVERY_STATE');
      if (!record(reservation) || reservation.taskId !== id || reservation.attempt !== attempt || reservation.inputRevision !== inputRevision
        || reservation.void || reservation.voided || reservation.voidedAt || /^void/iu.test(reservation.status ?? '')) throw fail('TRIAGE_RECOVERY_RESERVATION');
      if (!this.authorized(task, conversations)) throw fail('TRIAGE_AUTH_REVOKED');
      task.lastRunStopped = true; task.uncertain = false;
      task.recovery = { attempt, inputRevision, processTreeStopped: true, status: result.status, at: this.now() };
      this.#storeResult(data, task, { attempt, inputRevision }, result);
    });
  }
  async #execute(id, run) {
    let snapshot;
    try {
      await this.c.transaction(data => {
        const task = data.tasks[id];
        if (!kind(task) || task.status !== 'queued' || task.stopRequested || task.uncertain || !this.authorized(task)) return;
        task.status = 'preparing'; task.attempt++; task.includedRevision = task.inputRevision;
        task.startedAt = this.now(); task.updatedAt = this.now();
        if ((task.fileIds ?? []).some(value => !/^[1-9]\d*$/u.test(String(value)))) throw fail('TRIAGE_FILE_ID_INVALID');
        const fileIds = (task.fileIds ?? []).map(Number);
        if (fileIds.some(value => !Number.isSafeInteger(value) || value <= 0) || new Set(fileIds).size !== fileIds.length) throw fail('TRIAGE_FILE_ID_INVALID');
        snapshot = structuredClone({ ...task, fileIds, inputRevision: task.includedRevision }); this.#taskNode(data, task);
      });
      if (!snapshot) return;
      if (this.c.active.get(id)) this.c.active.get(id).started = true;
      const beforeModel = async () => {
        const conversations = await this.c.api.request('/api/conversations'); this.c.conversations = structuredClone(conversations);
        await this.c.transaction(data => {
          const task = data.tasks[id];
          if (run.controller.signal.aborted || this.stopping || this.c.stopping || task.stopRequested) throw fail('TRIAGE_STOPPED');
          if (!this.authorized(task, conversations)) throw fail('TRIAGE_AUTH_REVOKED');
          if (task.inputRevision !== snapshot.inputRevision) throw fail('TRIAGE_INPUT_CHANGED');
          const budget = data.triage.budget, day = this.now().slice(0, 10), key = `${id}:${snapshot.attempt}`;
          if (budget.reservations[key]) throw fail('TRIAGE_MODEL_ALREADY_RESERVED');
          if (budget.total >= this.options.totalModelCalls || (budget.days[day] ?? 0) >= this.options.dailyModelCalls) throw fail('TRIAGE_MODEL_BUDGET');
          budget.total++; budget.days[day] = (budget.days[day] ?? 0) + 1;
          budget.reservations[key] = { taskId: id, attempt: snapshot.attempt, inputRevision: snapshot.inputRevision, at: this.now() };
          task.status = 'running'; task.modelReserved = true; this.#taskNode(data, task);
        });
        run.modelReserved = true;
      };
      const result = await this.worker.run(snapshot, { signal: run.controller.signal, beforeModel });
      if (!result || !['completed', 'partial', 'waiting_input', 'waiting_log'].includes(result.status) || result.inputRevision !== snapshot.inputRevision) throw fail('TRIAGE_INVALID_RESULT');
      if (result.status === 'partial' && (!run.modelReserved || !validRecovered(result))) throw fail('TRIAGE_INVALID_PARTIAL');
      if (result.status === 'completed' && !run.modelReserved
        && !(result.modelCalls === 0 && result.report?.mode === 'preliminary' && result.manifest && typeof result.manifest === 'object')) throw fail('TRIAGE_UNRESERVED_MODEL');
      if (result.modelCalls !== undefined && (!Number.isSafeInteger(result.modelCalls) || result.modelCalls < 0 || result.modelCalls > 1)) throw fail('TRIAGE_INVALID_RESULT');
      await this.c.transaction(data => {
        const task = data.tasks[id]; task.lastRunStopped = true;
        if (task.stopRequested || run.controller.signal.aborted) { task.status = task.pauseRequested ? 'paused' : 'cancelled'; task.uncertain = false; this.#taskNode(data, task); return; }
        this.#storeResult(data, task, snapshot, result);
      });
    } catch (cause) {
      await this.c.transaction(data => {
        const task = data.tasks[id]; if (!kind(task)) return;
        task.error = safeError(cause); task.updatedAt = this.now();
        task.failure = { phase: String(cause.phase ?? 'execution').slice(0, 50), kind: String(cause.kind ?? 'failed').slice(0, 80),
          modelStarted: cause.modelStarted === true, processTreeStopped: cause.processTreeStopped === true };
        const stopped = cause.processTreeStopped === true || !run.modelReserved && !cause.modelStarted;
        task.lastRunStopped = stopped;
        if (cause.code === 'TRIAGE_INPUT_CHANGED' && stopped && !task.stopRequested) { task.status = 'queued'; task.uncertain = false; }
        else if (task.stopRequested && stopped) { task.status = task.pauseRequested ? 'paused' : 'cancelled'; task.uncertain = false; }
        else { task.status = 'paused'; task.uncertain = !stopped || run.modelReserved || Boolean(cause.modelStarted); }
        this.#taskNode(data, task);
        if (task.status === 'paused') this.#outbox(data, { key: `triage-paused:${id}:${task.attempt}`, text: `#${id} 分析已暂停，资料和记录已保留。${task.error === 'TRIAGE_MODEL_BUDGET' ? '本次分析额度已用完。' : '请由管理员检查后继续。'}`,
          conversationId: task.conversationId, taskId: id, revision: task.inputRevision, category: 'notice' });
      });
    }
  }
  async cancel(id, reason = 'Analysis stopped') {
    const task = this.data.tasks[id]; if (!kind(task)) return;
    await this.c.transaction(data => { const current = data.tasks[id]; current.stopRequested = true;
      current.status = this.runs.has(id) ? 'interrupting' : current.uncertain && current.lastRunStopped !== true ? 'paused' : 'cancelled'; this.#taskNode(data, current); });
    const run = this.runs.get(id);
    if (run) { run.controller.abort(reason); await run.promise; }
    return { processTreeStopped: this.data.tasks[id].lastRunStopped === true || !run && !this.data.tasks[id].uncertain };
  }
  async pause(id, cause = fail('TRIAGE_PAUSED')) {
    await this.c.transaction(data => { const task = data.tasks[id]; if (!kind(task)) return;
      task.status = 'paused'; task.error = safeError(cause); task.stopRequested = true; task.pauseRequested = true;
      task.uncertain = task.uncertain || this.runs.has(id); this.#taskNode(data, task); });
    const run = this.runs.get(id); if (run) { run.controller.abort('Analysis paused'); await run.promise; }
  }
  async finishStopped(id) { return this.cancel(id); }
  beforeSend(item, conversations) {
    if (item.kind !== 'log-triage') return 'send';
    if (hash(item.text) !== item.bodyHash) return 'pause';
    const chat = item.event?.conversation_id;
    if (!this.#chatAllowed(chat, conversations)) return 'pause';
    if (item.controlAck) return this.#humanAllowed(item.requesterId, chat, conversations) ? 'send' : 'pause';
    const task = this.data.tasks[item.taskId];
    if (!task || !kind(task) || !same(task.conversationId, chat)) return 'drop';
    if (!this.authorized(task, conversations)) return 'pause';
    if (['result', 'artifact'].includes(item.category) && (task.stopRequested || item.reportRevision !== task.inputRevision || item.reportRevision !== task.reportRevision)) return 'drop';
    if (item.requesterId && !this.#humanAllowed(item.requesterId, chat, conversations)) return 'pause';
    return 'send';
  }
  async close() {
    this.stopping = true;
    for (const run of this.runs.values()) run.controller.abort('Controller closing');
    await Promise.allSettled([...this.runs.values()].map(run => run.promise));
    await this.worker?.close?.();
  }
}
