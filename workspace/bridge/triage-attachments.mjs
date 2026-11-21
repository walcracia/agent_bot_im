import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_BYTES = 99999999;
const NAMES = new Map([['report.json', 'application/json'], ['报告.txt', 'text/plain']]);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => { const rest = relative(root, file); return rest && !isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + sep); };
function invalid() { const error = new Error('报告文件校验失败，已暂停发送。'); error.code = 'TRIAGE_ARTIFACT_INVALID'; return error; }
function serverError(status) {
  const error = new Error(Number.isSafeInteger(status) ? `报告文件发送失败（HTTP ${status}）。` : '报告文件暂未发送，请稍后重试。');
  if (Number.isSafeInteger(status)) error.status = status;
  return error;
}
const publicMetadata = artifact => ({ name: artifact.name, size: artifact.size, sha256: artifact.sha256 });
const sameMetadata = (metadata, artifact) => metadata && metadata.name === artifact.name && metadata.size === artifact.size && metadata.sha256 === artifact.sha256;

function identity(item) {
  if (!item || item.kind !== 'log-triage' || item.category !== 'artifact' || typeof item.key !== 'string' || !item.key || item.key.length > 300
    || typeof item.clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(item.clientId)
    || typeof item.event?.conversation_id !== 'string' || !item.event.conversation_id || item.event.conversation_id.length > 200
    || typeof item.text !== 'string' || item.text.length > 10000) throw invalid();
  const artifact = item.artifact;
  if (!artifact || !NAMES.has(artifact.name) || artifact.mime !== NAMES.get(artifact.name) || typeof artifact.pathPrivate !== 'string'
    || !isAbsolute(artifact.pathPrivate) || basename(artifact.pathPrivate) !== artifact.name
    || !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > MAX_BYTES || artifact.size >= 100000000
    || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw invalid();
  return sha256(JSON.stringify({ key: item.key, clientId: item.clientId, conversationId: item.event.conversation_id,
    taskId: item.taskId ?? null, reportRevision: item.reportRevision ?? null, bodyHash: item.bodyHash ?? null,
    text: item.text, artifact: { ...publicMetadata(artifact), mime: artifact.mime, pathPrivate: artifact.pathPrivate } }));
}

/** Retain file identity across the read; reports follow the same <100MB IM attachment contract. */
async function artifactBytes(root, artifact) {
  if (typeof root !== 'string' || !isAbsolute(root) || (await lstat(root)).isSymbolicLink()) throw invalid();
  const trustedRoot = await realpath(root), absolute = resolve(artifact.pathPrivate);
  if (!inside(trustedRoot, absolute)) throw invalid();
  let cursor = trustedRoot;
  for (const part of relative(trustedRoot, absolute).split(sep)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw invalid();
  }
  if (await realpath(absolute) !== absolute) throw invalid();
  const original = await lstat(absolute);
  if (!original.isFile() || original.nlink !== 1 || original.size !== artifact.size || original.size > MAX_BYTES) throw invalid();
  const handle = await open(absolute, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.dev !== original.dev || before.ino !== original.ino || before.size !== artifact.size) throw invalid();
    const chunks = []; let size = 0;
    while (size <= MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(65536, MAX_BYTES + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); size += bytesRead;
    }
    const bytes = Buffer.concat(chunks), after = await handle.stat(), pathAfter = await lstat(absolute);
    if (size !== artifact.size || size > MAX_BYTES || sha256(bytes) !== artifact.sha256 || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || after.nlink !== 1 || pathAfter.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || after.size !== before.size || pathAfter.size !== before.size
      || await realpath(absolute) !== absolute) throw invalid();
    return bytes;
  } finally { await handle.close(); }
}

async function limitedJSON(response) {
  if (!response.ok) { await response.body?.cancel(); throw serverError(response.status); }
  if (!response.body) throw invalid();
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 16384) throw invalid(); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid(); }
}

