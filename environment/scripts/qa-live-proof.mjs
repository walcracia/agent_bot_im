import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const execFileAsync = promisify(execFile);

/** Match super-agent.mjs normalization; the legacy bridge ledger is a different store. */
export function qaStatePath(config, configPath) {
  assert.equal(config.superAgent?.enabled, true, 'QA验收需要已启用的Super Agent。');
  const selected = config.superAgent.statePath ?? '../data/super-agent/state.json';
  assert.ok(typeof selected === 'string' && selected && !/[\0\r\n]/u.test(selected));
  return resolve(dirname(configPath), selected);
}

/** Query by the backend's verified project/no contract, then prove exact task scope. */
export async function readQaTaskIssue(adapter, task, binding) {
  const issue = await adapter.getIssue({ projectId: binding.projectId, no: task.externalIssueNo });
  assert.ok(issue, '当前QA项目中未找到准确问题编号，请核对任务编号。');
  assert.equal(String(issue.id), String(task.externalIssueId), 'QA返回的问题ID与当前任务不符。');
  assert.equal(String(issue.projectId), String(task.projectId), 'QA返回的项目ID与当前任务不符。');
  assert.equal(issue.no, task.externalIssueNo, 'QA返回的问题编号与当前任务不符。');
  return issue;
}

/** Reuse startup's live CIM executable/creation/command-line identity check. */
export async function readQaListenerProcess({ processRecord, powershellPath, root = projectRoot }) {
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $env:TEAMPLAY_QA_SCRIPTS 'runtime-processes.ps1')
$record = Read-ImRuntimeJson -Path $env:TEAMPLAY_QA_PROCESS_RECORD
Assert-ImDshRecordPaths -Record $record -ProjectRoot $env:TEAMPLAY_QA_PROJECT_ROOT
$current = Get-ImSavedProcess -Record $record -Role dsh
if (!$current) { throw 'Saved listener process has exited.' }
$runtime = Get-ImBridgeRuntime -Record $record
[ordered]@{pid=$current.ProcessId;executable=$current.ExecutablePath;creationTicks=[string]$current.CreationDate.Ticks;configPath=$runtime.configPath;instanceId=$runtime.instanceId;startedAt=$runtime.startedAt;status=$runtime.status;processIdentityVerified=$true;identitySource='Get-ImSavedProcess'} | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync(powershellPath, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, TEAMPLAY_QA_SCRIPTS: join(root, 'environment/scripts'), TEAMPLAY_QA_PROJECT_ROOT: root,
      TEAMPLAY_QA_PROCESS_RECORD: resolve(processRecord) }, shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000,
  });
  return JSON.parse(stdout.trim().replace(/^\uFEFF/u, ''));
}

/** InstalledHeadlessExecutor.classify() uses kind=classifier, not classify. */
export async function findQaNative(root, task, startedAt) {
  const matches = [];
  for (const entry of await readdir(join(root, 'agent-runs'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('skill-')) continue;
    const directory = join(root, 'agent-runs', entry.name);
    const request = await readJson(join(directory, 'plugin-request.json')).catch(() => null);
    if (request?.taskId !== task.id || request.inputRevision !== task.inputRevision) continue;
    const receipt = await readJson(join(directory, 'plugin-receipt.json')).catch(() => null);
    if (receipt?.completed !== true) continue;
    for (const run of await readdir(join(directory, 'runs'), { withFileTypes: true })) {
      if (!run.isDirectory() || !run.name.startsWith('classifier-')) continue;
      const nativeRoot = join(directory, 'runs', run.name);
      const supervision = await readJson(join(nativeRoot, 'bridge-supervision.json')).catch(() => null);
      const native = await readJson(join(nativeRoot, 'result.json')).catch(() => null);
      if (supervision?.status === 'completed' && Date.parse(supervision.startedUtc) >= Date.parse(startedAt) && native?.completed === true)
        matches.push({ directory, nativeRoot, request, receipt, supervision, native });
    }
  }
  assert.equal(matches.length, 1, '找不到本轮唯一真实完成的原插件调用。'); return matches[0];
}
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Product runtime bytes, including dependencies; documentation and tests do not change execution. */
export async function runtimeSourceIdentity(root = projectRoot) {
  const files = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '__pycache__', 'test', 'tests'].includes(item.name)) continue;
      const file = join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile() && /\.(?:mjs|cjs|js|py|json|html|css|svg)$/u.test(item.name)) files.push(file);
    }
  }
  for (const name of ['server', 'bridge', 'client', 'desktop']) await walk(join(root, 'workspace', name));
  for (const name of ['package.json', 'package-lock.json', 'requirements.txt', 'requirements.lock.txt']) {
    const file = join(root, 'workspace', name);
    if (await stat(file).then(item => item.isFile(), error => { if (error.code === 'ENOENT') return false; throw error; })) files.push(file);
  }
  const entries = []; let newestBridgeSourceMtimeMs = 0;
  for (const file of [...new Set(files)].sort()) {
    const name = relative(root, file).replaceAll('\\', '/');
    entries.push({ path: name, sha256: await hashFile(file) });
    if (name.startsWith('workspace/bridge/')) newestBridgeSourceMtimeMs = Math.max(newestBridgeSourceMtimeMs, (await stat(file)).mtimeMs);
  }
  const { version } = await readJson(join(root, 'workspace/package.json'));
  return { version, sourceSha256: sha256(JSON.stringify(entries)), sourceFiles: entries.length,
    newestBridgeSourceModifiedAt: new Date(newestBridgeSourceMtimeMs).toISOString() };
}

