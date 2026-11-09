/** Actual pnpm dev -> Electron -> preload -> Bot page -> real online model, isolated HOME. No build/pack. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const memoryScenario = process.argv.includes('--memory');
const windows = process.platform === 'win32';
const selectedModel = process.env.BOT_FRONTDOOR_MODEL || 'opendesign/deepseek-v4.1-flash';
const modelKey = `fixture/${selectedModel}`;
const headless = process.env.BOT_WORK_DEV_HEADLESS === '1';
const watchScenario = process.argv.includes('--watch');
if (headless && process.platform !== 'linux') throw Error('Headless dev page validation requires Linux; it does not validate desktop input.');
const out = path.join(root, memoryScenario ? 'out/diagnostics/bot-memory/live' : watchScenario ? 'out/diagnostics/bot-watch/live' : 'out/diagnostics/bot-frontdoor/live'); fs.mkdirSync(out, { recursive: true });
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
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
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
    requests.push(JSON.parse(raw));
    const response=await fetch((process.env.BOT_FRONTDOOR_BASE_URL || 'http://127.0.0.1:3425/v1')+'/chat/completions', {
      method:'POST',headers:{'content-type':'application/json'},body:raw});
    res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'text/event-stream'});
    for await(const chunk of response.body) res.write(chunk);
    res.end();
  } catch(error) { res.writeHead(502);res.end(String(error)); }
});
async function send(text) {
  await evaluate('document.querySelector("#bot-draft").focus()');
  await rpc('Input.insertText', { text });
  await until(() => evaluate(`document.querySelector('#bot-draft').value === ${JSON.stringify(text)}`), 'composer text');
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
      memoryEnabled: memoryScenario, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light', permissionMode: 'readonly' }));
    const launch = async () => {
    const port = await freePort();
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), REMOTE_DEBUGGING_PORT: String(port),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
      ELECTRON_CLI_ARGS: JSON.stringify(['--remote-debugging-address=127.0.0.1', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--enable-logging=stderr',
        ...(headless ? ['--ozone-platform=headless', '--disable-gpu'] : [])]) };
    delete env.ELECTRON_RUN_AS_NODE;
    assert(process.env.npm_execpath && fs.existsSync(process.env.npm_execpath), 'launch through pnpm test script');
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
    const botId = 'bot-mybuddy-default';
    const history = () => evaluate(`window.api.botWork.history({botId:'${botId}'})`);
    const foregroundDone = async before => until(async () => (await history()).messages.filter(m => m.role==='assistant' && m.status==='completed').length > before, 'foreground completed');
    if (memoryScenario) {
      await send('请记住：我的常用测试代号是云杉7842，以后默认用简短中文回复。');
      await foregroundDone(0);
      await until(async () => {
        const atoms = await evaluate(`window.api.memory.list({scopeType:'bot',scopeId:'${botId}',status:'active'})`);
        return atoms.some(atom => JSON.stringify(atom).includes('云杉7842'));
      }, 'completed natural Bot turn becomes private L1 without approval');
      report.memories = await evaluate(`window.api.memory.list({scopeType:'bot',scopeId:'${botId}',status:'active'})`);
      report.turns = await evaluate('window.api.memory.turns({limit:100})');
      assert(report.turns.every(turn => turn.userText === '' && turn.assistantText === ''), 'L0 source pointers do not duplicate conversation text');
      const newChat = async () => {
        await evaluate('document.querySelector(".bot-new-conversation").click()');
        await until(() => evaluate('[...document.querySelectorAll("button")].some(button => button.textContent === "归档并开始新对话")'), 'new conversation confirmation');
        await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "归档并开始新对话").click()');
        await until(async () => (await history()).messages.length === 0, 'blank new conversation');
      };
      const oldConversation = (await history()).conversationId;
      if(electronWatch) { clearInterval(electronWatch); electronWatch=undefined; }
      try { await rpc('Browser.close'); } catch {} socket.close(); socket=undefined;
      await stopTestElectronMains();
      if(processDev.exitCode===null) processDev.kill('SIGTERM');
      await launch();
      await until(()=>evaluate('Boolean(window.api?.botWork?.history)'), 'memory persisted after actual Electron restart');
      if(!await evaluate('Boolean(document.querySelector("#bot-draft"))')) {
        await evaluate('document.querySelector(".sidebar-user-main").click()');
        await until(() => evaluate('[...document.querySelectorAll("button")].some(button => button.textContent.includes("Bot 模式"))'), 'account navigation after restart');
        await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("Bot 模式")).click()');
      }
      await until(()=>evaluate('Boolean(document.querySelector("#bot-draft"))'), 'Bot UI after memory restart');
      await newChat();
      await send('我的常用测试代号是什么？');
      await foregroundDone(0);
      report.recalledHistory = await history();
      assert.notEqual(report.recalledHistory.conversationId, oldConversation);
      assert(report.recalledHistory.messages.some(message => message.role === 'assistant' && message.text.includes('云杉7842')), 'real model recalls learned fact in fresh chat');
      report.checks.push('real UI + real model: stable user fact automatically learned without approval and recalled in a new chat after actual Electron restart');
      await evaluate(`window.api.memory.forget(${JSON.stringify(report.memories.map(atom => atom.id))})`);
      await newChat();
      const before = requests.length;
      await send('我的常用测试代号是什么？没有记录就直说不知道。');
      await foregroundDone(0);
      report.afterDeletion = await history();
      assert(!JSON.stringify(requests.slice(before)).includes('云杉7842'), 'deleted memory is absent from fresh provider requests');
      assert(!report.afterDeletion.messages.some(message => message.role === 'assistant' && message.text.includes('云杉7842')));
      assert.equal((await evaluate('window.api.botWork.listWorks(true)')).length, 0);
      report.checks.push('existing memory deletion removes provider evidence and real model recall, with no Work created');
    } else if (watchScenario) {
      const works = () => evaluate('window.api.botWork.listWorks(true)');
      const detail = id => evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
      let before = 0;
      await send('请创建一个持续跟踪事项：每小时整点按 Asia/Shanghai 时区只读检查这项委托的进展，报告本次检查时间和“追踪验收正在进行”。不要修改文件或执行外部操作；现在不用检查。');
      await foregroundDone(before);
      let current = await works(); assert.equal(current.length, 1);
      let work = await detail(current[0].workId);
      const workId = work.workId;
      assert.equal(work.mode, 'watch'); assert.equal(work.executions.length, 0);
      let sub = work.phase4.subscriptions.find(item => item.status !== 'stopped');
      assert(sub?.nextWakeAt > Date.now()); assert.equal(sub.timezone, 'Asia/Shanghai');
      report.checks.push('real natural-language UI request -> persisted watch, timezone, no early execution');
      before=(await history()).messages.filter(m=>m.role==='assistant'&&m.status==='completed').length;
      await send(`把 ${workId} 的检查频率改为每天上海时间上午9点，仍然不要现在执行。`);
      await foregroundDone(before);
      work=await detail(workId); sub=work.phase4.subscriptions.find(item=>item.status!=='stopped');
      assert.match(sub.cronExpression, /^(?:0 )?0 9 \* \* \*$/); assert.equal(sub.timezone, 'Asia/Shanghai');
      assert.equal(work.executions.length, 0);
      for (const [command, state] of [['暂停', 'paused'], ['恢复', 'active']]) {
        before=(await history()).messages.filter(m=>m.role==='assistant'&&m.status==='completed').length;
        await send(`${command} ${workId} 的持续跟踪。`); await foregroundDone(before);
        assert.equal((await detail(workId)).lifecycle, state);
      }
      report.checks.push('model queries current guard before timing change, pause and resume');
      const dueAt=Date.now()+120000;
      before=(await history()).messages.filter(m=>m.role==='assistant'&&m.status==='completed').length;
      await send(`将 ${workId} 改成一次性只读跟进，替换原来的每日重复安排。准确检查时间为 ${new Date(dueAt).toISOString()}（UTC），只有这一次，不要现在执行。`);
      await foregroundDone(before);
      work=await detail(workId); sub=work.phase4.subscriptions.find(item=>item.status!=='stopped');
      assert.equal(sub.cronExpression, undefined); assert(Math.abs(sub.nextWakeAt-dueAt)<1000);
      assert.equal(work.executions.length, 0);
      // Restart the actual isolated pnpm dev process before the due slot. Never
      // terminate the user's dev instance, GPU, renderer or production profile.
      assert(Date.now()<dueAt, 'schedule must still be in the future before process restart');
      if(electronWatch) { clearInterval(electronWatch); electronWatch=undefined; }
      try { await rpc('Browser.close'); } catch {} socket.close(); socket=undefined;
      await stopTestElectronMains();
      if(processDev.exitCode===null) processDev.kill('SIGTERM');
      await launch();
      await until(()=>evaluate('Boolean(window.api?.botWork?.getWork)'), 'reopened preload');
      work=await detail(workId); sub=work.phase4.subscriptions.find(item=>item.status!=='stopped');
      assert(Math.abs(sub.nextWakeAt-dueAt)<1000);
      await until(async()=>{
        const value=await detail(workId);
        const check=value.executions.find(item=>item.inboxEventId);
        if(check?.status==='failed') throw Error('scheduled native execution failed: '+JSON.stringify(check));
        return check?.status==='completed';
      }, 'real due tick -> background model -> completed report after process restart');
      work=await detail(workId);
      assert.equal(work.executions.length, 1);
      assert.deepEqual(work.executions[0].delegatedScope, ['workspace:read']);
      await wait(6000); assert.equal((await detail(workId)).executions.length, 1);
      assert.equal((await detail(workId)).phase4.subscriptions.find(item=>item.status!=='stopped').nextWakeAt, undefined);
      report.checks.push('actual Electron main restart retains next wake; real scheduler dispatches exactly one read-only native model execution');
      // Return to the same Bot UI after restart before sending explicit stop.
      if(!await evaluate('Boolean(document.querySelector("#bot-draft"))')) {
        await evaluate('document.querySelector(".sidebar-user-main").click()');
        await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("Bot 模式")).click()');
      }
      await until(()=>evaluate('Boolean(document.querySelector("#bot-draft"))'), 'Bot UI after restart');
      before=(await history()).messages.filter(m=>m.role==='assistant'&&m.status==='completed').length;
      await send(`取消 ${workId}，停止这项持续跟踪。`); await foregroundDone(before);
      work=await detail(workId); assert(['closing','closed'].includes(work.lifecycle));
      report.finalWork=work; report.history=await history();
      const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(out,'watch.png'),Buffer.from(shot.data,'base64'));
      report.checks.push('explicit natural-language stop prevents further checks');
    } else {
    await send('今天杭州天气怎么样');
    await foregroundDone(0);
    report.weatherHistory=await history();
    report.weatherWorks=await evaluate('window.api.botWork.listWorks(true)');
    assert.equal(report.weatherWorks.length,0,'daily weather query must not create Work');
    const calls=()=>requests.flatMap(r=>r.messages.flatMap(m=>m.tool_calls||[])).map(t=>t.function.name);
    assert(calls().includes('web_search'),'actual online model calls real frontend search');
    assert(!calls().includes('work_create'));
    report.toolResults=requests.flatMap(r=>r.messages.filter(m=>m.role==='tool'));
    report.checks.push('real UI natural weather request -> real web_search -> answer with 0 Work');
    let before=(await history()).messages.filter(m=>m.role==='assistant'&&m.status==='completed').length;
    await send('这他妈的能用？我就问个天气');
    await foregroundDone(before);
    report.afterCriticism=await history();
    assert(!calls().includes('work_cancel'),'criticism must not cancel');
    assert.equal((await evaluate('window.api.botWork.listWorks(true)')).length,0);
    before=(await history()).messages.filter(m=>m.role==='assistant'&&m.status==='completed').length;
    await send('不用查了，停止查询');
    await foregroundDone(before);
    report.cancelHistory=await history();
    report.finalWorks=await evaluate('window.api.botWork.listWorks(true)');
    assert.equal(report.finalWorks.length,0);
    // New requests contain prior calls, so inspect only tools after the final user input.
    for(const request of requests.filter(r=>JSON.stringify(r.messages[r.messages.findLastIndex(m=>m.role==='user')]?.content).includes('不用查了'))) {
      const last=request.messages.findLastIndex(m=>m.role==='user');
      assert(!request.messages.slice(last+1).flatMap(m=>m.tool_calls||[]).some(t=>['web_search','fetch_content','work_create'].includes(t.function.name)),'explicit stop must not restart research');
    }
    report.checks.push('criticism does not cancel; explicit stop does not restart query; no Work created');
    }
    const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,memoryScenario?'memory.png':watchScenario?'watch.png':'weather.png'),Buffer.from(shot.data,'base64'));
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
    if (log !== undefined) fs.closeSync(log); await new Promise(resolve=>provider.close(resolve));
    console.log(`Bot frontdoor pnpm dev UI: ${report.status}; ${path.join(out, 'report.json')}`);
  }
})();
