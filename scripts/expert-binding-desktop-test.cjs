/** Isolated real Electron/packaged acceptance: IPC, Durable, provider requests and HTTP MCP. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), cp = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-expert-binding-desktop-'));
const home = path.join(temp, 'profile'), agentDir = path.join(home, '.mybuddy');
const workspace = path.join(temp, 'workspace');
const out = path.resolve(process.env.MYBUDDY_DESKTOP_OUT || path.join(root, 'out/tests/expert-binding-desktop'));
const taskId = 'expert-binding-desktop-task';
const connectorId = 'binding-connector', privateSkillId = 'binding-private-skill';
const connectorMarker = 'BOUND_CONNECTOR_SKILL_SENTINEL', privateMarker = 'BOUND_PRIVATE_SKILL_SENTINEL';
const identityA = 'BOUND_IDENTITY_ALPHA', identityB = 'BOUND_IDENTITY_BETA', identityTemplateOnly = 'TEMPLATE_ONLY_GAMMA';
const requests = [], mcpRequests = [], report = { temp, out, tests: [], status: 'running' };
for (const dir of [out, agentDir, workspace, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local'), path.join(agentDir, 'plugins/mcp')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(out, 'desktop.log'), '');

function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function seedSkill(dir, name, marker) {
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${marker}\n---\n\nUse the isolated fixture capability.\n`);
  fs.writeFileSync(path.join(dir, 'references/guide.txt'), `${marker}: retained resource`);
}
seedSkill(path.join(agentDir, 'plugins/skills', privateSkillId), privateSkillId, privateMarker);
const connectorSource = path.join(agentDir, 'plugins/connector-market/connectors', connectorId);
writeJson(path.join(connectorSource, 'connector-meta.json'), { name: 'Binding Connector', description: 'Isolated connector acceptance', type: 'cli', version: '1.0.0' });
writeJson(path.join(connectorSource, 'cli.json'), {});
seedSkill(path.join(connectorSource, 'skills/binding-connector-skill'), 'binding-connector-skill', connectorMarker);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await wait(80); }
  throw Error('Timeout: ' + label);
}
async function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
function contentText(content) {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
}
function requestInput(body) {
  const index = (body.messages || []).findLastIndex(message => message.role === 'user' && /^BIND_[A-Z_]+/.test(contentText(message.content).trim()));
  return { index, text: index < 0 ? '' : contentText(body.messages[index].content).trim(), recent: body.messages.slice(index + 1) };
}
function systemText(body) { return body.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => contentText(message.content)).join('\n'); }
function called(recent, name) { return recent.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.function.name === name)); }

let holdReached = false, generationHoldReached = false, releaseHold;
const holdGate = new Promise(resolve => { releaseHold = resolve; });
const mcpServer = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); mcpRequests.push({ server: req.url.slice(1), method: body.method, tool: body.params?.name });
    if (body.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (body.method === 'initialize') result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'binding-fixture', version: '1.0.0' } };
    else if (body.method === 'tools/list') result = { tools: [{ name: 'hold_identity', description: 'Wait for the acceptance runner to release this isolated tool.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
    else if (body.method === 'tools/call' && body.params.name === 'hold_identity') {
      holdReached = true; await holdGate;
      result = { content: [{ type: 'text', text: 'BIND_HOLD_RELEASED' }] };
    } else if (body.method === 'ping') result = {};
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Fixture method unavailable' } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});

const provider = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const authoringHold = body.messages.some(message => message.role === 'user' && contentText(message.content).includes('AUTHORING_HOLD_FIXTURE'));
    if (authoringHold) {
      generationHoldReached = true;
      await new Promise(resolve => res.once('close', resolve));
      return;
    }
    const authoringRetry = body.messages.some(message => message.role === 'user' && contentText(message.content).includes('AUTHORING_RETRY_FIXTURE'));
    const input = requestInput(body);
    let tool;
    if (input.text.startsWith('BIND_HOLD')) {
      if (!called(input.recent, 'mcp_list_tools')) tool = { name: 'mcp_list_tools', arguments: JSON.stringify({ server: 'selected' }) };
      else if (!called(input.recent, 'mcp_call_tool')) tool = { name: 'mcp_call_tool', arguments: JSON.stringify({ server: 'selected', tool: 'hold_identity', arguments: {} }) };
    }
    if (input.text.startsWith('BIND_SCOPE') && !called(input.recent, 'mcp_list_tools')) tool = { name: 'mcp_list_tools', arguments: JSON.stringify({ server: 'excluded' }) };
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'binding-call-' + requests.length, type: 'function', function: tool }] }
      : { role: 'assistant', content: authoringRetry ? JSON.stringify({ name: 'Retry Generated Expert', description: 'Cancellation released the authoring slot', instructions: 'AUTHORING_RETRY_SUCCEEDED', skillIds: [] }) : 'BIND_COMPLETE ' + (input.text.match(/^BIND_[A-Z_]+/)?.[0] || 'OTHER') };
    const packet = (value, finish) => ({ id: 'chatcmpl-binding-' + requests.length, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 2000, completion_tokens: 50, total_tokens: 2050 } } : {}) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify(packet(delta, null)) + '\n\n');
    res.end('data: ' + JSON.stringify(packet({}, tool ? 'tool_calls' : 'stop')) + '\n\ndata: [DONE]\n\n');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});

let proc, socket, log, sequence = 0;
const pendingRpc = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pendingRpc.delete(id); reject(Error('CDP timeout ' + method)); }, 45000);
    pendingRpc.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const api = (method, ...args) => evaluate(`window.api.${method}(${args.map(value => JSON.stringify(value)).join(',')})`);
async function launch() {
  const port = await freePort(), env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local') };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.MYBUDDY_DESKTOP_EXECUTABLE || require('electron');
  log = fs.openSync(path.join(out, 'desktop.log'), 'a');
  proc = cp.spawn(executable, [...(process.env.MYBUDDY_DESKTOP_EXECUTABLE ? [] : [root]), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
  let launchError; proc.once('error', error => { launchError = error; });
  let target;
  await until(async () => {
    if (launchError) throw launchError;
    if (proc.exitCode !== null) throw Error('Isolated Electron exited ' + proc.exitCode);
    try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())).find(item => item.type === 'page' && item.url.includes('index.html')); return !!target; } catch { return false; }
  }, 'isolated Electron renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => { const response = JSON.parse(event.data), pending = pendingRpc.get(response.id); if (!pending) return; pendingRpc.delete(response.id); clearTimeout(pending.timer); response.error ? pending.reject(Error(JSON.stringify(response.error))) : pending.resolve(response.result); });
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate('Boolean(window.api?.agent?.saveTaskExpertBinding && document.querySelector("textarea"))'), 'binding IPC and renderer ready');
  await evaluate('window.__bindingEvents=[];window.api.agent.onEvent(event=>window.__bindingEvents.push(event));true');
  report.executable = executable;
}
async function close() {
  if (socket) { try { await Promise.race([rpc('Browser.close'), wait(2000)]); } catch { /* termination may close CDP first */ } socket.close(); socket = undefined; }
  for (const pending of pendingRpc.values()) { clearTimeout(pending.timer); pending.reject(Error('Isolated renderer closed')); } pendingRpc.clear();
  if (proc) {
    const instance = proc;
    await until(() => instance.exitCode !== null, 'isolated Electron exits', 4000).catch(() => {
      if (instance.exitCode === null && instance.pid) cp.execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(instance.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    });
    proc = undefined;
  }
  if (log !== undefined) { fs.closeSync(log); log = undefined; }
}
let inputCounter = 0;
function promptRequest(text, extra = {}) { const id = ++inputCounter; return { taskId, text, userMessageId: 'binding-user-' + id, assistantMessageId: 'binding-assistant-' + id, modePresetId: 'native', modelId: 'binding-fixture/fixture', ...extra }; }
async function completePrompt(text, extra) {
  const result = await api('agent.prompt', promptRequest(text, extra));
  assert(!result.error, JSON.stringify(result)); assert.equal(result.queued, false);
  await idle(text);
}
async function idle(lastInput) {
  await until(async () => { const history = await api('agent.loadTaskHistory', taskId); return !history.durable.busy && !history.durable.pendingInputs?.length && history.messages.some(message => message.role === 'user' && message.text === lastInput) && history.messages.at(-1)?.text === 'BIND_COMPLETE ' + lastInput; }, 'idle after ' + lastInput);
}
function assertIdentity(marker, identity, absent) {
  const matched = requests.filter(body => requestInput(body).text.startsWith(marker));
  assert(matched.length, 'No provider request for ' + marker);
  for (const body of matched) {
    const system = systemText(body);
    assert(system.includes(identity), `${marker} missing ${identity}`);
    if (absent) assert(!system.includes(absent), `${marker} unexpectedly adopted ${absent}`);
    assert(system.includes(privateMarker), marker + ' lost task private skill');
    assert(system.includes(connectorMarker), marker + ' lost connector skill');
  }
}