export function validateQaLiveReceipt(receipt, expected) {
  assert.equal(receipt?.kind, 'qa-live-acceptance', '需要真实QA验收收据。');
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.status, 'passed', 'QA正向流程尚未完成。');
  assert.equal(receipt.version, expected.version, 'QA收据属于其他产品版本。');
  assert.equal(receipt.sourceSha256, expected.sourceSha256, 'QA验收后产品源已变化，请按当前源码复验。');
  assert.equal(receipt.newestBridgeSourceModifiedAt, expected.newestBridgeSourceModifiedAt);
  assert.match(receipt.runId, /^[a-f0-9-]{36}$/u);
  assert.ok(Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt));
  for (const name of ['currentListenerLoaded', 'authorizedQaRead', 'realTriggerRouted', 'freshRevision', 'downloadHashes', 'originalPluginPrompt', 'nativeCompleted',
    'qwen4High', 'oneConclusionAndTxt', 'memberAuthenticatedDownload', 'originalReportPreserved'])
    assert.equal(receipt.checks?.[name], true, `QA验收缺少：${name}`);
  assert.match(receipt.taskId, /^T\d{6,}$/u);
  assert.ok(Number.isSafeInteger(receipt.inputRevision) && receipt.inputRevision > receipt.beforeRevision);
  assert.ok(Number.isSafeInteger(receipt.attempt) && receipt.attempt > receipt.beforeAttempt);
  assert.equal(receipt.model, 'qwen4-max'); assert.equal(receipt.reasoningEffort, 'high');
  assert.equal(receipt.nativeExitCode, 0); assert.match(receipt.nativeSessionId, /^session-[A-Za-z0-9_-]+$/u);
  assert.ok(Number.isSafeInteger(receipt.providerRequests) && receipt.providerRequests > 0);
  for (const role of ['trigger', 'listener', 'route', 'original-plugin', 'plugin-request', 'plugin-preparation', 'plugin-receipt', 'plugin-report', 'native-result', 'native-supervision', 'manifest', 'downloaded-report'])
    assert.equal(receipt.proofFiles?.filter(item => item.role === role).length, 1, `QA收据缺少独立凭证：${role}`);
  assert.ok(receipt.proofFiles.some(item => item.role === 'download-input'));
  assert.match(receipt.downloadSha256, /^[a-f0-9]{64}$/u);
  assert.ok(receipt.downloadBytes > 0 && receipt.downloadBytes < 100000000);
  return receipt;
}

