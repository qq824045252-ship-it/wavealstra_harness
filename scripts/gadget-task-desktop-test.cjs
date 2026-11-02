/** Real application UI, isolated HOME/userData; also accepts MYBUDDY_DESKTOP_EXECUTABLE. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const executable = process.env.MYBUDDY_DESKTOP_EXECUTABLE;
const output = path.resolve(process.env.MYBUDDY_GADGET_TEST_OUT || path.join(root, 'out/tests/gadget-task-desktop'));
fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-gadget-desktop-'));
for (const dir of ['.mybuddy/plugins/mcp', 'appdata', 'localappdata', 'workspace']) fs.mkdirSync(path.join(fixture, dir), { recursive: true });
fs.writeFileSync(path.join(fixture, '.mybuddy/plugins/mcp/mcp.json'), '{"mcpServers":{}}');
fs.writeFileSync(path.join(fixture, '.mybuddy/settings.json'), JSON.stringify({ memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, permissionMode: 'auto' }));
const report = { tests: [], status: 'running', executable: executable || 'dev', fixture };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await wait(100); }
  throw Error('Timeout: ' + label);
}
let proc, socket, fd, sequence = 0;
const pending = new Map();
async function main(expression) {
  const result = await new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Inspector timeout')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const ui = expression => main(`globalThis.__gadgetWindow.webContents.executeJavaScript(${JSON.stringify(expression)}, true)`);
async function click(expression) {
  const point = await ui(`(() => {const el=${expression};if(!el)throw Error('Missing target');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  await main(`(()=>{const wc=globalThis.__gadgetWindow.webContents;wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...${JSON.stringify(point)}});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...${JSON.stringify(point)}});return true})()`);
  await wait(180);
}
const card = `[...document.querySelectorAll('.task-gadget-strip .gadget-card')].find(el=>el.querySelector('.gadget-card-name')?.textContent==='VPS fixture')`;
const cardButton = name => `${card}?.querySelector(${JSON.stringify(name)})`;
const sourceEditor = `document.querySelector(${JSON.stringify('textarea[aria-label="Gadget 源码"]')})`;
const button = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)})`;
async function screenshot(name) {
  await main(`(async()=>{const image=await globalThis.__gadgetWindow.capturePage();process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(path.join(output, name + '.png'))}, image.toPNG());return image.getSize()})()`);
}
async function frameText() {
  return main(`(async()=>{const frame=globalThis.__gadgetWindow.webContents.mainFrame.frames.find(f=>f.url.startsWith('http://127.0.0.1:'));return frame?frame.executeJavaScript('document.body.innerText'):''})()`);
}
(async () => {
  try {
    if (executable) {
      const asar = require('@electron/asar');
      const archive = path.join(path.dirname(executable), 'resources/app.asar');
      const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
      report.mainHash = hash(asar.extractFile(archive, path.join('out', 'main', 'index.js')));
      assert.equal(report.mainHash, hash(fs.readFileSync(path.join(root, 'out/main/index.js'))));
      report.executableHash = hash(fs.readFileSync(executable));
    }
    const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
    const env = { ...process.env, HOME: fixture, USERPROFILE: fixture, PI_CODING_AGENT_DIR: path.join(fixture, '.mybuddy'), APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata'), XDG_CONFIG_HOME: path.join(fixture, '.config') };
    delete env.ELECTRON_RUN_AS_NODE;
    fd = fs.openSync(path.join(output, 'startup.log'), 'w');
    const args = [`--inspect=127.0.0.1:${port}`, `--user-data-dir=${path.join(fixture, 'chromium')}`, '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
    proc = spawn(executable || require('electron'), executable ? args : [path.join(root, 'out/main/index.js'), ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', fd, fd] });
    let target;
    await until(async () => {
      if (proc.exitCode !== null) throw Error('App exited ' + proc.exitCode);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'node'); return !!target; } catch { return false; }
    }, 'main inspector');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = event => { const msg = JSON.parse(event.data), request = pending.get(msg.id); if (!request) return; pending.delete(msg.id); clearTimeout(request.timer); msg.error ? request.reject(Error(JSON.stringify(msg.error))) : request.resolve(msg.result); };
    assert.equal(await main('process.pid'), proc.pid);
    await main(`(async()=>{const {app}=process.mainModule.require('electron');await app.whenReady();if(process.mainModule.require('node:os').homedir()!==${JSON.stringify(fixture)}||!app.getPath('userData').startsWith(${JSON.stringify(fixture)}))throw Error('Profile isolation failed');return true})()`);
    await until(() => main(`(()=>{const {BrowserWindow}=process.mainModule.require('electron');globalThis.__gadgetWindow=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL().includes('index.html')&&!w.webContents.isLoadingMainFrame());return !!globalThis.__gadgetWindow})()`), 'app window');
    await until(() => ui('Boolean(window.api?.gadget && document.querySelector(".sidebar"))'), 'app UI');
    await main('globalThis.__gadgetWindow.showInactive();true');
    report.version = await main("process.mainModule.require('electron').app.getVersion()");
    if (executable) assert.equal(report.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version);
    const seed = await ui(`(async()=>{
      const space={id:'gadget-ui-space',name:'Gadget UI Space',path:${JSON.stringify(path.join(fixture, 'workspace'))},createdAt:Date.now(),updatedAt:Date.now()};
      const result=await window.api.db.upsertSpace(space);if(!result.ok)throw Error(result.error);
      for(const [id,title] of [['gadget-ui-task','Gadget UI Task'],['gadget-ui-other','Other Task']])await window.api.db.upsertTask({id,title,spaceId:space.id,updatedAt:Date.now()});
      const gadget=await window.api.gadget.create({name:'VPS fixture',scope:{type:'workspace',workspaceId:space.id},files:[{path:'index.html',content:'<!doctype html><html><body><h1>VPS original</h1></body></html>'}]});
      await window.api.gadget.create({name:'Personal fixture',scope:{type:'global'}});
      await window.api.gadget.create({name:'Private sibling',scope:{type:'task',taskId:'gadget-ui-other'}});
      return {gadgetId:gadget.id};
    })()`);
    await main('globalThis.__gadgetWindow.webContents.reload();true');
    await until(() => ui(`Boolean(${button('.space-name', 'Gadget UI Space')})`).catch(() => false), 'seed reload');
    await click(`${button('.space-name', 'Gadget UI Space')}?.closest('.space-header')?.querySelector('.space-chevron')`);
    await click(button('.task-item-title', 'Gadget UI Task'));
    await until(() => ui(`Boolean(${card})`), 'workspace Gadget visible in task');
    const titles = await ui(`[...document.querySelectorAll('.task-gadget-strip .gadget-card-name')].map(el=>el.textContent)`);
    assert(titles.includes('Personal fixture')); assert(!titles.includes('Private sibling'));
    report.tests.push('Task displays workspace/personal Gadgets and excludes sibling private Gadget');
    await click(cardButton('.gadget-card-actions > button'));
    await until(async () => (await frameText()).includes('VPS original'), 'Open renders Gadget');
    await screenshot('opened');
    await click(button('.gadget-view header button', '关闭'));
    await click(cardButton('.gadget-action-menu summary'));
    await click(button('.gadget-action-menu-popover button', '编辑源码'));
    await until(() => ui(`Boolean(${sourceEditor} && !${sourceEditor}.disabled)`), 'source editor');
    await click(sourceEditor);
    const edited = '<!doctype html><html><body><h1>VPS edited in task</h1></body></html>';
    await main(`(()=>{const wc=globalThis.__gadgetWindow.webContents;wc.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});wc.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});wc.insertText(${JSON.stringify(edited)});return true})()`);
    await click(button('.gadget-dialog footer button', '保存修改'));
    await until(() => ui('document.querySelector(".gadget-dialog [role=status]")?.textContent.includes("已保存")'), 'source saved');
    const saved = await ui(`window.api.gadget.readSource(${JSON.stringify(seed.gadgetId)})`);
    assert.equal(saved.files.find(f => f.path === 'index.html').content, edited);
    await screenshot('source-saved');
    await click(button('.gadget-dialog footer button', '关闭'));
    await click(cardButton('.gadget-card-actions > button'));
    await until(async () => (await frameText()).includes('VPS edited in task'), 'edited Gadget rendered');
    report.tests.push('Native clicks open Gadget; native text input saves source; same Gadget renders new content');
    const updated = '<!doctype html><html><body><h1>VPS updated by Agent</h1></body></html>';
    await ui(`window.api.gadget.updateSource(${JSON.stringify({ gadgetId: seed.gadgetId, expectedRevision: saved.revision, files: [{ path: 'index.html', content: updated }] })})`);
    await until(async () => (await frameText()).includes('VPS updated by Agent'), 'open viewer refreshes');
    await screenshot('refreshed');
    await click(button('.gadget-view header button', '关闭'));
    await main(`globalThis.__gadgetWindow.webContents.send('gadget:changed',${JSON.stringify({ type: 'open-requested', gadgetId: seed.gadgetId, taskId: 'gadget-ui-task' })});true`);
    await until(async () => (await frameText()).includes('VPS updated by Agent'), 'Agent open request');
    assert.equal(await ui('document.querySelectorAll(".gadget-view-overlay").length'), 1);
    await click(button('.gadget-view header button', '关闭'));
    await main(`globalThis.__gadgetWindow.webContents.send('gadget:changed',${JSON.stringify({ type: 'open-requested', gadgetId: seed.gadgetId, taskId: 'gadget-ui-other' })});true`);
    await wait(300);
    assert.equal(await ui('document.querySelectorAll(".gadget-view-overlay").length'), 0);
    report.tests.push('Source update refreshes open viewer; Agent open event opens once and respects active task');
    report.status = 'passed';
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); console.error(error); process.exitCode = 1;
    try { if (socket) { report.ui = await ui('document.body.innerText'); await screenshot('failure'); } } catch {}
  } finally {
    try { if (socket) await main("setTimeout(()=>process.mainModule.require('electron').app.quit(),100);true"); } catch {}
    if (socket) socket.close();
    if (proc) { await until(() => proc.exitCode !== null, 'fixture shutdown', 15000).catch(() => proc.kill()); }
    if (fd !== undefined) fs.closeSync(fd);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    // Retain this isolated profile and screenshots as diagnostics; never touch real user data.
  }
})();
