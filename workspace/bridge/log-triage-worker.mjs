import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectTriageInputs, collectEvidence, parserHints, buildModelPayload, validateModelReport, renderReport, redact, reportHash } from './triage-report.mjs';

export { inspectTriageInputs } from './triage-report.mjs';
export const SKILL_ARCHIVE_SHA256 = '3be41e8de6d60ace8f22c99469854023bc8ed4622d212998eea2be9b5f057e17';
const SKILL_FILES_DIGEST = '02bfa88c2871a8f748f4a52647075c505ccb7e5fe88765ada5a839aca4319ad5';
const EXTRACTOR = fileURLToPath(new URL('./triage-extract.py', import.meta.url));
const DEFAULTS = Object.freeze({ maxAttachments: 8, maxFileBytes: 99999999, maxDownloadBytes: 160000000, downloadTimeoutMs: 60000,
  maxExpandedBytes: 320000000, maxExpandedFileBytes: 64000000, maxExtractedFiles: 800, maxArchiveDepth: 3, maxCompressionRatio: 150,
  parserTimeoutMs: 60000, extractionTimeoutMs: 60000, runTimeoutMs: 900000, maxProcessOutputBytes: 2000000,
  maxScanLines: 200000, maxScanCharacters: 16000000, maxEvidenceCandidates: 1200, maxEvidence: 60, maxLineCharacters: 600,
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
  const proof = result.execution;
  if (!proof || !['dsh', 'pi', 'hermes', 'opencode'].includes(proof.backend) || proof.agentSessions !== 1 || proof.skillLoaded !== true
    || proof.proofValidated !== true || !Number.isSafeInteger(proof.providerRequests) || proof.providerRequests < 1 || proof.providerRequests > 32
    || !Number.isSafeInteger(proof.toolCalls) || proof.toolCalls < 3 || proof.toolCalls > 96)
    throw new Error('Skill execution proof is missing or outside its budget.');
  let executionLimits;
  if (proof.limits !== undefined) {
    const policy = proof.limits, hard = { modelRequests: 32, toolCalls: 96, inputCharacters: 384000, maxTokens: 8192 };
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || Object.keys(policy).sort().join('|') !== Object.keys(hard).sort().join('|')
      || Object.entries(hard).some(([key, max]) => !Number.isSafeInteger(policy[key]) || policy[key] < (key === 'toolCalls' ? 3 : 1) || policy[key] > max)
      || proof.providerRequests > policy.modelRequests || proof.toolCalls > policy.toolCalls)
      throw new Error('Skill execution proof exceeds its verified policy.');
    executionLimits = Object.fromEntries(Object.keys(hard).map(key => [key, policy[key]]));
  }
  if (!Array.isArray(result.files) || result.files.length !== 2 || new Set(result.files.map(item => item?.name)).size !== 2)
    throw new Error('Skill execution must return its two validated report files.');
  const root = await realpath(service.root ?? fallbackRoot), files = [];
  for (const file of result.files) {
    if (!file || !['report.json', '报告.txt'].includes(file.name) || file.mime !== (file.name === 'report.json' ? 'application/json' : 'text/plain')
      || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 2000000 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')
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
    } else if (content.trimEnd() !== text.trimEnd()) throw new Error('Text artifact differs from the validated report.');
    files.push({ name: file.name, mime: file.mime, size: file.size, sha256: file.sha256, pathPrivate: path });
  }
  return { files, execution: { backend: proof.backend, agentSessions: 1, providerRequests: proof.providerRequests, toolCalls: proof.toolCalls,
    skillLoaded: true, proofValidated: true, ...(executionLimits ? { limits: executionLimits } : {}) } };
}

export class TriageWorkerError extends Error {
  constructor(message, { kind = 'failed', phase = 'prepare', modelStarted = false, processTreeStopped = true, cause } = {}) {
    super(message, { cause }); this.name = 'TriageWorkerError'; Object.assign(this, { kind, phase, modelStarted, processTreeStopped });
  }
}

