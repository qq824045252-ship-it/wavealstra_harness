/** Actual desktop IPC -> Pi tool loop -> HTTP transport, with a deterministic local provider. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts/memory-lifecycle-desktop');
fs.mkdirSync(out, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-memory-lifecycle-'));
const profile = path.join(temporary, 'profile');
const agentDir = path.join(profile, '.mybuddy');
const seed = path.join(temporary, 'seed.txt');
for (const directory of [agentDir, path.join(agentDir, 'plugins'), path.join(profile, 'AppData/Roaming'), path.join(profile, 'AppData/Local')]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(seed, 'DESKTOP_NATIVE_READ_COMPLETED');
const report = { startedAt: new Date().toISOString(), kind: 'actual-electron-local-http-provider', tests: [], status: 'running' };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, socket, log, current, requestId = 0;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function until(expression, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await evaluate(expression); if (value) return value; await delay(100); }
  throw Error('Desktop timeout: ' + expression);
}
const invoke = (method, ...args) => evaluate(`window.api.${method}(${args.map(value => JSON.stringify(value)).join(',')})`);
function sendCompletion(res, content, tool) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const base = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'memory-fixture' };
  const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  chunk({ role: 'assistant' });
  if (tool) chunk({ tool_calls: [{ index: 0, id: 'call_fixture_read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: seed }) } }] });
  else chunk({ content });
  chunk({}, tool ? 'tool_calls' : 'stop');
  res.end('data: [DONE]\n\n');
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
    const buffers = []; for await (const buffer of req) buffers.push(buffer);
    const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    if (!body.tools?.length) { sendCompletion(res, '{"candidates":[]}'); return; }
    assert(current, 'unexpected task request');
    assert(body.tools.some(tool => tool.function?.name === 'read'), 'native read tool unavailable');
    const transmitted = JSON.stringify(body.messages);
    current.requests.push({ phase: current.phase, oldMemory: transmitted.includes(current.canary), newMemory: transmitted.includes(current.newCanary), toolResult: transmitted.includes('DESKTOP_NATIVE_READ_COMPLETED') });
    if (current.phase === 'first' && current.requests.length === 1) {
      assert(transmitted.includes(current.canary), 'first real HTTP request omitted selected memory');
      // Mutate through the real Memory IPC while the first model request is in flight.
      if (current.mutation === 'forget') await invoke('memory.forget', current.memoryId);
      else if (current.mutation === 'scope') await invoke('memory.detachScope', current.memoryId, 'global');
      else await invoke('memory.update', { id: current.memoryId, ...({
        update: { content: current.newCanary }, resolved: { status: 'resolved' }, invalid: { status: 'invalid' },
        expiry: { validUntil: Date.now() - 1 },
      }[current.mutation]) });
      sendCompletion(res, '', true);
    } else sendCompletion(res, 'MEMORY_LIFECYCLE_COMPLETED');
  } catch (error) {
    if (current) current.serverError = error.stack;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});

async function prompt(taskId) {
  const request = { taskId, text: 'Recall the shared calibration reference and read the fixture file.',
    userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(),
    modelId: 'fixture/memory-fixture', permissionMode: 'auto', welcomeMode: 'coding' };
  await evaluate(`(()=>{window.__memoryLifecycle={taskId:${JSON.stringify(taskId)},done:false,tools:[],text:''};
    window.api.agent.prompt(${JSON.stringify(request)}).then(result=>{window.__memoryLifecycle.promptResult=result;})
      .catch(error=>{window.__memoryLifecycle.error=String(error);window.__memoryLifecycle.done=true;});return true;})()`);
  return until('window.__memoryLifecycle.done && window.__memoryLifecycle');
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only',
      models: [{ id: 'memory-fixture', name: 'Memory fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'memory-fixture',
      enabledModels: ['fixture/memory-fixture'], defaultThinkingLevel: 'off', memoryEnabled: true, memoryGatewayEnabled: false,
      remoteAccessEnabled: false, closeToTray: false, permissionMode: 'auto', proxyUrl: '' }));
    fs.writeFileSync(path.join(agentDir, 'plugins/mcp.json'), '{"mcpServers":{}}');
    const capabilities = { schemaVersion: 1, execution: { terminalEnabled: true, codeExecutionEnabled: false } };
    for (const key of ['web', 'vision', 'imageGeneration', 'videoGeneration', 'speechToText', 'textToSpeech', 'browser', 'diagnostics', 'subagent', 'multiModelConsult']) capabilities[key] = { enabled: false };
    fs.writeFileSync(path.join(agentDir, 'capabilities.json'), JSON.stringify(capabilities));
    const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
    const executable = process.env.MEMORY_LIFECYCLE_DESKTOP_EXE;
    const main = path.join(root, 'out/main/index.js');
    const env = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'), PI_CODING_AGENT_DIR: agentDir };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(env)) if (/^MYBUDDY_/i.test(key)) delete env[key];
    log = fs.openSync(path.join(out, 'desktop.log'), 'w');
    child = cp.spawn(executable || require('electron'), [...(executable ? [] : [main]), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { cwd: profile, env, stdio: ['ignore', log, log], windowsHide: true });
    report.pid = child.pid;
    report.executable = executable || require('electron');
    report.buildSha256 = crypto.createHash('sha256').update(fs.readFileSync(executable ? path.join(path.dirname(executable), 'resources/app.asar') : main)).digest('hex');
    save();
    let target;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())).find(target => target.type === 'page' && !target.url.startsWith('devtools')); if (target) break; } catch {}
      if (child.exitCode !== null) throw Error('Electron exited: ' + child.exitCode);
      await delay(250);
    }
    assert(target, 'Electron renderer unavailable');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => { const message = JSON.parse(event.data), item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result); });
    await rpc('Runtime.enable');
    await until('Boolean(window.api?.memory && document.querySelector("textarea"))');
    const configuration = await invoke('agent.getModelsConfig');
    assert.equal(configuration.providers.fixture?.baseUrl, `http://127.0.0.1:${server.address().port}/v1`, 'desktop must use isolated model configuration');
    assert(fs.existsSync(path.join(agentDir, 'app.db')), 'isolated database must exist');
    assert.equal((await invoke('db.listTasks')).length, 0, 'isolated database must start empty');
    await evaluate(`window.api.agent.onEvent(event=>{const state=window.__memoryLifecycle;if(!state||event.taskId!==state.taskId)return;
      if(event.type==='tool_start')state.tools.push(event.tool);if(event.type==='text_delta')state.text+=event.delta||'';
      if(event.type==='assistant_end'){state.error=event.error;state.done=true;}})`);
    await invoke('db.upsertTask', { id: 'fixture-writer', title: 'Concurrent memory owner', updatedAt: Date.now() });
    for (const mutation of ['update', 'resolved', 'forget', 'invalid', 'scope', 'expiry']) {
      current = { mutation, phase: 'first', requests: [], canary: 'MEMORY_OLD_' + crypto.randomUUID(), newCanary: 'MEMORY_NEW_' + crypto.randomUUID(), status: 'running' };
      report.tests.push(current);
      const taskId = 'fixture-reader-' + mutation;
      await invoke('db.upsertTask', { id: taskId, title: mutation, modelId: 'fixture/memory-fixture', welcomeMode: 'coding', modePresetId: 'minimal', permissionMode: 'auto', updatedAt: Date.now() });
      const memory = await invoke('memory.create', { scopeType: 'global', kind: 'fact', title: 'Shared calibration reference', content: current.canary, sourceTaskId: 'fixture-writer', sourceType: 'user', explicit: true });
      current.memoryId = memory.id;
      if (mutation === 'scope') await invoke('memory.promote', memory.id, 'task', 'fixture-writer');
      const first = await prompt(taskId);
      assert(!current.serverError, current.serverError);
      const soft = mutation === 'update' || mutation === 'resolved';
      assert.equal(current.requests.length, soft ? 2 : 1, 'wrong number of real HTTP requests');
      assert(first.tools.includes('read'), 'native tool loop was not exercised');
      if (soft) {
        assert(!first.error, first.error);
        assert(first.text.includes('MEMORY_LIFECYCLE_COMPLETED'));
        assert(current.requests[1].oldMemory && current.requests[1].toolResult, 'snapshot or real native read result missing');
      } else assert.match(first.error, /Memory 已撤销/);
      current.phase = 'fresh';
      const fresh = await prompt(taskId);
      assert(!fresh.error, fresh.error);
      assert(fresh.text.includes('MEMORY_LIFECYCLE_COMPLETED'));
      assert.equal(current.requests.at(-1).oldMemory, false, 'retired memory returned on fresh turn');
      if (mutation === 'update') assert(current.requests.at(-1).newMemory);
      const tasks = await invoke('db.listTasks');
      const sessionFile = tasks.find(task => task.id === taskId).sessionFile;
      assert(sessionFile && path.resolve(sessionFile).startsWith(path.resolve(agentDir) + path.sep));
      const persisted = fs.readFileSync(sessionFile, 'utf8');
      assert(!persisted.includes(current.canary), 'request-only evidence persisted into Pi history');
      current.status = 'passed';
      console.log('PASS actual Electron/HTTP ' + mutation);
      await invoke('memory.forget', memory.id);
      save();
    }
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack; console.error(error.stack); }
  finally {
    if (socket) { await Promise.race([rpc('Browser.close').catch(() => {}), delay(2000)]); socket.close(); }
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Desktop closed')); }
    pending.clear();
    if (child) { await delay(700); if (child.exitCode === null) cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    if (log !== undefined) fs.closeSync(log);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const cleanupTarget = path.resolve(temporary);
    assert(path.dirname(cleanupTarget) === path.resolve(os.tmpdir()) && path.basename(cleanupTarget).startsWith('mybuddy-memory-lifecycle-'));
    try { fs.rmSync(cleanupTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (error) { report.cleanupError = error.message; report.status = 'failed'; }
    report.finishedAt = new Date().toISOString(); save();
    process.exitCode = report.status === 'passed' ? 0 : 1;
    console.log(JSON.stringify({ status: report.status, report: path.join(out, 'results.json') }));
  }
})();