/** Reopen the linked native evidence rather than trusting a passed flag copied from an old report. */
export async function verifyQaReceiptFile(file, { root = projectRoot } = {}) {
  const receipt = validateQaLiveReceipt(await readJson(file), await runtimeSourceIdentity(root));
  for (const proof of receipt.proofFiles) {
    assert.match(proof.sha256, /^[a-f0-9]{64}$/u); assert.equal(await hashFile(proof.path), proof.sha256, `QA凭证文件已变化：${proof.role}`);
  }
  const load = role => readJson(receipt.proofFiles.find(item => item.role === role).path);
  const [trigger, listener, route, request, prepared, model, native, supervision] = await Promise.all([
    'trigger', 'listener', 'route', 'plugin-request', 'plugin-preparation', 'plugin-receipt', 'native-result', 'native-supervision'].map(load));
  assert.equal(trigger.runId, receipt.runId); assert.equal(trigger.version, receipt.version); assert.equal(trigger.sourceSha256, receipt.sourceSha256);
  assert.equal(trigger.messageId, receipt.triggerMessageId); assert.equal(trigger.qa.authorized, true);
  assert.ok(Date.parse(listener.startedAt) >= Date.parse(receipt.newestBridgeSourceModifiedAt), '监听进程尚未加载当前桥接源码。');
  assert.equal(listener.status, 'listening'); assert.equal(listener.processIdentityVerified, true);
  assert.equal(listener.identitySource, 'Get-ImSavedProcess'); assert.match(listener.creationTicks, /^\d+$/u); assert.ok(listener.executable);
  assert.equal(route.triggerId, `im:${receipt.triggerMessageId}`); assert.equal(route.status, 'routed'); assert.equal(route.decision.taskKind, 'log-triage');
  assert.equal(route.decision.taskId, receipt.taskId); assert.ok(['new', 'followup'].includes(route.decision.action));
  assert.equal(request.taskId, receipt.taskId); assert.equal(request.inputRevision, receipt.inputRevision); assert.equal(request.recipe, 'chery-qa-plugin');
  assert.equal(prepared.system, request.system); assert.equal(prepared.user, request.user);
  assert.equal(model.systemSha256, sha256(request.system)); assert.equal(model.userSha256, sha256(request.user));
  assert.equal(model.recipe, 'chery-qa-plugin'); assert.equal(model.taskId, receipt.taskId); assert.equal(model.inputRevision, receipt.inputRevision);
  assert.equal(model.completed, true); assert.equal(model.model, 'qwen4-max'); assert.equal(model.reasoningEffort, 'high');
  assert.equal(model.finishReason, 'stop');
  assert.equal(model.requests, receipt.providerRequests); assert.equal(model.tools, 0);
  assert.equal(prepared.proof?.skillLoaded, true); assert.equal(prepared.proof?.parserRuns, 1);
  assert.ok(Array.isArray(prepared.evidence) && prepared.evidence.length > 0);
  assert.equal(native.completed, true); assert.equal(native.nativeExitCode, 0); assert.equal(native.finalReason, 'completed');
  assert.equal(native.sessionId, receipt.nativeSessionId); assert.equal(supervision.status, 'completed'); assert.equal(supervision.launcherExited, true);
  assert.ok(Date.parse(supervision.startedUtc) >= Date.parse(receipt.startedAt), '原生调用不是本轮触发之后的新分析。');
  assert.equal(model.sourceReportSha256, receipt.proofFiles.find(item => item.role === 'plugin-report').sha256);
  assert.equal(receipt.originalPluginSha256, receipt.proofFiles.find(item => item.role === 'original-plugin').sha256);
  const manifest = await load('manifest'), downloads = receipt.proofFiles.filter(item => item.role === 'download-input');
  assert.equal(manifest.inputRevision, receipt.inputRevision); assert.equal(downloads.length, manifest.attachments.length);
  assert.deepEqual(manifest.attachments.map(item => String(item.id)).sort(), trigger.qa.fileIds);
  for (let index = 0; index < downloads.length; index++) {
    assert.equal(downloads[index].sha256, manifest.attachments[index].sha256);
    assert.equal((await stat(downloads[index].path)).size, manifest.attachments[index].bytes);
  }
  const report = receipt.proofFiles.find(item => item.role === 'downloaded-report');
  assert.equal(report.sha256, receipt.downloadSha256); assert.equal((await stat(report.path)).size, receipt.downloadBytes);
  return { status: 'passed', version: receipt.version, sourceSha256: receipt.sourceSha256, taskId: receipt.taskId,
    inputRevision: receipt.inputRevision, model: receipt.model, reasoningEffort: receipt.reasoningEffort, providerRequests: receipt.providerRequests,
    receiptSha256: await hashFile(file), receiptPath: resolve(file) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv[2], '--receipt', '请提供 --receipt <本轮真实QA收据>。');
    console.log(JSON.stringify(await verifyQaReceiptFile(resolve(process.argv[3]))));
  } catch (error) { console.error('QA交付检查未通过：' + error.message); process.exitCode = 1; }
}
