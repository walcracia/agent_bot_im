// Audit reproduction for source dad375d; asserts known gaps, not product correctness.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, writeFile, realpath, rm, readFile } from 'node:fs/promises';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createTaskDaemon, taskToolToken } from '../../../workspace/bridge/super-daemon.mjs';
import { createMcpHandler } from '../../../workspace/bridge/super-mcp.mjs';

const parent=resolve(dirname(fileURLToPath(import.meta.url)),'../../verification/super-audit-2026-11-10');
await mkdir(parent,{recursive:true});
const root=await mkdtemp(join(parent,'runtime-fixture-'));
const token='synthetic-audit-token-'.repeat(3),taskId='T810001',workspace=join(root,'workspace'),runsPath=join(root,'runs');
await mkdir(workspace);await mkdir(runsPath);
let status='ready';
const pool={records:new Map(),prepare:async()=>({workspace,branch:'codex/audit',baseCommit:'a'.repeat(40)}),inspect:async()=>({workspace,branch:'codex/audit',running:false,status,diff:''}),persist:async()=>{},input:async()=>({}),cancel:async()=>{status='cancelled';return{processTreeStopped:true};},close:async()=>{}};
const daemon=createTaskDaemon({token,pool,runsPath,commands:{brief:{file:process.execPath,args:['-e','setTimeout(()=>process.stdout.write("completed"),450)']}}});
await new Promise(done=>daemon.server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+daemon.server.address().port;
const call=async(path,data,auth=token)=>{const r=await fetch(origin+path,{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify({taskId,...data})});return {status:r.status,data:await r.json()};};
const output={scope:'Isolated HTTP, synthetic task/pool and real bounded Node child; zero models or production state'};
const req=createRequire(import.meta.url),fsp=req('node:fs/promises'),originalRead=fsp.readFile;
try{
 const handle=createMcpHandler({url:origin,token:taskToolToken(token,taskId),taskId});let resolved=false;const start=Date.now();
 const execution=handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'exec',arguments:{command:'brief',args:[]}}}).then(value=>{resolved=true;return value;});
 await new Promise(done=>setTimeout(done,180));assert.equal(resolved,false);
 const response=await execution;const payload=JSON.parse(response.result.content[0].text);assert.equal(payload.code,0);assert.equal(payload.stdout,'completed');
 output.synchronous_remote_tool={resolvedBeforeCompletion:false,durationMs:Date.now()-start,returnedOnlyFinalResult:true,payload};
 // Delay precisely the compare-before-write read to model an in-flight filesystem operation.
 const target=join(workspace,'source.txt');await writeFile(target,'original');
 let enteredResolve,release;const entered=new Promise(done=>enteredResolve=done),gate=new Promise(done=>release=done);
 let intercepted=false;fsp.readFile=async function(path,...args){if(String(path)===target&&!intercepted){intercepted=true;enteredResolve();await gate;}return originalRead(path,...args);};syncBuiltinESMExports();
 const writing=call('/tools/write',{path:'source.txt',text:'changed after cancellation',expectedSha256:createHash('sha256').update('original').digest('hex')},taskToolToken(token,taskId));
 await entered;
 const cancellation=await call('/cancel',{});assert.equal(cancellation.data.processTreeStopped,true);
 const atAcknowledgement=await originalRead(target,'utf8');assert.equal(atAcknowledgement,'original');
 release();const writeResult=await writing;const after=await originalRead(target,'utf8');assert.equal(writeResult.status,200);assert.equal(after,'changed after cancellation');
 output.write_cancel_race={faultInjection:'Delay same-process readFile at compare-before-write; no product changes',cancelAcknowledged:cancellation.data,contentAtCancelAcknowledgement:atAcknowledgement,writeResponseStatus:writeResult.status,contentAfterWrite:after};
 await writeFile(join(parent,'runtime-probes.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
}finally{fsp.readFile=originalRead;syncBuiltinESMExports();await new Promise(done=>daemon.server.close(done));const canonical=await realpath(root);assert.equal(dirname(canonical),await realpath(parent));assert.ok(relative(parent,canonical).startsWith('runtime-fixture-'));await rm(canonical,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
