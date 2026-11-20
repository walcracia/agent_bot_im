import { createHash } from 'node:crypto';
import { normalizeQaIssue } from './qa-mcp.mjs';

export const DEFAULT_QA_SOURCE_LIMITS = Object.freeze({ pageSize: 100, maxPages: 20, maxIssues: 2000, maxCalls: 2200, maxAttachments: 100, maxTextBytes: 200000, maxCheckpointIssues: 10000 });
const error = code => Object.assign(new Error(code), { code });
const id = value => {
  if (!['string', 'number'].includes(typeof value) || !String(value).trim() || String(value).length > 200) throw error('QA_INVALID_BINDING');
  return String(value);
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const closedByDefault = ['close', 'invalid', 'noneedfix'];

export class QaSource {
  constructor({ binding, adapter, limits = {}, now = () => new Date(), closedStatuses = closedByDefault } = {}) {
    if (!binding || !adapter || typeof adapter.listIssues !== 'function' || typeof adapter.listFiles !== 'function') throw error('QA_INVALID_SOURCE');
    this.binding = { sourceId: id(binding.sourceId), projectId: id(binding.projectId), conversationId: id(binding.conversationId) };
    this.adapter = adapter; this.now = now; this.limits = { ...DEFAULT_QA_SOURCE_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) if (!Object.hasOwn(DEFAULT_QA_SOURCE_LIMITS, key) || !Number.isSafeInteger(value) || value <= 0) throw error('QA_INVALID_LIMITS');
    if (this.limits.pageSize > 200) throw error('QA_INVALID_LIMITS');
    if (!Array.isArray(closedStatuses) || closedStatuses.some(value => typeof value !== 'string' || !value)) throw error('QA_INVALID_CLOSED_STATUSES');
    this.closed = new Set(closedStatuses);
  }

  async poll(checkpoint = null, { signal, timeoutMs = 180000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600000) throw error('QA_INVALID_SCAN_TIMEOUT');
    this.#validateCheckpoint(checkpoint);
    const deadline = Date.now() + timeoutMs;
    const observedAt = new Date(this.now()).toISOString(), seen = Object.create(null), current = new Map();
    let count, calls = 0;
    const check = () => { signal?.throwIfAborted(); if (Date.now() >= deadline) throw error('QA_SCAN_TIMEOUT'); };
    const call = async action => { check(); if (++calls > this.limits.maxCalls) throw error('QA_CALL_LIMIT'); const result = await action(); check(); return result; };
    for (let pageIndex = 1; pageIndex <= this.limits.maxPages; pageIndex++) {
      const response = await call(() => this.adapter.listIssues({ projectId: this.binding.projectId, pageIndex, pageSize: this.limits.pageSize }));
      if (!response || !Array.isArray(response.data) || !Number.isSafeInteger(response.count) || response.count < 0 || response.data.length > this.limits.pageSize) throw error('QA_INVALID_PAGE');
      if (response.count > this.limits.maxIssues) throw error('QA_ISSUE_LIMIT');
      if (count !== undefined && count !== response.count) throw error('QA_SCAN_CHANGED');
      count = response.count;
      for (const raw of response.data) {
        const issue = normalizeQaIssue(raw, this.binding.projectId);
        if (current.has(issue.id)) throw error('QA_DUPLICATE_ISSUE');
        const files = await call(() => this.adapter.listFiles(issue));
        if (!Array.isArray(files) || files.length > this.limits.maxAttachments) throw error('QA_ATTACHMENT_LIMIT');
        issue.attachments = files.map(file => ({ id: id(typeof file === 'object' ? file?.id : file) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        if (new Set(issue.attachments.map(file => file.id)).size !== issue.attachments.length) throw error('QA_DUPLICATE_FILE');
        if (Buffer.byteLength(JSON.stringify(issue)) > this.limits.maxTextBytes) throw error('QA_ISSUE_TEXT_LIMIT');
        current.set(issue.id, issue);
      }
      if (current.size === count) break;
      if (current.size > count || response.data.length === 0) throw error('QA_INCOMPLETE_PAGE');
      if (pageIndex === this.limits.maxPages) throw error('QA_PAGE_LIMIT');
    }
    if (current.size !== count) throw error('QA_INCOMPLETE_SCAN');
    // Keep absent records: disappearance is not proof of a close event or permission to replay.
    if (checkpoint) for (const [key, value] of Object.entries(checkpoint.seen)) seen[key] = structuredClone(value);
    const triggers = [];
    for (const issue of current.values()) {
      const sourceRevision = digest(issue), previous = checkpoint && Object.hasOwn(checkpoint.seen, issue.id) ? checkpoint.seen[issue.id] : null;
      seen[issue.id] = { sourceRevision, issue };
      if (!checkpoint || previous?.sourceRevision === sourceRevision) continue;
      let eventKind;
      if (this.closed.has(issue.status)) { if (previous && !this.closed.has(previous.issue.status)) eventKind = 'issue.closed'; }
      else if (!previous) eventKind = 'issue.created';
      else if (digest(previous.issue.attachments ?? []) !== digest(issue.attachments)) eventKind = 'issue.attachments_changed';
      else eventKind = 'issue.updated';
      if (eventKind) triggers.push({
        triggerId: ['qa', this.binding.sourceId, this.binding.projectId, issue.id, eventKind, sourceRevision].map(encodeURIComponent).join(':'),
        sourceKind: 'qa', ...this.binding, eventKind, externalIssueId: issue.id, externalIssueNo: issue.no,
        observedAt, sourceRevision, issue: structuredClone(issue),
      });
    }
    if (Object.keys(seen).length > this.limits.maxCheckpointIssues) throw error('QA_CHECKPOINT_LIMIT');
    check();
    return { triggers, checkpoint: { version: 1, binding: { ...this.binding }, baselinedAt: checkpoint?.baselinedAt ?? observedAt, observedAt, seen: Object.fromEntries(Object.entries(seen)) } };
  }

  #validateCheckpoint(checkpoint) {
    if (checkpoint === null || checkpoint === undefined) return;
    if (checkpoint.version !== 1 || !checkpoint.binding || Object.keys(this.binding).some(key => checkpoint.binding[key] !== this.binding[key]) || !checkpoint.seen || typeof checkpoint.seen !== 'object' || Array.isArray(checkpoint.seen) || typeof checkpoint.baselinedAt !== 'string') throw error('QA_INVALID_CHECKPOINT');
    if (Object.keys(checkpoint.seen).length > this.limits.maxCheckpointIssues) throw error('QA_CHECKPOINT_LIMIT');
    for (const [key, value] of Object.entries(checkpoint.seen)) {
      if (!value || typeof value.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceRevision) || value.issue?.id !== key || value.issue?.projectId !== this.binding.projectId || digest(value.issue) !== value.sourceRevision) throw error('QA_INVALID_CHECKPOINT');
    }
  }
}
