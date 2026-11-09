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
const headless = process.env.BOT_WORK_DEV_HEADLESS === '1';

if (headless && process.platform !== 'linux') throw Error('Headless dev page validation requires Linux; it does not validate desktop input.');
const out = path.join(root, 'out/diagnostics/bot-work-recovery/dev'); fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-work-recovery-dev-'));
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
  const delegate = foreground && input.includes('委托自动恢复验收') && !recent.some(message => message.role === 'tool');
  const query = foreground && input.includes('查询界面事项') && !recent.some(message => message.role === 'tool');
  let tool = delegate ? { name: 'work_create', arguments: JSON.stringify({ title: '自动恢复验收事项', criteria: [{ text: 'fixture 成果待验收' }] }) }
    : query ? { name: 'work_query_status', arguments: '{}' } : undefined;
  const recovery = !foreground && JSON.stringify(body.messages).includes('这是原事项的定向恢复');
  const toolResults = recent.filter(message => message.role === 'tool');
  if (!foreground && !toolResults.length) tool = recovery
    ? { name: 'read', arguments: JSON.stringify({ path: 'retained-report.md' }) }
    : { name: 'write', arguments: JSON.stringify({ path: 'retained-report.md', content: '已保留的原始报告：fixture 来源 A。\n' }) };
  if (!foreground && !recovery && toolResults.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fixture terminal failure: parser unavailable; use alternative method', type: 'invalid_request_error', code: 'fixture_terminal' } })); return;
  }
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: tool }] }
    : { role: 'assistant', content: foreground ? '前台界面真实回复' : '自动恢复验收成果：已改用替代解析方式完成，fixture 来源可核对。' };
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
const report = { platform: `${process.platform} pnpm dev, isolated profile`, displayMode: headless ? 'headless-renderer' : 'desktop-session',
  validatesNativeDesktopInput: false, fixtureLimitations: ['Local deterministic HTTP provider, not an online public model; CDP input, not native keyboard/AT-SPI acceptance'], status: 'running', home, checks: [] };
(async () => {
  try {
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const model = { id: 'fixture', name: 'Recovery Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [model] } } }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enabledModels: ['fixture/fixture'],
      memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light', permissionMode: 'auto' }));
    const port = await freePort();
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), REMOTE_DEBUGGING_PORT: String(port),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
      ELECTRON_CLI_ARGS: JSON.stringify(['--remote-debugging-address=127.0.0.1', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--enable-logging=stderr',
        ...(headless ? ['--ozone-platform=headless', '--disable-gpu'] : [])]) };
    delete env.ELECTRON_RUN_AS_NODE;
    const pnpmPath = process.env.npm_execpath || cp.execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim();
    assert(pnpmPath && fs.existsSync(pnpmPath), 'pnpm executable available');
    log = fs.openSync(path.join(out, 'dev.log'), 'w');
    // pnpm also ships native Linux/macOS executables without a .exe extension.
    const nativePnpm = !/\.(?:cjs|mjs|js)$/i.test(pnpmPath);
    if (process.platform === 'linux') { electronExecutable = fs.realpathSync(require('electron')); devDebugPort = port; }
    processDev = cp.spawn(nativePnpm ? pnpmPath : process.execPath,
      nativePnpm ? ['dev'] : [pnpmPath, 'dev'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
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
    assert(await evaluate(`![...document.querySelectorAll('.bot-view-tabs button')].some(button => /待你决定|预算|额度/.test(button.innerText))`), 'retired navigation absent');
    await send('委托自动恢复验收');
    await until(() => evaluate('window.api.botWork.listWorks(true).then(works => works.some(work => work.executions.some(execution => execution.status === "failed") && work.executions.some(execution => execution.status === "completed")))'), 'real failed native execution and successful automatic continuation');
    const recovered = (await evaluate('window.api.botWork.listWorks(true)'))[0];
    report.recovered = recovered;
    const original = recovered.executions.find(execution => execution.status === 'failed');
    const retainedPath = path.join(original.workspaceBinding, 'retained-report.md');
    assert(original.workspaceBinding.startsWith(home + path.sep), 'native writes stay in isolated test HOME');
    assert.equal(fs.readFileSync(retainedPath, 'utf8'), '已保留的原始报告：fixture 来源 A。\n');
    assert(recovered.deliverables.some(result => result.artifactRefs.includes(retainedPath)), 'failed root artifact retained in authoritative projection');
    assert(recovered.executions.every(execution => execution.workspaceBinding === original.workspaceBinding), 'continuation uses original workspace');
    assert.equal(requests.flatMap(body => body.messages).filter(message => message.role === 'assistant' && message.tool_calls?.some(call => call.function.name === 'write')).length, 1, 'original file write not replayed');
    report.retainedPath = retainedPath;
    assert(recovered.phase3.continuations.some(plan => plan.planId.startsWith('automatic-recovery:')), 'host created recovery plan');
    assert(recovered.deliverables.some(result => result.summary.includes('自动恢复验收成果')), 'recovery output retained');
    assert(requests.some(body => JSON.stringify(body.messages).includes('这是原事项的定向恢复')), 'native model receives targeted recovery instructions');
    await until(() => evaluate('document.querySelector(".bot-thread").innerText.includes("自动恢复验收成果：")'), 'automatic recovery feedback visible');
    report.checks.push('real composer send, native provider HTTP 400 failure, host automatic continuation, successful native result and conversation feedback');
    await evaluate(`document.querySelector('.bot-message-work-links button').click()`);
    await until(() => evaluate('Boolean(document.querySelector(".bot-inspector[open]"))'), 'Work detail opens');
    await until(() => evaluate('document.querySelector(".bot-inspector").innerText.includes("自动恢复验收成果")'), 'retained result accessible');
    assert(await evaluate(`!document.querySelector('.budget-reconciliation') && !document.querySelector('[aria-label="预算上限"]') && !/待你决定/.test(document.querySelector('.bot-inspector').innerText)`), 'budget and decision controls absent');
    const input = '[aria-label="协作问题"]';
    await evaluate(`document.querySelector(${JSON.stringify(input)}).closest('details')?.setAttribute('open', ''); document.querySelector(${JSON.stringify(input)}).focus()`);
    await rpc('Input.insertText', { text: '验收问题：这份成果的来源是什么？' });
    await evaluate(`[...document.querySelectorAll('.bot-inspector button')].find(button => button.innerText === '保存问题').click()`);
    await until(() => evaluate(`window.api.botWork.getWork(${JSON.stringify(recovered.workId)}).then(work => work.phase3.collaborationMessages.some(message => message.body === '验收问题：这份成果的来源是什么？'))`), 'real collaboration question persisted');
    report.checks.push('retained output accessible in details; real question authored through input and saved by IPC; no retired navigation, budget controls');
    const shot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, 'recovery-details.png'), Buffer.from(shot.data, 'base64'));
    await evaluate(`document.querySelector('[aria-label="关闭详情"]').click()`);
    await evaluate(`const thread = document.querySelector('.bot-thread'); thread.scrollTop = thread.scrollHeight`);
    await wait(200);
    const conversation = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, 'recovery-conversation.png'), Buffer.from(conversation.data, 'base64'));
    report.finalProjection = await evaluate(`window.api.botWork.getWork(${JSON.stringify(recovered.workId)})`);
    report.providerRequests = requests.length; report.status = 'passed';
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
    console.log(`Automatic recovery pnpm dev UI: ${report.status}; ${path.join(out, 'report.json')}`);
  }
})();
