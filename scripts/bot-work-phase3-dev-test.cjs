/** Actual pnpm dev -> Electron -> preload -> Bot page -> native HTTP fixture, isolated HOME. No build/pack. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'out/diagnostics/bot-work-phase3/dev'); fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-work-phase3-dev-'));
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
const report = { platform: 'Windows pnpm dev, isolated profile', seededPresentationFacts: [], actualControlChecks: [], status: 'running', home, checks: [] };
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
    const phase3shot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, 'phase3-page.png'), Buffer.from(phase3shot.data, 'base64'));
    report.finalProjection = await evaluate(`window.api.botWork.getWork(${JSON.stringify(original.workId)})`);

    report.works = works; report.providerRequests = requests.length; report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); console.error(error); process.exitCode = 1;
    if (socket) try { report.visibleText = await evaluate('document.body.innerText'); const shot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(out, 'failed-page.png'), Buffer.from(shot.data, 'base64')); } catch {}
  }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, 'provider-requests.json'), JSON.stringify(requests, null, 2));
    if (socket) { try { await rpc('Browser.close'); } catch {} socket.close(); }
    if (processDev) { await wait(1000); if (processDev.exitCode === null) cp.execFileSync('taskkill.exe', ['/PID', String(processDev.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    if (log !== undefined) fs.closeSync(log); await new Promise(resolve => provider.close(resolve));
    console.log(`Phase 3 pnpm dev UI: ${report.status}; ${path.join(out, 'report.json')}`);
  }
})();
