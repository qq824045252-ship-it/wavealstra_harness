/** Actual pnpm dev -> Electron -> preload -> Bot page -> native HTTP fixture, isolated HOME. No build/pack. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'out/diagnostics/bot-work-phase2/dev'); fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-work-phase2-dev-'));
const agentDir = path.join(home, '.mybuddy'); fs.mkdirSync(agentDir, { recursive: true });
for (const directory of ['AppData/Roaming', 'AppData/Local', 'Temp']) fs.mkdirSync(path.join(home, directory), { recursive: true });
let processDev, socket, sequence = 0, log;
const pending = new Map(), requests = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, label) => { const end = Date.now() + 90000; while (!await fn()) { if (Date.now() > end) throw Error('timeout: ' + label); await wait(100); } };
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
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
  if (foreground) assert(names.every(name => ['work_query_status', 'work_create', 'work_amend', 'work_pause', 'work_resume', 'work_cancel', 'memory_search', 'work_team_templates', 'work_team_create', 'schedule_overview', 'web_search', 'fetch_content'].includes(name)), 'actual foreground provider whitelist');
  const userIndex = body.messages.findLastIndex(message => message.role === 'user');
  const recent = body.messages.slice(userIndex + 1);
  const input = JSON.stringify(body.messages[userIndex]?.content);
  const delegate = foreground && input.includes('委托界面验收') && !recent.some(message => message.role === 'tool');
  const query = foreground && input.includes('查询界面事项') && !recent.some(message => message.role === 'tool');
  const tool = delegate ? { name: 'work_create', arguments: JSON.stringify({ requestedOutcome: 'one_time', mode: 'once', title: '界面验收事项', criteria: [{ text: 'fixture 成果待验收' }] }) }
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
const report = { status: 'running', home, checks: [] };
(async () => {
  try {
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const model = { id: 'fixture', name: 'Phase 2 Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [model] } } }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enabledModels: ['fixture/fixture'],
      memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light', permissionMode: 'readonly' }));
    const port = await freePort();
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), REMOTE_DEBUGGING_PORT: String(port),
      ELECTRON_CLI_ARGS: JSON.stringify(['--remote-debugging-address=127.0.0.1', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--enable-logging=stderr']) };
    delete env.ELECTRON_RUN_AS_NODE;
    assert(process.env.npm_execpath && fs.existsSync(process.env.npm_execpath), 'launch through pnpm test script');
    log = fs.openSync(path.join(out, 'dev.log'), 'w');
    const nativePnpm = path.extname(process.env.npm_execpath).toLowerCase() === '.exe';
    processDev = cp.spawn(nativePnpm ? process.env.npm_execpath : process.execPath,
      nativePnpm ? ['dev'] : [process.env.npm_execpath, 'dev'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
    let target;
    await until(async () => {
      if (processDev.exitCode !== null) throw Error('pnpm dev exited ' + processDev.exitCode);
      try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())).find(item => item.type === 'page' && /localhost|127\.0\.0\.1/.test(item.url)); return Boolean(target); } catch { return false; }
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
    await send('普通界面提问');
    await until(() => evaluate('document.querySelector(".bot-thread").textContent.includes("前台界面真实回复")'), 'native foreground answer');
    assert.equal((await evaluate('window.api.db.listTasks()')).length, 0);
    assert.equal((await evaluate('window.api.botWork.listWorks(true)')).length, 0); report.checks.push('ordinary UI answer without Task/Work');
    await send('委托界面验收');
    await until(() => evaluate('window.api.botWork.listWorks(true).then(works => works.some(work => work.deliverables.length === 1))'), 'background native result');
    await until(() => evaluate('document.querySelector(".bot-thread").textContent.includes("界面验收事项")'), 'authoritative Work card');
    const works = await evaluate('window.api.botWork.listWorks(true)');
    assert.equal(works.length, 1); assert.equal(works[0].lifecycle, 'active'); assert.equal(works[0].acceptedDeliverableIds.length, 0);
    await send('查询界面事项');
    await until(() => evaluate('window.api.botWork.history({botId:"bot-mybuddy-default"}).then(history => history.messages.filter(message => message.role === "assistant" && message.status === "completed").length === 3)'), 'query while Work remains unaccepted');
    await until(() => evaluate('[...document.querySelectorAll(".bot-thread article")].filter(article => article.querySelector("strong")?.textContent === "MyBuddy" && article.querySelector("small")?.textContent === "已回复").length === 3'), 'latest replies rendered after durable history read');
    await evaluate('document.querySelector(".bot-work-card").click()');
    const screenshot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(out, 'bot-page.png'), Buffer.from(screenshot.data, 'base64'));
    report.checks.push('UI send -> trusted control -> independent root -> result -> projection -> Work selection');
    report.works = works; report.providerRequests = requests.length; report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); console.error(error); process.exitCode = 1;
    if (socket) try { report.visibleText = await evaluate('document.body.innerText'); } catch {}
  }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, 'provider-requests.json'), JSON.stringify(requests, null, 2));
    if (socket) { try { await rpc('Browser.close'); } catch {} socket.close(); }
    if (processDev) { await wait(1000); if (processDev.exitCode === null) cp.execFileSync('taskkill.exe', ['/PID', String(processDev.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    if (log !== undefined) fs.closeSync(log); await new Promise(resolve => provider.close(resolve));
    console.log(`Phase 2 pnpm dev UI: ${report.status}; ${path.join(out, 'report.json')}`);
  }
})();
