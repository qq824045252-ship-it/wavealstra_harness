const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const exe = path.resolve(process.argv[2] || 'release/win-unpacked/MyBuddy.exe');
const out = path.join(root, 'out/tests/subagent-settings-package');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-subagent-settings-'));
const config = path.join(profile, '.mybuddy');
for (const dir of [out, config, path.join(config, 'agents'), path.join(profile, 'appdata'), path.join(profile, 'localappdata')]) fs.mkdirSync(dir, { recursive: true });
const report = { exe, profile, status: 'running', childRequests: 0, recoveryRequests: 0, toolResults: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = text => [{ type: 'message', id: `msg_${Date.now()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];
let responseId = 0;
const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    let output;
    if (body.model === 'parent') {
      const previous = [...body.input].reverse().find(item => item.type === 'function_call_output');
      if (previous) { report.toolResults.push(previous.output); output = message('PARENT_DONE'); }
      else {
        const blocked = JSON.stringify(body.input).includes('BLOCK_OTHER');
        const recovery = JSON.stringify(body.input).includes('RECOVER_TRANSIENT');
        output = [{ type: 'function_call', id: `fc_${++responseId}`, call_id: `call_${responseId}`, name: 'subagent', arguments: JSON.stringify({ agent: 'worker', task: recovery ? 'RECOVER_TRANSIENT: return CHILD_OK.' : 'Return CHILD_OK.', model: recovery ? 'fixture/child' : blocked ? 'fixture/other' : 'fast', isolation: 'shared', timeout_ms: recovery ? 15000 : 1000 }) }];
      }
    } else {
      assert.equal(body.model, 'child', 'blocked model reached the provider');
      report.childRequests++;
      if (JSON.stringify(body.input).includes('RECOVER_TRANSIENT') && ++report.recoveryRequests === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'database_unavailable', message: 'Open Design: [code=database_unavailable] resolve Billing Scope: status 503: database_unavailable', param: null, type: 'api_error' }));
        return;
      }
      await wait(1500);
      output = message('CHILD_OK');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const item of output) for (const type of ['response.output_item.added', 'response.output_item.done']) res.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `resp_${++responseId}`, model: body.model, status: 'completed', output, usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
  } catch (error) { report.serverError = error.stack; res.writeHead(500).end('{}'); }
});
let child, ws, exited = false, sequence = 0;
const pending = new Map();
async function rpc(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error(`Inspector timeout: ${method}`)); }, 60000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function renderer(expression) { return evaluate(`globalThis.settingsWindow.webContents.executeJavaScript(${JSON.stringify(expression)})`); }
async function until(expression) { for (let i = 0; i < 100; i++) { if (await renderer(expression)) return; await wait(100); } throw Error(`UI condition not reached: ${expression}`); }
async function setControl(label, value) {
  await renderer(`(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]');if(!el)throw Error('Control absent: '+${JSON.stringify(label)});const prototype=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function clickText(selector, text) { await renderer(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!el)throw Error('Button absent: '+${JSON.stringify(text)});el.click()})()`); }
async function save() { await clickText('.subagent-policy button', 'Save limits'); await until(`document.querySelector('.subagent-policy [role=status]')?.textContent==='Execution limits saved.'`); }
async function prompt(id, text) {
  await renderer(`window.api.db.upsertTask({id:${JSON.stringify(id)},title:${JSON.stringify(id)},updatedAt:Date.now(),modelId:'fixture/parent',permissionMode:'auto',welcomeMode:'working'})`);
  const result = await renderer(`window.api.agent.prompt({taskId:${JSON.stringify(id)},text:${JSON.stringify(text)},modelId:'fixture/parent',permissionMode:'auto',userMessageId:${JSON.stringify(id+'-user')},assistantMessageId:${JSON.stringify(id+'-assistant')}})`);
  assert(!result.error, JSON.stringify(result));
  assert(!report.serverError, report.serverError);
  return report.toolResults.at(-1);
}
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const models = ['parent', 'child', 'other'].map(id => ({ id, name: `Fixture ${id}`, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    fs.writeFileSync(path.join(config, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only', models } } }));
    fs.writeFileSync(path.join(config, 'auth.json'), '{}');
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'parent', enabledModels: models.map(m => 'fixture/'+m.id), memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, proxyUrl: '', retry: { enabled: false } }));
    fs.writeFileSync(path.join(config, 'subagent.json'), JSON.stringify({ defaultModel: 'fixture/child', roles: { fast: ['fixture/other', 'fixture/child'] }, allowTools: ['read'], maxConcurrency: 2 }));
    fs.writeFileSync(path.join(config, 'agents/worker.md'), '---\nname: worker\ndescription: Local acceptance worker\ntools: read\n---\nReturn the requested text.\n');
    const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'appdata'), LOCALAPPDATA: path.join(profile, 'localappdata'), PI_CODING_AGENT_DIR: config };
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    for (const key of Object.keys(env)) if (/^MYBUDDY_/i.test(key)) delete env[key];
    const log = fs.openSync(path.join(out, 'desktop.log'), 'w');
    child = spawn(exe, [`--inspect=127.0.0.1:${port}`, `--user-data-dir=${path.join(profile, 'chromium')}`], { cwd: profile, env, windowsHide: true, stdio: ['ignore', log, log] }); fs.closeSync(log); child.on('exit', () => { exited = true; });
    let target;
    for (let i = 0; i < 150; i++) { assert(!exited, 'Package exited'); try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())).find(t => t.type === 'node'); } catch {} if (target) break; await wait(200); }
    assert(target, 'Inspector absent'); ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = event => { const msg = JSON.parse(event.data); const entry = pending.get(msg.id); if (!entry) return; pending.delete(msg.id); clearTimeout(entry.timer); msg.error ? entry.reject(Error(JSON.stringify(msg.error))) : entry.resolve(msg.result); };
    assert.equal(await evaluate('process.pid'), child.pid);
    await evaluate(`(async()=>{const req=process.mainModule.require.bind(process.mainModule),{app,BrowserWindow}=req('electron');await app.whenReady();if(req('node:os').homedir()!==${JSON.stringify(profile)}||!app.getPath('userData').startsWith(${JSON.stringify(profile)}))throw Error('Isolation failed');for(let i=0;i<150;i++){globalThis.settingsWindow=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('out/renderer/index.html')&&!w.webContents.isLoadingMainFrame());if(globalThis.settingsWindow)break;await new Promise(r=>setTimeout(r,200))}if(!globalThis.settingsWindow)throw Error('Renderer absent');return true})()`);
    report.identity = await evaluate(`(()=>{const {app}=process.mainModule.require('electron');return {version:app.getVersion(),packaged:app.isPackaged,pid:process.pid}})()`);
    assert(report.identity.packaged);
    await renderer(`document.querySelector('.sidebar-user-main').click()`);
    await clickText('.sidebar-popup-item', '设置');
    await clickText('.settings-nav-btn', '模型');
    await until(`Boolean(document.querySelector('[data-testid=subagent-policy]'))`);
    await renderer(`document.querySelector('[aria-label="Restrict subagent models"]').click()`);
    await renderer(`document.querySelector('[aria-label="Allow fixture/child"]').click()`);
    await setControl('Subagent run time limit in seconds', '5');
    await setControl('Subagent time limit policy', 'fixed');
    await setControl('fast candidate models', 'fixture/other\nfixture/child');
    await save();
    const saved = await renderer('window.api.agent.getSubagentConfig()');
    assert.equal(saved.timeoutMs, 5000); assert.equal(saved.timeoutPolicy, 'fixed'); assert.deepEqual(saved.allowedModels, ['fixture/child']); assert.deepEqual(saved.roles.fast, ['fixture/other', 'fixture/child']);
    await renderer(`window.api.agent.saveSubagentConfig({expectedRevision:${JSON.stringify(saved.revision)},agentScope:"user"})`);
    const conflict = await renderer(`window.api.agent.saveSubagentConfig({expectedRevision:${JSON.stringify(saved.revision)},allowedModels:undefined}).then(()=>false,error=>String(error).includes("changed elsewhere"))`);
    assert(conflict, "stale snapshots must not clear the allowed-model list");
    assert.deepEqual((await renderer("window.api.agent.getSubagentConfig()")).allowedModels, ["fixture/child"]);
    const disk = JSON.parse(fs.readFileSync(path.join(config, 'subagent.json'))); assert.equal(disk.maxConcurrency, 2); assert.deepEqual(disk.allowTools, ['read']);
    await clickText('.settings-nav-btn', '系统设置'); await clickText('.settings-nav-btn', '模型');
    await until(`document.querySelector('[aria-label="Subagent run time limit in seconds"]')?.value==='5'`);
    assert.equal(await renderer(`document.querySelector('[aria-label="Allow fixture/child"]').checked`), true);
    await setControl("Subagent run time limit in seconds", "");
    assert.equal(await renderer(`document.querySelector('[aria-label="Subagent run time limit in seconds"]').value`), "");
    await clickText(".subagent-policy button", "Save limits");
    await until(`document.querySelector(".subagent-policy [role=status]")?.textContent.includes("whole number")`);
    assert.equal((await renderer("window.api.agent.getSubagentConfig()")).timeoutMs, 5000);
    await setControl("Subagent run time limit in seconds", "5");
    await evaluate(`(async()=>{const image=await settingsWindow.capturePage();process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(path.join(out, 'settings.png'))},image.toPNG());return true})()`);
    assert.match(await prompt('fixed-limit', 'RUN_ALLOWED'), /CHILD_OK[\s\S]*Run time limit: 5s \(settings\)/);
    const beforeBlocked = report.childRequests;
    assert.match(await prompt('blocked-model', 'BLOCK_OTHER'), /unavailable|blocked/); assert.equal(report.childRequests, beforeBlocked);
    await setControl('Subagent time limit policy', 'allow-override'); await save();
    assert.match(await prompt('override-limit', 'RUN_ALLOWED'), /超时[\s\S]*Run time limit: 1s \(invocation\)/);
    await renderer(`document.querySelector('[aria-label="Allow fixture/child"]').click()`); await save();
    assert.deepEqual((await renderer('window.api.agent.getSubagentConfig()')).allowedModels, []);
    const beforeEmpty = report.childRequests;
    assert.match(await prompt('empty-list', 'RUN_ALLOWED'), /no available/); assert.equal(report.childRequests, beforeEmpty);
    await renderer(`document.querySelector('[aria-label="Restrict subagent models"]').click()`); await save();
    assert.equal((await renderer('window.api.agent.getSubagentConfig()')).allowedModels, undefined);
    // Disable transport retries so this proves the native agent retry decision.
    const settingsPath = path.join(config, 'settings.json');
    const recoverySettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    recoverySettings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 10, provider: { maxRetries: 0 } };
    fs.writeFileSync(settingsPath, JSON.stringify(recoverySettings));
    assert.match(await prompt('transient-recovery', 'RECOVER_TRANSIENT'), /CHILD_OK/);
    assert.equal(report.recoveryRequests, 2, 'packaged child must recover from the real billing-scope 503');
    report.status = 'passed';
    console.log('PASS packaged UI -> IPC -> subagent.json -> real worker: saved/reloaded controls, role order, allowlist/empty/reset, fixed time survives shorter call, override times out, unrelated config preserved, billing-scope 503 recovered');
  } catch (error) { report.status = 'failed'; report.error = error.stack; console.error(error.stack); process.exitCode = 1; }
  finally {
    if (ws?.readyState === WebSocket.OPEN) { try { await evaluate(`setTimeout(()=>process.mainModule.require('electron').app.quit(),100);true`); } catch {} }
    ws?.close(); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Closed')); }
    for (let i = 0; i < 50 && !exited; i++) await wait(100); if (child && !exited) child.kill('SIGTERM');
    server.closeAllConnections(); server.close(); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
  }
})();
