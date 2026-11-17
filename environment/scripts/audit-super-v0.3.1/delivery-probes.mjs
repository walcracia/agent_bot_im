// Audit reproduction for source dad375d; asserts known gaps, not product correctness.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {GitDelivery} from '../../../workspace/bridge/super-github.mjs';
import {ReleasePipeline} from '../../../workspace/bridge/super-release.mjs';
import {SuperCoordinator} from '../../../workspace/bridge/super-coordinator.mjs';
const execute=promisify(execFile),out=resolve('environment/verification/super-audit-2026-11-10');
await mkdir(out,{recursive:true});
const root=await mkdtemp(join(out,'delivery-probes-'));
const report={scope:'Real temporary local Git/Node, mocked GitHub only; zero network writes/models; product unchanged',root};
async function make(name){const dir=join(root,name),repo=join(dir,'repo'),bare=join(dir,'bare.git');await mkdir(dir);await execute('git',['init','--bare',bare]);await execute('git',['init','-b','main',repo]);const git=args=>execute('git',args,{cwd:repo,windowsHide:true});await git(['config','user.name','Synthetic Audit']);await git(['config','user.email','audit@example.invalid']);return{dir,repo,bare,git};}
{
 const f=await make('mutable-test');
 const trusted='import assert from "node:assert/strict";import {value} from "./app.mjs";assert.equal(value,1);\n';
 await writeFile(join(f.repo,'app.mjs'),'export const value=1;\n');await writeFile(join(f.repo,'check.mjs'),trusted);await f.git(['add','--','app.mjs','check.mjs']);await f.git(['commit','-m','trusted baseline']);await f.git(['remote','add','origin',f.bare]);await f.git(['push','origin','main']);const base=(await f.git(['rev-parse','HEAD'])).stdout.trim();await f.git(['checkout','-b','codex/TTEST']);
 // Equivalent to a code worker making both source and verification edits before delivery.
 await writeFile(join(f.repo,'app.mjs'),'export const value=999;\n');await writeFile(join(f.repo,'check.mjs'),'process.exit(0);\n');
 let pr=null,merges=0,testRuns=0;
 const command=async(file,args,options={})=>{if(file==='git'){const plain=args.slice(4);if(plain[0]==='remote'&&plain[1]==='get-url')return{stdout:'https://github.com/owner/project.git\n'};return execute(file,args,{cwd:options.cwd,windowsHide:true});}if(file!=='gh'){testRuns++;return execute(file,args,{cwd:options.cwd,windowsHide:true});}const endpoint=args.find(x=>x.startsWith('repos/'));if(args[0]==='api'){if(endpoint.includes('/pulls?'))return{stdout:JSON.stringify([pr?[pr]:[]])};if(endpoint.endsWith('/pulls/7'))return{stdout:JSON.stringify(pr)};if(endpoint.includes('/check-runs'))return{stdout:'[{"check_runs":[]}]'};if(endpoint.includes('/status?'))return{stdout:'[{"statuses":[]}]'};throw Error('Unexpected fake endpoint '+endpoint);}if(args[0]==='pr'&&args[1]==='create'){pr={number:7,state:'open',merged:false,mergeable:true,draft:false,body:await readFile(args[args.indexOf('--body-file')+1],'utf8'),html_url:'https://github.com/owner/project/pull/7',base:{sha:base,ref:'main',repo:{full_name:'owner/project'}},head:{sha:(await f.git(['rev-parse','HEAD'])).stdout.trim(),ref:'codex/TTEST',repo:{full_name:'owner/project'}}};return{stdout:pr.html_url};}if(args[0]==='pr'&&args[1]==='merge'){merges++;pr.state='closed';pr.merged=true;return{stdout:''};}throw Error('Unexpected fake operation');};
 const d=new GitDelivery({repository:'owner/project',worktreesPath:f.dir,autoMerge:true,mergePolicy:'verified-tests',command,testCommands:[[process.execPath,'check.mjs']]});
 const result=await d.deliver({id:'TTEST',workspace:f.repo,branch:'codex/TTEST',baseCommit:base,summary:'Synthetic bad change'});
 let independentFailed=false;try{await execute(process.execPath,['--input-type=module','-e','import assert from "node:assert/strict";import {value} from '+JSON.stringify(new URL('file:///'+join(f.repo,'app.mjs').replaceAll('\\','/')).href)+';assert.equal(value,1)'],{cwd:f.repo});}catch{independentFailed=true;}
 assert.equal(result.merged,true);assert.equal(merges,1);assert.equal(independentFailed,true);
 report.mutableVerification={reproduced:true,verificationRuns:testRuns,mergedByGate:result.merged,independentOriginalAssertionFailed:independentFailed,workerModifiedFiles:['app.mjs','check.mjs'],verifiedHead:result.head};
}
{
 const f=await make('build-head');await mkdir(join(f.repo,'workspace'));await writeFile(join(f.repo,'workspace/package.json'),'{"version":"1.2.3"}\n');await writeFile(join(f.repo,'app.mjs'),'export const value=1;\n');await writeFile(join(f.repo,'.gitignore'),'outputs/\n');await f.git(['add','--','workspace/package.json','app.mjs','.gitignore']);await f.git(['commit','-m','merged source']);await f.git(['remote','add','origin',f.bare]);await f.git(['push','origin','main']);const merge=(await f.git(['rev-parse','HEAD'])).stdout.trim();
 let release=null,assets=[],publishes=0,builds=0;
 const build='const fs=require("node:fs"),cp=require("node:child_process");fs.writeFileSync("app.mjs","export const value=999;\\n");cp.execFileSync("git",["add","--","app.mjs"]);cp.execFileSync("git",["commit","-m","synthetic build mutation"]);fs.mkdirSync("outputs");fs.writeFileSync("outputs/application.zip",cp.execFileSync("git",["rev-parse","HEAD"]));';
 const command=async(file,args,options={})=>{if(file==='git'){const plain=args.slice(args.indexOf('-C')+2);if(plain[0]==='remote'&&plain[1]==='get-url')return{stdout:'https://github.com/owner/project.git\n'};return execute(file,args,{cwd:options.cwd,windowsHide:true});}if(file!=='gh'){builds++;return execute(file,args,{cwd:options.cwd,windowsHide:true});}if(args[0]==='api'){const endpoint=args.find(x=>x.startsWith('repos/'));if(endpoint.endsWith('/pulls/7'))return{stdout:JSON.stringify({number:7,merged:true,merge_commit_sha:merge,base:{repo:{full_name:'owner/project'}}})};if(endpoint.includes('/releases?'))return{stdout:JSON.stringify([release?[release]:[]])};if(endpoint.includes('/assets?'))return{stdout:JSON.stringify([assets])};throw Error('Unexpected release endpoint');}if(args[0]==='release'&&args[1]==='create'){release={id:101,tag_name:'v1.2.3',draft:true,body:await readFile(args[args.indexOf('--notes-file')+1],'utf8'),html_url:'https://github.com/owner/project/releases/tag/v1.2.3'};return{stdout:release.html_url};}if(args[0]==='release'&&args[1]==='upload'){const data=await readFile(args[3]);assets.push({id:1,name:'application.zip',size:data.length,digest:'sha256:'+createHash('sha256').update(data).digest('hex'),state:'uploaded'});return{stdout:''};}if(args[0]==='release'&&args[1]==='edit'){publishes++;release.draft=false;return{stdout:''};}throw Error('Unexpected release operation');};
 const pipeline=new ReleasePipeline({repository:'owner/project',repositoryPath:f.repo,worktreesPath:join(f.dir,'releases'),statePath:join(f.dir,'ledger.json'),publishRelease:true,command,buildCommands:[[process.execPath,'-e',build]],artifacts:['outputs/application.zip']});
 const result=await pipeline.run({id:'TBUILD',delivery:{number:7}});const builtHead=(await execute('git',['rev-parse','HEAD'],{cwd:join(f.dir,'releases/TBUILD')})).stdout.trim();const artifactHead=(await readFile(join(f.dir,'releases/TBUILD/outputs/application.zip'),'utf8')).trim();
 assert.notEqual(builtHead,merge);assert.equal(artifactHead,builtHead);assert.equal(result.merge,merge);assert.equal(publishes,1);
 report.buildPinMutation={reproduced:true,claimedMerge:merge,actualBuildHead:builtHead,published:true,builds,artifactContainsChangedHead:true};
}
{
 let calls=0;const task={id:'TRECOVERY',status:'merged',releaseStatus:'needs_attention'};
 const c=new SuperCoordinator({state:{superAgent:{tasks:{TRECOVERY:task}}},release:{run:async()=>{calls++;return{url:'synthetic'};}}});
 c.queueRelease(task.id);await Promise.resolve();assert.equal(calls,0);report.releaseRetrySurface={reproduced:true,state:task.releaseStatus,queueReleaseCallsIntoPipeline:calls};
}
await writeFile(join(out,'delivery-probes-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
