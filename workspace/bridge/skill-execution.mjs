import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateModelReport, renderReport, redact } from './triage-report.mjs';

export const TRIAGE_SKILL_ID = 'ota-log-triage@1.3.2';
const BACKENDS = new Set(['dsh', 'pi', 'hermes', 'opencode']);
const LIMITS = Object.freeze({ files: 800, fileBytes: 64000000, totalBytes: 320000000, payloadCharacters: 100000,
  parameterCharacters: 16000, reportBytes: 200000, evidence: 200, scanLines: 2000000, scanCharacters: 320000000 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const contained = (root, path) => { const rest = relative(root, path); return rest && !isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + sep); };
const equalIdentity = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; };
function failure(code, { modelStarted = false, processTreeStopped = true, cause } = {}) {
  return Object.assign(new Error(code, { cause }), { code, kind: 'skill-execution', modelStarted, processTreeStopped });
}
function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.length > 800 || value.includes('\\') || /[:\0\r\n]/u.test(value) || isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw failure('SKILL_INPUT_PATH_INVALID');
  return value;
}
async function directoryPath(root, target, { mayCreate = false } = {}) {
  if (typeof target !== 'string' || !isAbsolute(target) || /[\0\r\n]/u.test(target) || !contained(root, resolve(target))) throw failure('SKILL_DIRECTORY_SCOPE');
  let current = root;
  for (const part of relative(root, resolve(target)).split(sep)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); } catch (cause) {
      if (cause.code !== 'ENOENT' || !mayCreate) throw failure('SKILL_DIRECTORY_MISSING');
      await mkdir(current, { mode: 0o700 }); info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('SKILL_DIRECTORY_LINK');
  }
  const canonical = await realpath(current);
  if (!contained(root, canonical)) throw failure('SKILL_DIRECTORY_SCOPE');
  return canonical;
}
async function safeFile(directory, descriptor, signal) {
  const name = relativeFile(descriptor.path), path = resolve(directory, name);
  if (!contained(directory, path)) throw failure('SKILL_INPUT_PATH_INVALID');
  let current = directory;
  for (const part of name.split('/')) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw failure('SKILL_INPUT_LINK');
  }
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(descriptor.bytes) || !contained(directory, await realpath(path))) throw failure('SKILL_INPUT_CHANGED');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!equalIdentity(before, opened)) throw failure('SKILL_INPUT_CHANGED');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let bytes = 0;
    while (true) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > descriptor.bytes || bytes > LIMITS.fileBytes) throw failure('SKILL_INPUT_SIZE');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat({ bigint: true }), visible = await lstat(path, { bigint: true });
    if (!equalIdentity(opened, after) || !equalIdentity(after, visible) || visible.nlink !== 1n || bytes !== descriptor.bytes
      || hash.digest('hex') !== descriptor.sha256) throw failure('SKILL_INPUT_CHANGED');
    return { path, identity: visible };
  } finally { await handle.close(); }
}
async function evidenceProof(payload, files, directory, signal) {
  if (!Array.isArray(payload.evidence) || !payload.evidence.length || payload.evidence.length > LIMITS.evidence) throw failure('SKILL_EVIDENCE_INVALID');
  const ids = new Set(), linesByFile = new Map();
  for (const evidence of payload.evidence) {
    if (!plain(evidence) || typeof evidence.id !== 'string' || !/^E\d{4,8}$/u.test(evidence.id) || ids.has(evidence.id)
      || !Number.isSafeInteger(evidence.line) || evidence.line < 1 || evidence.line > LIMITS.scanLines
      || typeof evidence.text !== 'string' || !evidence.text || evidence.text.length > 6000) throw failure('SKILL_EVIDENCE_INVALID');
    ids.add(evidence.id);
    const input = files.find(file => file.sha256 === evidence.sha256 && redact(file.path).slice(0, 500) === evidence.file);
    if (!input) throw failure('SKILL_EVIDENCE_SCOPE');
    if (!linesByFile.has(input.path)) linesByFile.set(input.path, []);
    linesByFile.get(input.path).push(evidence);
  }
  let scanned = 0, characters = 0;
  for (const [name, required] of linesByFile) {
    const pending = new Map(required.map(item => [item.line, []]));
    for (const item of required) pending.get(item.line).push(item);
    const stream = createReadStream(resolve(directory, name), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity }); let number = 0;
    try {
      for await (const line of lines) {
        signal?.throwIfAborted(); number++; scanned++; characters += line.length;
        if (scanned > LIMITS.scanLines || characters > LIMITS.scanCharacters) throw failure('SKILL_EVIDENCE_SCAN_LIMIT');
        if (pending.has(number)) {
          for (const item of pending.get(number)) if (!redact(line).startsWith(item.text)) throw failure('SKILL_EVIDENCE_CHANGED');
          pending.delete(number);
        }
        if (!pending.size) break;
      }
    } finally { lines.close(); stream.destroy(); }
    if (pending.size) throw failure('SKILL_EVIDENCE_CHANGED');
  }
}
export function validateExecutionProof(value, backend) {
  if (!plain(value) || value.agentSessions !== 1 || value.skillLoaded !== true || value.proofValidated !== true
    || !Number.isSafeInteger(value.providerRequests) || value.providerRequests < 1 || value.providerRequests > 32
    || !Number.isSafeInteger(value.toolCalls) || value.toolCalls < 3 || value.toolCalls > 96
    || value.backend !== undefined && value.backend !== backend) throw failure('SKILL_EXECUTION_PROOF_INVALID', { modelStarted: true });
  let limits;
  if (value.limits !== undefined) {
    const maximum = { modelRequests: 32, toolCalls: 96, inputCharacters: 384000, maxTokens: 8192 };
    if (!plain(value.limits) || Object.keys(value.limits).some(key => !Object.hasOwn(maximum, key))
      || Object.entries(maximum).some(([key, max]) => !Number.isSafeInteger(value.limits[key]) || value.limits[key] < (key === 'toolCalls' ? 3 : 1) || value.limits[key] > max)
      || value.providerRequests > value.limits.modelRequests || value.toolCalls > value.limits.toolCalls) throw failure('SKILL_EXECUTION_PROOF_INVALID', { modelStarted: true });
    limits = Object.fromEntries(Object.keys(maximum).map(key => [key, value.limits[key]]));
  }
  return { backend, agentSessions: 1, providerRequests: value.providerRequests, toolCalls: value.toolCalls, skillLoaded: true, proofValidated: true,
    ...(limits ? { limits } : {}) };
}

