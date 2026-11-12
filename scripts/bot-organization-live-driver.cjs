/** Isolated pnpm dev, real model transport, real SQLite faults and owned restarts. No product build/package. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const readline = require('node:readline');
const root = path.resolve(__dirname, '..');
const baseUrl = process.env.BOT_FRONTDOOR_BASE_URL || 'http://127.0.0.1:3425/v1';
const sourceModel = process.env.BOT_FRONTDOOR_MODEL || 'auto/deepseek-v4.1-flash';
const targetModel = process.env.BOT_COLLABORATION_TARGET_MODEL || 'qwen-token-plan/qwen3.8-flash';
const modelKey = 'fixture/' + sourceModel, targetModelKey = 'fixture/' + targetModel;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let stopReason;
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const until = async (test, label, timeout = 300000) => { const end = Date.now() + timeout; for(;;){if(stopReason)throw Error(stopReason);if(await test())return;if(Date.now()>end)throw Error('timeout: '+label);await delay(150);} };
const git = args => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 60e6, stdio: ['ignore','pipe','ignore'] });
function sourceFingerprint() {
  const archived = !fs.existsSync(path.join(root,'.git'));
  const manifestPath=process.env.BOT_ORGANIZATION_SOURCE_MANIFEST;
  if(archived)assert(manifestPath&&fs.existsSync(manifestPath),'archive runs require BOT_ORGANIZATION_SOURCE_MANIFEST provenance');
  const provenance=archived?JSON.parse(fs.readFileSync(manifestPath,'utf8')):undefined;
  const walk=directory=>fs.existsSync(path.join(root,directory))?fs.readdirSync(path.join(root,directory),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(directory+'/'+entry.name):entry.isFile()?[directory+'/'+entry.name]:[]):[];
  const names = archived?[...walk('src'),...walk('scripts'),...['package.json','pnpm-lock.yaml','electron.vite.config.ts','tsconfig.node.json','tsconfig.web.json'].filter(file=>fs.existsSync(path.join(root,file)))].sort()
    :[...new Set([...git(['ls-files','-z','src','scripts','package.json','pnpm-lock.yaml','electron.vite.config.ts','tsconfig.node.json','tsconfig.web.json']).split('\0'), ...git(['ls-files','--others','--exclude-standard','-z','src','scripts']).split('\0')].filter(Boolean))].sort();
  const files = names.map(file => ({ file, sha256: fs.existsSync(path.join(root,file)) ? sha(fs.readFileSync(path.join(root,file))) : null }));
  return { capturedAt: new Date().toISOString(), ...(archived?{snapshotProvenance:provenance,sourceManifestPath:manifestPath}:{baseSHA:git(['rev-parse','HEAD']).trim(),trackedDiffSHA256:sha(git(['diff','--binary','HEAD']))}), sourceDigest: sha(JSON.stringify(files)), files };
}
const applicationSourceDigest = source => sha(JSON.stringify(source.files.filter(item=>!['scripts/bot-organization-live-driver.cjs','scripts/bot-organization-live-scenario.cjs'].includes(item.file))));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(root, 'out/diagnostics/issue32/organization-live', runId);
let home, agentDir, dbPath, devOutput, userData, socket, processDev, broker, brokerLines, log;
let sequence = 0, sqliteSequence = 0, botId = 'bot-mybuddy-default', currentRuntime;
const pending = new Map(), sqlitePending = new Map(), requests = [], transport = [], faults = [], restarts = [], runtimes = [];
const outlineWatches = new Map();
let transportFault, responseGate;
let privateFixture;
const report = { status: 'running', platform: process.platform, displayMode: 'real Electron dev/CDP', validatesNativeDesktopInput: false,
  startedAt: new Date().toISOString(), checks: [], limitations: [], runtimeEvents: runtimes, faults, restarts };
function persist() {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out,'report.json'), JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'provider-requests.json'), JSON.stringify(requests,null,2));
  fs.writeFileSync(path.join(out,'provider-audit.json'), JSON.stringify(transport,null,2));
}
function rpc(method, params = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(Error('CDP unavailable: ' + method));
  return new Promise((resolve,reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 30000); pending.set(id,{resolve,reject,timer}); socket.send(JSON.stringify({id,method,params})); });
}
async function evaluate(expression) {
  if(stopReason)throw Error(stopReason);
  new Function(expression);
  const response = await rpc('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
  if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
}
const api = (method,input) => evaluate(`window.api.botWork.${method}(${input === undefined ? '' : JSON.stringify(input)})`);
const history = () => api('history',{botId});
async function selectBot(id) {
  await evaluate(`import('/src/store/appStore.ts').then(({useAppStore})=>{const s=useAppStore.getState();s.setActiveBotId(${JSON.stringify(id)});s.setPage('bot');return s.refreshBotHistory(${JSON.stringify(id)});})`);
  botId = id;
  await until(() => evaluate('Boolean(document.querySelector("#bot-draft"))'), 'selected Bot composer');
}
async function send(text) {
  await until(async () => { const current = await evaluate('document.querySelector("#bot-draft")?.value'); if (current === text) return true; if (current === '') { await evaluate('document.querySelector("#bot-draft").focus()'); await rpc('Input.insertText',{text}); } return false; }, 'one real composer draft');
  await evaluate('document.querySelector(".bot-composer button[type=submit]").click()');
  await until(() => evaluate('document.querySelector("#bot-draft")?.value === ""'), 'real source request accepted');
}
async function submit(text, endpoint = botId) {
  if (endpoint !== botId) await selectBot(endpoint);
  await send(text); let user, answer;
  await until(async () => { const page = await history(); user = page.messages.findLast(item => item.role === 'user' && item.text === text); answer = user && page.messages.find(item => item.role === 'assistant' && item.requestId === user.requestId); return answer && ['completed','failed','cancelled','unknown'].includes(answer.status); }, 'real foreground completion');
  return {user,answer};
}
const provider = http.createServer(async (request,response) => {
  const controller = new AbortController(); let entry;
  response.once('close', () => { controller.abort(); if (entry) { entry.downstreamClosedAt = Date.now(); persist(); } });
  try {
    let raw=''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), index = requests.push(body)-1;
    entry = { index, startedAt: Date.now(), model: body.model, forwarded: false };
    transport.push(entry); persist();
    if (transportFault && body.model === targetModel && raw.includes(transportFault.marker)) {
      entry.controlledFailure = transportFault.kind; entry.endedAt = Date.now();
      response.writeHead(503,{'content-type':'application/json'}); response.end(JSON.stringify({error:{message:'Controlled isolated organization transport failure',type:'service_unavailable'}})); persist(); return;
    }
    entry.forwarded = true;
    const upstream = await fetch(baseUrl.replace(/\/$/,'')+'/chat/completions', {method:'POST',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(300000)]),headers:{'content-type':'application/json'},body:raw});
    entry.upstreamStatus = upstream.status; entry.upstreamHeadersAt = Date.now();
    const gate = responseGate;
    if (gate && body.model === targetModel && raw.includes(gate.marker) && (!gate.afterFile || fs.existsSync(gate.afterFile))) {
      entry.heldAt = Date.now(); gate.hits.push(entry); persist();
      await Promise.race([gate.release, new Promise((_,reject) => controller.signal.addEventListener('abort',() => reject(Error('owned runtime disconnected during observed response gate')),{once:true}))]);
      entry.releasedAt = Date.now();
    }
    response.writeHead(upstream.status, {'content-type':upstream.headers.get('content-type') || 'text/event-stream'});
    for await (const chunk of upstream.body) response.write(chunk);
    entry.endedAt = Date.now(); response.end(); persist();
  } catch (error) { if (entry) entry.error = String(error); if (!response.destroyed) { if (!response.headersSent) response.writeHead(502); response.end(String(error)); } persist(); }
});
function newGate(marker,afterFile) {
  let release; const gate = { marker, afterFile, hits:[], release:new Promise(resolve => {release=resolve;}), open:() => {release();if(responseGate===gate)responseGate=undefined;} };
  responseGate=gate; return gate;
}

async function startSqliteBroker() {
  const file=path.join(out,'sqlite-broker.cjs');
  fs.writeFileSync(file,`const {createRequire}=require('node:module');const requireRoot=createRequire(${JSON.stringify(path.join(root,'package.json'))});const db=new(requireRoot('better-sqlite3'))(process.argv[2]);db.pragma('busy_timeout=10000');const lines=require('node:readline').createInterface({input:process.stdin});lines.on('line',line=>{let command;try{command=JSON.parse(line);let result;if(command.method==='close'){db.close();process.stdout.write(JSON.stringify({id:command.id,result:true})+'\\n');process.exit(0);}if(command.method==='exec'){db.exec(command.sql);result=true;}else result=db.prepare(command.sql)[command.method](...(command.params||[]));process.stdout.write(JSON.stringify({id:command.id,result})+'\\n');}catch(error){process.stdout.write(JSON.stringify({id:command?.id,error:String(error.stack||error)})+'\\n');}});`);
  broker=cp.spawn(require('electron'),[file,dbPath],{cwd:root,env:{...process.env,HOME:home,USERPROFILE:home,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
  broker.stderr.on('data',data=>fs.appendFileSync(path.join(out,'sqlite-broker.log'),data));
  brokerLines=readline.createInterface({input:broker.stdout});
  brokerLines.on('line',line=>{let response;try{response=JSON.parse(line);}catch{return;}const task=sqlitePending.get(response.id);if(!task)return;sqlitePending.delete(response.id);clearTimeout(task.timer);response.error?task.reject(Error(response.error)):task.resolve(response.result);});
  broker.once('exit',()=>{for(const task of sqlitePending.values()){clearTimeout(task.timer);task.reject(Error('isolated SQLite broker exited'));}sqlitePending.clear();});
  assert.equal(await sql('get','SELECT 1 AS value').then(row=>row.value),1);
}
function sql(method,query='',params=[]) {
  assert(dbPath && path.resolve(dbPath).startsWith(path.resolve(home)+path.sep),'SQLite path is inside the isolated HOME');
  return new Promise((resolve,reject)=>{const id=++sqliteSequence,timer=setTimeout(()=>{sqlitePending.delete(id);reject(Error('SQLite broker timeout'));},20000);sqlitePending.set(id,{resolve,reject,timer});broker.stdin.write(JSON.stringify({id,method,sql:query,params})+'\n');});
}
const literal = value => "'"+String(value).replace(/'/g,"''")+"'";
async function snapshot(targetName) {
  const organizations=await sql('all',`SELECT organization_id,request_json,expected_revision,applied_revision,value_json FROM bot_organization_records ORDER BY created_at DESC`);
  const intents=organizations.map(row=>({...row,plan:JSON.parse(row.request_json),view:JSON.parse(row.value_json)})).filter(row=>!targetName||row.plan.target?.displayName===targetName||row.view.target?.displayName===targetName);
  const bots=await sql('all','SELECT bot_id,display_name,status,created_at,updated_at FROM bots');
  const works=await sql('all',`SELECT w.work_id,w.owner_bot_id,w.source_message_id,w.workspace_path,w.title,w.lifecycle,w.closure_conclusion,w.intent_revision,w.state_version,
    (SELECT json_extract(s.settings_json,'$.effectiveWorkspacePath') FROM bot_work_settings s WHERE s.work_id=w.work_id) AS frozen_workspace_path,
    (SELECT source_conversation_id FROM bot_collaborations c WHERE c.work_id=w.work_id) AS conversation_id FROM works w`);
  const bindings=await sql('all','SELECT binding_id,work_id,task_id,status,admitted_at,settled_at,intent_revision FROM work_execution_bindings');
  const feedback=await sql('all','SELECT message_id,metadata_json FROM bot_work_feedback');
  return { observedAt:Date.now(),intents,bots,works,bindings,feedback };
}
function bundles() { return ['main/index.js','preload/index.js'].map(file=>{const absolute=path.join(devOutput,file);return fs.existsSync(absolute)?{file,sha256:sha(fs.readFileSync(absolute)),modifiedAt:fs.statSync(absolute).mtime.toISOString()}:{file,missing:true};}); }
async function launch() {
  const port=await freePort(), bootstrap=path.join(out,'isolated-electron-bootstrap.cjs'), identityFile=path.join(out,'main-identities.jsonl');
  fs.writeFileSync(bootstrap,[
    "const {createRequire}=require('node:module');",`const requireRoot=createRequire(${JSON.stringify(path.join(root,'package.json'))});`,
    "const {app,ipcMain}=requireRoot('electron');const fs=require('node:fs');",
    `app.setAppPath(${JSON.stringify(root)});app.setPath('userData',${JSON.stringify(userData)});`,
    `fs.appendFileSync(${JSON.stringify(identityFile)},JSON.stringify({pid:process.pid,startedAt:Date.now(),home:process.env.HOME,userData:app.getPath('userData'),appPath:app.getAppPath(),bootstrap:__filename,debugPort:${port}})+'\\n');`,
    `const audit=${JSON.stringify(path.join(out,'official-file-open.jsonl'))};`,
    "const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,listener)=>handle(channel,['workspace:openFolder','workspace:readFile','saved-artifact:prepare'].includes(channel)?async(...args)=>{const target=channel==='saved-artifact:prepare'?args[1]?.snapshotPath:args[1];fs.appendFileSync(audit,JSON.stringify({phase:'started',channel,target,at:Date.now()})+'\\n');try{const value=await listener(...args);fs.appendFileSync(audit,JSON.stringify({phase:'completed',channel,target,at:Date.now()})+'\\n');return value;}catch(error){fs.appendFileSync(audit,JSON.stringify({phase:'failed',channel,target,at:Date.now(),error:String(error)})+'\\n');throw error;}}:listener);",
    `require(${JSON.stringify(path.join(devOutput,'main/index.js'))});`,
  ].join('\n'));
  new(require('node:vm').Script)(fs.readFileSync(bootstrap,'utf8'),{filename:bootstrap});
  const source=sourceFingerprint(); if(report.sourceAtLaunch)assert.equal(source.sourceDigest,report.sourceAtLaunch.sourceDigest,'production/script source stays frozen throughout this exact run');else{report.sourceAtLaunch=source;report.applicationSourceDigest=applicationSourceDigest(source);}
  const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_DATA_HOME:path.join(home,'.local/share'),REMOTE_DEBUGGING_PORT:String(port),ELECTRON_CLI_ARGS:JSON.stringify(['--remote-debugging-address=127.0.0.1','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows'])};
  delete env.ELECTRON_RUN_AS_NODE;
  assert(process.env.npm_execpath&&fs.existsSync(process.env.npm_execpath),'launch this driver with pnpm exec node scripts/bot-organization-live-driver.cjs');
  // Keep dependency optimization local to this run, never in shared/junction node_modules.
  const configPath=path.join(out,'isolated-vite.config.mjs');
  const nodeWrite=process.env.BOT_LIVE_NODE_WRITE==='1';
  const cacheDir=path.join(out,'vite-cache');
  const cacheAdapter=nodeWrite?`import fs from 'node:fs';import path from 'node:path';
const cacheRoot=${JSON.stringify(cacheDir)};
const outputPlugin={name:'isolated-node-cache-write',setup(build){build.onEnd(result=>{if(result.errors.length)return;for(const file of result.outputFiles||[]){if(file.path==='<stdout>')continue;const relative=path.relative(cacheRoot,file.path);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('cache output escaped isolated root');fs.mkdirSync(path.dirname(file.path),{recursive:true});fs.writeFileSync(file.path,file.contents);}})}};
` : '';
  fs.writeFileSync(configPath,'import config from '+JSON.stringify(path.join(root,'electron.vite.config.ts').replaceAll('\\','/'))+';\n'+cacheAdapter+'export default {...config,renderer:{...config.renderer,cacheDir:'+JSON.stringify(cacheDir)+(nodeWrite?',optimizeDeps:{...config.renderer?.optimizeDeps,esbuildOptions:{...config.renderer?.optimizeDeps?.esbuildOptions,write:false,plugins:[...(config.renderer?.optimizeDeps?.esbuildOptions?.plugins||[]),outputPlugin]}}':'')+'}};\n');
  report.testNodeCacheWriter=nodeWrite;
  const native=!/\.(?:cjs|mjs|js)$/i.test(process.env.npm_execpath),args=['dev','--config',configPath,'--outDir',devOutput,'--entry',bootstrap];
  if(log!==undefined)fs.closeSync(log);log=fs.openSync(path.join(out,'dev.log'),'a');
  processDev=cp.spawn(native?process.env.npm_execpath:process.execPath,native?args:[process.env.npm_execpath,...args],{cwd:root,env,windowsHide:true,stdio:['ignore',log,log]});
  let target;
  await until(async()=>{if(processDev.exitCode!==null)throw Error('owned pnpm dev exited '+processDev.exitCode);try{target=(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json())).find(item=>item.type==='page'&&/localhost|127\.0\.0\.1/.test(item.url));return Boolean(target);}catch{return false;}},'isolated Electron CDP');
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const value=JSON.parse(event.data),task=pending.get(value.id);if(!task)return;pending.delete(value.id);clearTimeout(task.timer);value.error?task.reject(Error(JSON.stringify(value.error))):task.resolve(value.result);});
  socket.addEventListener('close',()=>{for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error('owned runtime CDP closed'));}pending.clear();});
  const identities=fs.readFileSync(identityFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));currentRuntime=identities.findLast(value=>value.debugPort===port);
  assert(currentRuntime&&currentRuntime.home===home&&currentRuntime.userData===userData,'real main identity confirms isolated HOME and Chromium profile');
  await rpc('Runtime.enable');await rpc('Page.enable');await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await until(()=>evaluate('Boolean(window.api?.botWork?.history) && /^https?:$/.test(location.protocol) && document.readyState !== \"loading\"'), 'committed real renderer and preload');
  await selectBot('bot-mybuddy-default');
  await until(()=>api('hostStatus').then(value=>value.isAuthority),'isolated authoritative host');
  currentRuntime.launcherPid=processDev.pid;currentRuntime.bundles=bundles();runtimes.push(currentRuntime);persist();
  return currentRuntime;
}
async function stopOwnedRuntime() {
  if(!currentRuntime)return;
  const identity=currentRuntime;
  assert.equal(fs.realpathSync(identity.home),fs.realpathSync(home));assert.equal(identity.userData,userData);
  if(socket){try{await rpc('Browser.close');}catch{}socket.close();socket=undefined;}
  await delay(1000);
  if(process.platform==='win32') {
    const ps=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${identity.pid}' -ErrorAction SilentlyContinue;if($p){$p|Select-Object ProcessId,ExecutablePath,CommandLine|ConvertTo-Json -Compress}`;
    const raw=cp.execFileSync('powershell.exe',['-NoProfile','-Command',ps],{encoding:'utf8',windowsHide:true}).trim();
    if(raw){const actual=JSON.parse(raw);assert.equal(path.resolve(actual.ExecutablePath).toLowerCase(),path.resolve(require('electron')).toLowerCase(),'only owned Electron executable may stop');assert(actual.CommandLine.includes(path.join(out,'isolated-electron-bootstrap.cjs')),'exact unique fixture bootstrap identifies owned main');cp.execFileSync('powershell.exe',['-NoProfile','-Command',`Stop-Process -Id ${identity.pid} -ErrorAction Stop`],{windowsHide:true});}
  } else {try{process.kill(identity.pid,0);const args=fs.readFileSync(`/proc/${identity.pid}/cmdline`,'utf8');assert(args.includes(path.join(out,'isolated-electron-bootstrap.cjs')),'exact fixture bootstrap owns main');process.kill(identity.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH'&&error.code!=='ENOENT')throw error;}}
  if(processDev&&processDev.exitCode===null)processDev.kill('SIGTERM');
  currentRuntime=undefined;
}

// Hooks below act only on this synthetic database and this owned runtime.
async function installTrigger(spec,variant=spec.kind) {
  const trigger='org_live_'+crypto.randomBytes(5).toString('hex');let statement;
  if(variant==='creation_storage')statement=`CREATE TRIGGER ${trigger} BEFORE INSERT ON bot_expert_versions WHEN NEW.version=1 AND (SELECT display_name FROM bots WHERE bot_id=NEW.bot_id)=${literal(spec.targetName)} BEGIN SELECT RAISE(ABORT,'ORG_LIVE creation storage'); END`;
  else if(variant==='creation_response_loss')statement=`CREATE TRIGGER ${trigger} BEFORE UPDATE OF value_json ON bot_organization_records WHEN json_extract(NEW.request_json,'$.target.displayName')=${literal(spec.targetName)} AND json_extract(OLD.value_json,'$.target') IS NULL AND json_extract(NEW.value_json,'$.target.botId') IS NOT NULL BEGIN SELECT RAISE(ABORT,'ORG_LIVE committed creation acknowledgement lost'); END`;
  else if(variant==='dispatch_storage'||variant==='created_before_contact')statement=`CREATE TRIGGER ${trigger} BEFORE INSERT ON work_dispatch_requests WHEN (SELECT display_name FROM bots WHERE bot_id=NEW.bot_id)=${literal(spec.targetName)} BEGIN SELECT RAISE(ABORT,'ORG_LIVE dispatch storage'); END`;
  else if(variant==='delivery_storage'||variant==='artifact_pending_return')statement=`CREATE TRIGGER ${trigger} BEFORE INSERT ON bot_work_feedback WHEN json_extract(NEW.metadata_json,'$.category')='result' AND json_extract(NEW.metadata_json,'$.workId') IN (SELECT w.work_id FROM works w JOIN bots b ON b.bot_id=w.owner_bot_id WHERE b.display_name=${literal(spec.targetName)}) BEGIN SELECT RAISE(ABORT,'ORG_LIVE result delivery storage'); END`;
  else throw Error('unsupported actual SQL fault '+variant);
  await sql('exec',statement);return {trigger,statement,drop:()=>sql('exec',`DROP TRIGGER IF EXISTS ${trigger}`)};
}
async function observeFault(spec) {
  let state;
  await until(async()=>{
    state=await snapshot(spec.targetName);const intent=state.intents[0]?.view;
    if(spec.kind==='creation_storage')return intent?.phase==='creation_failed';
    if(spec.kind==='creation_response_loss')return intent?.phase==='creation_failed'&&state.bots.some(bot=>bot.display_name===spec.targetName)&&!intent.target;
    if(spec.kind==='dispatch_storage'||spec.stage==='created_before_contact')return intent?.phase==='contact_failed'&&Boolean(intent.target)&&!state.works.some(work=>work.owner_bot_id===intent.target.botId);
    const target=state.bots.find(bot=>bot.display_name===spec.targetName),works=state.works.filter(work=>work.owner_bot_id===target?.bot_id),ids=new Set(works.map(work=>work.work_id));
    if(spec.kind==='execution_transport')return state.bindings.some(binding=>ids.has(binding.work_id)&&['failed','unknown','stopped'].includes(binding.status))&&transport.some(item=>item.controlledFailure===spec.kind);
    if(spec.kind==='delivery_storage'||spec.stage==='artifact_pending_return')return state.bindings.some(binding=>ids.has(binding.work_id)&&binding.status==='completed'&&binding.settled_at!==null)
      &&works.some(work=>{const directory=work.workspace_path||work.frozen_workspace_path;return directory&&fs.existsSync(path.join(directory,spec.output));})
      &&state.feedback.every(item=>!ids.has(JSON.parse(item.metadata_json).workId)||JSON.parse(item.metadata_json).category!=='result');
    return false;
  },'actual persisted '+(spec.kind||spec.stage)+' fault hit');return state;
}
async function fault(spec,execute) {
  let trigger;const row={kind:spec.kind,installedAt:Date.now(),targetName:spec.targetName,events:[]};faults.push(row);persist();
  try {
    if(spec.kind==='execution_transport')transportFault={kind:spec.kind,marker:spec.marker};else trigger=await installTrigger(spec);
    row.sql=trigger?.statement;
    const activity=execute().then(value=>({value}),error=>({error:String(error)}));
    row.stateBeforeRelease=await observeFault(spec);row.hitAt=row.stateBeforeRelease.observedAt;row.intentId=row.stateBeforeRelease.intents[0]?.view.intentId;
    row.events.push({at:row.hitAt,type:'actual production failure observed'});persist();
    if(trigger)await trigger.drop();transportFault=undefined;row.releasedAt=Date.now();
    const completed=await activity;row.foregroundError=completed.error;persist();return {value:completed.value,evidence:row};
  } finally {if(trigger)await trigger.drop();transportFault=undefined;persist();}
}
async function restart(spec,execute) {
  let trigger,gate;const row={stage:spec.stage,targetName:spec.targetName,home,events:[]};restarts.push(row);
  try {
    if(spec.stage==='execution_in_progress'){
      assert(spec.directory,'execution restart requires an actual completed outline directory');
      const file=path.join(spec.directory,'outline-'+spec.stage+'.md'),events=[];
      const watcher=fs.watch(spec.directory,(eventType,filename)=>{if(String(filename)===path.basename(file)){const entry={at:Date.now(),eventType,file};if(fs.existsSync(file)){entry.sha256=sha(fs.readFileSync(file));entry.modifiedAt=fs.statSync(file).mtimeMs;}events.push(entry);persist();}});watcher.unref();
      outlineWatches.set(file,{watcher,events});row.outlineWriteAudit=events;row.outlineFile=file;gate=newGate(spec.marker,file);
    }else trigger=await installTrigger(spec,spec.stage);
    const activity=execute().then(value=>({value}),error=>({error:String(error)}));
    if(gate){await until(async()=>{const state=await snapshot(spec.targetName),target=state.bots.find(bot=>bot.display_name===spec.targetName),ids=new Set(state.works.filter(work=>work.owner_bot_id===target?.bot_id).map(work=>work.work_id));if(gate.hits.length&&state.bindings.some(binding=>ids.has(binding.work_id)&&['submitted','running'].includes(binding.status))){row.stateBeforeRestart=state;return true;}return false;},'real native execution and upstream response pending');}
    else row.stateBeforeRestart=await observeFault(spec);
    row.observedAt=Date.now();row.oldPid=currentRuntime.pid;row.intentId=row.stateBeforeRestart.intents[0]?.view.intentId;
    if(row.outlineFile){assert(fs.existsSync(row.outlineFile));row.outlineBeforeRestart={sha256:sha(fs.readFileSync(row.outlineFile)),modifiedAt:fs.statSync(row.outlineFile).mtimeMs,writeEvents:row.outlineWriteAudit.length};row.outlineToolReceiptsBefore=outlineToolReceipts(row.outlineFile);assert(row.outlineBeforeRestart.writeEvents>0,'OS observed actual outline write');assert(row.outlineToolReceiptsBefore.some(item=>item.completed),'native transcript contains actual successful outline tool receipt');}
    row.events.push({at:row.observedAt,type:'actual persisted restart checkpoint'});persist();
    await stopOwnedRuntime();if(gate)gate.open();await launch();row.newPid=currentRuntime.pid;
    if(trigger)await trigger.drop();row.stateAfterRestart=await snapshot(spec.targetName);row.events.push({at:Date.now(),type:'new owned main observed with same HOME'});persist();
    const completed=await activity;row.foregroundInterruption=completed.error;return {value:completed.value,evidence:row};
  } finally {if(trigger)await trigger.drop();if(gate)gate.open();persist();}
}

function outlineToolReceipts(file) {
  const records=new Map();
  for(const request of requests)for(const message of request.messages??[])for(const call of message.tool_calls??[]){
    if(!JSON.stringify(call.function?.arguments??'').includes(path.basename(file)))continue;
    const id=call.id;if(!id)continue;
    const result=(request.messages??[]).find(item=>item.role==='tool'&&item.tool_call_id===id);
    records.set(id,{id,name:call.function?.name,arguments:call.function?.arguments,completed:Boolean(result),result:result?.content});
  }
  return [...records.values()];
}
async function verifyRestart(_spec,evidence) {
  const file=evidence.outlineFile,watch=outlineWatches.get(file);assert(watch,'continuous OS write watcher exists');
  await delay(300);
  const after={sha256:sha(fs.readFileSync(file)),modifiedAt:fs.statSync(file).mtimeMs,writeEvents:watch.events.length,toolReceipts:outlineToolReceipts(file)};
  const originalIds=new Set(evidence.outlineToolReceiptsBefore.map(item=>item.id));
  const repeated=after.toolReceipts.filter(item=>!originalIds.has(item.id)&&['write','edit','bash'].includes(item.name));
  const noRepeatedOutlineWrite=after.writeEvents===evidence.outlineBeforeRestart.writeEvents&&after.modifiedAt===evidence.outlineBeforeRestart.modifiedAt&&after.sha256===evidence.outlineBeforeRestart.sha256&&repeated.length===0;
  assert(noRepeatedOutlineWrite,'completed outline cannot be silently replayed after restart');
  watch.watcher.close();outlineWatches.delete(file);return {before:evidence.outlineBeforeRestart,after,newOutlineToolCalls:repeated,noRepeatedOutlineWrite};
}

async function boundary(spec,execute) {
  if(spec.phase==='concurrent_amend_cancel')return concurrentBoundary(spec,execute);
  if(spec.phase==='private_fixture')return privateSetup(spec);
  if(spec.phase==='verify_role_private_origin')return verifyPrivateBoundary(spec);
  throw Error('unknown actual boundary '+spec.phase);
}

async function organizationsMatching(predicate) {
  const state=await snapshot();return state.intents.map(item=>item.view).filter(item=>item.kind==='intent'&&predicate(item));
}
async function waitOrganization(predicate,label) {
  let found;await until(async()=>{found=(await organizationsMatching(predicate)).findLast(item=>item.phase==='linked');return Boolean(found);},label);return found;
}
const journalFor = (organization,endpoint='bot-mybuddy-default') => api('collaborationHistory',{botId:endpoint,collaborationId:organization.collaborationId,limit:100});
async function workFor(organization) {let observed;await until(async()=>{observed=await require('./bot-organization-live-state.cjs').observeRecipientWork(()=>journalFor(organization),id=>api('getWork',id));return Boolean(observed.work);},'B foreground decision and actual unique Work');return observed.work;}
async function finishWork(workId) {let work;await until(async()=>{work=await api('getWork',workId);return work?.lifecycle==='closed';},'actual Work settlement',600000);return work;}
async function concurrentBoundary(spec,execute) {
  const evidence={phase:spec.phase,events:[]};let gate=newGate(spec.marker);
  try {
    const initial=execute();
    const incident=await waitOrganization(item=>item.target?.displayName==='工单整理员-'+spec.seed,'actual incident organization');
    const calendar=await waitOrganization(item=>item.target?.displayName==='日程整理员-'+spec.seed,'actual calendar organization');
    const beforeIncident=await workFor(incident),beforeCalendar=await workFor(calendar);
    await until(async()=>{const state=await snapshot(),ids=new Set([beforeIncident.workId,beforeCalendar.workId]);const active=state.bindings.filter(binding=>ids.has(binding.work_id)&&['running','submitted'].includes(binding.status));if(new Set(active.map(binding=>binding.work_id)).size===2&&gate.hits.length>=2){evidence.overlap={observedAt:Date.now(),bindings:active,providerRequests:gate.hits.map(item=>item.index)};return true;}return false;},'two target-owned real native executions overlap');
    await initial;
    const quick=await submit('并发验收 '+spec.seed+'：这两件后台任务保持不变。现在只简短回答“前台仍可继续”，不要查询或取消它们。');
    assert.equal(quick.answer.status,'completed');assert(quick.answer.text.includes('前台'));evidence.frontendReply={requestId:quick.user.requestId,text:quick.answer.text,at:Date.now()};
    const amended=await submit(`只修订工单协作 ${incident.collaborationId}，先 bot_collaborate query 读取实际 versionGuard，再 amend 原 Work，保留所有原要求，并在 incident.json 增加 amendedMarker=${spec.seed}。日程协作 ${calendar.collaborationId} 完全不变，不创建新 Work。`);
    const afterIncident=await workFor(incident),afterCalendar=await workFor(calendar);
    assert(afterIncident.intentRevision>beforeIncident.intentRevision,'actual guarded amendment advances only selected Work');assert.equal(afterCalendar.intentRevision,beforeCalendar.intentRevision);
    evidence.targetedAmendment={requestId:amended.user.requestId,workId:afterIncident.workId,beforeRevision:beforeIncident.intentRevision,afterRevision:afterIncident.intentRevision,otherWorkId:afterCalendar.workId,otherRevision:afterCalendar.intentRevision};
    gate.open();gate=undefined;
    assert.equal((await finishWork(afterIncident.workId)).closureConclusion,'succeeded');assert.equal((await finishWork(afterCalendar.workId)).closureConclusion,'succeeded');
    evidence.completedIncidentIntentId=incident.intentId;evidence.completedCalendarIntentId=calendar.intentId;

    const cancelMarker='CANCEL_'+spec.seed,name='并发去重员-'+spec.seed,folder=path.join(home,'concurrent-cancel-'+spec.seed);fs.mkdirSync(folder,{recursive:true});
    gate=newGate(cancelMarker);
    const command={action:'arrange',target:{kind:'create',displayName:name,responsibilitySummary:'专门核对并发与取消验收的测试文件',configuration:{workspacePath:folder,modelId:targetModelKey},whyExistingBotsDoNotFit:'需要独立取消测试，现有任务必须继续'},contact:{kind:'delegate',plan:{title:cancelMarker,goalDescription:`${cancelMarker} 写 cancel-target.txt，内容为 ${spec.seed}，回读并登记。`,requestedOutcome:'one_time',mode:'once'}}};
    const exact=`${cancelMarker} 这是同一创建意图的并发重发。请先 bot_organize discover，然后严格用下方完全相同的 JSON 调用 bot_organize。存在同意图时续用，不另换名，不创建团队。JSON=${JSON.stringify(command)}`;
    const left=crypto.randomUUID(),right=crypto.randomUUID();
    const accepted=await evaluate(`Promise.all([window.api.botWork.sendMessage(${JSON.stringify({botId:'bot-mybuddy-default',requestId:left,text:exact})}),window.api.botWork.sendMessage(${JSON.stringify({botId:'bot-mybuddy-default',requestId:right,text:exact})})])`);
    assert.equal(accepted.length,2);assert.notEqual(accepted[0].requestId,accepted[1].requestId);
    let duplicate;
    await until(async()=>{const rows=await sql('all',`SELECT r.organization_id,COUNT(DISTINCT o.operation_id) AS operations FROM bot_organization_records r JOIN bot_organization_operations o ON o.organization_id=r.organization_id WHERE json_extract(r.request_json,'$.target.displayName')=? GROUP BY r.organization_id`,[name]);if(rows.length===1&&rows[0].operations>=2){duplicate=rows[0];return true;}return false;},'two real model arrangement operations share one creation intent');
    const cancelIntent=await waitOrganization(item=>item.target?.displayName===name,'concurrently admitted target');const cancelWork=await workFor(cancelIntent);
    evidence.sameIntentConcurrentAdmission={...duplicate,requestIds:[left,right],organizationId:cancelIntent.intentId,targetBotId:cancelIntent.target.botId,workId:cancelWork.workId};
    const survivorName='独立继续员-'+spec.seed,survivorFolder=path.join(home,'concurrent-survivor-'+spec.seed);fs.mkdirSync(survivorFolder,{recursive:true});
    await submit(`${cancelMarker} 请创建专门的“${survivorName}”，职责为本次独立继续测试，先查 Bot 目录，再使用 bot_organize，模型 ${targetModelKey}，工作目录 ${survivorFolder}，直接委派一个个人 Work 写 survivor.txt，内容为 SURVIVOR_${spec.seed}，回读登记。与“${name}”是两个独立目标。`);
    const survivor=await waitOrganization(item=>item.target?.displayName===survivorName,'actual independent survivor'),survivorWork=await workFor(survivor);
    await until(()=>Promise.resolve(gate.hits.length>=2),'independent cancellation executions reached real upstream response gates');
    const cancelled=await submit(`明确取消协作 ${cancelIntent.collaborationId} 的原 Work。先 bot_collaborate query 再用实际 versionGuard cancel。只取消这一个，协作 ${survivor.collaborationId} 继续，不创建新 Work。`);
    gate.open();gate=undefined;
    const finalCancel=await finishWork(cancelWork.workId),finalSurvivor=await finishWork(survivorWork.workId);
    assert.equal(finalCancel.closureConclusion,'cancelled');assert.equal(finalSurvivor.closureConclusion,'succeeded');
    evidence.cancellation={requestId:cancelled.user.requestId,workId:cancelWork.workId,otherWorkId:survivorWork.workId,cancelled:finalCancel.closureConclusion,unaffected:finalSurvivor.closureConclusion};
    return {evidence};
  } finally {if(gate)gate.open();persist();}
}

async function privateSetup(spec) {
  const name='私人资料保管员-'+spec.seed;
  const created=await api('createBot',{requestId:crypto.randomUUID(),displayName:name,responsibilitySummary:'保存合成私有测试数据，不参与其他目标'});assert(created.ok,JSON.stringify(created));
  const secret='PRIVATE_MEMORY_'+spec.seed,skillSecret='PRIVATE_SKILL_'+spec.seed;
  const memory=await evaluate(`window.api.memory.create(${JSON.stringify({kind:'fact',title:'合成私有边界标记',content:secret,status:'active',explicit:true,sourceType:'user',scopeType:'bot',scopeId:created.bot.botId})})`);
  const skillId='private-'+spec.seed,skillRoot=path.join(agentDir,'plugins/skills',skillId);fs.mkdirSync(skillRoot,{recursive:true});
  fs.writeFileSync(path.join(skillRoot,'SKILL.md'),`---\nname: ${skillId}\ndescription: Synthetic private ownership fixture\n---\n${skillSecret}\n`);
  fs.writeFileSync(path.join(skillRoot,'_skillhub_meta.json'),JSON.stringify({id:skillId,name:skillId,source:'memory-learned',scopeType:'bot',scopeId:created.bot.botId,sourceMemoryIds:[memory.id]}));
  privateFixture={ownerBotId:created.bot.botId,memory,secret,skillSecret,skillId,skillRoot,providerOffset:requests.length};
  const ownerChoices=await api('getSettings',created.bot.botId),primaryChoices=await api('getSettings',spec.primaryBotId);
  assert(ownerChoices.skills.some(item=>item.id===skillId),'owner sees own scoped package');assert(!primaryChoices.skills.some(item=>item.id===skillId),'primary cannot select another Bot private skill');
  return {evidence:{privateSkillFiles:{ownerBotId:created.bot.botId,directory:skillRoot,sha256:sha(fs.readFileSync(path.join(skillRoot,'SKILL.md')))},privateMemoryScopes:{memoryId:memory.id,ownerBotId:created.bot.botId,record:memory},providerOffset:requests.length}};
}
async function verifyPrivateBoundary(spec) {
  assert(privateFixture,'real private fixture was created');const evidence={phase:spec.phase};
  const all=await api('listBots'),primary=all.find(item=>item.botId===spec.primaryBotId);assert(primary?.organizationRole==='primary');
  const renamed=await api('renameBot',{botId:primary.botId,expectedUpdatedAt:primary.updatedAt,displayName:'重命名主助理-'+spec.seed});assert(renamed.ok);
  evidence.renamedPrimaryId=(await api('listBots')).find(item=>item.organizationRole==='primary')?.botId;
  const oldHistory=await history();await evaluate(`window.api.botWork.archiveConversation(${JSON.stringify(spec.primaryBotId)},${JSON.stringify(oldHistory.conversationId)})`);
  const fresh=await history();assert.notEqual(fresh.conversationId,oldHistory.conversationId);evidence.newConversationPrimaryId=(await api('listBots')).find(item=>item.organizationRole==='primary')?.botId;
  await selectBot(spec.targetBotId);const forbidden='递归创建不应出现-'+spec.seed,before=(await api('listBots')).length;
  const attempted=await submit(`边界验收：请尝试用 bot_organize 创建“${forbidden}”。只能用真实 bot_organize；若本 Bot 没有此工具就如实说明，不能改用 work_create、不能请求其他 Bot 代建。`);
  const ordinaryWire=requests.slice(privateFixture.providerOffset).filter(body=>JSON.stringify(body.messages).includes(forbidden));
  assert(ordinaryWire.length);assert(ordinaryWire.every(body=>!(body.tools??[]).some(tool=>tool.function?.name==='bot_organize')),'ordinary model wire has no management tool');assert.equal((await api('listBots')).length,before);
  evidence.ordinaryManagementRejected={requestId:attempted.user.requestId,modelToolNames:ordinaryWire.flatMap(body=>(body.tools??[]).map(tool=>tool.function?.name)),botCount:before};
  const asked=await submit(`请通过 bot_ask 或 bot_collaborate ask 真实询问主 Bot ${spec.primaryBotId}：十九乘二十三是多少？只读咨询，不创建 Work。`);
  const calls=asked.answer.botCalls??[],relations=asked.answer.collaborations??[];assert(calls.some(call=>call.status==='completed'&&/437/.test(call.replyText??''))||relations.some(item=>item.targetBotId===spec.primaryBotId&&item.status==='returned'));
  evidence.ordinaryCollaborationWorked={requestId:asked.user.requestId,calls,relations};await selectBot(spec.primaryBotId);
  const wire=JSON.stringify(requests.slice(privateFixture.providerOffset));assert(!wire.includes(privateFixture.secret));assert(!wire.includes(privateFixture.skillSecret));
  evidence.privateWireIsolation={providerOffset:privateFixture.providerOffset,requestCount:requests.length-privateFixture.providerOffset,forbiddenMemoryAbsent:true,forbiddenSkillBodyAbsent:true};
  const targetProfiles=await sql('all','SELECT configuration_json,skill_packages_json FROM bot_expert_versions WHERE bot_id=?',[spec.targetBotId]);
  assert(targetProfiles.every(profile=>!JSON.stringify(profile).includes(privateFixture.skillRoot)&&!JSON.stringify(profile).includes(privateFixture.skillSecret)));
  evidence.privateSkillRootIsolation={targetBotId:spec.targetBotId,profileCount:targetProfiles.length,privateDirectoryAbsent:true};
  const team=await api('teamControl',{kind:'save_template',request:{operationId:crypto.randomUUID(),name:'独立计数团队-'+spec.seed,plan:{ownerBotId:spec.primaryBotId,ownerResponsibility:'只负责明日合成边界检查',members:[{botId:privateFixture.ownerBotId,responsibility:'检查合成数据',delegatedScope:[]}],executionPolicy:'sequential',maxConcurrency:1}}});assert(team.ok,JSON.stringify(team));
  const template=team.template;assert(template?.templateId,'actual persistent team template');
  fs.mkdirSync(path.join(home,'boundary-team'),{recursive:true});
  const scheduled=await api('teamControl',{kind:'create',request:{operationId:crypto.randomUUID(),templateId:template.templateId,ownerBotId:spec.primaryBotId,ownerResponsibility:template.ownerResponsibility,members:template.members,executionPolicy:'sequential',maxConcurrency:1,title:'明日团队边界检查-'+spec.seed,goalDescription:'只在明天检查合成数据，不立即执行',workspacePath:path.join(home,'boundary-team'),mode:'watch',watchRule:{nextWakeAt:Date.now()+86400000,timezone:'UTC',executionMode:'observe',scheduleBasis:'user_specified'},criteria:['只读取合成数据']}});assert(scheduled.ok,JSON.stringify(scheduled));
  const teamWorkId=scheduled.work?.workId??scheduled.workId;assert(teamWorkId,'actual accepted team Work');
  const personal=await api('queryWorks',{scope:{kind:'personal',botId:spec.primaryBotId},view:'all'}),teamList=await api('queryWorks',{scope:{kind:'team',teamId:template.templateId},view:'all'});
  assert(!personal.works.some(work=>work.workId===teamWorkId));assert(teamList.works.some(work=>work.workId===teamWorkId));
  evidence.teamCountsIndependent={templateId:template.templateId,teamWorkId,personalTotal:personal.total,teamTotal:teamList.total};
  const archived=await originalDestinationBoundary(spec,'archived');evidence.archivedExactOrigin=archived;
  const deleted=await originalDestinationBoundary(spec,'deleted');evidence.deletedNoFallback=deleted;
  return {evidence};
}

async function originalDestinationBoundary(spec,kind) {
  const marker='ORIGIN_'+kind+'_'+spec.seed,folder=path.join(home,'origin-'+kind+'-'+spec.seed);fs.mkdirSync(folder,{recursive:true});const gate=newGate(marker);
  try {
    const reply=await submit(`${marker} 指定现有 Bot ${spec.targetBotId}，不要创建或改配 Bot。用 bot_collaborate delegate 建一个独立的个人 Work，在其工作目录写 ${marker}.txt，内容为 ${marker}，回读登记。不要创建团队，前台尽快返回受理。`);
    let relation;await until(async()=>{const rows=(await api('collaborations',{botId:spec.primaryBotId,limit:100})).items;relation=rows.find(item=>item.sourceRequestId===reply.user.requestId&&item.workId);return Boolean(relation)&&gate.hits.length>0;},'original-source test accepted and target upstream held');
    const originalConversationId=relation.sourceConversationId,workId=relation.workId;
    if(kind==='archived')await evaluate(`window.api.botWork.archiveConversation(${JSON.stringify(spec.primaryBotId)},${JSON.stringify(originalConversationId)})`);
    else await sql('exec',`PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE;DELETE FROM bot_cancel_intents WHERE conversation_id=${literal(originalConversationId)};DELETE FROM bot_work_reads WHERE conversation_id=${literal(originalConversationId)};DELETE FROM bot_send_receipts WHERE conversation_id=${literal(originalConversationId)};DELETE FROM bot_messages WHERE conversation_id=${literal(originalConversationId)};DELETE FROM bot_conversations WHERE conversation_id=${literal(originalConversationId)};COMMIT;PRAGMA foreign_keys=ON;`);
    const replacement=await history();assert.notEqual(replacement.conversationId,originalConversationId);await selectBot(spec.primaryBotId);gate.open();
    const work=await finishWork(workId),journal=await api('collaborationHistory',{botId:spec.primaryBotId,collaborationId:relation.collaborationId,limit:100});
    const returned=await sql('all',`SELECT m.conversation_id,m.message_id FROM bot_work_feedback f JOIN bot_messages m ON m.message_id=f.message_id WHERE json_extract(f.metadata_json,'$.workId')=? AND json_extract(f.metadata_json,'$.category')='result'`,[workId]);
    assert(journal.messages.some(message=>message.kind==='result'),'real result retained in actual bilateral history');
    if(kind==='archived'){assert(returned.length);assert(returned.every(item=>item.conversation_id===originalConversationId));assert.equal(journal.collaboration.sourceConversationId,originalConversationId);}
    else {assert.equal(journal.collaboration.originAvailable,false);assert.equal(returned.length,0,'deleted origin has no fallback source feedback');}
    return {workId,collaborationId:relation.collaborationId,originalConversationId,replacementConversationId:replacement.conversationId,conclusion:work.closureConclusion,returnedMessages:returned,originAvailable:journal.collaboration.originAvailable,
      sourceMutation:kind==='deleted'?'external synthetic SQLite source deletion; no public conversation-delete API is available':'actual public archiveConversation IPC'};
  } finally {gate.open();}
}

async function main() {
  process.once('SIGINT',()=>{stopReason='Owned organization driver interrupted';});
  process.once('SIGTERM',()=>{stopReason='Owned organization driver terminated';});
  fs.mkdirSync(out,{recursive:true});home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bot-organization-live-')));agentDir=path.join(home,'.mybuddy');dbPath=path.join(agentDir,'app.db');devOutput=path.join(out,'dev-output');userData=path.join(home,'organization-electron-userData');
  for(const relative of ['.mybuddy','AppData/Roaming','AppData/Local','Temp'])fs.mkdirSync(path.join(home,relative),{recursive:true});report.home=home;report.output=out;
  try {
    await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
    const {loadLiveModel}=require('./bot-live-model-config.cjs');const source=await loadLiveModel(baseUrl,sourceModel),target=await loadLiveModel(baseUrl,targetModel);report.modelConfiguration={source:source.evidence,target:target.evidence};
    fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',apiKey:'fixture-only',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,models:[source.model,...sourceModel!==targetModel?[target.model]:[]]}}}));
    fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:sourceModel,enabledModels:[modelKey,targetModelKey],memoryEnabled:true,memoryGatewayEnabled:false,remoteAccessEnabled:false,closeToTray:false,theme:'light',permissionMode:'auto'}));
    await launch();await startSqliteBroker();
    await require('./bot-organization-live-scenario.cjs').run({send,until,evaluate,history,rpc,report,requests,out,home,modelKey,targetModelKey,botId:'bot-mybuddy-default',setBotId:selectBot,organizationHooks:{fault,restart,verifyRestart,boundary,audit:async()=>({faults,restarts,runtimes,finalState:await snapshot()})}});
    report.status=['passed','selected_passed'].includes(report.organization?.status)?report.organization.status:'failed';
  } catch(error){report.status='failed';report.error=String(error.stack||error);console.error(report.error);process.exitCode=1;}
  finally {
    report.endedAt=new Date().toISOString();report.sourceAtEnd=sourceFingerprint();report.executableBundles=devOutput?bundles():[];
    if(report.sourceAtLaunch){const before=new Map(report.sourceAtLaunch.files.map(item=>[item.file,item.sha256])),after=new Map(report.sourceAtEnd.files.map(item=>[item.file,item.sha256]));report.sourceDeltaFiles=[...new Set([...before.keys(),...after.keys()])].filter(file=>before.get(file)!==after.get(file)).sort();if(report.sourceDeltaFiles.length){report.status='failed';report.limitations.push('Source changed during the live run; exact-source acceptance is invalid.');process.exitCode=1;}}
    try{await stopOwnedRuntime();}catch(error){report.cleanupError=String(error);process.exitCode=1;}
    if(broker){try{await sql('close');}catch{}if(broker.exitCode===null)broker.kill('SIGTERM');brokerLines?.close();}
    for(const watch of outlineWatches.values())watch.watcher.close();
    if(log!==undefined)fs.closeSync(log);provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));persist();console.log(JSON.stringify({organizationDriver:report.status,report:path.join(out,'report.json'),home}));
  }
}
// Boundary helpers follow below. Importing the driver never launches anything.
if(require.main===module)main();
module.exports={sourceFingerprint};
