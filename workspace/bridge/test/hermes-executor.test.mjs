import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HermesExecutor } from '../hermes-executor.mjs';

const fake = String.raw`
import readline from 'node:readline'; import{writeFile}from'node:fs/promises';import{join}from'node:path';
const mode=process.argv[2],id='hermes-fixture-session-1';let active,resumed=false;
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
if(process.argv.includes('chat')){
 const query=process.argv[process.argv.indexOf('--query-file')+1];
 const content=await (await import('node:fs/promises')).readFile(query,'utf8');
 if(content.trim()!=='/version')process.exit(3);
 await writeFile(join(process.cwd(),'bootstrap-argv.json'),JSON.stringify(process.argv.slice(3)));
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:''}));
 console.log(JSON.stringify({type:'result',session_id:id,exit_code:0,text:'Hermes fixture version'}));
 process.exit(0);
}
const answer=(id,result)=>send({id,result});
const chunk=(text,messageId='final')=>send({method:'session/update',params:{sessionId:id,update:{sessionUpdate:'agent_message_chunk',messageId,content:{type:'text',text}}}});
const rl=readline.createInterface({input:process.stdin});
rl.on('line',async line=>{const m=JSON.parse(line);
 if(m.method==='initialize')return answer(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(m.method==='session/new')return answer(m.id,{sessionId:id});
 if(m.method==='session/load'){resumed=true;return answer(m.id,{sessionId:mode==='wrong-resume'?'different-native-session':id});}
 if(m.method==='session/set_model')return answer(m.id,{});
 if(m.method==='session/prompt'){
  if(m.params.prompt?.[0]?.text?.startsWith('/title ')){
   await writeFile(join(process.cwd(),'native-title-command.json'),JSON.stringify(m.params));
   return answer(m.id,{stopReason:'end_turn'});
  }
  active=m;await writeFile(join(process.cwd(),'prompt-admitted'),String(m.id));
  if(mode==='exit-after-admit'){process.exit(0);return;}
  if(mode==='wait-cancel')return;
  if(mode==='reject'){send({id:m.id,error:{code:-32603,message:'synthetic native failure'}});return;}
  chunk('Intermediate text that must not become the final result.','first');
  send({method:'session/update',params:{sessionId:id,update:{sessionUpdate:'tool_call',toolCallId:'call-1',title:'read fixture'}}});
  if(mode==='permission'){
   send({id:99,method:'session/request_permission',params:{sessionId:id,options:[{optionId:'allow_once',kind:'allow_once'}],toolCall:{kind:'edit',content:[{type:'diff',path:join(process.cwd(),'result.txt'),oldText:'',newText:'done'}]}}});return;
  }
  if(mode!=='empty')chunk(JSON.stringify({prompt:m.params.prompt[0].text,resumed,secretSeen:Object.keys(process.env).some(k=>/^(QA_|TEAM_RELAY_BOT|GITHUB_TOKEN|OPENAI_API_KEY)/.test(k)),home:process.env.HERMES_HOME}));
  answer(m.id,{stopReason:mode==='no-final'?'max_turn_requests':'end_turn',usage:{inputTokens:17,outputTokens:5,totalTokens:22}});return;
 }
 if(m.method==='session/cancel'){
  await new Promise(r=>setTimeout(r,90));await writeFile(join(process.cwd(),'cancel-settled'),'yes');
  answer(active.id,{stopReason:'cancelled'});return;
 }
 if(m.id===99){chunk('Permission outcome '+m.result.outcome.outcome);answer(active.id,{stopReason:'end_turn'});return;}
});
`;
async function fixture(t, mode='normal') {
  const root=await mkdtemp(join(tmpdir(),'teamplay hermes '));
  t.after(async()=>{assert.equal(dirname(root),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
  const cwd=join(root,'task workspace'),home=join(root,'home');await mkdir(cwd);await mkdir(home);
  const script=join(root,'fake hermes.mjs');await writeFile(script,fake);
  const options={command:[process.execPath,script,mode],dataHome:home,runsPath:join(root,'runs')};
  const executor=new HermesExecutor(options);t.after(()=>executor.close());
  return{root,cwd,home,executor,options};
}
const waitForFile=async path=>{for(let n=0;n<100;n++){try{return await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,15));}throw Error('Fixture file did not appear.');};

test('native prompt terminal, final assistant text, usage and viewer exit are required; prompt stays in JSON stdin',async t=>{
 const f=await fixture(t),prompt='请读fixture；原文 $(not-a-command) `backticks` "quotes"\n第二行。';
 const saved=process.env.QA_SYNTHETIC_SECRET;process.env.QA_SYNTHETIC_SECRET='must-not-inherit';
 t.after(()=>{if(saved===undefined)delete process.env.QA_SYNTHETIC_SECRET;else process.env.QA_SYNTHETIC_SECRET=saved;});
 const result=await f.executor.run({taskId:'TDEMO',cwd:f.cwd,prompt,mcpServers:[{name:'demo',command:'safe-configured-command',args:[],env:[]}]});
 assert.equal(result.backend,'hermes');assert.equal(result.completed,true);assert.equal(result.sessionId,'hermes-fixture-session-1');
 assert.deepEqual(JSON.parse(result.text),{prompt,resumed:false,secretSeen:false,home:f.home});
 assert.equal(result.usage.inputTokens,17);assert.equal(result.usage.outputTokens,5);assert.equal(result.usage.toolCalls,1);
 const run=(await readdir(f.options.runsPath)).find(x=>x.startsWith('TDEMO-'));
 const receipt=JSON.parse(await readFile(join(f.options.runsPath,run,'result.json')));assert.equal(receipt.nativeTerminal,'end_turn');assert.equal(receipt.viewerExit.code,0);
 const log=await readFile(join(f.options.runsPath,run,'protocol.jsonl'),'utf8');assert.match(log,/"mcpServers":\[\{"name":"demo"/);
 const title=JSON.parse(await readFile(join(f.cwd,'native-title-command.json'),'utf8'));
 assert.equal(title.prompt[0].text,'/title 同频 · TDEMO');
 assert.equal(title.sessionId,result.sessionId);
 const named=JSON.parse(await readFile(join(f.options.runsPath,run,'session-title.json'),'utf8'));
 assert.equal(named.modelPromptsSent,0);
 assert.ok(log.indexOf('/title 同频 · TDEMO')<log.indexOf('请读fixture'));
});

test('resume uses only exact native ID bound to the original task and workspace',async t=>{
 const f=await fixture(t);const first=await f.executor.run({taskId:'TDEMO',cwd:f.cwd,prompt:'first'});
 const resumed=await f.executor.run({taskId:'TDEMO',cwd:f.cwd,prompt:'continue',sessionId:first.sessionId});
 assert.equal(resumed.sessionId,first.sessionId);assert.equal(JSON.parse(resumed.text).resumed,true);
 await assert.rejects(f.executor.run({taskId:'OTHER',cwd:f.cwd,prompt:'steal',sessionId:first.sessionId}),/does not belong/);
 await assert.rejects(f.executor.run({taskId:'TDEMO',cwd:f.cwd,prompt:'not exact',sessionId:'latest'}),/exact session/);
});

test('cancel sends native session/cancel and waits for the original prompt terminal before returning',async t=>{
 const f=await fixture(t,'wait-cancel'),aborter=new AbortController();
 const run=f.executor.run({taskId:'TCANCEL',cwd:f.cwd,prompt:'wait',},{signal:aborter.signal});
 const failed=assert.rejects(run,e=>e.kind==='cancelled'&&e.processTreeStopped===true&&e.sessionId==='hermes-fixture-session-1');
 await waitForFile(join(f.cwd,'prompt-admitted'));aborter.abort();await failed;
 assert.equal(await readFile(join(f.cwd,'cancel-settled'),'utf8'),'yes');
});

test('viewer exit after admission is uncertain even when its own process exits zero',async t=>{
 const f=await fixture(t,'exit-after-admit');
 await assert.rejects(f.executor.run({taskId:'TUNKNOWN',cwd:f.cwd,prompt:'do work'}),e=>e.processTreeStopped===false&&e.kind==='hermes-failed');
});

test('an end_turn without final text, native refusal or non-complete terminal is never completed',async t=>{
 for(const mode of ['empty','reject','no-final']){
  const f=await fixture(t,mode);await assert.rejects(f.executor.run({taskId:'TBAD',cwd:f.cwd,prompt:'test'}));
 }
});

test('only an in-task edit permission is approved once by the ACP client',async t=>{
 const f=await fixture(t,'permission');const result=await f.executor.run({taskId:'TEDIT',cwd:f.cwd,prompt:'write result'});
 assert.equal(result.text,'Permission outcome selected');
});

test('unmapped skill preload is explicit and cannot silently fall back to running without the requested skill',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.executor.run({taskId:'TSKILL',cwd:f.cwd,prompt:'test',skillPaths:[join(f.root,'external','SKILL.md')]}),e=>e.kind==='hermes-skill-mapping-required'&&e.processTreeStopped);
});

test('registered skills use native zero-model CLI bootstrap then exact ACP load; resume keeps frozen skills',async t=>{
 const f=await fixture(t);const skill=join(f.home,'skills','analysis','local-sum','SKILL.md');
 await mkdir(dirname(skill),{recursive:true});await writeFile(skill,'---\nname: local-sum\n---\nRead a fixture and add numbers.\n');
 const result=await f.executor.run({taskId:'TSKILL',cwd:f.cwd,prompt:'process fixture',skillPaths:[skill]});
 assert.equal(JSON.parse(result.text).resumed,true);
 const argv=JSON.parse(await readFile(join(f.cwd,'bootstrap-argv.json'),'utf8'));
 assert.equal(argv[argv.indexOf('--skills')+1],'analysis/local-sum');
 assert.ok(!argv.includes('--ignore-rules'));assert.ok(!argv.includes('--yolo'));
 const run=(await readdir(f.options.runsPath)).find(x=>x.startsWith('TSKILL-'));
 const receipt=JSON.parse(await readFile(join(f.options.runsPath,run,'skill-bootstrap-receipt.json')));
 assert.equal(receipt.modelPromptsSent,0);assert.equal(receipt.sessionId,result.sessionId);
 const again=await f.executor.run({taskId:'TSKILL',cwd:f.cwd,prompt:'continue',sessionId:result.sessionId,skillIds:['analysis/local-sum']});
 assert.equal(again.sessionId,result.sessionId);
 const other=join(f.home,'skills','analysis','different','SKILL.md');await mkdir(dirname(other),{recursive:true});await writeFile(other,'Different skill');
 await assert.rejects(f.executor.run({taskId:'TSKILL',cwd:f.cwd,prompt:'change skills',sessionId:result.sessionId,skillPaths:[other]}),/cannot replace/);
});