/** Publish only validated report files. Outbox retry reuses the persisted upload and stable message id. */
export async function publishTriageArtifact({ api, item, root, transaction, beforeSend }) {
  let fingerprint;
  try {
    fingerprint = identity(item);
    if (!api || typeof api.request !== 'function' || typeof transaction !== 'function' || typeof beforeSend !== 'function') throw invalid();
    const base = new URL(api.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)
      || base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || typeof api.token !== 'string' || !api.token || /[\r\n]/.test(api.token)) throw invalid();
    const bytes = await artifactBytes(root, item.artifact);
    const gate = async () => {
      const conversations = await api.request('/api/conversations');
      if (!Array.isArray(conversations)) throw invalid();
      const verdict = await beforeSend(item, conversations);
      return verdict === 'send' ? null : { paused: true, verdict: verdict === 'drop' ? 'drop' : 'pause' };
    };
    let paused = await gate(); if (paused) return paused;
    const authoritative = await transaction(data => {
      const current = data.outbox?.[item.key];
      if (!current || identity(current) !== fingerprint) throw invalid();
      const attempts = current.uploadAttempts ?? 0;
      if (!Number.isSafeInteger(attempts) || attempts < 0) throw invalid();
      if (current.attachmentId) {
        if (attempts < 1 || !/^[A-Za-z0-9_-]{1,160}$/.test(current.attachmentId) || !sameMetadata(current.attachmentMetadata, item.artifact)) throw invalid();
        return { attachmentId: current.attachmentId };
      }
      current.uploadAttempts = attempts + 1;
      return { upload: true };
    });
    let attachmentId = authoritative.attachmentId;
    if (!attachmentId) {
      let metadata;
      try {
        const body = new FormData(); body.set('file', new Blob([bytes], { type: item.artifact.mime }), item.artifact.name);
        const response = await fetch(`${base.origin}/api/conversations/${encodeURIComponent(item.event.conversation_id)}/attachments`, {
          method: 'POST', headers: { Authorization: `Bearer ${api.token}` }, body, redirect: 'error', signal: AbortSignal.timeout(30000)
        });
        metadata = await limitedJSON(response);
        if (!metadata || !/^[A-Za-z0-9_-]{1,160}$/.test(metadata.id ?? '') || !sameMetadata(metadata, item.artifact)) throw invalid();
      } catch (error) {
        await transaction(data => {
          const current = data.outbox?.[item.key];
          if (current && identity(current) === fingerprint) current.uploadError = '报告文件上传未获确认，稍后继续发送。';
        });
        throw error;
      }
      attachmentId = await transaction(data => {
        const current = data.outbox?.[item.key];
        if (!current || identity(current) !== fingerprint) throw invalid();
        if (current.attachmentId) {
          if (!sameMetadata(current.attachmentMetadata, item.artifact)) throw invalid();
          return current.attachmentId;
        }
        current.attachmentId = metadata.id;
        current.attachmentMetadata = { id: metadata.id, ...publicMetadata(item.artifact) };
        delete current.uploadError;
        return metadata.id;
      });
    }
    // Authorization and input revision may have changed while upload was in flight.
    paused = await gate(); if (paused) return paused;
    const latest = await transaction(data => {
      const current = data.outbox?.[item.key];
      if (!current || identity(current) !== fingerprint || current.attachmentId !== attachmentId || !sameMetadata(current.attachmentMetadata, item.artifact)) throw invalid();
      return { text: current.text, clientId: current.clientId, conversationId: current.event.conversation_id };
    });
    const message = await api.request(`/api/conversations/${encodeURIComponent(latest.conversationId)}/messages`, {
      text: latest.text, attachment_id: attachmentId, client_id: latest.clientId
    });
    return { attachmentId, message };
  } catch (error) {
    if (error?.code === 'TRIAGE_ARTIFACT_INVALID') return { paused: true, verdict: 'pause', error: '报告文件校验失败，已暂停发送。' };
    const status = error?.status ?? Number(/HTTP\s+(\d{3})/.exec(String(error?.message ?? ''))?.[1]);
    throw serverError(Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : undefined);
  }
}
