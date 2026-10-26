/** Actual Electron + renderer + IPC + Durable + Pi HTTP provider + real MCP, all in an isolated profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-durable-desktop-'));
const home = path.join(temp, 'profile'), agentDir = path.join(home, '.mybuddy'), workspace = path.join(temp, 'workspace');
const out = process.env.MYBUDDY_DESKTOP_OUT || path.join(root, 'out/tests/durable-bot-desktop'); fs.mkdirSync(out, {recursive:true});
fs.writeFileSync(path.join(out,'desktop.log'),'');
for (const dir of [agentDir,workspace,path.join(home,'AppData/Roaming'),path.join(home,'AppData/Local'),path.join(agentDir,'plugins/mcp'),path.join(agentDir,'modes/design')]) fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(workspace,'seed.json'),JSON.stringify({nonce:'durable-fixture',values:[8,13]}));
const tinyPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AACA//8EggJ/LF23YQAAAABJRU5ErkJggg==','base64');
const imageInput=path.join(workspace,'input.png');fs.writeFileSync(imageInput,tinyPng);
fs.writeFileSync(path.join(agentDir,'modes/design/goal.md'),'PRESERVED_USER_BOT_PROMPT');
fs.writeFileSync(path.join(agentDir,'modes/design/policy.json'),JSON.stringify({toolPolicy:{mode:'hard',deny:['write','bash','mcp__fixture__read_seed']},mcpPolicy:{mode:'hard',deny:['fixture']},artifactPolicy:{mode:'hard',deny:['py'],allow:['pdf']},presets:[{id:'kept',label:'保留的预设',promptAddon:'PRESERVED_TAG',providerMcpIds:['nonexistent'] },{id:'general',label:'通用设计'},{id:'web-prototype',label:'网页原型 · Penpot',promptAddon:'PRESERVED_PENPOT_PROMPT'}]}));
fs.writeFileSync(path.join(agentDir,'plugins/mcp/mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[path.join(root,'scripts/pi-codemode-auto-fixture.mjs'),workspace],modes:['working'],exposure:'direct',timeout:15}}}));
const requests=[];
let releasePresentationStart, releasePresentationFinish, releaseQueueHold;
let queueHoldReleased = false;
let blockedMcpRequests=0;
const blockedMcp=http.createServer(()=>{blockedMcpRequests++;});
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  let body;try{body=JSON.parse(raw);}catch{res.writeHead(400);res.end();return;}
  requests.push(body);
  const extraction=JSON.stringify(body.messages).includes('conversationTurns');
  // Pi serializes tool image blocks as a separate user message; keep the fixture turn tied to actual input.
  const lastUser=body.messages.findLastIndex(m=>m.role==='user'&&!JSON.stringify(m.content).includes('Attached image(s) from tool result:'));
  if(!extraction&&JSON.stringify(body.messages[lastUser]).includes('BOT_FAIL')){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'BOT_FIXTURE_REJECTION',type:'invalid_request_error'}}));return;}
  const recent=body.messages.slice(lastUser+1);
  const native=body.tools?.some(t=>t.function?.name==='write');
  let tool;
  if(!recent.some(m=>m.role==='tool')) tool = native
    ? {name:'mcp_list_tools',arguments:JSON.stringify({server:'fixture'})}
    : {name:'codemode',arguments:JSON.stringify({code:'text(await tools.mcp_list_tools({server:"fixture"})); const r=await tools.mcp_call_tool({server:"fixture",tool:"read_seed",arguments:{}}); text(r); await tools.write({path:"proof.py",content:"DURABLE_PROOF"}); await tools.write({path:".scratch/visible.py",content:"HIDDEN_DIRECTORY_PROOF"}); await tools.write({path:' + JSON.stringify(path.join(temp,'outside.py')) + ',content:"OUTSIDE_PROOF"}); await tools.bash({command:"printf DURABLE_SHELL"});'})};
  else if(native && !recent.some(m=>m.role==='assistant'&&m.tool_calls?.some(t=>t.function.name==='mcp_call_tool')))tool={name:'mcp_call_tool',arguments:JSON.stringify({server:'fixture',tool:'read_seed',arguments:{}})};
  else if(native && !recent.some(m=>m.role==='assistant'&&m.tool_calls?.some(t=>t.function.name==='write')))tool={name:'write',arguments:JSON.stringify({path:'proof.py',content:'DURABLE_PROOF'})};
  if (String(JSON.stringify(body.messages[lastUser])).includes('BOT_HOLD') && !recent.some(m=>m.role==='tool')) tool={name:'codemode',arguments:JSON.stringify({code:'await tools.bash({command:"printf X >> resume-marker.txt; sleep 30"});'})};
  const contextTest=String(JSON.stringify(body.messages[lastUser])).includes('BOT_CONTEXT');
  if(contextTest) tool=recent.some(m=>m.role==='tool')?undefined:{name:'codemode',arguments:JSON.stringify({code:'const memories=await tools.memory_search({}); if(!JSON.stringify(memories).includes("PROJECT_MEMORY_SENTINEL"))throw Error("Project memory missing"); text(memories); text(await tools.project_context_get({})); text(await tools.project_plan_create({title:"BOT_CREATED_TODO"})); text(await tools.library_list({})); text(await tools.runtime_probe({action:"read"}));'})};
  if(JSON.stringify(body.messages[lastUser]).includes('BOT_MEMORY_NATIVE'))tool=recent.some(m=>m.role==='tool')?undefined:{name:'memory_search',arguments:'{}'};
  if(JSON.stringify(body.messages[lastUser]).includes('BOT_MCP_REFRESH'))tool=!recent.some(m=>m.role==='tool')?{name:'mcp_list_tools',arguments:JSON.stringify({server:'added'})}
    :!recent.some(m=>m.role==='assistant'&&m.tool_calls?.some(t=>t.function.name==='mcp_call_tool'))?{name:'mcp_call_tool',arguments:JSON.stringify({server:'added',tool:'read_seed',arguments:{}})}:undefined;
  if(JSON.stringify(body.messages[lastUser]).includes('BOT_IMAGE'))tool=recent.some(m=>m.role==='tool')?undefined:{name:'codemode',arguments:JSON.stringify({code:'const r=await tools.read({path:'+JSON.stringify(imageInput)+'}); const img=r.content.find(c=>c.type==="image"); if(!img)throw Error("Image missing"); image(img); image(img);'})};
  if(JSON.stringify(body.messages[lastUser]).includes('BOT_IMAGE_REOPEN'))tool=undefined;
  // Pi may append a user-role evidence message after the actual input; fixture selection
  // must still recognize the real continuation instead of markers inside injected memory.
  const modeBound=body.messages.some(message=>message.role==='user'&&/^MODE_BOUND_(?:CONTINUE_|BOT_CONTINUE)/.test((typeof message.content==='string'?message.content:message.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'').trim()));
  if(modeBound)tool=undefined;
  if(body.messages.some(message=>message.role==='user'&&/^BOT_GREETING/.test((typeof message.content==='string'?message.content:message.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'').trim())))tool=undefined;
  if(JSON.stringify(body.messages[lastUser]).includes('BOT_MOVED_GREETING'))tool=undefined;
  if(extraction)tool=undefined;
  const extracted=JSON.stringify(body.messages).includes('项目介质确定为乙腈')?{candidates:[{kind:'constraint',title:'BOT_EXTRACTED_MEDIUM',content:'项目介质为乙腈',scopeType:'project',confidence:0.99,importance:2,explicit:true,operationHint:'create',userEvidence:'项目介质确定为乙腈'}]}:{candidates:[]};
  if(!extraction&&JSON.stringify(body.messages[lastUser]).includes('BOT_QUEUE_')) {
    tool=undefined;
    if(JSON.stringify(body.messages[lastUser]).includes('BOT_QUEUE_HOLD')&&!queueHoldReleased) {
      await new Promise(resolve=>{releaseQueueHold=()=>{queueHoldReleased=true;resolve();};});
    }
  }
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'call-'+requests.length,type:'function',function:tool}]}:{role:'assistant',content:extraction?JSON.stringify(extracted):'DURABLE_DESKTOP_COMPLETE'};
  const packet=(delta,finish_reason)=>({id:'chatcmpl-'+requests.length,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture',choices:[{index:0,delta,finish_reason}],...(finish_reason?{usage:{prompt_tokens:2400,completion_tokens:80,total_tokens:2480,prompt_tokens_details:{cached_tokens:1800}}}:{})});
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
function rpc(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},method==='Page.captureScreenshot'?45000:15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const result=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;}
async function launch(){
  console.log("desktop launch",temp);
  port=await freePort();
  const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local')};delete env.ELECTRON_RUN_AS_NODE;
  log=fs.openSync(path.join(out,'desktop.log'),'a');
  const executable=process.env.MYBUDDY_DESKTOP_EXECUTABLE||require('electron');
  // Keep lazy image decoding active when the user's foreground window covers this isolated app.
  proc=cp.spawn(executable,[...(process.env.MYBUDDY_DESKTOP_EXECUTABLE?[]:[root]),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-features=CalculateNativeWinOcclusion'],{cwd:root,env,stdio:['ignore',log,log],windowsHide:true});
  let target;await until(async()=>{if(proc.exitCode!==null)throw Error('Electron exited '+proc.exitCode);try{target=(await fetch('http://127.0.0.1:'+port+'/json/list').then(r=>r.json())).find(t=>t.type==='page'&&t.url.includes('index.html'));return !!target;}catch{return false;}},'Electron renderer');
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
  socket.addEventListener('message',e=>{const r=JSON.parse(e.data),p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result);});
  await rpc('Runtime.enable');await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await until(()=>evaluate('Boolean(window.api?.agent&&document.querySelector("textarea"))'),'app ready');
  await evaluate('window.__botEvents=[];window.__botErrors=[];window.api.agent.onEvent(e=>window.__botEvents.push(e));window.addEventListener("error",e=>window.__botErrors.push(e.message));true');
}
async function close(){if(socket){try{await rpc('Browser.close');}catch{}socket.close();socket=null;}if(proc){await wait(500);if(proc.exitCode===null)cp.execFileSync('C:/Windows/System32/taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});proc=null;}if(log!==undefined){fs.closeSync(log);log=undefined;}}
async function click(selector,text){const end=Date.now()+15000;for(;;){const ok=await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)return false;e.click();return true})()`);if(ok)return true;if(Date.now()>end){const available=await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(e=>e.textContent.trim())`);throw Error('Missing '+text+' available='+JSON.stringify(available));}await wait(200);}}

async function revealSpace(name){return evaluate(`(()=>{const h=[...document.querySelectorAll('.space-header')].find(h=>h.querySelector('.space-name')?.textContent.trim()===${JSON.stringify(name)});if(!h)return false;const icon=h.querySelector('.space-icon svg');const closed=!!icon&&icon.classList.contains('lucide-folder');if(closed)h.querySelector('.space-chevron')?.click();return true})()`);}
async function send(text){await evaluate(`(()=>{const e=document.querySelector('.chat-input textarea')||document.querySelector('textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);await wait(120);await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
async function streamingMode(label) {
  await evaluate('document.querySelector(".streaming-mode-trigger").click();true');
  await until(()=>evaluate('Boolean(document.querySelector(".streaming-mode-menu"))'),'streaming mode menu');
  await evaluate(`[...document.querySelectorAll('.streaming-mode-item')].find(e=>e.querySelector('span').textContent===${JSON.stringify(label)}).click();true`);
}
async function mouseClick(selector) {
  const r=await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
  const point={x:r.x+r.width/2,y:r.y+r.height/2,button:'left',clickCount:1};
  await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...point,buttons:1});
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...point,buttons:0});
}
async function selectProse() {
  // Wait for the timeline collapse animation before computing native mouse coordinates.
  await wait(350);
  const rect=await evaluate(`(()=>{const p=[...document.querySelectorAll('.assistant-card p')].find(e=>e.textContent.includes('DURABLE_DESKTOP_COMPLETE'));if(!p)throw Error('Missing assistant prose');p.scrollIntoView({block:'center',behavior:'instant'});window.getSelection().removeAllRanges();const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(node.textContent.includes('DURABLE_DESKTOP_COMPLETE'))break;}if(!node)throw Error('Missing text node');const r=document.createRange();r.selectNodeContents(node);return r.getBoundingClientRect().toJSON();})()`);
  const y=rect.y+rect.height/2;
  await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x+1,y,button:'left',buttons:1,clickCount:1});
  for(let i=1;i<=5;i++)await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+rect.width*i/5,y,button:'left',buttons:1});
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+rect.width,y,button:'left',buttons:0,clickCount:1});
  return evaluate('window.getSelection().toString()');
}
async function key(key,code,virtualKey,modifiers=0) {
  await rpc('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,modifiers});
  await rpc('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey,modifiers});
}
async function draft(value) {
  await evaluate(`(()=>{const e=document.querySelector('.input-area textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);await wait(80);
}
async function dropText(text,selector='.input-area textarea') {
  const rect=await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
  const point={x:rect.x+10,y:rect.y+10},data={items:[{mimeType:'text/plain',data:text}],dragOperationsMask:1};
  for(const type of ['dragEnter','dragOver','drop'])await rpc('Input.dispatchDragEvent',{type,...point,data});
  await wait(100);
  return evaluate('document.querySelector(".input-area textarea").value');
}
async function beginPanelResize() {
  if(!await evaluate('Boolean(document.querySelector(".panel-resize-handle"))'))await evaluate('document.querySelector("button[title=打开概览]").click()');
  await until(()=>evaluate('Boolean(document.querySelector(".panel-resize-handle"))'),'resize handle');
  await wait(350);
  const r=await evaluate('document.querySelector(".panel-resize-handle").getBoundingClientRect().toJSON()');
  await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:r.x+r.width/2,y:r.y+100,button:'left',buttons:1,clickCount:1});
  await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x-30,y:r.y+100,button:'left',buttons:1});
  return {x:r.x-30,y:r.y+100};
}
const report={temp,tests:[],status:'running'};
(async()=>{try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  await new Promise(r=>blockedMcp.listen(0,'127.0.0.1',r));
  const startupMcpFile=path.join(agentDir,'plugins/mcp/mcp.json'),startupMcpConfig=JSON.parse(fs.readFileSync(startupMcpFile,'utf8'));
  startupMcpConfig.mcpServers.blocked={url:'http://127.0.0.1:'+blockedMcp.address().port,headers:{Authorization:'fixture'},timeout:30};fs.writeFileSync(startupMcpFile,JSON.stringify(startupMcpConfig));
  const url='http://127.0.0.1:'+server.address().port+'/v1';
  const fixtureModel={id:'fixture',name:'Durable Fixture',reasoning:false,input:['text','image'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{'durable-fixture':{baseUrl:url,api:'openai-completions',apiKey:'fixture-only',models:[fixtureModel,{...fixtureModel,id:'alternate',name:'Durable Alternate'}]}}}));
  fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'durable-fixture',defaultModel:'fixture',enabledModels:['durable-fixture/fixture','durable-fixture/alternate'],memoryEnabled:true,memoryGatewayEnabled:false,remoteAccessEnabled:false,closeToTray:false,theme:'light',permissionMode:'readonly'}));
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
  const greetingStart=Date.now();
  await send('BOT_GREETING: 你好');
  await until(()=>evaluate('window.__botEvents.some(e=>e.type==="durable_snapshot"&&!e.snapshot.busy&&e.snapshot.messages.at(-1)?.text==="DURABLE_DESKTOP_COMPLETE")'),'plain greeting with an unused 30-second MCP',5000);
  report.mcpStartup={greetingMs:Date.now()-greetingStart,unusedServerTimeoutMs:30000,unusedServerRequests:blockedMcpRequests};
  assert(report.mcpStartup.greetingMs<2000,JSON.stringify(report.mcpStartup));assert.equal(blockedMcpRequests,0,'a plain greeting must not contact unused MCP');
  assert(!fs.existsSync(path.join(workspace,'mcp-audit.jsonl')),'plain greeting must not call the healthy MCP either');
  report.tests.push('plain greeting reaches the real provider within 2s while an unused MCP would block for 30s; no MCP contacts');
  report.botComposer=await evaluate(`({modeSelector:Boolean(document.querySelector('.input-area .workspace-trigger')),runtimeLabel:document.querySelector('[data-testid="pi-durable-status"]')?.textContent,context:Boolean(document.querySelector('.context-usage-ring-btn'))})`);
  assert(report.botComposer.context,'Bot composer must expose the office/code context usage control');
  assert(!report.botComposer.modeSelector,'Bot chat must not show a mode selector');
  assert(!report.botComposer.runtimeLabel,'Bot chat must not show a Pi Durable mode label');
  await mouseClick('.context-usage-ring-btn');
  await until(()=>evaluate('Boolean(document.querySelector(".context-usage-popup"))'),'Bot context popup');
  const contextUi=await evaluate(`({summary:document.querySelector('.context-usage-popup-used').textContent,cache:document.querySelector('.context-usage-popup-cache-val').textContent,categories:[...document.querySelectorAll('.context-usage-popup-label')].map(e=>e.textContent),button:document.querySelector('.manual-compaction-control button').textContent,disabled:document.querySelector('.manual-compaction-control button').disabled,usage:window.__botEvents.filter(e=>e.type==='durable_snapshot').at(-1).snapshot.contextUsage})`);
  assert.match(contextUi.summary,/约 2\.5K\/128\.0K/);assert.equal(contextUi.cache,'75%');
  assert.deepEqual(contextUi.categories,['系统提示词','工具及子智能体','对话消息','技能','MCP','连接器']);
  assert.equal(contextUi.button,'立即压缩');assert(!contextUi.disabled);
  assert.equal(contextUi.usage.usedTokens,2480);assert.equal(contextUi.usage.cacheHitRate,0.75);
  report.contextUi=contextUi;
  await rpc('Page.bringToFront');
  fs.writeFileSync(path.join(out,'bot-context-usage.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await mouseClick('.context-usage-popup-close');
  await until(()=>evaluate('!document.querySelector(".context-usage-popup")'),'context popup close');
  report.tests.push('Bot composer replaces mode controls with the office/code context ring and popup; native token use, cache rate and manual compaction control are shown');
  await click('.sidebar-cta-btn','新建任务');await until(()=>evaluate('Boolean(document.querySelector(".hero"))'),'new task after greeting');
  await click('.hero-categories button','Bot');
  await evaluate('window.__botEvents=[];true');
  await evaluate('window.__entryTiming={};document.addEventListener("keydown",e=>{if(e.key==="Enter"&&!window.__entryTiming.sent)window.__entryTiming.sent=performance.now()},true);new MutationObserver(()=>{if(window.__entryTiming.sent&&!window.__entryTiming.chat&&document.querySelector(".task-chat-header"))window.__entryTiming.chat=performance.now()}).observe(document.body,{childList:true,subtree:true});true');
  await send('BOT_NATIVE: run deterministic verification');
  assert(await evaluate('!!document.querySelector(".task-chat-header")&&!document.querySelector(".hero")'),'Bot must enter chat immediately, before runtime startup');
  assert(await evaluate('document.body.innerText.includes("BOT_NATIVE: run deterministic verification")'),'submission preview must preserve the sent input while awaiting Durable');
  report.entryTiming=await evaluate('({chatMs:window.__entryTiming.chat-window.__entryTiming.sent,hasSnapshot:window.__botEvents.some(e=>e.type==="durable_snapshot")})');
  assert(report.entryTiming.chatMs<500,JSON.stringify(report.entryTiming));
  report.tests.push('first Bot submission enters chat within 500ms without waiting for Durable startup');
  let taskId;await until(async()=>{const value=await evaluate('window.__botEvents.filter(e=>e.type==="durable_snapshot").at(-1)');taskId=value?.taskId;return value?.snapshot.messages.at(-1)?.text==='DURABLE_DESKTOP_COMPLETE'&&!value.snapshot.busy;},'native result',45000);
  let task=(await evaluate('window.api.db.listTasks()')).find(t=>t.id===taskId);assert.equal(task.executionBackend,'pi-durable');assert.equal(task.sessionFile,undefined);assert.equal(fs.readFileSync(path.join(task.cwd,'proof.py'),'utf8'),'DURABLE_PROOF');
  assert(requests.some(r=>r.messages.some(m=>JSON.stringify(m).includes('PRESERVED_USER_BOT_PROMPT'))));
  const eventTypes=await evaluate('[...new Set(window.__botEvents.map(e=>e.type))]');assert(!eventTypes.includes('tool_start'));report.tests.push('real UI native input -> native Durable + MCP + write, despite readonly and inherited deny policy');
  await until(()=>evaluate('document.body.innerText.includes("DURABLE_DESKTOP_COMPLETE")'),'renderer snapshot');
  await until(()=>evaluate('document.querySelectorAll(".assistant-avatar-row").length===1'),'one displayed assistant for the native tool loop');
  await evaluate('document.querySelector("button.timeline-header").click()');
  const nativeToolIds=(await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`)).messages.flatMap(m=>(m.tools??[]).map(t=>t.id));
  assert.equal(nativeToolIds.length,3);
  await until(()=>evaluate(`(()=>{const ids=[...document.querySelectorAll('.timeline-body [data-tool-call-id]')].map(e=>e.dataset.toolCallId);return ${JSON.stringify(nativeToolIds)}.every(id=>ids.includes(id));})()`),'grouped timeline retains the native MCP and write tool records');
  const groupedNativeShot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'bot-grouped-native.png'),Buffer.from(groupedNativeShot.data,'base64'));
  await evaluate('document.querySelector("button.timeline-header").click()');
  report.tests.push('native tool loop renders one assistant avatar, one completion header and one final answer with all tools in the timeline');
  const history=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);assert(history.durable.messages.some(m=>m.tools?.some(t=>t.tool==='mcp_call_tool'&&t.status==='success')));assert.equal(blockedMcpRequests,0,'healthy native tool must not wait for another MCP');
  await rpc('Page.bringToFront');
  await evaluate(`window.__textEvents=[];for(const type of ['pointerdown','pointerup','mousedown','mouseup','dragstart','dragenter','dragover','drop','lostpointercapture'])document.addEventListener(type,e=>{window.__textEvents.push({type,target:e.target.className,isPrimary:e.isPrimary,pointerId:e.pointerId,button:e.button,buttons:e.buttons,text:window.getSelection().toString(),types:e.dataTransfer?.types,selected:document.body.style.userSelect});},true);true`);
  const selected=await selectProse();
  fs.writeFileSync(path.join(out,'prose-selection.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png'})).data,'base64'));
  // Clone available clipboard payloads before native copy; restore text, HTML and images.
  // 空剪贴板在 Linux/Wayland 上会以「types 为空」的 ClipboardItem 返回，new ClipboardItem({}) 直接抛
// 『Empty dictionary argument』；过滤空项，恢复逻辑用已有的 length 判断兜底。
await evaluate(`(async()=>{window.__savedClipboard=(await Promise.all((await navigator.clipboard.read()).map(async item=>item.types.length?new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)])))):null))).filter(Boolean);return true;})()`);
  let pasted;
  try {
    await key('c','KeyC',67,2);
    await draft('');await key('v','KeyV',86,2);await wait(100);
    pasted=await evaluate('document.querySelector(".input-area textarea").value');
  } finally {await evaluate('window.__savedClipboard.length?navigator.clipboard.write(window.__savedClipboard):navigator.clipboard.writeText("")');}
  await draft('');
  const dropped=await dropText('正文拖入\n第二行');
  const resize=await beginPanelResize();
  const resizing=await evaluate('({userSelect:document.body.style.userSelect,cursor:document.body.style.cursor})');
  await evaluate('window.dispatchEvent(new Event("blur"));true');
  const afterBlur=await evaluate('({userSelect:document.body.style.userSelect,cursor:document.body.style.cursor,resizing:document.body.classList.contains("panel-resizing")})');
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...resize,button:'left',buttons:0,clickCount:1});
  const resizeAgain=await beginPanelResize();
  await evaluate('document.querySelector(".extension-top-actions button[title=关闭侧栏]").click();true');
  await until(()=>evaluate('!document.querySelector(".panel-resize-handle")'),'resize handle unmount');
  const afterUnmount=await evaluate('({userSelect:document.body.style.userSelect,cursor:document.body.style.cursor,resizing:document.body.classList.contains("panel-resizing")})');
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...resizeAgain,button:'left',buttons:0,clickCount:1});
  report.textInteraction={selected,pasted,dropped,resizing,afterBlur,afterUnmount,events:await evaluate('window.__textEvents')};
  assert.equal(selected,'DURABLE_DESKTOP_COMPLETE','assistant prose must support actual mouse selection');
  assert.equal(pasted,selected,'Ctrl+C selection must paste through the actual native clipboard');
  assert.equal(dropped,'正文拖入\n第二行','a text drop must populate the controlled composer');
  assert.equal(resizing.userSelect,'none','selection is suppressed only during the resize');
  assert.deepEqual(afterBlur,{userSelect:'',cursor:'',resizing:false},'blur must release resize ownership');
  assert.deepEqual(afterUnmount,{userSelect:'',cursor:'',resizing:false},'closing the panel during resize must release ownership');
  assert.equal(await selectProse(),selected,'prose remains selectable after interrupted resizing');
  const normalResize=await beginPanelResize();
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...normalResize,button:'left',buttons:0,clickCount:1});
  assert.equal(await evaluate('document.body.style.userSelect'),'','normal pointerup restores selection');
  await evaluate('document.body.style.cursor="help";document.body.style.userSelect="text";true');
  const cancelResize=await beginPanelResize();
  await evaluate('window.dispatchEvent(new PointerEvent("pointercancel",{pointerId:1}));true');
  assert.deepEqual(await evaluate('({cursor:document.body.style.cursor,userSelect:document.body.style.userSelect})'),{cursor:'help',userSelect:'text'},'pointer cancellation must restore previous styles');
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...cancelResize,button:'left',buttons:0,clickCount:1});
  await evaluate('document.body.style.cursor="";document.body.style.userSelect="";document.querySelector(".extension-top-actions button[title=关闭侧栏]").click();true');
  await draft('前缀替换后缀');
  await evaluate('document.querySelector(".input-area textarea").setSelectionRange(2,4);true');
  assert.equal(await dropText('正文\n第二行','.input-area'),'前缀正文\n第二行后缀','dropping on composer padding replaces the selected draft portion without losing the rest');
  assert.deepEqual(await evaluate('(()=>{const e=document.querySelector(".input-area textarea");return {focused:document.activeElement===e,start:e.selectionStart,end:e.selectionEnd}})()'),{focused:true,start:8,end:8});
  await draft('保留草稿');
  const nativeMixed=await dropText('插入文字');
  assert.equal(nativeMixed.replace('插入文字',''),'保留草稿','native drop preserves existing draft');
  assert.equal(nativeMixed.split('插入文字').length,2,'native text must be inserted only once');
  await draft('保留附件草稿');
  const fileRect=await evaluate('document.querySelector(".input-area textarea").getBoundingClientRect().toJSON()');
  const fileDrop={x:fileRect.x+10,y:fileRect.y+10,data:{items:[{mimeType:'application/x-mybuddy-workspace-file',data:JSON.stringify({paths:[imageInput]})},{mimeType:'text/plain',data:imageInput}],dragOperationsMask:1}};
  for(const type of ['dragEnter','dragOver','drop'])await rpc('Input.dispatchDragEvent',{type,...fileDrop});
  await until(()=>evaluate('Boolean(document.querySelector(".attach-chip.file-chip"))'),'workspace file attachment after text drop');
  assert.equal(await evaluate('document.querySelector(".input-area textarea").value'),'保留附件草稿','files with text/plain must remain attachments');
  await evaluate('document.querySelector(".attach-chip.file-chip .attach-chip-x").click();true');
  fs.writeFileSync(path.join(out,'prose-drop.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await draft('');
  report.tests.push('actual mouse selection and native Ctrl+C/Ctrl+V; multiline text drop; resize blur and unmount restore selection');
  report.tests.push('resize pointerup and pointercancel restore previous styles; native and padding text drops preserve drafts and caret; mixed file/text drops remain attachments');
  // Move the existing standalone Bot into a populated bound space through its actual IPC.
  // Old code compares the original runtime baseline against this unrelated target directory.
  const moveRoot=path.join(temp,'populated-space');fs.mkdirSync(moveRoot);
  for(const name of ['proof.py','existing.md','old-record.json'])fs.writeFileSync(path.join(moveRoot,name),'EXISTING_SPACE_FILE_SENTINEL');
  const moveSpace={id:'desktop-bot-move-space',name:'Bot move regression',path:moveRoot};
  await evaluate(`window.api.db.upsertSpace(${JSON.stringify(moveSpace)})`);
  const moveResult=await evaluate(`window.api.db.moveTaskInWorkspaceTree({taskId:${JSON.stringify(taskId)},targetSpaceId:${JSON.stringify(moveSpace.id)}})`);
  assert.equal(moveResult.ok,true);
  const moveReply=await evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(taskId)},text:'BOT_MOVED_GREETING: 你好',userMessageId:'desktop-move-user',assistantMessageId:'desktop-move-assistant'})`);
  assert(!moveReply.error,JSON.stringify(moveReply));
  await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`); // Await its artifact projection.
  const movedArtifacts=await evaluate(`window.api.artifactDomain.list({taskId:${JSON.stringify(taskId)}})`);
  const movedTask=(await evaluate('window.api.db.listTasks()')).find(t=>t.id===taskId);
  report.workspaceMove={runtimeCwd:task.cwd,persistedCwd:movedTask.cwd,spaceId:movedTask.spaceId,artifacts:movedArtifacts.artifacts.map(a=>({path:a.source?.entryFile,producer:a.createdByToolCallId})),targetFiles:fs.readdirSync(moveRoot)};
  assert.equal(movedTask.cwd,task.cwd,'moving an existing Bot must preserve its native execution binding');
  assert(movedArtifacts.artifacts.some(a=>a.source?.entryFile===path.join(task.cwd,'proof.py')),'the original output must remain');
  assert(!movedArtifacts.artifacts.some(a=>a.source?.entryFile?.startsWith(moveRoot+path.sep)),'preexisting space files must not be scanned or projected as Bot outputs');
  const unmove=await evaluate(`window.api.db.moveTaskInWorkspaceTree({taskId:${JSON.stringify(taskId)},targetSpaceId:null})`);assert.equal(unmove.ok,true);
  report.tests.push('standalone Bot moved to a populated space preserves native cwd and original artifacts; preexisting files and same-name files are not new outputs');
  // Existing configured Code Mode Bots remain supported without a chat mode picker.
  await evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(taskId)},text:'BOT_CODEMODE: run deterministic verification',userMessageId:'desktop-codemode',assistantMessageId:'desktop-codemode-placeholder',modePresetId:'codemode'})`);
  await until(async()=>{const h=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);return h.durable.toolMode==='codemode'&&!h.durable.busy&&h.messages.filter(m=>m.role==='user').length===3;},'Code Mode result',45000);
  const second=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);assert(second.messages.some(m=>m.tools?.some(t=>t.tool==='bash'&&t.parentToolCallId&&t.status==='success')),JSON.stringify(second.messages));report.tests.push('configured Code Mode Bot still uses real QuickJS worker, MCP, write and Bash child tasks');
  await until(()=>evaluate('document.querySelectorAll(".assistant-avatar-row").length===3'),'one displayed assistant per user turn in Code Mode');
  const cards=await evaluate(`window.api.artifactDomain.list({taskId:${JSON.stringify(taskId)}})`);
  assert(cards.artifacts.some(a=>a.source?.entryFile===path.join(temp,'outside.py')),'native absolute output must appear as artifact');
  assert(cards.artifacts.some(a=>a.source?.entryFile===path.join(task.cwd,'.scratch/visible.py')),'hidden-directory output must appear as artifact');
  assert.equal(fs.readFileSync(path.join(temp,'outside.py'),'utf8'),'OUTSIDE_PROOF');
  report.tests.push('no display filtering for hidden directories or native writes outside the working directory');
  const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'bot-codemode.png'),Buffer.from(shot.data,'base64'));
  assert.equal((await evaluate('window.__botErrors')).length,0);
  const imageResult=await evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(taskId)},text:'BOT_IMAGE: read and return the tiny image twice',attachments:[${JSON.stringify({name:'input.png',path:imageInput})}],userMessageId:'desktop-image',assistantMessageId:'desktop-image-placeholder',modePresetId:'codemode'})`);assert(!imageResult.error,JSON.stringify(imageResult));
  const imageHistory=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
  const imageArtifacts=imageHistory.messages.flatMap(m=>m.artifacts??[]).filter(a=>a.kind==='image');
  assert.equal(imageArtifacts.length,1,'duplicate Code Mode image output must share one persisted artifact');
  const savedImage=imageArtifacts[0];assert(fs.readFileSync(savedImage.path).equals(tinyPng));
  assert(imageHistory.messages.some(m=>m.tools?.some(t=>t.tool==='read'&&t.parentToolCallId&&t.status==='success')),'native image read must execute through a Durable child');
  assert(requests.some(r=>JSON.stringify(r.messages).includes('Attached image(s) from tool result:')),'real provider must receive native tool image blocks');
  // Locate the displayed turn through its stable user row: native assistant IDs change on commit.
  const imageUserId=imageHistory.messages.findLast(message=>message.role==='user').id;
  const displayedImage=`(()=>{const row=document.getElementById(${JSON.stringify('msg-'+imageUserId)})?.nextElementSibling;const img=row?.querySelector('img.chat-inline-image');img?.scrollIntoView({behavior:'instant',block:'center'});return {exists:Boolean(row?.querySelector('.assistant-avatar-row')&&img),decoded:Boolean(img?.complete&&img.naturalWidth===1),visibility:document.visibilityState,rect:img?.getBoundingClientRect().toJSON()};})()`;
  async function verifyDisplayedImage(label) {
    await rpc('Page.bringToFront');
    // Additional regression turns can enable virtualization: scroll the historical turn into DOM.
    for(let attempt=0;attempt<40&&!(await evaluate(displayedImage))?.exists;attempt++) {
      const r=await evaluate('document.querySelector(".message-scroll").getBoundingClientRect().toJSON()');
      await rpc('Input.dispatchMouseEvent',{type:'mouseWheel',x:r.x+r.width/2,y:r.y+r.height/2,deltaX:0,deltaY:-450});
      await wait(100);
    }
    await until(async()=>Boolean((await evaluate(displayedImage))?.exists),label+' element');
    const before=await evaluate(displayedImage);
    await rpc('Page.bringToFront');
    await rpc('Page.captureScreenshot',{format:'png'});
    await until(async()=>Boolean((await evaluate(displayedImage))?.decoded),label);
    return {before,after:await evaluate(displayedImage)};
  }
  report.imageDisplay=await verifyDisplayedImage('saved Code Mode image displays in actual renderer');
  const imageShot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'bot-image.png'),Buffer.from(imageShot.data,'base64'));
  report.image={path:savedImage.path,bytes:tinyPng.length,duplicateOutputs:2,artifacts:1};
  report.tests.push('native image read reaches the HTTP provider; Code Mode saves and displays one artifact for duplicate image outputs');
  await send('BOT_PRESENTATION: verify waiting, streaming and completion');
  await until(()=>Boolean(releasePresentationStart),'provider waiting for first token');
  await until(()=>evaluate('document.body.innerText.includes("正在准备回复…")'),'waiting feedback before first token');
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
  // Queue via the actual composer while the native provider is still answering.
  await send('BOT_QUEUE_HOLD: keep the current reply active');
  await until(()=>Boolean(releaseQueueHold),'queue fixture provider hold');
  await mouseClick('.context-usage-ring-btn');
  await until(()=>evaluate('Boolean(document.querySelector(".context-usage-popup"))'),'context popup while Bot is running');
  assert(await evaluate('document.querySelector(".manual-compaction-control button").disabled'),'manual compaction is disabled during a reply');
  await mouseClick('.context-usage-popup-close');
  await draft('BOT_QUEUE_STEER: 先核对来源\n再解释区别');
  await until(()=>evaluate('Boolean(document.querySelector(".streaming-mode-trigger"))'),'streaming send mode');
  await streamingMode('引导');
  await send('BOT_QUEUE_STEER: 先核对来源\n再解释区别');
  await draft('BOT_QUEUE_FOLLOW: 最后给出结论');
  await streamingMode('继续');
  await send('BOT_QUEUE_FOLLOW: 最后给出结论');
  await until(async()=>{const h=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);return h.durable.pendingInputs.length===2;},'native steer and follow-up queue');
  const queueUi=await evaluate(`({outside:[...document.querySelectorAll('.durable-bot-state')].map(e=>e.textContent),users:[...document.querySelectorAll('.user-bubble-text')].map(e=>e.textContent),statuses:[...document.querySelectorAll('.timeline-preparing')].map(e=>e.textContent)})`);
  report.queueUi=queueUi;
  fs.writeFileSync(path.join(out,'bot-queued.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png'})).data,'base64'));
  assert(queueUi.users.includes('BOT_QUEUE_STEER: 先核对来源\n再解释区别'),'queued steer must use the normal user bubble');
  assert(queueUi.users.includes('BOT_QUEUE_FOLLOW: 最后给出结论'),'queued follow-up must use the normal user bubble');
  assert(queueUi.statuses.includes('引导已提交，等待当前步骤结束'),'steer must use the office/code reply status');
  assert(queueUi.statuses.includes('已排队，等待当前执行结束'),'follow-up must use the office/code reply status');
  assert(!queueUi.outside.some(text=>text.includes('已入队')||text.includes('BOT_QUEUE_')),'queue text must not sit outside the conversation');
  releaseQueueHold();
  await until(async()=>{const h=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);return !h.durable.busy&&h.durable.pendingInputs.length===0;},'native queued inputs consumed');
  await until(()=>evaluate('![...document.querySelectorAll(".timeline-preparing")].some(e=>/引导已提交|已排队/.test(e.textContent))'),'queued status removed after delivery');
  assert.equal(await evaluate('[...document.querySelectorAll(".user-bubble-text")].filter(e=>e.textContent.includes("BOT_QUEUE_FOLLOW:")).length'),1,'consumed follow-up must not duplicate its pending preview');
  report.tests.push('Bot steer and follow-up use office/code user bubbles and reply statuses; native consumption removes queue previews without duplicates');
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
  const refreshed=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(nativeTaskId)})`);assert(refreshed.messages.some(m=>m.tools?.some(t=>t.tool==='mcp_call_tool'&&t.summary.includes('added')&&t.status==='success')),'existing Bot did not use changed MCP config');
  report.tests.push('an existing Bot refreshes MCP configuration on its next input');
  for(const [id,prompt,expected] of [['bot-cron-ok','BOT_MEMORY_NATIVE','success'],['bot-cron-failed','BOT_FAIL','error']]){
    await evaluate(`window.api.cron.upsert({id:${JSON.stringify(id)},name:'Bot scheduled fixture',prompt:${JSON.stringify(prompt)},welcomeMode:'bot',projectId:${JSON.stringify(projectId)},permissionMode:'readonly',scheduleType:'every',scheduleExpr:'1h',timezone:'Asia/Shanghai',enabled:false,createdAt:Date.now(),updatedAt:Date.now()})`);
    await evaluate(`window.api.cron.runNow(${JSON.stringify(id)})`);
    await until(async()=>{const runs=await evaluate('window.api.cron.runs()');return runs.some(r=>r.jobId===id&&r.status!=='running');},'Bot cron completion');
    const run=(await evaluate('window.api.cron.runs()')).find(r=>r.jobId===id);assert.equal(run.status,expected,JSON.stringify(run));
    const cronHistory=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(run.taskId)})`);assert.equal(cronHistory.durable.outcome,expected==='success'?'completed':'failed');
  }
  report.tests.push('real scheduled Bot calls use native project tools and reflect native failure instead of reporting success');
  // Recovery belongs to this Code Mode task, regardless of which conversation the UI now shows.
  // Native/Code Mode composer submission is already exercised above; target the owner explicitly here.
  await evaluate(`window.__holdRequest=window.api.agent.prompt({taskId:${JSON.stringify(taskId)},text:'BOT_HOLD: checkpoint during nested Bash',userMessageId:'desktop-hold',assistantMessageId:'desktop-hold-placeholder',modePresetId:'codemode'});true`);
  await until(()=>fs.existsSync(path.join(task.cwd,'resume-marker.txt')),'nested Bash started');
  const queued=await evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(taskId)},text:'AFTER_RESTART',userMessageId:'desktop-queued',assistantMessageId:'desktop-placeholder',streamingBehavior:'followUp',modePresetId:'codemode'})`);
  assert.equal(queued.queued,true);
  const pending=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
  assert(pending.durable.pendingInputs.some(input=>input.text==='AFTER_RESTART'));
  assert.equal((await evaluate(`window.api.db.moveTaskInWorkspaceTree({taskId:${JSON.stringify(taskId)},targetSpaceId:${JSON.stringify(moveSpace.id)}})`)).ok,true);
  // Reproduce the stale Task.cwd left by older artifact projection without altering native state.
  await evaluate(`window.api.db.upsertTask({id:${JSON.stringify(taskId)},cwd:${JSON.stringify(moveRoot)},title:'recovery test',updatedAt:Date.now(),status:'failed'})`);
  console.log('closing active app');await close();console.log('active app closed; seed legacy');
  const legacyModeCwd=path.join(agentDir,'task-workspaces','mode-bound-legacy');fs.mkdirSync(legacyModeCwd,{recursive:true});
  const legacyModeFile=path.join(temp,'mode-bound-legacy.jsonl'),legacyTimestamp=new Date().toISOString();
  const legacyModeEvents=[{type:'session',version:3,id:'mode-bound-legacy',timestamp:legacyTimestamp,cwd:legacyModeCwd},
    {type:'message',id:'legacy-user',parentId:null,timestamp:legacyTimestamp,message:{role:'user',content:[{type:'text',text:'你好'}],timestamp:Date.now()}},
    {type:'message',id:'legacy-assistant',parentId:'legacy-user',timestamp:legacyTimestamp,message:{role:'assistant',content:[{type:'text',text:'LEGACY_CODING_HISTORY'}],api:'openai-completions',provider:'durable-fixture',model:'fixture',stopReason:'stop',usage:{input:0,output:0,totalTokens:0,cost:{input:0,output:0,total:0}},timestamp:Date.now()}}];
  fs.writeFileSync(legacyModeFile,legacyModeEvents.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const database=new DatabaseSync(path.join(agentDir,'app.db'));database.prepare("INSERT INTO tasks(id,title,updated_at,welcome_mode) VALUES ('legacy-design-fixture','old design',?,'design')").run(Date.now());
  database.prepare("INSERT INTO tasks(id,title,updated_at,welcome_mode,session_file,cwd,model_id,mode_preset_id) VALUES ('mode-bound-legacy','MODE_BOUND_LEGACY',?,'coding',?,?,'durable-fixture/fixture','native')").run(Date.now(),legacyModeFile,legacyModeCwd);
  database.close();console.log('legacy seeded');
  await launch();
  console.log('restarted; read recovery');
  let restored;
  await until(async()=>{restored=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);return !restored.durable.busy&&restored.messages.some(m=>m.role==='user'&&m.text==='AFTER_RESTART')&&restored.messages.at(-1)?.text==='DURABLE_DESKTOP_COMPLETE';},'durable queue resumes after whole app restart',45000);
  const repairedTask=(await evaluate('window.api.db.listTasks()')).find(t=>t.id===taskId);
  assert.equal(repairedTask.spaceId,moveSpace.id);assert.equal(repairedTask.cwd,task.cwd,'old stale Task.cwd must repair from the native binding on recovery');
  const recoveredArtifacts=await evaluate(`window.api.artifactDomain.list({taskId:${JSON.stringify(taskId)}})`);
  assert(!recoveredArtifacts.artifacts.some(a=>a.source?.entryFile?.startsWith(moveRoot+path.sep)),'recovery must not ingest the new space files');
  for(const name of ['proof.py','existing.md','old-record.json'])assert.equal(fs.readFileSync(path.join(moveRoot,name),'utf8'),'EXISTING_SPACE_FILE_SENTINEL');
  report.tests.push('moving an active Bot and recovering old mismatched Task.cwd preserves its queue, native directory and target-space files');
  assert.deepEqual(restored.messages.slice(0,second.messages.length),second.messages);
  assert.equal(restored.messages.find(m=>m.id===completedPresentation.id).durationMs,completedPresentation.durationMs,'completed duration must survive restart');
  assert.deepEqual(restored.messages.find(m=>m.id===displayed.id),displayed,'attachment and display text lost after restart');
  assert(restored.messages.some(m=>m.artifacts?.some(a=>a.path===savedImage.path)),'saved image artifact must restore after whole app restart');
  assert(fs.readFileSync(savedImage.path).equals(tinyPng),'saved image bytes survive restart');
  fs.unlinkSync(imageInput);
  const reopenedImageResult=await evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(taskId)},text:'BOT_IMAGE_REOPEN: confirm persisted image context',userMessageId:'desktop-image-reopen',assistantMessageId:'desktop-image-reopen-placeholder',modePresetId:'codemode'})`);assert(!reopenedImageResult.error,JSON.stringify(reopenedImageResult));
  const reopenedImageRequest=requests.findLast(r=>JSON.stringify(r.messages.at(-1)).includes('BOT_IMAGE_REOPEN'));
  assert(JSON.stringify(reopenedImageRequest.messages).includes('data:image/png;base64,'+tinyPng.toString('base64')),'stored input and tool images reach provider after original file deletion');
  restored=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
  await revealSpace('Bot move regression');await wait(300);await click('.task-item-title','recovery test');
  report.restoredImageDisplay=await verifyDisplayedImage('saved image displays after restart');
  report.tests.push('image artifact and provider image context survive whole app restart and deletion of the original attachment');
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
  await click('.task-item-title','MODE_BOUND_LEGACY');
  await until(()=>evaluate('document.body.innerText.includes("LEGACY_CODING_HISTORY")'),'legacy coding history loads');
  assert.equal(await evaluate('document.querySelector(".task-chat-header .welcome-mode-icon-label")?.textContent'),'代码开发');
  for(const text of ['MODE_BOUND_CONTINUE_ONE','MODE_BOUND_CONTINUE_TWO']){
    if(text.endsWith('TWO')){
      await evaluate('document.querySelector(".model-trigger").click()');
      await until(()=>evaluate('[...document.querySelectorAll(".model-option-name")].some(e=>e.textContent==="Durable Alternate")'),'alternate model picker');
      await evaluate('[...document.querySelectorAll(".model-option-name")].find(e=>e.textContent==="Durable Alternate").closest("button").click()');
    }
    await send(text);
    await until(async()=>{const h=await evaluate('window.api.agent.loadTaskHistory("mode-bound-legacy")');return h.messages.some(m=>m.role==='user'&&m.text===text)&&h.messages.at(-1)?.text==='DURABLE_DESKTOP_COMPLETE';},text);
  }
  const legacyModeHistory=await evaluate('window.api.agent.loadTaskHistory("mode-bound-legacy")');
  const legacyModeTask=(await evaluate('window.api.db.listTasks()')).find(t=>t.id==='mode-bound-legacy');
  assert.equal(legacyModeTask.welcomeMode,'coding');assert.equal(legacyModeTask.sessionFile,legacyModeFile);
  assert.equal(legacyModeHistory.durable,undefined);assert(legacyModeHistory.messages.some(m=>m.text==='LEGACY_CODING_HISTORY'));
  assert(!await evaluate('document.body.innerText.includes("旧 Pi 会话不能转换")'));
  const legacyModeShot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'legacy-mode-continue.png'),Buffer.from(legacyModeShot.data,'base64'));
  assert.equal(legacyModeTask.modelId,'durable-fixture/alternate');
  report.tests.push('restored Pi coding task keeps its mode, original history and session through two real composer submissions with a model switch');
  await revealSpace('Bot move regression');await wait(300);await click('.task-item-title','recovery test');
  await evaluate('document.querySelector(".model-trigger").click()');
  await until(()=>evaluate('[...document.querySelectorAll(".model-option-name")].some(e=>e.textContent==="Durable Alternate")'),'Bot alternate model picker');
  await evaluate('[...document.querySelectorAll(".model-option-name")].find(e=>e.textContent==="Durable Alternate").closest("button").click()');
  await send('MODE_BOUND_BOT_CONTINUE');
  await until(async()=>{const h=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);return !h.durable.busy&&h.messages.some(m=>m.role==='user'&&m.text==='MODE_BOUND_BOT_CONTINUE')&&h.messages.at(-1)?.text==='DURABLE_DESKTOP_COMPLETE';},'Bot continuation after switching from Pi coding task');
  const botModeTask=(await evaluate('window.api.db.listTasks()')).find(t=>t.id===taskId);
  assert.equal(botModeTask.welcomeMode,'bot');assert.equal(botModeTask.sessionFile,undefined);assert.equal(botModeTask.executionBackend,'pi-durable');
  assert.equal(botModeTask.modelId,'durable-fixture/alternate');
  report.tests.push('switching back from a restored coding task and changing models keeps the existing Bot on Durable for the next composer submission');
  const legacyGateway={id:'gw-telegram-default-desktop-fixture',title:'Legacy gateway fixture',welcomeMode:'working',modePresetId:'summary',sessionFile:'legacy-gateway.jsonl',updatedAt:123};
  await evaluate(`window.api.db.upsertTask(${JSON.stringify(legacyGateway)})`);
  const legacyBefore=(await evaluate('window.api.db.listTasks()')).find(t=>t.id===legacyGateway.id);
  const gatewayTaskId='gw-bot-telegram-default-desktop-fixture';
  await evaluate(`window.api.db.upsertTask({id:${JSON.stringify(gatewayTaskId)},title:'Gateway Bot fixture',welcomeMode:'working',modePresetId:'codemode',projectId:${JSON.stringify(projectId)},updatedAt:Date.now()})`);
  const gatewayResult=await evaluate(`window.api.agent.prompt({taskId:${JSON.stringify(gatewayTaskId)},text:'BOT_NATIVE gateway verification',userMessageId:'gateway-desktop-user',assistantMessageId:'gateway-desktop-assistant',modePresetId:'codemode',permissionMode:'readonly'})`);
  assert(!gatewayResult.error,JSON.stringify(gatewayResult));
  const gatewayTask=(await evaluate('window.api.db.listTasks()')).find(t=>t.id===gatewayTaskId);
  assert.equal(gatewayTask.welcomeMode,'bot');assert.equal(gatewayTask.modePresetId,'native');assert.equal(gatewayTask.projectId,projectId);
  const gatewayHistory=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(gatewayTaskId)})`);
  assert.equal(gatewayHistory.durable.toolMode,'native');
  assert.equal(fs.readFileSync(path.join(gatewayTask.cwd,'proof.py'),'utf8'),'DURABLE_PROOF');
  await until(()=>evaluate('[...document.querySelectorAll(".task-item-title")].some(e=>e.textContent==="Gateway Bot fixture")'),'Gateway sidebar task');
  await click('.task-item-title','Gateway Bot fixture');
  await until(()=>evaluate('Boolean(document.querySelector(".context-usage-ring-btn"))'),'Gateway context control');
  assert(await evaluate('!document.querySelector(".input-area .workspace-trigger")&&!document.querySelector("[data-testid=pi-durable-status]")'));
  assert(await evaluate('document.body.innerText.includes("DURABLE_DESKTOP_COMPLETE")'));
  const gatewayShot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'gateway-bot-native.png'),Buffer.from(gatewayShot.data,'base64'));
  assert.deepEqual((await evaluate('window.api.db.listTasks()')).find(t=>t.id===legacyGateway.id),legacyBefore);
  report.tests.push('new Gateway namespace renders Bot/native, preserves project, executes native tools despite readonly/Code Mode request; old Gateway record untouched');
  report.executable=process.env.MYBUDDY_DESKTOP_EXECUTABLE||require('electron');
  if(process.env.MYBUDDY_DESKTOP_EXECUTABLE)report.buildSha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(path.dirname(report.executable),'resources/app.asar'))).digest('hex');
  report.requests=requests.length;report.taskId=taskId;report.status='passed';
}catch(error){report.status='failed';report.error=error.stack;try{
  report.body=await evaluate('document.body.innerText.slice(-5000)');report.events=await evaluate('window.__botEvents.slice(-4)');
  report.presentation=await evaluate(`(async()=>{const event=window.__botEvents.findLast(e=>e.type==='durable_snapshot');const rows=[...document.querySelectorAll('[id^="msg-"]')].map(row=>{const key=Object.keys(row).find(k=>k.startsWith('__reactFiber$'));const pending=[row[key]];let message;while(pending.length){const fiber=pending.shift();if(!fiber)continue;if(fiber.memoizedProps?.message?.role){message=fiber.memoizedProps.message;break;}pending.push(fiber.child,fiber.sibling);}return {id:row.id,message,images:[...row.querySelectorAll('img')].map(img=>({src:img.src.slice(0,100),complete:img.complete,width:img.naturalWidth})),status:row.querySelector('.chat-image-status')?.textContent};});return {native:event?.snapshot.messages,rows,artifacts:event&&await window.api.artifactDomain.list({taskId:event.taskId})};})()`);
}catch{}}
finally{await close();server.close();blockedMcp.closeAllConnections();blockedMcp.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='passed'?0:1;}})();
