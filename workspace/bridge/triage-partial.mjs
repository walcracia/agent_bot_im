import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { SKILL_TOOL_NAMES } from './triage-skill-plugin.mjs';
import { validateExecutionProof } from './skill-execution.mjs';

const inside = (root, path) => { const rest = relative(root, path); return rest && !isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + sep); };
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const fail = () => { throw new Error('Stored execution does not prove a safe budget-only partial result.'); };

/** Read-only recovery of the SAME terminated invocation. Never calls a model. */
export async function collectBudgetPartial({ root, directory, request }) {
  if (!isAbsolute(directory) || (await lstat(directory)).isSymbolicLink() || !inside(await realpath(root), await realpath(directory))) fail();
  const context = await read(join(directory, 'task-context.json')), provider = await read(join(directory, 'provider-proof.json')),
    tools = await read(join(directory, 'tool-proof.json'));
  if (context.taskId !== request.taskId || context.inputRevision !== request.inputRevision || context.skillId !== request.skillId
    || resolve(context.directory) !== resolve(request.executionContext.directory) || resolve(context.skillRoot) !== resolve(request.executionContext.skillRoot)
    || JSON.stringify(context.files) !== JSON.stringify(request.inputFiles) || JSON.stringify(context.payload) !== JSON.stringify(request.executionContext.payload)) fail();
  const policy = provider.limits ?? { modelRequests: 6, toolCalls: 12, inputCharacters: 120000, maxTokens: 2400 };
  const execution = validateExecutionProof({ backend: 'dsh', agentSessions: 1, providerRequests: provider.requests,
    toolCalls: tools.toolCalls, skillLoaded: tools.skillLoaded, proofValidated: true, limits: policy }, 'dsh');
  if (provider.requests !== policy.modelRequests || provider.guard !== true || JSON.stringify(provider.tools) !== JSON.stringify(SKILL_TOOL_NAMES)
    || !Array.isArray(provider.inputCharacters) || provider.inputCharacters.length !== policy.modelRequests || provider.inputCharacters.some(n => !Number.isSafeInteger(n) || n < 1 || n > policy.inputCharacters)
    || tools.taskId !== request.taskId || tools.inputRevision !== request.inputRevision || tools.skillId !== request.skillId
    || tools.skillLoaded !== true || tools.parserRan !== true || tools.parserProcess?.status !== 'stopped' || tools.parserProcess.exitCode !== 0
    || !Array.isArray(tools.evidenceReadIds) || !tools.evidenceReadIds.length) fail();
  const runs = (await readdir(join(directory, 'runs'))).filter(name => name.startsWith('classifier-'));
  if (runs.length !== 1) fail();
  const result = await read(join(directory, 'runs', runs[0], 'result.json')), supervision = await read(join(directory, 'runs', runs[0], 'bridge-supervision.json'));
  const events = (await readFile(join(directory, 'runs', runs[0], 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const final = events.at(-1);
  if (result.completed !== false || result.finalReason !== 'error' || result.nativeExitCode !== 1 || !/^session-[A-Za-z0-9_-]+$/u.test(result.sessionId)
    || supervision.launcherExited !== true || final.type !== 'final' || final.sessionId !== result.sessionId
    || final.reason?.kind !== 'error' || final.reason.error?.message !== 'Skill execution request exceeds its tool or model budget.') fail();
  const readIds = new Set(tools.evidenceReadIds), available = context.payload.evidence.filter(item => readIds.has(item.id));
  if (!available.length) fail();
  const abnormal = available.filter(item => /fail|error|timeout|panic|exception|denied|异常|失败/iu.test(item.text));
  const selected = (abnormal.length ? abnormal : available).slice(0, 4);
  const resultReport = {
    conclusion: '本轮只取得部分日志线索，助手未完成完整判断，故障根因仍待验证。',
    confidence: 'low', responsibility: '待验证',
    evidence: selected.map(item => ({ id: item.id, interpretation: '已核对的原始记录：' + item.text.slice(0, 280) + '。是否与本次问题相关仍需核实。' })),
    timeline: selected.map(item => ({ id: item.id, event: '已核对这条日志；记录之间的时钟关系尚未确认。' })),
    alternatives: ['日志中的异常可能是过程告警，也可能与报告的问题无关。'],
    nextSteps: ['结合复现步骤核对上述异常是否发生在同一次故障中，并补充对应模块的关键日志。'],
    limitations: ['本轮已达到阅读上限；以下为程序初排，并非模型终稿。',
      '已实际加载技能、运行解析器并读取部分证据，没有追加模型调用。',
      ...(context.payload.limitations ?? []).slice(0, 10)],
  };
  return { status: 'partial', result: resultReport, execution };
}
