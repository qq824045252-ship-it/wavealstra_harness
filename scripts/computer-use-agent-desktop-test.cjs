/** Real AgentService + tool wire + native host + renderer, with an isolated profile.
 * Only the model endpoint is scripted. MYBUDDY_DESKTOP_EXECUTABLE accepts a packaged app.
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), http = require('node:http'), net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const executable = process.env.MYBUDDY_DESKTOP_EXECUTABLE;
const output = path.resolve(process.env.MYBUDDY_CU_TEST_OUT || 'out/tests/computer-use-agent-desktop');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-cu-agent-'));
fs.mkdirSync(output, { recursive: true });
for (const dir of ['.mybuddy/plugins/mcp', 'appdata', 'localappdata', 'workspace']) fs.mkdirSync(path.join(fixture, dir), { recursive: true });
fs.writeFileSync(path.join(fixture, '.mybuddy/plugins/mcp/mcp.json'), '{"mcpServers":{}}');
const report = { status: 'running', executable: executable || 'dev', fixture, tests: [], calls: [] };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, timeout = 30000, ignoreGatewayError = false) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (report.gatewayError && !ignoreGatewayError) throw Error(report.gatewayError); if (await check()) return; await wait(80); }
  throw Error('Timeout: ' + label);
}
let proc, socket, fd, gateway, held, seq = 0, mode = 'complete', step = 0, targetHandle, targetPoint;
const pending = new Map();
async function main(expression) {
  const result = await new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Inspector timeout')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const ui = expression => main(`globalThis.__cuMain.webContents.executeJavaScript(${JSON.stringify(expression)}, true)`);
const overlayState = () => main(`process.mainModule.require('electron').BrowserWindow.getAllWindows().filter(w=>w.getTitle().includes('COMPUTER_USE_')).map(w=>({title:w.getTitle(),visible:w.isVisible()}))`);
async function hidden() { const state = await overlayState(); return state.length === 2 && state.every(w => !w.visible); }
function send(res, event) { res.write(`data: ${JSON.stringify(event)}\n\n`); }
function reply(res, item) {
  send(res, { type: 'response.output_item.added', output_index: 0, item });
  send(res, { type: 'response.output_item.done', output_index: 0, item });
  send(res, { type: 'response.completed', response: { id: `response-${mode}-${step}`, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10 } } });
  res.end();
}
function value(item) {
  const text = typeof item.output === 'string' ? item.output : item.output.filter(x => x.text).map(x => x.text).join('\n');
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}
(async () => {
  try {
    gateway = http.createServer(async (req, res) => {
      try {
        let raw = ''; for await (const chunk of req) raw += chunk;
        if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
        const body = JSON.parse(raw);
        for (const name of ['ui_exec', 'computer_exec']) {
          const tool = body.tools.find(t => t.name === name);
          assert(tool, name + ' is available to the actual model'); assert.equal(tool.strict, false);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        send(res, { type: 'response.created', response: { id: `response-${mode}-${step}`, status: 'in_progress' } });
        const outputs = body.input.filter(x => x.type === 'function_call_output');
        const last = outputs.at(-1);
        if (mode !== 'complete' && step === 1) {
          assert.equal(value(last).action, 'list_windows');
          await until(hidden, 'CU retracts while provider is still pending, without final or Stop');
          if (mode === 'cancel') held = res; else res.end();
          return;
        }
        let name = 'computer_exec', args;
        switch (step) {
          case 0: args = { action: 'list_windows' }; break;
          case 1:
            await until(hidden, 'CU retracts before non-desktop UI work, without agent final');
            name = 'ui_exec'; args = { action: 'snapshot', target: 'app' }; break;
          case 2: {
            const snapshot = value(last);
            const element = snapshot.elements.find(x => x.id === 'cu-fixture-button');
            assert(element, 'snapshot app must still target main renderer while overlay and secondary windows exist');
            name = 'ui_exec'; args = { action: 'click', selector: element.selector }; break;
          }
          case 3:
            assert.equal(await ui('window.__cuClicks'), 1, 'snapshot selector must cause a real click');
            args = { action: 'inspect_controls', window_handle: targetHandle }; break;
          case 4:
            assert.equal(value(last).truncated, true, 'deep fixture exposes the bounded initial UIA observation');
            args = { action: 'inspect_controls', window_handle: targetHandle, max_depth: 32 }; break;
          case 5:
            assert(JSON.stringify(value(last)).includes('Native action'), 'real Windows UIA tree contains fixture button: ' + JSON.stringify(value(last)));
            { const bounds = value(last).controls.find(c => c.name === 'Native action' && c.controlType === 'Button').clientBoundsDip;
              targetPoint = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }; }
            args = { action: 'invoke_control', window_handle: targetHandle, control_name: 'Native action', max_depth: 32 }; break;
          case 6:
            await until(() => main(`globalThis.__cuTarget.webContents.executeJavaScript('window.clicked===1')`), 'native UIA invoke updates DOM');
            args = { action: 'screenshot_window', window_handle: targetHandle }; break;
          case 7: {
            const capture = value(last);
            assert.equal(capture.computerUseRun.verification.visualVerification, 'captured');
            assert.equal(capture.computerUseRun.phase, 'executed', 'screenshot does not prove task success');
            assert.equal(capture.capture.coordinateSpace, 'client-dip-aligned-pixels');
            args = { action: 'click_client', window_handle: targetHandle, observation_id: capture.observationId, ...targetPoint }; break;
          }
          default: {
            assert.equal(step, 8, 'bounded agent fixture');
            await until(() => main(`globalThis.__cuTarget.webContents.executeJavaScript('window.clicked===2')`), 'physical coordinate click triggers exactly once');
            assert.equal(value(last).computerUseRun.phase, 'executed');
            reply(res, { type: 'message', id: 'msg-final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'CU_AGENT_FLOW_COMPLETE', annotations: [] }] });
            return;
          }
        }
        report.calls.push({ mode, name, args });
        const id = `${mode}-${step++}`;
        reply(res, { type: 'function_call', id: 'fc-' + id, call_id: 'call-' + id, name, arguments: JSON.stringify(args), status: 'completed' });
      } catch (error) { report.gatewayError = String(error.stack || error); res.end(); }
    });
    await new Promise(r => gateway.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(fixture, '.mybuddy/models.json'), JSON.stringify({ providers: { magpie: {
      baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, apiKey: 'isolated-fixture', api: 'openai-responses',
      models: [{ id: 'fixture', name: 'Fixture', api: 'openai-responses', reasoning: false, input: ['text', 'image'], contextWindow: 500000, maxTokens: 4096 }]
    } } }));
    fs.writeFileSync(path.join(fixture, '.mybuddy/settings.json'), JSON.stringify({ memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, permissionMode: 'auto', enabledModels: ['magpie/fixture'], defaultProvider: 'magpie', defaultModel: 'fixture', retry: { enabled: false, maxRetries: 0 } }));
    if (executable) {
      const { createHash } = require('node:crypto'), asar = require('@electron/asar');
      const hash = bytes => createHash('sha256').update(bytes).digest('hex');
      report.mainHash = hash(asar.extractFile(path.join(path.dirname(executable), 'resources/app.asar'), path.join('out', 'main', 'index.js')));
      assert.equal(report.mainHash, hash(fs.readFileSync('out/main/index.js')));
      report.executableHash = hash(fs.readFileSync(executable));
    }
    const port = await new Promise(r => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => r(p)); }); });
    const env = { ...process.env, HOME: fixture, USERPROFILE: fixture, APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata'), XDG_CONFIG_HOME: path.join(fixture, '.config'), PI_CODING_AGENT_DIR: path.join(fixture, '.mybuddy') };
    delete env.ELECTRON_RUN_AS_NODE;
    fd = fs.openSync(path.join(output, 'startup.log'), 'w');
    const args = [`--inspect=127.0.0.1:${port}`, `--user-data-dir=${path.join(fixture, 'chromium')}`, '--force-renderer-accessibility', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
    proc = spawn(executable || require('electron'), executable ? args : [path.join(root, 'out/main/index.js'), ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', fd, fd] });
    let target;
    await until(async () => {
      if (proc.exitCode !== null) throw Error('App exited: ' + proc.exitCode);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'node'); return !!target; } catch { return false; }
    }, 'main inspector');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = event => { const msg = JSON.parse(event.data), p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result); };
    await until(() => main('Boolean(process.mainModule?.require)'), 'application main module initialized');
    await main(`(async()=>{const {app}=process.mainModule.require('electron');await app.whenReady();if(process.mainModule.require('node:os').homedir()!==${JSON.stringify(fixture)}||!app.getPath('userData').startsWith(${JSON.stringify(fixture)}))throw Error('Profile isolation failed');return true})()`);
    await until(() => main(`(()=>{globalThis.__cuMain=process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html')&&!w.webContents.isLoadingMainFrame());return !!globalThis.__cuMain})()`), 'main window');
    await until(() => ui('Boolean(window.api?.agent && document.querySelector(".sidebar"))'), 'app UI');
    report.version = await main("process.mainModule.require('electron').app.getVersion()");
    if (executable) assert.equal(report.version, JSON.parse(fs.readFileSync('package.json')).version);
    await ui(`(async()=>{await window.api.db.upsertSpace({id:'cu-space',name:'CU isolated',path:${JSON.stringify(path.join(fixture, 'workspace'))},createdAt:Date.now(),updatedAt:Date.now()});await window.api.db.upsertTask({id:'cu-task',title:'CU acceptance',spaceId:'cu-space',updatedAt:Date.now(),modelId:'magpie/fixture',permissionMode:'auto',welcomeMode:'working'});window.__cuClicks=0;const b=document.createElement('button');b.id='cu-fixture-button';b.textContent='CU fixture action';b.style='position:fixed;top:100px;left:200px;z-index:999999;padding:20px';b.onclick=()=>window.__cuClicks++;document.body.append(b);window.__cuEvents=[];window.api.agent.onEvent(p=>window.__cuEvents.push(p));return true})()`);
    targetHandle = await main(`(async()=>{const {app,BrowserWindow}=process.mainModule.require('electron');app.setAccessibilitySupportEnabled(true);const w=globalThis.__cuTarget=new BrowserWindow({width:420,height:300,show:false});await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>MyBuddy CU E2E Fixture</title>'+Array.from({length:14},(_,i)=>'<div role="group" aria-label="Level '+i+'">').join('')+'<button style="margin:60px;padding:20px" onclick="window.clicked++">Native action</button>'+'</div>'.repeat(14)+'<script>window.clicked=0</script>'));w.showInactive();return w.getNativeWindowHandle().readBigUInt64LE().toString()})()`);
    const request = () => ({ taskId: 'cu-task', spaceId: 'cu-space', text: 'Run isolated Computer Use acceptance ' + mode, modelId: 'magpie/fixture', welcomeMode: 'working', permissionMode: 'auto', userMessageId: 'user-' + mode, assistantMessageId: 'assistant-' + mode });
    await ui(`window.api.agent.prompt(${JSON.stringify(request())})`);
    await until(hidden, 'normal completion hides BOTH native overlay windows');
    assert(await ui(`window.__cuEvents.some(p=>p.type==='assistant_end'&&p.messageId==='assistant-complete')`));
    report.tests.push('Actual agent: list windows -> app snapshot -> exact DOM click -> deep UIA inspect/invoke -> screenshot -> observation-bound physical coordinate click -> final -> native overlay hidden');
    mode = 'cancel'; step = 0;
    await ui(`window.__cuPrompt=window.api.agent.prompt(${JSON.stringify(request())}).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}));true`);
    await until(() => !!held, 'provider waiting after successful CU action');
    await ui(`window.api.agent.abort('cu-task')`);
    await until(hidden, 'abort hides overlay while provider has not completed');
    assert.equal((await ui('window.__cuPrompt')).ok, true);
    held.end(); held = undefined;
    report.tests.push('CU retracts while the provider is held; subsequent abort settles the task without false errors or reopening the overlays');
    mode = 'truncate'; step = 0;
    const failed = await ui(`window.api.agent.prompt(${JSON.stringify(request())}).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}))`);
    assert.equal(failed.ok, false); assert(failed.error.includes('terminal response event'), failed.error);
    await until(hidden, 'provider failure hides BOTH native overlay windows');
    report.tests.push('Provider EOF after successful CU remains a task failure and releases both native windows');
    report.status = 'passed'; console.log(JSON.stringify(report, null, 2));
  } catch (error) { report.status = 'failed'; report.error = String(error.stack || error); console.error(error); process.exitCode = 1; }
  finally {
    try { if (socket) { report.overlay = await overlayState(); await main("setTimeout(()=>process.mainModule.require('electron').app.quit(),100);true"); } } catch {}
    if (socket) socket.close();
    if (proc) await until(() => proc.exitCode !== null, 'fixture shutdown', 10000, true).catch(() => proc.kill());
    if (fd !== undefined) fs.closeSync(fd);
    if (held) held.end(); if (gateway) { gateway.closeAllConnections(); gateway.close(); }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  }
})();
