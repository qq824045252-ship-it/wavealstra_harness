/** Actual renderer + IPC + SQLite + filesystem archive deletion, in a disposable profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'out/tests/archive-deletion-desktop');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-archive-deletion-'));
const home = path.join(temp, 'profile');
const agentDir = path.join(home, '.mybuddy');
const databasePath = path.join(agentDir, 'app.db');
const managedRoot = path.join(agentDir, 'task-workspaces');
const trashRoot = path.join(agentDir, 'task-workspaces-trash');
const outsideParent = path.join(temp, 'linked-parent');
const outsideChild = path.join(temp, 'linked-child');
const outsideActive = path.join(temp, 'linked-active');
const parentSpaceId = 'archive-fixture-parent';
const childSpaceId = 'archive-fixture-child';
const activeSpaceId = 'archive-fixture-active';
const activeTaskId = 'archive-fixture-active-task';
const batchTasks = Array.from({ length: 12 }, (_, i) => ({
  id: `archive-fixture-task-${String(i + 1).padStart(2, '0')}`,
  title: `批量任务 ${String(i + 1).padStart(2, '0')}`,
}));
const cascadeTasks = [
  { id: 'archive-fixture-parent-task', title: '空间级联父任务', spaceId: parentSpaceId, cwd: outsideParent },
  { id: 'archive-fixture-child-task', title: '空间级联子任务', spaceId: childSpaceId, cwd: outsideChild },
];
const allTaskIds = [...batchTasks.map(task => task.id), ...cascadeTasks.map(task => task.id), activeTaskId];
const taskMemoryIds = new Map();
const workspaceMemoryIds = new Map();
let globalMemoryId;
const report = { startedAt: new Date().toISOString(), kind: 'actual-archive-deletion-desktop', profile: home, tests: [], status: 'running' };
for (const directory of [out, agentDir, managedRoot, trashRoot, path.join(agentDir, 'plugins/mcp'), path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(out, 'desktop.log'), '');
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
  baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'isolated-unused-fixture',
  models: [{ id: 'fixture', name: 'Archive fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enabledModels: ['fixture/fixture'],
  memoryEnabled: true, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light', permissionMode: 'readonly', proxyUrl: '' }));
fs.writeFileSync(path.join(agentDir, 'plugins/mcp/mcp.json'), '{"mcpServers":{}}');
fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
const disabledCapabilities = { schemaVersion: 1, execution: { terminalEnabled: false, codeExecutionEnabled: false } };
for (const key of ['web', 'vision', 'imageGeneration', 'videoGeneration', 'speechToText', 'textToSpeech', 'browser', 'diagnostics', 'subagent', 'multiModelConsult']) disabledCapabilities[key] = { enabled: false };
fs.writeFileSync(path.join(agentDir, 'capabilities.json'), JSON.stringify(disabledCapabilities));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(100); }
  throw Error('Timeout: ' + label);
}
async function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
let proc, socket, log, seq = 0;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const invoke = (method, ...args) => evaluate(`window.api.${method}(${args.map(value => JSON.stringify(value)).join(',')})`);
async function launch() {
  const port = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PI_CODING_AGENT_DIR;
  for (const key of Object.keys(env)) if (/^MYBUDDY_/i.test(key)) delete env[key];
  const executable = process.env.MYBUDDY_DESKTOP_EXECUTABLE || require('electron');
  log = fs.openSync(path.join(out, 'desktop.log'), 'a');
  proc = cp.spawn(executable, [...(process.env.MYBUDDY_DESKTOP_EXECUTABLE ? [] : [root]), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { cwd: root, env, stdio: ['ignore', log, log], windowsHide: true });
  report.executable = executable;
  const build = process.env.MYBUDDY_DESKTOP_EXECUTABLE ? path.join(path.dirname(executable), 'resources/app.asar') : path.join(root, 'out/main/index.js');
  report.buildSha256 = crypto.createHash('sha256').update(fs.readFileSync(build)).digest('hex');
  const target = await until(async () => {
    if (proc.exitCode !== null) throw Error('Electron exited before readiness: ' + proc.exitCode);
    try { return (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())).find(item => item.type === 'page' && item.url.includes('index.html')); }
    catch { return undefined; }
  }, 'Electron renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result);
  });
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate('Boolean(window.api?.db?.purgeArchivedContent && document.querySelector("button[title=设置]"))'), 'archive IPC and app ready');
  await evaluate('window.__archiveErrors=[]; window.addEventListener("error", event => window.__archiveErrors.push(event.message)); window.addEventListener("unhandledrejection", event => window.__archiveErrors.push(String(event.reason))); true');
  assert(fs.existsSync(databasePath), 'The test must initialize only its isolated app.db');
}
async function close() {
  if (socket) {
    try { await rpc('Browser.close'); } catch {}
    socket.close(); socket = undefined;
  }
  if (proc) {
    const ownProcess = proc; proc = undefined;
    await delay(500);
    if (ownProcess.exitCode === null && ownProcess.signalCode === null) {
      if (process.platform === 'win32') cp.execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(ownProcess.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else ownProcess.kill('SIGTERM');
      await until(() => ownProcess.exitCode !== null || ownProcess.signalCode !== null, 'own Electron process exits', 10000);
    }
  }
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Desktop closed')); }
  pending.clear();
  if (log !== undefined) { fs.closeSync(log); log = undefined; }
}
async function click(selector, text) {
  const expression = `(()=>{const list=[...document.querySelectorAll(${JSON.stringify(selector)})]; const element=${text === undefined ? 'list[0]' : `list.find(item => item.textContent.trim() === ${JSON.stringify(text)})`}; if(!element || element.disabled)throw Error('Missing or disabled click target: '+${JSON.stringify(text || selector)}); element.scrollIntoView({block:'center'}); const r=element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`;
  const point = await evaluate(expression);
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await delay(100);
}
async function search(query) {
  await evaluate(`(()=>{const element=document.querySelector('input[aria-label="搜索归档"]'); if(!element)throw Error('Search input missing');element.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(query)});element.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await delay(120);
}
async function screenshot(name) {
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function openArchives(category) {
  await click('button[title="设置"]');
  await click('.settings-nav-btn', '归档管理');
  await until(() => evaluate('Boolean(document.querySelector(".archive-management"))'), 'archive settings mounted');
  if (category === 'tasks') await click('.archive-management .record-tabs button', `任务 ${batchTasks.length + cascadeTasks.length}`);
}
function sqlRows(sql, ...params) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return database.prepare(sql).all(...params); } finally { database.close(); }
}
function count(table, column, ids) {
  if (!ids.length) return 0;
  return Number(sqlRows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${ids.map(() => '?').join(',')})`, ...ids)[0].n);
}
function directoryName(id) { return id + '--' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 16); }
function managedDirectory(id) { return path.join(managedRoot, directoryName(id)); }
function durableDirectory(id) { return path.join(agentDir, 'durable', crypto.createHash('sha256').update(id).digest('hex')); }
function sessionFile(id) { return path.join(agentDir, 'sessions', id + '.jsonl'); }
function remoteUploadsDirectory(id) { return path.join(agentDir, 'remote-uploads', id); }
function seedManagedFiles(id) {
  const directory = managedDirectory(id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.mybuddy-task.json'), JSON.stringify({ version: 1, taskId: id, createdAt: Date.now() }));
  fs.writeFileSync(path.join(directory, 'managed-sentinel.txt'), 'MANAGED_' + id);
  fs.mkdirSync(durableDirectory(id), { recursive: true });
  fs.writeFileSync(path.join(durableDirectory(id), 'sentinel.txt'), 'DURABLE_' + id);
  fs.mkdirSync(remoteUploadsDirectory(id), { recursive: true });
  fs.writeFileSync(path.join(remoteUploadsDirectory(id), 'sentinel.txt'), 'REMOTE_' + id);
  fs.mkdirSync(path.dirname(sessionFile(id)), { recursive: true });
  fs.writeFileSync(sessionFile(id), JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: directory }) + '\n');
}
function assertPreserved() {
  assert.equal(count('tasks', 'id', [activeTaskId]), 1, 'active sibling task must remain');
  assert.equal(count('spaces', 'id', [activeSpaceId]), 1, 'active sibling space must remain');
  assert.equal(count('memory_records', 'id', [globalMemoryId]), 1, 'global memory must remain');
  assert(fs.existsSync(managedDirectory(activeTaskId)), 'active task managed files must remain');
  assert(fs.existsSync(durableDirectory(activeTaskId)), 'active task Durable files must remain');
  assert(fs.existsSync(sessionFile(activeTaskId)), 'active task Pi history must remain');
  assert(fs.existsSync(remoteUploadsDirectory(activeTaskId)), 'active task remote attachments must remain');
  for (const directory of [outsideParent, outsideChild, outsideActive]) assert.equal(fs.readFileSync(path.join(directory, 'user-sentinel.txt'), 'utf8'), 'PRESERVE_USER_FILES');
}
function assertPurged(ids) {
  for (const table of ['tasks', 'task_execution_workspace_state', 'memory_turns', 'memory_pipeline_state', 'task_write_grants']) {
    assert.equal(count(table, table === 'tasks' ? 'id' : 'task_id', ids), 0, table + ' retained permanently deleted tasks');
  }
  assert.equal(count('memory_records', 'id', ids.map(id => taskMemoryIds.get(id))), 0, 'task-only memories must be forgotten');
  for (const id of ids) {
    assert(!fs.existsSync(managedDirectory(id)), 'managed task directory survived: ' + id);
    assert(!fs.existsSync(durableDirectory(id)), 'Durable task history survived: ' + id);
    assert(!fs.existsSync(sessionFile(id)), 'managed Pi history survived: ' + id);
    assert(!fs.existsSync(remoteUploadsDirectory(id)), 'remote uploaded attachments survived: ' + id);
  }
  assert.deepEqual(fs.readdirSync(trashRoot), [], 'permanent deletion left recoverable trash');
  assertPreserved();
}
async function seed() {
  for (const directory of [outsideParent, outsideChild, outsideActive]) {
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'user-sentinel.txt'), 'PRESERVE_USER_FILES');
  }
  for (const space of [
    { id: parentSpaceId, name: '归档级联空间', path: outsideParent },
    { id: childSpaceId, name: '未显式归档子空间', path: outsideChild, parentId: parentSpaceId },
    { id: activeSpaceId, name: '保留活动空间', path: outsideActive },
  ]) {
    const result = await invoke('db.upsertSpace', space);
    assert.equal(result.ok, true, result.error); assert.equal(result.space.id, space.id, 'space identity merged unexpectedly');
  }
  for (const [i, task] of [...batchTasks, ...cascadeTasks, { id: activeTaskId, title: '保留活动任务', spaceId: activeSpaceId, cwd: outsideActive }].entries()) {
    seedManagedFiles(task.id);
    await invoke('db.upsertTask', { ...task, updatedAt: Date.now() + i, executionBackend: 'pi', welcomeMode: 'coding', cwd: task.cwd || managedDirectory(task.id), sessionFile: sessionFile(task.id) });
    if (batchTasks.some(item => item.id === task.id)) await invoke('db.archiveTask', task.id, true);
    const memory = await invoke('memory.create', { kind: 'fact', title: 'TASK_MEMORY_' + task.id, content: 'Isolated task-owned archive evidence ' + task.id,
      scopeType: 'task', scopeId: task.id, sourceTaskId: task.id, sourceType: 'manual', explicit: true });
    taskMemoryIds.set(task.id, memory.id);
  }
  await invoke('db.archiveSpace', parentSpaceId, true);
  for (const id of [parentSpaceId, childSpaceId]) {
    const memory = await invoke('memory.create', { kind: 'fact', title: 'SPACE_MEMORY_' + id, content: 'Isolated workspace-only archive evidence ' + id,
      scopeType: 'workspace', scopeId: id, sourceType: 'manual', explicit: true });
    workspaceMemoryIds.set(id, memory.id);
  }
  globalMemoryId = (await invoke('memory.create', { kind: 'preference', title: 'GLOBAL_PRESERVED_MEMORY', content: 'Global archive fixture memory must remain', scopeType: 'global', sourceType: 'manual', explicit: true })).id;
  await close();
  const database = new DatabaseSync(databasePath);
  try {
    const now = Date.now();
    for (const id of allTaskIds) {
      database.prepare('INSERT INTO memory_turns (id, task_id, user_text, assistant_text, content_hash, captured_at, extraction_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('turn-' + id, id, 'archive fixture user', 'archive fixture assistant', 'hash-' + id, now, 'completed');
      database.prepare('INSERT INTO memory_pipeline_state (task_id, updated_at) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET updated_at=excluded.updated_at').run(id, now);
      database.prepare('INSERT INTO task_write_grants (task_id, path, created_at) VALUES (?, ?, ?)').run(id, outsideParent, now);
      database.prepare('INSERT INTO task_execution_workspace_state (task_id, directory_name, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO NOTHING')
        .run(id, directoryName(id), batchTasks.some(task => task.id === id) ? 'archived' : 'active', now, now);
    }
  } finally { database.close(); }
}

(async () => {
  try {
    await launch(); await seed(); await launch();
    const spaces = await invoke('db.listSpaces');
    assert.equal(spaces.find(space => space.id === childSpaceId).archived, false);
    assert.equal(spaces.find(space => space.id === childSpaceId).effectiveArchived, true);
    assert.equal(count('tasks', 'id', allTaskIds), allTaskIds.length);
    report.tests.push('isolated archived tasks and inherited archive subtree seeded through actual IPC; linked folders and active sibling preserved');
    await openArchives('tasks'); await search('批量任务');
    await until(() => evaluate('document.querySelector(".archive-management .record-pager").textContent.includes("共 12 条")'), '12 filtered archives across pages');
    assert.equal(await evaluate('document.querySelectorAll(".archive-card").length'), 8);
    await click('.archive-card input[type="checkbox"]');
    const firstSelected = await evaluate('document.querySelector(".archive-card.selected .archive-card-name").textContent');
    await click('.archive-management .record-pager button', '下一页');
    assert.equal(await evaluate('document.querySelectorAll(".archive-card").length'), 4);
    await click('.archive-card input[type="checkbox"]');
    assert(await evaluate('document.querySelector(".archive-management").textContent.includes("已选 2 项")'), 'selection must persist across pagination');
    await click('.archive-management .record-pager button', '上一页');
    assert.equal(await evaluate('document.querySelector(".archive-card.selected .archive-card-name").textContent'), firstSelected);
    await screenshot('cross-page-selection');
    await search('批量任务 01');
    assert.equal(await evaluate('document.querySelectorAll(".archive-card.selected").length'), 0, 'query must clear hidden selections');
    assert(await evaluate('document.querySelector(".archive-management").textContent.includes("已选 0 项")'));
    await search('批量任务');
    await click('.archive-management button', '选择全部匹配项（12）');
    assert(await evaluate('document.querySelector(".archive-management").textContent.includes("已选 12 项")'));
    await click('.archive-management button', '批量彻底删除');
    await until(() => evaluate('document.querySelector("[role=dialog]")?.textContent.includes("批量彻底删除归档？")'), 'bulk confirmation');
    await screenshot('bulk-confirmation');
    await click('[role="dialog"] button', '取消');
    assert.equal(count('tasks', 'id', allTaskIds), allTaskIds.length, 'cancel changed task database');
    assert.equal(count('memory_turns', 'task_id', allTaskIds), allTaskIds.length, 'cancel changed captured memory');
    assert.equal(count('memory_records', 'id', [...taskMemoryIds.values()]), allTaskIds.length, 'cancel changed owned memory');
    for (const id of allTaskIds) assert(fs.existsSync(managedDirectory(id)), 'cancel deleted managed task files');
    assertPreserved();
    report.tests.push('cross-page selection retained, filtering clears hidden selection, select-all spans all matching pages, cancellation changes no task or file');
    await click('.archive-management button', '批量彻底删除');
    await click('[role="dialog"] button', '彻底删除');
    await until(() => count('tasks', 'id', batchTasks.map(task => task.id)) === 0, 'batch permanent deletion committed');
    await until(() => evaluate('document.querySelector(".archive-operation-status")?.getAttribute("role") === "status" && document.querySelector(".archive-operation-status")?.textContent.includes("12 个任务")'), 'successful batch status');
    assertPurged(batchTasks.map(task => task.id));
    await screenshot('tasks-purged');
    report.tests.push('actual bulk confirmation purges task rows, lifecycle metadata, L0 memory, owned L1 memory, managed directories, Durable and Pi history with no recoverable trash');
    await click('.archive-management .record-tabs button', '空间 1');
    await search('');
    await click('input[aria-label="选择空间「归档级联空间」"]');
    await click('.archive-management button', '批量彻底删除');
    const cascadeConfirmation = await evaluate('document.querySelector("[role=dialog]").textContent');
    assert(cascadeConfirmation.includes('2 个空间') && cascadeConfirmation.includes('2 个任务'), 'space confirmation must disclose nested cascade');
    assert(cascadeConfirmation.includes('用户文件会保留'), 'space confirmation must describe linked-folder preservation');
    await screenshot('space-cascade-confirmation');
    await click('[role="dialog"] button', '彻底删除');
    await until(() => count('spaces', 'id', [parentSpaceId, childSpaceId]) === 0, 'space subtree permanently deleted');
    await until(() => evaluate('document.querySelector(".archive-operation-status")?.getAttribute("role") === "status" && document.querySelector(".archive-operation-status")?.textContent.includes("2 个空间")'), 'successful space status');
    assertPurged(cascadeTasks.map(task => task.id));
    assert.equal(count('memory_records', 'id', [...workspaceMemoryIds.values()]), 0, 'workspace-only memories survived cascade');
    await screenshot('space-cascade-purged');
    report.tests.push('archived space cascade includes an unarchived descendant and inherited archived tasks; workspace memory removed and external folders untouched');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await invoke('db.purgeArchivedContent', { taskIds: [activeTaskId], spaceIds: [activeSpaceId] });
      assert.deepEqual(result.deletedTaskIds, []); assert.deepEqual(result.deletedSpaceIds, []);
      assert(result.failures.some(failure => failure.kind === 'task' && failure.id === activeTaskId));
      assert(result.failures.some(failure => failure.kind === 'space' && failure.id === activeSpaceId));
      assertPreserved();
    }
    assert.deepEqual(await evaluate('window.__archiveErrors'), [], 'renderer errors occurred');
    await close(); await launch();
    const afterTasks = await invoke('db.listTasks');
    const afterSpaces = await invoke('db.listSpaces');
    assert(afterTasks.some(task => task.id === activeTaskId));
    assert(!afterTasks.some(task => [...batchTasks, ...cascadeTasks].some(deleted => deleted.id === task.id)));
    assert(!afterSpaces.some(space => [parentSpaceId, childSpaceId].includes(space.id)));
    assertPurged([...batchTasks, ...cascadeTasks].map(task => task.id));
    await openArchives('spaces');
    assert(await evaluate('document.querySelector(".archive-management").textContent.includes("暂无归档空间")'));
    await screenshot('restart-empty-archives');
    assert.deepEqual(await evaluate('window.__archiveErrors'), []);
    report.tests.push('repeated direct IPC requests reject active tasks/spaces; whole-app restart confirms permanent absence and preserves active sibling/global memory/user files');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack;
    try { report.body = await evaluate('document.body.innerText.slice(-5000)'); report.rendererErrors = await evaluate('window.__archiveErrors'); await screenshot('failure'); } catch {}
  } finally {
    try { await close(); } catch (error) { report.status = 'failed'; report.cleanupError = error.stack; }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
})();
