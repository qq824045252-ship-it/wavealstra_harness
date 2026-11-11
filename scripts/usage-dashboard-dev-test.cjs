/** Real desktop pnpm dev -> Electron -> preload -> usage IPC. No mocks or performance claims. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),net=require('node:net'),os=require('node:os');
const root=path.resolve(__dirname,'..');
assert.equal(process.platform,'linux');assert(process.env.WAYLAND_DISPLAY||process.env.DISPLAY,'Real desktop required');
const out=path.join(root,'out/diagnostics/usage-dashboard-dev');fs.mkdirSync(out,{recursive:true});
const home=fs.mkdtempSync(path.join(os.tmpdir(),'udg-')),agentDir=path.join(home,'.mybuddy');fs.mkdirSync(agentDir,{recursive:true});
let processDev,socket,sequence=0,log,electronExecutable,devDebugPort,launcherIdentity,electronWatch,electronSeenAt;
const ownedElectronMains=new Map(),pending=new Map();
const report={status:'running',home,displayMode:'real desktop session',inputMode:'CDP input and DOM activation',validatesNativeDesktopInput:false,checks:[],rendererErrors:[],ranges:[]};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label)=>{const end=Date.now()+120000;while(!await fn()){if(Date.now()>end)throw Error('timeout: '+label);await wait(100);}};
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
function linuxProcessState(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, parent: Number(fields[1]), startedAt: fields[19],
      args: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) };
  } catch { return undefined; } // The process may have exited between proc reads.
}
const observedDescendants = new Map();
function isTestElectronMain(state) {
  if (!state || observedDescendants.get(state.pid) !== state.startedAt) return false;
  // Electron rewrites Linux argv into one space-separated entry and clears its
  // initial environ. Bind executable/cwd, launcher ancestry, unique debug port
  // and PID start-time rather than relying on NUL-separated argv or HOME.
  const command = state.args.join(' ');
  if (/(?:^|\s)--type(?:=|\s)/.test(command)
    || !new RegExp('(?:^|\\s)--remote-debugging-port=' + devDebugPort + '(?:\\s|$)').test(command)) return false;
  try { return fs.realpathSync('/proc/'+state.pid+'/exe') === electronExecutable
    && fs.realpathSync('/proc/'+state.pid+'/cwd') === fs.realpathSync(root); }
  catch { return false; }
}
function trackTestElectronMains() {
  if (!launcherIdentity) return;
  const launcher = linuxProcessState(launcherIdentity.pid);
  if (!launcher || launcher.startedAt !== launcherIdentity.startedAt) return;
  const queue = [launcher], seen = new Set();
  while (queue.length) {
    const state = queue.shift(); if (seen.has(state.pid)) continue; seen.add(state.pid);
    observedDescendants.set(state.pid, state.startedAt);
    if (isTestElectronMain(state)) ownedElectronMains.set(state.pid, state.startedAt);
    let children;try { children=fs.readFileSync('/proc/'+state.pid+'/task/'+state.pid+'/children','utf8').trim().split(/\s+/).filter(Boolean); }catch{continue;}
    for(const id of children){const child=linuxProcessState(Number(id));if(child?.parent===state.pid)queue.push(child);}
  }
}
async function stopTestElectronMains() {
  if (process.platform !== 'linux') return;
  trackTestElectronMains();
  const stillOwned = (pid, startedAt) => {
    const state = linuxProcessState(pid);
    return state?.startedAt === startedAt && isTestElectronMain(state);
  };
  for (const [pid, startedAt] of ownedElectronMains) if (stillOwned(pid, startedAt)) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  // Only the main process receives a signal. Let Electron close its GPU/renderers
  // itself; PID start time and the isolated profile prevent unrelated-process kills.
  const deadline = Date.now() + 3000;
  while ([...ownedElectronMains].some(([pid, startedAt]) => stillOwned(pid, startedAt)) && Date.now() < deadline) await wait(50);
}
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result?.value;
}
const count=n=>Math.round(n).toLocaleString('en-US'),token=n=>(Math.max(0,n)/1e6).toFixed(3)+'M';
const value=(n,k)=>k===false?(n>0?'已知 '+token(n):'未知'):token(n),allKnown=k=>!k||Boolean(k.input&&k.output&&k.cacheRead&&k.cacheWrite);
const rate=n=>n===null?'未知':n>0&&n<.01?(n*100).toFixed(1)+'%':Math.round(n*100)+'%';
const duration=ms=>{if(ms<=0)return '—';if(ms<60000)return Math.max(1,Math.round(ms/1000))+'秒';const m=Math.round(ms/60000);if(m<60)return m+'分钟';const h=Math.floor(m/60),r=m%60;if(h<24)return r?h+'小时 '+r+'分钟':h+'小时';const d=Math.floor(h/24),rh=h%24;return rh?d+'天 '+rh+'小时':d+'天';};
async function click(selector,label){await evaluate('(()=>{const b=[...document.querySelectorAll('+JSON.stringify(selector)+')].find(b=>b.textContent.trim()==='+JSON.stringify(label)+');if(!b)throw Error("Missing button");b.click()})()');}
async function ready(){await until(()=>evaluate('Boolean(document.querySelector(".us-kpis")&&!document.querySelector(".us-empty--error")&&!document.querySelector(".us-text-btn[disabled]"))'),'usage data');}
async function open(){await evaluate('document.querySelector(".sidebar-user-main").click()');await click('button','用量统计');await ready();}
async function shot(name){const s=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));}
async function inspect(range){
 await ready();const dto=await evaluate('window.api.usage.dashboard('+range+')');
 const dom=await evaluate('({kpis:[...document.querySelectorAll(".us-kpi-value")].map(x=>x.textContent),stats:[...document.querySelectorAll(".us-stat-value")].map(x=>x.textContent),heat:[...document.querySelectorAll(".us-heat-cell[title]")].map(x=>x.title),selected:document.querySelector(".us-range-btn.active").textContent})');
 assert.equal(dto.rangeDays,range);
 assert.deepEqual(dom.kpis,[value(dto.totalTokens,allKnown(dto.known)),token(dto.dailyPeakTokens),duration(dto.longestTaskMs),count(dto.currentStreakDays)+' 天',count(dto.longestStreakDays)+' 天']);
 assert.deepEqual(dom.stats,[count(dto.sessions),count(dto.runs),value(dto.avgTokensPerRun,allKnown(dto.known)),duration(dto.longestTaskMs),value(dto.input,dto.known?.input),value(dto.output,dto.known?.output),value(dto.cacheRead,dto.known?.cacheRead),value(dto.cacheWrite,dto.known?.cacheWrite),value(dto.cacheRead+dto.cacheWrite,dto.known?.cacheRead!==false&&dto.known?.cacheWrite!==false),rate(dto.cacheHitRate)]);
 assert.equal(dto.days.length,Math.max(371,range));
 assert.deepEqual(dom.heat,dto.days.map(d=>d.date+': '+token(d.tokens)+' tokens / '+count(d.calls)+' 次'),'every daily cell matches IPC DTO');
 const skills=[];for(let p=0;p<Math.max(1,Math.ceil(dto.skills.length/6));p++){
  skills.push(...await evaluate('[...document.querySelectorAll(".us-skill-list li")].map(x=>({name:x.querySelector(".us-skill-name").textContent.slice(1),count:x.querySelector(".us-skill-count").textContent}))'));
  if((p+1)*6<dto.skills.length){await evaluate('document.querySelector(".us-split > section:first-child .us-pager button:last-child").click()');await wait(100);}
 }assert.deepEqual(skills,dto.skills.map(s=>({name:s.name,count:count(s.count)+'次'})));
 const models=[];for(let p=0;p<Math.max(1,Math.ceil(dto.models.length/4));p++){
  models.push(...await evaluate('[...document.querySelectorAll(".us-model")].map(x=>({name:x.querySelector(".us-model-name").textContent,provider:x.querySelector(".us-model-prov").textContent,total:x.querySelector(".us-model-total > div").textContent,metrics:[...x.querySelectorAll(".us-model-metrics > span")].map(s=>s.textContent)}))'));
  if((p+1)*4<dto.models.length){await evaluate('document.querySelector(".us-split > section:last-child .us-pager button:last-child").click()');await wait(100);}
 }assert.deepEqual(models,dto.models.map(m=>({name:m.model,provider:m.provider,total:value(m.totalTokens,allKnown(m.known)),metrics:['输入 '+value(m.input,m.known?.input),'输出 '+value(m.output,m.known?.output),'缓存读取 '+value(m.cacheRead,m.known?.cacheRead),'缓存写入 '+value(m.cacheWrite,m.known?.cacheWrite),'缓存命中率 '+rate(m.cacheHitRate),count(m.calls)+'次']})));
 report.ranges.push({range,dto,dom,skills,models});report.checks.push(range+'d: rendered KPI/stat/model/skill values and '+dto.days.length+' daily cells equal real IPC DTO');
}
(async()=>{try{
 const seed=path.join(out,'seed.cjs');await require('esbuild').build({entryPoints:[path.join(root,'scripts/usage-dashboard-dev-seed.ts')],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:seed});
 cp.execFileSync(process.execPath,[seed],{cwd:root,env:{...process.env,HOME:home,USAGE_DASHBOARD_TEST_HOME:home,TMPDIR:home},stdio:'inherit'});
 fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',apiKey:'synthetic-not-a-secret',baseUrl:'http://127.0.0.1:1/v1',models:[{id:'fixture',name:'Synthetic usage fixture',reasoning:false,input:['text'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'fixture',enabledModels:['fixture/fixture'],memoryEnabled:false,memoryGatewayEnabled:false,remoteAccessEnabled:false,closeToTray:false,theme:'light',permissionMode:'readonly'}));
 const port=await freePort();devDebugPort=port;electronExecutable=fs.realpathSync(require('electron'));
 const env={...process.env,HOME:home,USERPROFILE:home,TMPDIR:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_DATA_HOME:path.join(home,'.local/share'),REMOTE_DEBUGGING_PORT:String(port),ELECTRON_CLI_ARGS:JSON.stringify(['--remote-debugging-address=127.0.0.1','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--enable-logging=stderr'])};delete env.ELECTRON_RUN_AS_NODE;
 assert(process.env.npm_execpath&&fs.existsSync(process.env.npm_execpath),'Run through pnpm test:usage-dashboard-dev');
 log=fs.openSync(path.join(out,'dev.log'),'w');const native=!/\.(?:cjs|mjs|js)$/i.test(process.env.npm_execpath);
 processDev=cp.spawn(native?process.env.npm_execpath:process.execPath,native?['dev']:[process.env.npm_execpath,'dev'],{cwd:root,env,stdio:['ignore',log,log]});
 launcherIdentity=linuxProcessState(processDev.pid);trackTestElectronMains();electronWatch=setInterval(trackTestElectronMains,100);electronWatch.unref();
 let target;await until(async()=>{if(processDev.exitCode!==null)throw Error('pnpm dev exited '+processDev.exitCode);try{target=(await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(3000)}).then(r=>r.json())).find(t=>t.type==='page'&&/localhost|127\.0\.0\.1/.test(t.url));return Boolean(target);}catch{return false;}},'dev renderer');
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.addEventListener('message',event=>{const v=JSON.parse(event.data);if(v.method==='Runtime.exceptionThrown')report.rendererErrors.push(v.params);if(v.method==='Log.entryAdded'&&v.params.entry.level==='error')report.rendererErrors.push(v.params);const call=pending.get(v.id);if(!call)return;pending.delete(v.id);clearTimeout(call.timer);v.error?call.reject(Error(JSON.stringify(v.error))):call.resolve(v.result);});
 await rpc('Runtime.enable');await rpc('Log.enable');await rpc('Page.enable');await rpc('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
 await until(()=>evaluate('Boolean(window.api?.usage?.dashboard&&document.querySelector(".sidebar-user-main"))'),'App and preload');
 const browserInfo=await fetch('http://127.0.0.1:'+port+'/json/version').then(r=>r.json());
 const browserSocket=new WebSocket(browserInfo.webSocketDebuggerUrl);
 const processInfo=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Browser process identity timeout')),10000);browserSocket.addEventListener('open',()=>browserSocket.send(JSON.stringify({id:1,method:'SystemInfo.getProcessInfo'})),{once:true});browserSocket.addEventListener('message',event=>{const response=JSON.parse(event.data);if(response.id!==1)return;clearTimeout(timer);response.error?reject(Error(JSON.stringify(response.error))):resolve(response.result.processInfo);},{once:true});browserSocket.addEventListener('error',reject,{once:true});});browserSocket.close();
 const browserProcess=processInfo.find(p=>p.type==='browser');assert(browserProcess,'CDP identifies its actual browser process');
 const mainState=linuxProcessState(browserProcess.id);assert(mainState,'CDP browser PID is readable');
 observedDescendants.set(mainState.pid,mainState.startedAt);
 report.mainIdentity={cdpBrowserPid:browserProcess.id,pid:mainState.pid,startedAt:mainState.startedAt,args:mainState.args,exe:fs.realpathSync('/proc/'+mainState.pid+'/exe'),cwd:fs.realpathSync('/proc/'+mainState.pid+'/cwd'),port};
 assert(isTestElectronMain(mainState),'CDP browser PID matches our executable, checkout and unique debug port');ownedElectronMains.set(mainState.pid,mainState.startedAt);
 trackTestElectronMains();assert(ownedElectronMains.size>0,'Tracked isolated Electron main process');
 await open();assert.equal(await evaluate('document.querySelector(".us-range-btn.active").textContent'),'今天');await inspect(1);await shot('today');
 await click('.us-range-btn','30 天');await inspect(30);await shot('30-days');
 for(const mode of ['每周','累计','每日']){await click('.us-heat-mode',mode);await wait(100);assert.equal(await evaluate('document.querySelector(".us-heat-mode[aria-selected=true]").textContent'),mode);assert(await evaluate('document.querySelectorAll(".us-heat-cell").length>=371'));}report.checks.push('Weekly/cumulative/daily modes render and switch');
 await click('.us-range-btn','全部');await inspect(3650);await shot('all-days');
 await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until(()=>evaluate('!document.querySelector(".us-panel")'),'Escape close');
 await open();assert.equal(await evaluate('document.querySelector(".us-range-btn.active").textContent'),'今天');assert.equal(await evaluate('document.querySelector(".us-heat-mode[aria-selected=true]").textContent'),'每日');await inspect(1);report.checks.push('Escape closes; reopening resets Today and Daily');
 await evaluate('document.querySelector(".us-actions [title=关闭]").click()');await until(()=>evaluate('!document.querySelector(".us-panel")'),'close button');
 assert(report.ranges.some(r=>r.models.some(m=>m.metrics.some(t=>t.includes('未知')))),'Unknown fields rendered');assert(report.ranges.some(r=>r.models.some(m=>m.total.startsWith('已知 '))),'Partially known totals rendered');assert(report.ranges.some(r=>r.models.some(m=>m.total==='0.000M')),'Known zero rendered');report.checks.push('Unknown fields, partially known totals and known zero render distinctly');assert.deepEqual(report.rendererErrors,[],'no renderer errors');report.status='passed';
}catch(error){report.status='failed';report.error=String(error.stack||error);console.error(error);process.exitCode=1;if(socket)try{report.visibleText=await evaluate('document.body.innerText');await shot('failed-page');}catch{}}
finally{
 if(electronWatch)clearInterval(electronWatch);
 if(socket){try{await rpc('Browser.close');}catch{}socket.close();}
 await stopTestElectronMains();if(processDev){await wait(1000);if(processDev.exitCode===null)processDev.kill('SIGTERM');}
 report.ownedElectronMains=[...ownedElectronMains];report.remainingOwnedMains=[...ownedElectronMains].filter(([pid,start])=>linuxProcessState(pid)?.startedAt===start&&isTestElectronMain(linuxProcessState(pid)));
 if(report.remainingOwnedMains.length){report.status='failed';process.exitCode=1;}
 if(log!==undefined)fs.closeSync(log);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('Usage dashboard dev: '+report.status+'; '+path.join(out,'report.json'));
}})();
