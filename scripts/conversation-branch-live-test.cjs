/** Opt-in acceptance: actual production Electron renderer/IPC, actual authenticated
 * Pi provider, native tools, real files, branching, cold restart and regeneration.
 * Uses an isolated profile, never logs credentials, never modifies user tasks.
 * Run after pnpm build. Real model requests may incur provider charges. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const assert = require('node:assert/strict');
const root = process.cwd();
const output = path.join(root, 'out/tests/conversation-branch-live');
fs.mkdirSync(output, { recursive: true });
const file = path.join(output, 'report.json');
const report = { result: 'RUNNING', phase: 'starting', startedAt: new Date().toISOString(), checks: [], scenarios: {}, errors: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
const phase = value => { report.phase = value; save(); console.log(value); };
const check = (name, condition) => { assert(condition, name); report.checks.push(name); save(); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-branch-live-'));
const dir = path.join(profile, '.mybuddy');
fs.mkdirSync(dir, { recursive: true });
const userDir = path.join(os.homedir(), '.mybuddy');
for (const name of ['auth.json', 'models.json', 'models-store.json']) {
  if (fs.existsSync(path.join(userDir, name))) fs.copyFileSync(path.join(userDir, name), path.join(dir, name));
}
const modelId = process.env.MYBUDDY_BRANCH_LIVE_MODEL || 'commandcode/deepseek/deepseek-v4.1-flash';
const split = modelId.indexOf('/');
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
  defaultProvider: modelId.slice(0, split), defaultModel: modelId.slice(split + 1), defaultThinkingLevel: 'high',
  enabledModels: [modelId], conversationBranchEnabled: true, memoryEnabled: false, memoryGatewayEnabled: false,
  remoteAccessEnabled: false, closeToTray: false, theme: 'light', language: 'zh-CN', permissionMode: 'auto',
  cacheWarming: 'off', retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
}));
fs.writeFileSync(path.join(dir, 'capabilities.json'), JSON.stringify({ schemaVersion: 1,
  web: { enabled: false }, vision: { enabled: false }, imageGeneration: { enabled: false }, videoGeneration: { enabled: false },
  speechToText: { enabled: false }, textToSpeech: { enabled: false }, browser: { enabled: false },
  execution: { terminalEnabled: false, codeExecutionEnabled: false }, subagent: { enabled: false }, multiModelConsult: { enabled: false },
}));
for (const d of ['AppData/Roaming', 'AppData/Local']) fs.mkdirSync(path.join(profile, d), { recursive: true });
const env = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local') };
delete env.ELECTRON_RUN_AS_NODE;
let proc, socket, port, rpcId = 0, log;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function until(expression, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    if (proc.exitCode !== null) throw Error('Test Electron exited unexpectedly');
    await sleep(200);
  }
  throw Error('Timed out: ' + expression.slice(0, 180));
}
async function startApp() {
  port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
  });
  log = fs.openSync(path.join(output, 'runtime.log'), 'a');
  proc = cp.spawn(require('electron'), [path.join(root, 'out/main/index.js'), '--remote-debugging-port=' + port,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { cwd: root, env, stdio: ['ignore', log, log], windowsHide: true });
  report.pids = [...(report.pids || []), proc.pid]; save();
  let target;
  for (let i = 0; i < 140; i++) {
    if (proc.exitCode !== null) throw Error('Test application failed to start');
    try { target = (await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch {}
    if (target) break; await sleep(350);
  }
  if (!target) throw Error('No test renderer debugging target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const m = JSON.parse(event.data); const item = pending.get(m.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(m.id); m.error ? item.reject(Error(JSON.stringify(m.error))) : item.resolve(m.result); };
  await until('!!window.api?.agent && !!document.querySelector(".input-area textarea")', 60000);
  await evaluate(`(()=>{
    window.__branchErrors=[]; window.addEventListener('error',e=>window.__branchErrors.push(e.message));
    window.addEventListener('unhandledrejection',e=>window.__branchErrors.push(String(e.reason)));
    window.__branchProbe={done:false,text:'',tools:[],events:[]};
    window.api.agent.onEvent(e=>{const p=window.__branchProbe;if(!p)return;
      if(e.type==='assistant_start'&&!p.messageId){p.taskId=e.taskId;p.messageId=e.messageId;}
      if(e.taskId!==p.taskId||(e.messageId&&e.messageId!==p.messageId))return;
      if(e.type==='text_delta')p.text+=e.delta;
      if(e.type==='tool_start')p.tools.push({id:e.toolCallId,name:e.tool});
      if(e.type==='assistant_end'){p.done=true;p.error=e.error;}
      p.events.push({type:e.type,at:Date.now()});if(p.events.length>400)p.events.shift();
    });return true;
  })()`);
}
async function stopApp() {
  if (socket?.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify({ id: ++rpcId, method: 'Browser.close' })); } catch {}
  }
  if (proc) {
    for (let i = 0; i < 30 && proc.exitCode === null; i++) await sleep(100);
    if (proc.exitCode === null) cp.spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    for (let i = 0; i < 30 && proc.exitCode === null; i++) await sleep(100);
  }
  try { socket?.close(); } catch {}
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('test renderer stopped')); } pending.clear();
  if (log !== undefined) { fs.closeSync(log); log = undefined; }
}
async function resetProbe() { await evaluate('window.__branchProbe={done:false,text:"",tools:[],events:[]}'); }
async function send(text) {
  await resetProbe();
  await evaluate(`(()=>{const e=[...document.querySelectorAll('.input-area textarea')].find(e=>e.getBoundingClientRect().width>0);
    if(!e)throw Error('No composer');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});
    e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(100);
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
async function task(id) { return evaluate(`(async()=>{const ts=await window.api.db.listTasks();return ts.find(t=>t.id===${JSON.stringify(id)})})()`); }
async function history(id) { return evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(id)})`); }
async function artifacts(id) {
  const result = await evaluate(`window.api.artifactDomain.list({taskId:${JSON.stringify(id)}})`);
  return Array.isArray(result) ? result : result.artifacts || result.items || result.descriptors || [];
}
async function finish(name) {
  await until('window.__branchProbe.done || document.querySelector(".msg-generate-error")', 360000);
  await sleep(400);
  const p = await evaluate('window.__branchProbe');
  report.scenarios[name] = p; save();
  check(name + ': actual model completed without runtime error', p.done && !p.error);
  const h = await history(p.taskId); report.scenarios[name].history = h; save();
  check(name + ': real response persisted', h.messages.some(m => m.role === 'assistant' && (m.text || '').trim()));
  return { p, h };
}
async function openTask(id) {
  const t = await task(id); assert(t, 'persisted task exists');
  await until(`[...document.querySelectorAll('.task-item')].some(e=>e.querySelector('.task-item-title')?.textContent===${JSON.stringify(t.title)})`, 60000);
  await evaluate(`[...document.querySelectorAll('.task-item')].find(e=>e.querySelector('.task-item-title')?.textContent===${JSON.stringify(t.title)}).click()`);
  await sleep(400); return t;
}
async function screenshot(name) { const shot = await rpc('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64')); }
async function regenerate(index, name) {
  await resetProbe();
  await evaluate(`(()=>{const xs=[...document.querySelectorAll('button[title="重新生成"]')];const el=xs[${index}<0?xs.length-1:${index}];if(!el||el.disabled)throw Error('No regenerate button');el.click();return true})()`);
  return finish(name);
}
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
(async () => {
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const token = crypto.randomBytes(5).toString('hex');
    const base = 'BASE_' + token, later = 'LATER_' + token, childMark = 'CHILD_' + token, fresh = 'FRESH_' + token;
    report.model = modelId; report.profile = profile; report.markers = { base, later, childMark, fresh }; save();
    await startApp();
    const models = await evaluate('window.api.agent.listModels()');
    check('selected actual Pi provider is available', models.some(m => m.id === modelId && m.available !== false && m.enabled !== false));
    phase('real-parent-file-write');
    await send(`请用 write 工具在当前任务目录创建 branch-base.md，内容必须是 ${base}。完成后只回复 BASE_DONE。不要用 shell，不要委派任务。`);
    await until('window.__branchProbe.taskId');
    const busy = await evaluate(`window.api.conversationBranch.create({sourceTaskId:window.__branchProbe.taskId,userMessageIndex:0,position:'after_user',requestId:'busy-${token}'})`);
    check('branching a running real task is rejected', !busy.ok && busy.code === 'TASK_BUSY');
    const first = await finish('parent-base'); const parentId = first.p.taskId;
    const parent = await task(parentId); report.parentId = parentId;
    check('task workspace is isolated from user files', path.resolve(parent.cwd).startsWith(path.resolve(profile) + path.sep));
    check('real model used native write', first.p.tools.some(t => t.name === 'write'));
    check('real base file contains expected content', fs.readFileSync(path.join(parent.cwd, 'branch-base.md'), 'utf8').trim() === base);
    phase('real-parent-second-turn');
    await send(`请用 write 工具创建 branch-later.md，内容必须是 ${later}。完成后只回复 LATER_DONE。不要用 shell。`);
    await finish('parent-later');
    const parentHistory = await history(parentId); const parentHash = hash(parentHistory.sessionFile);
    const sourceArtifacts = await artifacts(parentId); report.parentArtifacts = sourceArtifacts; save();
    check('real tools registered two parent artifacts', sourceArtifacts.length >= 2);
    phase('fork-first-reply-through-real-ui');
    await until('document.querySelectorAll(\'button[title="从这里创建分支"]\').length>=2');
    await evaluate('document.querySelectorAll(\'button[title="从这里创建分支"]\')[0].click()');
    const children = await until(`window.api.conversationBranch.listChildren(${JSON.stringify(parentId)}).then(xs=>xs.length?xs:false)`);
    const childId = children[0].childTaskId; report.childId = childId;
    await until('!!document.querySelector(".conv-branch-chip")');
    const child = await task(childId); const childHistory = await history(childId);
    check('UI fork creates independent task and session', childId !== parentId && child.sessionFile !== parentHistory.sessionFile);
    check('child history stops at selected reply', childHistory.messages.filter(m => m.role === 'user').length === 1 && !JSON.stringify(childHistory.messages).includes(later));
    const childArtifacts = await artifacts(childId); report.childArtifacts = childArtifacts; save();
    check('native first-turn artifact inherited', childArtifacts.some(a => /branch-base/.test(JSON.stringify(a))));
    check('native later-turn artifact not inherited', !childArtifacts.some(a => /branch-later/.test(JSON.stringify(a))));
    check('parent session unchanged by fork', hash(parentHistory.sessionFile) === parentHash);
    check('current snapshot is explicitly current, not historical rollback', fs.existsSync(path.join(child.cwd, 'branch-later.md')));
    phase('real-child-context-and-file-isolation');
    const contextPrompt = '不要调用任何工具。只根据本会话已有聊天记录复述最初写入文件的 BASE 标记，然后输出 CHILD_CONTEXT_OK。';
    await send(contextPrompt); const recalled = await finish('child-context');
    check('real model receives the inherited branch context', recalled.p.text.includes(base) && !recalled.p.text.includes(later) && recalled.p.tools.length === 0);
    await send(`读取 branch-base.md，然后用 write 将内容改成 ${childMark}。最后只回复 CHILD_DONE。不要用 shell。`);
    await finish('child-edit');
    report.childFileProbe = { childCwd: child.cwd, parentCwd: parent.cwd,
      childText: fs.readFileSync(path.join(child.cwd, 'branch-base.md'), 'utf8'), parentText: fs.readFileSync(path.join(parent.cwd, 'branch-base.md'), 'utf8') };
    report.childSystemEntries = SessionManager.open(child.sessionFile).getBranch().filter(e => e.type === 'message' && e.message.role === 'system'); save();
    check('child real file changed', report.childFileProbe.childText.trim() === childMark);
    check('parent real file remains unchanged', fs.readFileSync(path.join(parent.cwd, 'branch-base.md'), 'utf8').trim() === base);
    await screenshot('child-branch');
    const beforeRestart = await history(childId);
    phase('cold-restart-and-reopen-child');
    report.errors.push(...await evaluate('window.__branchErrors')); await stopApp(); await startApp(); await openTask(childId);
    const reopened = await history(childId);
    check('cold restart preserves exact Pi history', JSON.stringify(reopened.messages) === JSON.stringify(beforeRestart.messages));
    check('cold restart restores branch lineage UI', await until('!!document.querySelector(".conv-branch-chip")'));
    await screenshot('child-after-restart');
    phase('regenerate-middle-turn-and-create-new-path');
    await until('document.querySelectorAll(\'button[title="重新生成"]\').length>=3');
    await regenerate(1, 'regenerate-middle');
    let native = SessionManager.open(child.sessionFile);
    check('middle regenerate excludes abandoned later user', native.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').length === 2);
    check('abandoned path retained in native tree', JSON.stringify(native.getTree()).includes(childMark));
    await send(`仅回复 ${fresh}，不要调用工具。`); await finish('fresh-path');
    await regenerate(-1, 'regenerate-fresh-1');
    await regenerate(-1, 'regenerate-fresh-2');
    const active = await history(childId); native = SessionManager.open(child.sessionFile);
    check('repeated regenerate does not duplicate active users', active.messages.filter(m => m.role === 'user').length === 3);
    check('repeated regenerate follows current path, not abandoned same-index user', active.messages.filter(m => m.role === 'assistant').at(-1).text.includes(fresh));
    check('native tree keeps history while active projection excludes abandoned edit', native.getEntries().length > native.getBranch().length && !JSON.stringify(native.buildSessionContext().messages).includes(childMark));
    check('all child operations leave parent session unchanged', hash(parentHistory.sessionFile) === parentHash);
    phase('delete-selected-user-on-current-branch');
    const lastUser = active.messages.filter(m => m.role === 'user').at(-1);
    await evaluate(`window.api.agent.deleteUserMessage(${JSON.stringify({ taskId: childId, userMessageIndex: 2, entryId: lastUser.entryId })})`);
    const afterDelete = await history(childId);
    check('delete removes only selected current-path user and its reply', afterDelete.messages.filter(m => m.role === 'user').length === 2 && !JSON.stringify(afterDelete.messages).includes(fresh));
    check('delete retains abandoned native tree without restoring it to context', JSON.stringify(SessionManager.open(child.sessionFile).getTree()).includes(fresh));
    phase('real-user-only-fork-and-generate');
    const originalUser = parentHistory.messages.find(m => m.role === 'user');
    const only = await evaluate(`window.api.conversationBranch.create(${JSON.stringify({ sourceTaskId: parentId, entryId: originalUser.entryId, position: 'after_user', workspaceStrategy: 'conversation_only', requestId: 'user-only-' + token })})`);
    check('user-only task is created with persisted session', only.ok && fs.existsSync(only.result.task.sessionFile));
    const onlyTask = only.result.task; report.userOnlyTaskId = onlyTask.id;
    const onlyHistory = await history(onlyTask.id);
    await resetProbe();
    const request = { taskId: onlyTask.id, requestId: 'root-regen-' + token, userMessageIndex: 0, sourceUserEntryId: originalUser.entryId,
      sourceUserMessageId: onlyHistory.messages[0].id, sourceAssistantMessageId: 'source-' + token, assistantMessageId: 'root-reply-' + token, modelId, permissionMode: 'auto' };
    await evaluate(`(()=>{window.__rootResult=null;window.api.agent.regenerate(${JSON.stringify(request)}).then(r=>window.__rootResult=r,e=>window.__rootResult={ok:false,error:String(e)});return true})()`);
    await finish('user-only-generate');
    const rootResult = await until('window.__rootResult'); check('user-only regeneration returns success', rootResult.ok);
    const rootSession = SessionManager.open(onlyTask.sessionFile);
    check('current-leaf no-op cannot duplicate the root user', rootSession.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').length === 1);
    check('real root-only model task writes its own file', fs.readFileSync(path.join(onlyTask.cwd, 'branch-base.md'), 'utf8').trim() === base);
    report.errors.push(...await evaluate('window.__branchErrors'));
    check('no renderer exceptions across real tasks and restart', report.errors.length === 0);
    report.result = 'PASS'; report.phase = 'complete';
  } catch (error) {
    report.result = 'FAIL'; report.error = String(error.stack || error); process.exitCode = 1;
    try { report.failedDOM = await evaluate('document.body.innerText.slice(-6000)'); await screenshot('failure'); } catch {}
  } finally {
    report.finishedAt = new Date().toISOString(); save();
    await stopApp();
    // Only delete the uniquely created test profile, including its credential copy.
    if (path.basename(profile).startsWith('mybuddy-branch-live-') && path.dirname(profile) === os.tmpdir()) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); report.profileCleaned = true; }
      catch (e) { for (const name of ['auth.json', 'models.json', 'models-store.json']) try { fs.rmSync(path.join(dir, name), { force: true }); } catch {}
        report.cleanupError = String(e); report.result = 'FAIL'; process.exitCode = 1; }
    }
    save(); console.log(JSON.stringify({ result: report.result, checks: report.checks.length, file }));
  }
})();
