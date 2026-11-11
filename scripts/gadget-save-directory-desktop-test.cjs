/** Real Electron dev + native pointer events, isolated HOME/userData. No model or production data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out/tests/gadget-save-directory');
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
async function save(name) {
  await click(`${card(name)}?.querySelector('.gadget-more-btn')`);
  await click(button('.gadget-action-menu-popover button', '保存到任务工作目录'));
  await until(() => evaluate('Boolean(document.querySelector(".gadget-save-result"))'), 'save confirmation');
  assert.equal(await evaluate('document.querySelectorAll(".gadget-action-menu-popover").length'), 0);
  return evaluate('document.querySelector(".gadget-saved-path").textContent');
}
async function screenshot(name) {
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
}
(async () => {
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const sessions = {};
    for (const id of ['bound-task', 'isolated-task', 'bad-task']) {
      const manager = SessionManager.create(taskRoot, path.join(agentDir, 'sessions'));
      manager.appendMessage({ role: 'user', content: 'Gadget directory acceptance fixture', timestamp: Date.now() });
      sessions[id] = manager.getSessionFile();
    }
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    // Chromium's Unix socket path is capped; keep TMPDIR shorter than the profile path.
    const temp = fs.mkdtempSync(path.join(root, 'out', 'tmp-'));
    const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), PI_CODING_AGENT_DIR: agentDir };
    delete env.ELECTRON_RUN_AS_NODE;
    env.ELECTRON_CLI_ARGS = JSON.stringify(['--remote-debugging-address=127.0.0.1', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows']);
    log = fs.openSync(path.join(output, 'dev.log'), 'w');
    child = cp.spawn(process.execPath, [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--remoteDebuggingPort', String(port)], { cwd: root, env, stdio: ['ignore', log, log] });
    let target;
    await until(async () => {
      if (child.exitCode !== null) throw Error('Dev exited ' + child.exitCode);
      try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())).find(t => t.type === 'page' && /^http:\/\/(localhost|127\.0\.0\.1):/.test(t.url)); return !!target; } catch { return false; }
    }, 'real Electron dev renderer', 180000);
    report.target = target.url;
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = event => { const r = JSON.parse(event.data); if (r.method === "Runtime.exceptionThrown" || r.method === "Log.entryAdded") (report.console ||= []).push(r.params); const p = pending.get(r.id); if (!p) return; pending.delete(r.id); clearTimeout(p.timer); r.error ? p.reject(Error(JSON.stringify(r.error))) : p.resolve(r.result); };
    await rpc("Runtime.enable"); await rpc("Log.enable"); await rpc("Page.enable"); await rpc("Page.bringToFront");
    await rpc("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate('Boolean(window.api?.gadget && document.querySelector(".sidebar"))'), 'app ready', 90000);
    const seed = await evaluate(`(async()=>{
      await window.api.db.upsertSpace({id:'bound-space',name:'Save fixture space',path:${JSON.stringify(taskRoot)},createdAt:Date.now(),updatedAt:Date.now()});
      await window.api.db.upsertSpace({id:'bad-space',name:'Missing fixture space',path:${JSON.stringify(path.join(home, 'missing'))},createdAt:Date.now(),updatedAt:Date.now()});
      for(const [id,spaceId] of [['bound-task','bound-space'],['isolated-task',undefined],['bad-task','bad-space']])await window.api.db.upsertTask({id,title:id,spaceId,updatedAt:Date.now(),sessionFile:${JSON.stringify(sessions)}[id],welcomeMode:'working'});
      const own=await window.api.gadget.create({name:'Task save fixture',scope:{type:'task',taskId:'bound-task'},entry:'page/index.html',files:[{path:'page/index.html',content:'<h1>Task saved source</h1>'},{path:'assets/pixel.bin',content:'AP8NCg==',encoding:'base64'}]});
      const privateGadget=await window.api.gadget.create({name:'Private export fixture',scope:{type:'task',taskId:'bound-task'}});
      const personal=await window.api.gadget.create({name:'Personal save fixture',scope:{type:'global'}});
      return {own:own.id,privateGadget:privateGadget.id,personal:personal.id};
    })()`);
    await rpc('Page.reload');
    await until(() => evaluate(`Boolean(${button('.space-name', 'Save fixture space')})`), 'seed reload');
    await click(`${button('.space-name', 'Save fixture space')}?.closest('.space-header')?.querySelector('.space-chevron')`);
    await click(button('.task-item-title', 'bound-task'));
    await until(() => evaluate('Boolean(document.querySelector(\'button[title="打开概览"]\'))'), 'bound task');
    await showGadgets();
    const first = await save('Task save fixture');
    assert.equal(path.dirname(first), path.join(taskRoot, 'gadgets'));
    assert.equal(fs.readFileSync(path.join(first, 'code/page/index.html'), 'utf8'), '<h1>Task saved source</h1>');
    assert.deepEqual(fs.readFileSync(path.join(first, 'code/assets/pixel.bin')), Buffer.from([0, 255, 13, 10]));
    assert(fs.existsSync(path.join(first, 'gadget.json')));
    assert(await evaluate(`Boolean(${button('.gadget-save-result button', '打开文件夹')})`));
    fs.writeFileSync(path.join(first, 'code/page/index.html'), 'user change');
    const second = await save('Task save fixture');
    assert.notEqual(second, first);
    assert.equal(fs.readFileSync(path.join(first, 'code/page/index.html'), 'utf8'), 'user change');
    assert.equal(fs.readFileSync(path.join(second, 'code/page/index.html'), 'utf8'), '<h1>Task saved source</h1>');
    await screenshot('saved-task-directory');
    report.tests.push('Real menu clicks save nested HTML/binary resources/configuration to the bound task directory; repeated saves preserve user edits and expose the folder action');
    const rejected = await evaluate(`window.api.gadget.saveToTaskDirectory({gadgetId:${JSON.stringify(seed.privateGadget)},taskId:'isolated-task'}).then(()=>'',e=>String(e))`);
    assert(rejected.includes('其它任务'), rejected);
    // Save an independent personal copy, then export it from My Gadgets.
    await click(`${card('Task save fixture')}?.querySelector('.gadget-more-btn')`);
    await click(button('.gadget-action-menu-popover button', '保存到我的工作台'));
    await until(() => evaluate(`window.api.gadget.list({scope:{type:'global'}}).then(rows=>rows.some(g=>g.name==='Task save fixture' && g.id!==${JSON.stringify(seed.own)}))`), 'independent personal Gadget');
    const personalCopyId = await evaluate(`window.api.gadget.list({scope:{type:'global'}}).then(rows=>rows.find(g=>g.name==='Task save fixture' && g.id!==${JSON.stringify(seed.own)}).id)`);
    assert.equal(await evaluate(`window.api.gadget.get(${JSON.stringify(seed.own)}).then(g=>g.scope.type)`), 'task');
    const openMyGadgets = async () => {
      await click('document.querySelector(".sidebar-user-main")');
      await click(button('.sidebar-popup-item', '我的工作台'));
      await until(() => evaluate('Boolean(document.querySelector(".gadget-page"))'), 'My Gadgets page');
    };
    const personalCard = `[...document.querySelectorAll('.gadget-page .gadget-card')].find(e=>e.querySelector('.gadget-card-name')?.textContent==='Task save fixture')`;
    const openTaskPicker = async () => {
      await click(`${personalCard}?.querySelector('.gadget-more-btn')`);
      await click(button('.gadget-action-menu-popover button', '保存到任务工作目录'));
      await until(() => evaluate('Boolean(document.querySelector("[aria-label=目标任务]"))'), 'target task picker');
    };
    await openMyGadgets();
    await openTaskPicker();
    assert.equal(await evaluate('document.querySelector("[aria-label=目标任务]").value'), 'bound-task');
    const beforeCancel = fs.readdirSync(path.join(taskRoot, 'gadgets'));
    await click(button('.gadget-dialog footer button', '取消'));
    assert.deepEqual(fs.readdirSync(path.join(taskRoot, 'gadgets')), beforeCancel);
    await openTaskPicker();
    await click(button('.gadget-dialog footer button', '保存副本'));
    await until(() => evaluate('Boolean(document.querySelector(".gadget-save-result"))'), 'personal export confirmation');
    const promotedCopy = await evaluate('document.querySelector(".gadget-saved-path").textContent');
    assert.equal(path.dirname(promotedCopy), path.join(taskRoot, 'gadgets'));
    assert.notEqual(promotedCopy, first);
    assert.equal(await evaluate(`window.api.gadget.get(${JSON.stringify(seed.own)}).then(g=>g.scope.type)`), 'task');
    assert.equal(await evaluate(`window.api.gadget.get(${JSON.stringify(personalCopyId)}).then(g=>g.scope.type)`), 'global');
    assert.equal(fs.readFileSync(path.join(first, 'code/page/index.html'), 'utf8'), 'user change');
    await screenshot('personal-tool-task-save');
    report.tests.push('Actual copy-to-My-Gadgets then save: current task is offered explicitly, Cancel creates nothing, saving keeps the personal Gadget and prior user-edited copies');
    await click('document.querySelector("button[aria-label=新建独立任务]")');
    await openMyGadgets();
    await openTaskPicker();
    assert.equal(await evaluate('document.querySelector("[aria-label=目标任务]").value'), '', 'no active task must not choose an arbitrary destination');
    assert(await evaluate(`${button('.gadget-dialog footer button', '保存副本')}.disabled`));
    await screenshot('choose-task-without-active');
    const targetIndex = await evaluate('[...document.querySelector("[aria-label=目标任务]").options].findIndex(o=>o.value==="isolated-task")');
    assert(targetIndex > 0);
    await click('document.querySelector("[aria-label=目标任务]")');
    const keypress = async (key, code, n) => { for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: n }); };
    await keypress('Home', 'Home', 36);
    for (let n = 0; n < targetIndex; n++) await keypress('ArrowDown', 'ArrowDown', 40);
    await keypress('Enter', 'Enter', 13);
    await until(() => evaluate('document.querySelector("[aria-label=目标任务]").value==="isolated-task"'), 'native task selection');
    await click(button('.gadget-dialog footer button', '保存副本'));
    await until(() => evaluate('Boolean(document.querySelector(".gadget-save-result"))'), 'chosen task saved');
    const chosenCopy = await evaluate('document.querySelector(".gadget-saved-path").textContent');
    assert(chosenCopy.startsWith(path.join(home, '.mybuddy/task-workspaces') + path.sep), chosenCopy);
    assert.equal(fs.readFileSync(path.join(chosenCopy, 'code/page/index.html'), 'utf8'), '<h1>Task saved source</h1>');
    assert.equal(await evaluate(`window.api.gadget.get(${JSON.stringify(seed.own)}).then(g=>g.scope.type)`), 'task');
    assert.equal(await evaluate(`window.api.gadget.get(${JSON.stringify(personalCopyId)}).then(g=>g.scope.type)`), 'global');
    report.tests.push('Without an active task, My Gadgets requires a destination selection; native select and save write only to the chosen isolated task, preserving the personal tool');
    await click(button('.task-item-title', 'isolated-task'));
    await until(() => evaluate('!document.querySelector(".gadget-save-result")'), 'prior save notice hidden');
    await showGadgets();
    assert.equal(await evaluate(`Boolean(${card('Private export fixture')})`), false);
    const isolated = await save('Personal save fixture');
    assert(isolated.startsWith(path.join(home, '.mybuddy/task-workspaces') + path.sep), isolated);
    assert(fs.existsSync(path.join(isolated, 'code/index.html')));
    report.tests.push('Switching tasks removes the previous result; sibling private Gadgets are rejected; visible personal Gadget saves to the isolated task directory');
    await click(`${button('.space-name', 'Missing fixture space')}?.closest('.space-header')?.querySelector('.space-chevron')`);
    await click(button('.task-item-title', 'bad-task'));
    await showGadgets();
    await click(`${card('Personal save fixture')}?.querySelector('.gadget-more-btn')`);
    await click(button('.gadget-action-menu-popover button', '保存到任务工作目录'));
    await until(() => evaluate('Boolean(document.querySelector(".gadget-error"))'), 'directory error shown');
    assert.equal(await evaluate('Boolean(document.querySelector(".gadget-save-result"))'), false);
    assert.equal(fs.existsSync(path.join(home, 'missing')), false);
    await screenshot('missing-directory-error');
    report.tests.push('A missing bound directory shows a visible error and never silently falls back or reports success');
    await rpc('Page.reload');
    await until(() => evaluate('Boolean(window.api?.gadget)'), 'renderer restart');
    const source = await evaluate(`window.api.gadget.readSource(${JSON.stringify(seed.own)})`);
    assert.equal(source.files.find(f => f.path === 'page/index.html').content, '<h1>Task saved source</h1>');
    assert.equal(fs.readFileSync(path.join(first, 'code/page/index.html'), 'utf8'), 'user change');
    report.tests.push('Renderer reload preserves original Gadget and independent saved/user-edited copies');
    report.status = 'passed';
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1; console.error(error);
    try { if (ws?.readyState === 1) { report.ui = await evaluate('document.body.innerText'); await screenshot('failure'); } } catch {}
  } finally {
    if (child && ws?.readyState === 1) { ws.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' })); await wait(1000); }
    ws?.close(); for (const p of pending.values()) clearTimeout(p.timer);
    if (child?.exitCode === null) child.kill('SIGTERM');
    if (log !== undefined) fs.closeSync(log);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  }
})();
