/** Actual pnpm dev -> Electron -> preload -> Bot page -> native HTTP fixture, isolated HOME. No build/pack. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const live = process.env.BOT_SETTINGS_LIVE === '1';
const selectedModel = live ? 'opendesign/deepseek-v4.1-flash' : 'fixture';
const modelKey = `fixture/${selectedModel}`;
const headless = process.env.BOT_WORK_DEV_HEADLESS === '1';
const phase5 = process.env.BOT_WORK_DEV_PHASE5 === '1';
if (headless && process.platform !== 'linux') throw Error('Headless dev page validation requires Linux; it does not validate desktop input.');
const out = path.join(root, live ? 'out/diagnostics/bot-settings/live' : 'out/diagnostics/bot-settings/dev'); fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-work-phase3-dev-'));
const agentDir = path.join(home, '.mybuddy'); fs.mkdirSync(agentDir, { recursive: true });
for (const directory of ['AppData/Roaming', 'AppData/Local', 'Temp']) fs.mkdirSync(path.join(home, directory), { recursive: true });
let processDev, socket, sequence = 0, log;
let electronExecutable, devDebugPort, launcherIdentity, electronWatch;
const ownedElectronMains = new Map();
const pending = new Map(), requests = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, label) => { const end = Date.now() + 90000; while (!await fn()) { if (Date.now() > end) throw Error('timeout: ' + label); await wait(100); } };
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
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result?.value;
}
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw); requests.push(body);
  const names = (body.tools || []).map(tool => tool.function?.name);
  const foreground = names.includes('work_create');
  if (foreground) assert(names.every(name => ['work_query_status', 'work_create', 'work_amend', 'work_pause', 'work_resume', 'work_cancel', 'memory_search'].includes(name)), 'actual foreground provider whitelist');
  const userIndex = body.messages.findLastIndex(message => message.role === 'user');
  const recent = body.messages.slice(userIndex + 1);
  const input = JSON.stringify(body.messages[userIndex]?.content);
  const delegate = foreground && input.includes('委托界面验收') && !recent.some(message => message.role === 'tool');
  const query = foreground && input.includes('查询界面事项') && !recent.some(message => message.role === 'tool');
  const tool = delegate ? { name: 'work_create', arguments: JSON.stringify({ title: '界面验收事项', criteria: [{ text: 'fixture 成果待验收' }] }) }
    : query ? { name: 'work_query_status', arguments: '{}' } : undefined;
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: tool }] }
    : { role: 'assistant', content: foreground ? '前台界面真实回复' : '后台原生界面成果' };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (value) => res.write(`data: ${JSON.stringify({ id: `resp-${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'fixture', ...value })}\n\n`);
  chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  res.end('data: [DONE]\n\n');
});
async function send(text) {
  await evaluate('document.querySelector("#bot-draft").focus()');
  await rpc('Input.insertText', { text });
  await until(() => evaluate(`document.querySelector('#bot-draft').value === ${JSON.stringify(text)}`), 'composer text');
  await evaluate('document.querySelector(".bot-composer button[type=submit]").click()');
  await until(() => evaluate('document.querySelector("#bot-draft").value === ""'), 'accepted receipt clears matching draft');
}
function isolatedSql(input) {
  // Presentation fixtures only. Business controls below go through actual preload/IPC.
  const source = `import json,sqlite3,sys
p=json.load(sys.stdin)
c=sqlite3.connect(p['database'],timeout=10)
c.row_factory=sqlite3.Row
with c:
 for statement in p['statements']:
  c.execute(statement['sql'],statement.get('params',[]))
 rows=[dict(x) for x in c.execute(p['query']['sql'],p['query'].get('params',[]))] if p.get('query') else []
print(json.dumps(rows))
c.close()`;
  return JSON.parse(cp.execFileSync('python', ['-c', source], { input: JSON.stringify({ database: path.join(agentDir, 'app.db'), ...input }), encoding: 'utf8', windowsHide: true }));
}
const report = { platform: `${process.platform} pnpm dev, isolated profile`, displayMode: headless ? 'headless-renderer' : 'desktop-session',
  validatesNativeDesktopInput: false, seededPresentationFacts: [], actualControlChecks: [], status: 'running', home, checks: [] };
(async () => {
  try {
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const model = { id: selectedModel, name: live ? 'DeepSeek live verification' : 'Settings fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: live ? "http://127.0.0.1:3425/v1" : `http://127.0.0.1:${provider.address().port}/v1`, models: [model, ...Array.from({length: 50}, (_, i) => ({...model, id: `disabled-${i}`, name: `Disabled catalog model ${i}`}))] } } }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: selectedModel, enabledModels: [modelKey],
      memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light', permissionMode: 'readonly' }));
    const port = await freePort();
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), REMOTE_DEBUGGING_PORT: String(port),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
      ELECTRON_CLI_ARGS: JSON.stringify(['--remote-debugging-address=127.0.0.1', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--enable-logging=stderr',
        ...(headless ? ['--ozone-platform=headless', '--disable-gpu'] : [])]) };
    delete env.ELECTRON_RUN_AS_NODE;
    assert(process.env.npm_execpath && fs.existsSync(process.env.npm_execpath), 'launch through pnpm test script');
    log = fs.openSync(path.join(out, 'dev.log'), 'w');
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
    await until(() => evaluate('Boolean(window.api?.botWork?.sendMessage && document.querySelector("textarea"))'), 'preload and renderer');
    await evaluate('document.querySelector(".sidebar-user-main").click()');
    await until(() => evaluate('[...document.querySelectorAll("button")].some(button => button.textContent.includes("Bot 模式"))'), 'account navigation');
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("Bot 模式")).click()');
    await until(() => evaluate('Boolean(document.querySelector("#bot-draft"))'), 'independent Bot page');
    await until(() => evaluate('window.api.botWork.hostStatus().then(value => value.isAuthority)'), 'authoritative Bot host');
    const botId = 'bot-mybuddy-default';
    await evaluate(`document.querySelector('[aria-label="Bot 设置与对话管理"]').click()`);
    await until(() => evaluate(`Boolean(document.querySelector('[aria-label="Bot 工作文件夹"]'))`), "settings form");
    const choices = await evaluate(`Array.from(document.querySelector('[aria-label="Bot 模型"]').options, option => ({value:option.value, disabled:option.disabled}))`);
    assert.deepEqual(choices.map(item => item.value), ['', modelKey], 'disabled catalog models do not flood the picker');
    assert(await evaluate(`document.querySelector('[aria-label="Bot 模型"]').getBoundingClientRect().height <= 200`), 'model list has bounded height');
    await evaluate(`(() => {const el=document.querySelector('[aria-label="搜索 Bot 模型"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'no-such-model'); el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(() => evaluate(`document.querySelector('.bot-model-settings').textContent.includes('没有匹配')`), 'search empty state');
    await evaluate(`(() => {const el=document.querySelector('[aria-label="搜索 Bot 模型"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'fixture'); el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(() => evaluate(`document.querySelector('[aria-label="Bot 模型"]').options.length === 2`), 'search by provider id');
    report.checks.push('50 disabled catalog models hidden, searchable by provider, bounded native list, empty-state feedback');
    const folder = path.join(home, 'chosen-workspace'); fs.mkdirSync(folder);
    const evidence = `BOT_SETTINGS_VERIFIED_${Date.now()}`; fs.writeFileSync(path.join(folder,'settings-evidence.txt'),evidence);
    await evaluate(`(() => { const el = document.querySelector('[aria-label="Bot 工作文件夹"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(folder)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evaluate(`(() => { const el = document.querySelector('[aria-label="Bot 模型"]'); el.value=${JSON.stringify(modelKey)}; el.dispatchEvent(new Event('change', { bubbles:true })); })()`);
    await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent === '刷新模型列表').click()`);
    await until(() => evaluate(`[...document.querySelectorAll('button')].some(x => x.textContent === '刷新模型列表' && !x.disabled)`), 'catalog refreshed');
    assert.equal(await evaluate(`document.querySelector('[aria-label="Bot 工作文件夹"]').value`), folder, 'refresh preserves draft folder');
    assert.equal(await evaluate(`document.querySelector('[aria-label="Bot 模型"]').value`), modelKey, 'refresh preserves draft model');
    await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent === '保存 Bot 设置').click()`);
    await until(() => evaluate('document.querySelector(".bot-execution-settings").textContent.includes("已保存")'), 'save through UI and IPC');
    const saved = await evaluate(`window.api.botWork.getSettings('${botId}')`);
    assert.equal(saved.settings.effectiveWorkspacePath, folder); assert.equal(saved.settings.modelId, modelKey);
    await evaluate(`document.querySelector('[aria-label="关闭 Bot 设置"]').click()`);
    await evaluate(`document.querySelector('[aria-label="Bot 设置与对话管理"]').click()`);
    await until(() => evaluate(`document.querySelector('[aria-label="Bot 工作文件夹"]')?.value === ${JSON.stringify(folder)}`), 'reopen retains saved folder');
    const checkboxLayout = await evaluate(`(() => { const el = document.querySelector('.bot-setting-choice'); const input = el?.querySelector('input'); return !el || (getComputedStyle(el).flexDirection === 'row' && input.getBoundingClientRect().width < 30); })()`);
    assert(checkboxLayout, 'checkbox rows are compact and horizontal');
    const shot = await rpc('Page.captureScreenshot', {format:'png',captureBeyondViewport:false}); fs.writeFileSync(path.join(out,'bot-settings.png'),Buffer.from(shot.data,'base64'));
    await evaluate(`document.querySelector('[aria-label="关闭 Bot 设置"]').click()`);
    await send(live ? '请创建一个后台事项，立即执行：用 pwd 确认当前工作目录，再读取该目录下 settings-evidence.txt 的全部内容，准确报告目录和文件原文。不修改任何文件。' : '委托界面验收');
    await until(() => evaluate('window.api.db.listTasks().then(tasks => tasks.length > 0)'), 'background task creation');
    const task = (await evaluate('window.api.db.listTasks()'))[0];
    assert.equal(task.spaceId, saved.settings.spaceId); assert.equal(task.modelId,modelKey);
    await until(() => evaluate('window.api.botWork.listWorks(true).then(works => works.some(w => w.executions.some(e => e.status === "completed")))'), 'native fixture task completion');
    const persisted = isolatedSql({statements:[],query:{sql:'SELECT cwd FROM tasks WHERE id=?',params:[task.id]}})[0];
    assert.equal(persisted.cwd,folder);
    if (live) {
      await until(() => evaluate(`window.api.botWork.history({botId:'${botId}'}).then(h => h.messages.some(m => m.role === 'assistant' && m.text.includes('${evidence}')))`), 'live model reports unseen on-disk evidence');
      report.checks.push('LIVE DeepSeek model read exact unseen on-disk evidence from selected workspace');
    }
    report.checks.push(`real Electron UI save, close/reopen, exact model, dedicated space, persisted native cwd; ${live ? 'live local DeepSeek transport' : 'HTTP fixture transport, not live LLM'}`);
    await evaluate(`document.querySelector('[aria-label="Bot 设置与对话管理"]').click()`);
    await until(() => evaluate(`Boolean(document.querySelector('[aria-label="Bot 模型"]'))`), 'reopen settings for navigation');
    await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent === '管理模型').click()`);
    await until(() => evaluate(`!document.querySelector('.bot-settings-dialog[open]') && document.querySelector('.settings-content-title')?.textContent === '模型'`), 'model manager is not trapped behind Bot modal');
    await evaluate(`document.querySelector('.settings-content-head .icon-btn').click()`);
    await evaluate(`document.querySelector('[aria-label="Bot 设置与对话管理"]').click()`);
    await until(() => evaluate(`document.querySelector('[aria-label="Bot 模型"]')?.value === ${JSON.stringify(modelKey)}`), 'return from manager preserves saved selection');
    report.checks.push('model manager navigation closes native modal; return retains saved model');
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
      if (windows) cp.execFileSync('taskkill.exe', ['/PID', String(processDev.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else processDev.kill('SIGTERM');
    } }
    if (log !== undefined) fs.closeSync(log); await new Promise(resolve => provider.close(resolve));
    console.log(`Bot settings pnpm dev UI: ${report.status}; ${path.join(out, 'report.json')}`);
  }
})();