function limitsFor(input = {}) {
  const limits = { ...DEFAULTS, ...input };
  for (const [key, value] of Object.entries(limits)) if (!(key in DEFAULTS) || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid log-triage limit ${key}.`);
  if (limits.maxFileBytes >= 100000000 || limits.maxDownloadBytes > 500000000 || limits.maxExpandedBytes > 512000000
    || limits.maxExpandedFileBytes > limits.maxExpandedBytes || limits.maxExtractedFiles > 5000 || limits.maxArchiveDepth > 8
    || limits.maxInputCharacters > 100000 || limits.maxEvidence > 200 || limits.maxProcessOutputBytes > 8000000)
    throw new Error('Log-triage limits exceed supported bounds.');
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
    const timer = setTimeout(() => stop(new TriageWorkerError('解析超过时间预算。', { kind: 'parser-timeout', phase })), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(new TriageWorkerError('解析输出超过预算。', { kind: 'parser-output-limit', phase }));
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
    let phase = 'prepare', modelStarted = false, modelSettled = false;
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const timer = setTimeout(() => abort.abort(new TriageWorkerError('分析超过总时间预算。', { kind: 'timeout' })), this.limits.runTimeoutMs);
    timer.unref?.();
    const waiting = (status, text, manifest = {}) => ({ status, text, report: null, manifest, inputRevision: snapshot.inputRevision, modelCalls: 0 });
    try {
      combined.throwIfAborted();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(snapshot.id ?? '') || !Number.isSafeInteger(snapshot.inputRevision) || snapshot.inputRevision < 1)
        throw new Error('Task identity or input revision is invalid.');
      const input = inspectTriageInputs(snapshot);
      if (input.status !== 'ready') return waiting(input.status, input.text);
      if (input.fileIds.length > this.limits.maxAttachments || input.fileIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(input.fileIds).size !== input.fileIds.length)
        throw new Error('Invalid or excessive attachment IDs.');
      if (!this.origins.size) throw new Error('No trusted download origins configured.');
      const skill = await this.verifySkill(this.skillRoot);
      if ((await lstat(this.root).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; }))?.isSymbolicLink()) throw new Error('Triage root cannot be a link.');
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const directory = join(await realpath(this.root), `${snapshot.id}-r${snapshot.inputRevision}-${randomUUID()}`);
      await mkdir(directory, { mode: 0o700 });
      const inputs = [], attachments = []; let downloaded = 0;
      phase = 'download';
      for (let index = 0; index < input.fileIds.length; index++) {
        combined.throwIfAborted();
        const metadata = await readOnlyCall(this.adapter.getFile(input.fileIds[index]), combined);
        let url = new URL(metadata.url);
        if (!this.origins.has(url.origin) || url.username || url.password || url.hash) throw new Error('Attachment URL is outside trusted origins.');
        const originalOrigin = url.origin;
        if (Number.isFinite(metadata.size) && (metadata.size > this.limits.maxFileBytes || metadata.size < 0)) throw new Error('Attachment metadata size exceeds budget.');
        const name = String(metadata.name || `log-${index + 1}.txt`).replaceAll('\\', '/').split('/').at(-1);
        if (!name || name.length > 180 || /[\0\r\n:]/.test(name)) throw new Error('Attachment file name is invalid.');
        const file = join(directory, `download-${index + 1}`);
        const requestAbort = new AbortController();
        const requestTimer = setTimeout(() => requestAbort.abort(new TriageWorkerError('附件下载超时。', { kind: 'download-timeout' })), this.limits.downloadTimeoutMs);
        requestTimer.unref?.();
        const requestSignal = AbortSignal.any([combined, requestAbort.signal]);
        let handle;
        try {
          let response;
          for (let redirect = 0; redirect <= 2; redirect++) {
            response = await this.fetch(url, { redirect: 'manual', signal: requestSignal, credentials: 'omit' });
            if (response.status >= 300 && response.status < 400) {
              await response.body?.cancel();
              const location = response.headers.get('location');
              if (!location || redirect === 2) throw new Error('Attachment redirect is invalid.');
              url = new URL(location, url);
              if (url.origin !== originalOrigin || !this.origins.has(url.origin) || url.username || url.password || url.hash) throw new Error('Cross-origin attachment redirect refused.');
            } else break;
          }
          if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Attachment download failed.'); }
          const declared = response.headers.get('content-length');
          if (declared && (!/^\d+$/.test(declared) || Number(declared) > this.limits.maxFileBytes || Number(declared) + downloaded > this.limits.maxDownloadBytes)) {
            await response.body.cancel(); throw new Error('Declared download size exceeds budget.');
          }
          handle = await open(file, 'wx', 0o600);
          let bytes = 0; const hash = createHash('sha256'), md5 = createHash('md5');
          for await (const chunk of response.body) {
            combined.throwIfAborted(); bytes += chunk.length; downloaded += chunk.length;
            if (bytes > this.limits.maxFileBytes || downloaded > this.limits.maxDownloadBytes) throw new Error('Actual download size exceeds budget.');
            await handle.write(chunk); hash.update(chunk); md5.update(chunk);
          }
          if (Number.isSafeInteger(metadata.size) && metadata.size !== bytes) throw new Error('Attachment metadata size mismatch.');
          const actualMD5 = md5.digest('hex');
          if (metadata.md5 && (!/^[a-f0-9]{32}$/i.test(metadata.md5) || actualMD5 !== metadata.md5.toLowerCase())) throw new Error('Attachment MD5 mismatch.');
          attachments.push({ id: input.fileIds[index], name: redact(name), bytes, sha256: hash.digest('hex') });
          inputs.push({ path: file, name });
        } finally { clearTimeout(requestTimer); await handle?.close(); }
      }
      const manifest = { inputRevision: snapshot.inputRevision, skillVersion: '1.3.2', parserBaseline: 'log-analyzer v2.19.0',
        skillArchiveSha256: SKILL_ARCHIVE_SHA256, mode: input.window.mode, window: input.window, attachments, createdAt: this.now() };
      const extracted = join(directory, 'logs');
      const requestPath = join(directory, 'extract.json');
      await writeFile(requestPath, JSON.stringify({ inputs, output: extracted, limits: this.limits }), { flag: 'wx', mode: 0o600 });
      phase = 'extract';
      const extraction = await processJSON(this.python, [EXTRACTOR, '--request', requestPath], { cwd: directory, timeoutMs: this.limits.extractionTimeoutMs,
        maxBytes: this.limits.maxProcessOutputBytes, signal: combined, phase, graceMs: this.limits.terminationGraceMs });
      manifest.files = extraction.files; manifest.expandedBytes = extraction.expandedBytes;
      phase = 'evidence';
      const collected = await collectEvidence({ directory: extracted, files: extraction.files, window: input.window,
        clockDomains: snapshot.clockDomains, limits: this.limits, signal: combined });
      manifest.mode = !collected.recognized || !collected.evidence.length || input.window.mode === 'preliminary'
        || collected.evidence.some(item => !item.aligned) ? 'preliminary' : 'windowed';
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
      if (!collected.recognized || !collected.evidence.length) {
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
      const limitations = [...input.limitations, ...collected.limitations];
      let parserSummary = [];
      if (this.executionService) {
        limitations.push('本次先提取部分日志线索，再由助手选择有限日志解析；未覆盖全部材料。');
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
          parameters: { mode: payload.mode, window: input.window, clockDomains: snapshot.clockDomains ?? {} },
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
      }
      const validated = validateModelReport(raw, payload);
      if (payload.mode === 'preliminary') { validated.confidence = 'low'; validated.responsibility = '待验证'; }
      const text = renderReport(validated, payload);
      if (text.length > this.limits.maxReportCharacters) throw new Error('Rendered report exceeds budget.');
      const { files, execution } = executionResult ? await executionArtifacts(this.executionService, executionResult, artifactDirectory, validated, payload, text)
        : { files: [], execution: null };
      if (execution) {
        manifest.outputs = files.map(({ pathPrivate, ...file }) => file); manifest.execution = execution;
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      }
      const report = { ...validated, mode: payload.mode, inputRevision: snapshot.inputRevision, window: input.window, evidenceIndex: payload.evidence, manifestHash: reportHash(manifest) };
      const status = executionResult?.status === 'partial' ? 'partial' : 'completed';
      await writeFile(join(directory, 'report.json'), JSON.stringify({ status, text, report, manifest, files, execution }, null, 2), { flag: 'wx', mode: 0o600 });
      return { status, text, report, manifest, files, execution, inputRevision: snapshot.inputRevision, modelCalls: 1 };
    } catch (cause) {
      if (cause instanceof TriageWorkerError) {
        if (cause === combined.reason) cause.phase = phase;
        cause.modelStarted ||= modelStarted;
        if (modelStarted && !modelSettled) cause.processTreeStopped = cause !== combined.reason && cause.kind !== 'model-uncertain' && cause.processTreeStopped === true;
        throw cause;
      }
      const error = new TriageWorkerError('日志分析未完成，已有材料保留供核查。', { kind: combined.aborted ? 'cancelled' : cause?.kind ?? 'failed', phase,
        modelStarted, processTreeStopped: !modelStarted || modelSettled || cause?.processTreeStopped === true, cause });
      if (/^[A-Z][A-Z0-9_]{2,100}$/.test(cause?.code ?? '')) error.code = cause.code;
      throw error;
    } finally { clearTimeout(timer); }
  }
}
