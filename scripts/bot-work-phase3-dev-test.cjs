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
const phase5 = process.env.BOT_WORK_DEV_PHASE5 === '1';
if (headless && process.platform !== 'linux') throw Error('Headless dev page validation requires Linux; it does not validate desktop input.');
const out = path.join(root, `out/diagnostics/bot-work-phase${phase5 ? 5 : 3}/dev`); fs.mkdirSync(out, { recursive: true });
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
    const model = { id: 'fixture', name: 'Phase 3 Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [model] } } }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enabledModels: ['fixture/fixture'],
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
    await until(() => evaluate('document.querySelector("#bot-work-inspector").innerText.includes("执行情况")'), 'Phase 3 authoritative detail');
    const original = (await evaluate('window.api.botWork.listWorks(true)'))[0];
    if (phase5) {
      await require('./bot-work-phase5-dev-checks.cjs')({ evaluate, rpc, until, isolatedSql, report,
        original, requests, socket, out });
      report.finalProjection = await evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)})`);
      report.works = works; report.providerRequests = requests.length; report.status = 'passed';
      return;
    }
    const binding = original.executions[0];
    assert(binding && binding.status === 'completed', 'fixture original root really settled');
    const fullOwner = { taskId: binding.taskId, durableStoreKey: binding.durableStoreKey, conversationId: binding.conversationId,
      workspaceBinding: binding.workspaceBinding, bindingId: binding.bindingId, workId: original.workId };
    const gap = { itemId: 'ui-fixture-gap', task: '界面夹具：仅补齐缺少的检查', required: true, dependencies: [], criterionIds: original.criteria.map(item => item.id),
      nativeStatus: 'blocked', outcome: 'blocked', artifactRefs: [], writeConflicts: ['界面夹具：旧写入已阻止'], summary: '已核实的必要缺口' };
    const retained = { ...gap, itemId: 'ui-fixture-retained', task: '界面夹具：已经保留的成果', nativeStatus: 'completed', outcome: 'completed', writeConflicts: [], summary: '保留部分成果' };
    const now = Date.now();
    isolatedSql({ statements: [
      { sql: 'INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,deliverable_id,created_at) VALUES (?,?,?,?,?,?,?)',
        params: ['ui-fixture-gap-fact', original.workId, binding.bindingId, gap.itemId, JSON.stringify(gap), null, now] },
      { sql: 'INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,deliverable_id,created_at) VALUES (?,?,?,?,?,?,?)',
        params: ['ui-fixture-retained-fact', original.workId, binding.bindingId, retained.itemId, JSON.stringify(retained), original.deliverables[0].deliverableId, now] },
      { sql: 'INSERT INTO work_resource_waiters(action_id,owner_json,reason,updated_at,deadline_at) VALUES (?,?,?,?,?)',
        params: ['ui-fixture-wait', JSON.stringify(fullOwner), '界面夹具：等待共享文档写入结算', now, now + 30000] },
      { sql: 'UPDATE works SET state_version=state_version+1,updated_at=? WHERE work_id=?', params: [now, original.workId] },
    ] });
    report.seededPresentationFacts.push('two structured subitem rows and a resource waiter on a real native Work binding; this is a UI fixture, not a claimed native conflict');
    await until(() => evaluate('document.querySelector("#bot-work-inspector").innerText.includes("已保留 1 项子项成果，必要缺口 1 项")'), 'partial/gap projection displayed');
    await until(() => evaluate('document.querySelector("#bot-work-inspector").innerText.includes("界面夹具：等待共享文档写入结算")'), 'resource wait projection displayed');
    // Real UI input, strict request parsing, authenticated desktop actor, actual SQLite collaboration row.
    const questionText = '界面实机验证：这项缺口由谁确认？';
    await evaluate(`document.querySelector('[aria-label="协作问题"]').focus()`);
    await rpc('Input.insertText', { text: questionText });
    await until(() => evaluate(`document.querySelector('[aria-label="协作问题"]').value === ${JSON.stringify(questionText)}`), 'question controlled input');
    await evaluate('[...document.querySelectorAll("#bot-work-inspector button")].find(button => button.textContent === "保存问题").click()');
    await until(() => evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)}).then(work => work.phase3.collaborationMessages.some(message => message.body === ${JSON.stringify(questionText)}))`), 'actual collaboration persisted through IPC');
    const messages = isolatedSql({ statements: [], query: { sql: "SELECT message_id,kind,payload_json FROM work_collaboration_messages WHERE work_id=? AND kind='question'", params: [original.workId] } });
    assert.equal(messages.length, 1); assert.equal(JSON.parse(messages[0].payload_json).body, questionText);
    report.actualControlChecks.push('question typed and saved through real React UI, preload/IPC and authenticated Work collaboration service; exactly one SQLite row');
    const tasksBefore = (await evaluate('window.api.db.listTasks()')).length;
    const rootRequestsBefore = requests.filter(body => !(body.tools || []).some(tool => tool.function?.name === 'work_create')).length;
    await until(() => evaluate('[...document.querySelectorAll("#bot-work-inspector button")].some(button => button.textContent === "仅补跑此项" && !button.disabled)'), 'gap-only action enabled');
    await evaluate('[...document.querySelectorAll("#bot-work-inspector button")].find(button => button.textContent === "仅补跑此项").click()');
    await until(() => evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)}).then(work => work.phase3.continuations.length === 1)`), 'actual continuation plan persisted');
    await until(() => evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)}).then(work => work.executions.length === 2 && work.executions.every(item => item.status === 'completed'))`), 'new gap-only native root settled');
    const afterContinue = await evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)})`);
    assert.equal((await evaluate('window.api.db.listTasks()')).length, tasksBefore + 1);
    assert.equal(afterContinue.inputSnapshotId, original.inputSnapshotId);
    assert.equal(afterContinue.intentRevision, original.intentRevision);
    assert.equal(afterContinue.executions.filter(item => item.bindingId === binding.bindingId).length, 1);
    assert.deepEqual(afterContinue.phase3.continuations[0].gapItemIds, [gap.itemId]);
    assert(afterContinue.phase3.subitems.some(item => item.factId === 'ui-fixture-retained-fact' && item.outcome === 'completed'));
    assert.equal(requests.filter(body => !(body.tools || []).some(tool => tool.function?.name === 'work_create')).length, rootRequestsBefore + 1);
    assert(requests.some(body => JSON.stringify(body.messages).includes('ui-fixture-gap')));
    // A second click retries the same operation; no new logical plan or native execution.
    await until(() => evaluate('[...document.querySelectorAll("#bot-work-inspector button")].some(button => button.textContent === "仅补跑此项" && !button.disabled)'), 'gap retry control enabled');
    await evaluate('[...document.querySelectorAll("#bot-work-inspector button")].find(button => button.textContent === "仅补跑此项").click()');
    await until(() => evaluate('document.querySelector("#bot-work-inspector").innerText.includes("操作已受理")'), 'same-operation receipt retry');
    assert.equal((await evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)})`)).phase3.continuations.length, 1);
    assert.equal((await evaluate('window.api.db.listTasks()')).length, tasksBefore + 1);
    report.actualControlChecks.push('seeded necessary gap selected in real UI; strict owner/CAS continuation accepted, one new durable root, unchanged input/revision, retained completed fact, retry creates no additional plan/task');
    // Presentation of paused in-flight settlement is separately seeded and labelled.
    isolatedSql({ statements: [
      { sql: "INSERT INTO work_action_admissions(admission_id,work_id,binding_id,operation_id,action_kind,state,intent_revision,owner_epoch,admitted_at) VALUES (?,?,?,?,?,'admitted',?,?,?)",
        params: ['ui-fixture-admission', original.workId, binding.bindingId, 'ui-fixture-inflight', 'workspace:read', original.intentRevision, original.ownerEpoch, Date.now()] },
      { sql: "UPDATE works SET lifecycle='paused',state_version=state_version+1,updated_at=? WHERE work_id=?", params: [Date.now(), original.workId] },
    ] });
    await until(() => evaluate('document.querySelector("#bot-work-inspector").innerText.includes("已暂停，正在结算在途操作")'), 'paused settlement presentation');
    assert(await evaluate('[...document.querySelectorAll("#bot-work-inspector button")].filter(button => button.textContent === "仅补跑此项").every(button => button.disabled)'));
    report.seededPresentationFacts.push('paused lifecycle and one in-flight admission, proving projection label and disabled new-action control; actual pause execution/settlement is covered by separate native tests');
    // Exhaustion is a labelled fixture; the user action and safety checks use the
    // real React -> preload -> IPC -> transaction path below.
    const exhaustedAt = Date.now();
    isolatedSql({ statements: [
      { sql: "INSERT INTO work_resource_leases(action_id,owner_json,resources_json,host_id,state,expires_at,admitted_at) VALUES (?,?,?,'ui-fixture-old-host','quarantined',?,?)",
        params: ['ui-fixture-exhausted', JSON.stringify(fullOwner), JSON.stringify([{ kind: 'desktop', scope: 'host-input', key: 'focus:desktop', mode: 'write' }]), exhaustedAt - 1, exhaustedAt - 1000] },
      { sql: "INSERT INTO work_resource_recovery(token,attempts,next_at,exhausted_at,reason) SELECT token,4,?,?,? FROM work_resource_leases WHERE action_id='ui-fixture-exhausted'",
        params: [exhaustedAt, exhaustedAt, '界面夹具：旧宿主输入尚未核对'] },
    ] });
    await until(() => evaluate('Boolean(document.querySelector(\'[aria-label="资源隔离恢复"]\'))'), 'exhausted resource projection');
    assert(await evaluate('document.querySelector(\'[aria-label="资源隔离恢复"] button\').disabled'), 'retry requires explicit human confirmation');
    await evaluate('document.querySelector(\'[aria-label="资源隔离恢复"] input[type="checkbox"]\').click()');
    await until(() => evaluate('!document.querySelector(\'[aria-label="资源隔离恢复"] button\').disabled'), 'confirmed recovery control enabled');
    await evaluate('document.querySelector(\'[aria-label="资源隔离恢复"] button\').click()');
    await until(() => isolatedSql({ statements: [], query: { sql: "SELECT operation_id FROM work_operation_receipts WHERE operation_type='retryResourceRecovery' AND work_id=?", params: [original.workId] } }).length === 1, 'retry persisted through real IPC');
    const recoveredState = isolatedSql({ statements: [], query: { sql: "SELECT lease.state,recovery.attempts,recovery.exhausted_at FROM work_resource_leases lease JOIN work_resource_recovery recovery ON recovery.token=lease.token WHERE lease.action_id='ui-fixture-exhausted'" } })[0];
    assert.equal(recoveredState.state, 'quarantined', 'human confirmation never releases unknown original desktop input');
    assert(recoveredState.attempts >= 4, 'retry identity never rolls back');
    assert.equal((await evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)})`)).lifecycle, 'paused');
    assert.equal((await evaluate('window.api.db.listTasks()')).length, tasksBefore + 1, 'recovery retry does not submit a business task');
    report.seededPresentationFacts.push('one exhausted old-host desktop lease, labelled fixture; native Windows focus is not exercised');
    report.actualControlChecks.push('unchecked retry disabled; explicit confirmation accepted through real IPC and idempotent control transaction; unknown original input remains quarantined, Work remains paused, no new Task');
    // Phase 4 control through the real preload/IPC path and its authoritative projection.
    const phase4Before = await evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)})`);
    const phase4Response = await evaluate(`window.api.botWork.phase4Control(${JSON.stringify({
      kind: 'configure-subscription', operationId: 'dev-phase4-subscription', workId: original.workId,
      source: 'hook', catchUpPolicy: 'latest', maxMergeWaitMs: 1000, maxQueueDepth: 8,
      versionGuard: { expectedStateVersion: phase4Before.stateVersion, expectedIntentRevision: phase4Before.intentRevision,
        expectedOwnerEpoch: phase4Before.ownerEpoch },
    })})`);
    assert.equal(phase4Response.ok, true, 'phase4 control accepted through preload/IPC');
    const phase4After = await evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)})`);
    assert.equal(phase4After.phase4.subscriptions.length, 1);
    assert.equal(phase4After.phase4.subscriptions[0].source, 'hook');
    assert.equal(phase4After.phase4.budget.windowId.length > 0, true);
    await until(() => evaluate('document.querySelector("#bot-work-inspector").innerText.includes("关注与运行")'), 'Phase 4 projection rendered');
    await until(() => evaluate('document.querySelector("#bot-work-inspector").innerText.includes("共享预算")'), 'Phase 4 budget projection rendered');
    report.actualControlChecks.push('phase4 subscription saved through real preload/IPC and current-version guard; phase4 projection rendered in the dev page');
    // Seed one provider-unknown ledger fact only; the reconciliation itself must
    // travel through the real form, guarded preload/IPC and accounting transaction.
    isolatedSql({ statements: [
      { sql: "INSERT INTO work_budget_reservations(reservation_id,work_id,window_id,tokens,state,created_at,request_kind,metering) VALUES (?,?,?,20,'unknown',?,'generation','unknown')",
        params: ['dev-phase4-unknown', original.workId, phase4After.phase4.budget.windowId, Date.now()] },
      { sql: "UPDATE works SET state_version=state_version+1,updated_at=? WHERE work_id=?", params: [Date.now(), original.workId] },
    ] });
    await until(() => evaluate('Boolean(document.querySelector(".budget-reconciliation"))'), 'unknown provider reservation projected');
    await evaluate('document.querySelector(".budget-reconciliation summary").click()');
    assert(await evaluate('document.querySelector(".budget-reconciliation button").disabled'));
    assert.equal(await evaluate('document.querySelector(\'[aria-label="已核实 tokens"]\').value'), '', 'unknown amount has no default zero');
    const fillReconciliation = async (label, value) => {
      await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await until(() => evaluate(`document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}).value === ${JSON.stringify(value)}`), `reconciliation input ${label}`);
    };
    await fillReconciliation('已核实 tokens', '7');
    await fillReconciliation('预算核对说明', '隔离 fixture 账单已核实');
    await fillReconciliation('预算核对凭据', 'fixture:provider-invoice-7');
    assert(await evaluate('document.querySelector(".budget-reconciliation button").disabled'), 'amount and evidence still require explicit confirmation');
    await evaluate('document.querySelector(".budget-reconciliation input[type=checkbox]").click()');
    await until(() => evaluate('!document.querySelector(".budget-reconciliation button").disabled'), 'confirmed accounting command enabled');
    const accountingRequestsBefore = (await evaluate('window.api.db.listTasks()')).length;
    await evaluate('document.querySelector(".budget-reconciliation button").click()');
    await until(() => isolatedSql({ statements: [], query: { sql: "SELECT reservation_id FROM work_budget_reservations WHERE reservation_id='dev-phase4-unknown' AND state='committed' AND reported_tokens=7" } }).length === 1, 'unknown usage settled through UI and real IPC');
    await until(() => evaluate('!document.querySelector(".budget-reconciliation")'), 'settled unknown disappears after current projection refresh');
    assert.equal(isolatedSql({ statements: [], query: { sql: "SELECT operation_id FROM work_operation_receipts WHERE operation_type='phase4:reconcile-budget-reservation' AND work_id=?", params: [original.workId] } }).length, 1);
    assert.equal((await evaluate('window.api.db.listTasks()')).length, accountingRequestsBefore, 'accounting does not launch a new business execution');
    assert.equal((await evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)})`)).lifecycle, 'paused');
    report.seededPresentationFacts.push('one unknown provider reservation in the isolated database; no real provider outage or invoice is claimed');
    report.actualControlChecks.push('unknown amount starts empty; reason, evidence and explicit confirmation required; actual form/preload/IPC commits 7 tokens to original window with one control receipt; Work stays paused and no Task is created');
    isolatedSql({ statements: [
      { sql: "INSERT INTO work_budget_reservations(reservation_id,work_id,window_id,tokens,state,created_at,request_kind,metering) VALUES (?,?,?,3,'unknown',?,'generation','unknown')",
        params: ['dev-phase4-closed-unknown', original.workId, phase4After.phase4.budget.windowId, Date.now()] },
      { sql: "UPDATE works SET lifecycle='closed',state_version=state_version+1,updated_at=? WHERE work_id=?", params: [Date.now(), original.workId] },
    ] });
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "查看已结束事项").click()');
    await until(() => evaluate('[...document.querySelectorAll(".bot-work-card")].some(card => card.innerText.includes("界面验收事项") && card.innerText.includes("已结束"))'), 'closed Work loaded through includeClosed scope');
    await evaluate('[...document.querySelectorAll(".bot-work-card")].find(card => card.innerText.includes("界面验收事项")).click()');
    await until(() => evaluate('Boolean(document.querySelector(".budget-reconciliation"))'), 'closed Work accounting remains accessible');
    await evaluate('document.querySelector(".budget-reconciliation summary").click()');
    await evaluate(`(() => { const select = document.querySelector('[aria-label="未知用量处理方式"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'released');
      select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await fillReconciliation('已核实 tokens', '0');
    await fillReconciliation('预算核对说明', '隔离 fixture 确认请求未发送');
    await fillReconciliation('预算核对凭据', 'fixture:request-not-sent');
    await evaluate('document.querySelector(".budget-reconciliation input[type=checkbox]").click()');
    await until(() => evaluate('!document.querySelector(".budget-reconciliation button").disabled'), 'explicit zero confirmed for release');
    await evaluate('document.querySelector(".budget-reconciliation button").click()');
    await until(() => isolatedSql({ statements: [], query: { sql: "SELECT reservation_id FROM work_budget_reservations WHERE reservation_id='dev-phase4-closed-unknown' AND state='released' AND reported_tokens=0" } }).length === 1, 'closed Work reservation released through real controls');
    await until(() => evaluate('document.querySelector("#bot-work-inspector").innerText.includes("已结束") && !document.querySelector(".budget-reconciliation")'), 'closed Work remains selected after accounting refresh');
    assert.equal((await evaluate('window.api.db.listTasks()')).length, accountingRequestsBefore);
    report.seededPresentationFacts.push('closed lifecycle and a second unknown request are isolated database fixtures');
    report.actualControlChecks.push('view-completed toggle requests all scope; explicit zero release works after closure and preserves closed selection/lifecycle without new execution');
    const phase3shot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, 'phase3-page.png'), Buffer.from(phase3shot.data, 'base64'));
    report.finalProjection = await evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)})`);

    report.works = works; report.providerRequests = requests.length; report.status = 'passed';
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
    console.log(`Phase ${phase5 ? 5 : 3} pnpm dev UI: ${report.status}; ${path.join(out, 'report.json')}`);
  }
})();
