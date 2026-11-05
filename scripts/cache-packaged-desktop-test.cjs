/** Packaged desktop + real preload IPC + native read; only Responses is a local fixture.
 * Run: MYBUDDY_DESKTOP_EXECUTABLE=<existing package executable> node scripts/cache-packaged-desktop-test.cjs
 * Fixture cached_tokens prove protocol/accounting, never a real provider cache hit rate.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const executableArg = process.env.MYBUDDY_DESKTOP_EXECUTABLE;
assert(executableArg && path.isAbsolute(executableArg), 'MYBUDDY_DESKTOP_EXECUTABLE must name an explicit absolute packaged executable; no dev fallback');
const executable = fs.realpathSync(executableArg);
assert(fs.statSync(executable).isFile(), 'Packaged executable must exist');
const archive = path.join(path.dirname(executable), 'resources/app.asar');
assert(fs.statSync(archive).isFile(), 'The selected executable must have resources/app.asar');

const output = path.join(root, 'out/diagnostics/pi15-cache-fix/packaged');
fs.mkdirSync(output, { recursive: true });
const run = fs.mkdtempSync(path.join(output, 'run-'));
const profile = path.join(run, 'profile');
const agent = path.join(profile, '.mybuddy');
const workspace = path.join(profile, 'workspace');
for (const directory of [agent, workspace, path.join(agent, 'plugins/mcp'), path.join(profile, 'appdata'), path.join(profile, 'localappdata'), path.join(profile, '.config'), path.join(profile, 'tmp')]) fs.mkdirSync(directory, { recursive: true });
const id = crypto.randomUUID();
const taskId = `packaged-cache-${id}`;
const modelId = 'codex/gpt-6.1-terra';
const selection = `magpie/${modelId}`;
const promptMarker = `PACKAGED_CACHE_PROMPT_${id}`;
const fileMarker = `PACKAGED_NATIVE_READ_${crypto.randomUUID()}`;
const fixtureFile = path.join(workspace, 'read-fixture.txt');
const apiKey = `local-fixture-${crypto.randomUUID()}`;
fs.writeFileSync(fixtureFile, `${fileMarker}\nSecond fixture line\n`);
const cachedCounts = [undefined, 0, 8192, 8192];
const bodies = [];
const responses = [];
const pending = new Map();
const hmacKey = crypto.randomBytes(32);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHmac('sha256', hmacKey).update(JSON.stringify(canonical(value))).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
const report = {
  status: 'running', startedAt: new Date().toISOString(), executable, archive, run,
  evidenceScope: 'Actual packaged product protocol and raw accounting with scripted local Responses; not live cache-hit evidence.',
  configuration: { provider: 'magpie', model: modelId, compatOverrides: false, turns: 2 },
  tests: [], requests: [], turns: [],
};
const save = () => fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
let child, socket, logFd, server, currentTurn = 0, sequence = 0, pausedFrame, exitSeen = false;
function interrupt(signal) {
  report.cancelled = signal; report.status = 'failed';
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error(`Fixture interrupted: ${signal}`)); }
  pending.clear();
  if (child?.pid && !exitSeen) child.kill('SIGTERM');
  socket?.close(); server?.closeAllConnections();
}
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function until(check, label, timeout = 45000, shutdown = false) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!shutdown && report.cancelled) throw Error(`Fixture interrupted: ${report.cancelled}`);
    if (!shutdown && report.serverError) throw Error(report.serverError);
    if (!shutdown && report.spawnError) throw Error(report.spawnError);
    if (!shutdown && exitSeen) throw Error(`Packaged app exited during ${label}`);
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw Error(`Timeout: ${label}`);
}
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const request = ++sequence;
    const timer = setTimeout(() => { pending.delete(request); reject(Error(`CDP timeout: ${method}`)); }, 25000);
    pending.set(request, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id: request, method, params })); }
    catch (error) { clearTimeout(timer); pending.delete(request); reject(error); }
  });
}
async function evaluate(expression, frame = false) {
  const result = await rpc(frame ? 'Debugger.evaluateOnCallFrame' : 'Runtime.evaluate', frame
    ? { callFrameId: pausedFrame, expression, returnByValue: true }
    : { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const ui = expression => evaluate(`globalThis.__cachePackageWindow.webContents.executeJavaScript(${JSON.stringify(expression)}, true)`);
const invoke = (method, ...args) => ui(`window.api.${method}(${args.map(value => JSON.stringify(value)).join(',')})`);
const send = (response, event) => response.write(`data: ${JSON.stringify(event)}\n\n`);

function handleRequest(req, res, body, rawBytes) {
  const n = bodies.length;
  assert.equal(req.method, 'POST', 'Only local Responses POST is expected');
  assert.equal(req.url, '/v1/responses');
  assert(n < cachedCounts.length, 'Unexpected extra inference request');
  assert.equal(currentTurn, Math.floor(n / 2) + 1, 'Exactly one native read continuation per user turn');
  assert.equal(body.model, modelId);
  assert(Array.isArray(body.input), 'Actual serializer must provide Responses input');
  assert(JSON.stringify(body.input).includes(promptMarker), 'Unexpected auxiliary model operation');
  const additions = body.input.filter(item => item.type === 'additional_tools');
  assert(additions.length > 0, 'Product default Magpie/Codex compatibility must send additional_tools');
  const read = additions.flatMap(item => item.tools ?? []).find(tool => tool.name === 'read');
  assert(read, 'Native read must be declared in additional_tools');
  assert.equal(read.strict, false, 'Magpie default strict:false must survive serialization');
  assert(Array.isArray(body.tools) && body.tools.length === 0, 'Top-level tools must remain empty in changes mode');
  const outputs = body.input.filter(item => item.type === 'function_call_output');
  assert.equal(outputs.length, Math.floor((n + 1) / 2), 'Only the actual native read results may advance the transcript');
  if (n === 0) assert(!JSON.stringify(body.input).includes(fileMarker), 'File contents must not be seeded into the prompt');
  if (n % 2 === 1) assert(JSON.stringify(outputs.at(-1).output).includes(fileMarker), 'Continuation must contain the real file read output');
  const { input, ...fixed } = body;
  const previous = bodies.at(-1);
  const summary = {
    sequence: n + 1, turn: currentTurn, bytes: rawBytes, bodyHash: digest(body), inputCount: input.length,
    inputHash: digest(input), itemHashes: input.map(digest), itemKinds: input.map(item => item.type ?? item.role ?? 'other'),
    additionalToolsBatches: additions.length, topLevelTools: body.tools.length, nativeReadOutputs: outputs.length,
    fixedFieldsHash: digest(fixed), headersHash: digest(req.headers),
    headersScope: 'local-fixture-server-received-http', cacheFixture: cachedCounts[n] === undefined ? 'missing' : cachedCounts[n] === 0 ? 'explicit-zero' : 'positive',
  };
  report.requests.push(summary);
  if (previous) {
    const { input: oldInput, ...oldFixed } = previous;
    summary.prefixPreserved = digest(input.slice(0, oldInput.length)) === digest(oldInput);
    summary.fixedFieldsPreserved = digest(fixed) === digest(oldFixed);
    summary.firstChangedItem = oldInput.findIndex((item, index) => digest(item) !== digest(input[index] ?? null));
    summary.changedFixedFields = [...new Set([...Object.keys(oldFixed), ...Object.keys(fixed)])].filter(key => digest(oldFixed[key] ?? null) !== digest(fixed[key] ?? null));
    assert(summary.prefixPreserved, `Request ${n + 1} rewrote an earlier input item; see request summaries`);
    assert(summary.fixedFieldsPreserved, `Request ${n + 1} changed non-input request fields; see request summaries`);
  }
  bodies.push(body);
  const turn = currentTurn;
  const callId = `call_packaged_read_${turn}`;
  const item = n % 2 === 0
    ? { type: 'function_call', id: `fc_packaged_read_${turn}`, call_id: callId, name: 'read', arguments: JSON.stringify({ path: fixtureFile, offset: 1, limit: 5 }) }
    : { type: 'message', id: `msg_packaged_${turn}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `PACKAGED_CACHE_TURN_${turn}_COMPLETE`, annotations: [] }] };
  const responseId = `resp_packaged_cache_${id}_${n + 1}`;
  const usage = { input_tokens: 10000, output_tokens: 10, total_tokens: 10010,
    ...(cachedCounts[n] === undefined ? {} : { input_tokens_details: { cached_tokens: cachedCounts[n] } }) };
  responses.push({ responseHash: sha256(responseId), terminal: 'response.completed', cachedTokens: cachedCounts[n] ?? null, cachedTokensPresent: cachedCounts[n] !== undefined });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send(res, { type: 'response.created', response: { id: responseId, status: 'in_progress' } });
  send(res, { type: 'response.output_item.added', output_index: 0, item: item.type === 'message' ? { ...item, content: [] } : { ...item, arguments: '' } });
  if (item.type === 'message') {
    send(res, { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    send(res, { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
    send(res, { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text });
  } else {
    send(res, { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
    send(res, { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
  }
  send(res, { type: 'response.output_item.done', output_index: 0, item });
  send(res, { type: 'response.completed', response: { id: responseId, model: modelId, status: 'completed', output: [item], usage } });
  res.end();
}
function readTrace() {
  const directory = path.join(agent, 'logs');
  if (!fs.existsSync(directory)) return { text: '', records: [] };
  const files = fs.readdirSync(directory).filter(name => /^cache-requests-\d{8}(?:-\d+)?\.log$/.test(name));
  const text = files.map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n');
  const records = [];
  for (const line of text.split('\n')) {
    const marker = line.indexOf('[cache-trace] ');
    if (marker >= 0) records.push(JSON.parse(line.slice(marker + 14)));
  }
  return { text, records };
}
async function inspectTrace() {
  let trace;
  await until(() => { trace = readTrace(); return trace.records.filter(row => row.event === 'result').length >= cachedCounts.length; }, 'all host trace results flushed');
  for (const canary of [apiKey, promptMarker, fileMarker, fixtureFile]) assert(!trace.text.includes(canary), 'Trace must contain no credential, prompt or file plaintext');
  fs.writeFileSync(path.join(run, 'cache-trace.log'), trace.text);
  const { summarizeCacheTraces } = await import(pathToFileURL(path.join(root, 'scripts/cache-trace-audit.mjs')).href);
  const audit = summarizeCacheTraces(trace.records);
  fs.writeFileSync(path.join(run, 'cache-audit.json'), JSON.stringify(audit, null, 2));
  assert.equal(audit.calls, cachedCounts.length, 'Every actual model call must have one result');
  assert.equal(trace.records.filter(row => row.event === 'provider-usage').length, cachedCounts.length);
  report.metering = responses.map((expected, index) => {
    const observed = audit.requests.find(row => row.responseHash === expected.responseHash);
    assert(observed, `No trace correlated to local response ${index + 1}`);
    assert.equal(observed.source, 'main');
    assert.equal(observed.rawUsage.terminal, expected.terminal);
    assert.equal(observed.rawUsage.responseStatus, 'completed');
    assert.equal(observed.rawUsage.usagePresent, true);
    assert.equal(observed.rawUsage.cachedTokensPresent, expected.cachedTokensPresent);
    assert.deepEqual(observed.rawUsage.usage, { inputTokens: 10000, outputTokens: 10, totalTokens: 10010, cachedTokens: expected.cachedTokens });
    assert.equal(observed.cacheReadState, expected.cachedTokensPresent ? expected.cachedTokens === 0 ? 'explicit-zero' : 'positive' : 'missing');
    assert.deepEqual(observed.usage, { input: 10000 - (expected.cachedTokens ?? 0), output: 10, cacheRead: expected.cachedTokens ?? 0, cacheWrite: 0 });
    assert.equal(observed.sends, 1); assert.deepEqual(observed.httpStatuses, [200]);
    assert(observed.adapterMatches.every(value => value === true));
    if (!expected.cachedTokensPresent) {
      assert.equal(observed.classification, 'raw-cache-usage-missing');
      assert.equal(observed.historyUncachedTokens, null);
    } else {
      assert.equal(observed.normalizedCacheReadMatches, true);
      assert.equal(observed.rawHitRate, expected.cachedTokens / 10000);
      if (expected.cachedTokens === 0) assert.equal(observed.classification, 'stable-prefix-low-cache');
    }
    return { sequence: index + 1, request: observed.request, responseHash: expected.responseHash, cacheReadState: observed.cacheReadState,
      rawUsage: observed.rawUsage, normalizedUsage: observed.usage, classification: observed.classification };
  });
  const sends = trace.records.filter(row => row.event === 'request' && row.stage === 'http');
  assert.equal(sends.length, cachedCounts.length);
  assert(sends.every(row => row.coverage === 'complete' && row.headersScope === 'sdk-fetch-arguments' && typeof row.headersHash === 'string'));
  assert(sends.slice(1).every(row => row.previous?.prefix === true && row.previous.changedFields.length === 0));
  report.tests.push('Actual app logs distinguish absent cached_tokens, explicit zero and positive fixture values; normalized accounting is retained.');
}
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function screenshot(name) {
  if (!socket || exitSeen) return;
  try {
    const png = await evaluate('(async()=>{const image=await globalThis.__cachePackageWindow.webContents.capturePage();return image.toPNG().toString("base64")})()');
    if (png) fs.writeFileSync(path.join(run, name), Buffer.from(png, 'base64'));
  } catch (error) { report.screenshotError = error.message; }
}

(async () => {
  try {
    report.executableSha256 = await fileHash(executable);
    report.asarSha256 = await fileHash(archive);
    report.auditScriptSha256 = await fileHash(path.join(root, 'scripts/cache-trace-audit.mjs'));
    server = http.createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: modelId, object: 'model' }] })); return;
        }
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; assert(bytes <= 16 * 1024 * 1024, 'Fixture request exceeds bound'); chunks.push(chunk); }
        handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes);
      } catch (error) {
        report.serverError ??= error.message; save();
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"packaged fixture assertion failed"}}');
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { magpie: {
      baseUrl, apiKey, api: 'openai-responses', headers: { 'User-Agent': 'MyBuddy' },
      models: [{ id: modelId, name: 'Packaged cache fixture', api: 'openai-responses', reasoning: true, input: ['text'], contextWindow: 500000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
    for (const file of ['plugins/mcp.json', 'plugins/mcp/mcp.json']) fs.writeFileSync(path.join(agent, file), '{"mcpServers":{}}');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'magpie', defaultModel: modelId, enabledModels: [selection],
      defaultThinkingLevel: 'off', memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false,
      closeToTray: false, permissionMode: 'readonly', proxyUrl: '', retry: { enabled: false, maxRetries: 0 } }));
    // Inherit OS process essentials only; no provider credentials, proxies or user Pi settings.
    const permitted = new Set(['systemroot', 'windir', 'comspec', 'path', 'pathext', 'processor_architecture', 'number_of_processors', 'lang', 'lc_all', 'display', 'wayland_display', 'xdg_runtime_dir', 'dbus_session_bus_address']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => permitted.has(key.toLowerCase())));
    Object.assign(env, { HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'appdata'), LOCALAPPDATA: path.join(profile, 'localappdata'),
      XDG_CONFIG_HOME: path.join(profile, '.config'), XDG_DATA_HOME: path.join(profile, '.local/share'), XDG_CACHE_HOME: path.join(profile, '.cache'),
      TEMP: path.join(profile, 'tmp'), TMP: path.join(profile, 'tmp'), TMPDIR: path.join(profile, 'tmp'), PI_CODING_AGENT_DIR: agent,
      MYBUDDY_CACHE_TRACE: '1', MYBUDDY_PERF_STARTUP: '1' });
    const port = await freePort();
    logFd = fs.openSync(path.join(run, 'desktop.log'), 'w');
    assert(!report.cancelled, 'Fixture cancelled before launch');
    child = spawn(executable, [`--inspect-brk=127.0.0.1:${port}`, `--user-data-dir=${path.join(profile, 'chromium')}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
      { cwd: workspace, env, windowsHide: true, stdio: ['ignore', logFd, logFd] });
    report.pid = child.pid; save();
    child.once('error', error => { report.spawnError = error.message; });
    child.once('exit', (code, signal) => { exitSeen = true; report.exit = { code, signal }; });
    const target = await until(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()).find(item => item.type === 'node'); }
      catch { return false; }
    }, 'selected package inspector');
    assert(new URL(target.webSocketDebuggerUrl).hostname === '127.0.0.1', 'Inspector must remain loopback');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Debugger.paused') pausedFrame = message.params.callFrames[0].callFrameId;
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result);
    });
    await rpc('Runtime.enable'); await rpc('Debugger.enable'); await rpc('Runtime.runIfWaitingForDebugger');
    await until(() => pausedFrame, 'startup breakpoint');
    assert.equal(await evaluate('process.pid', true), child.pid, 'Only inspect the process spawned by this test');
    // Existing PERF_STARTUP makes only this fixture window hidden. Keep it alive by suppressing its exit callback.
    await evaluate(`(()=>{const write=process.stdout.write;process.stdout.write=function(chunk,...args){return String(chunk).startsWith('MYBUDDY_PERF_STARTUP:')?write.call(this,chunk):write.call(this,chunk,...args)};return true})()`, true);
    report.launchMode = 'hidden packaged window; startup-report auto-exit callback suppressed in this spawned process only';
    await rpc('Debugger.resume');
    await until(() => evaluate(`(()=>{if(!process.mainModule)return false;const {app,BrowserWindow}=process.mainModule.require('electron');if(!app.isReady())return false;globalThis.__cachePackageWindow=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('out/renderer/index.html')&&!w.webContents.isLoadingMainFrame());return !!globalThis.__cachePackageWindow})()`), 'packaged renderer');
    report.identity = await evaluate(`(()=>{const req=process.mainModule.require.bind(process.mainModule),{app}=req('electron');return {pid:process.pid,executable:process.execPath,packaged:app.isPackaged,version:app.getVersion(),home:req('node:os').homedir(),userData:app.getPath('userData'),visible:globalThis.__cachePackageWindow.isVisible(),rendererUrl:globalThis.__cachePackageWindow.webContents.getURL()}})()`);
    assert.equal(report.identity.pid, child.pid); assert.equal(report.identity.packaged, true);
    assert.equal(fs.realpathSync(report.identity.executable), executable);
    assert.equal(path.resolve(report.identity.home), profile); assert(inside(profile, report.identity.userData));
    assert.equal(report.identity.visible, false, 'Existing desktop focus must not be disturbed');
    await until(() => ui('Boolean(window.api?.agent && window.api?.db)'), 'real preload API');
    assert.equal((await invoke('db.listTasks')).length, 0, 'Isolated product database must start empty');
    assert(fs.existsSync(path.join(agent, 'app.db')), 'Product must create its isolated database');
    const capabilities = (await invoke('agent.getBuiltinCapabilities')).config;
    report.capabilitiesSchemaVersion = capabilities.schemaVersion;
    capabilities.execution = { terminalEnabled: false, codeExecutionEnabled: false };
    for (const key of ['ocr', 'web', 'vision', 'imageGeneration', 'videoGeneration', 'speechToText', 'textToSpeech', 'browser', 'diagnostics', 'subagent', 'multiModelConsult']) capabilities[key] = { ...capabilities[key], enabled: false };
    const savedCapabilities = await invoke('agent.saveBuiltinCapabilities', capabilities);
    assert.equal(savedCapabilities.config.subagent.enabled, false);
    const configured = await invoke('agent.getModelsConfig');
    assert.equal(configured.providers.magpie.baseUrl, baseUrl);
    const listed = await invoke('agent.listModels');
    assert(listed.some(model => model.id === selection && model.enabled && model.available), 'Product must resolve the configured Magpie model');
    await invoke('db.upsertSpace', { id: taskId, name: 'Packaged cache acceptance', path: workspace, createdAt: Date.now(), updatedAt: Date.now() });
    await invoke('db.upsertTask', { id: taskId, spaceId: taskId, title: 'Packaged cache acceptance', cwd: workspace, modelId: selection, welcomeMode: 'coding', modePresetId: 'minimal', permissionMode: 'readonly', updatedAt: Date.now() });
    await ui(`window.__cachePackageEvents=[];window.api.agent.onEvent(event=>{if(event.taskId===${JSON.stringify(taskId)})window.__cachePackageEvents.push(event)});true`);
    report.tests.push('Selected executable is packaged, PID matched, hidden, HOME/userData isolated and database initially empty.');
    for (currentTurn = 1; currentTurn <= 2; currentTurn++) {
      const assistantMessageId = `package-assistant-${currentTurn}`;
      const request = { taskId, spaceId: taskId, text: `${promptMarker} turn ${currentTurn}: Read ${fixtureFile} with the native read tool, then complete this turn.`,
        modelId: selection, welcomeMode: 'coding', permissionMode: 'readonly', userMessageId: `package-user-${currentTurn}`, assistantMessageId };
      await ui(`window.__cachePackagePrompt={done:false};window.api.agent.prompt(${JSON.stringify(request)}).then(result=>{window.__cachePackagePrompt={done:true,result}},error=>{window.__cachePackagePrompt={done:true,error:String(error)}});true`);
      const completion = await until(() => ui('window.__cachePackagePrompt.done && window.__cachePackagePrompt'), `user turn ${currentTurn} completion`, 90000);
      assert(!completion.error, completion.error); assert(!completion.result?.error, completion.result?.error);
      assert.equal(completion.result?.queued, false);
      const events = await until(() => ui(`window.__cachePackageEvents.some(event=>event.type==='assistant_end'&&event.messageId===${JSON.stringify(assistantMessageId)})&&window.__cachePackageEvents.filter(event=>event.messageId===${JSON.stringify(assistantMessageId)})`), 'assistant settled event');
      const reads = events.filter(event => event.type === 'tool_start' && event.tool === 'read');
      assert.equal(reads.length, 1);
      assert(events.some(event => event.type === 'tool_update' && event.toolCallId === reads[0].toolCallId && event.status === 'success' && String(event.output).includes(fileMarker)), 'Real tool success event must include the disk marker');
      const end = events.find(event => event.type === 'assistant_end'); assert(!end.error, end.error);
      assert(events.filter(event => event.type === 'text_delta').map(event => event.delta ?? '').join('').includes(`PACKAGED_CACHE_TURN_${currentTurn}_COMPLETE`));
      report.turns.push({ turn: currentTurn, completed: true, events: events.map(event => ({ type: event.type, messageId: event.messageId, tool: event.tool, toolCallId: event.toolCallId, status: event.status, hasError: Boolean(event.error), outputHash: event.output === undefined ? undefined : digest(event.output) })) });
      save();
    }
    assert.equal(bodies.length, cachedCounts.length);
    report.tests.push('Two user turns each executed native read; actual HTTP requests retained their complete prefixes and additional_tools with empty top-level tools.');
    await inspectTrace();
    await screenshot('packaged.png');
    assert.equal(await fileHash(executable), report.executableSha256, 'Executable changed during acceptance');
    assert.equal(await fileHash(archive), report.asarSha256, 'app.asar changed during acceptance');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack || String(error); process.exitCode = 1;
    await screenshot('failed.png'); console.error(report.error);
  } finally {
    if (socket && !exitSeen) { try { await evaluate("setTimeout(()=>process.mainModule.require('electron').app.quit(),50);true"); } catch {} }
    if (socket) socket.close();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Fixture inspector closed')); } pending.clear();
    if (child?.pid && !exitSeen) {
      try { await until(() => exitSeen, 'owned package shutdown', 5000, true); }
      catch { child.kill('SIGTERM'); try { await until(() => exitSeen, 'owned PID termination', 5000, true); } catch (error) { report.shutdownError = error.message; report.status = 'failed'; } }
    }
    if (logFd !== undefined) fs.closeSync(logFd);
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    // Keep the isolated profile and redacted trace evidence under this run for review; never touch user profiles.
    report.finishedAt = new Date().toISOString(); report.cleanup = { ownedProcessExited: !child?.pid || exitSeen, serverClosed: !server?.listening, retainedIsolatedProfile: profile };
    save();
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
    process.exitCode = report.status === 'passed' ? 0 : 1;
    console.log(JSON.stringify({ status: report.status, report: path.join(run, 'results.json'), evidenceScope: report.evidenceScope }));
  }
})();
