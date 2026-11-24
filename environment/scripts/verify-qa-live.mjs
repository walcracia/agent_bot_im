import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { ImApi } from '../../workspace/bridge/core.mjs';
import { QaMcpClient, QaAdapter } from '../../workspace/bridge/qa-mcp.mjs';
import { normalizeTriageConfig } from '../../workspace/bridge/triage-config.mjs';
import { triageModelEnvironment } from '../../workspace/bridge/triage-model.mjs';
import { redact } from '../../workspace/bridge/triage-report.mjs';
import { projectRoot, readJson, sha256, hashFile, runtimeSourceIdentity, verifyQaReceiptFile, findQaNative, readQaListenerProcess, qaStatePath, readQaTaskIssue } from './qa-live-proof.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  assert.ok(['--help', '--live', '--send', '--check', '--config', '--state', '--accounts-file', '--task', '--output', '--original-plugin', '--process-record'].includes(key), '未知验收参数。');
  options[key.slice(2)] = ['--help', '--live', '--send', '--check'].includes(key) ? true : process.argv[++index];
}
if (options.help) {
  console.log('真实QA验收：--live --send 或 --live --check；同时指定 --config <本机配置> --state <运行账本> --accounts-file <本机成员账号> --task T000001 --output <本轮私有目录>。send另需 --original-plugin <已安装chery-qa/index.js>，仅触发一次；check只检查，不重跑模型。');
  process.exit(0);
}

async function originalPromptParity(prepared, context, originalPluginPath) {
  const source = await readFile(originalPluginPath, 'utf8');
  const start = source.indexOf('  async function evidenceSnippets('), end = source.indexOf('  async function pickModel(', start);
  const route = source.indexOf("route('/chery-qa/api/triage/analyze'"), systemStart = source.indexOf('    const system = [', route);
  const promptEnd = source.indexOf('    const promptChars = ', systemStart);
  assert.ok(start > 0 && end > start && route > 0 && systemStart > route && promptEnd > systemStart, '原安装插件配方已变化，需核对。');
  const files = { low: ['SKILL.md', 'references/verdict-guide.md'], mid: ['SKILL.md', 'references/verdict-guide.md', 'references/time-alignment.md'],
    high: ['SKILL.md', 'references/verdict-guide.md', 'references/time-alignment.md', 'references/glossary.md', 'references/vehicle-config.md', 'references/component-map.md'] }[prepared.effort];
  assert.ok(files, '原插件强度未知。');
  const docs = await Promise.all(files.map(file => readFile(join(context.skillRoot, file), 'utf8')));
  const first = context.files[0]?.path, prefix = /^(input-\d+\/contents\/)/u.exec(first ?? '')?.[1];
  const baseDir = prefix && context.files.every(item => item.path.startsWith(prefix)) ? resolve(context.directory, prefix) : context.directory;
  const code = source.slice(start, end) + '\nasync function reference({baseDir,base,docs,symptom,effort}) {'
    + 'const level=EFFORT_LEVELS[effort];const evidence=await evidenceSnippets(baseDir,base,level.evidence);const keyLines=await keyLineHits(baseDir,base,level.keyLines);'
    + "const [skill,guide,align]=[docs[0],level.docs[1]?docs[1]:'',level.docs[2]?docs[2]:''];"
    + source.slice(systemStart, promptEnd) + '\nreturn {system,user};}\nreference;';
  const original = await vm.runInNewContext(code, { readFile, join })({ baseDir, base: prepared.base, docs, symptom: prepared.symptom, effort: prepared.effort });
  assert.equal(prepared.system, original.system, '原插件system不一致。'); assert.equal(prepared.user, original.user, '原插件user不一致。');
  return sha256(source);
}

async function listenerProof(configPath, identity, powershellPath) {
  const runtime = await readQaListenerProcess({ processRecord: options['process-record'] ?? join(projectRoot, 'environment/config/dsh-process.json'), powershellPath });
  assert.equal(resolve(runtime.configPath), configPath); assert.equal(runtime.status, 'listening');
  assert.ok(Date.parse(runtime.startedAt) >= Date.parse(identity.newestBridgeSourceModifiedAt), '监听仍加载旧桥接源码，请先按正常入口重启。');
  return runtime;
}

