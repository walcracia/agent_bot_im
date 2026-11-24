import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectTriageInputs, collectEvidence, logType, parserHints, buildModelPayload, validateModelReport, renderReport, redact, reportHash } from './triage-report.mjs';
import { validateExecutionProof, validateExecutionUsage } from './skill-execution.mjs';

export { inspectTriageInputs } from './triage-report.mjs';
export const SKILL_ARCHIVE_SHA256 = '3be41e8de6d60ace8f22c99469854023bc8ed4622d212998eea2be9b5f057e17';
const SKILL_FILES_DIGEST = '02bfa88c2871a8f748f4a52647075c505ccb7e5fe88765ada5a839aca4319ad5';
const EXTRACTOR = fileURLToPath(new URL('./triage-extract.py', import.meta.url));
const DEFAULTS = Object.freeze({ maxAttachments: 8, maxFileBytes: 99999999, maxDownloadBytes: 160000000, downloadTimeoutMs: 0,
  maxExpandedBytes: 320000000, maxExpandedFileBytes: 64000000, maxExtractedFiles: 800, maxArchiveDepth: 3, maxCompressionRatio: 150,
  parserTimeoutMs: 0, extractionTimeoutMs: 0, runTimeoutMs: 0, maxProcessOutputBytes: 0,
  maxScanLines: 0, maxScanCharacters: 0, maxEvidenceCandidates: 1200, maxEvidence: 60, maxLineCharacters: 600,
  maxInputCharacters: 48000, maxReportCharacters: 24000, terminationGraceMs: 4000 });
const digest = value => createHash('sha256').update(value).digest('hex');
const contained = (root, path) => { const rest = relative(root, path); return rest && !isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + sep); };
async function readOnlyCall(promise, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('Aborted'));
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
async function executionArtifacts(service, result, fallbackRoot, validated, payload, text) {
  const proof = validateExecutionProof(result.execution, result.execution?.backend);
  const expectedText = renderReport(validated, payload, proof.usage, result.sourceReport);
  if (text.trimEnd() !== expectedText.trimEnd()) throw new Error('Rendered report differs from the verified execution usage.');
  if (!proof || !['dsh', 'pi', 'hermes', 'opencode'].includes(proof.backend) || proof.agentSessions !== 1 || proof.skillLoaded !== true
    || proof.proofValidated !== true || !Number.isSafeInteger(proof.providerRequests) || proof.providerRequests < 1
    || !Number.isSafeInteger(proof.toolCalls) || proof.toolCalls < (proof.recipe === 'chery-qa-plugin' ? 0 : 1))
    throw new Error('Skill execution proof is missing or outside its budget.');
  if (!Array.isArray(result.files) || result.files.length !== 2 || new Set(result.files.map(item => item?.name)).size !== 2)
    throw new Error('Skill execution must return its two validated report files.');
  const root = await realpath(service.root ?? fallbackRoot), files = [];
  for (const file of result.files) {
    if (!file || !['report.json', '报告.txt'].includes(file.name) || file.mime !== (file.name === 'report.json' ? 'application/json' : 'text/plain')
      || !Number.isSafeInteger(file.size) || file.size < 1 || file.size >= 100000000 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')
      || typeof file.pathPrivate !== 'string' || !isAbsolute(file.pathPrivate) || !contained(root, resolve(file.pathPrivate)))
      throw new Error('Skill report artifact metadata is invalid.');
    const name = relative(root, resolve(file.pathPrivate)).split(sep).join('/');
    const path = await independentFile(root, name);
    if ((await lstat(path)).size !== file.size) throw new Error('Skill report artifact size changed.');
    const bytes = await readFile(path);
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error('Skill report artifact bytes changed.');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (redact(content) !== content) throw new Error('Skill report artifact contains unsanitized sensitive text.');
    if (file.name === 'report.json') {
      if (JSON.stringify(validateModelReport(JSON.parse(content), payload)) !== JSON.stringify(validated)) throw new Error('JSON artifact differs from the validated report.');
    } else if (content.trimEnd() !== expectedText.trimEnd()) throw new Error('Text artifact differs from the validated report.');
    files.push({ name: file.name, mime: file.mime, size: file.size, sha256: file.sha256, pathPrivate: path });
  }
  return { files, execution: { backend: proof.backend, agentSessions: 1, providerRequests: proof.providerRequests, toolCalls: proof.toolCalls,
    skillLoaded: true, proofValidated: true, ...(proof.recipe ? { recipe: proof.recipe } : {}), ...(proof.usage ? { usage: proof.usage } : {}) } };
}