/** Configured factories are trusted process adapters, never backend names supplied by a model. */
export function createSkillBackendRegistry(factories = {}) {
  const registry = new Map([['dsh', ({ runner }) => runner]]);
  const entries = factories instanceof Map ? factories.entries() : Object.entries(factories);
  for (const [name, factory] of entries) {
    if (!BACKENDS.has(name) || typeof factory !== 'function') throw failure('SKILL_BACKEND_REGISTRATION_INVALID');
    registry.set(name, factory);
  }
  return registry;
}

export class SkillExecutionService {
  constructor({ backend = 'dsh', runner, root, backendFactories = {} } = {}) {
    if (!isAbsolute(root ?? '') || /[\0\r\n]/u.test(root)) throw failure('SKILL_ROOT_INVALID');
    const registry = createSkillBackendRegistry(backendFactories);
    if (!BACKENDS.has(backend) || !registry.has(backend)) throw failure('SKILL_BACKEND_UNAVAILABLE');
    this.backend = backend; this.root = resolve(root); this.runner = registry.get(backend)({ backend, runner });
    if (!this.runner || typeof this.runner.runSkill !== 'function') throw failure('SKILL_RUNNER_INVALID');
  }
  async execute(request, { signal, beforeExecute } = {}) {
    let started = false, settled = false;
    try {
      signal?.throwIfAborted();
      if (!plain(request) || Object.keys(request).some(key => !['taskId', 'inputRevision', 'skillId', 'parameters', 'inputFiles', 'executionContext'].includes(key))
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(request.taskId ?? '') || !Number.isSafeInteger(request.inputRevision) || request.inputRevision < 1) throw failure('SKILL_REQUEST_INVALID');
      request = freeze(structuredClone(request));
      if (request.skillId !== TRIAGE_SKILL_ID) throw failure('SKILL_NOT_ALLOWED');
      if (!plain(request.parameters) || JSON.stringify(request.parameters).length > LIMITS.parameterCharacters) throw failure('SKILL_PARAMETERS_INVALID');
      const context = request.executionContext;
      if (!plain(context) || Object.keys(context).some(key => !['directory', 'outputDirectory', 'skillRoot', 'payload', 'proofPath'].includes(key))
        || !plain(context.payload) || context.payload.taskId !== request.taskId || context.payload.inputRevision !== request.inputRevision
        || context.payload.skill?.version !== '1.3.2' || JSON.stringify(context.payload).length > LIMITS.payloadCharacters) throw failure('SKILL_CONTEXT_INVALID');
      if (request.parameters.mode !== undefined && request.parameters.mode !== context.payload.mode
        || request.parameters.window !== undefined && JSON.stringify(request.parameters.window) !== JSON.stringify(context.payload.window)) throw failure('SKILL_PARAMETERS_MISMATCH');
      const rootInfo = await lstat(this.root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw failure('SKILL_ROOT_INVALID');
      const root = await realpath(this.root), directory = await directoryPath(root, context.directory);
      if (!isAbsolute(context.skillRoot ?? '') || (await lstat(context.skillRoot)).isSymbolicLink() || !(await lstat(context.skillRoot)).isDirectory()) throw failure('SKILL_CONTEXT_INVALID');
      if (context.proofPath && (!isAbsolute(context.proofPath) || !contained(root, resolve(context.proofPath)) || resolve(context.proofPath) === directory || contained(directory, resolve(context.proofPath)))) throw failure('SKILL_PROOF_PATH_INVALID');
      if (!Array.isArray(request.inputFiles) || !request.inputFiles.length || request.inputFiles.length > LIMITS.files) throw failure('SKILL_INPUT_FILES_INVALID');
      const files = [], names = new Set(); let total = 0;
      for (const descriptor of request.inputFiles) {
        if (!plain(descriptor) || Object.keys(descriptor).some(key => !['path', 'name', 'sha256', 'bytes'].includes(key))
          || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || descriptor.bytes > LIMITS.fileBytes
          || !/^[a-f0-9]{64}$/u.test(descriptor.sha256 ?? '') || descriptor.name !== undefined && (typeof descriptor.name !== 'string' || descriptor.name.length > 500)) throw failure('SKILL_INPUT_FILES_INVALID');
        const name = relativeFile(descriptor.path), key = process.platform === 'win32' ? name.toLowerCase() : name;
        if (names.has(key) || (total += descriptor.bytes) > LIMITS.totalBytes) throw failure('SKILL_INPUT_FILES_INVALID');
        names.add(key); files.push(structuredClone(descriptor));
      }
      const snapshot = freeze(structuredClone({ ...request, inputFiles: files, executionContext: { ...context, directory } }));
      for (const file of files) await safeFile(directory, file, signal);
      await evidenceProof(snapshot.executionContext.payload, files, directory, signal);
      let output = context.outputDirectory;
      if (output) {
        if (resolve(output) === directory || contained(directory, resolve(output))) throw failure('SKILL_OUTPUT_SCOPE');
        output = await directoryPath(root, output, { mayCreate: true });
      } else {
        const base = await directoryPath(root, join(root, 'skill-results'), { mayCreate: true });
        output = join(base, `${request.taskId}-r${request.inputRevision}-${randomUUID()}`); await mkdir(output, { mode: 0o700 });
      }
      for (const name of ['report.json', '报告.txt']) if (await lstat(join(output, name)).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; })) throw failure('SKILL_OUTPUT_EXISTS');
      signal?.throwIfAborted(); await beforeExecute?.(); signal?.throwIfAborted();
      started = true;
      const raw = await this.runner.runSkill(snapshot, { signal }); settled = true;
      signal?.throwIfAborted();
      const status = raw?.status ?? 'completed';
      if (!['completed', 'partial'].includes(status)) throw failure('SKILL_STATUS_INVALID', { modelStarted: true });
      const execution = validateExecutionProof(raw?.execution, this.backend);
      for (const file of files) await safeFile(directory, file, signal);
      await evidenceProof(snapshot.executionContext.payload, files, directory, signal);
      const result = validateModelReport(raw?.result, snapshot.executionContext.payload);
      if (status === 'partial') { result.confidence = 'low'; result.responsibility = '待验证'; }
      if (status === 'partial' && !result.limitations.some(text => text.includes('非模型终稿')))
        result.limitations = ['执行已达到预算上限；以下为程序初排，并非模型终稿。', ...result.limitations].slice(0, 12);
      // Only the service creates these two artifacts; runner/model file paths are never collected.
      const contents = [{ name: 'report.json', mime: 'application/json', data: JSON.stringify(result, null, 2) + '\n' },
        { name: '报告.txt', mime: 'text/plain', data: renderReport(result, snapshot.executionContext.payload) + '\n' }];
      const artifacts = [];
      for (const item of contents) {
        const bytes = Buffer.from(item.data, 'utf8');
        if (bytes.length > LIMITS.reportBytes || redact(item.data) !== item.data) throw failure('SKILL_OUTPUT_UNSAFE');
        const path = join(output, item.name), handle = await open(path, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        const descriptor = { path: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: digest(bytes) };
        await safeFile(root, descriptor, signal);
        artifacts.push({ name: item.name, mime: item.mime, size: bytes.length, sha256: descriptor.sha256, pathPrivate: path });
      }
      return { schemaVersion: 1, taskId: request.taskId, inputRevision: request.inputRevision, skillId: TRIAGE_SKILL_ID,
        backend: this.backend, status, result, files: artifacts, execution };
    } catch (cause) {
      if (cause?.code?.startsWith('SKILL_')) { cause.modelStarted ||= started; if (started && !settled) cause.processTreeStopped = cause.processTreeStopped === true; throw cause; }
      const code = /^[A-Z][A-Z0-9_]{2,100}$/u.test(cause?.code ?? '') ? cause.code : 'SKILL_EXECUTION_FAILED';
      throw failure(code, { modelStarted: started || cause?.modelStarted === true,
        processTreeStopped: !started || settled || cause?.processTreeStopped === true, cause });
    }
  }
}
