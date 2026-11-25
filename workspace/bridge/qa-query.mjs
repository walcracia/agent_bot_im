import { normalizeQaIssue } from './qa-mcp.mjs';
import { DEFAULT_QA_SOURCE_LIMITS } from './qa-source.mjs';

const fail = code => Object.assign(new Error(code), { code });
const same = (a, b) => a !== undefined && b !== undefined && String(a) === String(b);
const closed = new Set(['close', 'invalid', 'noneedfix']);
const active = new Set(['preparing', 'running', 'analysing', 'validating', 'interrupting']);
const clean = (value, max = 100) => String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
const issueStatuses = { open: '未解决', active: '未解决', resolved: '待验证', wait: '待验证', reopen: '重新打开', close: '已关闭', invalid: '无效', noneedfix: '无需修复', suspend: '挂起' };
const issueStatus = value => Object.hasOwn(issueStatuses, value) ? issueStatuses[value] : '其他状态';
const scopeKeys = ['sourceId', 'projectId', 'conversationId'];
const beijing = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const displayTime = value => Number.isFinite(value) ? beijing.format(new Date(value)) : '暂无记录';

function dateReader(timezone) {
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw fail('QA_QUERY_TIMEZONE'); }
  const partsAt = time => Object.fromEntries(formatter.formatToParts(new Date(time)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const asUtc = parts => Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return value => {
    // QA creation times without an offset use the trusted source timezone; fault times are never used.
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/u.exec(String(value ?? '').trim());
    if (!match) return null;
    const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4] ?? 0), minute: Number(match[5] ?? 0), second: Number(match[6] ?? 0) };
    const nominal = asUtc(parts), check = new Date(nominal);
    if (parts.year < 1000 || check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day
      || check.getUTCHours() !== parts.hour || check.getUTCMinutes() !== parts.minute || check.getUTCSeconds() !== parts.second) return null;
    const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
    if (match[8]) {
      if (match[8] === 'Z') return nominal + milliseconds;
      const offset = match[8].slice(1).replace(':', ''), hours = Number(offset.slice(0, 2)), minutes = Number(offset.slice(2));
      if (hours > 23 || minutes > 59) return null;
      return nominal + milliseconds - (match[8][0] === '+' ? 1 : -1) * (hours * 60 + minutes) * 60000;
    }
    // Compare offsets around the local day; ambiguous or nonexistent DST times remain unknown.
    const candidates = new Set();
    for (const delta of [-86400000, 0, 86400000]) {
      const offset = asUtc(partsAt(nominal + delta)) - (nominal + delta), candidate = nominal - offset;
      if (asUtc(partsAt(candidate)) === nominal) candidates.add(candidate + milliseconds);
    }
    return candidates.size === 1 ? [...candidates][0] : null;
  };
}

async function listCurrentIssues(adapter, binding, signal) {
  if (!adapter || typeof adapter.listIssues !== 'function') throw fail('QA_QUERY_ADAPTER');
  const limits = Object.fromEntries(['pageSize', 'maxPages', 'maxIssues'].map(key => [key, adapter[key] ?? DEFAULT_QA_SOURCE_LIMITS[key]]));
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0) || limits.pageSize > 200) throw fail('QA_INVALID_LIMITS');
  const issues = new Map(); let count;
  for (let pageIndex = 1; pageIndex <= limits.maxPages; pageIndex++) {
    signal?.throwIfAborted();
    const page = await adapter.listIssues({ projectId: String(binding.projectId), pageIndex, pageSize: limits.pageSize });
    signal?.throwIfAborted();
    if (!page || !Array.isArray(page.data) || !Number.isSafeInteger(page.count) || page.count < 0 || page.data.length > limits.pageSize) throw fail('QA_INVALID_PAGE');
    if (page.count > limits.maxIssues) throw fail('QA_ISSUE_LIMIT');
    if (count !== undefined && count !== page.count) throw fail('QA_SCAN_CHANGED');
    count = page.count;
    for (const raw of page.data) {
      const issue = normalizeQaIssue(raw, binding.projectId);
      if (issues.has(issue.id)) throw fail('QA_DUPLICATE_ISSUE');
      const { id, no, title, status, openedAt } = issue;
      issues.set(id, { id, no, title, status, openedAt });
    }
    if (issues.size === count) return [...issues.values()];
    if (issues.size > count || page.data.length === 0) throw fail('QA_INCOMPLETE_PAGE');
  }
  throw fail('QA_PAGE_LIMIT');
}

function taskState(task) {
  if (task.uncertain && task.lastRunStopped !== true) return 'unconfirmed';
  if (task.status === 'completed' && (!Number.isSafeInteger(task.inputRevision) || task.inputRevision < 1 || !Number.isSafeInteger(task.reportRevision))) return 'unconfirmed';
  if (task.status === 'completed' && task.reportRevision !== task.inputRevision) return 'outdated';
  if (active.has(task.status)) return 'active';
  return ['queued', 'completed', 'partial', 'waiting_input', 'waiting_log', 'paused', 'cancelled'].includes(task.status) ? task.status : 'unknown';
}
const taskLabels = { unconfirmed: '状态待确认', outdated: '新资料待分析（已有旧报告）', active: '正在处理', queued: '排队中', completed: '已完成', partial: '已有初排，尚未完成', waiting_input: '等待补充资料', waiting_log: '等待日志', paused: '已暂停', cancelled: '已停止', unknown: '状态待确认' };

