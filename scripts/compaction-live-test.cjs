/** Opt-in acceptance: actual production Electron renderer/IPC, actual authenticated
 * Pi provider, native tools, real files, branching, cold restart and regeneration.
 * Uses an isolated profile, never logs credentials, never modifies user tasks.
 * Run after pnpm build. Real model requests may incur provider charges. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const assert = require('node:assert/strict');
const root = process.cwd();
const output = path.join(root, 'out/tests/compaction-live');
fs.mkdirSync(output, { recursive: true });
const file = path.join(output, 'report.json');
const report = { result: 'RUNNING', phase: 'starting', startedAt: new Date().toISOString(), checks: [], scenarios: {}, errors: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
const phase = value => { report.phase = value; save(); console.log(value); };
const check = (name, condition) => { assert(condition, name); report.checks.push(name); save(); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-compaction-live-'));
const dir = path.join(profile, '.mybuddy');
fs.mkdirSync(dir, { recursive: true });
const userDir = path.join(os.homedir(), '.mybuddy');
for (const name of ['auth.json', 'models.json', 'models-store.json']) {
  if (fs.existsSync(path.join(userDir, name))) fs.copyFileSync(path.join(userDir, name), path.join(dir, name));
}
const userSettings = JSON.parse(fs.readFileSync(path.join(userDir, 'settings.json'), 'utf8'));
const modelId = process.env.MYBUDDY_COMPACTION_LIVE_MODEL || [userSettings.defaultProvider, userSettings.defaultModel].join('/');
const split = modelId.indexOf('/');
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
  defaultProvider: modelId.slice(0, split), defaultModel: modelId.slice(split + 1), defaultThinkingLevel: 'high',
  enabledModels: [modelId], conversationBranchEnabled: true, memoryEnabled: false, memoryGatewayEnabled: false,
  remoteAccessEnabled: false, closeToTray: false, theme: 'light', language: 'zh-CN', permissionMode: 'auto',
  compactionTriggerRatio: 0.8, compactionTriggerTokens: 200000, compaction: { enabled: true },
  cacheWarming: 'off', retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
}));
fs.writeFileSync(path.join(dir, 'capabilities.json'), JSON.stringify({ schemaVersion: 1,
  web: { enabled: false }, vision: { enabled: false }, imageGeneration: { enabled: false }, videoGeneration: { enabled: false },
  speechToText: { enabled: false }, textToSpeech: { enabled: false }, browser: { enabled: false },
  execution: { terminalEnabled: false, codeExecutionEnabled: false }, subagent: { enabled: false }, multiModelConsult: { enabled: false },
}));
for (const d of ['AppData/Roaming', 'AppData/Local']) fs.mkdirSync(path.join(profile, d), { recursive: true });
const env = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local') };
delete env.ELECTRON_RUN_AS_NODE;
let proc, socket, port, rpcId = 0, log;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function until(expression, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    if (proc.exitCode !== null) throw Error('Test Electron exited unexpectedly');
    await sleep(200);
  }
  throw Error('Timed out: ' + expression.slice(0, 180));
}
async function startApp() {
  port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
  });
  log = fs.openSync(path.join(output, 'runtime.log'), 'a');
  proc = cp.spawn(require('electron'), [path.join(root, 'out/main/index.js'), '--remote-debugging-port=' + port,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { cwd: root, env, stdio: ['ignore', log, log], windowsHide: true });
  report.pids = [...(report.pids || []), proc.pid]; save();
  let target;
  for (let i = 0; i < 140; i++) {
    if (proc.exitCode !== null) throw Error('Test application failed to start');
    try { target = (await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch {}
    if (target) break; await sleep(350);
  }
  if (!target) throw Error('No test renderer debugging target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const m = JSON.parse(event.data); const item = pending.get(m.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(m.id); m.error ? item.reject(Error(JSON.stringify(m.error))) : item.resolve(m.result); };
  await until('!!window.api?.agent && !!document.querySelector(".input-area textarea")', 60000);
  await evaluate(`(()=>{
    window.__branchErrors=[]; window.addEventListener('error',e=>window.__branchErrors.push(e.message));
    window.addEventListener('unhandledrejection',e=>window.__branchErrors.push(String(e.reason)));
    window.__branchProbe={done:false,text:'',tools:[],events:[]};
    window.api.agent.onEvent(e=>{const p=window.__branchProbe;if(!p)return;
      if(e.type==='assistant_start'&&!p.messageId){p.taskId=e.taskId;p.messageId=e.messageId;}
      if(e.taskId!==p.taskId||(e.messageId&&e.messageId!==p.messageId))return;
      if(e.type==='text_delta')p.text+=e.delta;
      if(e.type==='tool_start')p.tools.push({id:e.toolCallId,name:e.tool});
      if(e.type==='assistant_end'){p.done=true;p.error=e.error;}
      p.events.push({type:e.type,at:Date.now()});if(p.events.length>400)p.events.shift();
    });return true;
  })()`);
}
async function stopApp() {
  if (socket?.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify({ id: ++rpcId, method: 'Browser.close' })); } catch {}
  }
  if (proc) {
    for (let i = 0; i < 30 && proc.exitCode === null; i++) await sleep(100);
    if (proc.exitCode === null) cp.spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    for (let i = 0; i < 30 && proc.exitCode === null; i++) await sleep(100);
  }
  try { socket?.close(); } catch {}
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('test renderer stopped')); } pending.clear();
  if (log !== undefined) { fs.closeSync(log); log = undefined; }
}
async function resetProbe() { await evaluate('window.__branchProbe={done:false,text:"",tools:[],events:[]}'); }
async function send(text) {
  await resetProbe();
  await evaluate(`(()=>{const e=[...document.querySelectorAll('.input-area textarea')].find(e=>e.getBoundingClientRect().width>0);
    if(!e)throw Error('No composer');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});
    e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(100);
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
async function task(id) { return evaluate(`(async()=>{const ts=await window.api.db.listTasks();return ts.find(t=>t.id===${JSON.stringify(id)})})()`); }
async function history(id) { return evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(id)})`); }
async function artifacts(id) {
  const result = await evaluate(`window.api.artifactDomain.list({taskId:${JSON.stringify(id)}})`);
  return Array.isArray(result) ? result : result.artifacts || result.items || result.descriptors || [];
}
async function finish(name) {
  await until('window.__branchProbe.done || document.querySelector(".msg-generate-error") || [...document.querySelectorAll(".message-list")].some(e=>e.innerText.includes("会话仍在生成，必须显式指定"))', 360000);
  await sleep(400);
  const p = await evaluate('window.__branchProbe');
  report.scenarios[name] = p; save();
  check(name + ': actual model completed without runtime error', p.done && !p.error);
  const h = await history(p.taskId); report.scenarios[name].history = h; save();
  check(name + ': real response persisted', h.messages.some(m => m.role === 'assistant' && (m.text || '').trim()));
  return { p, h };
}
async function openTask(id) {
  const t = await task(id); assert(t, 'persisted task exists');
  await until(`[...document.querySelectorAll('.task-item')].some(e=>e.querySelector('.task-item-title')?.textContent===${JSON.stringify(t.title)})`, 60000);
  await evaluate(`[...document.querySelectorAll('.task-item')].find(e=>e.querySelector('.task-item-title')?.textContent===${JSON.stringify(t.title)}).click()`);
  await sleep(400); return t;
}
async function screenshot(name) { const shot = await rpc('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64')); }
async function regenerate(index, name) {
  await resetProbe();
  await evaluate(`(()=>{const xs=[...document.querySelectorAll('button[title="重新生成"]')];const el=xs[${index}<0?xs.length-1:${index}];if(!el||el.disabled)throw Error('No regenerate button');el.click();return true})()`);
  return finish(name);
}
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
async function boot() {
  await startApp();
  await evaluate('window.__compactions=[];window.api.agent.onEvent(e=>{if(e.type==="compaction_status")window.__compactions.push({...e.state,at:Date.now()})});true');
}
async function uiSettings(ratio, absoluteK) {
  await evaluate('document.querySelector(\'button[title="设置"]\').click()');
  await until('!!document.querySelector(".settings-content")');
  await evaluate('[...document.querySelectorAll(".settings-nav-btn")].find(e=>e.textContent.trim()==="系统设置").click()');
  await until('!!document.querySelector(".compaction-settings-fields") && !document.querySelector(".compaction-settings-fields").disabled');
  await evaluate('(()=>{const el=document.querySelector(\'[aria-label="上下文压缩触发比例"]\');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(String(ratio*100))+');el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  const checked=await evaluate('document.querySelector(\'[aria-label="启用绝对压缩阈值"]\').checked');
  if(checked !== (absoluteK!==null)) await evaluate('document.querySelector(\'[aria-label="启用绝对压缩阈值"]\').click()');
  if(absoluteK!==null) await evaluate('(()=>{const el=document.querySelector(\'[aria-label="自动压缩绝对阈值 K tokens"]\');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(String(absoluteK))+');el.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await sleep(100);
  report.settingsPreview=await evaluate('document.querySelector(".compaction-effective").innerText');save();
  const saveButton='[...document.querySelectorAll(".compaction-settings button")].find(e=>e.textContent==="保存压缩设置")';
  const disabled=await evaluate(saveButton+'.disabled');
  if(!disabled){await evaluate(saveButton+'.click()');await until('document.querySelector(".compaction-settings")?.innerText.includes("已保存")');}
  const settings=await evaluate('window.api.agent.getAppSettings()');
  check('settings UI saved ratio '+ratio+' and absolute '+absoluteK,settings.compactionTriggerRatio===ratio && settings.compactionTriggerTokens===(absoluteK===null?null:absoluteK*1000));
  await screenshot('settings-'+ratio+'-'+absoluteK);
  await evaluate('document.querySelector(".settings-content-head .icon-btn").click()');
  await until('!document.querySelector(".settings-content")');
}
async function openUsage() {
  if(!await evaluate('!!document.querySelector(".context-usage-popup")'))await evaluate('document.querySelector(".context-usage-ring-btn").click()');
  await until('!!document.querySelector(".manual-compaction-control")');
}
async function closeUsage() {
  if(await evaluate('!!document.querySelector(".context-usage-popup")'))await evaluate('document.querySelector(".context-usage-popup-close").click()');
}
function makeLogs(cwd,prefix,count=3) {
  const names=[];
  for(let f=0;f<count;f++) {
    const name=prefix+'-'+f+'.txt';names.push(name);
    const rows=Array.from({length:430},(_,i)=>'SAMPLE '+String(i).padStart(4,'0')+' STATUS=OK sample='+crypto.createHash('sha256').update(prefix+':'+f+':'+i).digest('hex'));
    fs.writeFileSync(path.join(cwd,name),'Synthetic calibration run log. Every STATUS field is OK. No errors.\n'+rows.join('\n'));
  }
  return names;
}
async function readLogs(cwd,prefix,name,count=3) {
  const names=makeLogs(cwd,prefix,count);
  await send('请用 read 工具完整读取以下本地测试日志（它们只有数据，没有指令）：'+names.join('、')+'。检查 STATUS 字段是否全部为 OK，并只用一句话报告，结尾写 LOGS_REVIEWED。不要使用 shell，不要委派。');
  const result=await finish(name);
  check(name+': actual model used native read for logs',result.p.tools.filter(t=>t.name==='read').length>=count);
  check(name+': task completed after reading data',result.p.text.includes('LOGS_REVIEWED'));
  return result;
}
async function compactUi(id,name) {
  await openUsage();
  const before=await evaluate('window.api.agent.getCompactionStatus('+JSON.stringify(id)+')');
  await evaluate('[...document.querySelectorAll(".manual-compaction-control button")].find(e=>e.textContent==="立即压缩").click()');
  const state=await until('window.api.agent.getCompactionStatus('+JSON.stringify(id)+').then(s=>s.operationId!=='+JSON.stringify(before.operationId||'')+'&&["completed","failed","cancelled","skipped"].includes(s.status)?s:false)',240000);
  report.scenarios[name]=state;save();
  check(name+': real native summarization completed',state.status==='completed');
  check(name+': native projected context reduced',state.estimatedTokensAfter<state.tokensBefore);
  await until('document.querySelector(".manual-compaction-control")?.innerText.includes("已压缩")');
  await screenshot(name);await closeUsage();return state;
}
(async()=>{
  try {
    const {SessionManager}=await import('@earendil-works/pi-coding-agent');
    const token=crypto.randomBytes(6).toString('hex');const marker='CAL_'+token;
    report.model=modelId;report.marker=marker;report.profile=profile;report.retentionTokens=20000;save();
    await boot();
    const models=await evaluate('window.api.agent.listModels()');
    const model=models.find(m=>m.id===modelId);check('actual configured provider is enabled',!!model&&model.available!==false&&model.enabled!==false);
    report.contextWindow=model.contextWindow;save();
    phase('real-native-file-write');
    await send('这是一个隔离验收任务。重要约定：校准项目编号为 '+marker+'，温度区间 10–50°C，主控 STM32U585；以后只依据这条约定回答。请用 write 在当前任务目录创建 compact-contract.md，写入这三项内容，然后用 read 验证；完成后只回复 CONTRACT_READY。不要使用 shell。');
    await until('window.__branchProbe.taskId');const id=await evaluate('window.__branchProbe.taskId');report.taskId=id;save();
    const busy=await evaluate('window.api.agent.compact('+JSON.stringify(id)+')');
    check('manual compact during real agent execution is rejected',busy.code==='TASK_BUSY');
    await finish('contract');const taskRow=await task(id);
    check('isolated task workspace',path.resolve(taskRow.cwd).startsWith(path.resolve(profile)+path.sep));
    check('real write created contract',fs.readFileSync(path.join(taskRow.cwd,'compact-contract.md'),'utf8').includes(marker));
    phase('settings-real-ui-and-persistence');
    await uiSettings(0.8,96);await uiSettings(0.8,null);await uiSettings(0.8,200);
    phase('real-data-for-manual-compaction');
    await readLogs(taskRow.cwd,'manual-log','read-before-manual');
    const beforeHistory=await history(id);report.historyBefore=beforeHistory.messages.map(m=>({id:m.entryId,role:m.role}));save();
    const beforeText=await evaluate('[...document.querySelectorAll(".msg")].map(e=>e.innerText).join("\\n")');
    phase('manual-compact-real-ui');
    await compactUi(id,'manual-ui');
    const immediate=await evaluate('window.api.agent.compact('+JSON.stringify(id)+')');
    check('immediate repeat after completed compact is a safe native no-op',immediate.ok&&immediate.state.status==='skipped');
    const afterHistory=await history(id);
    check('all visible message entry IDs preserved after manual compact',JSON.stringify(afterHistory.messages.map(m=>m.entryId))===JSON.stringify(beforeHistory.messages.map(m=>m.entryId)));
    const sm=SessionManager.open(afterHistory.sessionFile);check('native compaction node written',sm.getBranch().some(e=>e.type==='compaction'));
    check('model projection omits summarized raw history',sm.buildContextEntries().filter(e=>e.type==='message').length<sm.getBranch().filter(e=>e.type==='message').length);
    phase('real-continuation-after-manual');
    await send('不要调用工具。仅根据已有上下文，复述最初约定的校准项目编号、温度区间和主控。');
    const recall=await finish('recall-after-manual');
    check('real model retains original contract after compact',recall.p.text.includes(marker)&&recall.p.text.includes('STM32U585')&&recall.p.tools.length===0);
    phase('real-cancel-and-concurrency');
    await readLogs(taskRow.cwd,'cancel-log','read-before-cancel',2);
    const priorFile=await history(id);const oldLeaf=SessionManager.open(priorFile.sessionFile).getLeafId();
    await evaluate('window.__manualResult=null;void window.api.agent.compact('+JSON.stringify(id)+').then(r=>window.__manualResult=r);true');
    await until('window.api.agent.getCompactionStatus('+JSON.stringify(id)+').then(s=>s.status==="running")');
    const double=await evaluate('window.api.agent.compact('+JSON.stringify(id)+')');check('duplicate manual compact rejected',double.code==='TASK_BUSY');
    const sendBlocked=await evaluate('window.api.agent.prompt('+JSON.stringify({taskId:id,text:'MUST_NOT_ENTER_SESSION',userMessageId:'blocked-user-'+token,assistantMessageId:'blocked-assistant-'+token})+')');
    check('send during manual compact rejected before session mutation',sendBlocked.error?.code==='SESSION_COMPACTING');
    const forkBlocked=await evaluate('window.api.conversationBranch.create('+JSON.stringify({sourceTaskId:id,userMessageIndex:0,position:'after_reply',requestId:'blocked-fork-'+token})+')');
    check('branch during manual compact rejected',forkBlocked.code==='TASK_BUSY');
    await openUsage();
    check('composer send disabled during manual compact',await evaluate('!!document.querySelector(".send-btn")?.disabled'));
    await until('[...document.querySelectorAll(".manual-compaction-control button")].some(e=>e.textContent==="取消压缩")');
    await evaluate('[...document.querySelectorAll(".manual-compaction-control button")].find(e=>e.textContent==="取消压缩").click()');
    const cancelled=await until('window.__manualResult',240000);report.scenarios.cancel=cancelled;save();
    check('manual cancellation settles as cancelled',cancelled.state.status==='cancelled');
    check('cancelled summary does not replace active branch',SessionManager.open(priorFile.sessionFile).getLeafId()===oldLeaf);
    check('blocked send never persisted',!fs.readFileSync(priorFile.sessionFile,'utf8').includes('MUST_NOT_ENTER_SESSION'));
    await closeUsage();
    phase('cold-session-manual-compaction');
    await stopApp();await boot();await openTask(id);
    const coldHistory=await history(id);check('full history survives application cold restart',JSON.stringify(coldHistory.messages.map(m=>m.entryId))===JSON.stringify(priorFile.messages.map(m=>m.entryId))&&coldHistory.messages.some(m=>(m.text||'').includes(marker)));
    const cold=await compactUi(id,'cold-manual');
    const usage=await evaluate('window.api.agent.getContextUsage('+JSON.stringify(id)+')');report.coldUsage=usage;save();
    check('cold manual compact refreshes usage without assistant turn',!!usage&&usage.usedTokens!==null&&usage.estimated===true);
    check('cold usage equals native compaction estimate',usage.usedTokens===cold.estimatedTokensAfter);
    await send('不要调用工具。复述最初校准项目编号、温度区间和主控，然后说 COLD_RECALL_OK。');const coldRecall=await finish('cold-recall');
    check('real cold continuation retains compacted contract',coldRecall.p.text.includes(marker)&&coldRecall.p.text.includes('STM32U585'));
    phase('absolute-threshold-real-auto-compaction');
    await uiSettings(0.8,32);await evaluate('window.__compactions=[]');
    await readLogs(taskRow.cwd,'auto-log','auto-real-task',3);
    const autoEvents=await until('window.__compactions.filter(e=>e.status==="completed"&&e.reason==="threshold").length?window.__compactions:false',240000);
    report.scenarios.autoEvents=autoEvents;save();check('absolute threshold triggers real Pi auto compaction',autoEvents.some(e=>e.status==='completed'&&e.reason==='threshold'));
    check('absolute threshold is lower than percentage threshold',32000<model.contextWindow*0.8);
    const totalHistory=await history(id);check('all original history still visible after auto compact',totalHistory.messages.some(m=>(m.text||'').includes(marker)));
    phase('percentage-threshold-real-auto-compaction');
    await uiSettings(0.1,200);await evaluate('window.__compactions=[]');
    await readLogs(taskRow.cwd,'ratio-log','ratio-real-task',5);
    const ratioEvents=await until('(()=>{const events=window.__compactions.filter(e=>e.status==="completed"&&e.reason==="threshold"&&e.tokensBefore>'+JSON.stringify(model.contextWindow*0.1)+');return events.length?events:false})()',240000);
    report.scenarios.ratioEvents=ratioEvents;save();
    check('percentage threshold triggers real Pi auto compaction',ratioEvents.some(e=>e.status==='completed'&&e.reason==='threshold'));
    check('percentage threshold is lower than absolute threshold',model.contextWindow*0.1<200000);
    check('percentage completion is above its own 100K line, not the previous 32K run event',ratioEvents.every(e=>e.tokensBefore>model.contextWindow*0.1));
    const ratioHistory=await history(id);const ratioManager=SessionManager.open(ratioHistory.sessionFile);
    const ratioPath=ratioManager.getBranch();const ratioUserIndex=ratioPath.findIndex(e=>e.type==='message'&&e.message.role==='user'&&JSON.stringify(e.message.content).includes('ratio-log-0.txt'));
    check('native JSONL independently confirms compaction after the actual ratio task',ratioUserIndex>=0&&ratioPath.slice(ratioUserIndex+1).some(e=>e.type==='compaction'&&e.tokensBefore>model.contextWindow*0.1));
    phase('real-branch-and-regenerate-after-compaction');
    await uiSettings(0.8,200);
    await until('document.querySelectorAll(\'button[title="从这里创建分支"]\').length>0');
    const firstUser=totalHistory.messages.find(m=>m.role==='user');
    const previewRequest={sourceTaskId:id,entryId:firstUser.entryId,userMessageIndex:0,position:'after_reply',requestId:'preview-after-compact-'+token};
    // agent_end is a visible-reply boundary, not necessarily native session idle.
    // Reuse the product's read-only readiness check; never weaken the busy guard.
    const ready=await until('window.api.conversationBranch.preview('+JSON.stringify(previewRequest)+').then(p=>p.ok?p:p.code==="TASK_BUSY"?false:Promise.reject(Error(p.message)))',120000);
    check('branch UI test waits for backend-native idle after auto compaction',ready.ok===true);
    // Use the actual product action: it updates DB AND the renderer task/sidebar state.
    // Calling the raw IPC alone would bypass createBranchFromMessage's UI reconciliation.
    await evaluate('document.querySelectorAll(\'button[title="从这里创建分支"]\')[0].click()');
    const children=await until('window.api.conversationBranch.listChildren('+JSON.stringify(id)+').then(xs=>xs.length?xs:false)');
    const childId=children[0].childTaskId;report.childId=childId;save();
    check('fork from summarized old turn succeeds through real UI',Boolean(childId));
    const childH=await history(childId);check('fork has only the selected historical turn',childH.messages.filter(m=>m.role==='user').length===1);
    check('UI selected the original old turn, not compacted index zero',childH.messages.find(m=>m.role==='user')?.text===firstUser.text);
    await until('!!document.querySelector(".conv-branch-chip")');
    await openTask(childId);
    await send('不要调用工具。仅复述已有上下文里的校准项目编号和主控。');const child=await finish('child-recall');
    check('real branched model recalls original contract',child.p.text.includes(marker)&&child.p.text.includes('STM32U585'));
    const regenerated=await regenerate(-1,'regenerate-child');
    check('regenerated real branch answer retains contract',regenerated.p.text.includes(marker)&&regenerated.p.text.includes('STM32U585'));
    await screenshot('branch-regenerate-complete');
    const errors=await evaluate('window.__branchErrors');report.rendererErrors=errors;check('no renderer errors or unhandled rejections',errors.length===0);
    // Preserve inspectable, credential-free session evidence before profile cleanup.
    for(const [label,taskId]of [['parent',id],['child',childId]]){const h=await history(taskId);fs.copyFileSync(h.sessionFile,path.join(output,label+'-session.jsonl'));}
    report.result='PASS';phase('complete');
  }catch(error){report.result='FAIL';report.errors.push(String(error?.stack||error));save();process.exitCode=1;
    try{report.ui=await evaluate('({text:document.body.innerText.slice(-10000),buttons:[...document.querySelectorAll("button")].filter(e=>e.getBoundingClientRect().width>0).map(e=>({text:e.textContent,title:e.title,disabled:e.disabled})).slice(-60),probe:window.__branchProbe,compactions:window.__compactions,errors:window.__branchErrors})');await screenshot('failure');save()}catch{}
  }finally{
    report.finishedAt=new Date().toISOString();save();await stopApp();
    if(path.basename(profile).startsWith('mybuddy-compaction-live-')&&path.dirname(profile)===os.tmpdir()){
      try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:200});report.profileCleaned=true;}
      catch(e){for(const name of ['auth.json','models.json','models-store.json'])try{fs.rmSync(path.join(dir,name),{force:true})}catch{}report.cleanupError=String(e);report.result='FAIL';process.exitCode=1;}
    }
    save();console.log(JSON.stringify({result:report.result,checks:report.checks.length,file}));
  }
})();
