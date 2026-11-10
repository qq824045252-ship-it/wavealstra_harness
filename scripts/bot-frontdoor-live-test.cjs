/** Actual pnpm dev -> Electron -> preload -> Bot page -> real online model, isolated HOME. No build/pack. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const teamTransientFailure = process.argv.includes('--team-transient-failure');
const teamTransportFailure = process.argv.includes('--team-transport-failure') || teamTransientFailure;
const teamFailureScenario = process.argv.includes('--team-failure') || teamTransportFailure;
const teamScenario = process.argv.includes('--team') || teamFailureScenario;
const cacheScenario = process.argv.includes('--cache');
const memoryScenario = process.argv.includes('--memory');
const windows = process.platform === 'win32';
const selectedModel = process.env.BOT_FRONTDOOR_MODEL || 'opendesign/deepseek-v4.1-flash';
const modelKey = `fixture/${selectedModel}`;
const headless = process.env.BOT_WORK_DEV_HEADLESS === '1';
const trackingScenario = process.argv.includes('--tracking');
const watchScenario = process.argv.includes('--watch');
if (headless && process.platform !== 'linux') throw Error('Headless dev page validation requires Linux; it does not validate desktop input.');
const out = path.join(root, trackingScenario ? 'out/diagnostics/bot-tracking/live' : teamTransientFailure ? 'out/diagnostics/bot-team-transient-failure/live' : teamTransportFailure ? 'out/diagnostics/bot-team-transport-failure/live' : teamFailureScenario ? 'out/diagnostics/bot-team-failure/live' : teamScenario ? 'out/diagnostics/bot-team-frontdoor/live' : cacheScenario ? 'out/diagnostics/bot-cache/live' : memoryScenario ? 'out/diagnostics/bot-memory/live' : watchScenario ? 'out/diagnostics/bot-watch/live' : 'out/diagnostics/bot-frontdoor/live'); fs.mkdirSync(out, { recursive: true });
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
    if (teamTransportFailure && body.model === 'controlled-unavailable' && (!teamTransientFailure || requests.filter(r=>r.model==='controlled-unavailable').length<=4)) {
      res.writeHead(503, {'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'Controlled ordinary unavailable provider; no execution or process crash',type:'service_unavailable'}})); return;
    }
    const response=await fetch((process.env.BOT_FRONTDOOR_BASE_URL || 'http://127.0.0.1:3425/v1')+'/chat/completions', {
      method:'POST',headers:{'content-type':'application/json'},body:teamTransientFailure&&body.model==='controlled-unavailable'?JSON.stringify({...body,model:selectedModel}):raw});
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
    let botId = 'bot-mybuddy-default';
    const history = () => evaluate(`window.api.botWork.history({botId:'${botId}'})`);
    const foregroundDone = async _before => {
      const requestId=(await history()).messages.filter(m=>m.role==='user').at(-1)?.requestId;
      assert(requestId, 'accepted user request identity');
      await until(async () => (await history()).messages.some(m=>m.role==='assistant'&&m.requestId===requestId&&m.status==='completed'), 'matching foreground request completed');
    };
    if (trackingScenario) {
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
    } else if (teamScenario) {
      const workspace = path.join(home, 'team-workspace'); fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, 'alpha.txt'), 'ALPHA-31415\n');
      if (!teamFailureScenario || teamTransientFailure) fs.writeFileSync(path.join(workspace, 'beta.txt'), 'BETA-27182\n');
      const members = [];
      for (const label of (teamFailureScenario ? ['甲读取员','乙读取员','依赖核对员'] : ['甲读取员','乙读取员'])) {
        const created = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:${JSON.stringify(label)},responsibilitySummary:'按团队分工读取指定文件并报告原文'})`);
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
      const template = await evaluate(`window.api.botWork.teamControl(${JSON.stringify({kind:'save_template',request:{operationId:'live-template',name:'文件双人核对',plan:{ownerBotId:botId,ownerResponsibility:'汇总两位成员各自读到的文件原文，清楚标明文件名，不推算内容',executionPolicy:'parallel',maxConcurrency:2,members:members.map((id,index)=>({botId:id,responsibility:index===2?'仅核对乙读取员的真实 beta.txt 结果，若前置失败或缺失就如实说明无法核对，不推算、不造文件、不写盘':`使用真实 read 工具读取 ${path.join(workspace,index===0?'alpha.txt':'beta.txt')}，只报告该文件原文；不存在必须报告失败，不替代、不创建文件、不写盘`,delegatedScope:['workspace:read'],...(index===2?{dependsOnBotIds:[members[1]]}:{})}))}}})})`);
      assert(template.ok, JSON.stringify(template));
      await send('请使用已保存的“文件双人核对”团队，现在读取 alpha.txt、beta.txt，分别报告真实文件内容并汇总。不存在的文件必须标明失败，不能替代或创建；依赖缺失文件的分工说明无法完成。不要创建普通独立 Work，不需要再次确认，不能猜测文件内容。');
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
      const summary=team.executions.find(e=>e.role==='owner_summary').resultSummary;
      const memberNames = teamFailureScenario ? ['甲读取员', '乙读取员', '依赖核对员'] : ['甲读取员', '乙读取员'];
      for (const name of memberNames) assert(summary.includes(name), `owner summary must identify ${name} by host display name`);
      assert(!/bot-created-[a-f0-9]+|binding-[a-f0-9]+/.test(summary),
        'main owner report uses member names, not internal identity/binding IDs');
      report.checks.push('owner result identifies every member by host display name; technical IDs stay out of the main report');

      assert(summary.includes('ALPHA-31415')&&(teamFailureScenario && !teamTransientFailure ? /不存在|缺失|失败|未找到/.test(summary) && !summary.includes('BETA-27182') : summary.includes('BETA-27182')), summary);
      await until(()=>evaluate(`document.querySelector('.bot-thread').textContent.includes('ALPHA-31415') && document.querySelector('.bot-thread').textContent.includes(${JSON.stringify(teamFailureScenario?'beta.txt':'BETA-27182')})`),'team results visibly returned to original Bot conversation');
      assert(requests.some(r=>r.messages?.some(m=>m.tool_calls?.some(c=>c.function?.name==='work_team_create'))));
      const ownerReportSelector = `[...document.querySelectorAll('.bot-result-report')].find(el=>${JSON.stringify(memberNames)}.every(name=>el.textContent.includes(name)))`;
      await until(()=>evaluate(`Boolean(${ownerReportSelector})`),'named owner summary rendered in original conversation');
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
    const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,trackingScenario?'tracking.png':teamScenario?'team.png':cacheScenario?'cache.png':memoryScenario?'memory.png':watchScenario?'watch.png':'weather.png'),Buffer.from(shot.data,'base64'));
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
