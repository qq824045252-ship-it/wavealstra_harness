/** Actual pnpm dev -> Electron -> preload -> Bot page -> real online model, isolated HOME. No build/pack. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const teamWorkspaceScenario = true;
if (process.platform !== 'linux') throw Error('This isolated desktop acceptance runs on Omarchy/Linux only.');
const selectedModel = process.env.BOT_FRONTDOOR_MODEL || 'opendesign/deepseek-v4.1-flash';
const modelKey = `fixture/${selectedModel}`;
const headless = process.env.BOT_WORK_DEV_HEADLESS === '1';
const out = path.join(root,'out/diagnostics/bot-goal-outcome/live'); fs.mkdirSync(out,{recursive:true});
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
    let botId = 'bot-mybuddy-default', teamId;
    const history = () => evaluate(`window.api.botWork.history(${JSON.stringify({botId,teamId})})`);
    const foregroundDone = async _before => {
      const requestId=(await history()).messages.filter(m=>m.role==='user').at(-1)?.requestId;
      assert(requestId, 'accepted user request identity');
      await until(async () => (await history()).messages.some(m=>m.role==='assistant'&&m.requestId===requestId&&m.status==='completed'), 'matching foreground request completed');
    };
    if (teamWorkspaceScenario) {
      const member = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'验收成员',responsibilitySummary:'只读核验并按事实汇报'})`);
      assert(member.ok, JSON.stringify(member));
      await until(()=>evaluate(`document.querySelectorAll('.sidebar-bot-identity').length >= 2`), 'new member appears in sidebar');
      await send('个人会话标记 PERSONAL-UNCHANGED，只回复收到。'); await foregroundDone(0);
      const personalBefore = await history();
      const createTeam = async name => {
        await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='新建团队').click()`);
        await until(()=>evaluate(`!!document.querySelector('dialog[open] input[maxlength="120"]')`),'new team form');
        await evaluate(`document.querySelector('dialog[open] input[maxlength="120"]').focus()`); await rpc('Input.insertText',{text:name});
        await evaluate(`document.querySelector('dialog[open] input[type=checkbox]').click()`);
        await evaluate(`document.querySelector('dialog[open] input[placeholder="这个成员负责什么"]').focus()`);
        await rpc('Input.insertText',{text:'检查用户给出的加法函数，列出缺陷及具体输入输出证据，只出报告不修代码'});
        await evaluate(`document.querySelector('dialog[open] button[type=submit]').click()`);
        await until(()=>evaluate(`document.querySelector('.bot-heading h1')?.textContent===${JSON.stringify(name)} && !document.querySelector('dialog[open]')`),'creation opens full team page');
        const list=await evaluate(`window.api.botWork.teamControl({kind:'list_templates'})`);
        return list.templates.find(t=>t.name===name).templateId;
      };
      teamId=await createTeam('真实团队 A');
      assert.equal((await history()).messages.length,0,'new team does not copy leader personal chat');
      assert.equal(await evaluate("document.querySelector('.bot-new-conversation').disabled"),false,'empty team new conversation is usable');
      await evaluate("document.querySelector('.bot-new-conversation').click()");
      await until(()=>evaluate("document.activeElement?.tagName === 'TEXTAREA'"),'empty team new conversation focuses composer');
      assert(!await evaluate("!!document.querySelector('dialog[open]')"),'empty context needs no archive ceremony');
      await send('请立即交给本团队一次性后台任务：只审查这段代码并列出bug，不需要修改代码：function add(a,b){ return a-b; }。要求列出1个具体错误输入输出例子，如123与456，写出实际输出和应有输出。报告发现bug即完成委托，不需要项目无bug。不要联网，不写文件。');
      await send('独立插话：17+8，只答数字，不创建任务。');
      await until(()=>evaluate("!!document.querySelector('.bot-message-work-links button')"),'actual Work link appears');
      await evaluate("document.querySelector('.bot-message-work-links button').click()");
      await until(()=>evaluate("!!document.querySelector('.bot-work-details')"),'actual running Work details');
      assert(!await evaluate("[...document.querySelectorAll('.bot-work-details button')].some(b=>/采纳成果|拒绝成果|确认结束/.test(b.textContent))"),'no acceptance ceremony in actual UI');
      const detailShot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(out,'automatic-review-details.png'),Buffer.from(detailShot.data,'base64'));
      await evaluate("document.querySelector('.bot-work-conversation-breadcrumb button').click()");

      await until(async()=> (await history()).messages.some(m=>m.role==='assistant'&&m.status==='completed'&&/25/.test(m.text)), 'team concurrent arithmetic');
      await until(async()=> { const list=await evaluate('window.api.botWork.listWorks(true)'); const h=await history(); if (!list.length && h.messages.filter(m=>m.role==='assistant'&&!m.workFeedback).length>=2 && h.messages.filter(m=>m.role==='assistant'&&!m.workFeedback).every(m=>['completed','failed'].includes(m.status))) throw Error('Team delegation produced no Work: '+h.messages.filter(m=>m.role==='assistant').map(m=>m.text).join(' | ')); return list.some(w=>w.team?.teamId===teamId&&w.lifecycle==='closed'); }, 'team real Work auto finishes');
      const works=await evaluate('window.api.botWork.listWorks(true)');
      assert.equal(works.length,1); assert.equal(works[0].team.teamId,teamId); assert.equal(works[0].closureConclusion,'succeeded',JSON.stringify(works[0]));
      await until(async()=> (await history()).messages.some(m=>m.workFeedback?.kind==='result'&&/579/.test(m.text)), 'result delivered to team conversation');
      // A real model-created Work opens in the conversation viewport, then returns
      // to its originating team rather than a sidebar overlay or personal Bot.
      await until(()=>evaluate(`!!document.querySelector('.bot-message-work-links button')`),'real Work link');
      await evaluate(`document.querySelector('.bot-message-work-links button').click()`);
      await until(()=>evaluate(`!!document.querySelector('.bot-work-conversation-detail')`),'inline Work details');
      assert(await evaluate(`document.querySelector('.bot-thread').hidden`));
      assert(!await evaluate(`!!document.querySelector('.bot-inspector[open]')`));
      assert(await evaluate(`document.querySelector('.bot-work-conversation-body').innerText.includes('579')`),'real result is readable in details');
      const inlineDetailShot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(out,'team-inline-detail.png'),Buffer.from(inlineDetailShot.data,'base64'));
      await evaluate(`document.querySelector('.bot-work-conversation-breadcrumb button').click()`);
      await until(()=>evaluate(`!document.querySelector('.bot-work-conversation-detail') && !document.querySelector('.bot-thread').hidden`),'back to originating team');
      assert(await evaluate(`document.querySelector('.bot-heading h1').textContent==='真实团队 A'`));
      report.checks.push('Real model Work result -> full-width inline detail -> originating team conversation');
      const teamA=teamId; report.teamAHistory=await history(); report.works=works; assert(requests.some(request=>request.messages.some(message=>JSON.stringify(message.content).includes('个人助理的结果处理回合'))),'real team goal review must run');
      await until(()=>evaluate(`document.body.innerText.includes('579')`),'team result is visible');
      const image=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}); fs.writeFileSync(path.join(out,'team-result.png'),Buffer.from(image.data,'base64'));
      await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(b=>b.textContent.includes('MyBuddy')).click()`);
      teamId=undefined;
      await until(()=>evaluate(`document.querySelector('.bot-heading h1')?.textContent==='MyBuddy'`),'leader personal page');
      assert.deepEqual((await history()).messages.map(m=>m.messageId),personalBefore.messages.map(m=>m.messageId));
      assert(!await evaluate(`document.querySelector('.bot-thread').innerText.includes('579')`),'team result absent from personal chat');
      teamId=await createTeam('真实团队 B'); assert.equal((await history()).messages.length,0);
      await send('只回复 TEAM-B-ONLY'); await foregroundDone(0);
      assert(!await evaluate(`document.querySelector('.bot-thread').innerText.includes('579')`));
      await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(b=>b.textContent.includes('真实团队 A')).click()`); teamId=teamA;
      await until(()=>evaluate(`document.querySelector('.bot-thread').innerText.includes('579')`),'return restores team A conversation');
      await evaluate(`document.querySelector('[aria-label="团队设置与管理"]').click()`);
      await until(()=>evaluate(`!!document.querySelector('form[aria-label="团队设置"]')`),'team-specific settings reachable');
      const customWorkspace = path.join(home, 'custom-team-folder'); fs.mkdirSync(customWorkspace);
      await evaluate(`document.querySelector('form[aria-label="团队设置"] input[placeholder="留空使用团队自己的默认文件夹"]').focus()`);
      await rpc('Input.insertText', {text:customWorkspace});
      await evaluate(`document.querySelector('form[aria-label="团队设置"] button[type=submit]').click()`);
      await until(()=>evaluate(`!document.querySelector('dialog[open]')`),'team folder setting saved');
      const savedTeam=(await evaluate(`window.api.botWork.teamControl({kind:'list_templates'})`)).templates.find(t=>t.templateId===teamId);
      assert.equal(savedTeam.workspacePath,customWorkspace);
      const oldWork=await evaluate(`window.api.botWork.getWork(${JSON.stringify(works[0].workId)})`);
      assert.equal(oldWork.workspacePath,works[0].workspacePath,'changing team folder does not migrate prior Work');
      await evaluate(`document.querySelector('[aria-label="团队设置与管理"]').click()`);
      await until(()=>evaluate(`document.querySelector('form[aria-label="团队设置"] input[placeholder="留空使用团队自己的默认文件夹"]').value===${JSON.stringify(customWorkspace)}`),'saved folder visible on reopen');
      report.checks.push('empty team New Conversation focuses composer; actual model/team audit reports add defect (-333 versus 579); independent goal review closes succeeded; concurrent reply 25; personal and second team isolation; settings roundtrip');
    }
    const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(out,'team-workspace.png'),Buffer.from(shot.data,'base64'));
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
