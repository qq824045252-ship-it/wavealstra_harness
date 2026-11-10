/** Actual pnpm dev -> Electron -> preload -> Bot page -> real online model, isolated HOME. No build/pack. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const displayGroupsScenario = process.argv.includes('--display-groups');
const workspaceNavigationScenario = process.argv.includes('--workspace-navigation');
const composerScenario = process.argv.includes('--composer');
const searchScenario = process.argv.includes('--search');
const teamWorkspaceScenario = process.argv.includes('--team-workspace');
const teamTransientFailure = process.argv.includes('--team-transient-failure');
const teamTransportFailure = process.argv.includes('--team-transport-failure') || teamTransientFailure;
const teamFailureScenario = process.argv.includes('--team-failure') || teamTransportFailure;
const teamDefaultWorkspaceScenario = process.argv.includes('--team-default-workspace');
const teamFreeScenario = process.argv.includes('--team-free');
const structuredReportScenario = process.argv.includes('--structured-report');
const teamPlanningScenario = process.argv.includes('--team-planning') || teamFreeScenario;
const teamScenario = process.argv.includes('--team') || teamFailureScenario || teamPlanningScenario;
const concurrentScenario = process.argv.includes('--concurrent');
const completionScenario = process.argv.includes('--completion');
const cacheScenario = process.argv.includes('--cache');
const memoryScenario = process.argv.includes('--memory');
const windows = process.platform === 'win32';
const selectedModel = process.env.BOT_FRONTDOOR_MODEL || 'opendesign/deepseek-v4.1-flash';
const modelKey = `fixture/${selectedModel}`;
const headless = process.env.BOT_WORK_DEV_HEADLESS === '1';
const trackingScenario = process.argv.includes('--tracking');
const watchScenario = process.argv.includes('--watch');
const watchIntentScenario = process.argv.includes('--watch-intent');
if (headless && process.platform !== 'linux') throw Error('Headless dev page validation requires Linux; it does not validate desktop input.');
const out = path.join(root, teamDefaultWorkspaceScenario ? 'out/diagnostics/bot-team-default-workspace/live' : watchIntentScenario ? 'out/diagnostics/bot-watch-intent/live' : displayGroupsScenario ? 'out/diagnostics/bot-display-groups/live' : composerScenario ? 'out/diagnostics/bot-composer/live' : workspaceNavigationScenario ? 'out/diagnostics/bot-workspace-navigation/live' : searchScenario ? 'out/diagnostics/bot-search/live' : teamWorkspaceScenario ? 'out/diagnostics/bot-team-workspace/live' : concurrentScenario ? 'out/diagnostics/bot-concurrent/live' : completionScenario ? 'out/diagnostics/bot-completion/live' : trackingScenario ? 'out/diagnostics/bot-tracking/live' : teamTransientFailure ? 'out/diagnostics/bot-team-transient-failure/live' : teamTransportFailure ? 'out/diagnostics/bot-team-transport-failure/live' : teamFailureScenario ? 'out/diagnostics/bot-team-failure/live' : teamFreeScenario ? 'out/diagnostics/bot-team-free/live' : teamPlanningScenario ? 'out/diagnostics/bot-team-planning/live' : teamScenario ? 'out/diagnostics/bot-team-frontdoor/live' : cacheScenario ? 'out/diagnostics/bot-cache/live' : memoryScenario ? 'out/diagnostics/bot-memory/live' : watchScenario ? 'out/diagnostics/bot-watch/live' : 'out/diagnostics/bot-frontdoor/live'); fs.mkdirSync(out, { recursive: true });
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
    const lastUser = [...body.messages].reverse().find(message => message.role === 'user');
    const currentText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
    if (concurrentScenario && currentText?.includes('CONCURRENT_FAIL')) {
      res.writeHead(503, {'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'Controlled transport failure for one foreground request',type:'service_unavailable'}})); return;
    }
    if (teamTransportFailure && body.model === 'controlled-unavailable' && (!teamTransientFailure || requests.filter(r=>r.model==='controlled-unavailable').length<=4)) {
      res.writeHead(503, {'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'Controlled ordinary unavailable provider; no execution or process crash',type:'service_unavailable'}})); return;
    }
    const response=await fetch((process.env.BOT_FRONTDOOR_BASE_URL || 'http://127.0.0.1:3425/v1')+'/chat/completions', {
      method:'POST',headers:{'content-type':'application/json'},body:teamTransientFailure&&body.model==='controlled-unavailable'?JSON.stringify({...body,model:selectedModel}):raw});
    if (concurrentScenario && currentText?.includes('CONCURRENT_SLOW')) await wait(40000);
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
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [model, ...(teamTransportFailure?[{...model,id:'controlled-unavailable',name:'Controlled unavailable member'}]:[])] } } }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: selectedModel, enabledModels: [modelKey, ...(teamTransportFailure?['fixture/controlled-unavailable']:[])],
      memoryEnabled: memoryScenario, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light', permissionMode: 'readonly' }));
    if (searchScenario) {
      const searchPath = process.env.BOT_SEARCH_CONFIG_PATH || path.join(os.homedir(), '.mybuddy/web-search.json');
      const liveSearch = fs.existsSync(searchPath) ? JSON.parse(fs.readFileSync(searchPath, 'utf8')) : {};
      report.searchConfigAvailable = fs.existsSync(searchPath);
      const providers = ['tavily', 'serper'];
      fs.writeFileSync(path.join(agentDir, 'web-search.json'), JSON.stringify({
        tavilyApiKey: liveSearch.tavilyApiKey, serperApiKey: liveSearch.serperApiKey,
        apiKeyPools: Object.fromEntries(providers.filter(p => liveSearch.apiKeyPools?.[p]).map(p => [p, liveSearch.apiKeyPools[p]])),
        workflow: 'none', searchPolicy: { mode: 'parallel', providers, providerTimeoutMs: 30000, totalTimeoutMs: 60000, maxRequests: 2, verifySources: true }
      }), { mode: 0o600 });
    }
    if (composerScenario) {
      const mcpDir=path.join(agentDir,'plugins/mcp');fs.mkdirSync(mcpDir,{recursive:true});
      fs.writeFileSync(path.join(mcpDir,'mcp.json'),JSON.stringify({mcpServers:{'composer-probe':{command:process.execPath,args:[path.join(root,'scripts/durable-mcp-lazy-fixture.mjs'),path.join(out,'mcp-audit.jsonl')],enabled:true}}}));
      const skill=path.join(agentDir,'plugins/skills/composer-probe');fs.mkdirSync(skill,{recursive:true});
      fs.writeFileSync(path.join(skill,'SKILL.md'),'---\nname: composer-probe\ndescription: Verify the current composer skill is actually loaded.\n---\nThe verification marker is COMPOSER_SKILL_20261110. Include this marker only after reading this file.\n');
    }
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
    let botId = 'bot-mybuddy-default', teamId;
    const history = () => evaluate(`window.api.botWork.history(${JSON.stringify({botId,teamId})})`);
    const foregroundDone = async _before => {
      const requestId=(await history()).messages.filter(m=>m.role==='user').at(-1)?.requestId;
      assert(requestId, 'accepted user request identity');
      await until(async () => (await history()).messages.some(m=>m.role==='assistant'&&m.requestId===requestId&&m.status==='completed'), 'matching foreground request completed');
    };
    if (displayGroupsScenario) {
      const click=async text=>evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
      await click('＋ 创建分组');
      await until(()=>evaluate('document.querySelector(".bot-display-dialog").open'),'group dialog');
      await evaluate(`(()=>{const e=document.querySelector('.bot-display-dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'验收分组');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await click('保存');
      await until(()=>evaluate('document.querySelectorAll(".bot-display-group").length===2'),'created group');
      await evaluate(`document.querySelector('.bot-display-row .bot-display-actions>button').click()`);
      await click('验收分组');
      const snapshot=await evaluate(`window.api.botWork.displayGroups({kind:'list'})`);
      assert.equal(snapshot.membership[botId],snapshot.groups[0].id);
      await evaluate('window.__groupsReloadMarker = true');
      await rpc('Page.reload');
      await until(()=>evaluate('window.__groupsReloadMarker !== true && document.readyState === "complete"'),'new document loaded');
      await until(()=>evaluate('document.querySelector(".bot-display-group:first-of-type .bot-display-row")?.textContent.includes("MyBuddy")'),'persistent group after reload');
      await evaluate(`document.querySelector('[aria-label="管理分组 验收分组"]').click()`);
      await click('删除分组');
      await until(()=>evaluate('document.querySelectorAll(".bot-display-group").length===1'),'deleted group');
      assert.equal((await evaluate('window.api.botWork.listBots()')).length,1);
      assert.equal((await evaluate(`window.api.botWork.displayGroups({kind:'list'})`)).groups.length,0);
      report.checks.push('actual pnpm dev + preload IPC + SQLite: create, move, reload, delete group, Bot survives');
    } else if (workspaceNavigationScenario) {
      await send('空间导航测试：计算17+8，只回复数字，不使用工具不创建后台事项。'); await foregroundDone(0);
      const first = await history(); assert(first.messages.some(m=>m.role==='assistant' && /25/.test(m.text)));
      await evaluate(`window.api.botWork.archiveConversation(${JSON.stringify(botId)},${JSON.stringify(first.conversationId)})`);
      // Send through the normal product UI after starting a fresh conversation.
      await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(b=>b.textContent.includes('MyBuddy')).click()`);
      await wait(1500);
      await send('空间导航第二条：计算23+19，只回复数字，不创建后台事项。'); await foregroundDone(0);
      const second = await history(); assert.notEqual(first.conversationId, second.conversationId);
      const member = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'空间成员',responsibilitySummary:'核验任务'})`); assert(member.ok);
      await until(()=>evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].some(b=>b.textContent.includes('空间成员'))`),'second bot appears');
      await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(b=>b.textContent.includes('空间成员')).click()`);
      botId=member.bot.botId;
      await until(()=>evaluate(`document.querySelector('.bot-heading h1')?.textContent==='空间成员'`),'second bot page');
      await send('独立Bot任务：计算31+6，只回复数字，不创建后台事项。'); await foregroundDone(0);
      botId='bot-mybuddy-default';
      const saved = await evaluate(`window.api.botWork.teamControl({kind:'save_template',request:{operationId:crypto.randomUUID(),name:'空间团队',plan:{ownerBotId:${JSON.stringify(botId)},ownerResponsibility:'汇总',members:[{botId:${JSON.stringify(member.bot.botId)},responsibility:'核对',delegatedScope:['workspace:read']}],executionPolicy:'parallel',maxConcurrency:1}}})`);
      assert(saved.ok,JSON.stringify(saved));
      await evaluate(`window.dispatchEvent(new Event('mybuddy:teams-refresh'))`);
      await until(()=>evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].some(b=>b.textContent.includes('空间团队'))`),'team navigation appears');
      await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(b=>b.textContent.includes('空间团队')).click()`);
      teamId=(await evaluate(`window.api.botWork.teamControl({kind:'list_templates'})`)).templates.find(t=>t.name==='空间团队').templateId;
      await until(()=>evaluate(`document.querySelector('.bot-heading h1')?.textContent==='空间团队'`),'team workspace');
      await send('团队空间任务：计算7+8，只回复数字，不创建后台事项。'); await foregroundDone(0);
      const oldTeam=await history();
      await evaluate(`window.api.botWork.archiveConversation(${JSON.stringify(botId)},${JSON.stringify(oldTeam.conversationId)})`);
      await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(b=>b.textContent.includes('空间团队')).click()`);
      await wait(1500);
      await send('团队新对话任务：计算51+8，只回复数字，不创建后台事项。'); await foregroundDone(0);
      const newTeam=await history(); assert.notEqual(newTeam.conversationId,oldTeam.conversationId);
      await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='普通模式').click()`);
      const nav = await evaluate('window.api.botWork.workspaceNavigation()'); report.navigation=nav;
      assert.equal(nav.conversations.length,5,'all personal and team conversations have independent navigation identities');
      assert.equal(new Set(nav.conversations.map(c=>c.conversationId)).size,5);
      assert.equal(nav.foregroundRequests.length,5); assert.equal(nav.foregroundRequests.filter(r=>r.teamId===teamId).length,2);
      const personal=nav.foregroundRequests.filter(r=>r.botId===botId&&!r.teamId), team=nav.foregroundRequests.filter(r=>r.teamId===teamId);
      assert.equal(new Set(personal.map(r=>r.spaceId)).size,1,'new and archived personal conversations share one Bot space');
      assert.equal(new Set(team.map(r=>r.spaceId)).size,1,'new and archived team conversations share one team space');
      assert.notEqual(nav.foregroundRequests.find(r=>r.botId===member.bot.botId).spaceId,personal[0].spaceId,'different Bots never share spaces');
      assert.equal((await evaluate('window.api.db.listTasks()')).length,0,'no fake native Task from foreground requests');
      const expand = async name => { await until(()=>evaluate(`[...document.querySelectorAll('.space-header')].some(e=>e.querySelector('.space-name')?.textContent===${JSON.stringify(name)})`),'space '+name); await evaluate(`[...document.querySelectorAll('.space-header')].find(e=>e.querySelector('.space-name')?.textContent===${JSON.stringify(name)}).querySelector('.space-chevron').click()`); };
      await expand('Bot'); await expand('MyBuddy · 工作空间');
      await until(()=>evaluate(`document.querySelectorAll('.workspace-conversation-row').length===2`),'two independent personal conversation groups');
      assert.equal(await evaluate(`document.querySelectorAll('.workspace-foreground-row').length`),0,'conversation groups initially collapsed');
      await evaluate(`[...document.querySelectorAll('.workspace-conversation-row')].forEach(e=>e.click())`);
      await until(()=>evaluate(`document.querySelectorAll('.workspace-foreground-row').length===2`),'two personal foreground tasks');
      await evaluate(`[...document.querySelectorAll('.workspace-foreground-row')].find(e=>e.textContent.includes('计算17+8')).click()`);
      await until(()=>evaluate(`document.querySelector('[aria-label="前台任务对话"]')?.innerText.includes('25')`),'archived original answer reachable');
      assert(!await evaluate(`document.querySelector('[aria-label="前台任务对话"]').innerText.includes('42')`),'does not substitute current conversation');
      await evaluate(`document.querySelector('.workspace-foreground-heading button').click()`);
      await until(()=>evaluate(`document.body.innerText.includes('前台对话') && !document.querySelector('[aria-label="前台任务对话"]')`),'return to space overview');
      await evaluate(`[...document.querySelectorAll('.workspace-foreground-row')].find(e=>e.textContent.includes('计算23+19')).click()`);
      await until(()=>evaluate(`document.querySelector('[aria-label="前台任务对话"]')?.innerText.includes('42')`),'new personal conversation reply reachable');
      assert(!await evaluate(`document.querySelector('[aria-label="前台任务对话"]').innerText.includes('计算17+8')`));
      await expand('空间成员 · 工作空间');
      await evaluate(`[...document.querySelectorAll('.workspace-conversation-row')].filter(e=>e.getAttribute('aria-expanded')==='false').forEach(e=>e.click())`);
      await evaluate(`[...document.querySelectorAll('.workspace-foreground-row')].find(e=>e.textContent.includes('独立Bot任务')).click()`);
      await until(()=>evaluate(`document.querySelector('[aria-label="前台任务对话"]')?.innerText.includes('37')`),'other Bot reply isolated');
      await expand('Bot团队'); await expand('空间团队 · 工作空间');
      await evaluate(`[...document.querySelectorAll('.workspace-conversation-row')].filter(e=>e.getAttribute('aria-expanded')==='false').forEach(e=>e.click())`);
      await evaluate(`[...document.querySelectorAll('.workspace-foreground-row')].find(e=>e.textContent.includes('团队空间任务')).click()`);
      await until(()=>evaluate(`document.querySelector('[aria-label="前台任务对话"]')?.innerText.includes('15')`),'team original answer reachable');
      assert(!await evaluate(`document.querySelector('[aria-label="前台任务对话"]').innerText.includes('空间导航测试')`));
      await evaluate(`[...document.querySelectorAll('.workspace-foreground-row')].find(e=>e.textContent.includes('团队新对话任务')).click()`);
      await until(()=>evaluate(`document.querySelector('[aria-label="前台任务对话"]')?.innerText.includes('59')`),'new team conversation reply reachable');
      assert(!await evaluate(`document.querySelector('[aria-label="前台任务对话"]').innerText.includes('计算7+8')`));
      report.checks.push('five real-model requests across old/new personal and team conversations plus second Bot: one space per identity, exact replies isolated; real model personal and team requests visible under distinct space trees; archived original reply accessible; return navigation; no fake Tasks');
    } else if (composerScenario) {
      await until(()=>evaluate(`!document.querySelector('[aria-label="选择 Bot 模型"]').disabled`),'model catalog ready');
      assert.equal(await evaluate(`!!document.querySelector('[aria-label="增强提示词"]')`),false);
      await evaluate(`document.querySelector('[aria-label="选择 Bot 模型"]').click()`);
      await until(()=>evaluate(`!!document.querySelector('[aria-label="Bot 模型列表"]')`),'model menu');
      await evaluate(`[...document.querySelectorAll('[role="option"]')].find(b=>b.textContent.includes('Frontdoor live')).click()`);
      for(const category of ['技能','MCP']) {
        await evaluate(`document.querySelector('[aria-label="添加"]').click()`);
        await until(()=>evaluate(`!!document.querySelector('.add-menu')`),'add menu');
        await evaluate(`[...document.querySelectorAll('.add-menu-item')].find(b=>b.textContent.trim()===${JSON.stringify(category)}).click()`);
        await until(()=>evaluate(`[...document.querySelectorAll('.add-menu-flyout-item')].some(b=>b.textContent.includes('composer-probe'))`),'select '+category);
        await evaluate(`[...document.querySelectorAll('.add-menu-flyout-item')].find(b=>b.textContent.includes('composer-probe')).click()`);
      }
      await send('请在当前对话使用所选技能与 MCP，不创建 Work。先 read_skill 读取 composer-probe 的 SKILL.md，再 mcp_list_tools 查看 composer-probe，调用其中 read_cwd，label="composer-live"。最后用两行返回技能验证标记与工具返回的真实 cwd。不得猜测。');
      await foregroundDone(0);
      report.composerHistory=await history();
      const answer=report.composerHistory.messages.filter(m=>m.role==='assistant').at(-1);
      assert(answer.text.includes('COMPOSER_SKILL_20261110'),'selected skill content reached the real model');
      assert(fs.readFileSync(path.join(out,'mcp-audit.jsonl'),'utf8').includes('composer-live'),'real MCP stdio call occurred');
      assert.equal((await evaluate('window.api.botWork.listWorks(true)')).length,0,'selection works in foreground, not an empty button/background-only');
      await evaluate(`document.querySelector('#bot-draft').focus()`);await rpc('Input.insertText',{text:'帮我写一句邀请同事喝咖啡的话'});
      await until(()=>evaluate(`!!document.querySelector('[aria-label="增强提示词"]')`),'enhance visible only for text');
      await evaluate(`document.querySelector('[aria-label="增强提示词"]').click()`);
      await until(()=>evaluate(`!!document.querySelector('[aria-label="恢复原文"]')`),'real model enhancement applied');
      report.enhancedDraft=await evaluate(`document.querySelector('#bot-draft').value`);
      await evaluate(`document.querySelector('[aria-label="恢复原文"]').click()`);
      assert.equal(await evaluate(`document.querySelector('#bot-draft').value`),'帮我写一句邀请同事喝咖啡的话');
      report.checks.push('real dev UI selects model/skill/MCP; real model reads selected SKILL.md and calls native stdio MCP in foreground; no Work; real enhancement and undo');
    } else if (watchIntentScenario) {
      const allWorks = () => evaluate('window.api.botWork.listWorks(true)');
      const detail = id => evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
      const newChat = async () => {
        await evaluate('document.querySelector(".bot-new-conversation").click()');
        await until(() => evaluate('[...document.querySelectorAll("button")].some(button => button.textContent === "归档并开始新对话")'), 'new conversation confirmation');
        await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "归档并开始新对话").click()');
        await until(async () => (await history()).messages.length === 0 && await evaluate('!document.querySelector("dialog[open]")'), 'fresh conversation');
      };
      report.cases = [];
      const watchTarget = path.join(home, "watch-progress.txt");
      fs.writeFileSync(watchTarget, "Synthetic progress: waiting for the next test update.\n");
      const cases = [
        { label: 'contextual-ongoing-no-frequency', setup: `我想关注测试文件 ${watchTarget} 的进展，事项名称是“跟踪验收A”。文件已经存在，检查时只读这个文件并给简短进度简报，不访问网络、不修改文件。先问我只要一次快照还是持续追踪，暂时不要建单。`,
          prompt: '2，持续追踪，给我简短进度简报。', mode: 'watch', basis: 'recommended' },
        { label: 'english-explicit-cadence', prompt: `Create an ongoing monitoring assignment named English Watch: keep an eye on the existing test file ${watchTarget} at 09:00 every Monday in Asia/Shanghai. Only read its progress and report it. No external actions, and do not check immediately.`, mode: 'watch', basis: 'user_specified' },
        { label: 'historical-daily-data-once', prompt: '创建一个一次性后台委托：用一句话总结这段虚构记录：过去三天每天都完成了一项整理。只总结已有记录，不关注未来，也不设定时检查。', mode: 'once' },
        { label: 'describe-monitoring-feature-once', prompt: '创建一个一次性后台委托：用三句话说明如何实现持续追踪功能。不改代码，不监控任何真实目标，交付说明文字即可。', mode: 'once' },
        { label: 'explicit-negation-once', prompt: '不要持续跟踪，只为这一次写一句“测试说明已完成”，作为一次性后台委托处理。不要建立后续计划。', mode: 'once' },
        { label: 'one-future-observation', prompt: `请建立一个未来跟进事项，在 ${new Date(Date.now()+86400000).toISOString()} 只读检查一次现有测试文件 ${watchTarget} 的进展并报告，事项名称叫一次跟进。只检查一次，不设周期，现在不用检查。`, mode: 'watch', basis: 'user_specified', oneShot: true },
      ];
      for (const scenario of cases) {
        if (report.cases.length) await newChat();
        const old = new Set((await allWorks()).map(work => work.workId));
        const requestStart = requests.length, startedAt = Date.now();
        const item = {label:scenario.label, prompt:scenario.prompt}; report.cases.push(item);
        if (scenario.setup) { await send(scenario.setup); await foregroundDone(); assert.equal((await allWorks()).filter(work=>!old.has(work.workId)).length,0); }
        await send(scenario.prompt); await foregroundDone();
        item.initialHistory = await history();
        let created = (await allWorks()).filter(work => !old.has(work.workId));
        if (!created.length && scenario.basis === 'recommended') {
          item.askedBeforeRecommendation = true;
          await send('请按这类低频进展跟踪给出合理的默认安排并说明理由，频率之后可以更改，不需要再让我选择。现在不用检查。');
          await foregroundDone(); created = (await allWorks()).filter(work => !old.has(work.workId));
        }
        assert.equal(created.length,1, scenario.label+': exactly one accepted assignment');
        const work = await detail(created[0].workId); item.work=work; item.history=await history();
        assert.equal(work.mode,scenario.mode,scenario.label+': actual persisted mode matches goal');
        const calls = new Map();
        for(const request of requests.slice(requestStart)) for(const message of request.messages) for(const call of message.tool_calls||[])
          if(call.function.name==='work_create') calls.set(call.id,JSON.parse(call.function.arguments));
        item.createAttempts=[...calls.values()];
        assert(item.createAttempts.length, scenario.label+': real foreground tool call');
        const accepted = item.createAttempts.at(-1);
        assert.equal(accepted.requestedOutcome,scenario.mode==='watch'&&!scenario.oneShot?'ongoing':'one_time');
        if (scenario.mode==='watch') {
          assert.equal(work.watchPlan.scheduleBasis,scenario.basis);
          const active=work.phase4.subscriptions.filter(sub=>sub.status!=='stopped');
          assert.equal(active.length,1); assert(active[0].nextWakeAt>Date.now(), 'real future check persisted');
          if(scenario.oneShot) assert.equal(active[0].cronExpression,undefined); else assert(active[0].cronExpression);
          if(scenario.basis==='recommended') assert(work.watchPlan.scheduleRationale?.trim());
          assert.equal(work.executions.length,0,'future watch does not run the original work early');
          await send('停止刚才创建的跟踪，取消该事项，保留已有记录。'); await foregroundDone();
          await until(async()=>['closing','closed'].includes((await detail(work.workId)).lifecycle),'synthetic watch cancelled');
        } else {
          assert.equal(work.phase4.subscriptions.filter(sub=>sub.status!=='stopped').length,0);
          await until(async()=>{
            const value=await detail(work.workId);
            return value.executions.some(execution=>['completed','failed','stopped'].includes(execution.status));
          },'one-time text execution settles');
          item.settledWork=await detail(work.workId);
          assert(item.settledWork.executions.some(execution=>execution.status==='completed'),scenario.label+': real one-time execution completes');
        }
        item.elapsedMs=Date.now()-startedAt; item.providerRequests=requests.length-requestStart;
        console.log(JSON.stringify({label:item.label,mode:work.mode,basis:work.watchPlan?.scheduleBasis,elapsedMs:item.elapsedMs,providerRequests:item.providerRequests}));
      }
      report.checks.push('real UI and real model: contextual ongoing intent, English cadence, one-time history, feature implementation, explicit negation, and one future observation');
      report.checks.push('actual persisted mode and future wake checked; proposed cadence distinguished; no keyword classifier, additional intake model, production task edit, or crash injection');
    } else if (searchScenario) {
      report.cases = [];
      for (const [label, prompt] of [
        ['single-quick', '请只调用一次 web_search，query="Node.js fs readFile official documentation"，workflow="none"，不要抓取正文或核验，不创建 Work。用两句话及来源 URL 回答 readFile 用途，不能声称已独立核验。'],
        ['multi-quick', '请只调用一次 web_search，queries=["Node.js fs readFile official documentation","Node.js fs writeFile official documentation"]，workflow="none"，不要抓取正文或核验，不创建 Work。分两行给各自用途和 URL，覆盖不足如实说。'],
        ['single-verify', '请只调用一次 web_search，query="Node.js fs readFile official documentation"，evidenceMode="verify"，workflow="none"，不要调用其他工具也不创建 Work。两句报告来源及核验结果，若核验不完整必须明说。']
      ]) {
        const started = Date.now(), requestOffset = requests.length;
        await send(prompt); await foregroundDone(0);
        const messages = (await history()).messages;
        const answer = messages.filter(m => m.role === 'assistant').at(-1);
        const calls = requests.slice(requestOffset);
        const toolResults = calls.flatMap(r => r.messages.filter(m => m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
        const row = { label, elapsedMs: Date.now() - started, modelRequests: calls.length, answer: answer.text, toolResults };
        report.cases.push(row);
        assert(toolResults.some(x => x.includes('Merged sources')), 'real search result must reach real model');
        assert.equal(answer.workIds.length, 0, 'ordinary search stays foreground');
        assert(answer.text.length > 0);
        if (!report.searchConfigAvailable) assert(toolResults.some(x => x.includes('未发起请求')), 'missing configuration is explicit, never fabricated sources');
        if (label.endsWith('quick')) assert(toolResults.some(x => x.includes('未进行原文语义核验')), 'quick mode cannot claim verification');
        const shot = await rpc('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, label+'.png'), Buffer.from(shot.data, 'base64'));
      }
      report.checks.push(report.searchConfigAvailable ? 'three real-model UI searches: single quick, batched multi-query, explicit original-page verification; outputs and wall time recorded' : 'real-model UI empty-source failure paths verified; no configured live search API, actual provider latency comparison NOT performed');
    } else if (teamWorkspaceScenario) {
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
        await rpc('Input.insertText',{text:'核算 123+456，给出准确结果，负责人汇总'});
        await evaluate(`document.querySelector('dialog[open] button[type=submit]').click()`);
        await until(()=>evaluate(`document.querySelector('.bot-heading h1')?.textContent===${JSON.stringify(name)} && !document.querySelector('dialog[open]')`),'creation opens full team page');
        const list=await evaluate(`window.api.botWork.teamControl({kind:'list_templates'})`);
        return list.templates.find(t=>t.name===name).templateId;
      };
      teamId=await createTeam('真实团队 A');
      assert.equal((await history()).messages.length,0,'new team does not copy leader personal chat');
      await send('请立即交给本团队一次性后台任务：计算 123+456，成员核算，负责人汇总数值。不要联网，不写文件，不要求人工确认。');
      await send('独立插话：17+8，只答数字，不创建任务。');
      await until(async()=> (await history()).messages.some(m=>m.role==='assistant'&&m.status==='completed'&&/25/.test(m.text)), 'team concurrent arithmetic');
      await until(async()=> { const list=await evaluate('window.api.botWork.listWorks(true)'); const h=await history(); if (!list.length && h.messages.filter(m=>m.role==='assistant'&&!m.workFeedback).length>=2 && h.messages.filter(m=>m.role==='assistant'&&!m.workFeedback).every(m=>['completed','failed'].includes(m.status))) throw Error('Team delegation produced no Work: '+h.messages.filter(m=>m.role==='assistant').map(m=>m.text).join(' | ')); return list.some(w=>w.team?.teamId===teamId&&w.lifecycle==='closed'); }, 'team real Work auto finishes');
      const works=await evaluate('window.api.botWork.listWorks(true)');
      assert.equal(works.length,1); assert.equal(works[0].team.teamId,teamId); assert.equal(works[0].closureConclusion,'succeeded');
      await until(async()=> (await history()).messages.some(m=>m.workFeedback?.kind==='result'&&/579/.test(m.text)), 'result delivered to team conversation');
      const teamA=teamId; report.teamAHistory=await history(); report.works=works;
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
      report.checks.push('real UI team creation enters shared full workspace; real concurrent model reply; actual team Work returns 579 and closes; personal and second team histories isolated; team custom-folder save and reopen preserve prior Work');
    } else if (concurrentScenario) {
      const latestUser = async () => (await history()).messages.filter(m=>m.role==='user').at(-1);
      const assistant = async requestId => (await history()).messages.find(m=>m.role==='assistant'&&m.requestId===requestId);
      await send('CONCURRENT_SLOW 只回复“慢请求原答案”，不要用工具。');
      const slow = await latestUser();
      await until(async () => (await assistant(slow.requestId))?.status === 'running', 'slow live request running');
      await send('独立问题：23+19等于多少？只答数字。不要等待其他请求。');
      const fast = await latestUser();
      await until(async () => (await assistant(fast.requestId))?.status === 'completed', 'fast live response while slow pending');
      assert.match((await assistant(fast.requestId)).text, /42/);
      assert.equal((await assistant(slow.requestId)).status, 'running', 'slow response must still be running');
      const slowMessage = await assistant(slow.requestId);
      await evaluate(`[...document.querySelectorAll('[data-message-id="${slowMessage.messageId}"] .bot-message-meta button')].find(button => button.textContent.includes("停止回复")).click()`);
      await until(async () => (await assistant(slow.requestId))?.status === 'cancelled', 'stop only selected slow request');
      assert.equal((await assistant(fast.requestId)).status, 'completed');
      await send('第三条独立问题：只回复“第三条正常”。');
      const third = await latestUser();
      await until(async () => (await assistant(third.requestId))?.status === 'completed', 'subsequent live request');
      assert.match((await assistant(third.requestId)).text, /第三条正常/);
      await send('CONCURRENT_FAIL 这是单条传输失败验收请求。');
      const failed = await latestUser();
      await until(async () => ['failed','unknown'].includes((await assistant(failed.requestId))?.status), 'single failed provider request');
      await send('失败之后的新问题：17+8等于多少？只答数字。');
      const afterFailure = await latestUser();
      await until(async () => (await assistant(afterFailure.requestId))?.status === 'completed', 'failed request does not block next live model');
      assert.match((await assistant(afterFailure.requestId)).text, /25/);
      assert.equal((await assistant(slow.requestId)).status, 'cancelled', 'late cancelled stream cannot revive original request');
      report.checks.push('real model slow response overlapped by independent arithmetic; request-specific UI stop; third request completes; controlled 503 isolated; subsequent real model completes');
      report.messages = (await history()).messages;
      report.visibleText = await evaluate('document.body.innerText');
    } else if (completionScenario) {
      await send('请建立一次性后台委托，标题“自动收尾验收”：写一份周末居家整理计划，包含厨房、卧室、书桌三个区域，每个区域两步。直接交付文字结果，不用创建文件，不需要我确认或验收，不要设持续追踪。');
      await foregroundDone(0);
      await until(async () => (await evaluate('window.api.botWork.listWorks(true)')).length === 1, 'one real Work created');
      const workId = (await evaluate('window.api.botWork.listWorks(true)'))[0].workId;
      await until(async () => (await evaluate(`window.api.botWork.getWork(${JSON.stringify(workId)})`)).lifecycle === 'closed', 'automatic closure without review clicks');
      const work = await evaluate(`window.api.botWork.getWork(${JSON.stringify(workId)})`);
      assert.equal(work.closureConclusion, 'succeeded', JSON.stringify(work));
      assert(work.deliverables.some(item => item.summary.includes('厨房') && item.summary.includes('卧室') && item.summary.includes('书桌')));
      assert(work.deliverables.every(item => item.status === 'proposed'), 'no forged human acceptance');
      await until(async () => (await history()).messages.some(item => item.workFeedback?.kind === 'result' || item.text?.includes('居家整理')), 'result returned to original conversation');
      const deliveredText=(await history()).messages.find(item=>item.workFeedback?.eventId === `completion:${work.executions.at(-1).bindingId}`)?.workFeedback?.report?.summary;
      assert(deliveredText, 'result has a readable summary');
      await until(()=>evaluate(`document.body.innerText.includes(${JSON.stringify(deliveredText.slice(0,32))})`),'actual result summary rendered in conversation without refresh click');
      await evaluate(`document.querySelectorAll('[data-work-id]').item(document.querySelectorAll('[data-work-id]').length-1)?.scrollIntoView({block:'end'})`);
      const conversationShot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}); fs.writeFileSync(path.join(out,'completion-conversation.png'),Buffer.from(conversationShot.data,'base64'));
      await evaluate(`[...document.querySelectorAll('button')].find(item=>/^已结束/.test(item.textContent.trim())).click()`);
      await until(() => evaluate(`!!document.querySelector('[data-work-id="${workId}"]')`), 'completed Work visible in ended tab');
      report.work = work; report.history = await history();
      const processed = report.history.messages.filter(item => item.workFeedback?.eventId === `completion:${work.executions.at(-1).bindingId}`);
      assert.equal(processed.length, 1, 'one meaningful result delivery precedes closure');
      assert(!processed[0].text.includes('事项已关闭（succeeded）'));
      assert(requests.some(request => request.messages.some(message => JSON.stringify(message.content).includes('个人助理的结果处理回合'))), 'real independent foreground result-thinking model turn ran');
      report.checks.push('real UI + DeepSeek -> real once Work -> actual three-area result -> automatic closed -> visible in ended tab; no acceptance clicks or forged criteria');
    } else if (trackingScenario) {
      await send('请建立持续跟踪事项，标题“明日检查”：每天 Asia/Shanghai 时区上午9点只读检查委托进展。现在不用执行，不修改任何文件。');
      await foregroundDone(0);
      const works = await evaluate('window.api.botWork.listWorks(true)');
      assert.equal(works.length, 1);
      const workId = works[0].workId;
      const detail = await evaluate(`window.api.botWork.getWork(${JSON.stringify(workId)})`);
      assert.equal(detail.executions.length, 0, 'future schedule must not be reported as running');
      await send('查看目前委托进度：是否真的正在执行？下一步什么时候做？不要新建任务。');
      await foregroundDone(0);
      const latest = (await history()).messages.filter(m=>m.role==='assistant'&&m.status==='completed').at(-1).text;
      const toolFacts = requests.flatMap(r=>r.messages.filter(m=>m.role==='tool')).map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content));
      assert(toolFacts.some(t=>t.includes('"state":"scheduled"')&&t.includes('nextStep')), 'real provider receives factual scheduled next step');
      assert(/等待|未.*执行|还没|尚未|已安排|未到|没有.*执行/.test(latest), latest);
      assert(/9|九|09:00/.test(latest), latest);
      await send(`暂停 ${workId}，然后告诉我这项任务现在是否在执行。`);
      await foregroundDone(0);
      await send('再查一次当前所有委托的真实进度和下一步，不要恢复。');
      await foregroundDone(0);
      const paused = (await history()).messages.filter(m=>m.role==='assistant'&&m.status==='completed').at(-1).text;
      assert(/暂停/.test(paused), paused);
      assert(!/stateVersion|openBlockerCount|tracking\.state/.test(paused), 'user reply must not expose internal field names: '+paused);
      assert.equal((await evaluate(`window.api.botWork.getWork(${JSON.stringify(workId)})`)).lifecycle, 'paused');
      assert.equal((await evaluate('window.api.botWork.listWorks(true)')).length, 1, 'status checks do not duplicate delegation');
      report.history=await history(); report.scheduledReply=latest; report.pausedReply=paused;
      report.checks.push('real desktop renderer + DeepSeek: natural schedule creation, actual status tool facts, next check time, pause state, no duplicate Work');
    } else if (teamDefaultWorkspaceScenario) {
      const created = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'学习搭子',responsibilitySummary:'读取实际工作目录并报告真实工具结果'})`);
      assert(created.ok, JSON.stringify(created));
      const settings = (await evaluate(`window.api.botWork.getSettings('${botId}')`)).settings;
      assert.equal(settings.workspacePath, '');
      assert(!fs.existsSync(settings.effectiveWorkspacePath), 'fresh Bot managed directory must not exist before dispatch');
      await send('给学习搭子派一个任务：执行 pwd 查询实际工作目录，报告真实工具返回的绝对路径。请从现有 Bot 自由组队，只让学习搭子执行，你负责汇总；不要保存团队模板，不要创建普通独立 Work。现在执行，权限只读，不修改文件。');
      await foregroundDone(0);
      await until(async () => {
        const works = await evaluate('window.api.botWork.listWorks(true)');
        if (!works.length) return false;
        assert(works.length === 1 && works[0].team, 'request must create one real team, not fall back to ordinary Work');
        return works[0].team.executions.every(e => ['completed','recovered'].includes(e.status));
      }, 'fresh default directory -> member native execution -> owner summary');
      report.works = await evaluate('window.api.botWork.listWorks(true)');
      const work = report.works[0];
      const sqlite = new (require('better-sqlite3'))(path.join(agentDir, 'app.db'), {readonly:true});
      const stored = sqlite.prepare('SELECT workspace_path FROM works WHERE work_id=?').get(work.workId);
      const executions = sqlite.prepare('SELECT t.cwd FROM tasks t JOIN work_team_executions e ON e.task_id=t.id WHERE e.work_id=?').all(work.workId);
      sqlite.close();
      assert.equal(stored.workspace_path, settings.effectiveWorkspacePath);
      assert(executions.length === 2 && executions.every(e => e.cwd === stored.workspace_path));
      assert(fs.statSync(stored.workspace_path).isDirectory());
      assert.equal(work.team.executions.length, 2);
      assert.equal((await evaluate(`window.api.botWork.teamControl({kind:'list_templates'})`)).templates.length, 0);
      assert(requests.some(r => r.messages?.some(m => m.tool_calls?.some(c => c.function?.name === 'work_team_create'))));
      assert(requests.some(r => r.messages?.some(m => m.tool_calls?.some(c => c.function?.name === 'bash' && JSON.parse(c.function.arguments).command === 'pwd'))), 'member invokes real host-backed readonly pwd');
      await until(async () => (await history()).messages.some(m => m.workFeedback?.workId === work.workId && m.workFeedback?.report), 'team result returns to original Bot conversation');
      report.history = await history();
      assert(!report.history.messages.some(m => m.role === 'assistant' && m.text.includes('工作区必须是当前可访问')));
      const shot = await rpc('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(out,'team-default-workspace.png'),Buffer.from(shot.data,'base64'));
      report.checks.push('fresh Bot without configured folder: real model chooses existing peer, managed folder prepared at dispatch, real native directory read, owner summary returned without fallback or settings prompt');
    } else if (teamScenario) {
      const workspace = path.join(home, 'team-workspace'); fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, 'alpha.txt'), 'ALPHA-31415\n');
      if (!teamFailureScenario || teamTransientFailure) fs.writeFileSync(path.join(workspace, 'beta.txt'), 'BETA-27182\n');
      const members = [];
      for (const label of (teamFreeScenario ? ['文件读取员','交叉核对员','图片设计师'] : teamFailureScenario ? ['甲读取员','乙读取员','依赖核对员'] : ['甲读取员','乙读取员'])) {
        const created = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:${JSON.stringify(label)},responsibilitySummary:${JSON.stringify(label==='图片设计师'?'只负责图片设计和视觉创作，不适合文件读取核验':label==='交叉核对员'?'复核他人结果、交叉验证文件原文并报告差异':'读取指定文件并报告原文')}})`);
        assert(created.ok, JSON.stringify(created)); members.push(created.bot.botId);
      }
      const settings = (await evaluate(`window.api.botWork.getSettings('${botId}')`)).settings;
      const saved = await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`);
      assert(saved.ok, JSON.stringify(saved));
      if (teamTransportFailure) {
        const memberSettings=(await evaluate(`window.api.botWork.getSettings('${members[1]}')`)).settings;
        const unavailable=await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId:members[1],expectedRevision:memberSettings.revision,workspacePath:workspace,modelId:'fixture/controlled-unavailable',expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`);
        assert(unavailable.ok,JSON.stringify(unavailable));
      }
      const template = teamFreeScenario ? {ok:true} : await evaluate(`window.api.botWork.teamControl(${JSON.stringify({kind:'save_template',request:{operationId:'live-template',name:'文件双人核对',plan:{ownerBotId:botId,ownerResponsibility:'汇总两位成员各自读到的文件原文，清楚标明文件名，不推算内容',executionPolicy:'parallel',maxConcurrency:2,members:members.map((id,index)=>({botId:id,responsibility:teamPlanningScenario?'通用文件整理，等待本次任务分工':index===2?'仅核对乙读取员的真实 beta.txt 结果，若前置失败或缺失就如实说明无法核对，不推算、不造文件、不写盘':`使用真实 read 工具读取 ${path.join(workspace,index===0?'alpha.txt':'beta.txt')}，只报告该文件原文；不存在必须报告失败，不替代、不创建文件、不写盘`,delegatedScope:['workspace:read'],...(index===2?{dependsOnBotIds:[members[1]]}:{})}))}}})})`);
      assert(template.ok, JSON.stringify(template));
      await send((teamFreeScenario ? '从现有 Bot 自主挑选适合文件读取和交叉核对的两位成员组队，不使用或保存任何团队模板，不安排图片设计。先由读取成员读取 beta.txt，再由核对成员等前者完成后读取 alpha.txt 并核对 beta 原文，负责人汇总结果。' : '')+(teamPlanningScenario && !teamFreeScenario ? '本次请重新安排分工：甲读取员读取 beta.txt，乙读取员等甲完成后读取 alpha.txt 并核对甲的 beta 原文；负责人汇总两者。本次分工不要保存覆盖模板。' : '')+(teamFreeScenario ? '请直接开始，读取原文，不创建普通独立 Work，不猜测内容。' : '请使用已保存的“文件双人核对”团队，现在读取 alpha.txt、beta.txt，分别报告真实文件内容并汇总。不存在的文件必须标明失败，不能替代或创建；依赖缺失文件的分工说明无法完成。不要创建普通独立 Work，不需要再次确认，不能猜测文件内容。'));
      await foregroundDone(0);
      await until(async () => {
        const works=await evaluate('window.api.botWork.listWorks(true)');
        return works.length===1 && works[0].team?.executions.every(e=>['completed','recovered','failed','stopped','blocked'].includes(e.status)) && works[0].team.executions.some(e=>e.role==='owner_summary'&&['completed','recovered'].includes(e.status));
      }, 'real model team members and owner summary complete');
      report.works=await evaluate('window.api.botWork.listWorks(true)');
      report.history=await history();
      const team=report.works[0].team;
      assert.equal(team.executions.length,teamFailureScenario?4:3);
      assert.equal(team.executions.filter(e=>e.role==='owner_summary').length,1);
      if (teamPlanningScenario) {
        const createCall=requests.flatMap(r=>r.messages||[]).flatMap(m=>m.tool_calls||[]).find(c=>c.function?.name==='work_team_create');
        assert(createCall, 'real model selected the existing team tool');
        const planned=JSON.parse(createCall.function.arguments).taskAssignment;
        assert(planned, 'real model supplied a per-commission assignment');
        assert(team.members.find(m=>m.botId===members[0]).responsibility.includes('beta'));
        assert(team.members.find(m=>m.botId===members[1]).responsibility.includes('alpha'));
        assert.deepEqual(team.members.find(m=>m.botId===members[1]).dependsOnBotIds,[members[0]]);
        const preserved=await evaluate(`window.api.botWork.teamControl({kind:'list_templates'})`);
        if (teamFreeScenario) { assert.equal(preserved.templates.length, 0); assert.equal(JSON.parse(createCall.function.arguments).templateId, undefined); assert(!team.members.some(member=>member.botId===members[2]), 'irrelevant designer not selected'); }
        else assert(preserved.templates[0].members.every(m=>m.responsibility==='通用文件整理，等待本次任务分工'));
        report.checks.push('real model selected current-task responsibilities and dependency; saved template unchanged');
      }

      const ownerExecution = team.executions.find(e=>e.role==='owner_summary');
      await until(async()=> (await history()).messages.some(m=>m.workFeedback?.executionId===ownerExecution.bindingId && m.workFeedback?.report), 'owner result feedback persisted');
      report.history = await history();
      const ownerReport = report.history.messages.filter(m=>m.workFeedback?.executionId===ownerExecution.bindingId && m.workFeedback?.report).at(-1).workFeedback.report;
      const summary = ownerReport.structured ? ownerReport.structured.conclusions.map(item=>item.text).join('\n') : ownerExecution.resultSummary;
      if (structuredReportScenario) {
        assert(ownerReport.structured, 'real owner output must produce validated structured feedback, not silently pass through fallback');
        assert(ownerReport.teamFacts?.length, 'host execution facts are present independently');
        assert.equal(ownerReport.summary, ownerExecution.resultSummary, 'raw model output is unchanged');
        report.checks.push('real model structured report: request-linked conclusions, host execution facts, optional observations and unchanged original');
      }
      const memberNames = teamFreeScenario ? ['文件读取员', '交叉核对员'] : teamFailureScenario ? ['甲读取员', '乙读取员', '依赖核对员'] : ['甲读取员', '乙读取员'];
      for (const name of memberNames) assert((summary + JSON.stringify(ownerReport.teamFacts ?? [])).includes(name), `owner summary must identify ${name} by host display name`);
      assert(!/bot-created-[a-f0-9]+|binding-[a-f0-9]+/.test(summary),
        'main owner report uses member names, not internal identity/binding IDs');
      report.checks.push('owner result identifies every member by host display name; technical IDs stay out of the main report');

      assert(summary.includes('ALPHA-31415')&&(teamFailureScenario && !teamTransientFailure ? /不存在|缺失|失败|未找到/.test(summary) && !summary.includes('BETA-27182') : summary.includes('BETA-27182')), summary);
      await until(()=>evaluate(`document.querySelector('.bot-thread').textContent.includes('ALPHA-31415') && document.querySelector('.bot-thread').textContent.includes(${JSON.stringify(teamFailureScenario?'beta.txt':'BETA-27182')})`),'team results visibly returned to original Bot conversation');
      assert(requests.some(r=>r.messages?.some(m=>m.tool_calls?.some(c=>c.function?.name==='work_team_create'))));
      const ownerReportSelector = `[...document.querySelectorAll('.bot-result-report')].filter(el=>${JSON.stringify(memberNames)}.every(name=>el.textContent.includes(name))).at(-1)`;
      await until(()=>evaluate(`Boolean(${ownerReportSelector})`),'named owner summary rendered in original conversation');
      if (structuredReportScenario) {
        assert(await evaluate(`Boolean(${ownerReportSelector}.querySelector('[aria-label="本次请求的结论"]'))`));
        assert(await evaluate(`Boolean(${ownerReportSelector}.querySelector('[aria-label="汇总时的执行事实"]'))`));
        assert(await evaluate(`![...${ownerReportSelector}.querySelectorAll('details[aria-label="额外观察"]')].some(el=>el.open)`));
      }

      await evaluate(`${ownerReportSelector}.scrollIntoView({block:'start'})`); await wait(150);
      const readableShot = await rpc('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(out,'team-result.png'),Buffer.from(readableShot.data,'base64'));

      report.checks.push('real Bot composer -> real online model template selection -> durable team members -> owner summary -> original conversation');
      report.checks.push(teamTransportFailure&&!teamTransientFailure?'one successful read, one controlled provider failure, dependent scope accounted for, truthful owner summary':teamFailureScenario&&!teamTransientFailure?'one successful read, one real missing-file failure, dependent scope accounted for, truthful owner summary':`exact file values verified, one Work, ${team.executions.length} team executions, no fabricated tool results`);
      assert.equal(report.works[0].executions.filter(e=>e.taskId===team.executions[0].taskId).length,1,'successful member is never redispatched by sibling recovery');
      if (teamTransportFailure && !teamTransientFailure) {
        assert(team.executions.some(e=>e.role==='member'&&['failed','stopped','blocked'].includes(e.status)), 'provider unavailable must remain explicitly failed');
        assert(!JSON.stringify(report.works).includes('历史协作资料已离开'), 'same-task recovery must retain its collaboration sources');
        assert(team.executions.some(e=>e.notStartedReason), 'dependent member must have an explicit unstarted reason');
        report.checks.push('controlled member HTTP 503 exhausts bounded recovery; dependent member marked not started; owner still summarizes real success and failure');
      }
      if (teamTransientFailure) {
        assert(team.executions.some(e=>e.status==='recovered'), 'failed member recovers in its original task');
        assert(team.executions.every(e=>['completed','recovered'].includes(e.status)), 'dependency and owner complete after recovery');
        assert(!JSON.stringify(report.works).includes('历史协作资料已离开'));
        report.checks.push('transient 503 followed by real provider recovery, original member recovered, dependent member and owner finish');
      }
      if (teamFailureScenario) {
        if (!teamTransientFailure) assert(!fs.existsSync(path.join(workspace,'beta.txt')), 'missing input must not be fabricated');
        const before=(await history()).messages.filter(m=>m.role==='assistant'&&m.status==='completed').length;
        await send('现在只回答普通问题：19乘以23是多少？不需要团队或后台任务。');
        await foregroundDone(before);
        const messages=(await history()).messages;
        const requestId=messages.filter(m=>m.role==='user').at(-1).requestId;
        assert(messages.find(m=>m.role==='assistant'&&m.requestId===requestId).text.includes('437'));
        await until(()=>evaluate("document.querySelector('.bot-thread').textContent.includes('437')"),'ordinary answer rendered after background results');
        assert.equal((await evaluate('window.api.botWork.listWorks(true)')).length,1,'ordinary response after failure must not create another Work');
        report.checks.push('ordinary frontend conversation still responds 437 after failed team member, no extra Work');
      }
    } else if (cacheScenario) {
      const csv=['id,region,units,price',...Array.from({length:1200},(_,i)=>`${i+1},${['east','west','north'][i%3]},${i%9+1},${10+i%7}`)].join('\n');
      const prompts=[
        '这是隔离测试数据，仅在当前对话分析，不创建后台委托，不联网，不调用工具，不保存长期记忆。先确认列名、首末记录，80字以内。\n'+csv,
        '继续分析刚才的表格，不重复读取。描述region、units、price三个字段的循环规律，80字以内。仍不要创建Work或调用工具。',
        '仅根据刚才已有数据，提出三项数据质量检查。不宣称已经运行程序。80字以内，不创建Work。',
        '把本次分析总结成简短交接：已观察事实、未计算项目、下一步。120字以内，不调用工具。'
      ];
      report.turns=[];
      for(const prompt of prompts) {
        const before=(await history()).messages.filter(m=>m.role==='assistant'&&m.status==='completed').length;
        const started=Date.now(); await send(prompt); await foregroundDone(before);
        report.turns.push({ms:Date.now()-started,requests:requests.length}); console.log(JSON.stringify(report.turns.at(-1)));
        await wait(1200);
      }
      report.history=await history();
      report.workCount=(await evaluate('window.api.botWork.listWorks(true)')).length;
      assert.equal(report.workCount,0);
      assert.equal(report.history.messages.filter(m=>m.role==='assistant'&&m.status==='completed').length,4);
      assert.equal(requests.length,4,'one foreground inference per synthetic analysis turn');
      for(let i=1;i<requests.length;i++) {
        assert.deepEqual(requests[i].messages.slice(0,requests[i-1].messages.length),requests[i-1].messages,
          'new turn must append to the exact previous wire prefix, including a stable system message');
      }
      report.checks.push('three real HTTP prefixes remain append-only across four Bot turns');
      report.checks.push('real Bot composer + real online model, four foreground turns, synthetic data, zero Work');
    } else if (memoryScenario) {
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
        await until(async () => (await history()).messages.length === 0 && await evaluate('!document.querySelector("dialog[open]")'), 'blank new conversation and dismissed dialog');
      };
      const originalBotId = botId;
      const other = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'隔离记忆搭档',responsibilitySummary:'独立记忆验收'})`);
      assert(other.ok, JSON.stringify(other));
      await until(()=>evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].some(b=>b.textContent.includes('隔离记忆搭档'))`), 'second Bot appears');
      await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(b=>b.textContent.includes('隔离记忆搭档')).click()`);
      botId = other.bot.botId;
      await until(()=>evaluate(`document.querySelector('.bot-workspace')?.innerText.includes('隔离记忆搭档')`), 'second Bot selected');
      const isolationStart = requests.length;
      await send('我的常用测试代号是什么？没有记录就直说不知道。'); await foregroundDone(0);
      report.otherBotHistory = await history();
      assert(!JSON.stringify(requests.slice(isolationStart)).includes('云杉7842'), 'other Bot never receives private memory');
      assert(!report.otherBotHistory.messages.some(m=>m.role==='assistant'&&m.text.includes('云杉7842')));
      await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(b=>b.querySelector('strong')?.textContent==='MyBuddy').click()`);
      botId = originalBotId;
      await until(()=>evaluate(`document.querySelector('.sidebar-bot-identity[aria-pressed=true] strong')?.textContent==='MyBuddy'`), 'original Bot selected');
      report.checks.push('second Bot real model receives neither private fact nor original conversation');
      const oldConversation = (await history()).conversationId;
      if(electronWatch) { clearInterval(electronWatch); electronWatch=undefined; }
      try { await rpc('Browser.close'); } catch {} socket.close(); socket=undefined;
      await stopTestElectronMains();
      if(processDev.exitCode===null) processDev.kill('SIGTERM');
      await launch();
      await until(()=>evaluate('Boolean(window.api?.botWork?.history && document.querySelector(".sidebar-user-main"))'), 'memory persisted after actual Electron restart');
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
      await send('修正一下：我的常用测试代号现在改成雪松9361，旧的云杉7842不再使用。请更新长期记忆。');
      await foregroundDone(0);
      await until(async () => {
        const atoms = await evaluate(`window.api.memory.list({scopeType:'bot',scopeId:'${botId}',status:'active'})`);
        return atoms.some(atom => atom.content.includes('雪松9361')) && !atoms.some(atom => atom.content.includes('云杉7842') && !atom.content.includes('雪松9361'));
      }, 'natural correction replaces old active fact');
      report.correctedMemories = await evaluate(`window.api.memory.list({scopeType:'bot',scopeId:'${botId}',status:'active'})`);
      await newChat();
      await send('我的常用测试代号是什么？'); await foregroundDone(0);
      report.correctedRecall = await history();
      assert(report.correctedRecall.messages.some(m=>m.role==='assistant'&&m.text.includes('雪松9361')));
      await send('忘记我的常用测试代号，删除关于这个代号的长期记忆。'); await foregroundDone(0);
      await until(async () => {
        const atoms = await evaluate(`window.api.memory.list({scopeType:'bot',scopeId:'${botId}',status:'active'})`);
        return !atoms.some(atom => /雪松9361|云杉7842/.test(atom.content));
      }, 'natural forget removes active fact');
      assert(requests.some(request => request.messages.some(message => message.tool_calls?.some(call => call.function?.name === 'memory_forget'))), 'real model invokes synchronous forget tool');
      report.forgottenReply = (await history()).messages.filter(m=>m.role==='assistant').at(-1)?.text;
      assert(!/无法.*删|没有删除能力|记忆管理界面/.test(report.forgottenReply), 'forget must return a truthful completed receipt, not redirect the user');
      await newChat();
      const before = requests.length;
      await send('我的常用测试代号是什么？没有记录就直说不知道。');
      await foregroundDone(0);
      report.afterDeletion = await history();
      assert(!/云杉7842|雪松9361/.test(JSON.stringify(requests.slice(before))), 'deleted memory is absent from fresh provider requests');
      assert(!report.afterDeletion.messages.some(message => message.role === 'assistant' && message.text.includes('云杉7842')));
      assert.equal((await evaluate('window.api.botWork.listWorks(true)')).length, 0);
      report.checks.push('natural correction supersedes old fact; natural forget removes provider evidence and fresh-chat recall, no API deletion and no Work');
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
    const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,watchIntentScenario?'watch-intent.png':teamWorkspaceScenario?'team-workspace.png':completionScenario?'completion.png':trackingScenario?'tracking.png':teamScenario?'team.png':cacheScenario?'cache.png':memoryScenario?'memory.png':watchScenario?'watch.png':'weather.png'),Buffer.from(shot.data,'base64'));
    report.status='passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); console.error(error); process.exitCode = 1;
    if (socket) try { report.visibleText = await evaluate('document.body.innerText'); const shot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(out, 'failed-page.png'), Buffer.from(shot.data, 'base64')); } catch {}
  }
  finally {
    if (searchScenario) { try { fs.unlinkSync(path.join(agentDir, 'web-search.json')); } catch {} }
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
