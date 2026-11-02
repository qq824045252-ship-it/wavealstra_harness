/** Real application UI, isolated HOME/userData; also accepts MYBUDDY_DESKTOP_EXECUTABLE. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), net = require('node:net');
const { spawn } = require('node:child_process');
const http = require('node:http');
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
let proc, socket, fd, gateway, sequence = 0, modelMode = 'cancel', modelRequests = 0, heldResponse;
let gadgetId;
const modelCalls = [];
function sendEvent(res, event) { res.write(`data: ${JSON.stringify(event)}\n\n`); }
function reply(res, item) {
  sendEvent(res, { type: 'response.output_item.added', output_index: 0, item });
  sendEvent(res, { type: 'response.output_item.done', output_index: 0, item });
  sendEvent(res, { type: 'response.completed', response: { id: 'fixture-response-' + modelRequests, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10 } } });
  res.end();
}
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
const card = `[...document.querySelectorAll('.task-gadgets-view .gadget-card')].find(el=>el.querySelector('.gadget-card-name')?.textContent==='VPS fixture')`;
const cardButton = name => `${card}?.querySelector(${JSON.stringify(name)})`;
const sourceEditor = `document.querySelector(${JSON.stringify('textarea[aria-label="Gadget 源码"]')})`;
const button = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)})`;
async function screenshot(name) {
  await main(`(async()=>{const win=globalThis.__gadgetWindow;const {desktopCapturer}=process.mainModule.require('electron');const [width,height]=win.getSize();const sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width,height}});const source=sources.find(s=>s.id===win.getMediaSourceId());if(!source||source.thumbnail.isEmpty())throw Error('No native window screenshot');process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(path.join(output, name + '.png'))}, source.thumbnail.toPNG());return source.thumbnail.getSize()})()`);
}
async function frameText() {
  return main(`(async()=>{const wc=process.mainModule.require('electron').webContents.getAllWebContents().find(w=>w.getURL().startsWith('http://127.0.0.1:'));return wc?wc.executeJavaScript('document.body.innerText'):''})()`);
}
async function showGadgets() {
  if (!await ui('Boolean(document.querySelector(".artifact-panel"))')) await click('document.querySelector(\'button[title="打开概览"]\')');
  await click('document.querySelector(".extension-menu-btn")');
  await click(button('.extension-mode-item', 'Gadgets'));
  await until(() => ui(`Boolean(${card})`), 'side Gadgets list');
}
async function closeBrowser() { await click('document.querySelector(\'button[title="关闭网页"]\')'); }
(async () => {
  try {
    // Only the model endpoint is controlled; session restore, native adapter,
    // AgentService, Gadget tools, HTTP runtime and renderer are the real app.
    gateway = http.createServer(async (req, res) => {
      try {
        let raw = ''; for await (const chunk of req) raw += chunk;
        if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
        const body = JSON.parse(raw); modelRequests++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        sendEvent(res, { type: 'response.created', response: { id: 'fixture-response-' + modelRequests, status: 'in_progress' } });
        if (modelMode === 'cancel' || modelMode === 'truncate') {
          sendEvent(res, { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_partial', call_id: 'partial', name: 'gadget_list', arguments: '{' } });
          if (modelMode === 'truncate') res.end(); else heldResponse = res;
          return;
        }
        assert(modelRequests < 20, 'bounded provider fixture');
        for (const name of ['gadget_list', 'gadget_read', 'gadget_update', 'gadget_open']) {
          const tool = body.tools.find(t => t.name === name);
          assert(tool, name + ' must be declared to the model after session restore');
          assert.equal(tool.strict, false, 'Responses tool preserves optional fields');
        }
        const outputs = body.input.filter(item => item.type === 'function_call_output');
        const stage = outputs.length;
        const name = ['gadget_list', 'gadget_read', 'gadget_update', 'gadget_open'][stage];
        if (!name) {
          reply(res, { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'GADGET_AGENT_FLOW_COMPLETE', annotations: [] }] }); return;
        }
        let args = {};
        if (stage === 1) { assert(outputs[0].output.includes(gadgetId)); args = { gadgetId }; }
        if (stage === 2) {
          const content = JSON.parse(outputs[1].output);
          args = { gadgetId, expectedRevision: content.revision, files: [{ path: 'index.html', content: '<!doctype html><html><body><h1>VPS changed via resumed agent</h1></body></html>' }] };
          assert(args.expectedRevision, 'read must produce an actual source revision');
        }
        if (stage === 3) { assert(outputs[2].output.includes('已更新')); args = { gadgetId }; }
        modelCalls.push(name);
        reply(res, { type: 'function_call', id: 'fc_' + stage, call_id: 'call_' + stage, name, arguments: JSON.stringify(args), status: 'completed' });
      } catch (error) { report.gatewayError = String(error.stack || error); res.end(); }
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(fixture, '.mybuddy/models.json'), JSON.stringify({ providers: { magpie: {
      baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, apiKey: 'isolated-fixture', api: 'openai-responses',
      models: [{ id: 'fixture', name: 'Fixture', api: 'openai-responses', reasoning: false, contextWindow: 500000, maxTokens: 4096 }]
    } } }));
    const settingsPath = path.join(fixture, '.mybuddy/settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsPath)), enabledModels: ['magpie/fixture'], defaultProvider: 'magpie', defaultModel: 'fixture', retry: { enabled: false, maxRetries: 0 } }));
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.create(path.join(fixture, 'workspace'), path.join(fixture, '.mybuddy/sessions'));
    manager.appendMessage({ role: 'system', content: 'Previously saved task', toolsAdded: [{ name: 'gadget_create', description: 'Create a Gadget', parameters: { type: 'object', properties: {} } }], timestamp: Date.now() });
    manager.appendMessage({ role: 'user', content: 'Find existing Gadget', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Only creation was previously available.' }], api: 'openai-responses', provider: 'magpie', model: 'fixture', stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
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
      for(const [id,title] of [['gadget-ui-task','Gadget UI Task'],['gadget-ui-other','Other Task'],['gadget-cancel-task','Cancel Fixture']])await window.api.db.upsertTask({id,title,spaceId:space.id,updatedAt:Date.now(),modelId:'magpie/fixture',permissionMode:'auto',welcomeMode:'working',...(id==='gadget-ui-task'?{sessionFile:${JSON.stringify(manager.getSessionFile())}}:{})});
      const gadget=await window.api.gadget.create({name:'VPS fixture',scope:{type:'workspace',workspaceId:space.id},files:[{path:'index.html',content:${JSON.stringify('<!doctype html><html><body><h1>VPS original</h1><button id="copy">Copy fixture command</button><script>document.querySelector("#copy").onclick=async()=>{try{localStorage.setItem("fixture","saved");await navigator.clipboard.writeText("ssh fixture@example.invalid");document.querySelector("#copy").textContent="Copied fixture command"}catch(e){document.querySelector("#copy").textContent=String(e)}}</script></body></html>')}}]});
      await window.api.gadget.create({name:'Personal fixture',scope:{type:'global'}});
      await window.api.gadget.create({name:'Private sibling',scope:{type:'task',taskId:'gadget-ui-other'}});
      return {gadgetId:gadget.id};
    })()`);
    gadgetId = seed.gadgetId;
    await main('globalThis.__gadgetWindow.webContents.reload();true');
    await until(() => ui(`Boolean(${button('.space-name', 'Gadget UI Space')})`).catch(() => false), 'seed reload');
    await click(`${button('.space-name', 'Gadget UI Space')}?.closest('.space-header')?.querySelector('.space-chevron')`);
    await click(button('.task-item-title', 'Gadget UI Task'));
    await until(() => ui('Boolean(document.querySelector(\'button[title="打开概览"]\'))'), 'task loaded');
    assert.equal(await ui('document.querySelectorAll(".chat-column .gadget-section,.task-gadget-strip").length'), 0, 'Gadgets never occupy the chat column');
    await showGadgets();
    const titles = await ui(`[...document.querySelectorAll('.task-gadgets-view .gadget-card-name')].map(el=>el.textContent)`);
    assert(titles.includes('Personal fixture')); assert(!titles.includes('Private sibling'));
    report.tests.push('No chat Gadget strip; side management lists workspace/personal Gadgets and excludes sibling private Gadget');
    await click(cardButton('.gadget-card-actions > button'));
    await until(async () => (await frameText()).includes('VPS original'), 'Open renders Gadget');
    assert.equal(await ui('document.querySelectorAll(".gadget-view-overlay,iframe").length'), 0, 'Open never creates a blocking iframe overlay');
    assert(await ui('Boolean(document.querySelector(".browser-view .browser-wcv-host"))'), 'Open uses the existing side browser');
    await until(() => main(`(()=>{const view=globalThis.__gadgetWindow.contentView.children.find(v=>v.webContents?.getURL().startsWith('http://127.0.0.1:'));return Boolean(view?.getVisible()&&view.getBounds().width>=200&&view.getBounds().height>=100)})()`), 'native browser view is visible');
    const browserBounds = await main(`globalThis.__gadgetWindow.contentView.children.find(v=>v.webContents?.getURL().startsWith('http://127.0.0.1:')).getBounds()`);
    const chatRight = await ui('document.querySelector(".content-col").getBoundingClientRect().right');
    assert(browserBounds.x >= chatRight, 'native Gadget view must not cover the chat');
    const composer = 'document.querySelector(\'.input-area [contenteditable="true"],.input-area textarea\')';
    await click(composer);
    await main(`globalThis.__gadgetWindow.webContents.insertText('Chat remains usable');true`);
    assert(await ui(`(${composer}).textContent.includes('Chat remains usable') || (${composer}).value?.includes('Chat remains usable')`));
    await main(`(()=>{const wc=globalThis.__gadgetWindow.webContents;wc.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});wc.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});wc.sendInputEvent({type:'keyDown',keyCode:'BACKSPACE'});wc.sendInputEvent({type:'keyUp',keyCode:'BACKSPACE'});return true})()`);
    await main(`(async()=>{const {clipboard,webContents}=process.mainModule.require('electron');globalThis.__gadgetClipboard=await Promise.all((await clipboard.read()).map(async item=>new (process.mainModule.require('electron').ClipboardItem)(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)]))))));const wc=webContents.getAllWebContents().find(w=>w.getURL().startsWith('http://127.0.0.1:'));const p=await wc.executeJavaScript("(()=>{const r=document.querySelector('#copy').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");wc.focus();wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});return true})()`);
    await until(async () => (await frameText()).includes('Copied fixture command'), 'native Gadget copy action');
    assert(await main(`(async()=>await process.mainModule.require('electron').clipboard.readText()==='ssh fixture@example.invalid')()`));
    await main(`(async()=>{await process.mainModule.require('electron').clipboard.write(globalThis.__gadgetClipboard);delete globalThis.__gadgetClipboard;return true})()`);
    await screenshot('opened');
    await click(button('.task-item-title', 'Other Task'));
    await until(() => ui('Boolean(document.querySelector(".home-hero,.hero-input"))'), 'empty task remains accessible');
    assert.equal(await ui('document.querySelectorAll(".task-gadget-strip").length'), 0);
    await click(button('.task-item-title', 'Gadget UI Task'));
    await until(async () => (await frameText()).includes('VPS original'), 'task browser restored');
    report.tests.push('Side browser preserves normal clipboard/storage; chat accepts input and tasks switch while the Gadget is open');
    await showGadgets();
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
    await closeBrowser();
    await main(`globalThis.__gadgetWindow.webContents.send('gadget:changed',${JSON.stringify({ type: 'open-requested', gadgetId: seed.gadgetId, taskId: 'gadget-ui-task' })});true`);
    await until(async () => (await frameText()).includes('VPS updated by Agent'), 'Agent open request');
    assert.equal(await ui('document.querySelectorAll(".browser-view").length'), 1);
    assert.equal(await ui('document.querySelectorAll(".gadget-view-overlay").length'), 0);
    await closeBrowser();
    await main(`globalThis.__gadgetWindow.webContents.send('gadget:changed',${JSON.stringify({ type: 'open-requested', gadgetId: seed.gadgetId, taskId: 'gadget-ui-other' })});true`);
    await wait(300);
    assert.equal(await ui('document.querySelectorAll(".browser-view").length'), 0);
    report.tests.push('Source update refreshes side browser; Agent opens once without the Gadget list mounted and respects active task');
    await ui(`window.__gadgetEvents=[];window.api.agent.onEvent(p=>window.__gadgetEvents.push(p));true`);
    const request = (taskId, suffix) => ({ taskId, spaceId: 'gadget-ui-space', text: suffix === 'flow' ? '找到已有 Gadget，读取后修改标题并打开。' : '列出 Gadget。', modelId: 'magpie/fixture', welcomeMode: 'working', permissionMode: 'auto', userMessageId: 'user-' + suffix, assistantMessageId: 'assistant-' + suffix });
    await ui(`window.__gadgetPrompt=window.api.agent.prompt(${JSON.stringify(request('gadget-cancel-task', 'cancel'))}).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}));true`);
    await until(() => Boolean(heldResponse), 'partial provider stream');
    await ui(`window.api.agent.abort('gadget-cancel-task')`);
    const cancelled = await ui('window.__gadgetPrompt');
    heldResponse.end(); heldResponse = undefined;
    assert.equal(cancelled.ok, true, 'user stop must not reject agent:prompt with an EOF error: ' + cancelled.error);
    const errors = await ui(`window.__gadgetEvents.filter(p=>p.messageId==='assistant-cancel'&&p.error)`);
    assert.equal(errors.length, 0, 'user stop must not emit failed/error patches');
    report.tests.push('Stopping a real partial Responses stream preserves cancellation without a false EOF failure');
    modelMode = 'flow';
    const completed = await ui(`window.api.agent.prompt(${JSON.stringify(request('gadget-ui-task', 'flow'))})`);
    assert.equal(completed.queued, false);
    if (report.gatewayError) throw Error(report.gatewayError);
    assert.deepEqual(modelCalls, ['gadget_list', 'gadget_read', 'gadget_update', 'gadget_open']);
    await until(async () => (await frameText()).includes('VPS changed via resumed agent'), 'actual resumed agent opens edited Gadget');
    await screenshot('agent-resumed');
    report.tests.push('Restored task exposes tools on the wire and executes list -> read -> update -> open through the real AgentService');
    // A genuine EOF without a user stop must still fail; never promote partial
    // function arguments to executable calls or hide provider errors.
    modelMode = 'truncate';
    const truncated = await ui(`window.api.agent.prompt(${JSON.stringify(request('gadget-cancel-task', 'truncate'))}).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}))`);
    assert.equal(truncated.ok, false);
    assert(truncated.error.includes('terminal response event'), truncated.error);
    report.tests.push('Uncancelled truncated Responses stream still surfaces its error');
    report.status = 'passed';
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); console.error(error); process.exitCode = 1;
    try { if (socket) { report.ui = await ui('document.body.innerText'); await screenshot('failure'); } } catch {}
  } finally {
    try { if (socket) await main("(async()=>{if(globalThis.__gadgetClipboard)await process.mainModule.require('electron').clipboard.write(globalThis.__gadgetClipboard);return true})()"); } catch {}
    try { if (socket) await main("setTimeout(()=>process.mainModule.require('electron').app.quit(),100);true"); } catch {}
    if (socket) socket.close();
    if (proc) { await until(() => proc.exitCode !== null, 'fixture shutdown', 15000).catch(() => proc.kill()); }
    if (fd !== undefined) fs.closeSync(fd);
    if (heldResponse) heldResponse.end();
    if (gateway) { gateway.closeAllConnections(); gateway.close(); }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    // Retain this isolated profile and screenshots as diagnostics; never touch real user data.
  }
})();
