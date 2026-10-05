/** Actual Electron + renderer + IPC + Durable + Pi HTTP provider + real MCP, all in an isolated profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-durable-desktop-'));
const home = path.join(temp, 'profile'), agentDir = path.join(home, '.mybuddy'), workspace = path.join(temp, 'workspace');
const out = path.join(root, 'out/tests/durable-bot-desktop'); fs.mkdirSync(out, {recursive:true});
for (const dir of [agentDir,workspace,path.join(home,'AppData/Roaming'),path.join(home,'AppData/Local'),path.join(agentDir,'plugins/mcp'),path.join(agentDir,'modes/design')]) fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(workspace,'seed.json'),JSON.stringify({nonce:'durable-fixture',values:[8,13]}));
fs.writeFileSync(path.join(agentDir,'modes/design/goal.md'),'PRESERVED_USER_BOT_PROMPT');
fs.writeFileSync(path.join(agentDir,'modes/design/policy.json'),JSON.stringify({toolPolicy:{mode:'hard',deny:['write','bash','mcp__fixture__read_seed']},mcpPolicy:{mode:'hard',deny:['fixture']},artifactPolicy:{mode:'hard',deny:['py'],allow:['pdf']},presets:[{id:'kept',label:'保留的预设',promptAddon:'PRESERVED_TAG',providerMcpIds:['nonexistent'] },{id:'general',label:'通用设计'},{id:'web-prototype',label:'网页原型 · Penpot',promptAddon:'PRESERVED_PENPOT_PROMPT'}]}));
fs.writeFileSync(path.join(agentDir,'plugins/mcp/mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[path.join(root,'scripts/pi-codemode-auto-fixture.mjs'),workspace],modes:['working'],exposure:'direct',timeout:15}}}));
const requests=[];
let releasePresentationStart, releasePresentationFinish;
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  let body;try{body=JSON.parse(raw);}catch{res.writeHead(400);res.end();return;}
  requests.push(body);
  const extraction=JSON.stringify(body.messages).includes('conversationTurns');
  const lastUser=body.messages.findLastIndex(m=>m.role==='user');
  if(!extraction&&JSON.stringify(body.messages[lastUser]).includes('BOT_FAIL')){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'BOT_FIXTURE_REJECTION',type:'invalid_request_error'}}));return;}
  const recent=body.messages.slice(lastUser+1);
  const native=body.tools?.some(t=>t.function?.name==='write');
  let tool;
  if(!recent.some(m=>m.role==='tool')) tool = native
    ? {name:'mcp__fixture__read_seed',arguments:'{}'}
    : {name:'codemode',arguments:JSON.stringify({code:'const r=await tools.mcp__fixture__read_seed({}); text(r); await tools.write({path:"proof.py",content:"DURABLE_PROOF"}); await tools.write({path:".scratch/visible.py",content:"HIDDEN_DIRECTORY_PROOF"}); await tools.write({path:' + JSON.stringify(path.join(temp,'outside.py')) + ',content:"OUTSIDE_PROOF"}); await tools.bash({command:"printf DURABLE_SHELL"});'})};
  else if(native && !recent.some(m=>m.role==='assistant'&&m.tool_calls?.some(t=>t.function.name==='write')))tool={name:'write',arguments:JSON.stringify({path:'proof.py',content:'DURABLE_PROOF'})};
  if (String(JSON.stringify(body.messages[lastUser])).includes('BOT_HOLD') && !recent.some(m=>m.role==='tool')) tool={name:'codemode',arguments:JSON.stringify({code:'await tools.bash({command:"printf X >> resume-marker.txt; sleep 30"});'})};
  const contextTest=String(JSON.stringify(body.messages[lastUser])).includes('BOT_CONTEXT');
  if(contextTest) tool=recent.some(m=>m.role==='tool')?undefined:{name:'codemode',arguments:JSON.stringify({code:'const memories=await tools.memory_search({}); if(!JSON.stringify(memories).includes("PROJECT_MEMORY_SENTINEL"))throw Error("Project memory missing"); text(memories); text(await tools.project_context_get({})); text(await tools.project_plan_create({title:"BOT_CREATED_TODO"})); text(await tools.library_list({})); text(await tools.runtime_probe({action:"read"}));'})};
  if(JSON.stringify(body.messages[lastUser]).includes('BOT_MEMORY_NATIVE'))tool=recent.some(m=>m.role==='tool')?undefined:{name:'memory_search',arguments:'{}'};
  if(JSON.stringify(body.messages[lastUser]).includes('BOT_MCP_REFRESH'))tool=recent.some(m=>m.role==='tool')?undefined:{name:'mcp__added__read_seed',arguments:'{}'};
  if(extraction)tool=undefined;
  const extracted=JSON.stringify(body.messages).includes('项目介质确定为乙腈')?{candidates:[{kind:'constraint',title:'BOT_EXTRACTED_MEDIUM',content:'项目介质为乙腈',scopeType:'project',confidence:0.99,importance:2,explicit:true,operationHint:'create',userEvidence:'项目介质确定为乙腈'}]}:{candidates:[]};
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'call-'+requests.length,type:'function',function:tool}]}:{role:'assistant',content:extraction?JSON.stringify(extracted):'DURABLE_DESKTOP_COMPLETE'};
  const packet=(delta,finish_reason)=>({id:'chatcmpl-'+requests.length,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture',choices:[{index:0,delta,finish_reason}]});
  if(!extraction&&JSON.stringify(body.messages[lastUser]).includes('BOT_PRESENTATION')) {
    await new Promise(resolve=>{releasePresentationStart=resolve;});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write('data: '+JSON.stringify(packet({role:'assistant',content:'BOT_PRESENTATION_'},null))+'\n\n');
    await new Promise(resolve=>{releasePresentationFinish=resolve;});
    res.write('data: '+JSON.stringify(packet({content:'COMPLETE'},null))+'\n\n');
    res.end('data: '+JSON.stringify(packet({},'stop'))+'\n\ndata: [DONE]\n\n');return;
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify(packet(delta,null))+'\n\n');
  res.end('data: '+JSON.stringify(packet({},tool?'tool_calls':'stop'))+'\n\ndata: [DONE]\n\n');
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await wait(100);}throw Error('Timeout: '+label);}
async function freePort(){return new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});}
let proc,socket,log,port,seq=0;
const pending=new Map();
function rpc(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const result=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;}
async function launch(){
  console.log("desktop launch",temp);
  port=await freePort();
  const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local')};delete env.ELECTRON_RUN_AS_NODE;
  log=fs.openSync(path.join(out,'desktop.log'),'a');
  const executable=process.env.MYBUDDY_DESKTOP_EXECUTABLE||require('electron');
  proc=cp.spawn(executable,[...(process.env.MYBUDDY_DESKTOP_EXECUTABLE?[]:[root]),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--disable-background-timer-throttling'],{cwd:root,env,stdio:['ignore',log,log],windowsHide:true});
  let target;await until(async()=>{if(proc.exitCode!==null)throw Error('Electron exited '+proc.exitCode);try{target=(await fetch('http://127.0.0.1:'+port+'/json/list').then(r=>r.json())).find(t=>t.type==='page'&&t.url.includes('index.html'));return !!target;}catch{return false;}},'Electron renderer');
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
  socket.addEventListener('message',e=>{const r=JSON.parse(e.data),p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result);});
  await rpc('Runtime.enable');await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await until(()=>evaluate('Boolean(window.api?.agent&&document.querySelector("textarea"))'),'app ready');
  await evaluate('window.__botEvents=[];window.__botErrors=[];window.api.agent.onEvent(e=>window.__botEvents.push(e));window.addEventListener("error",e=>window.__botErrors.push(e.message));true');
}
async function close(){if(socket){try{await rpc('Browser.close');}catch{}socket.close();socket=null;}if(proc){await wait(500);if(proc.exitCode===null)cp.execFileSync('C:/Windows/System32/taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});proc=null;}if(log!==undefined){fs.closeSync(log);log=undefined;}}
async function click(selector,text){return evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.click();return true})()`);}
async function send(text){await evaluate(`(()=>{const e=document.querySelector('.chat-input textarea')||document.querySelector('textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);await wait(120);await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
const report={temp,tests:[],status:'running'};
(async()=>{try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port+'/v1';
  fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{'durable-fixture':{baseUrl:url,api:'openai-completions',apiKey:'fixture-only',models:[{id:'fixture',name:'Durable Fixture',reasoning:false,input:['text'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
  fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'durable-fixture',defaultModel:'fixture',enabledModels:['durable-fixture/fixture'],memoryEnabled:true,memoryGatewayEnabled:false,remoteAccessEnabled:false,closeToTray:false,theme:'light',permissionMode:'readonly'}));
  await launch();
  const profile=await evaluate('window.api.agent.getModeProfile("bot")');
  assert(profile.blocks.some(b=>b.content.trim()==='PRESERVED_USER_BOT_PROMPT'));assert.equal(profile.policy.presets.find(p=>p.id==='kept').promptAddon,'PRESERVED_TAG');assert.equal(profile.policy.presets.find(p=>p.id==='kept').providerMcpIds,undefined);assert.equal(profile.policy.artifactPolicy.unfiltered,true);report.tests.push('legacy prompts and Tags preserved; all scene policies removed');
  const modeLabels=await evaluate('[...document.querySelectorAll(".hero-categories button")].map(b=>b.textContent.trim())');assert.deepEqual(modeLabels.sort(),['日常办公','代码开发','Bot'].sort());
  assert(!profile.policy.presets.some(p=>['general','web-prototype'].includes(p.id)));
  const office=await evaluate('window.api.agent.getModeProfile("working")');
  const penpot=office.policy.presets.find(p=>p.id==='web-prototype');
  assert.equal(penpot.label,'Penpot');assert.equal(penpot.promptAddon,'PRESERVED_PENPOT_PROMPT');assert.deepEqual(penpot.providerMcpIds,['penpot']);
  assert(penpot.requiredRuntimes.some(r=>r.providerId==='penpot'&&r.launchPolicy==='backend'&&r.readinessPolicy==='http'&&r.openUi==='browser'));
  await click('.hero-categories button','日常办公');
  await until(()=>evaluate('[...document.querySelectorAll(".preset-chip")].some(e=>e.textContent.trim()==="Penpot")'),'office Tag bar');
  const officeTags=await evaluate('[...document.querySelectorAll(".preset-chip")].map(e=>e.textContent.trim())');
  assert(officeTags.includes('Penpot'));assert(!officeTags.some(t=>t==='通用设计'||t.includes('网页原型')));
  const officeShot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'office-penpot.png'),Buffer.from(officeShot.data,'base64'));
  report.tests.push('Penpot appears in office with preserved prompt, MCP and runtime; general design and old Penpot removed from Bot');
  await click('.hero-categories button','Bot');await until(()=>evaluate('document.querySelector(".hero")?.dataset.mode==="bot"'),'Bot mode');
  await send('BOT_NATIVE: run deterministic verification');
  let taskId;await until(async()=>{const value=await evaluate('window.__botEvents.filter(e=>e.type==="durable_snapshot").at(-1)');taskId=value?.taskId;return value?.snapshot.messages.at(-1)?.text==='DURABLE_DESKTOP_COMPLETE'&&!value.snapshot.busy;},'native result',45000);
  let task=(await evaluate('window.api.db.listTasks()')).find(t=>t.id===taskId);assert.equal(task.executionBackend,'pi-durable');assert.equal(task.sessionFile,undefined);assert.equal(fs.readFileSync(path.join(task.cwd,'proof.py'),'utf8'),'DURABLE_PROOF');
  assert(requests.some(r=>r.messages.some(m=>JSON.stringify(m).includes('PRESERVED_USER_BOT_PROMPT'))));
  const eventTypes=await evaluate('[...new Set(window.__botEvents.map(e=>e.type))]');assert(!eventTypes.includes('tool_start'));report.tests.push('real UI native input -> native Durable + MCP + write, despite readonly and inherited deny policy');
  await until(()=>evaluate('document.body.innerText.includes("DURABLE_DESKTOP_COMPLETE")'),'renderer snapshot');
  const history=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);assert(history.durable.messages.some(m=>m.tools?.some(t=>t.tool==='mcp__fixture__read_seed'&&t.status==='success')));
  await click('.workspace-trigger','原生模式');await evaluate(`(()=>{const e=[...document.querySelectorAll('.workspace-popup-item')].find(e=>e.querySelector('.workspace-popup-name')?.textContent==='Code Mode');if(!e)throw Error('Code Mode Tag missing');e.click();return true;})()`);
  await send('BOT_CODEMODE: run deterministic verification');
  await until(async()=>{const h=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);return h.durable.toolMode==='codemode'&&!h.durable.busy&&h.messages.filter(m=>m.role==='user').length===2;},'Code Mode result',45000);
  const second=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);assert(second.messages.some(m=>m.tools?.some(t=>t.tool==='bash'&&t.parentToolCallId&&t.status==='success')),JSON.stringify(second.messages));report.tests.push('same Bot switches Tag to Code Mode; real QuickJS worker, MCP, write and Bash child tasks');
  const cards=await evaluate(`window.api.artifactDomain.list({taskId:${JSON.stringify(taskId)}})`);
  assert(cards.artifacts.some(a=>a.source?.entryFile===path.join(temp,'outside.py')),'native absolute output must appear as artifact');
  assert(cards.artifacts.some(a=>a.source?.entryFile===path.join(task.cwd,'.scratch/visible.py')),'hidden-directory output must appear as artifact');
  assert.equal(fs.readFileSync(path.join(temp,'outside.py'),'utf8'),'OUTSIDE_PROOF');
  report.tests.push('no display filtering for hidden directories or native writes outside the working directory');
  const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'bot-codemode.png'),Buffer.from(shot.data,'base64'));
  assert.equal((await evaluate('window.__botErrors')).length,0);
  await send('BOT_PRESENTATION: verify waiting, streaming and completion');
  await until(()=>Boolean(releasePresentationStart),'provider waiting for first token');
  await until(()=>evaluate('document.body.innerText.includes("等待模型响应")'),'waiting feedback before first token');
  const pendingUi=await evaluate(`(()=>{const m=window.__botEvents.filter(e=>e.type==='durable_snapshot').at(-1).snapshot.messages.at(-1);const row=document.getElementById('msg-'+m.id);window.__presentationRow=row;return {key:m.presentationKey,phase:m.generationStats?.phase,animation:getComputedStyle(row.querySelector('.msg-row')).animationName};})()`);
  assert.equal(pendingUi.phase,'waiting');assert.equal(pendingUi.animation,'bot-message-enter');
  const waitingShot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'bot-waiting.png'),Buffer.from(waitingShot.data,'base64'));
  await wait(1100);releasePresentationStart();
  await until(()=>evaluate('document.body.innerText.includes("BOT_PRESENTATION_")'),'partial response visible');
  assert(await evaluate(`(()=>{const m=window.__botEvents.filter(e=>e.type==='durable_snapshot').at(-1).snapshot.messages.at(-1);return document.getElementById('msg-'+m.id)===window.__presentationRow;})()`),'first token must reuse the waiting row');
  releasePresentationFinish();
  let presentation;
  await until(async()=>{presentation=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);return !presentation.durable.busy&&presentation.messages.at(-1)?.text==='BOT_PRESENTATION_COMPLETE';},'presentation completion');
  const completedPresentation=presentation.messages.at(-1);assert(completedPresentation.durationMs>=1100);assert.equal(completedPresentation.presentationKey,pendingUi.key);
  const completionUi=await evaluate(`(()=>{const row=document.getElementById(${JSON.stringify('msg-'+completedPresentation.id)});return {same:row===window.__presentationRow,label:row?.querySelector('.timeline-header')?.textContent};})()`);
  assert(completionUi.same,'committed answer must reuse the streaming row');assert.match(completionUi.label,/已完成.*s/);
  const completionShot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'bot-completed.png'),Buffer.from(completionShot.data,'base64'));
  assert(requests.some(r=>r.messages.some(m=>JSON.stringify(m).includes('operating in Bot mode'))));
  assert(!requests.some(r=>r.messages.some(m=>m.role==='system'&&JSON.stringify(m).includes('你当前处于「设计创意」场景'))));
  report.tests.push('native waiting animation, stable DOM through streaming/commit, plain-text completion duration and generic Bot instructions');
  const project=await evaluate('window.api.db.createProject({name:"Bot integration",instructions:"PROJECT_INSTRUCTIONS_SENTINEL",goal:"PROJECT_GOAL_SENTINEL"})');assert(project.ok,JSON.stringify(project));
  const projectId=project.project.id;
  await evaluate(`window.api.db.upsertTask({id:${JSON.stringify(taskId)},title:'Bot integration',projectId:${JSON.stringify(projectId)},updatedAt:Date.now()})`);
  await evaluate(`window.api.db.createProjectResource({projectId:${JSON.stringify(projectId)},kind:'text',title:'fixture resource',value:'PROJECT_RESOURCE_SENTINEL'})`);
  await evaluate(`window.api.memory.create({kind:'constraint',title:'PROJECT_MEMORY_SENTINEL',content:'durable project baseline',scopeType:'project',scopeId:${JSON.stringify(projectId)},sourceType:'manual'})`);
  await evaluate(`window.api.memory.create({kind:'preference',title:'GLOBAL_MEMORY_SENTINEL',content:'BOT_CONTEXT 项目介质 使用中文',scopeType:'global',sourceType:'manual'})`);
  const attachment={name:'seed.json',path:path.join(workspace,'seed.json')};
  const contextResult=await evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(taskId)},text:'BOT_CONTEXT 项目介质确定为乙腈',displayText:'确认项目介质，并附上资料',attachments:[${JSON.stringify(attachment)}],userMessageId:'context-test',assistantMessageId:'context-placeholder',modePresetId:'codemode'})`);assert(!contextResult.error,JSON.stringify(contextResult));
  const contextHistory=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
  for(const name of ['memory_search','project_context_get','project_plan_create','library_list'])assert(contextHistory.messages.some(m=>m.tools?.some(t=>t.tool===name&&t.status==='success')),name+' did not succeed');
  const contextRequest=requests.find(r=>JSON.stringify(r.messages.at(-1)).includes('BOT_CONTEXT'));
  for(const marker of ['PROJECT_MEMORY_SENTINEL','GLOBAL_MEMORY_SENTINEL','PROJECT_RESOURCE_SENTINEL','PROJECT_INSTRUCTIONS_SENTINEL'])assert(JSON.stringify(contextRequest).includes(marker),marker+' not sent to model');
  assert(!contextHistory.messages.filter(m=>m.role==='user').some(m=>m.text.includes('PROJECT_MEMORY_SENTINEL')),'request evidence must not pollute persisted user history');
  assert((await evaluate(`window.api.db.listProjectTodos(${JSON.stringify(projectId)})`)).some(t=>t.title==='BOT_CREATED_TODO'));
  await until(async()=> (await evaluate(`window.api.memory.list({projectId:${JSON.stringify(projectId)}})`)).some(m=>m.title==='BOT_EXTRACTED_MEDIUM'),'Bot automatic project memory extraction');
  const memoryTurns=await evaluate(`window.api.memory.turns({taskId:${JSON.stringify(taskId)}})`);assert(memoryTurns.some(t=>t.userText.includes('BOT_CONTEXT')));
  assert(memoryTurns.some(t=>t.metadata?.procedureExecution?.tools?.some(tool=>tool.name==='bash')),'Code Mode nested execution evidence must reach procedure learning');
  assert.equal(memoryTurns.find(t=>t.userText.includes('BOT_CONTEXT')).userText,'BOT_CONTEXT 项目介质确定为乙腈','memory must use original user text, not attachment/context expansions');
  const displayed=contextHistory.messages.find(m=>m.role==='user'&&m.text==='确认项目介质，并附上资料');assert.deepEqual(displayed?.attachments,[attachment]);
  for(const name of ['memory_search','library_read','project_plan_create','web_search','fetch_content','browser_exec'])assert(requests.some(r=>JSON.stringify(r.tools??[]).includes(name)),name+' absent from native/Code Mode tool catalog');
  assert(contextHistory.durable.contextUsage?.contextWindow===128000);
  report.tests.push('actual Bot context, project resources, native domain tools via Code Mode, automatic L0 and project memory extraction, current usage');
  const nativeTaskId='bot-shared-project-memory';
  await evaluate(`window.api.db.upsertTask({id:${JSON.stringify(nativeTaskId)},title:'Native project recall',welcomeMode:'bot',projectId:${JSON.stringify(projectId)},modePresetId:'native',updatedAt:Date.now()})`);
  await evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(nativeTaskId)},text:'BOT_MEMORY_NATIVE',userMessageId:'native-memory-user',assistantMessageId:'native-memory-placeholder'})`);
  const nativeHistory=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(nativeTaskId)})`);
  const recall=nativeHistory.messages.flatMap(m=>m.tools??[]).find(t=>t.tool==='memory_search');assert.equal(recall?.status,'success');assert(recall.output.includes('BOT_EXTRACTED_MEDIUM'),'a second Bot must recall the first Bot project memory');
  report.tests.push('native mode reads project memory learned by another Bot; project knowledge is shared across native/Code Mode');
  const mcpFile=path.join(agentDir,'plugins/mcp/mcp.json'),mcpConfig=JSON.parse(fs.readFileSync(mcpFile,'utf8'));
  mcpConfig.mcpServers.added={...mcpConfig.mcpServers.fixture};fs.writeFileSync(mcpFile,JSON.stringify(mcpConfig));
  await evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(nativeTaskId)},text:'BOT_MCP_REFRESH',userMessageId:'mcp-refresh-user',assistantMessageId:'mcp-refresh-placeholder'})`);
  const refreshed=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(nativeTaskId)})`);assert(refreshed.messages.some(m=>m.tools?.some(t=>t.tool==='mcp__added__read_seed'&&t.status==='success')),'existing Bot did not use changed MCP config');
  report.tests.push('an existing Bot refreshes MCP configuration on its next input');
  for(const [id,prompt,expected] of [['bot-cron-ok','BOT_MEMORY_NATIVE','success'],['bot-cron-failed','BOT_FAIL','error']]){
    await evaluate(`window.api.cron.upsert({id:${JSON.stringify(id)},name:'Bot scheduled fixture',prompt:${JSON.stringify(prompt)},welcomeMode:'bot',projectId:${JSON.stringify(projectId)},permissionMode:'readonly',scheduleType:'every',scheduleExpr:'1h',timezone:'Asia/Shanghai',enabled:false,createdAt:Date.now(),updatedAt:Date.now()})`);
    await evaluate(`window.api.cron.runNow(${JSON.stringify(id)})`);
    await until(async()=>{const runs=await evaluate('window.api.cron.runs()');return runs.some(r=>r.jobId===id&&r.status!=='running');},'Bot cron completion');
    const run=(await evaluate('window.api.cron.runs()')).find(r=>r.jobId===id);assert.equal(run.status,expected,JSON.stringify(run));
    const cronHistory=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(run.taskId)})`);assert.equal(cronHistory.durable.outcome,expected==='success'?'completed':'failed');
  }
  report.tests.push('real scheduled Bot calls use native project tools and reflect native failure instead of reporting success');
  await send('BOT_HOLD: checkpoint during nested Bash');
  await until(()=>fs.existsSync(path.join(task.cwd,'resume-marker.txt')),'nested Bash started');
  const queued=await evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(taskId)},text:'AFTER_RESTART',userMessageId:'desktop-queued',assistantMessageId:'desktop-placeholder',streamingBehavior:'followUp',modePresetId:'codemode'})`);
  assert.equal(queued.queued,true);
  const pending=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
  assert(pending.durable.pendingInputs.some(input=>input.text==='AFTER_RESTART'));
  await evaluate(`window.api.db.upsertTask({id:${JSON.stringify(taskId)},title:'recovery test',updatedAt:Date.now(),status:'failed'})`);
  console.log('closing active app');await close();console.log('active app closed; seed legacy');
  const database=new DatabaseSync(path.join(agentDir,'app.db'));database.prepare("INSERT INTO tasks(id,title,updated_at,welcome_mode) VALUES ('legacy-design-fixture','old design',?,'design')").run(Date.now());database.close();console.log('legacy seeded');
  await launch();
  console.log('restarted; read recovery');
  let restored;
  await until(async()=>{restored=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);return !restored.durable.busy&&restored.messages.some(m=>m.role==='user'&&m.text==='AFTER_RESTART')&&restored.messages.at(-1)?.text==='DURABLE_DESKTOP_COMPLETE';},'durable queue resumes after whole app restart',45000);
  assert.deepEqual(restored.messages.slice(0,second.messages.length),second.messages);
  assert.equal(restored.messages.find(m=>m.id===completedPresentation.id).durationMs,completedPresentation.durationMs,'completed duration must survive restart');
  assert.deepEqual(restored.messages.find(m=>m.id===displayed.id),displayed,'attachment and display text lost after restart');
  assert(restored.messages.some(m=>m.tools?.some(t=>t.parentToolCallId&&t.status==='error')),'interrupted nested tool projected');
  assert.equal(fs.readFileSync(path.join(task.cwd,'resume-marker.txt'),'utf8'),'X','unsafe shell must not replay');
  assert(!(await evaluate('window.api.db.listTasks()')).some(t=>t.id==='legacy-design-fixture'));
  const afterTurns=await evaluate(`window.api.memory.turns({taskId:${JSON.stringify(taskId)}})`);
  for(const turn of memoryTurns)assert.equal(afterTurns.filter(t=>t.assistantMessageId===turn.assistantMessageId).length,1,'reconnect duplicated memory');
  const usageDb=new DatabaseSync(path.join(agentDir,'app.db'),{readOnly:true});
  const count=usageDb.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE task_id=? AND source_detail='pi-durable'").get(taskId).n;
  assert.equal(count,restored.messages.filter(m=>m.role==='assistant'&&!m.streaming).length,'durable usage did not project every assistant response exactly once');usageDb.close();
  report.tests.push('memory and usage projection survive restart with no duplicates');
  report.tests.push('complete snapshot after active restart; native queue continues despite stale MyBuddy failed status; no unsafe replay; old design task retired');
  report.requests=requests.length;report.taskId=taskId;report.status='passed';
}catch(error){report.status='failed';report.error=error.stack;try{report.body=await evaluate('document.body.innerText.slice(-5000)');report.events=await evaluate('window.__botEvents.slice(-4)');}catch{}}
finally{await close();server.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='passed'?0:1;}})();
