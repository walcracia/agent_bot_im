/** Fixed regression MCP for verify-agent-reviews.mjs.
 * This executable accepts a trusted, private task configuration. Model input can
 * select only its assigned suite; it never supplies an executable or shell text.
 * Real Agent runs are explicitly opt-in at the preparation/runner entry point.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const configPath=process.argv[2];if(!isAbsolute(configPath??''))throw Error('Absolute trusted tool config required.');
const config=JSON.parse(await readFile(configPath,'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,file)=>{const r=relative(root,file);return r&&!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);};
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const tool={name:'run_regression',description:`Execute only the frozen ${config.suite} regression suite using the fixed Node argv. Returns a real test stdout SHA and unpredictable execution nonce. Call it before reviewing these source files; copy its receipt into review.json.`,inputSchema:{type:'object',properties:{suite:{type:'string',enum:[config.suite]}},required:['suite'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}};
async function verifySnapshot(){
 const manifest=JSON.parse(await readFile(config.manifestPath,'utf8'));
 if(hash(JSON.stringify(manifest.files))!==config.sourceManifestSHA256)throw Error('Manifest identity changed.');
 for(const file of manifest.files){const path=resolve(config.snapshotRoot,file.path);if(!inside(config.snapshotRoot,path))throw Error('Snapshot scope changed.');const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||hash(await readFile(path))!==file.sha256)throw Error('Frozen snapshot source changed.');}
 if(hash(await readFile(config.toolPath))!==config.toolSHA256)throw Error('Regression tool source changed.');
}
async function runSuite(arguments_){
 if(!config.sourceFrozen||!Array.isArray(config.tests)||!config.tests.length)throw Error('Source is not frozen and integration suite is not finalized.');
 if(!arguments_||Object.keys(arguments_).length!==1||arguments_.suite!==config.suite)throw Error('Only the assigned fixed suite is allowed.');
 await verifySnapshot();
 const nonce=randomUUID(),started=new Date().toISOString();
 const stem=config.agentId+'-'+nonce,stdoutPath=join(config.auditDirectory,stem+'.stdout.log'),stderrPath=join(config.auditDirectory,stem+'.stderr.log');
 const env={};for(const name of ['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE'])if(process.env[name])env[name]=process.env[name];
 if(!isAbsolute(config.powershellCommand??'')||!(await lstat(config.powershellCommand)).isFile())throw Error('Trusted PowerShell 7 was not configured for the Windows test environment.');
 const inheritedPath=env.PATH??env.Path??'';delete env.Path;env.PATH=[dirname(config.nodeCommand),dirname(config.powershellCommand),inheritedPath].join(delimiter);
 const child=spawn(config.nodeCommand,['--test',...config.tests],{cwd:config.snapshotRoot,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env});
 const stdout=[],stderr=[];child.stdout.on('data',x=>stdout.push(x));child.stderr.on('data',x=>stderr.push(x));
 const exitCode=await new Promise((yes,no)=>{child.once('error',no);child.once('close',yes);});
 const output=Buffer.concat(stdout),errors=Buffer.concat(stderr);await writeFile(stdoutPath,output,{flag:'wx',mode:0o600});await writeFile(stderrPath,errors,{flag:'wx',mode:0o600});
 await verifySnapshot();
 const receipt={agentId:config.agentId,suite:config.suite,nonce,exitCode,passed:exitCode===0,started,finished:new Date().toISOString(),stdoutPath,stdoutSHA256:hash(output),stderrPath,stderrSHA256:hash(errors),sourceManifestSHA256:config.sourceManifestSHA256,tests:config.tests,nodeCommand:config.nodeCommand,powershellCommand:config.powershellCommand};
 await writeFile(join(config.auditDirectory,stem+'.receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});await appendFile(config.auditPath,JSON.stringify({method:'tools/call',name:'run_regression',arguments:arguments_,...receipt})+'\n',{mode:0o600});
 return {...receipt,stdoutTail:output.toString('utf8').slice(-24000),stderrTail:errors.toString('utf8').slice(-4000)};
}
let chain=Promise.resolve();
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{if(!line.trim())return;let r;try{r=JSON.parse(line);}catch{return;}
if(r.id===undefined)return;
if(r.method==='initialize')return send(r.id,{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'teamplay-native-regression',version:'1.0.0'}});
if(r.method==='tools/list')return send(r.id,{tools:[tool]});
if(r.method==='ping')return send(r.id,{});
if(r.method==='tools/call'&&r.params.name==='run_regression'){chain=chain.then(async()=>{try{const result=await runSuite(r.params.arguments);send(r.id,{content:[{type:'text',text:JSON.stringify(result)}]});}catch(e){send(r.id,{isError:true,content:[{type:'text',text:e.message}]});}});return;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Unknown fixed regression method.'}})+'\n');
});
