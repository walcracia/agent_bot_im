import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstalledHeadlessExecutor } from '../../workspace/bridge/installed-headless.mjs';
import { SuperRouter } from '../../workspace/bridge/super-router.mjs';
import { SemanticWatchdog } from '../../workspace/bridge/super-watchdog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.argv.includes('--live')) {
  console.log(JSON.stringify({ live: false, modelSessions: 0, note: 'Add --live to run at most two read-only native model sessions.' }));
} else {
  const configIndex = process.argv.indexOf('--config');
  const config = JSON.parse(await readFile(configIndex >= 0 ? resolve(process.argv[configIndex + 1]) : join(root, 'environment/config/bridge-installed.local.json'), 'utf8'));
  const evidence = join(root, 'environment/verification/super-model', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(evidence, { recursive: true });
  const env = { ...process.env }; for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD/iu.test(key)) delete env[key];
  const executor = new InstalledHeadlessExecutor({ ...config.harness, cwd: root, env, runsPath: join(evidence, 'runs'), sessionMapPath: join(evidence, 'sessions.json'), classificationTimeoutMs: 120000 });
  const report = { kind: 'explicit-live-read-only-model', classifierSessions: 0, watchdogSessions: 0, codeWorkers: 0, syntheticEvidence: true, passed: false };
  try {
    const router = new SuperRouter({ projectId: 'agent-bot-im', classify: prompt => { report.classifierSessions++; return executor.classify(prompt); } });
    const sender = { id: 'synthetic-human', username: 'acceptance', is_bot: false };
    const decisions = await router.route([
      { id: 7901, conversation_id: 'synthetic-chat', sender, text: '这是明确要现在落实的验收任务：修复微型函数compute(x)，要求返回x+1，补充负数用例并运行对应测试。' },
      { id: 7902, conversation_id: 'synthetic-chat', sender, text: '刚才讨论的另一项界面问题已经解决，请不要再修改界面。' },
    ], { tasks: [], context: [] });
    report.router = decisions.map(({ eventId, action }) => ({ eventId, action }));
    if (decisions.find(item => item.eventId === 7901)?.action !== 'new' || decisions.find(item => item.eventId === 7902)?.action !== 'ignore') throw new Error('Real Router decisions did not match the explicit synthetic requests.');
    const now = Date.now(), actions = [];
    const watchdog = new SemanticWatchdog({ snapshot: async () => ({ generation: 'synthetic-quality-case', heartbeat: new Date(now).toISOString(), sources: [], tasks: [{
      id: 'T790001', status: 'running', attempt: 1, summary: '修复compute并通过已指定测试', instructions: '仅修复compute函数并通过test_compute，不能跳过测试或扩大修改。',
      startedAt: new Date(now - 900000).toISOString(), updatedAt: new Date(now).toISOString(),
      progress: { at: new Date(now).toISOString(), events: Array.from({ length: 6 }, () => ({ type: 'tool', command: '重复读取相同文件，没有编辑', result: '相同内容' })),
        diff: '', tests: '连续6次test_compute失败，预期3实际1，代码未变化。此为明确标注的合成监督验收事实。' },
    }] }), act: async action => { actions.push(action); return { accepted: true }; }, classify: prompt => { report.watchdogSessions++; return executor.classify(prompt); }, now: () => now,
      config: { taskAgeMs: 1, maxAssessmentsPerTick: 1 } });
    const result = await watchdog.tick();
    report.watchdog = { assessed: result.assessed, actions: actions.map(({ action, taskId }) => ({ action, taskId })) };
    if (result.assessed !== 1 || !actions.some(item => ['steer', 'pause', 'notify'].includes(item.action))) throw new Error('Real semantic supervision did not flag the synthetic no-progress evidence.');
    report.passed = true;
  } catch (error) { report.error = String(error.message); process.exitCode = 1; }
  finally { await executor.close(); await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify({ evidence, ...report }));
}
