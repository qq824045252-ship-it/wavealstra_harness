/** Real-model worker from a copied standalone runtime, not from repository node_modules. */
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,cpSync,copyFileSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';import {resolve,join,dirname} from 'node:path';import {randomBytes} from 'node:crypto';
const root=process.cwd(),temp=mkdtempSync(join(tmpdir(),'pi099-portable-worker-')),main=join(temp,'out/main'),agentDir=join(temp,'agent'),work=join(temp,'work');
mkdirSync(agentDir,{recursive:true});mkdirSync(work,{recursive:true});
const report={kind:'real-model-isolated-portable-worker',startedAt:new Date().toISOString(),passed:false};
const output=resolve('artifacts/pi099-closeout/portable-worker.json');mkdirSync(dirname(output),{recursive:true});
const runtimeSource=process.argv[2]?resolve(process.argv[2]):resolve('out/main/capabilities/subagent/runtime');
cpSync(runtimeSource,join(main,'capabilities/subagent/runtime'),{recursive:true,dereference:true});
for(const name of ['capabilities/subagent/worker-launcher.mjs','capabilities/subagent/vendor/context-projection.mjs','capabilities/subagent/vendor/command-code.mjs','agent/request-transport.mjs']){const dest=join(main,name);mkdirSync(dirname(dest),{recursive:true});copyFileSync(resolve('src/main',name),dest);}
cpSync(resolve('node_modules/jiti'),join(temp,'node_modules/jiti'),{recursive:true,dereference:true});
for(const name of ['auth.json','models.json','models-store.json']){const source=join(homedir(),'.mybuddy',name);if(existsSync(source))copyFileSync(source,join(agentDir,name));}
writeFileSync(join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'commandcode',defaultModel:'deepseek/deepseek-v4.1-flash',enabledModels:['commandcode/deepseek/deepseek-v4.1-flash'],compaction:{enabled:false},retry:{enabled:false,maxRetries:0}}));
const nonce=randomBytes(10).toString('hex');writeFileSync(join(work,'input.json'),JSON.stringify({nonce,values:[17,42,-9,6]}));
const child=spawn(process.execPath,[join(main,'capabilities/subagent/worker-launcher.mjs'),join(main,'capabilities/subagent/runtime/pi-runtime.mjs'),'--mode','rpc','--no-extensions','--no-approve','--tools','read,ls','--model','commandcode/deepseek/deepseek-v4.1-flash','--thinking','high','--session-dir',join(temp,'sessions'),'--session-id','portable-worker-proof'],{cwd:work,env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_SKIP_VERSION_CHECK:'1',PI_OFFLINE:'1'},stdio:['pipe','pipe','pipe'],windowsHide:true});
let text='',stderr='',events=[];child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>{text+=chunk;let pos;while((pos=text.indexOf('\n'))>=0){const line=text.slice(0,pos);text=text.slice(pos+1);try{events.push(JSON.parse(line));}catch{}}});child.stderr.on('data',chunk=>{stderr+=chunk;});
const wait=ms=>new Promise(r=>setTimeout(r,ms));async function until(test,ms=20000){const end=Date.now()+ms;while(!test()){if(child.exitCode!==null)throw Error('Worker exited '+child.exitCode+': '+stderr.slice(-2200));if(Date.now()>end)throw Error('Worker timed out: '+stderr.slice(-1200));await wait(100);}}
try{
 child.stdin.write(JSON.stringify({type:'get_state',id:'state'})+'\n');await until(()=>events.some(e=>e.id==='state'&&e.success===true));report.rpcReady=true;
 child.stdin.write(JSON.stringify({type:'prompt',id:'prompt',message:'Read input.json in the current directory with the read tool. Calculate the sum of values. Reply only RESULT_JSON={"nonce":"the exact nonce read from the file","sum":the numeric sum}. You must read the actual file; do not guess.'})+'\n');
 await until(()=>events.some(e=>e.type==='agent_settled'),80000);
 const messages=events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant').map(e=>e.message);
 const answer=messages.at(-1)?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'';
 const match=/RESULT_JSON\s*=\s*(\{[^\n]*\})/.exec(answer);assert(match,'No independently verifiable result: '+answer.slice(-1200));
 const result=JSON.parse(match[1]);assert.deepEqual(result,{nonce,sum:56});
 assert(events.some(e=>e.type==='tool_execution_start'&&e.toolName==='read'),'The worker did not read the real test file');
 assert(!messages.some(m=>m.stopReason==='error'),'Worker had a provider/runtime error');
 Object.assign(report,{passed:true,result,toolCalls:events.filter(e=>e.type==='tool_execution_end').map(e=>({tool:e.toolName,isError:e.isError})),externalPiInstallRequired:false,sourceRepositoryCwdUsed:false});console.log('PASS native portable Pi worker completed a real-model read-and-calculate task');
}catch(e){report.error=e.message;report.stderr=stderr.slice(-3500);console.error(report.error);}
finally{
 child.stdin.end();await wait(300);if(child.exitCode===null)child.kill();await wait(400);
 try{rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:300});report.temporaryCredentialsRemoved=true;}catch(e){report.cleanupError=e.message;report.passed=false;}
 report.finishedAt=new Date().toISOString();writeFileSync(output,JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
}
