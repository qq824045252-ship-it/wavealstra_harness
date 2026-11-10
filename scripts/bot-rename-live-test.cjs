/** Real pnpm dev / Electron / preload / SQLite rename acceptance. Isolated HOME; no model call, build or pack. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (process.platform !== 'linux') throw Error('This isolated desktop acceptance runs on Omarchy/Linux only.');
const selectedModel = process.env.BOT_FRONTDOOR_MODEL || 'opendesign/deepseek-v4.1-flash';
const modelKey = `fixture/${selectedModel}`;
const headless = process.env.BOT_WORK_DEV_HEADLESS === '1';
const out = path.join(root,'out/diagnostics/bot-rename/live'); fs.mkdirSync(out,{recursive:true});
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-frontdoor-live-'));
const agentDir = path.join(home, '.mybuddy'); fs.mkdirSync(agentDir, { recursive: true });
for (const directory of ['AppData/Roaming', 'AppData/Local', 'Temp']) fs.mkdirSync(path.join(home, directory), { recursive: true });
let processDev, socket, sequence = 0, log;
let electronExecutable, devDebugPort, launcherIdentity, electronWatch;
const ownedElectronMains = new Map();
const pending = new Map(), requests = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, label) => { const end = Date.now() + 240000; while (!await fn()) { if (Date.now() > end) throw Error('timeout: ' + label); await wait(100); } };
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
function linuxProcessState(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, parent: Number(fields[1]), startedAt: fields[19],
      args: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) };
  } catch { return undefined; } // The process may have exited between proc reads.
}
function isTestElectronMain(state) {
  if (!state || !state.args.includes(`--remote-debugging-port=${devDebugPort}`)
    || state.args.some(arg => arg === '--type' || arg.startsWith('--type='))) return false;
  try {
    const env = fs.readFileSync(`/proc/${state.pid}/environ`, 'utf8').split('\0');
    return fs.realpathSync(`/proc/${state.pid}/exe`) === electronExecutable
      && fs.realpathSync(`/proc/${state.pid}/cwd`) === fs.realpathSync(root)
      && env.includes(`HOME=${home}`) && env.includes(`REMOTE_DEBUGGING_PORT=${devDebugPort}`)
      && !env.includes('ELECTRON_RUN_AS_NODE=1');
  } catch { return false; }
}
function trackTestElectronMains() {
  if (process.platform !== 'linux' || !launcherIdentity) return;
  const launcher = linuxProcessState(launcherIdentity.pid);
  if (!launcher || launcher.startedAt !== launcherIdentity.startedAt) return;
  const queue = [launcher], seen = new Set();
  while (queue.length) {
    const parent = queue.shift();
    if (seen.has(parent.pid)) continue;
    seen.add(parent.pid);
    if (isTestElectronMain(parent)) ownedElectronMains.set(parent.pid, parent.startedAt);
    let children;
    try { children = fs.readFileSync(`/proc/${parent.pid}/task/${parent.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); }
    catch { continue; }
    for (const id of children) {
      const child = linuxProcessState(Number(id));
      if (child?.parent === parent.pid) queue.push(child);
    }
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
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method + ' ' + String(params.expression ?? '').slice(0,160))); }, 20000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result?.value;
}
// Transparent recording transport: every inference is forwarded to the real configured model.
const provider = http.createServer(async (req,res) => {
  try {
    let raw=''; for await(const chunk of req) raw+=chunk;
    const body = JSON.parse(raw); requests.push(body);
    const response=await fetch((process.env.BOT_FRONTDOOR_BASE_URL || 'http://127.0.0.1:3425/v1')+'/chat/completions', {
      method:'POST',headers:{'content-type':'application/json'},body:raw});
    res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'text/event-stream'});
    for await(const chunk of response.body) res.write(chunk);
    res.end();
  } catch(error) { res.writeHead(502);res.end(String(error)); }
});
async function send(text) {
  // New-conversation transitions can replace the textarea after preload is ready.
  // Re-focus only an empty composer; never append a duplicate prompt or resend a receipt.
  await until(async () => {
    const value = await evaluate('document.querySelector("#bot-draft")?.value');
    if (value === text) return true;
    if (value === '') {
      await evaluate('document.querySelector("#bot-draft").focus()');
      await rpc('Input.insertText', { text });
    }
    return false;
  }, 'composer text');
  await evaluate('document.querySelector(".bot-composer button[type=submit]").click()');
  await until(() => evaluate('document.querySelector("#bot-draft").value === ""'), 'accepted receipt clears matching draft');
}
const report = { platform: `${process.platform} pnpm dev, isolated profile`, displayMode: headless ? 'headless-renderer' : 'desktop-session',
  validatesNativeDesktopInput: false, status: 'running', home, checks: [] };
(async () => {
  try {
    await new Promise(resolve=>provider.listen(0,"127.0.0.1",resolve));
    const model = { id: selectedModel, name: 'Frontdoor live verification', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [model] } } }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: selectedModel, enabledModels: [modelKey],
      memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light', permissionMode: 'readonly' }));
    const launch = async () => {
    const port = await freePort();
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), REMOTE_DEBUGGING_PORT: String(port),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
      ELECTRON_CLI_ARGS: JSON.stringify(['--remote-debugging-address=127.0.0.1', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--enable-logging=stderr',
        ...(headless ? ['--ozone-platform=headless', '--disable-gpu'] : [])]) };
    delete env.ELECTRON_RUN_AS_NODE;
    assert(process.env.npm_execpath && fs.existsSync(process.env.npm_execpath), 'set npm_execpath to the installed pnpm executable');
    if (log !== undefined) fs.closeSync(log);
    log = fs.openSync(path.join(out, 'dev.log'), 'a');
    // pnpm also ships native Linux/macOS executables without a .exe extension.
    const nativePnpm = !/\.(?:cjs|mjs|js)$/i.test(process.env.npm_execpath);
    if (process.platform === 'linux') { electronExecutable = fs.realpathSync(require('electron')); devDebugPort = port; }
    processDev = cp.spawn(nativePnpm ? process.env.npm_execpath : process.execPath,
      nativePnpm ? ['dev'] : [process.env.npm_execpath, 'dev'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
    if (process.platform === 'linux') {
      launcherIdentity = linuxProcessState(processDev.pid);
      trackTestElectronMains(); electronWatch = setInterval(trackTestElectronMains, 100); electronWatch.unref();
    }
    let target;
    await until(async () => {
      if (processDev.exitCode !== null) throw Error('pnpm dev exited ' + processDev.exitCode);
      try { target = (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).then(response => response.json())).find(item => item.type === 'page' && /localhost|127\.0\.0\.1/.test(item.url)); return Boolean(target); } catch { return false; }
    }, 'dev Electron renderer');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => { const value = JSON.parse(event.data), call = pending.get(value.id); if (!call) return; pending.delete(value.id); clearTimeout(call.timer); value.error ? call.reject(Error(JSON.stringify(value.error))) : call.resolve(value.result); });
    await rpc('Runtime.enable'); await rpc('Page.enable');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    };
    await launch();
    await until(() => evaluate('Boolean(window.api?.botWork?.sendMessage && document.querySelector("textarea"))'), 'preload and renderer');
    await evaluate('document.querySelector(".sidebar-user-main").click()');
    await until(() => evaluate('[...document.querySelectorAll("button")].some(button => button.textContent.includes("Bot 模式"))'), 'account navigation');
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("Bot 模式")).click()');
    await until(() => evaluate('Boolean(document.querySelector("#bot-draft"))'), 'independent Bot page');
    await until(() => evaluate('window.api.botWork.hostStatus().then(value => value.isAuthority)'), 'authoritative Bot host');

    const before=await evaluate("window.api.botWork.listBots()");
    const bot=before.find(b=>b.botId==="bot-mybuddy-default"); assert(bot);
    assert.equal(await evaluate("!!document.querySelector('.bot-heading .bot-rename-trigger')"), false, "no extra header entry");
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Bot 设置与对话管理').click()");
    await until(()=>evaluate("!!document.querySelector('.bot-settings-identity .bot-rename-trigger')"),"settings identity");
    await evaluate("document.querySelector('.bot-settings-identity .bot-rename-trigger').click()");
    await until(()=>evaluate("!!document.querySelector('.bot-rename-dialog[open] input')"),"rename dialog");
    await evaluate("document.querySelector('.bot-rename-dialog[open] input').focus(); document.querySelector('.bot-rename-dialog[open] input').select()");
    await rpc("Input.insertText",{text:"我的日常助理"});
    await evaluate("document.querySelector('.bot-rename-dialog[open] button[type=submit]').click()");
    await until(()=>evaluate("document.querySelector('.bot-heading h1')?.textContent==='我的日常助理'"),"renamed header");
    await until(()=>evaluate("[...document.querySelectorAll('.sidebar-bot-identity')].some(el=>el.textContent.includes('我的日常助理'))"),"sidebar reflects identity");
    const after=(await evaluate("window.api.botWork.listBots()")).find(b=>b.botId===bot.botId);
    assert.equal(after.displayName,"我的日常助理");assert.deepEqual(after.authorization,bot.authorization);assert.deepEqual(after.expertProfile,bot.expertProfile);
    await rpc("Page.reload"); await wait(700);
    await until(()=>evaluate("document.querySelector('.bot-heading h1')?.textContent==='我的日常助理'"),"reload retains name");
    report.checks.push("real pnpm dev + preload + SQLite: rename through settings-only dialog, side bar refresh, stable identity and permissions/profile, renderer reload");
    assert.equal(requests.length, 0, "renaming needs no model call");
    report.visibleText = await evaluate("document.body.innerText");
    // Wayland may not capture an occluded surface. Screenshot is diagnostics,
    // not a substitute for the DOM, native IPC and database assertions above.
    try {
      await rpc("Page.bringToFront");
      const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(out,'rename-workspace.png'),Buffer.from(shot.data,'base64'));
    } catch(error) { report.screenshotError=String(error); }
    report.status='passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); console.error(error); process.exitCode = 1;
    if (socket) try { report.visibleText = await evaluate('document.body.innerText'); const shot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(out, 'failed-page.png'), Buffer.from(shot.data, 'base64')); } catch {}
  }
  finally {
    if (electronWatch) clearInterval(electronWatch);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, 'provider-requests.json'), JSON.stringify(requests, null, 2));
    if (socket) { try { await rpc('Browser.close'); } catch {} socket.close(); }
    await stopTestElectronMains();
    if (processDev) { await wait(1000); if (processDev.exitCode === null) {
      processDev.kill('SIGTERM');
    } }
    if (log !== undefined) fs.closeSync(log); await new Promise(resolve=>provider.close(resolve));
    console.log(`Bot frontdoor pnpm dev UI: ${report.status}; ${path.join(out, 'report.json')}`);
  }
})();