export class TriageWorkerError extends Error {
  constructor(message, { kind = 'failed', phase = 'prepare', modelStarted = false, processTreeStopped = true, cause } = {}) {
    super(message, { cause }); this.name = 'TriageWorkerError'; Object.assign(this, { kind, phase, modelStarted, processTreeStopped });
  }
}

const diagnosticText = value => redact(String(value ?? '').replace(/\b(?:https?|wss?):\/\/[^\s<>"'`]+/giu, '[地址已隐藏]')).slice(0, 2000);
const errorCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/u.test(value) ? value : undefined;
function errorChain(cause) {
  const seen = new Set(), chain = [];
  while (cause && !seen.has(cause) && chain.length < 8) {
    seen.add(cause);
    chain.push({ name: diagnosticText(cause.name || 'Error'), message: diagnosticText(cause.message ?? cause),
      ...(errorCode(cause.code) ? { code: cause.code } : {}) });
    cause = cause.cause;
  }
  return chain;
}
function downloadCode(cause, attachment) {
  if (String(cause.code ?? '').startsWith('TRIAGE_DOWNLOAD_')) return cause.code;
  if (cause.kind === 'download-timeout') return 'TRIAGE_DOWNLOAD_TIMEOUT';
  const codes = errorChain(cause).map(item => item.code);
  if (codes.some(code => /^(?:UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|E(?:CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH|NETUNREACH|NOTFOUND))$/u.test(code ?? '')))
    return 'TRIAGE_DOWNLOAD_NETWORK';
  if (codes.some(code => ['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(code))) return 'TRIAGE_DOWNLOAD_STORAGE';
  return attachment?.stage === 'metadata' ? 'TRIAGE_DOWNLOAD_METADATA' : 'TRIAGE_DOWNLOAD_FAILED';
}
function attachmentFailure(code, message, status) {
  return Object.assign(new Error(message), { code, ...(Number.isInteger(status) ? { httpStatus: status } : {}) });
}

function limitsFor(input = {}) {
  const limits = { ...DEFAULTS, ...input };
  for (const [key, value] of Object.entries(limits)) if (!(key in DEFAULTS) || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid log-triage limit ${key}.`);
  return limits;
}
async function independentFile(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid trusted skill path.');
  const path = resolve(root, name);
  if (!contained(root, path)) throw new Error('Trusted skill file escaped root.');
  let cursor = root;
  for (const part of name.split('/')) { cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Trusted skill paths cannot be links.'); }
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || !contained(root, await realpath(path))) throw new Error('Trusted skill file is not independent.');
  return path;
}
export async function verifySkill(directory) {
  if (!isAbsolute(directory) || (await lstat(directory)).isSymbolicLink()) throw new Error('Skill root must be an absolute regular directory.');
  const root = await realpath(directory);
  const integrity = JSON.parse(await readFile(await independentFile(root, 'integrity.json'), 'utf8'));
  if (integrity.version !== '1.3.2' || integrity.archiveSha256 !== SKILL_ARCHIVE_SHA256 || !integrity.files || Array.isArray(integrity.files)
    || Object.keys(integrity.files).length !== 24) throw new Error('Pinned skill manifest is invalid.');
  const files = Object.fromEntries(Object.entries(integrity.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  if (digest(JSON.stringify(files)) !== SKILL_FILES_DIGEST) throw new Error('Pinned skill manifest digest changed.');
  for (const [name, hash] of Object.entries(files)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || digest(await readFile(await independentFile(root, name))) !== hash) throw new Error('Pinned skill file digest changed.');
  }
  const boundary = JSON.parse(await readFile(await independentFile(root, 'package.json'), 'utf8'));
  if (Object.keys(boundary).length !== 1 || boundary.type !== 'commonjs') throw new Error('Skill module boundary is invalid.');
  const rules = await Promise.all(['SKILL.md', 'references/time-alignment.md', 'references/verdict-guide.md'].map(name => readFile(join(root, name), 'utf8')));
  return { root, parser: join(root, 'scripts', 'triage.js'), rules: rules.join('\n\n') };
}

/** Execute only trusted parser/helper argv. It never executes a command from a log or model. */
async function processJSON(executable, args, { cwd, timeoutMs, maxBytes, signal, phase, graceMs }) {
  signal?.throwIfAborted();
  return await new Promise((resolveResult, reject) => {
    const env = { PATH: process.env.PATH ?? '', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' };
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
    let child;
    try { child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env }); }
    catch (cause) { reject(new TriageWorkerError('解析进程未能启动。', { kind: 'parser-start', phase, cause })); return; }
    let stdout = [], bytes = 0, error = null, closed = false, settled = false, termination;
    const finish = (failure, result) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(termination); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure); else resolveResult(result);
    };
    const stop = failure => {
      error ??= failure;
      if (closed) return;
      child.kill();
      termination ??= setTimeout(() => finish(new TriageWorkerError('无法确认解析进程已结束，请核查后继续。', {
        kind: 'termination-unconfirmed', phase, processTreeStopped: false, cause: error })), graceMs);
      termination.unref?.();
    };
    const abort = () => stop(new TriageWorkerError('日志分析已停止。', { kind: signal?.reason?.kind ?? 'cancelled', phase }));
    const timer = timeoutMs > 0 ? setTimeout(() => stop(new TriageWorkerError('解析超过时间预算。', { kind: 'parser-timeout', phase })), timeoutMs) : null;
    timer?.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (maxBytes > 0 && bytes > maxBytes) stop(new TriageWorkerError('解析输出超过预算。', { kind: 'parser-output-limit', phase }));
      else stdout.push(chunk);
    });
    child.stderr.on('data', () => {}); // Do not expose a log line, URL or credential from parser diagnostics.
    child.once('error', cause => { error = new TriageWorkerError('解析进程未能启动。', { kind: 'parser-start', phase, cause }); });
    child.once('close', code => {
      closed = true;
      if (error) { error.processTreeStopped = true; finish(error); return; }
      if (code !== 0) { finish(new TriageWorkerError('日志解包或解析失败，未调用模型。', { kind: 'parser-failed', phase })); return; }
      try { finish(null, JSON.parse(Buffer.concat(stdout).toString('utf8'))); }
      catch (cause) { finish(new TriageWorkerError('解析输出格式不正确。', { kind: 'parser-json', phase, cause })); }
    });
    if (signal?.aborted) abort();
  });
}

/** Read-only preparation locates useful lines before evidence is frozen. It is
 * deliberately separate from the Agent's required skill/tool execution proof. */
async function prepareParserEvidence({ directory, extracted, files, skill, limits, signal }) {
  const types = ['ota', 'slave', 'qnx-uds', 'de', 'other'], queues = new Map(types.map(type => [type, []]));
  for (const file of files) {
    signal.throwIfAborted();
    if (!/\.(?:log(?:\.\d+)?|txt|json)$/iu.test(file.path) || file.bytes > 16000000) continue;
    const source = await independentFile(extracted, file.path), handle = await open(source, 'r');
    let head;
    try { const buffer = Buffer.alloc(8192), result = await handle.read(buffer, 0, buffer.length, 0); head = buffer.toString('utf8', 0, result.bytesRead); }
    finally { await handle.close(); }
    queues.get(logType(file.path, head)).push(file);
  }
  for (const queue of queues.values()) queue.sort((a, b) => a.path.localeCompare(b.path));
  const ordered = [];
  while (types.some(type => queues.get(type).length)) for (const type of types) if (queues.get(type).length) ordered.push(queues.get(type).shift());
  const batches = [];
  for (const file of ordered) {
    let batch = batches.at(-1);
    if (!batch || batch.files.length === 3 || batch.bytes + file.bytes > 16000000) {
      if (batches.length === 4) break;
      batches.push(batch = { files: [], bytes: 0, status: 'pending', findingCount: 0 });
    }
    batch.files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 }); batch.bytes += file.bytes;
  }
  const findings = [], limitations = [];
  for (const batch of batches) {
    signal.throwIfAborted();
    const stage = await mkdtemp(join(directory, 'preparation-'));
    for (const file of batch.files) {
      const source = await independentFile(extracted, file.path), target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await copyFile(source, target);
      if ((await lstat(target)).size !== file.bytes || digest(await readFile(target)) !== file.sha256) throw new Error('Preparation input hash changed.');
    }
    try {
      const parser = await processJSON(process.execPath, ['--max-old-space-size=512', skill.parser, stage, '--effort', 'low', '--json'], {
        cwd: stage, timeoutMs: limits.parserTimeoutMs, maxBytes: limits.maxProcessOutputBytes, signal, phase: 'preparation', graceMs: limits.terminationGraceMs });
      for (const finding of (Array.isArray(parser?.findings) ? parser.findings : []).slice(0, 1000 - findings.length)) {
        const evidence = [];
        for (const ref of (Array.isArray(finding?.evidence) ? finding.evidence : []).slice(0, 50)) {
          if (typeof ref?.file !== 'string' || !Number.isSafeInteger(ref.line) || ref.line < 1) continue;
          const name = relative(stage, resolve(stage, ref.file)).split(sep).join('/');
          if (batch.files.some(file => file.path === name)) evidence.push({ file: join(extracted, name), line: ref.line });
        }
        if (evidence.length) { findings.push({ summary: redact(finding.summary ?? '').slice(0, 300), evidence }); batch.findingCount++; }
      }
      batch.status = 'completed';
    } catch (cause) {
      if (signal.aborted || cause.processTreeStopped !== true) throw cause;
      batch.status = 'failed'; batch.failure = cause.kind;
      limitations.push('部分日志的取证解析未完成，仍需结合已取得的原始记录核对。');
    }
  }
  const selected = batches.reduce((sum, batch) => sum + batch.files.length, 0);
  return { findings, limitations: [...new Set(limitations)], manifest: { kind: 'read-only-evidence', agentProof: false, coverage: 'partial',
    parserBatches: batches, selectedFiles: selected, omittedFiles: files.length - selected, findingCount: findings.length } };
}

export class LogTriageWorker {
  constructor({ adapter, root, skillRoot, model, executionService, limits, now = () => new Date().toISOString(), python, downloadOrigins = [], fetch: fetcher = globalThis.fetch,
    verifySkill: skillVerifier = verifySkill }) {
    if (!isAbsolute(root) || !isAbsolute(skillRoot) || !isAbsolute(python)) throw new Error('Triage root, skillRoot and Python must be absolute trusted paths.');
    this.adapter = adapter; this.root = resolve(root); this.skillRoot = resolve(skillRoot); this.model = model; this.executionService = executionService; this.python = python;
    this.limits = limitsFor(limits); this.now = now; this.fetch = fetcher; this.verifySkill = skillVerifier;
    this.origins = new Set(downloadOrigins.map(value => {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.origin !== value || url.search || url.hash) throw new Error('Download origins must be exact trusted HTTP(S) origins.');
      return value;
    }));
  }
  async run(snapshot, { signal, beforeModel } = {}) {
    let phase = 'prepare', modelStarted = false, modelSettled = false, directory;
    const downloads = [];
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const timer = this.limits.runTimeoutMs > 0 ? setTimeout(() => abort.abort(new TriageWorkerError('分析超过总时间预算。', { kind: 'timeout' })), this.limits.runTimeoutMs) : null;
    timer?.unref?.();
    const waiting = (status, text, manifest = {}) => ({ status, text, report: null, manifest, inputRevision: snapshot.inputRevision, modelCalls: 0 });
    try {
      combined.throwIfAborted();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(snapshot.id ?? '') || !Number.isSafeInteger(snapshot.inputRevision) || snapshot.inputRevision < 1)
        throw new Error('Task identity or input revision is invalid.');
      const input = inspectTriageInputs(snapshot);
      if (input.status !== 'ready') return waiting(input.status, input.text);
      if (input.fileIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(input.fileIds).size !== input.fileIds.length)
        throw new Error('Invalid or excessive attachment IDs.');
      if (!this.origins.size) throw new Error('No trusted download origins configured.');
      const skill = await this.verifySkill(this.skillRoot);
      if ((await lstat(this.root).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; }))?.isSymbolicLink()) throw new Error('Triage root cannot be a link.');
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      directory = join(await realpath(this.root), `${snapshot.id}-r${snapshot.inputRevision}-${randomUUID()}`);
      await mkdir(directory, { mode: 0o700 });
      const inputs = [], attachments = []; let downloaded = 0;
      phase = 'download';
      for (let index = 0; index < input.fileIds.length; index++) {
        combined.throwIfAborted();
        const download = { attachmentIndex: index + 1, attachmentId: String(input.fileIds[index]), stage: 'metadata', receivedBytes: 0 };
        downloads.push(download);
        const metadata = await readOnlyCall(this.adapter.getFile(input.fileIds[index]), combined);
        download.stage = 'validate-metadata';
        if (Number.isSafeInteger(metadata.size) && metadata.size >= 0) download.expectedBytes = metadata.size;
        download.md5Provided = typeof metadata.md5 === 'string';
        let url = new URL(metadata.url);
        if (!this.origins.has(url.origin) || url.username || url.password || url.hash) throw attachmentFailure('TRIAGE_DOWNLOAD_SOURCE', 'Attachment URL is outside trusted origins.');
        const originalOrigin = url.origin;
        if (Number.isFinite(metadata.size) && metadata.size < 0) throw attachmentFailure('TRIAGE_DOWNLOAD_METADATA', 'Attachment metadata size is invalid.');
        const name = String(metadata.name || `log-${index + 1}.txt`).replaceAll('\\', '/').split('/').at(-1);
        if (!name || name.length > 180 || /[\0\r\n:]/.test(name)) throw attachmentFailure('TRIAGE_DOWNLOAD_METADATA', 'Attachment file name is invalid.');
        const file = join(directory, `download-${index + 1}`);
        const requestAbort = new AbortController();
        const requestTimer = this.limits.downloadTimeoutMs > 0 ? setTimeout(() => requestAbort.abort(new TriageWorkerError('附件下载超时。', { kind: 'download-timeout', phase: 'download' })), this.limits.downloadTimeoutMs) : null;
        requestTimer?.unref?.();
        const requestSignal = AbortSignal.any([combined, requestAbort.signal]);
        let handle;
        try {
          let response;
          for (let redirect = 0; redirect <= 2; redirect++) {
            download.stage = 'request';
            response = await this.fetch(url, { redirect: 'manual', signal: requestSignal, credentials: 'omit' });
            download.httpStatus = response.status;
            if (response.status >= 300 && response.status < 400) {
              await response.body?.cancel();
              const location = response.headers.get('location');
              if (!location || redirect === 2) throw attachmentFailure('TRIAGE_DOWNLOAD_SOURCE', 'Attachment redirect is invalid.');
              url = new URL(location, url);
              if (url.origin !== originalOrigin || !this.origins.has(url.origin) || url.username || url.password || url.hash) throw attachmentFailure('TRIAGE_DOWNLOAD_SOURCE', 'Cross-origin attachment redirect refused.');
            } else break;
          }
          if (!response.ok || !response.body) { await response.body?.cancel(); throw attachmentFailure('TRIAGE_DOWNLOAD_HTTP', 'Attachment download failed.', response.status); }
          const declared = response.headers.get('content-length');
          if (declared && !/^\d+$/.test(declared)) {
            await response.body.cancel(); throw attachmentFailure('TRIAGE_DOWNLOAD_METADATA', 'Attachment Content-Length is invalid.');
          }
          download.stage = 'storage';
          handle = await open(file, 'wx', 0o600);
          let bytes = 0; const hash = createHash('sha256'), md5 = createHash('md5');
          const exactSize = Number.isSafeInteger(metadata.size) && metadata.size >= 0;
          const expectedMd5 = typeof metadata.md5 === 'string' && /^[a-f0-9]{32}$/iu.test(metadata.md5) ? metadata.md5.toLowerCase() : null;
          let actualMD5, verifiedMetadata = false;
          download.stage = 'stream';
          if (exactSize && metadata.size === 0 && expectedMd5) {
            actualMD5 = md5.digest('hex');
            if (actualMD5 !== expectedMd5) throw attachmentFailure('TRIAGE_DOWNLOAD_INTEGRITY', 'Attachment MD5 mismatch.');
            verifiedMetadata = true; await response.body.cancel();
          } else for await (const chunk of response.body) {
            combined.throwIfAborted(); bytes += chunk.length; downloaded += chunk.length; download.receivedBytes = bytes;
            if (exactSize && bytes > metadata.size) throw attachmentFailure('TRIAGE_DOWNLOAD_INTEGRITY', 'Attachment metadata size mismatch.');
            await handle.writeFile(chunk); hash.update(chunk); md5.update(chunk);
            // A complete size+MD5-verified file does not depend on a proxy or
            // server closing its chunked response. Breaking cancels the stream.
            // Without both metadata fields, the ordinary EOF path still applies.
            if (exactSize && expectedMd5 && bytes === metadata.size) {
              actualMD5 = md5.digest('hex');
              if (actualMD5 !== expectedMd5) throw attachmentFailure('TRIAGE_DOWNLOAD_INTEGRITY', 'Attachment MD5 mismatch.');
              verifiedMetadata = true; break;
            }
          }
          download.stage = 'integrity';
          if (exactSize && metadata.size !== bytes) throw attachmentFailure('TRIAGE_DOWNLOAD_INTEGRITY', 'Attachment metadata size mismatch.');
          actualMD5 ??= md5.digest('hex');
          if (metadata.md5 && (!expectedMd5 || actualMD5 !== expectedMd5)) throw attachmentFailure('TRIAGE_DOWNLOAD_INTEGRITY', 'Attachment MD5 mismatch.');
          download.stage = 'completed'; download.completion = verifiedMetadata ? 'metadata-size-md5' : 'http-eof';
          download.md5Verified = Boolean(expectedMd5);
          attachments.push({ id: input.fileIds[index], name: redact(name), bytes, sha256: hash.digest('hex') });
          inputs.push({ path: file, name });
        } catch (cause) {
          if (requestAbort.signal.aborted && !combined.aborted) throw requestAbort.signal.reason;
          throw cause;
        } finally { clearTimeout(requestTimer); await handle?.close(); }
      }
      await writeFile(join(directory, 'downloads.json'), JSON.stringify({ taskId: snapshot.id, inputRevision: snapshot.inputRevision, downloads }, null, 2), { flag: 'wx', mode: 0o600, flush: true });
      const manifest = { inputRevision: snapshot.inputRevision, skillVersion: '1.3.2', parserBaseline: 'log-analyzer v2.19.0',
        skillArchiveSha256: SKILL_ARCHIVE_SHA256, mode: input.window.mode, window: input.window, attachments, createdAt: this.now() };
      const extracted = join(directory, 'logs');
      const requestPath = join(directory, 'extract.json');
      await writeFile(requestPath, JSON.stringify({ inputs, output: extracted, limits: this.limits }), { flag: 'wx', mode: 0o600 });
      phase = 'extract';
      const extraction = await processJSON(this.python, [EXTRACTOR, '--request', requestPath], { cwd: directory, timeoutMs: this.limits.extractionTimeoutMs,
        maxBytes: this.limits.maxProcessOutputBytes, signal: combined, phase, graceMs: this.limits.terminationGraceMs });
      manifest.files = extraction.files; manifest.expandedBytes = extraction.expandedBytes;
      const pluginRecipe = this.executionService?.runner?.recipe === 'chery-qa-plugin';
      let preparation = null;
      if (this.executionService && !pluginRecipe) {
        phase = 'preparation';
        preparation = await prepareParserEvidence({ directory, extracted, files: extraction.files, skill, limits: this.limits, signal: combined });
        manifest.preparation = preparation.manifest;
      }
      phase = 'evidence';
      const collected = pluginRecipe ? { recognized: extraction.files.length, evidence: [], limitations: [] }
        : await collectEvidence({ directory: extracted, files: extraction.files, window: input.window,
          clockDomains: snapshot.clockDomains, limits: this.limits, signal: combined, parserFindings: preparation?.findings ?? [] });
      manifest.mode = !collected.recognized || !collected.evidence.length || input.window.mode === 'preliminary'
        || collected.evidence.some(item => !item.aligned) ? 'preliminary' : 'windowed';
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
      if (!collected.recognized || !pluginRecipe && !collected.evidence.length) {
        manifest.mode = 'preliminary';
        const payload = buildModelPayload({ snapshot, window: { ...input.window, mode: 'preliminary' }, evidence: [], parserSummary: [], rules: '',
          limitations: [...input.limitations, ...collected.limitations, '没有可提供模型复核的实际证据，本次为零模型规则初排。'], maxCharacters: this.limits.maxInputCharacters });
        const basic = { conclusion: collected.recognized ? '所选范围内未取得可定位的日志证据，初排未能确认明确异常；这不代表系统没有故障。'
          : '附件中未识别到可分析的文本日志，暂时无法确认异常或根因。', confidence: 'low', responsibility: '待验证', evidence: [], timeline: [],
          alternatives: ['日志类型、日志覆盖范围或时间设置可能不足。'], nextSteps: ['可补充相应文本日志或核对时间范围后重新分析。'], limitations: payload.limitations };
        const report = { ...basic, mode: 'preliminary', inputRevision: snapshot.inputRevision, window: input.window, evidenceIndex: [], manifestHash: reportHash(manifest) };
        const text = renderReport(basic, payload);
        await writeFile(join(directory, 'report.json'), JSON.stringify({ text, report, manifest }, null, 2), { flag: 'wx', mode: 0o600 });
        return { status: 'completed', text, report, manifest, inputRevision: snapshot.inputRevision, modelCalls: 0 };
      }
      if (typeof this.executionService?.execute !== 'function' && typeof this.model !== 'function') throw new Error('A skill execution service is not configured.');
      const limitations = [...input.limitations, ...collected.limitations, ...(preparation?.limitations ?? [])];
      let parserSummary = [];
      if (pluginRecipe) {
        manifest.preparation = { kind: 'chery-qa-plugin', coverage: 'whole-target', agentProof: false };
      } else if (this.executionService) {
        parserSummary = parserHints({ findings: preparation.findings }, collected.evidence);
        limitations.push('本次按日志类型选取部分记录核对，再由助手选择有限日志解析；未覆盖全部材料。');
      } else {
        // Legacy model-only compatibility keeps the fixed pre-parser. Production skill
        // execution selects its bounded parser inputs through the controlled Agent tool.
        phase = 'parser';
        const parser = await processJSON(process.execPath, ['--max-old-space-size=512', skill.parser, extracted, '--effort', 'low', '--json'], {
          cwd: directory, timeoutMs: this.limits.parserTimeoutMs, maxBytes: this.limits.maxProcessOutputBytes,
          signal: combined, phase, graceMs: this.limits.terminationGraceMs });
        parserSummary = parserHints(parser, collected.evidence);
      }
      const payload = buildModelPayload({ snapshot, window: input.window, evidence: collected.evidence, parserSummary,
        rules: skill.rules, limitations, maxCharacters: this.limits.maxInputCharacters });
      manifest.mode = payload.mode;
      const artifactDirectory = join(directory, 'artifacts');
      await mkdir(artifactDirectory, { mode: 0o700 });
      combined.throwIfAborted();
      const admitModel = async () => {
        phase = 'before-model';
        combined.throwIfAborted();
        await beforeModel?.();
        combined.throwIfAborted();
        phase = 'model'; modelStarted = true;
      };
      if (this.executionService) phase = 'service-validation';
      else await admitModel();
      let termination;
      const onAbort = () => { termination = setTimeout(() => rejectAbort(new TriageWorkerError(modelStarted ? '模型中断后的终态未确认，请核查后继续。' : '日志分析已停止。', {
        kind: modelStarted ? 'model-uncertain' : 'cancelled', phase, modelStarted, processTreeStopped: !modelStarted })), this.limits.terminationGraceMs); termination.unref?.(); };
      let rejectAbort;
      const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
      combined.addEventListener('abort', onAbort, { once: true });
      let raw, executionResult = null;
      try {
        const invoke = () => this.executionService ? this.executionService.execute({
          taskId: snapshot.id, inputRevision: snapshot.inputRevision, skillId: 'ota-log-triage@1.3.2',
          parameters: { mode: payload.mode, window: input.window, clockDomains: snapshot.clockDomains ?? {},
            ...(snapshot.descriptionOverride ? { symptom: redact(snapshot.descriptionOverride) } : {}) },
          inputFiles: extraction.files, executionContext: { directory: extracted, outputDirectory: artifactDirectory, skillRoot: this.skillRoot, payload }
        }, { signal: combined, beforeExecute: admitModel }) : this.model(payload, { signal: combined });
        raw = await Promise.race([Promise.resolve().then(invoke), aborted]);
        modelSettled = true;
      } finally { combined.removeEventListener('abort', onAbort); clearTimeout(termination); }
      combined.throwIfAborted();
      phase = 'report';
      if (this.executionService) {
        if (!modelStarted) throw new Error('Skill execution skipped its pre-execution admission guard.');
        executionResult = raw;
        if (!executionResult || typeof executionResult !== 'object' || !Object.hasOwn(executionResult, 'result')) throw new Error('Skill execution result is invalid.');
        if (executionResult.status !== undefined && !['completed', 'partial'].includes(executionResult.status)) throw new Error('Skill execution status is invalid.');
        raw = executionResult.result;
        if (executionResult.evidence !== undefined) {
          if (!Array.isArray(executionResult.evidence)) throw new Error('Skill evidence catalog is invalid.');
          payload.evidence = executionResult.evidence;
        }
      }
      const validated = validateModelReport(raw, payload);
      const sourceReport = executionResult?.sourceReport;
      const text = renderReport(validated, payload, validateExecutionUsage(executionResult?.execution?.usage), sourceReport);
      const { files, execution } = executionResult ? await executionArtifacts(this.executionService, executionResult, artifactDirectory, validated, payload, text)
        : { files: [], execution: null };
      if (execution) {
        manifest.outputs = files.map(({ pathPrivate, ...file }) => file); manifest.execution = execution;
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      }
      const report = { ...validated, mode: payload.mode, inputRevision: snapshot.inputRevision, window: input.window, evidenceIndex: payload.evidence, manifestHash: reportHash(manifest),
        ...(sourceReport === undefined ? {} : { sourceReport }) };
      const status = executionResult?.status === 'partial' ? 'partial' : 'completed';
      await writeFile(join(directory, 'report.json'), JSON.stringify({ status, text, report, manifest, files, execution }, null, 2), { flag: 'wx', mode: 0o600 });
      return { status, text, report, manifest, files, execution, inputRevision: snapshot.inputRevision, modelCalls: 1 };
    } catch (cause) {
      let error;
      if (cause instanceof TriageWorkerError) {
        if (cause === combined.reason) cause.phase = phase;
        cause.modelStarted ||= modelStarted;
        if (modelStarted && !modelSettled) cause.processTreeStopped = cause !== combined.reason && cause.kind !== 'model-uncertain' && cause.processTreeStopped === true;
        error = cause;
      } else {
        error = new TriageWorkerError('日志分析未完成，已有材料保留供核查。', { kind: combined.aborted ? 'cancelled' : cause?.kind ?? 'failed', phase,
          modelStarted, processTreeStopped: !modelStarted || modelSettled || cause?.processTreeStopped === true, cause });
        if (errorCode(cause?.code)) error.code = cause.code;
        if (cause?.usage) error.usage = validateExecutionUsage(cause.usage);
      }
      if (phase === 'download' && !combined.aborted) error.code = downloadCode(cause, downloads.at(-1));
      if (Number.isInteger(cause?.httpStatus)) error.httpStatus = cause.httpStatus;
      if (directory) {
        const receiptPath = join(directory, 'failure.json');
        try {
          await writeFile(receiptPath, JSON.stringify({ taskId: snapshot.id, attempt: snapshot.attempt ?? null, inputRevision: snapshot.inputRevision,
            at: this.now(), phase: error.phase, kind: error.kind, code: errorCode(error.code) ?? null, modelStarted: error.modelStarted,
            processTreeStopped: error.processTreeStopped, downloads, causes: errorChain(error) }, null, 2), { flag: 'wx', mode: 0o600, flush: true });
          error.failureReceiptPath = receiptPath;
        } catch { /* Preserve the original failure if local diagnostics cannot be written. */ }
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
}
