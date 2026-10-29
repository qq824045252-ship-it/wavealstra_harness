/** Real provider -> packaged Electron -> hidden browser screenshots and scoped CU Stop. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');

const root = path.resolve(__dirname, '..');
const main = path.join(root, 'out/main/index.js');
const out = process.env.COMPUTER_USE_ARTIFACT_DIR
  ? path.resolve(root, process.env.COMPUTER_USE_ARTIFACT_DIR)
  : path.join(root, 'artifacts/computer-use-browser-repair/desktop-live');
fs.mkdirSync(out, { recursive: true });
const lock = path.join(out, 'acceptance.lock');
try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' }); }
catch (error) { if (error.code === 'EEXIST') { console.error('Computer Use desktop acceptance is already running.'); process.exit(2); } throw error; }
process.on('exit', () => { try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock); } catch {} });

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-computer-use-desktop-'));
const profile = path.join(temporary, 'profile');
const agentDir = path.join(profile, '.mybuddy');
const workspace = path.join(temporary, 'workspace');
// 这是「真机验收」：需要本机 ~/.mybuddy 里已配置好的 provider/model 与凭据。
// 托管 CI runner 没有真实用户配置，缺前置条件时显式 SKIP（退出 0），不要假装跑过。
{
  const realProfile = path.join(os.homedir(), '.mybuddy');
  if (!fs.existsSync(path.join(realProfile, 'settings.json'))) {
    console.log(`[SKIP] computer-use-desktop: 需要本机已配置的 ${path.join(realProfile, 'settings.json')}（含 provider/model 与凭据），当前不存在。`);
    process.exit(0);
  }
}
let selectedModel;
function configureProfile() {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  for (const suffix of ['AppData/Roaming', 'AppData/Local']) fs.mkdirSync(path.join(profile, suffix), { recursive: true });
  const source = path.join(os.homedir(), '.mybuddy');
  const sourceSettings = JSON.parse(fs.readFileSync(path.join(source, 'settings.json'), 'utf8'));
  selectedModel = process.env.COMPUTER_USE_MODEL || `${sourceSettings.defaultProvider}/${sourceSettings.defaultModel}`;
  assert(selectedModel.includes('/') && !selectedModel.includes('undefined'), 'A configured real provider/model is required');
  report.model = selectedModel;
  const slash = selectedModel.indexOf('/');
  for (const name of ['auth.json', 'models.json', 'models-store.json']) {
    const file = path.join(source, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(agentDir, name));
  }
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: selectedModel.slice(0, slash), defaultModel: selectedModel.slice(slash + 1),
    defaultThinkingLevel: 'off', enabledModels: [selectedModel],
    memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false,
    theme: 'light', language: 'zh-CN', permissionMode: 'auto', proxyUrl: sourceSettings.proxyUrl || '',
  }));
  fs.writeFileSync(path.join(agentDir, 'mcp.json'), '{"mcpServers":{}}');
  const capabilities = { schemaVersion: 1, execution: { terminalEnabled: true, codeExecutionEnabled: false } };
  for (const key of ['web', 'vision', 'imageGeneration', 'videoGeneration', 'speechToText', 'textToSpeech', 'browser', 'diagnostics', 'subagent', 'multiModelConsult']) capabilities[key] = { enabled: false };
  capabilities.browser.enabled = true;
  fs.writeFileSync(path.join(agentDir, 'capabilities.json'), JSON.stringify(capabilities));
}

const nonce = crypto.randomBytes(8).toString('hex');
const continuePath = path.join(workspace, 'continued-after-computer-stop.txt');
let desktopPort, fixtureServer, fixtureUrl, fixtureClicks = 0;
const report = { kind: 'computer-use-real-provider-source-electron', artifactDir: out, model: selectedModel, nonce, startedAt: new Date().toISOString(), tests: [], status: 'running' };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let child, socket, fd, requestId = 0;
const requests = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { requests.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
    requests.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result?.value;
}
async function until(expression, limit = 30000) {
  const started = Date.now();
  while (Date.now() - started < limit) { const value = await evaluate(expression); if (value) return value; await delay(150); }
  throw Error('Timed out awaiting desktop state: ' + expression);
}
async function capture(name) {
  const shot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function newTask() {
  await evaluate(`(()=>{const e=document.querySelector('button[title="新建任务"]');if(e)e.click();return true;})()`);
  await until('Boolean(document.querySelector(".hero textarea"))');
  await evaluate(`(()=>{const e=[...document.querySelectorAll('.hero-categories button')].find(e=>e.textContent.trim()==='代码开发');if(!e)throw Error('Code scene unavailable');e.click();return true;})()`);
  await delay(100);
  await evaluate(`(()=>{const e=[...document.querySelectorAll('.hero-scenes button')].find(e=>e.textContent.trim()==='最小模式');if(e)e.click();return true;})()`);
}
async function submit(prompt) {
  await newTask();
  await evaluate(`window.__nativeCore.current={tools:[],text:'',started:false,done:false,textEvents:0}`);
  await evaluate(`(()=>{const e=document.querySelector('textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(prompt)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await delay(100);
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await until('window.__nativeCore.current.started', 25000);
}
function sessionMessages() {
  const messages = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.jsonl')) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
        const value = JSON.parse(line);
        if (value.message) messages.push(value.message);
      }
    }
  }
  walk(path.join(agentDir, 'sessions'));
  return messages;
}
async function test(name, prompt, check, cancel = false) {
  const row = { name, startedAt: new Date().toISOString(), status: 'running' };
  report.tests.push(row); save();
  try {
    await submit(prompt);
    if (cancel) {
      await until('window.__nativeCore.current.tools.some(t=>t.name==="computer_exec")',60000);
      let controls;
      for(let i=0;i<100;i++){
        controls=(await fetch('http://127.0.0.1:'+desktopPort+'/json/list').then(r=>r.json())).find(p=>p.title==='__MYBUDDY_COMPUTER_USE_CONTROLS__');
        if(controls)break;
        if((await evaluate('window.__nativeCore.current')).done)throw Error('Task ended before the Computer Use Stop control appeared');
        await delay(100);
      }
      assert(controls,'Computer Use Stop overlay did not appear');
      const controlSocket=new WebSocket(controls.webSocketDebuggerUrl);
      await new Promise((resolve,reject)=>{controlSocket.addEventListener('open',resolve,{once:true});controlSocket.addEventListener('error',reject,{once:true})});
      try{
        const clicked=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('Computer Use Stop control timed out')),5000);
          controlSocket.addEventListener('message',e=>{const r=JSON.parse(e.data);if(r.id===1){clearTimeout(timer);r.error?reject(Error(JSON.stringify(r.error))):r.result?.exceptionDetails?reject(Error(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text)):r.result?.result?.value!==true?reject(Error('Stop control did not execute')):resolve(r)}});
        });
        controlSocket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(async()=>{if(document.readyState==='loading')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));const stop=document.querySelector('a[href="mybuddy-computer-use://stop"]');if(!stop)throw Error('Stop control unavailable');stop.click();return true;})()`,returnByValue:true,awaitPromise:true}}));
        await clicked;row.stoppedViaRealOverlay=true;row.cancelledAt=Date.now();
      }finally{controlSocket.close()}
    }
    const state = await until('window.__nativeCore.current.done&&window.__nativeCore.current', 180000);
    row.tools = state.tools; row.finalText = state.text; row.assistantError = state.error; row.taskId = state.taskId;
    assert(!state.tools.some(tool => tool.approval), 'Native core requested a retired product approval');
    assert(!state.error, 'The parent Agent task was aborted or failed: ' + state.error);
    row.result = await check(state);
    row.status = 'passed'; console.log('PASS actual Electron ' + name);
  } catch (error) {
    row.status = 'failed'; row.error = error.message;
    try { row.state = await evaluate('window.__nativeCore.current'); if (row.state.taskId && !row.state.done) await evaluate(`window.api.agent.abort(${JSON.stringify(row.state.taskId)})`); } catch {}
    console.error('FAIL actual Electron ' + name + ': ' + error.message);
  } finally { row.finishedAt = new Date().toISOString(); try { await capture(name); } catch {} save(); }
}

(async () => {
  try {
    configureProfile();
    fixtureServer=require('node:http').createServer((req,res)=>{
      if(req.url==='/clicked'){fixtureClicks++;res.writeHead(200,{'content-type':'text/plain'});res.end('ok');return;}
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      res.end('<!doctype html><html><head><title>Screenshot acceptance fixture</title><style>body{margin:0;background:#1965c0;color:white;font:32px sans-serif;padding:40px}button{padding:16px;background:#ffd451;font:28px sans-serif}#state{background:#247b37;padding:20px}</style></head><body><h1>VISUAL-'+nonce+'</h1><button id="fixtureButton" onclick="document.querySelector(&quot;#state&quot;).textContent=&quot;CLICKED&quot;;fetch(&quot;/clicked&quot;)">Run fixture action</button><p id="state">READY</p></body></html>');
    });
    await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));fixtureUrl='http://127.0.0.1:'+fixtureServer.address().port;
    const executable = process.env.COMPUTER_USE_DESKTOP_EXE;
    if (executable) {
      assert(fs.existsSync(executable), 'Requested packaged desktop executable is missing');
      report.executable = path.resolve(executable);
      report.kind = 'computer-use-real-provider-packaged-electron';
      const archive = path.join(path.dirname(report.executable), 'resources/app.asar');
      assert(fs.existsSync(archive), 'Packaged desktop archive is missing');
      report.asarSha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    } else {
      assert(fs.existsSync(main), 'Run pnpm build before this acceptance');
      report.mainBuildSha256 = crypto.createHash('sha256').update(fs.readFileSync(main)).digest('hex');
    }
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
    desktopPort = port;
    const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'), PI_CODING_AGENT_DIR: agentDir };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(env)) if (/^MYBUDDY_/i.test(key)) delete env[key];
    fd = fs.openSync(path.join(out, 'desktop.log'), 'w');
    const arguments_ = [
      ...(executable ? [] : [main]), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    ];
    child = cp.spawn(executable || require('electron'), arguments_, { cwd: profile, env, stdio: ['ignore', fd, fd], windowsHide: true });
    report.pid = child.pid; save();
    let page;
    for (let index = 0; index < 120; index++) {
      try { page = (await fetch('http://127.0.0.1:' + port + '/json/list').then(response => response.json())).find(item => item.type === 'page' && !item.url.startsWith('devtools')); if (page) break; } catch {}
      if (child.exitCode !== null) throw Error('Electron exited before readiness: ' + child.exitCode);
      await delay(250);
    }
    assert(page, 'Actual Electron renderer unavailable');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => { const message = JSON.parse(event.data); const pending = requests.get(message.id); if (!pending) return; requests.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(Error(JSON.stringify(message.error))) : pending.resolve(message.result); });
    await rpc('Runtime.enable');
    await until('Boolean(window.api?.agent&&document.querySelector("textarea"))');
    const models = await evaluate('window.api.agent.listModels().then(rows=>rows.map(m=>({id:m.id,provider:m.provider,available:m.available,enabled:m.enabled,supportsImages:m.supportsImages})))');
    assert(models.some(model => model.available !== false && (model.id === selectedModel || `${model.provider}/${model.id}` === selectedModel)), 'Selected configured model is unavailable');
    assert(models.some(model=>model.supportsImages&&(model.id===selectedModel||`${model.provider}/${model.id}`===selectedModel)),'Screenshot acceptance requires a configured native image model');
    report.permissionMode='auto (isolated localhost fixtures only)';
    await evaluate(`(()=>{window.__nativeCore={current:null,errors:[]};window.addEventListener('error',e=>window.__nativeCore.errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__nativeCore.errors.push(String(e.reason)));window.api.agent.onEvent(e=>{const s=window.__nativeCore.current;if(!s)return;s.seq=(s.seq||0)+1;if(e.taskId)s.taskId=e.taskId;if(e.type==='assistant_start'){s.started=true;s.messageId=e.messageId;s.done=false;}if(e.type==='text_delta'){s.textEvents++;s.text+=e.delta||'';}if(e.type==='tool_start')s.tools.push({id:e.toolCallId,name:e.tool,parent:e.parentToolCallId,summary:e.summary,status:e.status,taskId:e.taskId,startSeq:s.seq,approval:e.status==='pending_approval'});if(e.type==='tool_update'){const t=s.tools.find(t=>t.id===e.toolCallId);if(t){if(e.status){t.status=e.status;if(e.status==='success'||e.status==='error')t.endSeq=s.seq;}if(e.output)t.output=String(e.output);if(e.status==='pending_approval')t.approval=true;}}if(e.type==='assistant_end'){s.done=true;s.error=e.error;s.finishedAt=Date.now();}});return true;})()`);
    await test('hidden-browser-screenshot-and-action', '只按这个顺序调用browser_exec：navigate打开 '+fixtureUrl+'；screenshot观察；click selector="#fixtureButton"；screenshot再次观察。禁止read、ui_exec、computer_exec、shell和其他工具。页面包含未知VISUAL标记，最后根据真实截图报告该标记完整文字及操作后的状态。不要打开浏览器侧栏。', async state=>{
      assert(state.tools.every(t=>t.name==='browser_exec'&&!t.parent),'Unexpected tool could bypass visual nonce proof');
      const tools=state.tools.filter(t=>t.name==='browser_exec');assert.equal(tools.length,4);assert(tools.every(t=>t.status==='success'),'Browser tool failed');
      assert.equal(fixtureClicks,1,'Actual fixture action did not execute exactly once');
      assert(state.text.includes('VISUAL-'+nonce),'Real provider did not read the unknown marker from screenshot');assert.match(state.text,/CLICKED/);
      const browserMessages=sessionMessages().filter(m=>m.role==='toolResult'&&m.toolName==='browser_exec');assert.deepEqual(browserMessages.map(m=>m.details?.action),['navigate','screenshot','click','screenshot']);
      const screenshots=sessionMessages().filter(m=>m.role==='toolResult'&&m.toolName==='browser_exec'&&m.details?.action==='screenshot');
      const nativeImages=[];
      assert.equal(screenshots.length,2);for(const [index,m] of screenshots.entries()){assert(!m.isError);assert(m.content.some(p=>p.type==='image'&&p.data.length>100));const bytes=fs.readFileSync(m.details.path);assert(bytes.length>1000);assert.equal(bytes.subarray(1,4).toString(),'PNG');const evidencePath=path.join(out,`browser-native-${index}.png`);fs.writeFileSync(evidencePath,bytes);nativeImages.push({path:evidencePath,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
      assert.notEqual(nativeImages[0].sha256,nativeImages[1].sha256,'Click must produce a fresh visual frame');
      return {nativeImageResults:screenshots.length,nativeImages,visualNonceRead:true,actualFixtureClicks:fixtureClicks};
    });
    await test('computer-stop-preserves-agent-task', '仅调用一次computer_exec action=wait_for_window，window_title='+JSON.stringify('Missing acceptance window '+nonce)+'，timeout_ms=30000，wait_state=visible。用户会在操作界面点击停止；收到取消结果后不要重试computer_exec，不要中止任务，改用原生write创建 '+JSON.stringify(continuePath.split(path.sep).join('/'))+'，内容逐字为 '+JSON.stringify('CONTINUED-'+nonce)+'，然后回复任务已继续。禁止其他工具。', async state=>{
      const calls=state.tools.filter(t=>t.name==='computer_exec');assert.equal(calls.length,1);assert.equal(calls[0].status,'error');assert.match(calls[0].output||'',/cancel|取消|停止/i);
      assert.deepEqual(state.tools.map(t=>t.name),['computer_exec','write']);
      const write=state.tools[1];assert.equal(write.status,'success');assert.equal(write.taskId,calls[0].taskId);assert(calls[0].endSeq<write.startSeq,'Write started before CU cancellation completed');
      assert.equal(fs.readFileSync(continuePath,'utf8'),'CONTINUED-'+nonce);return {computerUseCancelled:true,parentTaskContinued:true,nativeWriteAfterStop:true};
    },true);
    report.rendererErrors = await evaluate('window.__nativeCore.errors');
    assert.deepEqual(report.rendererErrors, []);
    const transcript = sessionMessages();
    report.observedModels = [...new Set(transcript.filter(message => message.role === 'assistant').map(message => `${message.provider}/${message.model}`))];
    assert(report.observedModels.includes(selectedModel), 'A real configured provider response must be persisted');
    if (report.executable) {
      const archive = path.join(path.dirname(report.executable), 'resources/app.asar');
      const finalHash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
      assert.equal(finalHash, report.asarSha256, 'Packaged build changed during desktop acceptance');
    }
    report.status = report.tests.length && report.tests.every(test => test.status === 'passed') ? 'passed' : 'failed';
  } catch (error) { report.status = 'failed'; report.error = error.message; console.error('Computer Use desktop acceptance failed: ' + error.message); }
  finally {
    if(fixtureServer)await new Promise(resolve=>fixtureServer.close(resolve));
    try { if (socket?.readyState === WebSocket.OPEN) await rpc('Browser.close'); } catch {}
    socket?.close(); for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(Error('Desktop closed')); } requests.clear();
    await delay(700);
    if (child?.exitCode === null) { try { cp.execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch {} }
    if (fd !== undefined) fs.closeSync(fd);
    const resolved = path.resolve(temporary);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('mybuddy-computer-use-desktop-'), 'Cleanup escaped the disposable test directory');
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); report.temporaryCredentialsRemoved = true; }
    catch (error) { report.cleanupError = error.message; report.status = 'failed'; }
    report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ status: report.status, report: path.join(out, 'results.json') }));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
})();