(async () => {
  try {
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => mcpServer.listen(0, '127.0.0.1', resolve));
    const mcpUrl = 'http://127.0.0.1:' + mcpServer.address().port;
    writeJson(path.join(agentDir, 'plugins/mcp/mcp.json'), { mcpServers: { selected: { url: mcpUrl + '/selected', exposure: 'deferred', timeout: 120 }, excluded: { url: mcpUrl + '/excluded', exposure: 'deferred' }, disabled: { url: mcpUrl + '/disabled', enabled: false } } });
    writeJson(path.join(agentDir, 'models.json'), { providers: { 'binding-fixture': { baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1', api: 'openai-completions', apiKey: 'isolated-fixture', models: [{ id: 'fixture', name: 'Binding Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
    writeJson(path.join(agentDir, 'settings.json'), { defaultProvider: 'binding-fixture', defaultModel: 'fixture', enabledModels: ['binding-fixture/fixture'], memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, permissionMode: 'readonly' });
    await launch();
    await evaluate(`window.__generationError=null;window.__generationResult=null;window.api.agent.generateExpertAuthoringDraft({requestId:'binding-authoring-hold',intent:'AUTHORING_HOLD_FIXTURE',modelId:'binding-fixture/fixture'}).then(value=>window.__generationResult=value,error=>window.__generationError=String(error));true`);
    await until(() => generationHoldReached, 'expert draft reaches the real HTTP provider');
    await api('agent.cancelExpertAuthoring', 'binding-authoring-hold');
    const generated = await api('agent.generateExpertAuthoringDraft', { requestId: 'binding-authoring-retry', intent: 'AUTHORING_RETRY_FIXTURE', modelId: 'binding-fixture/fixture' });
    assert.equal(generated.instructions, 'AUTHORING_RETRY_SUCCEEDED');
    await until(() => evaluate('Boolean(window.__generationError)'), 'cancelled draft rejects');
    assert.match(await evaluate('window.__generationError'), /取消/);
    assert.equal(await evaluate('window.__generationResult'), null);
    report.tests.push('cancelling a blocked real authoring HTTP request releases its slot for an immediate successful retry');
    await api('agent.installConnector', connectorId);
    const created = await api('agent.authorExpert', { name: 'Binding Acceptance Expert', description: 'Isolated reusable template', instructions: identityA, skillIds: [privateSkillId], mcpIds: ['selected'], connectorIds: [connectorId] });
    let detail = await api('agent.getExpertDetail', created.expert.id);
    assert(detail.instructions.includes(identityA)); assert.deepEqual(detail.mcpIds, ['selected']); assert.deepEqual(detail.connectorIds, [connectorId]); assert(detail.skills.includes(privateSkillId));
    detail = await api('agent.updateExpert', { id: detail.id, name: 'Edited Acceptance Expert', description: 'Edited reusable template', instructions: identityA, skillIds: detail.skills, mcpIds: detail.mcpIds, connectorIds: detail.connectorIds, expectedRevision: detail.revision });
    assert.equal(detail.name, 'Edited Acceptance Expert'); assert.equal(detail.instructions, identityA);
    await api('agent.setSkillEnabled', privateSkillId, false); // Ensure the private package, rather than the global source, supplies this capability.
    report.tests.push('real IPC creates/edits expert template and reads back role, private skill, MCP and connector selections');

    await api('db.upsertTask', { id: taskId, title: 'Expert binding acceptance', welcomeMode: 'bot', modePresetId: 'native', modelId: 'binding-fixture/fixture', cwd: workspace, updatedAt: Date.now() });
    let binding = await api('agent.saveTaskExpertBinding', { taskId, expertId: detail.id, expectedRevision: null });
    assert.equal(binding.desired.instructions, identityA); assert.equal(binding.active, null); assert.equal(binding.pending, true);
    await completePrompt('BIND_FIRST');
    binding = await api('agent.getTaskExpertBinding', taskId);
    assert.equal(binding.pending, false); assert.equal(binding.active.instructions, identityA);
    assertIdentity('BIND_FIRST', identityA, identityB);
    report.tests.push('first actual provider call receives the bound identity, independent private skill and connector skill');

    const heldRequest = promptRequest('BIND_HOLD');
    await evaluate(`window.__heldResult=null;window.__heldError=null;window.api.agent.prompt(${JSON.stringify(heldRequest)}).then(value=>window.__heldResult=value,error=>window.__heldError=String(error));true`);
    await until(() => holdReached, 'selected MCP hold tool starts');
    const beforeSaveQueue = await api('agent.prompt', promptRequest('BIND_QUEUE_BEFORE_SAVE', { streamingBehavior: 'followUp' }));
    assert.equal(beforeSaveQueue.queued, true);
    const desiredB = { name: 'Task-owned Beta', instructions: identityB, skillIds: binding.desired.skillIds, mcpIds: binding.desired.mcpIds, connectorIds: binding.desired.connectorIds };
    binding = await api('agent.saveTaskExpertBinding', { taskId, custom: desiredB, expectedRevision: binding.desired.revision });
    assert.equal(binding.pending, true); assert.equal(binding.active.instructions, identityA); assert.equal(binding.desired.instructions, identityB);
    const afterSaveQueue = await api('agent.prompt', promptRequest('BIND_QUEUE_AFTER_SAVE', { streamingBehavior: 'followUp' }));
    assert.equal(afterSaveQueue.queued, true);
    releaseHold();
    await until(() => evaluate('Boolean(window.__heldResult || window.__heldError)'), 'held prompt settles');
    assert.equal(await evaluate('window.__heldError'), null);
    await idle('BIND_QUEUE_AFTER_SAVE');
    for (const marker of ['BIND_HOLD', 'BIND_QUEUE_BEFORE_SAVE', 'BIND_QUEUE_AFTER_SAVE']) assertIdentity(marker, identityA, identityB);
    await completePrompt('BIND_FRESH');
    assertIdentity('BIND_FRESH', identityB, identityA);
    binding = await api('agent.getTaskExpertBinding', taskId);
    assert.equal(binding.pending, false); assert.equal(binding.active.instructions, identityB);
    report.tests.push('saving during a real MCP tool leaves the active turn and both queued inputs on Alpha; next idle submission adopts Beta');

    await completePrompt('BIND_SCOPE');
    const scopeRequests = requests.filter(body => requestInput(body).text.startsWith('BIND_SCOPE'));
    assert(scopeRequests.some(body => body.messages.some(message => message.role === 'tool' && /not enabled|unavailable|not configured/i.test(contentText(message.content)))), 'unselected MCP lookup should return an availability error');
    assert(mcpRequests.some(item => item.server === 'selected' && item.method === 'tools/call'), 'selected MCP must execute a real tool');
    assert(!mcpRequests.some(item => item.server === 'excluded' || item.server === 'disabled'), 'unselected/disabled MCP must never connect');
    const listTools = requests.flatMap(body => body.tools || []).filter(tool => tool.function?.name === 'mcp_list_tools');
    assert(listTools.length && listTools.every(tool => !tool.function.description.includes('excluded') && !tool.function.description.includes('disabled')), 'provider tool catalog exposes only selected active MCP');
    report.tests.push('MCP selection constrains the real provider catalog and execution; excluded and disabled servers receive no requests');

    detail = await api('agent.updateExpert', { id: detail.id, name: detail.name, description: detail.description, instructions: identityTemplateOnly, skillIds: [], mcpIds: ['excluded'], connectorIds: [], expectedRevision: detail.revision });
    assert.equal((await api('agent.getTaskExpertBinding', taskId)).desired.instructions, identityB);
    await api('agent.uninstallExpert', detail.id);
    assert(!(await api('agent.listExperts')).some(item => item.id === detail.id));
    await completePrompt('BIND_AFTER_UNINSTALL');
    assertIdentity('BIND_AFTER_UNINSTALL', identityB, identityTemplateOnly);
    const savedBinding = await api('agent.getTaskExpertBinding', taskId);
    assert(savedBinding.warnings.some(warning => warning.includes('卸载')));
    report.tests.push('editing then uninstalling the template preserves the task identity, copied private skill and capability choices');

    await close(); await launch();
    const restored = await api('agent.getTaskExpertBinding', taskId);
    assert.deepEqual(restored.desired, savedBinding.desired); assert.deepEqual(restored.active, savedBinding.active); assert.equal(restored.pending, false);
    await completePrompt('BIND_RESTART');
    assertIdentity('BIND_RESTART', identityB, identityTemplateOnly);
    assert(!mcpRequests.some(item => item.server === 'excluded' || item.server === 'disabled'));
    report.tests.push('whole app restart retains the task-owned identity and capabilities after source-template uninstall');

    const ordinaryTaskId = 'ordinary-custom-binding-task', ordinaryIdentity = 'ORDINARY_CUSTOM_IDENTITY_WITHOUT_SOURCE';
    await api('db.upsertTask', { id: ordinaryTaskId, title: 'Ordinary custom identity acceptance', welcomeMode: 'working', modelId: 'binding-fixture/fixture', cwd: workspace, permissionMode: 'readonly', updatedAt: Date.now() });
    const ordinaryBinding = await api('agent.saveTaskExpertBinding', { taskId: ordinaryTaskId, expectedRevision: null,
      custom: { name: 'Ordinary task identity', instructions: ordinaryIdentity, skillIds: [], mcpIds: [], connectorIds: [] } });
    assert.equal(ordinaryBinding.desired.sourceExpertId, undefined);
    const ordinaryResult = await api('agent.prompt', { taskId: ordinaryTaskId, text: 'BIND_ORDINARY_CUSTOM', userMessageId: 'ordinary-custom-user', assistantMessageId: 'ordinary-custom-assistant', modelId: 'binding-fixture/fixture', permissionMode: 'readonly' });
    assert(!ordinaryResult.error, JSON.stringify(ordinaryResult));
    const ordinaryRequests = requests.filter(body => requestInput(body).text.startsWith('BIND_ORDINARY_CUSTOM'));
    assert(ordinaryRequests.length && ordinaryRequests.every(body => systemText(body).includes(ordinaryIdentity)), 'ordinary session dropped custom identity without a source expert');
    const ordinaryHistory = await api('agent.loadTaskHistory', ordinaryTaskId);
    assert.equal(ordinaryHistory.durable, undefined); assert(ordinaryHistory.messages.some(message => message.text === 'BIND_COMPLETE BIND_ORDINARY_CUSTOM'));
    report.tests.push('a regular non-Durable task sends its source-free custom identity to the real model provider');

    await until(() => evaluate(`(()=>{const task=[...document.querySelectorAll('.task-item-title')].find(element=>element.textContent.trim()==='Expert binding acceptance');if(!task)return false;task.click();return true})()`), 'restored Bot in sidebar');
    await until(() => evaluate('document.body.innerText.includes("BIND_COMPLETE BIND_RESTART")'), 'restored conversation displays accepted completion');
    const shot = await rpc('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'expert-binding-desktop.png'), Buffer.from(shot.data, 'base64'));
    await until(() => evaluate('document.querySelector(".input-expert-chip-name")?.textContent === "Task-owned Beta"'), 'composer displays the saved identity');
    await evaluate('document.querySelector(".input-expert-chip .expert-editor-chip-button").click();true');
    const dialogSelector = '[role="dialog"][aria-label="管理当前任务专家"]';
    await until(() => evaluate(`(()=>{const dialog=document.querySelector(${JSON.stringify(dialogSelector)});return Boolean(dialog && dialog.innerText.includes('原专家模板已卸载或不可用') && dialog.querySelector('input')?.value==='Task-owned Beta' && dialog.querySelector('textarea')?.value===${JSON.stringify(identityB)})})()`), 'identity editor restores its fields and uninstalled-source warning');
    const layout = await evaluate(`(()=>{const dialog=document.querySelector(${JSON.stringify(dialogSelector)}),rect=dialog.getBoundingClientRect();return {width:rect.width,height:rect.height,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,overflow:getComputedStyle(dialog).overflowY}})()`);
    assert(layout.width > 400 && layout.height > 200 && layout.left >= 0 && layout.top >= 0 && layout.right <= layout.viewportWidth + 1 && layout.bottom <= layout.viewportHeight + 1, 'packaged expert editor must fit within the viewport: ' + JSON.stringify(layout));
    const editorShot = await rpc('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'expert-binding-editor.png'), Buffer.from(editorShot.data, 'base64'));
    await evaluate(`([...document.querySelector(${JSON.stringify(dialogSelector)}).querySelectorAll('button')].find(button=>button.textContent.trim()==='关闭')).click();true`);
    await until(() => evaluate(`!document.querySelector(${JSON.stringify(dialogSelector)})`), 'editor closes without saving');
    await evaluate('document.querySelector(".add-menu-anchor > button").click();true');
    await until(() => evaluate('[...document.querySelectorAll(".add-menu-item")].some(button=>button.textContent.trim()==="专家")'), 'plus menu expert entry');
    await evaluate('[...document.querySelectorAll(".add-menu-item")].find(button=>button.textContent.trim()==="专家").click();true');
    const manageText = '绑定 / 管理当前任务专家';
    await until(() => evaluate(`[...document.querySelectorAll('.add-menu-flyout-footer')].some(button=>button.textContent.trim()===${JSON.stringify(manageText)})`), 'plus menu contains the actual manage-expert action');
    await evaluate(`[...document.querySelectorAll('.add-menu-flyout-footer')].find(button=>button.textContent.trim()===${JSON.stringify(manageText)}).click();true`);
    await until(() => evaluate(`document.querySelector(${JSON.stringify(dialogSelector)})?.querySelector('textarea')?.value===${JSON.stringify(identityB)}`), 'plus menu opens the same task identity editor');
    await evaluate(`([...document.querySelector(${JSON.stringify(dialogSelector)}).querySelectorAll('button')].find(button=>button.textContent.trim()==='关闭')).click();true`);
    report.editorLayout = layout;
    report.tests.push('real composer identity chip and plus-menu manage action open the packaged editor with saved fields, source-uninstalled warning and valid viewport layout');
    if (process.env.MYBUDDY_DESKTOP_EXECUTABLE) report.buildSha256 = createHash('sha256').update(fs.readFileSync(path.join(path.dirname(report.executable), 'resources/app.asar'))).digest('hex');
    report.taskId = taskId; report.providerRequests = requests.length; report.mcpRequests = mcpRequests; report.binding = restored; report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack;
    try { report.body = await evaluate('document.body.innerText.slice(-5000)'); report.events = await evaluate('window.__bindingEvents.slice(-6)'); report.binding = await api('agent.getTaskExpertBinding', taskId); } catch { /* retain original failure */ }
  } finally {
    releaseHold(); await close();
    provider.closeAllConnections(); provider.close(); mcpServer.closeAllConnections(); mcpServer.close();
    writeJson(path.join(out, 'provider-requests.json'), requests); writeJson(path.join(out, 'results.json'), report);
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.status === 'passed' ? 0 : 1;
  }
})();