function localSummary(binding, request, tasks) {
  const selected = tasks.filter(task => task?.kind === 'log-triage' && scopeKeys.every(key => same(task[key], binding[key]))
    && (!request.taskId || task.id === request.taskId) && (!request.issueNo || String(task.externalIssueNo).toUpperCase() === request.issueNo.toUpperCase()));
  const counts = {};
  for (const task of selected) { const state = taskState(task); counts[state] = (counts[state] ?? 0) + 1; }
  const latest = [...selected].sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0)).slice(0, 5)
    .map(task => ({ taskId: clean(task.id), issueNo: clean(task.externalIssueNo || task.externalIssueId), state: taskState(task), label: taskLabels[taskState(task)] }));
  const text = selected.length ? Object.entries(counts).map(([state, count]) => `${taskLabels[state]}${count}项`).join('，') : '暂无分析任务';
  return { total: selected.length, counts, latest, text };
}

function pollSummary(binding, pollRecord, parseDate) {
  const checkpoint = pollRecord?.checkpoint;
  if (checkpoint?.binding && !scopeKeys.every(key => same(checkpoint.binding[key], binding[key]))) throw fail('QA_QUERY_SCOPE');
  const lastSuccess = parseDate(checkpoint?.observedAt);
  return { status: pollRecord?.status ?? 'unknown', lastSuccessAt: lastSuccess === null ? null : new Date(lastSuccess).toISOString(),
    text: `最近一次自动检查成功：${displayTime(lastSuccess === null ? NaN : lastSuccess)}${lastSuccess === null ? '' : '（北京时间）'}${pollRecord?.status === 'error' ? '；之后的自动检查未成功' : ''}。` };
}

/** Read-only: callers resolve an authorized, trusted binding before invoking this module. */
export async function executeQaQuery({ adapter, binding, request, tasks = [], pollRecord, now = () => new Date(), timezone = 'Asia/Shanghai', signal } = {}) {
  if (!binding || scopeKeys.some(key => !['string', 'number'].includes(typeof binding[key]) || !String(binding[key]).trim() || String(binding[key]).length > 200)) throw fail('QA_QUERY_BINDING');
  if (!request || !['recent_issues', 'analysis_status'].includes(request.kind) || !Array.isArray(tasks)) throw fail('QA_QUERY_REQUEST');
  for (const key of ['issueNo', 'taskId', 'projectCode']) if (request[key] !== undefined && (typeof request[key] !== 'string' || !request[key].trim() || request[key].length > 200)) throw fail('QA_QUERY_REQUEST');
  if (request.projectCode && String(binding.projectCode).toUpperCase() !== request.projectCode.toUpperCase()) throw fail('QA_QUERY_SCOPE');
  const days = request.days ?? 7;
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw fail('QA_QUERY_DAYS');
  const end = new Date(now()).getTime();
  if (!Number.isFinite(end)) throw fail('QA_QUERY_TIME');
  const sourceTimezone = binding.qaTimeZone ?? timezone, parseDate = dateReader(sourceTimezone);
  const poll = pollSummary(binding, pollRecord, parseDate), analysis = localSummary(binding, request, tasks);
  const project = clean(binding.projectCode || binding.projectId), checkedAt = new Date(end).toISOString();
  if (request.kind === 'analysis_status') {
    const heading = analysis.total ? `${project} 本聊天分析：${analysis.text}。` : `${project} ${request.taskId || request.issueNo ? '未找到对应的分析记录' : '本聊天暂无分析任务'}。`;
    const details = analysis.latest.map(task => `${task.issueNo} · ${task.label}`).join('\n');
    return { text: [heading, details, poll.text].filter(Boolean).join('\n'), data: { kind: request.kind, checkedAt, analysis, poll } };
  }
  const issues = await listCurrentIssues(adapter, binding, signal), start = end - days * 86400000;
  let unknownDates = 0;
  const recent = [];
  for (const issue of issues) {
    const created = parseDate(issue.openedAt);
    if (created === null) unknownDates++;
    else if (created >= start && created <= end) recent.push({ ...issue, createdAt: new Date(created).toISOString() });
  }
  recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const latest = recent.slice(0, 5).map(issue => ({ ...issue, no: clean(issue.no || issue.id), title: clean(issue.title), statusLabel: issueStatus(issue.status) }));
  const unresolved = issues.filter(issue => !closed.has(issue.status)).length;
  const lines = [`${project} 近${days}天（${displayTime(start)}—${displayTime(end)}，北京时间，按创建时间）：`,
    `新增${unknownDates ? '至少' : ''}${recent.length}个；当前未关闭${unresolved}个。`];
  if (unknownDates) lines.push(`另有${unknownDates}个缺陷的创建时间不明确，未计入近期新增。`);
  if (sourceTimezone !== 'Asia/Shanghai') lines.push(`未标时区的创建时间按${clean(sourceTimezone)}计算。`);
  for (const issue of latest) lines.push(`${issue.no} · ${issue.statusLabel} · ${issue.title || '未填写标题'}`);
  if (recent.length > latest.length) lines.push(`另有${recent.length - latest.length}个近期新增。`);
  lines.push(`本聊天分析：${analysis.text}。`, poll.text);
  return { text: lines.join('\n'), data: { kind: request.kind, checkedAt, sourceTimezone, from: new Date(start).toISOString(), to: checkedAt,
    days, total: issues.length, recentCount: recent.length, unresolvedCount: unresolved, unknownDateCount: unknownDates, latest, analysis, poll } };
}
