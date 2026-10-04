import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const base=path.resolve('scripts/skill-governance'), payload=path.join(base,'payload');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"skill-governance-中文 ' "));
const shell='C:/Program Files/Git/bin/bash.exe';
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const forward=s=>s.replaceAll('\\','/');
async function run(args,cwd=temp){
 const command=args.map(a=>quote(forward(a))).join(' ');
 const child=spawn(shell,['--noprofile','--norc','-c',command],{cwd,windowsHide:true});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const status=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 return {status,stdout,stderr};
}
const results=[];
async function check(name,fn){try{const detail=await fn();results.push({name,pass:true,detail});console.log(name,'PASS',JSON.stringify(detail));}catch(e){results.push({name,pass:false,error:e.message});console.error(name,'FAIL',e.message);}}
const fast=path.join(payload,'fastcopy-copy/scripts/fcopy.mjs');
await check('fastcopy-native-gitbash-copy-filter-sync-delete',async()=>{
 const src=path.join(temp,'源 source'),dst=path.join(temp,'目标 target');fs.mkdirSync(src);fs.mkdirSync(dst);
 fs.writeFileSync(path.join(src,"quote ' 中文.txt"),'known-content-123');fs.writeFileSync(path.join(src,'skip.tmp'),'excluded');
 let result=await run(['node',fast,'--src',src+path.sep,'--dst',dst,'--include','*.txt']);
 assert.equal(result.status,0,result.stderr+result.stdout);
 assert.equal(fs.readFileSync(path.join(dst,"quote ' 中文.txt"),'utf8'),'known-content-123');assert.ok(!fs.existsSync(path.join(dst,'skip.tmp')));
 fs.writeFileSync(path.join(dst,'extra.txt'),'remove-by-sync');
 // Both resolved destructive targets were created beneath this test's exact temp root.
 for(const target of [src,dst])assert.ok(fs.realpathSync(target).startsWith(fs.realpathSync(temp)+path.sep));
 result=await run(['node',fast,'--src',src+path.sep,'--dst',dst,'--mode','sync','--include','*.txt']);
 assert.equal(result.status,0,result.stderr+result.stdout);assert.ok(!fs.existsSync(path.join(dst,'extra.txt')));
 result=await run(['node',fast,'--src',dst,'--mode','delete','--no-confirm-del']);
 assert.equal(result.status,0,result.stderr+result.stdout);assert.ok(!fs.existsSync(dst));
 result=await run(['node',fast,'--src',path.join(temp,'missing'),'--dst',dst]);assert.equal(result.status,2);
 return 'copied exact bytes with spaces/CJK/apostrophe; filter respected; sync removed extra; delete scoped to fixture; error=2';
});
await check('matlab-native-gitbash-code-script-exit',async()=>{
 const file=path.join(payload,'matlab-r2025b/scripts/matlab-run.mjs');
 const before=new Set(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('mybuddy_matlab_')));
 let result=await run(['node',file,'--cwd',temp,'--code',"assert(mean([1 2 3 4 5])==3); fprintf('GOVERNANCE_MATLAB_OK');"]);
 assert.equal(result.status,0,result.stderr+result.stdout);assert.ok(result.stdout.includes('GOVERNANCE_MATLAB_OK'));
 const script=path.join(temp,'quoted_script.m');fs.writeFileSync(script,"assert(isfolder(pwd)); fprintf('GOVERNANCE_SCRIPT_OK');\n");
 result=await run(['node',file,'--script',script,'--cwd',temp]);assert.equal(result.status,0,result.stderr+result.stdout);assert.ok(result.stdout.includes('GOVERNANCE_SCRIPT_OK'));
 result=await run(['node',file,'--code',"error('Governance:Expected','intentional smoke failure');"]);
 assert.notEqual(result.status,0);assert.ok((result.stderr+result.stdout).includes('intentional smoke failure'));
 assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('mybuddy_matlab_')&&!before.has(n)),[]);
 return {code:'mean=3',script:'executed',failureExit:result.status,tempCleanup:true};
});
fs.writeFileSync(path.join(base,'native-smoke.json'),JSON.stringify({temp,results},null,2)+'\n');
process.exitCode=results.some(r=>!r.pass)?1:0;