async function keepSameFile(file, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.ok((await readFile(file)).equals(bytes), '已有验收文件内容不同，已保留原证据。'); }
}

async function main() {
  assert.equal(options.live, true, '请显式指定 --live；默认不触发真实QA或模型。');
  assert.notEqual(Boolean(options.send), Boolean(options.check), '请选择一次 --send 或 --check。');
  for (const key of ['config', 'state', 'accounts-file', 'task', 'output']) assert.ok(typeof options[key] === 'string' && options[key], `缺少 --${key}。`);
  assert.match(options.task, /^T\d{6,}$/u);
  const configPath = resolve(options.config), statePath = resolve(options.state), output = resolve(options.output);
  assert.ok(output.startsWith(resolve(projectRoot, 'environment/verification') + (process.platform === 'win32' ? '\\' : '/')), '收据必须保存到本机忽略验收目录。');
  const config = await readJson(configPath), identity = await runtimeSourceIdentity();
  const triage = normalizeTriageConfig(config.superAgent?.triage, dirname(configPath), config);
  assert.ok(triage, '真实QA尚未启用。'); assert.equal(qaStatePath(config, configPath), statePath, '请选择Super Agent监听实际使用的账本。');
  const state = (await readJson(statePath)).superAgent, task = state.tasks[options.task];
  assert.equal(task?.kind, 'log-triage', '该任务不是QA日志任务。');
  const binding = triage.bindings.find(item => String(item.projectId) === String(task.projectId) && item.conversationId === task.conversationId);
  assert.ok(binding && config.conversationIds.includes(task.conversationId), '任务不属于当前授权项目和聊天。');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const triggerFile = join(output, 'qa-live-trigger.json'), receiptFile = join(output, 'qa-live-receipt.json');
  let trigger = await readJson(triggerFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (trigger) {
    assert.equal(trigger.taskId, task.id); assert.equal(trigger.version, identity.version); assert.equal(trigger.sourceSha256, identity.sourceSha256, '触发后产品源已变化，请使用新的验收目录重新实测。');
    if (options.send && trigger.messageId) { console.log(JSON.stringify({ status: 'already-sent', taskId: task.id, messageId: trigger.messageId })); return; }
  }
  if (options.check) {
    assert.ok(trigger?.messageId, '本轮尚无真实聊天触发。请先 --live --send。');
    if (await readJson(receiptFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      console.log(JSON.stringify(await verifyQaReceiptFile(receiptFile))); return;
    }
  }
  const accounts = (await readJson(resolve(options['accounts-file']))).accounts;
  const account = accounts.find(item => config.senderIds.includes(item.user?.id) && !item.user.is_bot && item.user.is_admin)
    ?? accounts.find(item => config.senderIds.includes(item.user?.id) && !item.user.is_bot);
  assert.ok(account, '缺少已授权聊天成员账号。');
  const base = new URL(config.baseUrl); assert.ok(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password);
  const login = await new ImApi(base.origin).request('/api/login', { username: account.username, password: account.password });
  const api = new ImApi(base.origin, login.token);
  try {
    const health = await api.request('/api/health'); assert.equal(health.version, identity.version, '运行服务尚未加载当前产品版本。');
    assert.ok((await api.request('/api/conversations')).some(item => item.id === task.conversationId), '成员无法读取目标聊天。');
    if (options.send) {
      assert.ok(typeof options['original-plugin'] === 'string' && options['original-plugin'], 'send需要显式 --original-plugin 本机原插件路径。');
      assert.ok(!['preparing', 'running', 'interrupting', 'cancelled'].includes(task.status) && task.uncertain !== true, '任务尚在运行或终态未确认，请先核对原任务。');
      if (!trigger) {
        const startedAt = new Date().toISOString(), env = triageModelEnvironment();
        const listener = await listenerProof(configPath, identity, config.harness?.powershellPath);
        for (const name of triage.mcp.envNames) if (process.env[name]) env[name] = process.env[name];
        if (triage.mcp.envFile) Object.assign(env, await readJson(triage.mcp.envFile));
        const client = new QaMcpClient({ ...triage.mcp, env });
        let issue, files;
        try { const adapter = new QaAdapter({ client, ...triage.sourceLimits }); issue = await readQaTaskIssue(adapter, task, binding); files = await adapter.listFiles(issue); }
        finally { await client.close(); }
        assert.ok(files.length, 'QA问题当前没有附件。');
        assert.match(task.externalIssueNo, /^[A-Za-z][A-Za-z0-9_-]{0,79}-\d+$/u);
        trigger = { schemaVersion: 1, runId: randomUUID(), ...identity, startedAt, taskId: task.id, statePath,
          beforeRevision: task.inputRevision, beforeAttempt: task.attempt, text: `重新分析 ${task.externalIssueNo}`,
          clientId: 'qa-live-' + randomUUID(), conversationId: task.conversationId,
          listener, originalPluginPath: resolve(options['original-plugin']), originalPluginSha256: await hashFile(resolve(options['original-plugin'])),
          qa: { authorized: true, at: new Date().toISOString(), projectId: issue.projectId, issueId: issue.id, fileIds: files.map(item => String(item.id)).sort() } };
        await writeFile(triggerFile, JSON.stringify(trigger, null, 2), { flag: 'wx', mode: 0o600 });
      }
      const sent = await api.request(`/api/conversations/${encodeURIComponent(task.conversationId)}/messages`, { text: trigger.text, client_id: trigger.clientId });
      trigger.messageId = sent.id;
      await writeFile(triggerFile, JSON.stringify(trigger, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ status: 'sent-once', version: identity.version, taskId: task.id, messageId: sent.id, next: '--live --check' })); return;
    }
    assert.equal(task.status, 'completed', 'QA任务尚未真实完成，不能交付为完成。');
    assert.ok(task.inputRevision > trigger.beforeRevision && task.attempt > trigger.beforeAttempt && task.reportRevision === task.inputRevision, '尚未生成本轮新输入版本和报告。');
    const routed = state.inbox[`im:${trigger.messageId}`];
    assert.equal(routed?.status, 'routed'); assert.equal(routed.trigger?.triggerId, `im:${trigger.messageId}`);
    assert.equal(routed.decision?.taskKind, 'log-triage'); assert.ok(['new', 'followup'].includes(routed.decision.action));
    assert.equal(routed.decision.taskId, task.id);
    assert.equal(task.execution?.recipe, 'chery-qa-plugin'); assert.equal(task.execution.backend, 'dsh'); assert.equal(task.execution.proofValidated, true);
    assert.deepEqual(task.fileIds.map(String).sort(), trigger.qa.fileIds);
    const native = await findQaNative(triage.root, task, trigger.startedAt);
    const prepared = await readJson(join(native.directory, 'plugin-preparation.json')), context = await readJson(join(native.directory, 'task-context.json'));
    const originalPluginSha256 = await originalPromptParity(prepared, context, trigger.originalPluginPath);
    assert.equal(originalPluginSha256, trigger.originalPluginSha256, '真实触发后原安装插件已变化。');
    const workerRoot = dirname(context.directory), manifestPath = join(workerRoot, 'manifest.json'), manifest = await readJson(manifestPath);
    assert.equal(manifest.inputRevision, task.inputRevision); assert.deepEqual(manifest.attachments.map(item => String(item.id)).sort(), trigger.qa.fileIds);
    const proofFiles = [];
    const proof = async (role, path) => { proofFiles.push({ role, path: resolve(path), sha256: await hashFile(path) }); };
    await proof('trigger', triggerFile); await proof('manifest', manifestPath);
    const listenerPath = join(output, 'qa-live-listener.json'), routePath = join(output, 'qa-live-route.json');
    await keepSameFile(listenerPath, JSON.stringify(trigger.listener, null, 2));
    await keepSameFile(routePath, JSON.stringify({ triggerId: routed.trigger.triggerId, status: routed.status, decision: routed.decision }, null, 2));
    await proof('listener', listenerPath); await proof('route', routePath); await proof('original-plugin', trigger.originalPluginPath);
    for (let index = 0; index < manifest.attachments.length; index++) {
      const file = join(workerRoot, `download-${index + 1}`), bytes = await readFile(file), expected = manifest.attachments[index];
      assert.equal(bytes.length, expected.bytes); assert.equal(sha256(bytes), expected.sha256); await proof('download-input', file);
    }
    for (const [role, name] of [['plugin-request', 'plugin-request.json'], ['plugin-preparation', 'plugin-preparation.json'], ['plugin-receipt', 'plugin-receipt.json'], ['plugin-report', 'plugin-report.md']]) await proof(role, join(native.directory, name));
    await proof('native-result', join(native.nativeRoot, 'result.json')); await proof('native-supervision', join(native.nativeRoot, 'bridge-supervision.json'));
    const sourceReport = await readFile(join(native.directory, 'plugin-report.md'), 'utf8');
    assert.equal(sha256(sourceReport), native.receipt.sourceReportSha256); assert.equal(redact(sourceReport).trim(), task.report.sourceReport);
    const outgoing = Object.values(state.outbox).filter(item => item.taskId === task.id && item.reportRevision === task.inputRevision && ['artifact', 'result', 'usage'].includes(item.category) && item.status !== 'superseded');
    assert.equal(outgoing.length, 1); const item = outgoing[0]; assert.equal(item.status, 'sent');
    const messages = await api.request(`/api/conversations/${encodeURIComponent(task.conversationId)}/messages?limit=100`);
    const matches = messages.filter(message => message.client_id === item.clientId); assert.equal(matches.length, 1);
    assert.equal(matches[0].text, task.externalIssueNo + '\n' + task.report.conclusion); assert.equal(matches[0].attachment?.name, '报告.txt');
    assert.equal(matches[0].attachment.id, item.attachmentId);
    const ticket = await api.request(`/api/attachments/${encodeURIComponent(item.attachmentId)}/ticket`, {}), url = new URL(ticket.url, base.origin);
    assert.equal(url.origin, base.origin); url.searchParams.set('download', '1');
    const downloaded = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) }); assert.equal(downloaded.ok, true);
    const bytes = Buffer.from(await downloaded.arrayBuffer()); assert.equal(bytes.length, item.artifact.size); assert.equal(sha256(bytes), item.artifact.sha256);
    assert.equal(bytes.toString('utf8').trim(), task.reportText.trim()); assert.ok(bytes.toString('utf8').startsWith(task.report.sourceReport));
    const reportPath = join(output, 'qa-live-report.txt'); await keepSameFile(reportPath, bytes); await proof('downloaded-report', reportPath);
    const receipt = { schemaVersion: 1, kind: 'qa-live-acceptance', status: 'passed', ...identity, runId: trigger.runId, startedAt: trigger.startedAt, completedAt: new Date().toISOString(),
      taskId: task.id, beforeRevision: trigger.beforeRevision, beforeAttempt: trigger.beforeAttempt, inputRevision: task.inputRevision, attempt: task.attempt,
      triggerMessageId: trigger.messageId, model: native.receipt.model, reasoningEffort: native.receipt.reasoningEffort, nativeSessionId: native.native.sessionId,
      nativeExitCode: native.native.nativeExitCode, providerRequests: native.receipt.requests, downloadBytes: bytes.length, downloadSha256: sha256(bytes), originalPluginSha256,
      checks: Object.fromEntries(['currentListenerLoaded', 'authorizedQaRead', 'realTriggerRouted', 'freshRevision', 'downloadHashes', 'originalPluginPrompt', 'nativeCompleted', 'qwen4High',
        'oneConclusionAndTxt', 'memberAuthenticatedDownload', 'originalReportPreserved'].map(name => [name, true])), proofFiles };
    // The shared checker rereads native model controls and every proof hash before publication.
    const candidate = receiptFile + '.pending';
    await keepSameFile(candidate, JSON.stringify(receipt, null, 2));
    await verifyQaReceiptFile(candidate);
    await rename(candidate, receiptFile);
    console.log(JSON.stringify(await verifyQaReceiptFile(receiptFile)));
  } finally { await api.request('/api/logout', {}).catch(() => {}); }
}

main().catch(error => { console.error('QA实测未完成：' + error.message); process.exitCode = 1; });
