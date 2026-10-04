/** Real provider + actual packaged desktop + composer/IPC/DOM, with isolated credentials and workspace. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto'),net=require('node:net');
const root=path.resolve(__dirname,'..');process.chdir(root);
const out=path.join(root,'artifacts/pi0992-memory/memory-live');fs.mkdirSync(out,{recursive:true});
// A retried bridge invocation must never run the same paid-model acceptance twice.
const lock=path.join(out,'acceptance.lock');
try {const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));fs.closeSync(fd);}
catch(error){if(error.code==='EEXIST'){console.error('Native desktop acceptance is already running; refusing duplicate launch.');process.exit(2);}throw error;}
process.on('exit',()=>{try{if(JSON.parse(fs.readFileSync(lock,'utf8')).pid===process.pid)fs.unlinkSync(lock);}catch{}});
const report={kind:'pi0992-real-model-memory-ipc-session',harnessPid:process.pid,startedAt:new Date().toISOString(),tests:[],status:'running'};
const save=()=>fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));
const wait=ms=>new Promise(r=>setTimeout(r,ms));const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi0992-memory-live-'));
const home=path.join(temp,'profile'),agentDir=path.join(home,'.mybuddy'),workspace=path.join(temp,'workspace');
fs.mkdirSync(agentDir,{recursive:true});fs.mkdirSync(workspace,{recursive:true});
const sourceHome=path.join(os.homedir(),'.mybuddy');
for(const name of ['auth.json','models.json','models-store.json'])if(fs.existsSync(path.join(sourceHome,name)))fs.copyFileSync(path.join(sourceHome,name),path.join(agentDir,name));
for(const dir of ['AppData/Roaming','AppData/Local'])fs.mkdirSync(path.join(home,dir),{recursive:true});
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'commandcode',defaultModel:'deepseek/deepseek-v4.1-flash',defaultThinkingLevel:'high',enabledModels:['commandcode/deepseek/deepseek-v4.1-flash'],memoryEnabled:true,memoryGatewayEnabled:false,remoteAccessEnabled:false,closeToTray:false,theme:'light',language:'zh-CN',permissionMode:'auto'}));
fs.writeFileSync(path.join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[path.join(root,'scripts/pi099-workflow-server.mjs'),workspace,root],exposure:'codemode',timeout:15}}}));
const nonce=crypto.randomBytes(12).toString('hex'),values=Array.from({length:13},()=>crypto.randomInt(-500,1000));
fs.writeFileSync(path.join(workspace,'sample.json'),JSON.stringify({nonce,values}));
const validator=path.join(workspace,'validate.cjs');
fs.writeFileSync(validator,`const fs=require('node:fs'),p=require('node:path');const expected=${JSON.stringify(nonce)};let input;try{input=JSON.parse(fs.readFileSync(p.join(__dirname,'repair.json'),'utf8'));}catch{}const ok=input?.enabled===true&&input?.nonce===expected;fs.appendFileSync(p.join(__dirname,'validator-audit.jsonl'),JSON.stringify({code:ok?0:7,at:Date.now()})+'\\n');if(!ok){console.error('INPUT_INVALID: repair.json must contain enabled=true and the exact expected nonce documented in validate.cjs. Do not change the validator.');process.exit(7);}fs.writeFileSync(p.join(__dirname,'validated.json'),JSON.stringify({ok:true,nonce:expected,source:'real-node'}));console.log('VALIDATED_OK');`);
const validatorHash=crypto.createHash('sha256').update(fs.readFileSync(validator)).digest('hex');
fs.mkdirSync(path.join(agentDir,'agents'),{recursive:true});
fs.writeFileSync(path.join(agentDir,'agents/worker.md'),'---\nname: worker\ndescription: Read-only native Pi acceptance worker\ntools: read, ls\nmodel: commandcode/deepseek/deepseek-v4.1-flash\n---\nRead the actual task input. Report exact values; do not guess.');
let proc,socket,log;let id=0;const pending=new Map();
function rpc(method,params={}){return new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout: '+method));},20000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});}
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
function inventory(){const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())walk(f);else if(/\.tsx?$/.test(e.name))files.push({path:path.relative(root,f).replaceAll('\\','/'),bytes:fs.statSync(f).size});}}walk(path.join(root,'src'));files.sort((a,b)=>b.bytes-a.bytes||a.path.localeCompare(b.path));return {total:files.length,totalBytes:files.reduce((n,f)=>n+f.bytes,0),largest:files.slice(0,3)};}
const listing=path.join(workspace,'listing');fs.mkdirSync(listing,{recursive:true});
fs.writeFileSync(path.join(listing,'alpha-'+nonce.slice(0,6)+'.txt'),'listing fixture alpha');
fs.writeFileSync(path.join(listing,'beta-'+nonce.slice(0,6)+'.md'),'listing fixture beta');
fs.mkdirSync(path.join(listing,'nested'));fs.writeFileSync(path.join(listing,'nested','child.txt'),'not requested');
const missing=path.join(workspace,'missing-'+nonce+'.txt');
const slow=path.join(workspace,'slow.cjs'),slowAudit=path.join(workspace,'slow-audit.jsonl');
fs.writeFileSync(slow,"const fs=require('node:fs');fs.appendFileSync("+JSON.stringify(slowAudit)+",JSON.stringify({started:Date.now()})+'\\n');setTimeout(()=>console.log('TOO_LATE'),60000);");
const valuesForMemory={global:'G-'+crypto.randomBytes(6).toString('hex'),a:'A-'+crypto.randomBytes(6).toString('hex'),b:'B-'+crypto.randomBytes(6).toString('hex'),updated:'U-'+crypto.randomBytes(6).toString('hex'),private:'T-'+crypto.randomBytes(6).toString('hex')};
let fixtureIds;
const question='仅依据当前可访问的长期记忆回答：本项目的标定编号是什么？有记录就只输出编号，没有就只输出 UNKNOWN。不要搜索文件或网络，不要猜测。';
const cases=[
 {name:'global-memory-auto-recall',project:'a',prompt:'仅依据可访问的长期记忆回答：全局参考编号是什么？有就只输出编号，没有就只输出 UNKNOWN。不要调用工具。',expected:()=>valuesForMemory.global},
 {name:'project-a-recall-no-b-leak',project:'a',prompt:question,expected:()=>valuesForMemory.a,forbidden:()=>[valuesForMemory.b,valuesForMemory.private]},
 {name:'project-b-recall-no-a-leak',project:'b',prompt:question,expected:()=>valuesForMemory.b,forbidden:()=>[valuesForMemory.a,valuesForMemory.private]},
 {name:'updated-memory-new-task',project:'a',before:async()=>{await evaluate('window.api.memory.update('+JSON.stringify({id:fixtureIds.aMemory,content:'本项目的标定编号是 '+valuesForMemory.updated+'。',changedBy:'user'})+')');},prompt:question,expected:()=>valuesForMemory.updated,forbidden:()=>[valuesForMemory.a]},
 {name:'forgotten-memory-new-task-is-unknown',project:'a',before:async()=>{await evaluate('window.api.memory.forget('+JSON.stringify(fixtureIds.aMemory)+')');},prompt:question,expected:()=> 'UNKNOWN',forbidden:()=>[valuesForMemory.a,valuesForMemory.updated]},
 {name:'sibling-task-private-memory-isolated',project:'a',prompt:'仅依据当前可访问的长期记忆回答：任务专有检测编号是什么？有就只输出编号，没有就只输出 UNKNOWN。不要搜索文件或网络，不要猜测。',expected:()=> 'UNKNOWN',forbidden:()=>[valuesForMemory.private]},
 {name:'disabled-memory-not-auto-injected',project:'b',before:async()=>{await evaluate('window.api.agent.updateAppSettings({memoryEnabled:false})');},prompt:'仅依据当前可访问的长期记忆回答：全局参考编号是什么？有就只输出编号，没有就只输出 UNKNOWN。不要调用工具，不要猜测。',expected:()=> 'UNKNOWN',forbidden:()=>[valuesForMemory.global]},
];
(async()=>{try{
 const exe=process.env.PI_NATIVE_DESKTOP_EXE||JSON.parse(fs.readFileSync(path.join(root,'artifacts/pi0992-memory/accepted-build.json'),'utf8')).executable;assert(fs.existsSync(exe),'Verified portable executable is missing');report.executable=exe;
 const port=await freePort();report.port=port;log=fs.openSync(path.join(out,'desktop.log'),'w');
 const env={...process.env,USERPROFILE:home,HOME:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local')};delete env.ELECTRON_RUN_AS_NODE;
 proc=cp.spawn(exe,['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--disable-background-timer-throttling','--disable-renderer-backgrounding'],{cwd:temp,env,stdio:['ignore',log,log],windowsHide:true});report.pid=proc.pid;save();
 let target;for(let i=0;i<120;i++){try{const targets=await fetch('http://127.0.0.1:'+port+'/json/list').then(r=>r.json());target=targets.find(t=>t.type==='page'&&t.url.includes('index.html'))||targets.find(t=>t.type==='page'&&!t.url.startsWith('devtools'));if(target)break;}catch{}if(proc.exitCode!==null)throw Error('Desktop exited before readiness: '+proc.exitCode);await wait(250);}assert(target,'Desktop CDP page unavailable');
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',ev=>{const r=JSON.parse(ev.data),p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result);});
 await rpc('Runtime.enable');await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 let ready=false;for(let i=0;i<120;i++){ready=await evaluate('Boolean(window.api?.agent&&document.querySelector("textarea"))');if(ready)break;await wait(250);}assert(ready,'Desktop composer unavailable');
 await evaluate(`(()=>{window.__pi099={current:null,errors:[]};window.addEventListener('error',e=>window.__pi099.errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__pi099.errors.push(String(e.reason)));window.api.agent.onEvent(e=>{const p=window.__pi099.current;if(!p)return;if(e.taskId)p.taskId=e.taskId;if(e.type==='assistant_start'){p.started=true;p.messageId=e.messageId;p.done=false;p.error=undefined;if(p.awaitingApprovalRestart){p.awaitingApprovalRestart=false;p.approvalRestarted=true;}}if(e.type==='thinking_delta')p.thinkingEvents++;if(e.type==='text_delta'){p.textEvents++;p.receivedText+=e.delta||'';}if(e.type==='tool_start')p.tools.push({id:e.toolCallId,name:e.tool,parent:e.parentToolCallId,summary:e.summary,status:'running'});if(e.type==='tool_update'){const t=p.tools.find(t=>t.id===e.toolCallId);if(t){if(e.status)t.status=e.status;if(e.output)t.output=String(e.output).slice(-1800);}}if(e.type==='assistant_end'){if(p.awaitingApprovalRestart){p.approvalAbortObserved=true;return;}p.done=true;p.error=e.error;p.finishedAt=Date.now();}});return true;})()`);
 fixtureIds=await evaluate(`(async()=>{
  const a=await window.api.db.createProject({name:'Memory regression A'}),b=await window.api.db.createProject({name:'Memory regression B'});
  if(!a.ok||!b.ok)throw Error('Fixture project creation failed');
  const projectA=a.project.id,projectB=b.project.id;
  await window.api.db.upsertTask({id:'memory-private-owner',title:'Isolated private owner',projectId:projectA,updatedAt:Date.now()});
  const add=(title,content,scopeType,scopeId)=>window.api.memory.create({kind:'fact',title,content,scopeType,scopeId,explicit:true,sourceType:'user',importance:2,confidence:1});
  const global=await add('全局参考编号','全局参考编号是 '+${JSON.stringify(valuesForMemory.global)}+'。','global');
  const am=await add('本项目标定编号','本项目的标定编号是 '+${JSON.stringify(valuesForMemory.a)}+'。','project',projectA);
  const bm=await add('本项目标定编号','本项目的标定编号是 '+${JSON.stringify(valuesForMemory.b)}+'。','project',projectB);
  const tm=await add('任务专有检测编号','任务专有检测编号是 '+${JSON.stringify(valuesForMemory.private)}+'。','task','memory-private-owner');
  return {projectA,projectB,aMemory:am.id,bMemory:bm.id,globalMemory:global.id,privateMemory:tm.id};
 })()`);report.fixtureIds=fixtureIds;save();
 for(const task of cases.filter(c=>!process.argv.includes('--only')||c.name===process.argv[process.argv.indexOf('--only')+1])){
  const row={name:task.name,status:'running',startedAt:new Date().toISOString()};report.tests.push(row);save();
  try{
   await evaluate(`window.__pi099.current={tools:[],thinkingEvents:0,textEvents:0,receivedText:'',started:false,done:false}`);
   if(task.before)await task.before();
   const taskId='memory-live-'+crypto.randomUUID(),messageId='assistant-'+crypto.randomUUID();
   const projectId=task.project==='a'?fixtureIds.projectA:fixtureIds.projectB;
   await evaluate('window.api.db.upsertTask('+JSON.stringify({id:taskId,title:task.name,projectId,updatedAt:Date.now(),permissionMode:'auto',modelId:'commandcode/deepseek/deepseek-v4.1-flash'})+')');
   const request={taskId,assistantMessageId:messageId,userMessageId:'user-'+crypto.randomUUID(),text:task.prompt,modelId:'commandcode/deepseek/deepseek-v4.1-flash',permissionMode:'auto'};
   await evaluate('(()=>{window.__pi099.current.taskId='+JSON.stringify(taskId)+';window.api.agent.prompt('+JSON.stringify(request)+').then(r=>{window.__pi099.current.promptResult=r;}).catch(e=>{window.__pi099.current.error=String(e);window.__pi099.current.done=true;});return true;})()');
   let state;for(let i=0;i<240;i++){
    await wait(1000);
    state=await evaluate('window.__pi099.current');row.progress={elapsedMs:Date.now()-Date.parse(row.startedAt),started:state.started,done:state.done,toolCount:state.tools?.length,lastTool:state.tools?.at(-1)?.name,textEvents:state.textEvents};save();
    if(i===20&&!state.started)throw Error('Composer did not start a task');
    if(state.done&&(!row.approvalSubmitted||state.approvalRestarted))break;
   }
   if(!state?.done){if(state?.taskId)await evaluate('window.api.agent.abort('+JSON.stringify(state.taskId)+')');throw Error('Desktop task timed out');}
   assert(!state.error,'Desktop assistant failed: '+state.error);assert(state.textEvents>0,'No streamed text events');
   row.tools=state.tools;row.finalText=state.receivedText;row.streaming={thinkingEvents:state.thinkingEvents,textEvents:state.textEvents};row.taskId=state.taskId;save();assert(state.receivedText.includes(task.expected()),'Expected memory answer missing: '+task.name);
   for(const forbidden of task.forbidden?.()||[])assert(!state.receivedText.includes(forbidden),'Out-of-scope or stale memory leaked');
   row.result={expected:task.expected(),noForbiddenValues:true,toolsUsed:state.tools.length};row.tools=state.tools;row.streaming={thinkingEvents:state.thinkingEvents,textEvents:state.textEvents};row.taskId=state.taskId;row.finalText=state.receivedText;row.finishedAtMs=state.finishedAt;
   row.history=await evaluate('(async()=>{const p=window.__pi099.current,h=await window.api.agent.loadTaskHistory(p.taskId);const m=h.messages.filter(m=>m.role==="assistant").at(-1);return {found:!!m,textChars:m?.text?.length||0};})()');assert(row.history.found&&row.history.textChars>0,'Completed answer was not persisted');
   row.status='passed';console.log('PASS actual desktop '+task.name);
  }catch(e){row.status='failed';row.error=e.message;try{row.probe=await evaluate('window.__pi099.current');}catch{}console.error('FAIL actual desktop '+task.name+': '+e.message);}
  finally{row.finishedAt=new Date().toISOString();save();try{const s=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,task.name+'.png'),Buffer.from(s.data,'base64'));}catch{} }
 }
 const sessionAudit=[];
 function auditSessions(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())auditSessions(file);else if(e.name.endsWith('.jsonl')){const rows=fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));const controls=rows.filter(r=>/mybuddy_completion_gate|mybuddy_request_user_input_recovery/.test(r.customType||r.message?.customType||''));assert.equal(controls.length,0,'retired host control message was persisted');assert(!rows.some(r=>r.message?.customType==='mybuddy.context-capsule'||r.customType==='mybuddy.context-capsule'),'request-only memory capsule was persisted');sessionAudit.push({file:e.name,entries:rows.length,userMessages:rows.filter(r=>r.message?.role==='user').length,retiredControlMessages:controls.length});}}}
 auditSessions(path.join(agentDir,'sessions'));report.sessionAudit=sessionAudit;assert(sessionAudit.length>0,'No real native session history found');
 report.rendererErrors=await evaluate('window.__pi099.errors');assert.equal(report.rendererErrors.length,0,'Renderer errors occurred');report.status=report.tests.every(t=>t.status==='passed')?'passed':'failed';
}catch(e){report.status='failed';report.error=e.stack;}
finally{
 if(socket){try{await rpc('Browser.close');}catch{}socket.close();}for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('CDP closed'));}pending.clear();
 if(proc){await wait(700);if(proc.exitCode===null){try{cp.execFileSync('C:/Windows/System32/taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:5000});}catch{}}}
 if(log!==undefined)fs.closeSync(log);try{fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:300});report.temporaryCredentialsRemoved=true;}catch(e){report.cleanupError=e.message;report.status='failed';}
 report.finishedAt=new Date().toISOString();save();process.exitCode=report.status==='passed'?0:1;console.log(JSON.stringify({status:report.status,report:path.join(out,'results.json')},null,2));
}})();
