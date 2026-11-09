import { createHash } from 'node:crypto';

export function reference(kind, value) {
  if (!['trigger', 'thread', 'task', 'result', 'evidence'].includes(kind)) throw new Error('Invalid context kind.');
  return `${kind}:${createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
}

export function putNode(graph, { id, kind, projectId, conversations = [], text = '', links = [], at = new Date().toISOString(), meta = {} }) {
  if (!id || !projectId || typeof text !== 'string') throw new Error('Invalid context node.');
  const old = graph[id];
  if (old && (old.projectId !== projectId || old.kind !== kind)) throw new Error('Context reference collision.');
  graph[id] = { id, kind, projectId, conversations: [...new Set(conversations)], text,
    links: [...new Set(links)], at, meta };
  return id;
}

/** Every truncation leaves a stable continuation reference; no cross-project reads. */
export function readNode(graph, id, { projectId, conversations, offset = 0, limit = 6000, linkOffset = 0 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12000 || !Number.isSafeInteger(linkOffset) || linkOffset < 0) throw new Error('Invalid context page.');
  const node = graph[id];
  const allowed = item => item && item.projectId === projectId && item.conversations.some(value => conversations?.includes(value));
  if (!allowed(node)) throw new Error('Context is outside the authorized task scope.');
  const text = node.text.slice(offset, offset + limit);
  const links = node.links.filter(value => allowed(graph[value]));
  return { id, kind: node.kind, at: node.at, text, offset, total: node.text.length,
    next: offset + text.length < node.text.length ? { reference: id, offset: offset + text.length } : null,
    nextLinks: linkOffset + 40 < links.length ? { reference: id, linkOffset: linkOffset + 40 } : null,
    links: links.slice(linkOffset, linkOffset + 40).map(value => ({ reference: value, kind: graph[value].kind,
      summary: graph[value].text.slice(0, 240), truncated: graph[value].text.length > 240 })) };
}

export function inlineContext(graph, ids, scope, budget = 10000) {
  const nodes = [];
  for (const id of [...new Set(ids)]) {
    if (budget < 1) break;
    try {
      const item = readNode(graph, id, { ...scope, limit: Math.min(2000, budget) });
      nodes.push(item); budget -= item.text.length;
    } catch { /* A link can outlive membership; it must not leak into a task. */ }
  }
  return nodes;
}
