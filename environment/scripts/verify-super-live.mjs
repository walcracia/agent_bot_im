import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { glob, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { once } from 'node:events';
import { TaskWorkerPool, CloudTaskWorkerPool, git } from '../../workspace/bridge/super-worker.mjs';
import { apply as inboxPlugin, inputKey } from '../../workspace/bridge/super-inbox-plugin.mjs';
import { createTaskDaemon } from '../../workspace/bridge/super-daemon.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const exec = promisify(execFile);
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const cliPath = 'D:/Work/ai/deepseek-harness/resources/runtime/cli/bin/dsh.cmd';
const python = join(root, 'environment/venv/Scripts/python.exe');
async function nativeEvents(id) {
  if (!/^session-[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid native ID.');
  const folder = join(homedir(), '.dsh', 'sessions');
  const matches = [];
  for await (const file of glob(`**/${id}/session.v4.jsonl.zstd`, { cwd: folder })) matches.push(join(folder, file));
  if (matches.length !== 1) throw new Error('Expected one exact owned native session artifact.');
  const bytes = await readFile(matches[0]);
  let offset = 0, text = '';
  while (offset < bytes.length) {
    const frame = zstdDecompressSync(bytes.subarray(offset), { info: true });
    if (!frame.engine.bytesWritten) throw new Error('Native compressed frame made no progress.');
    offset += frame.engine.bytesWritten; text += frame.buffer.toString('utf8');
  }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => Number.isInteger(event.seq));
}
if (!process.argv.includes('--live') && !process.argv.includes('--remote-tools-live')) {
  console.log(JSON.stringify({ mode: 'disabled', modelSessions: 0, message: 'Pass --live for exactly two installed DSH coding sessions, maximum five minutes each. No classifier, PR or automatic retries.' }));
} else if (process.argv.includes('--remote-tools-live')) {
  const evidence = join(root, 'environment/verification/super-live', new Date().toISOString().replaceAll(/[:.]/g, '-') + '-remote-tools');
  await mkdir(evidence, { recursive: true });
  let number = 900003;
  while (true) { try { await git(root, ['show-ref', '--verify', 'refs/heads/codex/super/T' + number]); number += 2; } catch (cause) { if (cause.code === 1 || cause.code === 128) break; throw cause; } }
  const id = 'T' + number, token = randomBytes(32).toString('hex');
  const daemonOptions = { repositoryPath: root, worktreesPath: join(evidence, 'daemon/worktrees'), runsPath: join(evidence, 'daemon/runs'), sessionMapsPath: join(evidence, 'daemon/sessions'),
    token, commands: { test: { file: python, args: ['-X', 'utf8', '-m', 'pytest', '-q', '.super-live-fixture/test_calc.py'], allowArgs: false, timeoutMs: 30000 } } };
  const { server, pool: daemonPool } = createTaskDaemon(daemonOptions);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const pool = new CloudTaskWorkerPool({ runsPath: join(evidence, 'controller/runs'), sessionMapsPath: join(evidence, 'controller/sessions'), daemon: { url: 'http://127.0.0.1:' + server.address().port, token },
    harness: { cliPath, auth: 'stored', runTimeoutMs: 300000, permissionMode: 'danger-full-access' } });
  const report = { taskId: id, modelSessionBudget: 1, modelSessionsAdmitted: 0, newCloudServer: false, retries: 0, checks: {}, evidence };
  const progress = [];
  try {
    const metadata = await pool.prepare({ id });
    const fixture = join(metadata.environmentWorkspace, '.super-live-fixture'); await mkdir(fixture);
    const baseline = 'def compute(value):\n    return value * 2 - 1\n', test = 'from calc import compute\n\ndef test_compute():\n    assert compute(3) == 6\n    assert compute(-2) == -4\n';
    await writeFile(join(fixture, 'calc.py'), baseline); await writeFile(join(fixture, 'test_calc.py'), test);
    await writeFile(join(fixture, 'DESIGN.md'), 'Synthetic remote-environment acceptance. Only calc.py may change. compute(x) must return 2*x. Preserve test_calc.py. Use configured test command. No Git commit/tag/push/PR or product edits.\n');
    report.checks.controllerInitiallyEmpty = (await readdir(metadata.workspace)).length === 0;
    const handle = await pool.start({ id, attempt: 1, summary: '端侧MCP真实编码验收', inputs: [], instructions: '显式合成验收：控制侧cwd没有项目源码，代码仅在端侧。只能通过mcp__task__read读取.super-live-fixture/DESIGN.md、calc.py和test_calc.py，再用mcp__task__write修calc.py中compute(value)错误减一，使其返回value*2。测试文件不可改，使用mcp__task__exec选择可信命令test（args为空）运行验证。不用原生文件、搜索、shell或subagent工具，不commit/tag/push/PR，不改产品文件。最终简短报告真实结果。' }, { onProgress: event => progress.push(event) });
    report.modelSessionsAdmitted = 1;
    report.result = await handle.completion;
    const map = JSON.parse(await readFile(join(evidence, 'controller/sessions', id + '.json'), 'utf8'));
    report.nativeId = map.sessions['super-' + id].nativeSessionId;
    const events = await nativeEvents(report.nativeId);
    const names = [];
    for (const event of events) if (event.type === 'assistant/message') for (const block of event.data?.message?.content ?? event.data?.content ?? []) {
      if (['tool-call', 'tool_call'].includes(block.type)) names.push(block.name ?? block.toolName ?? block.function?.name);
    }
    report.toolNames = names.filter(Boolean);
    report.checks.mcpReadUsed = report.toolNames.some(name => /mcp__task__read$/.test(name));
    report.checks.mcpWriteUsed = report.toolNames.some(name => /mcp__task__write$/.test(name));
    report.checks.mcpExecUsed = report.toolNames.some(name => /mcp__task__exec$/.test(name));
    report.checks.noNativeFileOrShellTools = !report.toolNames.some(name => /^(?:bash|pwsh|powershell|read|write|edit|apply_patch|glob|grep|rg|exec_command|subagent|subagent_fork)$/.test(name));
    report.checks.controllerStillEmpty = (await readdir(metadata.workspace)).length === 0;
    report.checks.sourceChanged = await readFile(join(fixture, 'calc.py'), 'utf8') !== baseline;
    report.checks.testUnchanged = hash(await readFile(join(fixture, 'test_calc.py'))) === hash(test);
    await exec(python, ['-X', 'utf8', '-c', 'import runpy,sys;m=runpy.run_path(sys.argv[1]);assert m["compute"](3)==6;assert m["compute"](-2)==-4', join(fixture, 'calc.py')], { windowsHide: true, timeout: 30000 });
    report.checks.independentAssertions = true;
    const tested = await exec(python, ['-X', 'utf8', '-m', 'pytest', '-q', join(fixture, 'test_calc.py')], { cwd: metadata.environmentWorkspace, windowsHide: true, timeout: 30000 });
    report.checks.independentPytest = true; await writeFile(join(evidence, 'pytest.txt'), tested.stdout);
    const command = JSON.parse(await readFile(join(daemonOptions.runsPath, 'tasks', id, 'tool-command.json'), 'utf8'));
    report.checks.daemonCommandSettled = command.status === 'finished';
    report.checks.noProductEdits = (await git(metadata.environmentWorkspace, ['status', '--porcelain', '--untracked-files=all'])).split('\n').filter(Boolean).every(line => line.slice(3).replaceAll('\\', '/').startsWith('.super-live-fixture/'));
    report.passed = Object.values(report.checks).every(Boolean);
  } catch (cause) { report.passed = false; report.failure = String(cause.message); }
  finally {
    try { await pool.close(); await daemonPool.close(); } catch (cause) { report.passed = false; report.shutdownFailure = String(cause.message); }
    await new Promise(resolveClose => server.close(resolveClose));
    await writeFile(join(evidence, 'progress.json'), JSON.stringify(progress, null, 2)); await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, taskId: id, nativeId: report.nativeId, modelSessionsAdmitted: report.modelSessionsAdmitted, checks: report.checks, toolNames: report.toolNames, failure: report.failure, evidence }));
    if (!report.passed) process.exitCode = 1;
  }
} else if (process.argv.includes('--resume-from')) {
  // Explicitly budgeted follow-up after the first acceptance exposed a native event-shape defect.
  const prior = resolve(process.argv[process.argv.indexOf('--resume-from') + 1]);
  if (!prior.startsWith(join(root, 'environment', 'verification', 'super-live'))) throw new Error('Resume evidence must be in this project.');
  const first = JSON.parse(await readFile(join(prior, 'report.json'), 'utf8'));
  if (first.modelSessionsAdmitted !== 2) throw new Error('Expected original two-session acceptance.');
  const id = first.ids[0], evidence = join(prior, 'next-step-resume'); await mkdir(evidence);
  const oldMap = JSON.parse(await readFile(join(prior, 'sessions', id + '.json'), 'utf8'));
  const nativeId = oldMap.sessions['super-' + id].nativeSessionId;
  const report = { originalTaskId: id, nativeId, extraModelTurnsBudget: 1, extraModelTurnsAdmitted: 0, newNativeSessions: 0, checks: {}, evidence };
  const beforeEvents = await nativeEvents(nativeId);
  const oldInputFile = join(prior, 'runs/tasks', id, 'inbox', inputKey('live-followup-offset17') + '.json');
  const oldInput = JSON.parse(await readFile(oldInputFile, 'utf8'));
  const offlineInbox = join(evidence, 'offline-inbox'); await mkdir(offlineInbox);
  await writeFile(join(offlineInbox, inputKey(oldInput.id) + '.json'), JSON.stringify(oldInput));
  const hooks = {}, session = { header: {}, seq: beforeEvents.length, eventAt: i => beforeEvents[i] };
  inboxPlugin({ on(name, callback) { hooks[name] = callback; } }, { inboxPath: offlineInbox });
  hooks['agent/created']({ agent: { id: nativeId, session, steer() { throw new Error('Already-consumed native input must not be injected again.'); } } });
  for (let index = 0; index < 40; index++) {
    try { report.offlineReceipt = JSON.parse(await readFile(join(offlineInbox, 'receipts', inputKey(oldInput.id) + '.json'), 'utf8')); break; }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; await sleep(50); }
  }
  hooks.dispose(); report.checks.originalEventOfflineRegression = report.offlineReceipt?.nativeSequence === beforeEvents.find(event => event.type === 'user/message' && event.data?.id === oldInput.messageId)?.seq;
  const pool = new TaskWorkerPool({ repositoryPath: root, worktreesPath: join(prior, 'worktrees'), runsPath: join(prior, 'runs'), sessionMapsPath: join(prior, 'sessions'),
    harness: { cliPath, auth: 'stored', runTimeoutMs: 300000, permissionMode: 'danger-full-access' } });
  const progress = [];
  try {
    const metadata = await pool.prepare({ id }), fixture = join(metadata.workspace, '.super-live-fixture');
    const before = await readFile(join(fixture, 'calc.py'), 'utf8'), testBefore = hash(await readFile(join(fixture, 'test_calc.py')));
    const handle = await pool.start({ id, attempt: 2, inputs: [], summary: '原A会话next-step接续验收', instructions: '这是根协调器明确预算的一次原会话接续，只处理已有.super-live-fixture，保留compute和offset_result当前正确实现及测试不变。先在同一个前台工具写.super-live-fixture/nextstep.ready后等待20秒，再处理运行期间收到的新补充。没有补充则保持当前offset_result的+17。不要改其他产品文件，不commit/tag/push/PR。完成后运行已有fixture测试。' }, { onProgress: event => progress.push(event) });
    report.extraModelTurnsAdmitted = 1;
    let done = false, sent = false;
    const outcome = handle.completion.then(result => { done = true; return { ok: true, result }; }, cause => { done = true; return { ok: false, error: String(cause.message), kind: cause.kind }; });
    const input = { id: 'live-followup-offset23-next-step', text: '当前原A任务的新补充：只将offset_result(value)从compute(value)+17改为compute(value)+23。保留compute(value)=value*2、原测试和其他工作不变。确认实际代码与指定测试。', source: 'synthetic-live-controller' };
    const deadline = Date.now() + 310000;
    while (!done && Date.now() < deadline) {
      if (!sent) try { if ((await readFile(join(fixture, 'nextstep.ready'), 'utf8')).includes('ready')) { report.inputAdmission = await pool.input(id, input); sent = true; } } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      await sleep(100);
    }
    if (!done) { await pool.close(); throw new Error('Resume budget expired; no retry.'); }
    report.outcome = await outcome; report.checks.inputSent = sent;
    const state = await pool.inspect(id), receipt = state.inputs.find(item => item.id === input.id);
    report.receipt = receipt; report.checks.nativeReceipt = Boolean(receipt?.delivered);
    const currentMap = JSON.parse(await readFile(join(prior, 'sessions', id + '.json'), 'utf8'));
    report.checks.originalNativeIdUnchanged = currentMap.sessions['super-' + id].nativeSessionId === nativeId;
    const afterEvents = await nativeEvents(nativeId);
    const splice = afterEvents.find(event => event.type === 'agent/inbox/spliced' && event.data.inserted?.some(message => message.id === receipt?.messageId));
    const consumed = afterEvents.find(event => event.type === 'user/message' && event.data.id === receipt?.messageId);
    report.nativeProof = { spliceSequence: splice?.seq, target: splice?.data.target, consumedSequence: consumed?.seq };
    report.checks.actualNextStepTarget = splice?.data.target === 'next-step';
    report.checks.receiptMatchesNativeConsumption = Boolean(consumed && consumed.seq === receipt?.nativeSequence);
    report.checks.noInterveningTurnEnd = Boolean(splice && consumed && !afterEvents.some(event => event.type === 'turn/end' && event.seq > splice.seq && event.seq < consumed.seq));
    report.checks.testUnchanged = hash(await readFile(join(fixture, 'test_calc.py'))) === testBefore;
    const after = await readFile(join(fixture, 'calc.py'), 'utf8'); report.checks.sourceChanged = after !== before;
    await exec(python, ['-X', 'utf8', '-c', 'import runpy,sys;m=runpy.run_path(sys.argv[1]);assert m["compute"](3)==6;assert m["compute"](-2)==-4;assert m["offset_result"](3)==29;assert m["offset_result"](-2)==19', join(fixture, 'calc.py')], { windowsHide: true, timeout: 30000 });
    report.checks.independentAssertions = true;
    const tested = await exec(python, ['-X', 'utf8', '-m', 'pytest', '-q', join(fixture, 'test_calc.py')], { cwd: metadata.workspace, windowsHide: true, timeout: 30000 });
    report.checks.independentPytest = true; await writeFile(join(evidence, 'pytest.txt'), tested.stdout);
    report.checks.noProductEdits = (await git(metadata.workspace, ['status', '--porcelain', '--untracked-files=all'])).split('\n').filter(Boolean).every(line => line.slice(3).replaceAll('\\', '/').startsWith('.super-live-fixture/'));
    await writeFile(join(evidence, 'source-after.py'), after);
    report.passed = report.outcome.ok && Object.values(report.checks).every(Boolean);
  } catch (cause) { report.passed = false; report.failure = String(cause.message); }
  finally {
    try { await pool.close(); } catch (cause) { report.passed = false; report.shutdownFailure = String(cause.message); }
    await writeFile(join(evidence, 'progress.json'), JSON.stringify(progress, null, 2)); await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, taskId: id, nativeId, extraModelTurnsAdmitted: report.extraModelTurnsAdmitted, checks: report.checks, nativeProof: report.nativeProof, failure: report.failure, evidence }));
    if (!report.passed) process.exitCode = 1;
  }
} else {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const evidence = join(root, 'environment/verification/super-live', stamp);
  await mkdir(evidence, { recursive: true });
  let start = 900001;
  const exists = async id => { try { await git(root, ['show-ref', '--verify', `refs/heads/codex/super/${id}`]); return true; } catch (cause) { if (cause.code === 1 || cause.code === 128) return false; throw cause; } };
  while (await exists('T' + start) || await exists('T' + (start + 1))) start += 2;
  const ids = ['T' + start, 'T' + (start + 1)];
  const pool = new TaskWorkerPool({ repositoryPath: root, worktreesPath: join(evidence, 'worktrees'), runsPath: join(evidence, 'runs'), sessionMapsPath: join(evidence, 'sessions'),
    harness: { cliPath, auth: 'stored', runTimeoutMs: 300000, permissionMode: 'danger-full-access' } });
  const report = { startedUtc: new Date().toISOString(), modelSessionBudget: 2, modelSessionsAdmitted: 0, ids, evidence,
    usesSyntheticFixture: true, deploymentTouched: false, retryCount: 0, sourceCommit: await git(root, ['rev-parse', 'HEAD']), checks: {} };
  const baseline = 'def compute(value):\n    return value * 2 - 1\n';
  const test = 'from calc import compute\n\ndef test_compute():\n    assert compute(3) == 6\n    assert compute(-2) == -4\n';
  const progress = {};
  const handles = [];
  try {
    for (const id of ids) {
      const metadata = await pool.prepare({ id });
      const fixture = join(metadata.workspace, '.super-live-fixture');
      await mkdir(fixture);
      await writeFile(join(fixture, 'calc.py'), baseline);
      await writeFile(join(fixture, 'test_calc.py'), test);
      await writeFile(join(fixture, 'DESIGN.md'), '# Synthetic live acceptance\n\nOnly calc.py is a coding target. compute(x) should return x*2. Preserve test_calc.py. The controller independently verifies the actual diff and output. Task A receives a new requirement through its native inbox during a 20-second tool wait. No commit, tag, push, PR, network publication, product-file changes or branch cleanup.\n');
      progress[id] = [];
    }
    const common = '这是显式合成验收，只改 .super-live-fixture/calc.py。该文件compute(value)错误地减一，应返回value*2。已有test_calc.py不可修改。先读fixture的DESIGN，再处理。不要修改产品文件，不commit/tag/push/建PR；Git交付由协调器处理。验证可用的Python解释器为 ' + python.replaceAll('\\', '/') + '，运行该fixture的pytest。最终给真实修改和测试结论。';
    const tasks = ids.map((id, index) => ({ id, summary: index === 0 ? '合成验收A：执行中补充' : '合成验收B：并行计算修正', attempt: 1, inputs: [],
      instructions: common + (index === 0 ? '\n为了给实时补充留窗口：完成初步检查后，必须先用一个前台工具在fixture写midpoint.ready，再执行20秒等待（例如同一个pwsh工具中 Set-Content -LiteralPath .super-live-fixture/midpoint.ready -Value ready; Start-Sleep -Seconds 20）。等待结束后继续修复，并处理期间送入的补充消息。不要自行创建offset_result，除非后续输入要求。' : '') }));
    for (const task of tasks) {
      handles.push(await pool.start(task, { onProgress: event => { progress[task.id].push(event); } }));
      report.modelSessionsAdmitted++;
    }
    const deadline = Date.now() + 310000;
    let simultaneous = false, inputSent = false;
    const settlements = handles.map(handle => handle.completion.then(result => ({ ok: true, result }), cause => ({ ok: false, error: String(cause.message), kind: cause.kind, processTreeStopped: cause.processTreeStopped })));
    const finished = [false, false]; settlements.forEach((promise, index) => promise.then(() => { finished[index] = true; }));
    const input = { id: 'live-followup-offset17', at: new Date().toISOString(), text: '补充当前合成验收A：保留compute(value)=value*2的修复，并在同一个calc.py增加offset_result(value)，其返回值严格为compute(value)+17。不得改测试文件。请在最终结果确认这条新要求。', source: 'synthetic-live-controller' };
    while (Date.now() < deadline && !finished.every(Boolean)) {
      const records = ids.map(id => pool.records.get(id));
      if (records.every(record => record.executor?.active.size > 0 && Object.keys(record.executor.map?.sessions ?? {}).length > 0)) simultaneous = true;
      try {
        if (!inputSent && (await readFile(join(records[0].workspace, '.super-live-fixture/midpoint.ready'), 'utf8')).includes('ready')) {
          report.inputAdmission = await pool.input(ids[0], input); report.inputSentUtc = new Date().toISOString(); inputSent = true;
        }
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      await sleep(100);
    }
    if (!finished.every(Boolean)) { await pool.close(); throw new Error('Live acceptance deadline reached; owned workers stopped without automatic retry.'); }
    const results = await Promise.all(settlements);
    report.results = results;
    report.checks.simultaneousNativeSessions = simultaneous;
    report.checks.liveInputSent = inputSent;
    const receipt = (await pool.inspect(ids[0])).inputs.find(item => item.id === input.id);
    report.checks.nativeInputReceipt = Boolean(receipt?.delivered);
    report.nativeReceipt = receipt;
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index], metadata = await pool.inspect(id), fixture = join(metadata.workspace, '.super-live-fixture');
      const source = await readFile(join(fixture, 'calc.py'), 'utf8');
      report.checks[id + 'TestUnchanged'] = hash(await readFile(join(fixture, 'test_calc.py'))) === hash(test);
      report.checks[id + 'ActualSourceChanged'] = source !== baseline;
      await writeFile(join(evidence, id + '-source.py'), source);
      const script = 'import runpy,sys; m=runpy.run_path(sys.argv[1]); assert m["compute"](3)==6; assert m["compute"](-2)==-4;' + (index === 0 ? ' assert m["offset_result"](3)==23; assert m["offset_result"](-2)==13;' : '');
      try { const checked = await exec(python, ['-X', 'utf8', '-c', script, join(fixture, 'calc.py')], { cwd: metadata.workspace, windowsHide: true, timeout: 30000 }); report.checks[id + 'IndependentAssertions'] = true; }
      catch (cause) { report.checks[id + 'IndependentAssertions'] = false; report[id + 'assertionError'] = String(cause.stderr ?? cause.message).slice(-2000); }
      try { const checked = await exec(python, ['-X', 'utf8', '-m', 'pytest', '-q', join(fixture, 'test_calc.py')], { cwd: metadata.workspace, windowsHide: true, timeout: 30000 }); report.checks[id + 'IndependentPytest'] = true; await writeFile(join(evidence, id + '-pytest.txt'), checked.stdout); }
      catch (cause) { report.checks[id + 'IndependentPytest'] = false; await writeFile(join(evidence, id + '-pytest.txt'), String(cause.stdout ?? '') + String(cause.stderr ?? '')); }
      report.checks[id + 'NoProductEdits'] = (await git(metadata.workspace, ['status', '--porcelain', '--untracked-files=all'])).split('\n').filter(Boolean).every(line => line.slice(3).replaceAll('\\', '/').startsWith('.super-live-fixture/'));
      report[id] = { ...metadata, sourceBeforeSha256: hash(baseline), sourceAfterSha256: hash(source), sessionMap: JSON.parse(await readFile(join(evidence, 'sessions', id + '.json'), 'utf8')) };
    }
    report.passed = results.every(item => item.ok) && Object.values(report.checks).every(Boolean);
  } catch (cause) { report.passed = false; report.failure = String(cause.message); }
  finally {
    try { await pool.close(); } catch (cause) { report.shutdownFailure = String(cause.message); report.passed = false; }
    report.finishedUtc = new Date().toISOString();
    await writeFile(join(evidence, 'progress.json'), JSON.stringify(progress, null, 2));
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, ids, modelSessionsAdmitted: report.modelSessionsAdmitted, checks: report.checks, failure: report.failure, evidence }));
    if (!report.passed) process.exitCode = 1;
  }
}
