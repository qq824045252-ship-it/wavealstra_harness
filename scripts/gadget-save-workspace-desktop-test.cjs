/** Real Electron dev + native pointer events, isolated HOME/userData. No model or production data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out/tests/gadget-save-workspace');
fs.mkdirSync(output, { recursive: true });
const home = fs.mkdtempSync(path.join(output, 'profile-'));
const taskRoot = path.join(home, 'bound-workspace');
fs.mkdirSync(taskRoot);
const agentDir = path.join(home, '.mybuddy');
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false }));
let child, log, ws, sequence = 0;
const pending = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { status: 'running', tests: [], home };
async function until(check, label, timeout = 30000) {
  for (const end = Date.now() + timeout; Date.now() < end;) { if (await check()) return; await wait(100); }
  throw Error('Timeout: ' + label);
}
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function click(expression) {
  await until(() => evaluate(`Boolean(${expression})`), "click target");
  await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing target');e.scrollIntoView({block:'nearest'});})()`);
  await wait(120); // Settle scrolling without depending on a foreground animation frame.
  const p = await evaluate(`(()=>{const e=${expression};const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
  await wait(160);
}
const button = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
const card = name => `[...document.querySelectorAll('.task-gadgets-view .gadget-card')].find(e=>e.querySelector('.gadget-card-name')?.textContent===${JSON.stringify(name)})`;
async function showGadgets() {
  if (!await evaluate('Boolean(document.querySelector(".artifact-panel"))')) await click('document.querySelector(\'button[title="打开概览"]\')');
  await click('document.querySelector(\'.extension-tab-btn[title^="工作台"]\')');
  await until(() => evaluate('Boolean(document.querySelector(".task-gadgets-view"))'), 'Gadget panel');
}
async function screenshot(name) {
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
}
const directCard = name => `[...document.querySelectorAll('.gadget-card:not(.gadget-card--inherited)')].find(e=>e.querySelector('.gadget-card-name')?.textContent===${JSON.stringify(name)})`;
const get = id => evaluate(`window.api.gadget.get(${JSON.stringify(id)})`);
const list = scope => evaluate(`window.api.gadget.list({scope:${JSON.stringify(scope)}})`);
const snapshot = id => evaluate(`window.api.gadget.readSource(${JSON.stringify(id)})`);
async function navigate(where) {
  if (where === 'personal') {
    await click('document.querySelector(".sidebar-user-main")');
    await click(button('.sidebar-popup-item', '我的工作台'));
    await until(() => evaluate('Boolean(document.querySelector(".gadget-page"))'), 'personal page');
  } else if (where === 'workspace') {
    await evaluate(`window.gadgetSaveStore.setState({page:'workspace',activeWorkspaceId:'bound-space',panelOpen:false})`);
    await until(() => evaluate('Boolean(document.querySelector(".workspace-detail-tab"))'), 'workspace page');
    await click(button('.workspace-detail-tab', 'Gadgets'));
    await until(() => evaluate('Boolean(document.querySelector(".workspace-gadgets"))'), 'workspace gadgets');
  } else {
    await evaluate(`window.gadgetSaveStore.setState({page:'chat',activeTaskId:'bound-task',activeBotId:null,draft:null,panelOpen:true,panelMode:'gadgets',panelWidth:440,panelExpanded:false})`);
    await until(() => evaluate('Boolean(document.querySelector(".task-gadgets-view"))'), 'task gadgets');
  }
  await wait(200);
}
async function action(name, label) {
  await click(`${directCard(name)}?.querySelector('.gadget-more-btn')`);
  const labels = await evaluate('[...document.querySelectorAll(".gadget-action-menu-popover button")].map(e=>e.textContent.trim())');
  assert(!labels.includes('保存到任务工作目录'), 'Duplicate directory-save action must be removed');
  assert(!labels.includes('移动到…'), 'Save menus must not offer a confusing move action');
  if (label === '保存到工作空间') assert.equal(labels.filter(x => x === label).length, 1);
  await click(button('.gadget-action-menu-popover button', label));
}
async function saveWorkspace(name, cancelFirst = false) {
  await action(name, '保存到工作空间');
  await until(() => evaluate('Boolean(document.querySelector(".gadget-dialog"))'), 'workspace save dialog');
  assert(await evaluate('document.querySelector(".gadget-dialog").textContent.includes("原工具保留")'));
  if (cancelFirst) {
    const before = (await list({ type: 'workspace', workspaceId: 'bound-space' })).length;
    await click(button('.gadget-dialog footer button', '取消'));
    assert.equal((await list({ type: 'workspace', workspaceId: 'bound-space' })).length, before);
    await action(name, '保存到工作空间');
  }
  await click(button('.gadget-dialog footer button', '保存副本'));
  await until(() => evaluate('!document.querySelector(".gadget-dialog")'), 'saved workspace copy');
}
async function openAndCheck(name, id, expected) {
  await click(`${directCard(name)}?.querySelector('.gadget-open-btn')`);
  await until(async () => (await get(id))?.runtime?.status === 'running', 'open runtime '+id);
  const row = await get(id);
  assert.match(await (await fetch(row.runtime.url)).text(), /Independent preview fixture/);
  assert.deepEqual(Buffer.from(await (await fetch(new URL('../assets/pixel.bin', row.runtime.url))).arrayBuffer()), Buffer.from([0,255,13,10]));
  assert.deepEqual(await snapshot(id), expected);
  const opened = await evaluate(`(()=>{const s=window.gadgetSaveStore.getState();return {panelMode:s.panelMode,urls:Object.values(s.browserUrlByTask)}})()`);
  assert.equal(opened.panelMode, 'browser');
  assert(opened.urls.includes(row.runtime.url), 'Open must route the exact independent runtime into the sidebar browser');
  return row;
}
async function deleteUi(name, id, cancelFirst = false) {
  await action(name, '删除');
  await until(() => evaluate('Boolean(document.querySelector(".full-access-dialog"))'), 'delete confirmation');
  if (cancelFirst) {
    await click(button('.full-access-dialog button', '取消'));
    assert(await get(id), 'Cancel must preserve the selected copy');
    await action(name, '删除');
  }
  await click(button('.full-access-dialog button', '删除'));
  await until(async () => !(await get(id)), 'only selected gadget deleted');
}
(async () => {
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.create(taskRoot, path.join(agentDir, 'sessions'));
    manager.appendMessage({ role: 'user', content: 'Isolated Gadget save-copy acceptance fixture', timestamp: Date.now() });
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p=s.address().port; s.close(()=>resolve(p)); }); });
    const temp=fs.mkdtempSync(path.join(root,'out','tmp-'));
    const userData=path.join(home,'chromium');
    const env={...process.env,TMPDIR:temp,TEMP:temp,TMP:temp,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'appdata'),LOCALAPPDATA:path.join(home,'localappdata'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),PI_CODING_AGENT_DIR:agentDir};
    delete env.ELECTRON_RUN_AS_NODE;
    env.ELECTRON_CLI_ARGS=JSON.stringify(['--user-data-dir='+userData,'--remote-debugging-address=127.0.0.1','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows']);
    for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','PI_CODING_AGENT_DIR']) assert(env[key]===home||env[key].startsWith(home+path.sep),key+' profile isolation');
    report.isolation={home,userData,agentDir,taskRoot};
    log=fs.openSync(path.join(output,'dev.log'),'w');
    child=cp.spawn(process.execPath,[path.join(root,'node_modules/electron-vite/bin/electron-vite.js'),'dev','--remoteDebuggingPort',String(port)],{cwd:root,env,stdio:['ignore',log,log]});
    let target;
    await until(async()=>{if(child.exitCode!==null)throw Error('Dev exited '+child.exitCode);try{target=(await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())).find(t=>t.type==='page'&&/^http:\/\/(localhost|127\.0\.0\.1):/.test(t.url));return !!target;}catch{return false;}},'isolated Electron dev',180000);
    report.target=target.url;
    ws=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    ws.onmessage=event=>{const r=JSON.parse(event.data);const p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result);};
    await rpc('Runtime.enable');await rpc('Page.enable');await rpc('Page.bringToFront');
    await rpc('Emulation.setDeviceMetricsOverride',{width:1700,height:1000,deviceScaleFactor:1,mobile:false});
    await until(()=>evaluate('Boolean(window.api?.gadget?.copyScope && document.querySelector(".sidebar"))'),'app API ready',90000);
    const source=await evaluate(`(async()=>{const {useAppStore:s}=await import('/src/store/appStore.ts');window.gadgetSaveStore=s;
      const space={id:'bound-space',name:'Save fixture space',path:${JSON.stringify(taskRoot)},createdAt:Date.now(),updatedAt:Date.now()};
      const task={id:'bound-task',title:'Copy fixture task',spaceId:space.id,updatedAt:Date.now(),sessionFile:${JSON.stringify(manager.getSessionFile())},welcomeMode:'working',messages:[{id:'fixture-message',role:'assistant',createdAt:Date.now(),blocks:[{type:'text',content:'Isolated UI fixture. No model request.'}]}]};
      await window.api.db.upsertSpace(space);await window.api.db.upsertTask(task);
      s.setState({theme:'light',tasks:[task],spaces:[space],activeTaskId:task.id,activeBotId:null,draft:null,sidebarCollapsed:false});
      return window.api.gadget.create({name:'Copy fixture',scope:{type:'task',taskId:task.id},entry:'page/index.html',defaultConfig:{fixture:1},files:[{path:'page/index.html',content:'<!doctype html><html><body><h1>Independent preview fixture</h1><script src="../assets/app.js"></script></body></html>'},{path:'assets/app.js',content:'window.fixtureLoaded=true;'},{path:'assets/pixel.bin',encoding:'base64',content:'AP8NCg=='}]});})()`);
    assert(source.sourcePath.startsWith(home+path.sep),'Real IPC storage must stay in fixture HOME');
    const expected=await snapshot(source.id);
    await navigate('task');await saveWorkspace('Copy fixture',true);
    const workspace=(await list({type:'workspace',workspaceId:'bound-space'})).find(g=>g.name==='Copy fixture');
    assert(workspace && workspace.id!==source.id);
    assert.equal((await get(source.id)).scope.type,'task');
    assert.deepEqual(await snapshot(workspace.id),expected);
    await navigate('workspace');await openAndCheck('Copy fixture',workspace.id,expected);
    await navigate('workspace');await action('Copy fixture','保存到我的工作台');
    await until(async()=>(await list({type:'global'})).some(g=>g.name==='Copy fixture'),'personal independent copy');
    const personal=(await list({type:'global'})).find(g=>g.name==='Copy fixture');
    assert.equal(new Set([source.id,workspace.id,personal.id]).size,3);
    assert.equal(new Set([source.sourcePath,workspace.sourcePath,personal.sourcePath]).size,3);
    for(const row of [source,workspace,personal]) {
      assert(row.sourcePath.startsWith(home+path.sep));
      assert.deepEqual(await snapshot(row.id),expected);
      assert.deepEqual(fs.readFileSync(path.join(row.sourcePath,'assets/pixel.bin')),Buffer.from([0,255,13,10]));
    }
    assert.equal(fs.existsSync(path.join(taskRoot,'gadgets')),false,'Application workspace save must not silently export a filesystem directory');
    await navigate('personal');await openAndCheck('Copy fixture',personal.id,expected);
    report.tests.push('Real menu and dialog: cancel preserves original; task -> workspace -> My Gadgets produce three IDs/directories, complete HTML/JS/binary/config copies, with workspace and personal tools opening their own preview runtime. Duplicate directory and move actions are absent.');
    await navigate('personal');await screenshot('three-independent-copies');await deleteUi('Copy fixture',personal.id,true);
    assert.deepEqual(await snapshot(source.id),expected);assert.deepEqual(await snapshot(workspace.id),expected);
    await navigate('workspace');await openAndCheck('Copy fixture',workspace.id,expected);
    await navigate('workspace');await deleteUi('Copy fixture',workspace.id);
    assert.deepEqual(await snapshot(source.id),expected);
    await navigate('task');await openAndCheck('Copy fixture',source.id,expected);
    report.tests.push('Real delete dialogs: cancel preserves copy; deleting My Gadgets copy leaves task and workspace alive; deleting workspace copy leaves original task source and its preview working.');
    // A separate fixture proves deleting the original cannot cascade to already saved copies.
    const reverse=await evaluate(`window.api.gadget.create({name:'Reverse delete fixture',scope:{type:'task',taskId:'bound-task'},entry:${JSON.stringify(expected.manifest.entry)},defaultConfig:${JSON.stringify(expected.manifest.defaultConfig)},files:${JSON.stringify(expected.files)}})`);
    const reverseExpected=await snapshot(reverse.id);
    await navigate('task');await saveWorkspace('Reverse delete fixture');
    const reverseWorkspace=(await list({type:'workspace',workspaceId:'bound-space'})).find(g=>g.name==='Reverse delete fixture');
    await action('Reverse delete fixture','保存到我的工作台');
    await until(async()=>(await list({type:'global'})).some(g=>g.name==='Reverse delete fixture'),'reverse personal copy');
    const reversePersonal=(await list({type:'global'})).find(g=>g.name==='Reverse delete fixture');
    await deleteUi('Reverse delete fixture',reverse.id);
    assert.deepEqual(await snapshot(reverseWorkspace.id),reverseExpected);assert.deepEqual(await snapshot(reversePersonal.id),reverseExpected);
    await navigate('workspace');await openAndCheck('Reverse delete fixture',reverseWorkspace.id,reverseExpected);
    await navigate('personal');await openAndCheck('Reverse delete fixture',reversePersonal.id,reverseExpected);
    await rpc('Page.reload');await until(()=>evaluate('Boolean(window.api?.gadget)'),'renderer reload');
    assert.equal(await get(reverse.id),null);
    assert.deepEqual(await snapshot(reverseWorkspace.id),reverseExpected);assert.deepEqual(await snapshot(reversePersonal.id),reverseExpected);
    report.tests.push('Deleting the task original leaves workspace and personal copies independently openable; renderer reload retains the saved copies and deletion state.');
    report.ids={source:source.id,workspace:workspace.id,personal:personal.id,reverse:reverse.id,reverseWorkspace:reverseWorkspace.id,reversePersonal:reversePersonal.id};
    report.status='passed';console.log(JSON.stringify(report,null,2));
  } catch(error) {
    report.status='failed';report.error=String(error.stack||error);process.exitCode=1;console.error(error);
    try {if(ws?.readyState===1){report.ui=await evaluate('document.body.innerText');await screenshot('failure');}}catch{}
  } finally {
    if(child&&ws?.readyState===1){ws.send(JSON.stringify({id:++sequence,method:'Browser.close'}));await wait(1000);}
    ws?.close();for(const p of pending.values())clearTimeout(p.timer);
    if(child?.exitCode===null)child.kill('SIGTERM');
    if(log!==undefined)fs.closeSync(log);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
  }
})();
