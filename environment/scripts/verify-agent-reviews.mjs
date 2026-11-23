/** Explicit real-Agent regression and source review.
 * Run with Node 24.9+ after environment/scripts/setup.ps1 has restored tools.
 * --prepare copies source and records hashes without model calls. Add
 * --source-frozen once edits stop; --run-agent also requires --live.
 * Runtime credentials stay in each configured Agent's original data home.
 * No API key, environment map, chat or runtime state is copied from bridge config.
 */
import { mkdir, readFile, readdir, copyFile, lstat, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshExecutor } from '../../workspace/bridge/dsh-executor.mjs';
import { HermesExecutor } from '../../workspace/bridge/hermes-executor.mjs';
import { PiExecutor } from '../../workspace/bridge/pi-executor.mjs';
import { dshModelSelection } from '../../workspace/bridge/dsh-model-selection.mjs';

const repo = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const toolSource = fileURLToPath(new URL('./agent-review-mcp.mjs', import.meta.url));
const nodeCommand = process.execPath;
const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const inside = (root, file) => { const part = relative(root, file); return part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const suites = {
  router: ['worker-registry.test.mjs', 'business-router.test.mjs', 'super-business.test.mjs'],
  adapters: ['dsh-executor.test.mjs', 'hermes-executor.test.mjs', 'pi-executor.test.mjs'],
  integration: ['business-config.test.mjs', 'super-coordinator.test.mjs', 'super-lifecycle.test.mjs'],
};
const assignments = { dsh: 'router', pi: 'adapters', hermes: 'integration' };
const HELP = `Usage (Node 24.9+):
  node environment/scripts/verify-agent-reviews.mjs --config <local-bridge.json> --prepare [--source-frozen]
  node environment/scripts/verify-agent-reviews.mjs --config <local-bridge.json> --run-agent dsh|pi|hermes --live
Options:
  --output <project-directory>       Default environment/verification/agent-reviews
  --powershell-command <absolute>    Verified PowerShell 7; otherwise discover Get-Command pwsh
  --integration-tests-file <json>    Trusted JSON array of bridge test basenames
  --plan <project-plan.json>         Use an earlier prepared generation

Preparation is offline and starts no Agent or model. Actual reviews use stored
Agent credentials, consume model calls and execute the fixed isolated test suite.
Reports are local evidence; do not commit their raw protocol or account paths.`;

function testPaths(names) {
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length) throw Error('Regression suite needs distinct test basenames.');
  return names.map(name => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+\.test\.mjs$/u.test(name)) throw Error('Tests must be exact bridge test basenames.');
    return 'workspace/bridge/test/' + name;
  });
}

async function outputDirectory(create) {
  const output = resolve(repo, value('--output') ?? 'environment/verification/agent-reviews');
  if (!inside(repo, output)) throw Error('--output must stay inside this checkout.');
  let cursor = repo;
  for (const part of relative(repo, output).split(sep)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink() || info && !info.isDirectory()) throw Error('Review output must use independent project directories.');
  }
  if (create) await mkdir(output, { recursive: true, mode: 0o700 });
  return output;
}

async function configuredAgents() {
  const file = value('--config');
  if (!file || /[\0\r\n]/u.test(file)) throw Error('Provide --config with a trusted local bridge configuration.');
  const configPath = resolve(repo, file), base = dirname(configPath);
  const raw = await readJSON(configPath), candidates = raw.superAgent?.business?.agents;
  if (!Array.isArray(candidates)) throw Error('Configuration needs superAgent.business.agents.');
  const result = {};
  for (const backend of Object.keys(assignments)) {
    const selected = candidates.find(agent => agent?.backend === backend && agent.available !== false);
    if (!selected) throw Error('Configure an available ' + backend + ' backend before preparing its native review.');
    const executable = selected.command;
    if (typeof executable !== 'string' || !executable || /[\0\r\n]/u.test(executable)) throw Error('Backend command must be a trusted path.');
    const command = resolve(base, executable);
    if (!isAbsolute(command) || !(await lstat(command)).isFile()) throw Error('Configured backend executable is missing.');
    const picked = { command };
    if (selected.dataHome !== undefined) {
      if (typeof selected.dataHome !== 'string' || !selected.dataHome || /[\0\r\n]/u.test(selected.dataHome)) throw Error('Invalid backend data home.');
      picked.dataHome = resolve(base, selected.dataHome);
      if (!(await lstat(picked.dataHome)).isDirectory()) throw Error('Configured backend data home is missing.');
    } else if (backend !== 'dsh') throw Error(backend + ' requires its configured native dataHome.');
    for (const field of ['provider', 'model']) if (selected[field] !== undefined) {
      if (typeof selected[field] !== 'string' || !selected[field] || /[\0\r\n]/u.test(selected[field])) throw Error('Invalid trusted model selection.');
      picked[field] = selected[field];
    }
    if (backend === 'dsh') {
      const selection = dshModelSelection({ ...raw.harness?.modelSelection,
        ...(picked.provider ? { provider: picked.provider } : {}), ...(picked.model ? { model: picked.model } : {}),
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) });
      Object.assign(picked, selection);
    }
    result[backend] = picked;
  }
  return result;
}

