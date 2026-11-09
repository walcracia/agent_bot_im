import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstalledHeadlessExecutor } from '../../workspace/bridge/installed-headless.mjs';
import { SuperRouter } from '../../workspace/bridge/super-router.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.argv.includes('--live')) console.log(JSON.stringify({ modelSessions: 0, message: 'Pass --live for one read-only two-event Router classification. No workers or retries.' }));
else {
  const evidence = join(root, 'environment/verification/super-proactive-live', new Date().toISOString().replaceAll(/[:.]/g, '-'));
  await mkdir(evidence, { recursive: true });
  const executor = new InstalledHeadlessExecutor({ cwd: root, cliPath: 'D:/Work/ai/deepseek-harness/resources/runtime/cli/bin/dsh.cmd',
    auth: 'stored', classificationTimeoutMs: 120000, runTimeoutMs: 120000, runsPath: join(evidence, 'runs'), sessionMapPath: join(evidence, 'sessions.json') });
  const report = { modelSessionBudget: 1, classifyInvocations: 0, workerInvocations: 0, retries: 0, evidence };
  try {
    const router = new SuperRouter({ projectId: 'synthetic-proactive-acceptance', allowProactive: true,
      classify: prompt => { report.classifyInvocations++; return executor.classify(prompt); } });
    const decisions = await router.route([
      { id: 7101, conversation_id: 'synthetic-defect-discussion', addressed: false, sender: { id: 'authorized-person', is_bot: false },
        text: '昨天也碰到了：在搜索框输入中文后，按清空按钮，旧筛选条件还在，请求仍带上旧关键词。大家先记一下这个可复现现象，我们还没给助手派任务。' },
      { id: 7102, conversation_id: 'synthetic-explicit-request', addressed: true, sender: { id: 'authorized-person', is_bot: false },
        text: '@dsh 请修复成员列表点击联系人后打不开私聊的问题，并补一个相关回归测试。现在就处理这个任务。' },
    ], { tasks: [], context: [] });
    report.decisions = decisions;
    report.passed = decisions.find(item => item.eventId === 7101)?.action === 'speculate' && decisions.find(item => item.eventId === 7102)?.action === 'new';
    const folders = await readdir(join(evidence, 'runs'));
    for (const folder of folders) { const result = JSON.parse(await readFile(join(evidence, 'runs', folder, 'result.json'), 'utf8')); report.nativeId = result.sessionId; }
  } catch (cause) { report.passed = false; report.failure = String(cause.message); }
  finally {
    await executor.close(); await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
  }
}
