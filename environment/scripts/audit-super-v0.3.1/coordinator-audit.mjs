// Audit reproduction for source dad375d; asserts known gaps, not product correctness.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir,writeFile} from 'node:fs/promises';
import {SuperCoordinator} from '../../../workspace/bridge/super-coordinator.mjs';
import {SuperRouter} from '../../../workspace/bridge/super-router.mjs';
const bot={id:'bot',username:'dsh',is_bot:true},human={id:'human',is_bot:false};
const conversations=[{id:'audit-chat',members:[bot,human]}];
const event=(id,text)=>({id,text,sender:human,conversation_id:'audit-chat',created_at:new Date().toISOString()});
const until=async(fn)=>{for(let i=0;i<500;i++){if(fn())return;await delay(2);}throw Error('Condition timed out')};
async function fixture(options={}){
 const runs=new Map(),starts=[],inputs=[],replies=[];
 const pool={prepare:async task=>({workspace:'/synthetic/'+task.id,branch:'codex/super/'+task.id}),start:async(task,{onProgress})=>{let resolve,reject;const completion=new Promise((yes,no)=>{resolve=yes;reject=no});completion.catch(()=>{});runs.set(task.id,{resolve,reject,onProgress});starts.push(task.id);return{completion}},input:async(id,input)=>{inputs.push({id,input});return{queued:true,delivered:false,live:false}},cancel:async id=>{runs.get(id)?.reject(Object.assign(Error('cancelled'),{processTreeStopped:true}));return{processTreeStopped:true}},close:async()=>{for(const run of runs.values())run.reject(Object.assign(Error('fixture close'),{processTreeStopped:true}))}};
 const c=new SuperCoordinator({state:options.state??{cursor:0},store:{write:async()=>{}},config:{projectId:'audit',conversationIds:['audit-chat'],senderIds:['human'],maxWorkers:2,...options.config},api:{request:async()=>conversations,reply:async(_event,text)=>{replies.push(text);return{id:1}}},bot,pool,delivery:options.delivery,release:options.release,router:options.router??{route:async events=>events.map(e=>({eventId:e.id,action:'new',summary:e.text,instructions:e.text}))}});
 await c.initialize();await c.ingestIm([],conversations);return{c,runs,starts,inputs,replies};
}
const results={scope:'Synthetic zero-model in-memory coordinator; no actual IM, files, CLI, GitHub or runtime operations',tests:[]};
// Late input after a worker completed but before its trusted delivery finished.
{
 let releaseDelivery;const held=new Promise(resolve=>{releaseDelivery=resolve});
 const f=await fixture({delivery:{deliver:async()=>held}});
 await f.c.ingestIm([event(1,'请修复初始问题')],conversations);await f.c.routePending();await until(()=>f.starts.length===1);
 f.runs.get('T000001').resolve({finalResponse:'Initial work only'});await until(()=>f.c.data.tasks.T000001.status==='delivering');
 await f.c.ingestIm([event(2,'#T000001 请补充空输入处理')],conversations);await f.c.writes;
 assert.equal(f.c.data.tasks.T000001.inputs.length,2);assert.equal(f.inputs.length,1);
 releaseDelivery({merged:true,number:7,head:'a'.repeat(40),url:'https://example.invalid/pr/7',threadId:'github:audit/project:pr:7'});
 await until(()=>f.c.active.size===0);await f.c.flushOutbox();
 const task=f.c.data.tasks.T000001,consumed=new Set([...(task.includedInputIds??[]),...(task.deliveredInputIds??[])]);
 assert.equal(task.status,'merged');assert.equal(f.starts.length,1);assert.equal(consumed.has('im:2'),false);
 results.tests.push({name:'followup_during_delivery',reproduced:true,status:task.status,workerStarts:f.starts.length,inputCount:task.inputs.length,newInputConsumed:consumed.has('im:2'),pendingTaskStatuses:Object.values(f.c.data.tasks).map(t=>t.status),acceptedNotice:f.replies.some(t=>t.includes('补充已加入'))});await f.c.close();
}
// A silent investigation that has no verified deliverable becomes visible after restart.
{
 const f=await fixture({config:{proactive:{enabled:true}},delivery:{},router:{route:async events=>events.map(e=>({eventId:e.id,action:'speculate',taskId:null,summary:'Synthetic defect investigation',instructions:e.text}))}});
 await f.c.ingestIm([event(1,'有人反馈某个具体结果异常')],conversations);await f.c.routePending();await until(()=>f.starts.length===1);
 assert.equal(Object.keys(f.c.data.outbox).length,0);const preserved=structuredClone(f.c.state);await f.c.close();
 const recovered=await fixture({state:preserved,config:{proactive:{enabled:true}},delivery:{}});await recovered.c.flushOutbox();
 const notices=Object.values(recovered.c.data.outbox).filter(x=>x.key.startsWith('restart-'));
 assert.equal(notices.length,1);assert.equal(recovered.c.data.tasks.T000001.speculative,true);assert.equal(recovered.c.data.tasks.T000001.delivery,undefined);
 results.tests.push({name:'silent_speculative_restart_notice',reproduced:true,speculative:true,verifiedPr:false,restartNotices:notices.length});await recovered.c.close();
}
// The IM thread/trigger side of the durable graph does not link back to tasks.
{
 const f=await fixture();await f.c.ingestIm([event(1,'请处理问题A'),event(2,'请处理问题B')],conversations);await f.c.routePending();await until(()=>f.starts.length===2);
 const graph=f.c.data.graph,thread=Object.values(graph).find(n=>n.kind==='thread');const seen=new Set(),pending=[thread.id];while(pending.length){const id=pending.shift();if(seen.has(id))continue;seen.add(id);pending.push(...(graph[id]?.links??[]));}
 const allTasks=Object.values(graph).filter(n=>n.kind==='task'),reachable=allTasks.filter(n=>seen.has(n.id));assert.equal(allTasks.length,2);assert.equal(reachable.length,0);
 results.tests.push({name:'im_thread_chain_recall_direction',reproduced:true,taskNodes:allTasks.length,tasksReachableFromImThread:reachable.length,reachableKinds:[...new Set([...seen].map(id=>graph[id]?.kind))]});await f.c.close();
}
// The Router cannot return an old task omitted by its fixed recent-task input.
{
 let captured;
 const router=new SuperRouter({projectId:'audit',classify:async prompt=>{captured=JSON.parse(prompt.split('\n').at(-1));return JSON.stringify([{eventId:1,action:'ignore',taskId:null,summary:'',instructions:''}]);}});
 const f=await fixture({router});
 await f.c.transaction(data=>{for(let n=1;n<=81;n++){const id='T'+String(n).padStart(6,'0');const task={id,projectId:'audit',conversationId:'audit-chat',summary:n===1?'Unique oldest task requested again':'Recent task '+n,instructions:'Synthetic',status:'completed',event:event(0,'Synthetic'),inputs:[],reference:'task:synthetic-'+n,threadReference:'thread:synthetic',updatedAt:new Date().toISOString()};data.tasks[id]=task;f.c.taskNode(data,task);}data.nextTask=82;});
 await f.c.ingestIm([event(1,'请继续最早的那个Unique oldest task')],conversations);await f.c.routePending();assert.equal(captured.tasks.length,80);assert.equal(captured.tasks.some(t=>t.id==='T000001'),false);
 results.tests.push({name:'router_recent_task_window',reproduced:true,totalTaskCount:81,tasksGivenToClassifier:captured.tasks.length,oldestTaskAvailable:captured.tasks.some(t=>t.id==='T000001'),routeInterface:['events','tasks','context'],contextRecallToolMountedByRouter:false});await f.c.close();
}
// A publication error is durable, but normal chat continuation/restart has no recovery action.
{
 let releaseCalls=0;
 const f=await fixture({delivery:{deliver:async()=>({merged:true,number:8,head:'b'.repeat(40),url:'https://example.invalid/pr/8',threadId:'github:audit/project:pr:8'})},release:{run:async()=>{releaseCalls++;throw Error('Synthetic release failure, no side effects');}}});
 await f.c.ingestIm([event(1,'请修复并发布')],conversations);await f.c.routePending();await until(()=>f.starts.length===1);f.runs.get('T000001').resolve({finalResponse:'Code ready'});await until(()=>f.c.data.tasks.T000001.releaseStatus==='needs_attention'&&f.c.active.size===0);
 await f.c.ingestIm([event(2,'继续修正 #T000001')],conversations);await f.c.flushOutbox();f.c.kick();await delay(5);assert.equal(releaseCalls,1);
 const preserved=structuredClone(f.c.state);await f.c.close();let restartCalls=0;const recovered=await fixture({state:preserved,release:{run:async()=>{restartCalls++;return{}}}});await delay(5);assert.equal(restartCalls,0);
 results.tests.push({name:'release_needs_attention_chat_recovery',reproduced:true,firstReleaseCalls:releaseCalls,afterContinueReleaseStatus:preserved.superAgent.tasks.T000001.releaseStatus,taskStatus:preserved.superAgent.tasks.T000001.status,restartReleaseCalls:restartCalls,mergedContinuationHint:f.replies.some(t=>t.includes('已合并。请描述新的修正需求'))});await recovered.c.close();
}
await mkdir(new URL('../../verification/super-audit-2026-11-10/',import.meta.url),{recursive:true});
await writeFile(new URL('../../verification/super-audit-2026-11-10/coordinator-audit.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
