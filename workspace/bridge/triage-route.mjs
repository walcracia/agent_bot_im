const ACTIONS = new Set(['new', 'followup', 'ignore', 'status', 'details', 'stop', 'resume', 'bind', 'unbind', 'need_info']);
const CLOSED = new Set(['close', 'invalid', 'noneedfix']);
const same = (a, b) => String(a) === String(b);

/** Deterministic typed routing. Source content never selects code, a destination or credentials. */
export function routeTriageTriggers(triggers, { tasks = [] } = {}) {
  if (!Array.isArray(triggers) || triggers.length > 100) throw new Error('Invalid triage trigger batch.');
  const known = Array.isArray(tasks) ? tasks : Object.values(tasks);
  const seen = new Set();
  return triggers.map(trigger => {
    if (!trigger || typeof trigger.triggerId !== 'string' || !trigger.triggerId || seen.has(trigger.triggerId)
      || !['qa', 'im'].includes(trigger.sourceKind)) throw new Error('Invalid triage trigger.');
    seen.add(trigger.triggerId);
    const own = known.filter(task => task.kind === 'log-triage' && same(task.conversationId, trigger.conversationId));
    const requested = trigger.taskId && own.find(task => task.id === trigger.taskId);
    const linked = own.find(task => same(task.sourceId, trigger.sourceId) && same(task.projectId, trigger.projectId)
      && same(task.externalIssueId, trigger.externalIssueId));
    let task = requested || linked, action;
    if (trigger.sourceKind === 'im') {
      if (['bind', 'unbind'].includes(trigger.request)) action = trigger.request;
      else if (trigger.taskId && !requested) action = 'need_info';
      else if (['status', 'details', 'stop', 'resume'].includes(trigger.request)) action = task ? trigger.request : 'need_info';
      else if (!trigger.issue || !trigger.projectId || !trigger.sourceId) action = 'need_info';
      else action = task ? 'followup' : 'new';
    } else if (!trigger.sourceId || !trigger.projectId || !trigger.externalIssueId || !trigger.conversationId) {
      throw new Error('QA trigger has no trusted binding.');
    } else if (trigger.eventKind === 'issue.closed' || CLOSED.has(trigger.issue?.status)) action = task ? 'stop' : 'ignore';
    else if (trigger.eventKind === 'issue.created') action = task ? 'followup' : 'new';
    else if (['issue.attachments_changed', 'issue.updated'].includes(trigger.eventKind)) action = task ? 'followup' : 'ignore';
    else action = 'ignore';
    if (!ACTIONS.has(action)) throw new Error('Invalid typed route.');
    return { triggerId: trigger.triggerId, taskKind: 'log-triage', action, taskId: task?.id ?? null,
      summary: String(trigger.issue?.no || trigger.externalIssueNo || trigger.issueNo || '日志分析').slice(0, 160) };
  });
}
