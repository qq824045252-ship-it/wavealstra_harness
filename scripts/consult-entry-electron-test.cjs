/** Real Electron composer/settings regression; isolated profile, no model messages sent. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const installed = process.argv.includes('--installed');
const executableOverride = process.env.CONSULT_ENTRY_TEST_EXE;
const out = path.join(root, 'out/tests/consult-entry', executableOverride ? 'packaged' : installed ? 'installed' : 'built');
fs.mkdirSync(out, {recursive:true});
const report = {startedAt:new Date().toISOString(), tests:[], status:'running'};
const save = () => fs.writeFileSync(path.join(out,'results.json'), JSON.stringify(report,null,2));
const wait = ms => new Promise(r=>setTimeout(r,ms));
const home = fs.mkdtempSync(path.join(os.tmpdir(),'mybuddy-consult-entry-'));
const agentDir = path.join(home,'.mybuddy');fs.mkdirSync(agentDir,{recursive:true});
const userDir = path.join(os.homedir(),'.mybuddy');
for (const name of ['auth.json','models.json','models-store.json','capabilities.json']) {
  const from=path.join(userDir,name);if(fs.existsSync(from))fs.copyFileSync(from,path.join(agentDir,name));
}
let settings={};try{settings=JSON.parse(fs.readFileSync(path.join(userDir,'settings.json'),'utf8'));}catch{}
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...settings,memoryEnabled:false,memoryGatewayEnabled:false,remoteAccessEnabled:false,closeToTray:false,theme:'light',language:'zh-CN'}));
fs.writeFileSync(path.join(agentDir,'mcp.json'),'{"mcpServers":{}}');
for(const d of ['AppData/Roaming','AppData/Local'])fs.mkdirSync(path.join(home,d),{recursive:true});
let child,socket,fd,id=0;const pending=new Map();
function rpc(method,params={}) {return new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},15000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});}
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
async function until(expression,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const v=await evaluate(expression);if(v)return v;await wait(100);}throw Error('Timed out: '+expression);}
async function click(selector){await until('Boolean(document.querySelector('+JSON.stringify(selector)+'))');const p=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');await rpc('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await wait(150);}
async function screenshot(name){const r=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));}
async function selectConsult(){await click('button[title="添加"]');await click('[data-testid="consult-add-menu"]');await wait(600);return evaluate('({chip:Boolean(document.querySelector("button[aria-label=\\"移除多模型会诊\\"]")),settings:Boolean(document.querySelector(".settings-modal,.settings-overlay,.capabilities-page")),notice:document.querySelector(".consult-notice")?.textContent,body:document.body.innerText.slice(-1100)})');}
async function test(name,fn){const row={name,status:'running'};report.tests.push(row);save();try{row.details=await fn();row.status='passed';console.log('PASS '+name);}catch(e){row.status='failed';row.error=e.message;console.error('FAIL '+name+': '+e.message);}save();}
(async()=>{try{
const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
const exe=executableOverride||(installed?path.join(os.homedir(),'AppData/Local/Programs/MyBuddy/MyBuddy.exe'):require('electron'));
const args=[...((installed||executableOverride)?[]:[path.join(root,'out/main/index.js')]),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port];
const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),PI_CODING_AGENT_DIR:agentDir};delete env.ELECTRON_RUN_AS_NODE;
fd=fs.openSync(path.join(out,'desktop.log'),'w');child=cp.spawn(exe,args,{cwd:home,env,stdio:['ignore',fd,fd],windowsHide:true});report.pid=child.pid;report.port=port;report.executable=exe;save();
let page;for(let i=0;i<120;i++){try{const xs=await fetch('http://127.0.0.1:'+port+'/json/list').then(r=>r.json());page=xs.find(p=>p.type==='page'&&!p.url.startsWith('devtools'));if(page)break;}catch{}if(child.exitCode!==null)throw Error('Desktop exited: '+child.exitCode);await wait(250);}assert(page,'No desktop page');
socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});
await rpc('Runtime.enable');await rpc('Emulation.setDeviceMetricsOverride',{width:1360,height:1000,deviceScaleFactor:1,mobile:false});
await until('Boolean(window.api?.agent?.getBuiltinCapabilities && document.querySelector("textarea"))',30000);
report.initial=await evaluate('(async()=>{const s=await window.api.agent.getBuiltinCapabilities();return {multiModelConsult:s.config.multiModelConsult,buttons:[...document.querySelectorAll("button")].slice(-15).map(e=>({text:e.textContent,title:e.title,aria:e.getAttribute("aria-label")}))};})()');save();
await test('saved configuration selects this-message chip without opening settings',async()=>{const s=await selectConsult();await screenshot('configured-selection');assert(s.chip,JSON.stringify(s));assert(!s.settings,JSON.stringify(s));return s;});
await test('reselecting consult stays in composer',async()=>{if(await evaluate('Boolean(document.querySelector("button[aria-label=\\"移除多模型会诊\\"]"))'))await click('button[aria-label="移除多模型会诊"]');const s=await selectConsult();assert(s.chip,JSON.stringify(s));assert(!s.settings,JSON.stringify(s));return s;});

await test('missing configuration stays in chat instead of redirecting',async()=>{
 if(await evaluate('Boolean(document.querySelector("[data-testid=consult-chip]"))'))await click('button[aria-label="移除多模型会诊"]');
 await evaluate('(async()=>{const s=await window.api.agent.getBuiltinCapabilities();window.__consultOriginalConfig=s.config;await window.api.agent.saveBuiltinCapabilities({...s.config,multiModelConsult:{...s.config.multiModelConsult,enabled:false,participants:[]}});})()');
 const state=await selectConsult();await screenshot('missing-config');assert(!state.settings,'Missing configuration forced a settings redirect');assert(!state.chip);assert(await evaluate('Boolean(document.querySelector("[data-testid=consult-configure]"))'));return state;
});
if(!installed){
 await test('explicit configuration save and close resumes this-message selection',async()=>{
  await click('[data-testid="consult-configure"]');await until('Boolean(document.querySelector("[data-testid=consult-settings]"))');
  await evaluate('(()=>{document.querySelector("[data-testid=consult-settings]").closest(".capability-config-row").querySelector("button.switch").click();})()');
  await until('[...document.querySelector("[data-testid=consult-add-model]").options].filter(x=>x.value).length >= 2',30000);
  const ids=await evaluate('[...document.querySelector("[data-testid=consult-add-model]").options].filter(x=>x.value).slice(0,2).map(x=>x.value)');
  for(const id of ids){await evaluate('(()=>{const e=document.querySelector("[data-testid=consult-add-model]");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(e,'+JSON.stringify(id)+');e.dispatchEvent(new Event("change",{bubbles:true}));})()');await wait(100);}
  const before=await evaluate('window.api.agent.getBuiltinCapabilities().then(s=>s.config.multiModelConsult)');assert.equal(before.enabled,false);assert.equal(before.participants.length,0,'Unsaved draft was treated as saved configuration');
  await click('.capabilities-footer .btn.primary');await until('window.api.agent.getBuiltinCapabilities().then(s=>s.config.multiModelConsult.enabled&&s.config.multiModelConsult.participants.length===2)');
  await screenshot('config-saved');await click('.settings-content-head .icon-btn');await until('Boolean(document.querySelector("[data-testid=consult-chip]"))');
  assert(!(await evaluate('Boolean(document.querySelector(".settings-modal"))')));await screenshot('saved-return');return {modelIds:ids,saved:true,selectedOnReturn:true};
 });
 await test('configured repeat click never reopens settings or duplicates chip',async()=>{const state=await selectConsult();assert(state.chip&&!state.settings,JSON.stringify(state));assert.equal(await evaluate('document.querySelectorAll("[data-testid=consult-chip]").length'),1);return {chipCount:1};});
 await test('closing setup without saving stays in chat and leaves selection off',async()=>{
  await click('button[aria-label="移除多模型会诊"]');await evaluate('(async()=>{const s=await window.api.agent.getBuiltinCapabilities();await window.api.agent.saveBuiltinCapabilities({...s.config,multiModelConsult:{...s.config.multiModelConsult,enabled:false}});})()');
  await selectConsult();await click('[data-testid="consult-configure"]');await until('Boolean(document.querySelector("[data-testid=consult-settings]"))');
  await evaluate('document.querySelector("[data-testid=consult-settings]").closest(".capability-config-row").querySelector("button.switch").click()');await wait(100);
  await click('.settings-content-head .icon-btn');await wait(600);assert(!(await evaluate('Boolean(document.querySelector(".settings-modal"))')));assert(!(await evaluate('Boolean(document.querySelector("[data-testid=consult-chip]"))')));assert.equal(await evaluate('window.api.agent.getBuiltinCapabilities().then(s=>s.config.multiModelConsult.enabled)'),false);return {unsavedDraftIgnored:true,noRedirect:true};
 });
 await test('restored saved configuration is read freshly on next click',async()=>{await evaluate('window.api.agent.saveBuiltinCapabilities(window.__consultOriginalConfig)');const state=await selectConsult();assert(state.chip&&!state.settings,JSON.stringify(state));return {originalSavedModelsRestored:true};});
 await test('candidates stay listed, have no count cap, and one model can run two thinking levels',async()=>{
  if(await evaluate('Boolean(document.querySelector("button[aria-label=\\"移除多模型会诊\\"]"))'))await click('button[aria-label="移除多模型会诊"]');
  await evaluate('(async()=>{const s=await window.api.agent.getBuiltinCapabilities();await window.api.agent.saveBuiltinCapabilities({...s.config,multiModelConsult:{...s.config.multiModelConsult,enabled:false,participants:[]}});})()');
  await selectConsult();await click('[data-testid="consult-configure"]');await until('Boolean(document.querySelector("[data-testid=consult-settings]"))');
  await evaluate('(()=>{document.querySelector("[data-testid=consult-settings]").closest(".capability-config-row").querySelector("button.switch").click();})()');
  await until('[...document.querySelector("[data-testid=consult-add-model]").options].filter(o=>o.value).length >= 2',30000);
  const candidates=await evaluate('[...document.querySelector("[data-testid=consult-add-model]").options].filter(o=>o.value).map(o=>o.value)');
  for(const id of candidates){await evaluate('(()=>{const e=document.querySelector("[data-testid=consult-add-model]");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(e,'+JSON.stringify(id)+');e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');await wait(60);}
  const added=await evaluate('(()=>{const e=document.querySelector("[data-testid=consult-add-model]");return {exists:Boolean(e),members:document.querySelectorAll(".consult-settings-member").length,ids:[...e.options].filter(o=>o.value).map(o=>o.value)}})()');
  assert(added.exists,'Candidate dropdown disappeared after adding every enabled model');
  assert.equal(added.members,candidates.length,'Not every added model became a participant: '+JSON.stringify(added));
  assert.deepEqual(added.ids.slice().sort(),candidates.slice().sort(),'An added model vanished from the candidate list: '+JSON.stringify(added.ids));
  await screenshot('candidates-with-added-models');
  const twoLevel=await evaluate('(async()=>{const ms=await window.api.agent.listModels();const byId=new Map(ms.map(m=>[m.id,(m.thinkingLevels||[]).length]));return '+JSON.stringify(candidates)+'.find(id=>(byId.get(id)||0)>=1)||null})()');
  assert(twoLevel,'No enabled model exposes a thinking level, so the level A/B cannot be exercised');
  const addAgain='(()=>{const e=document.querySelector("[data-testid=consult-add-model]");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(e,'+JSON.stringify(twoLevel)+');e.dispatchEvent(new Event("change",{bubbles:true}));return true})()';
  await evaluate(addAgain);await wait(150);
  const twice=await evaluate('(()=>{const rows=[...document.querySelectorAll(".consult-settings-member")];const mine=rows.filter(r=>r.querySelector(".consult-settings-model small").textContent.startsWith('+JSON.stringify(twoLevel)+'));return {members:rows.length,levels:mine.map(r=>r.querySelector("select").value)}})()');
  assert.equal(twice.members,candidates.length+1,'The same model could not be added a second time: '+JSON.stringify(twice));
  assert.equal(new Set(twice.levels).size,2,'The second entry reused the same thinking level: '+JSON.stringify(twice));
  await screenshot('same-model-two-levels');
  await click('[aria-label="移除模型 1"]');await wait(200);
  const afterRemove=await evaluate('(()=>{const e=document.querySelector("[data-testid=consult-add-model]");return {exists:Boolean(e),members:document.querySelectorAll(".consult-settings-member").length}})()');
  assert(afterRemove.exists,'Candidate dropdown disappeared after removing a participant');
  assert.equal(afterRemove.members,candidates.length,JSON.stringify(afterRemove));
  return {candidates:candidates.length,added:added.members,twoLevelModel:twoLevel,levels:twice.levels};
 });
}

report.status=report.tests.every(t=>t.status==='passed')?'passed':'failed';
}catch(e){report.status='failed';report.error=e.stack;console.error(e.stack);}
finally{if(socket){try{await rpc('Browser.close');}catch{}socket.close();}for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Closed'));}pending.clear();if(child){await wait(600);if(child.exitCode===null){try{cp.execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});}catch{}}}if(fd!==undefined)fs.closeSync(fd);try{fs.rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:200});report.profileRemoved=true;}catch(e){report.cleanupError=e.message;report.status='failed';}report.finishedAt=new Date().toISOString();save();process.exitCode=report.status==='passed'?0:1;console.log(JSON.stringify({status:report.status,report:path.join(out,'results.json')}));}})();
