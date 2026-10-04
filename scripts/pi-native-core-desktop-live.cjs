/** Real provider -> built Electron -> composer/IPC -> installed Pi core tools, in a disposable profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');

const root = path.resolve(__dirname, '..');
const main = path.join(root, 'out/main/index.js');
const out = process.env.PI_NATIVE_CORE_ARTIFACT_DIR
  ? path.resolve(root, process.env.PI_NATIVE_CORE_ARTIFACT_DIR)
  : path.join(root, 'artifacts/pi-native-core/desktop-live');
fs.mkdirSync(out, { recursive: true });
const lock = path.join(out, 'acceptance.lock');
try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' }); }
catch (error) { if (error.code === 'EEXIST') { console.error('Core desktop acceptance is already running.'); process.exit(2); } throw error; }
process.on('exit', () => { try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock); } catch {} });

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-pi-core-desktop-'));
const profile = path.join(temporary, 'profile');
const agentDir = path.join(profile, '.mybuddy');
const workspace = path.join(temporary, 'workspace');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
for (const suffix of ['AppData/Roaming', 'AppData/Local']) fs.mkdirSync(path.join(profile, suffix), { recursive: true });
const source = path.join(os.homedir(), '.mybuddy');
const sourceSettings = JSON.parse(fs.readFileSync(path.join(source, 'settings.json'), 'utf8'));
const selectedModel = process.env.PI_NATIVE_CORE_MODEL || `${sourceSettings.defaultProvider}/${sourceSettings.defaultModel}`;
assert(selectedModel.includes('/') && !selectedModel.includes('undefined'), 'A configured real provider/model is required');
const slash = selectedModel.indexOf('/');
for (const name of ['auth.json', 'models.json', 'models-store.json']) {
  const file = path.join(source, name);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(agentDir, name));
}
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
  defaultProvider: selectedModel.slice(0, slash), defaultModel: selectedModel.slice(slash + 1),
  defaultThinkingLevel: 'off', enabledModels: [selectedModel],
  memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false,
  theme: 'light', language: 'zh-CN', permissionMode: 'default', proxyUrl: sourceSettings.proxyUrl || '',
}));
fs.writeFileSync(path.join(agentDir, 'mcp.json'), '{"mcpServers":{}}');
const capabilities = { schemaVersion: 1, execution: { terminalEnabled: true, codeExecutionEnabled: false } };
for (const key of ['web', 'vision', 'imageGeneration', 'videoGeneration', 'speechToText', 'textToSpeech', 'browser', 'diagnostics', 'subagent', 'multiModelConsult']) capabilities[key] = { enabled: false };
fs.writeFileSync(path.join(agentDir, 'capabilities.json'), JSON.stringify(capabilities));

const nonce = crypto.randomBytes(8).toString('hex');
const seed = path.join(workspace, 'seed.txt');
const result = path.join(workspace, 'result.txt');
const probe = path.join(workspace, 'probe.cjs');
const probeAudit = path.join(workspace, 'probe.json');
const slow = path.join(workspace, 'slow.cjs');
const slowStarted = path.join(workspace, 'slow-started.json');
const lateMarker = path.join(workspace, 'slow-finished.txt');
fs.writeFileSync(seed, `nonce=${nonce}\nphase=before\n`);
fs.writeFileSync(probe, `const fs=require('node:fs');const content=fs.readFileSync(${JSON.stringify(result)},'utf8');const report={content,hostEnvironmentKeys:Object.keys(process.env).filter(k=>/^MYBUDDY_/i.test(k)).sort()};fs.writeFileSync(${JSON.stringify(probeAudit)},JSON.stringify(report));if(content!==${JSON.stringify(`nonce=${nonce}\nphase=after\n`)}||report.hostEnvironmentKeys.length){console.error('NATIVE_PROBE_FAILED');process.exit(9);}console.log('NATIVE_PROBE_OK');`);
fs.writeFileSync(slow, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(slowStarted)},JSON.stringify({pid:process.pid,startedAt:Date.now()}));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(lateMarker)},'UNEXPECTED_LATE_SIDE_EFFECT');console.log('UNEXPECTED_LATE_SIDE_EFFECT');},9000);`);
const shellQuote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
const probeCommand = `${shellQuote(process.execPath)} ${shellQuote(probe)}`;
const slowCommand = `${shellQuote(process.execPath)} ${shellQuote(slow)}`;
const forbiddenOutput = /read-back verified|Evidence:|executionVerification|Bounded raw preview|verification requires an active main-process|Write requires an active main-process|Edit requires an active main-process/i;
const report = { kind: 'pi-native-core-real-provider-source-electron', artifactDir: out, model: selectedModel, nonce, startedAt: new Date().toISOString(), tests: [], status: 'running' };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let child, socket, fd, requestId = 0;
const requests = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { requests.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
    requests.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result?.value;
}
async function until(expression, limit = 30000) {
  const started = Date.now();
  while (Date.now() - started < limit) { const value = await evaluate(expression); if (value) return value; await delay(150); }
  throw Error('Timed out awaiting desktop state: ' + expression);
}
async function capture(name) {
  const shot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function newTask() {
  await evaluate(`(()=>{const e=document.querySelector('button[title="新建任务"]');if(e)e.click();return true;})()`);
  await until('Boolean(document.querySelector(".hero textarea"))');
  await evaluate(`(()=>{const e=[...document.querySelectorAll('.hero-categories button')].find(e=>e.textContent.trim()==='代码开发');if(!e)throw Error('Code scene unavailable');e.click();return true;})()`);
  await delay(100);
  await evaluate(`(()=>{const e=[...document.querySelectorAll('.hero-scenes button')].find(e=>e.textContent.trim()==='最小模式');if(e)e.click();return true;})()`);
}
async function submit(prompt) {
  await newTask();
  await evaluate(`window.__nativeCore.current={tools:[],text:'',started:false,done:false,textEvents:0}`);
  await evaluate(`(()=>{const e=document.querySelector('textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(prompt)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await delay(100);
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await until('window.__nativeCore.current.started', 25000);
}
async function assertChatControls(taskId) {
  const controls = await evaluate(`(()=>{const header=document.querySelector('.task-chat-header');if(!header)throw Error('Chat header unavailable');const input=document.querySelector('.input-box textarea');return {headerButtons:[...header.querySelectorAll('button')].map(e=>({text:e.textContent.trim(),title:e.title})),retiredSurfaces:[...document.querySelectorAll('[class*="conversation-todo"],[class*="conversation-plan"]')].map(e=>e.className),goal:Boolean(header.querySelector('.conversation-goal-chip')),input:Boolean(input&&!input.disabled)};})()`);
  assert(controls.goal, 'Goal button is missing from the real chat header');
  assert(controls.input, 'The real chat composer is unavailable');
  assert.equal(controls.retiredSurfaces.length, 0, 'Retired Todo/Plan controls or popovers remain mounted');
  assert(!controls.headerButtons.some(button => /^(todo|plan)(?:\b|$)/i.test(button.text) || /conversation[_ -]?(todo|plan)/i.test(button.title)), 'Retired Todo/Plan header button remains');
  const snapshot = await evaluate(`window.api.conversationRuntime.snapshot(${JSON.stringify(taskId)})`);
  assert.equal(snapshot.taskId, taskId);
  assert(Array.isArray(snapshot.interactions), 'User input interaction snapshot is unavailable');
  for (const field of ['todos', 'activePlan']) assert(!Object.hasOwn(snapshot, field), 'Retired snapshot field remains: ' + field);
  return { headerButtons: controls.headerButtons, retiredSurfaces: controls.retiredSurfaces, snapshotKeys: Object.keys(snapshot).sort(), goalAvailable: true, composerAvailable: true };
}
async function assertGoalAndInput(taskId) {
  await evaluate(`(()=>{document.querySelector('.task-chat-header .conversation-goal-chip').click();return true;})()`);
  await until('Boolean(document.querySelector(".conversation-goal-dialog"))');
  const title = `Desktop retained Goal ${nonce}`;
  await evaluate(`(()=>{const e=document.querySelector('.conversation-goal-dialog input');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(title)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await until('Boolean(document.querySelector(".conversation-goal-dialog button.primary:not(:disabled)"))');
  await evaluate(`(()=>{document.querySelector('.conversation-goal-dialog button.primary').click();return true;})()`);
  await until('!document.querySelector(".conversation-goal-dialog")');
  const created = await until(`window.api.conversationRuntime.snapshot(${JSON.stringify(taskId)}).then(s=>s.activeGoal?.title===${JSON.stringify(title)}&&s.activeGoal)`);
  await until(`document.querySelector('.task-chat-header .conversation-goal-chip-label')?.textContent===${JSON.stringify(title)}`);
  await capture('retained-goal-created');
  await evaluate(`(()=>{document.querySelector('.task-chat-header .conversation-goal-chip').click();return true;})()`);
  await until('Boolean(document.querySelector(".conversation-goal-dialog button.danger:not(:disabled)"))');
  await evaluate(`(()=>{document.querySelector('.conversation-goal-dialog button.danger').click();return true;})()`);
  await until('!document.querySelector(".conversation-goal-dialog")');
  await until(`window.api.conversationRuntime.snapshot(${JSON.stringify(taskId)}).then(s=>!s.activeGoal)`);
  const text = `Retained composer ${nonce}`;
  await evaluate(`(()=>{const e=document.querySelector('.input-box textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await until(`document.querySelector('.input-box textarea')?.value===${JSON.stringify(text)}`);
  await evaluate(`(()=>{const e=document.querySelector('.input-box textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await until('document.querySelector(".input-box textarea")?.value===""');
  return { goalCreatedViaUi: true, goalCancelledViaUi: true, goalId: created.id, composerAcceptedAndClearedText: true };
}
async function assertReopenedHistory(taskId) {
  const task = await evaluate(`window.api.db.listTasks().then(tasks=>tasks.find(t=>t.id===${JSON.stringify(taskId)}))`);
  assert(task?.sessionFile, 'Completed chat must persist its real Pi session');
  const before = await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
  assert(before.messages.some(message => message.role === 'user' && message.text.includes('执行一个短真实工具验收')), 'Ordinary user history is missing');
  assert(before.messages.some(message => message.role === 'assistant' && message.text.trim()), 'Ordinary assistant history is missing');
  await newTask();
  await until(`Boolean([...document.querySelectorAll('.task-item')].find(e=>e.querySelector('.task-item-title')?.textContent===${JSON.stringify(task.title)}))`);
  await evaluate(`(()=>{const e=[...document.querySelectorAll('.task-item')].find(e=>e.querySelector('.task-item-title')?.textContent===${JSON.stringify(task.title)});e.click();return true;})()`);
  await until(`document.querySelector('.task-chat-header .chat-header-title')?.textContent===${JSON.stringify(task.title)}`);
  await until('Boolean(document.querySelector(".message-scroll"))');
  await evaluate(`(()=>{const e=document.querySelector('.message-scroll');e.scrollTop=0;e.dispatchEvent(new Event('scroll'));return true;})()`);
  await until('Boolean(document.querySelector(".message-scroll")?.textContent.includes("执行一个短真实工具验收"))');
  const after = await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
  assert.deepEqual(after.messages.map(message => ({id:message.id,role:message.role,text:message.text})), before.messages.map(message => ({id:message.id,role:message.role,text:message.text})), 'Reopening changed ordinary conversation history');
  return { reopenedViaSidebar: true, ordinaryMessagesUnchanged: true, messages: after.messages.length, controls: await assertChatControls(taskId) };
}
function sessionMessages() {
  const messages = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.jsonl')) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
        const value = JSON.parse(line);
        if (value.message) messages.push(value.message);
      }
    }
  }
  walk(path.join(agentDir, 'sessions'));
  return messages;
}
async function test(name, prompt, check, cancel = false) {
  const row = { name, startedAt: new Date().toISOString(), status: 'running' };
  report.tests.push(row); save();
  try {
    await submit(prompt);
    if (cancel) {
      const end = Date.now() + 90000;
      while (!fs.existsSync(slowStarted) && Date.now() < end) { await delay(100); const state = await evaluate('window.__nativeCore.current'); if (state.done) throw Error('Slow command never started'); }
      assert(fs.existsSync(slowStarted), 'A real shell child must start before cancellation');
      const state = await evaluate('window.__nativeCore.current');
      assert(state.tools.some(tool => tool.name === 'bash'), 'Cancel must target an actual bash call');
      row.cancelledAt = Date.now();
      await evaluate(`window.api.agent.abort(${JSON.stringify(state.taskId)})`);
    }
    const state = await until('window.__nativeCore.current.done&&window.__nativeCore.current', 180000);
    row.tools = state.tools; row.finalText = state.text; row.assistantError = state.error; row.taskId = state.taskId;
    assert(!state.tools.some(tool => tool.approval), 'Native core requested a retired product approval');
    for (const tool of state.tools) assert(!forbiddenOutput.test(tool.output || ''), 'Retired core output reached desktop: ' + tool.name);
    if (!cancel) assert(!state.error, 'Assistant failed: ' + state.error);
    row.result = await check(state);
    row.status = 'passed'; console.log('PASS actual Electron ' + name);
  } catch (error) {
    row.status = 'failed'; row.error = error.message;
    try { row.state = await evaluate('window.__nativeCore.current'); if (row.state.taskId && !row.state.done) await evaluate(`window.api.agent.abort(${JSON.stringify(row.state.taskId)})`); } catch {}
    console.error('FAIL actual Electron ' + name + ': ' + error.message);
  } finally { row.finishedAt = new Date().toISOString(); try { await capture(name); } catch {} save(); }
}

(async () => {
  try {
    const executable = process.env.PI_NATIVE_CORE_DESKTOP_EXE;
    if (executable) {
      assert(fs.existsSync(executable), 'Requested packaged desktop executable is missing');
      report.executable = path.resolve(executable);
      report.kind = 'pi-native-core-real-provider-packaged-electron';
      const archive = path.join(path.dirname(report.executable), 'resources/app.asar');
      assert(fs.existsSync(archive), 'Packaged desktop archive is missing');
      report.asarSha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    } else {
      assert(fs.existsSync(main), 'Run pnpm build before this acceptance');
      report.mainBuildSha256 = crypto.createHash('sha256').update(fs.readFileSync(main)).digest('hex');
    }
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
    const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'), PI_CODING_AGENT_DIR: agentDir };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(env)) if (/^MYBUDDY_/i.test(key)) delete env[key];
    fd = fs.openSync(path.join(out, 'desktop.log'), 'w');
    const arguments_ = [
      ...(executable ? [] : [main]), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ];
    child = cp.spawn(executable || require('electron'), arguments_, { cwd: profile, env, stdio: ['ignore', fd, fd], windowsHide: true });
    report.pid = child.pid; save();
    let page;
    for (let index = 0; index < 120; index++) {
      try { page = (await fetch('http://127.0.0.1:' + port + '/json/list').then(response => response.json())).find(item => item.type === 'page' && !item.url.startsWith('devtools')); if (page) break; } catch {}
      if (child.exitCode !== null) throw Error('Electron exited before readiness: ' + child.exitCode);
      await delay(250);
    }
    assert(page, 'Actual Electron renderer unavailable');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => { const message = JSON.parse(event.data); const pending = requests.get(message.id); if (!pending) return; requests.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(Error(JSON.stringify(message.error))) : pending.resolve(message.result); });
    await rpc('Runtime.enable');
    await until('Boolean(window.api?.agent&&document.querySelector("textarea"))');
    const models = await evaluate('window.api.agent.listModels().then(rows=>rows.map(m=>({id:m.id,provider:m.provider,available:m.available,enabled:m.enabled})))');
    assert(models.some(model => model.available !== false && (model.id === selectedModel || `${model.provider}/${model.id}` === selectedModel)), 'Selected configured model is unavailable');
    await evaluate(`(()=>{window.__nativeCore={current:null,errors:[]};window.addEventListener('error',e=>window.__nativeCore.errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__nativeCore.errors.push(String(e.reason)));window.api.agent.onEvent(e=>{const s=window.__nativeCore.current;if(!s)return;if(e.taskId)s.taskId=e.taskId;if(e.type==='assistant_start'){s.started=true;s.messageId=e.messageId;s.done=false;}if(e.type==='text_delta'){s.textEvents++;s.text+=e.delta||'';}if(e.type==='tool_start')s.tools.push({id:e.toolCallId,name:e.tool,parent:e.parentToolCallId,summary:e.summary,status:e.status,approval:e.status==='pending_approval'});if(e.type==='tool_update'){const t=s.tools.find(t=>t.id===e.toolCallId);if(t){if(e.status)t.status=e.status;if(e.output)t.output=String(e.output);if(e.status==='pending_approval')t.approval=true;}}if(e.type==='assistant_end'){s.done=true;s.error=e.error;s.finishedAt=Date.now();}});return true;})()`);
    const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
    if (!only || only === 'core') await test('four-native-core-tools', `执行一个短真实工具验收，只按以下顺序调用原生 read、write、edit、bash，禁止 codemode、execute_code、MCP 或其他工具。\n1. read 读取 ${JSON.stringify(seed.replaceAll('\\', '/'))}，取得未知 nonce。\n2. write 创建 ${JSON.stringify(result.replaceAll('\\', '/'))}，内容逐字复制 seed（保留换行）。\n3. edit 把该文件唯一的 phase=before 替换成 phase=after，保留 nonce，使用 edits 数组。\n4. bash 的 command 精确为 ${JSON.stringify(probeCommand)}，timeout=10，不追加命令。它真实验证文件和环境。完成后一句话总结。不要规划、重试或自行创建验证器。`, async state => {
      for (const name of ['read', 'write', 'edit', 'bash']) assert(state.tools.some(tool => tool.name === name && tool.status === 'success'), 'Native tool did not complete: ' + name);
      assert(!state.tools.some(tool => tool.parent || !['read', 'write', 'edit', 'bash'].includes(tool.name)), 'Core test used a wrapper or unrelated tool');
      assert.equal(fs.readFileSync(result, 'utf8'), `nonce=${nonce}\nphase=after\n`);
      const observed = JSON.parse(fs.readFileSync(probeAudit, 'utf8'));
      assert.deepEqual(observed.hostEnvironmentKeys, [], 'Native shell received injected MYBUDDY environment');
      const messages = sessionMessages().filter(message => message.role === 'toolResult');
      const writeResult = messages.find(message => message.toolName === 'write');
      const editResult = messages.find(message => message.toolName === 'edit');
      assert(writeResult?.content.some(part => /Successfully wrote to /.test(part.text || '')), 'Native write result is missing');
      assert(editResult?.content.some(part => /Successfully replaced 1 block\(s\)/.test(part.text || '')), 'Native edit result is missing');
      for (const message of messages) assert(!forbiddenOutput.test(JSON.stringify(message)), 'Pi transcript contains retired tool evidence');
      const controls = await assertChatControls(state.taskId);
      const retainedInteractions = await assertGoalAndInput(state.taskId);
      const reopenedHistory = await assertReopenedHistory(state.taskId);
      return { tools: state.tools.map(tool => tool.name), externalTargetWorkedWithoutApproval: true, environmentKeys: observed.hostEnvironmentKeys, nativeTranscriptResults: true, controls, retainedInteractions, reopenedHistory };
    });
    if (!only || only === 'nonzero') await test('native-nonzero-failure', '只调用一次原生 bash，command 精确为 printf NATIVE_NONZERO; exit 7。不要追加 echo、不要用 || true、不要调用其他工具，不要重试。工具失败后如实说明退出码并结束。', state => {
      const calls = state.tools.filter(tool => tool.name === 'bash');
      assert.equal(calls.length, 1); assert.equal(calls[0].status, 'error');
      assert.match(calls[0].output, /NATIVE_NONZERO/); assert.match(calls[0].output, /code 7|exit_code[^0-9]*7/);
      return { nativeExitCode: 7, errorVisible: true, invocations: 1 };
    });
    if (!only || only === 'cancel') await test('native-running-command-cancellation', `只调用一次原生 bash，command 精确为 ${JSON.stringify(slowCommand)}，timeout=30。不要调用其他工具，不要修改脚本，不要重试。执行中用户将停止任务。`, async state => {
      const calls = state.tools.filter(tool => tool.name === 'bash');
      assert.equal(calls.length, 1); assert.equal(calls[0].status, 'error');
      assert.match(calls[0].output || '', /aborted|cancel/i);
      await delay(10000);
      assert(!fs.existsSync(lateMarker), 'Native cancellation failed to terminate the running shell child');
      return { actualShellStarted: true, stoppedBeforeLateSideEffect: true, invocations: 1 };
    }, true);
    report.rendererErrors = await evaluate('window.__nativeCore.errors');
    assert.deepEqual(report.rendererErrors, []);
    const transcript = sessionMessages();
    report.observedModels = [...new Set(transcript.filter(message => message.role === 'assistant').map(message => `${message.provider}/${message.model}`))];
    assert(report.observedModels.includes(selectedModel), 'A real configured provider response must be persisted');
    if (report.executable) {
      const archive = path.join(path.dirname(report.executable), 'resources/app.asar');
      const finalHash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
      assert.equal(finalHash, report.asarSha256, 'Packaged build changed during desktop acceptance');
    }
    report.status = report.tests.length && report.tests.every(test => test.status === 'passed') ? 'passed' : 'failed';
  } catch (error) { report.status = 'failed'; report.error = error.message; console.error('Core desktop acceptance failed: ' + error.message); }
  finally {
    try { if (socket?.readyState === WebSocket.OPEN) await rpc('Browser.close'); } catch {}
    socket?.close(); for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(Error('Desktop closed')); } requests.clear();
    await delay(700);
    if (child?.exitCode === null) { try { cp.execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch {} }
    if (fd !== undefined) fs.closeSync(fd);
    const resolved = path.resolve(temporary);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('mybuddy-pi-core-desktop-'), 'Cleanup escaped the disposable test directory');
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); report.temporaryCredentialsRemoved = true; }
    catch (error) { report.cleanupError = error.message; report.status = 'failed'; }
    report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ status: report.status, report: path.join(out, 'results.json') }));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
})();
