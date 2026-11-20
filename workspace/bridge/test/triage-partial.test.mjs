import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectBudgetPartial } from '../triage-partial.mjs';
import { SKILL_TOOL_NAMES } from '../triage-skill-plugin.mjs';

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'teamplay-partial-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'skill-unit'),run=join(directory,'runs','classifier-unit');await mkdir(run,{recursive:true});
 const payload={evidence:[{id:'E0001',file:'a.log',line:12,text:'ERROR synthetic timeout',sha256:'a'.repeat(64)}],limitations:['Synthetic test; no model call.']};
 const request={taskId:'T000001',inputRevision:2,skillId:'ota-log-triage@1.3.2',inputFiles:[{path:'a.log',bytes:10,sha256:'a'.repeat(64)}],
 executionContext:{directory:join(root,'inputs'),skillRoot:join(root,'fixed-skill'),payload}};
 const write=async(name,data)=>writeFile(join(directory,name),JSON.stringify(data));
 await write('task-context.json',{taskId:request.taskId,inputRevision:2,skillId:request.skillId,files:request.inputFiles,...request.executionContext});
 await write('provider-proof.json',{requests:6,tools:SKILL_TOOL_NAMES,guard:true,inputCharacters:[2000,3000,4000,5000,6000,7000]});
 const tools={taskId:request.taskId,inputRevision:2,skillId:request.skillId,skillLoaded:true,parserRan:true,parserProcess:{status:'stopped',exitCode:0},toolCalls:11,evidenceReadIds:['E0001']};
 await write('tool-proof.json',tools);
 await writeFile(join(run,'result.json'),JSON.stringify({completed:false,finalReason:'error',nativeExitCode:1,sessionId:'session-synthetic'}));
 await writeFile(join(run,'bridge-supervision.json'),JSON.stringify({launcherExited:true}));
 await writeFile(join(run,'events.jsonl'),JSON.stringify({type:'final',sessionId:'session-synthetic',reason:{kind:'error',error:{message:'Skill execution request exceeds its tool or model budget.'}}})+'\n');
 return {root,directory,request,run,write,tools};
}

test('only a proven terminated budget stop yields an explicit program partial with no new model',async t=>{
 const f=await fixture(t),r=await collectBudgetPartial(f);
 assert.equal(r.status,'partial');assert.equal(r.execution.providerRequests,6);assert.equal(r.result.confidence,'low');
 assert.match(r.result.limitations[0],/并非模型终稿/u);assert.equal(r.result.evidence[0].id,'E0001');
});
test('foreign task/revision/context and unconfirmed parser termination cannot become partial',async t=>{
 const f=await fixture(t);
 await assert.rejects(collectBudgetPartial({...f,request:{...f.request,inputRevision:3}}));
 await f.write('tool-proof.json',{...f.tools,parserProcess:{status:'running',exitCode:null}});
 await assert.rejects(collectBudgetPartial(f));
});
test('credential errors and native success do not use budget fallback',async t=>{
 const f=await fixture(t);
 await writeFile(join(f.run,'events.jsonl'),JSON.stringify({type:'final',sessionId:'session-synthetic',reason:{kind:'error',error:{message:'MISSING_CREDENTIAL'}}})+'\n');
 await assert.rejects(collectBudgetPartial(f));
});
test('unread evidence and directory escapes cannot be used as recovered findings',async t=>{
 const f=await fixture(t);
 await f.write('tool-proof.json',{...f.tools,evidenceReadIds:['E9999']});
 await assert.rejects(collectBudgetPartial(f));await assert.rejects(collectBudgetPartial({...f,root:join(f.root,'elsewhere')}));
});