async function powershellPath() {
  let candidate = value('--powershell-command');
  if (!candidate) {
    const script = "[Console]::Write((Get-Command pwsh -CommandType Application | Select-Object -First 1).Source)";
    try { candidate = (await execute('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 })).stdout.trim(); }
    catch { throw Error('PowerShell 7 was not discoverable; pass --powershell-command with its absolute executable path.'); }
  }
  if (!isAbsolute(candidate) || /[\0\r\n]/u.test(candidate) || !(await lstat(candidate)).isFile()) throw Error('PowerShell must be an existing absolute executable.');
  const script = '[Console]::Write($PSVersionTable.PSVersion.ToString())';
  const version = (await execute(candidate, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 })).stdout.trim();
  if (!/^7\./u.test(version)) throw Error('Native Windows identity tests require PowerShell 7.');
  return resolve(candidate);
}

async function copyTree(source, destination, files) {
  await mkdir(destination, { recursive: true });
  for (const item of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith('.') || ['node_modules', '__pycache__'].includes(item.name)) continue;
    const from = join(source, item.name), to = join(destination, item.name);
    if (item.isSymbolicLink()) throw Error('Source snapshots cannot include symbolic links.');
    if (item.isDirectory()) { await copyTree(from, to, files); continue; }
    if (!item.isFile()) continue;
    await copyFile(from, to); files.push({ path: to, bytes: (await lstat(to)).size, sha256: hash(await readFile(to)) });
  }
}

async function prepare() {
  const configured = await configuredAgents();
  const powershellCommand = await powershellPath();
  const listFile = value('--integration-tests-file');
  if (listFile) suites.integration = await readJSON(resolve(repo, listFile));
  for (const suite of Object.values(suites)) testPaths(suite);
  const output = await outputDirectory(true), sourceFrozen = flag('--source-frozen');
  const generation = new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID();
  const generationRoot = join(output, 'generations', generation); await mkdir(generationRoot, { recursive: true });
  // Each generation keeps its exact tool bytes; later source edits cannot erase
  // the implementation needed to reproduce an earlier failure receipt.
  const toolPath = join(generationRoot, 'agent-review-mcp.mjs'); await copyFile(toolSource, toolPath);
  const toolSHA256 = hash(await readFile(toolPath));
  const plan = { schemaVersion: 1, repoRoot: repo, generation, sourceFrozen, preparedAt: new Date().toISOString(), nodeCommand, powershellCommand, toolPath, toolSHA256, agents: {} };
  for (const agentId of Object.keys(assignments)) {
    const root = join(generationRoot, agentId), snapshotRoot = join(root, 'snapshot'), bridge = join(snapshotRoot, 'workspace/bridge');
    await mkdir(bridge, { recursive: true }); const files = [];
    for (const entry of (await readdir(join(repo, 'workspace/bridge'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/\.(?:mjs|ps1)$/u.test(entry.name)) continue;
      const to = join(bridge, entry.name); await copyFile(join(repo, 'workspace/bridge', entry.name), to);
      files.push({ path: to, bytes: (await lstat(to)).size, sha256: hash(await readFile(to)) });
    }
    await copyTree(join(repo, 'workspace/bridge/test'), join(bridge, 'test'), files);
    const rows = files.map(file => ({ ...file, path: relative(snapshotRoot, file.path).split(sep).join('/') })).sort((a, b) => a.path.localeCompare(b.path));
    const manifestPath = join(root, 'source-manifest.json'), sourceManifestSHA256 = hash(JSON.stringify(rows));
    await writeFile(manifestPath, JSON.stringify({ files: rows, sha256: sourceManifestSHA256 }, null, 2));
    const suite = assignments[agentId], tests = testPaths(suites[suite]); for (const file of tests) await lstat(join(snapshotRoot, file));
    const auditDirectory = join(root, 'tool-evidence'); await mkdir(auditDirectory);
    const configPath = join(root, 'regression-config.json'), auditPath = join(auditDirectory, 'calls.jsonl');
    const config = { agentId, suite, sourceFrozen, snapshotRoot, manifestPath, sourceManifestSHA256, toolPath, toolSHA256, tests, nodeCommand, powershellCommand, auditDirectory, auditPath };
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    plan.agents[agentId] = { root, suite, snapshotRoot, configPath, manifestPath, sourceManifestSHA256, executor: configured[agentId] };
  }
  await writeFile(join(output, 'current-plan.json'), JSON.stringify(plan, null, 2));
  await writeFile(join(generationRoot, 'plan.json'), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({ prepared: true, generation, sourceFrozen, agents: Object.keys(plan.agents), modelCalls: 0, testsExecuted: 0, output }));
}

async function nativeMcpEvidence(agentId,runsPath){
 const paths=[];async function scan(path){for(const item of await readdir(path,{withFileTypes:true})){const file=join(path,item.name);if(item.isDirectory())await scan(file);else if(item.isFile()&&(/events.*\.jsonl$/u.test(item.name)||item.name==='protocol.jsonl'))paths.push(file);}}
 await scan(runsPath);const hits=[];
 for(const path of paths){for(const line of (await readFile(path,'utf8')).split('\n')){
  if(!line.trim())continue;let event;try{event=JSON.parse(line.replace(/^\uFEFF/u,''));}catch{continue;}
  let name;
  if(agentId==='dsh'&&event.type==='tool_call')name=event.tool;
  if(agentId==='pi'&&event.type==='tool_execution_start')name=event.toolName??event.tool;
  if(agentId==='hermes'&&event.direction==='receive'&&event.value?.method==='session/update'&&event.value.params?.update?.sessionUpdate==='tool_call')name=event.value.params.update.title;
  if(typeof name==='string'&&/run[_-]?regression/iu.test(name))hits.push({path,name});
 }}return hits;
}
async function runAgent(agentId){
 if(!flag('--live'))throw Error('Real Agent reviews require explicit --live; --prepare never calls a model.');
 const selected=await configuredAgents();
 const output=await outputDirectory(false);
 const plan=await readJSON(value('--plan')?resolve(repo,value('--plan')):join(output,'current-plan.json'));
 if(plan.schemaVersion!==1||plan.repoRoot!==repo)throw Error('Review plan belongs to another checkout.');
 const expected=selected[agentId];
 if(!expected||JSON.stringify(expected)!==JSON.stringify(plan.agents[agentId]?.executor))throw Error('Configured backend changed after preparation; create a new frozen plan.');
 const agent=plan.agents[agentId];if(!agent||!plan.sourceFrozen)throw Error('Root must freeze the source and final suites before real Agent review.');
 const cfg=await readJSON(agent.configPath);if(!cfg.sourceFrozen||!cfg.tests.length)throw Error('Assigned suite has not been finalized.');
 if(hash(await readFile(plan.toolPath))!==plan.toolSHA256)throw Error('Regression tool changed after source freeze; prepare a new generation.');
 const server={name:'regression',command:plan.nodeCommand,args:[plan.toolPath,agent.configPath]};
 const mcpServers=agentId==='pi'?{regression:{command:server.command,args:server.args}}:agentId==='hermes'?[{...server,env:[]}]:[server];
 const runsPath=join(agent.root,'native-runs'),Executor={dsh:DshExecutor,pi:PiExecutor,hermes:HermesExecutor}[agentId];
 const executor=new Executor({...agent.executor,runsPath,...(agentId==='dsh'?{harness:{...agent.executor.harness,powershellPath:plan.powershellCommand}}:{})});
 const request={taskId:'REVIEW-'+agentId.toUpperCase(),cwd:agent.snapshotRoot,mcpServers,prompt:[
  '你正在对这份隔离的同频TeamPlay源码快照进行独立回归和源码审查。与协调者沟通、反馈进度及说明结论均使用简体中文。',
  '首先实际调用提供的regression MCP工具run_regression，参数suite='+JSON.stringify(agent.suite)+'。必须真实调用，不得用其他shell测试命令替代，不得编造回执。',
  '随后阅读该套件对应的workspace/bridge源码和测试，报告具体问题。不得修改源码或测试、安装依赖、访问业务系统或委派其他Agent。',
  '在当前快照根目录写review.json，使用严格JSON，字段为agentId,suite,nonce,sourceManifestSHA256,stdoutSHA256,exitCode,summary,findings。回执值必须从真实MCP结果原样复制。agentId='+JSON.stringify(agentId)+'。',
  'findings是对象数组，每项为{file,line,severity,detail}；file是快照内相对源码路径，line为正整数，severity只能是high|medium|low。没有可处理的问题时使用空数组。summary和detail使用简体中文，summary需说明审查范围和局限，不得编造失败。JSON字段、枚举、工具名、命令、路径、源码及原始引用保持原样。',
  '完成后用中文简短回复。源码清单SHA256：'+agent.sourceManifestSHA256+'。固定测试文件：'+cfg.tests.join(', ')+'。'
 ].join('\n')};
 try{
  const result=await executor.run(request);if(!result.completed)throw Error('Native Agent did not complete.');
  const audit=(await readFile(cfg.auditPath,'utf8')).trim().split('\n').map(JSON.parse);
  const reviewBytes=await readFile(join(agent.snapshotRoot,'review.json')),review=JSON.parse(reviewBytes);
  const receipt=audit.find(row=>row.nonce===review.nonce&&row.suite===agent.suite&&row.agentId===agentId);
  if(!receipt||review.agentId!==agentId||review.sourceManifestSHA256!==agent.sourceManifestSHA256||review.stdoutSHA256!==receipt.stdoutSHA256||review.exitCode!==receipt.exitCode)throw Error('Agent report does not match actual MCP test audit/nonce.');
  if(hash(await readFile(receipt.stdoutPath))!==receipt.stdoutSHA256)throw Error('Saved test stdout changed.');
  if(!Array.isArray(review.findings)||typeof review.summary!=='string')throw Error('Review shape is invalid.');
  const nativeMcpCalls=await nativeMcpEvidence(agentId,runsPath);if(!nativeMcpCalls.length)throw Error('Native MCP tool-call event was not proven.');
  const manifest=await readJSON(agent.manifestPath);for(const file of manifest.files)if(hash(await readFile(join(agent.snapshotRoot,file.path)))!==file.sha256)throw Error('Agent altered reviewed source/test bytes.');
  const verification={...result,agentId,suite:agent.suite,nativeMcpCalls,mcpReceipt:receipt,reviewSha256:hash(reviewBytes),sourceUnchanged:true,review};
  await writeFile(join(agent.root,'verification.json'),JSON.stringify(verification,null,2));
  console.log(JSON.stringify({agentId,suite:agent.suite,completed:result.completed,actualMcpCall:true,testExitCode:receipt.exitCode,findings:review.findings.length,sourceUnchanged:true,usage:result.usage,root:agent.root}));
 }catch(error){await writeFile(join(agent.root,'failure.json'),JSON.stringify({message:error.message,kind:error.kind,sessionId:error.sessionId,processTreeStopped:error.processTreeStopped},null,2));throw error;}
 finally{await executor.close();}
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (flag('--help')) console.log(HELP);
else {
  if (major !== 24 || minor < 9) throw Error('Use Node 24.9+ in the 24.x line; the exact executable is frozen into the test MCP.');
  if (flag('--prepare') && value('--run-agent')) throw Error('Choose preparation or live execution separately.');
  if (flag('--prepare')) await prepare();
  else if (value('--run-agent')) await runAgent(value('--run-agent'));
  else throw Error(HELP);
}
