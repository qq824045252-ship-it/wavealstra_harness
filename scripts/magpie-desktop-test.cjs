/** Actual Magpie executable -> MyBuddy Electron -> Pi tool loop -> Magpie gateway -> local HTTP provider. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts/magpie-desktop');
fs.mkdirSync(out, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-magpie-desktop-'));
const profile = path.join(temporary, 'profile');
const agentDir = path.join(profile, '.mybuddy');
const seed = path.join(temporary, 'seed.txt');
for (const directory of [agentDir, path.join(agentDir, 'plugins'), path.join(profile, 'AppData/Roaming'), path.join(profile, 'AppData/Local')]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(seed, 'DESKTOP_NATIVE_READ_COMPLETED');
const report = { startedAt: new Date().toISOString(), kind: 'actual-electron-and-magpie-local-http-provider', tests: [], status: 'running' };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, socket, log, current, gatewayChild, requestId = 0;
const magpieExe = process.env.MAGPIE_TEST_EXE;
assert(magpieExe && fs.existsSync(magpieExe), 'MAGPIE_TEST_EXE must name the built Magpie executable');
const requests=[];
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
    requests.push({model:body.model,userAgent:req.headers['user-agent'],toolResult:transmitted.includes('DESKTOP_NATIVE_READ_COMPLETED')});
    if (!requests.at(-1).toolResult) sendCompletion(res,'',true);
    else sendCompletion(res,'MAGPIE_ADAPTATION_COMPLETED');
  } catch (error) {
    if (current) current.serverError = error.stack;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});

async function prompt(taskId) {
  const request = { taskId, text: 'Recall the shared calibration reference and read the fixture file.',
    userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(),
    modelId: 'magpie/relay/probe', permissionMode: 'auto', welcomeMode: 'coding' };
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
      enabledModels: ['fixture/memory-fixture'], defaultThinkingLevel: 'off', memoryEnabled: false, memoryGatewayEnabled: false,
      remoteAccessEnabled: false, closeToTray: false, permissionMode: 'auto', proxyUrl: '' }));
    fs.writeFileSync(path.join(agentDir, 'plugins/mcp.json'), '{"mcpServers":{}}');
    const capabilities = { schemaVersion: 1, execution: { terminalEnabled: true, codeExecutionEnabled: false } };
    for (const key of ['web', 'vision', 'imageGeneration', 'videoGeneration', 'speechToText', 'textToSpeech', 'browser', 'diagnostics', 'subagent', 'multiModelConsult']) capabilities[key] = { enabled: false };
    fs.writeFileSync(path.join(agentDir, 'capabilities.json'), JSON.stringify(capabilities));
    const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
    const executable = process.env.MYBUDDY_TEST_EXE;
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

    const modelsPath=path.join(agentDir,'models.json'), settingsPath=path.join(agentDir,'settings.json');
    const settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
    const configDir=path.join(profile,'.config/magpie');fs.mkdirSync(configDir,{recursive:true});
    fs.writeFileSync(path.join(configDir,'providers.json'),JSON.stringify({noAutoGroups:true,providers:[{id:'relay',name:'Fixture relay',key:'fixture-only',chat:configuration.providers.fixture.baseUrl,models:['probe']}]}));
    const gatewayPort=await new Promise(resolve=>{const p=net.createServer();p.listen(0,'127.0.0.1',()=>{const port=p.address().port;p.close(()=>resolve(port));});});
    const magpieEnv={...env, XDG_CONFIG_HOME:path.join(profile,'.config'),MAGPIE_ADDR:'127.0.0.1:'+gatewayPort};
    const magpie=(...args)=>cp.execFileSync(magpieExe,args,{env:magpieEnv,cwd:profile,windowsHide:true,encoding:'utf8',timeout:30000});
    await until('document.querySelector(".model-trigger")?.title === "Memory fixture"');
    await invoke('db.upsertTask',{id:'existing-task',title:'Existing task model',modelId:'fixture/memory-fixture',updatedAt:Date.now()});
    await rpc('Page.enable');
    const loaded = new Promise(resolve => {
      const listener = event => { if (JSON.parse(event.data).method === 'Page.loadEventFired') { socket.removeEventListener('message', listener); resolve(); } };
      socket.addEventListener('message', listener);
    });
    await rpc('Page.reload'); await loaded;
    await until('Boolean([...document.querySelectorAll(".task-item-title")].find(e=>e.textContent==="Existing task model"))');
    await evaluate('[...document.querySelectorAll(".task-item-title")].find(e=>e.textContent==="Existing task model").closest(".task-item").click()');
    await until('document.querySelector(".model-trigger")?.title === "Memory fixture"');
    // The real Magpie adapter writes the files while the real desktop is open.
    magpie('mybuddy','model','magpie/relay/probe');
    const written=JSON.parse(fs.readFileSync(modelsPath,'utf8'));
    const expectedName=written.providers.magpie.models.find(m=>m.id==='relay/probe').name;
    assert.equal(written.providers.magpie.headers['User-Agent'],'MyBuddy');
    gatewayChild=cp.spawn(magpieExe,['serve'],{env:magpieEnv,cwd:profile,windowsHide:true,stdio:['ignore',log,log]});
    for(let n=0;n<100;n++){try{const r=await fetch('http://127.0.0.1:'+gatewayPort+'/v1/models');if(r.ok)break;}catch{}if(n===99)throw Error('Fixture Magpie gateway did not start');await delay(100);}
    await evaluate('window.dispatchEvent(new Event("focus"))');
    await until('(async()=> (await window.api.agent.listModels()).some(m=>m.id==="magpie/relay/probe"&&m.enabled))()');
    assert.equal(await evaluate('document.querySelector(".model-trigger")?.title'),'Memory fixture','external default changed active task model');
    await evaluate('document.querySelector(\'button[title="新建任务"]\').click()');
    await until('document.querySelector(".model-trigger")?.title === '+JSON.stringify(expectedName));
    const catalogs=await Promise.all(Array.from({length:4},()=>invoke('agent.listModels')));
    assert(catalogs.every(models=>models.some(m=>m.id==='magpie/relay/probe'&&m.available&&m.enabled)));
    report.tests.push({name:'real Magpie write refreshes running desktop and draft picker',status:'passed',modelLabel:expectedName});
    assert.equal((await invoke('db.listTasks')).find(t=>t.id==='existing-task').modelId,'fixture/memory-fixture');
    report.tests.push({name:'existing task model preserved',status:'passed'});
    // Explicit empty scope is distinct from absent scope for MyBuddy.
    fs.writeFileSync(settingsPath,JSON.stringify({...JSON.parse(fs.readFileSync(settingsPath)),enabledModels:[]}));
    magpie('mybuddy','model','magpie/relay/probe');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath)).enabledModels,['magpie/relay/probe']);
    report.tests.push({name:'adapter enables selection from empty scope',status:'passed'});
    await evaluate(`window.api.agent.onEvent(event=>{const state=window.__memoryLifecycle;if(!state||event.taskId!==state.taskId)return;if(event.type==='tool_start')state.tools.push(event.tool);if(event.type==='text_delta')state.text+=event.delta||'';if(event.type==='assistant_end'){state.error=event.error;state.done=true;}})`);
    await invoke('db.upsertTask',{id:'gateway-task',title:'Magpie tool loop',modelId:'magpie/relay/probe',welcomeMode:'coding',modePresetId:'minimal',permissionMode:'auto',updatedAt:Date.now()});
    current={};const answer=await prompt('gateway-task');
    assert(!answer.error,answer.error);assert(!current.serverError,current.serverError);
    assert(answer.text.includes('MAGPIE_ADAPTATION_COMPLETED'));assert(answer.tools.includes('read'));
    assert.equal(requests.length,2);assert(requests.every(r=>r.model==='probe'));assert(requests[1].toolResult);
    const ledger=path.join(configDir,'usage.jsonl');
    for(let n=0;n<50&&!fs.existsSync(ledger);n++)await delay(100);
    const usage=fs.readFileSync(ledger,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert(usage.filter(r=>r.agent==='mybuddy'&&r.provider==='relay'&&r.status===200).length>=2);
    report.tests.push({name:'real desktop tool loop through Magpie gateway with MyBuddy attribution',status:'passed',requests,usage:usage.map(({agent,provider,model,status})=>({agent,provider,model,status}))});
    // An interrupted external file write is rejected, then a valid replacement recovers.
    const saved=fs.readFileSync(modelsPath,'utf8');fs.writeFileSync(modelsPath,'{"providers":');
    await assert.rejects(()=>invoke('agent.listModels'));
    await evaluate('window.dispatchEvent(new Event("focus"))');await delay(250);
    assert.equal(await evaluate('document.querySelector(".model-trigger")?.title'),expectedName);
    fs.writeFileSync(modelsPath,saved);
    assert((await invoke('agent.listModels')).some(m=>m.id==='magpie/relay/probe'));
    report.tests.push({name:'incomplete JSON keeps UI selection and valid file recovers',status:'passed'});
    const changed=JSON.parse(saved);changed.providers.magpie.models.find(m=>m.id==='relay/probe').name='Updated Magpie fixture';
    fs.writeFileSync(modelsPath,JSON.stringify(changed));
    await evaluate('window.dispatchEvent(new Event("focus"))');
    await until('document.querySelector(".model-trigger")?.title === "Updated Magpie fixture"');
    report.tests.push({name:'updated catalog metadata reaches live picker',status:'passed'});
    magpie('mybuddy','model','default');
    await evaluate('window.dispatchEvent(new Event("focus"))');
    await until('(async()=>!(await window.api.agent.listModels()).some(m=>m.vendor==="magpie"))()');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath)).enabledModels,[]);
    report.tests.push({name:'disconnect removes provider without enabling unrelated models',status:'passed'});
    report.magpieExecutable=magpieExe;
    report.magpieSha256=crypto.createHash('sha256').update(fs.readFileSync(magpieExe)).digest('hex');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack; console.error(error.stack); }
  finally {
    if (socket) { await Promise.race([rpc('Browser.close').catch(() => {}), delay(2000)]); socket.close(); }
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Desktop closed')); }
    pending.clear();
    if (child) { await delay(700); if (child.exitCode === null) cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    if (gatewayChild && gatewayChild.exitCode === null) cp.spawnSync('taskkill',['/PID',String(gatewayChild.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    if (log !== undefined) fs.closeSync(log);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const cleanupTarget = path.resolve(temporary);
    assert(path.dirname(cleanupTarget) === path.resolve(os.tmpdir()) && path.basename(cleanupTarget).startsWith('mybuddy-magpie-desktop-'));
    try { fs.rmSync(cleanupTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (error) { report.cleanupError = error.message; report.status = 'failed'; }
    report.finishedAt = new Date().toISOString(); save();
    process.exitCode = report.status === 'passed' ? 0 : 1;
    console.log(JSON.stringify({ status: report.status, report: path.join(out, 'results.json') }));
  }
})();
