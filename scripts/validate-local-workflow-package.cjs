const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const exe = path.resolve(process.argv[2] || 'release/win-unpacked/MyBuddy.exe');
assert(fs.existsSync(exe), 'Packaged executable missing');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'out/tests/local-workflow-package');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-workflow-package-'));
const config = path.join(profile, '.mybuddy');
for (const dir of [out, config, path.join(profile, 'appdata'), path.join(profile, 'localappdata')]) fs.mkdirSync(dir, { recursive: true });
const fixture = path.join(profile, 'tui.cjs');
fs.writeFileSync(fixture, `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HSTALE\\r\\x1b[2KREADY');process.stdin.on('data',d=>{const s=d.toString();if(s.includes('g'))process.stdout.write('\\r\\nINPUT_OK');if(s.includes('s'))process.stdout.write('\\r\\nSIZE='+process.stdout.columns+'x'+process.stdout.rows);if(s.includes('\\x03')){process.stdout.write('\\r\\nINTERRUPTED');process.exit(0)}});`);
const report = { exe, profile, status: 'running', toolSteps: [], scheduledRequests: 0 };
let setupStep = 0;
function findTerminal(value) {
  if (typeof value === 'string') { try { return findTerminal(JSON.parse(value)); } catch { return undefined; } }
  if (!value || typeof value !== 'object') return undefined;
  if (value.terminalId && value.sessionId) return value;
  for (const child of Object.values(value)) { const found = findTerminal(child); if (found) return found; }
}
const server = http.createServer(async (req, res) => {
  try {
    assert(req.method === 'POST' && req.url.endsWith('/responses'));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const lastUser = [...body.input].reverse().find(item => item.role === 'user');
    const scheduled = JSON.stringify(lastUser).includes('SCHEDULED_WORKFLOW_CHECK');
    let output;
    if (scheduled) { report.scheduledRequests++; output = message('SCHEDULED_DONE'); }
    else {
      const previous = [...body.input].reverse().find(item => item.type === 'function_call_output');
      const terminal = findTerminal(previous?.output) || findTerminal(body.input);
      const ids = terminal ? { terminal_id: terminal.terminalId, session_id: terminal.sessionId } : {};
      const steps = [
        ['terminal_exec', { action: 'open' }],
        ['terminal_exec', { action: 'input', ...ids, text: `node '${fixture.replaceAll("'", "''")}'\r` }],
        ['terminal_exec', { action: 'read', ...ids, wait_for: 'READY', timeout_ms: 15000 }],
        ['terminal_exec', { action: 'input', ...ids, text: 'g' }],
        ['terminal_exec', { action: 'read', ...ids, wait_for: 'INPUT_OK' }],
        ['terminal_exec', { action: 'resize', ...ids, cols: 100, rows: 30 }],
        ['terminal_exec', { action: 'input', ...ids, text: 's' }],
        ['terminal_exec', { action: 'read', ...ids, wait_for: 'SIZE=100x30' }],
        ['terminal_exec', { action: 'input', ...ids, text: '\x03' }],
        ['terminal_exec', { action: 'read', ...ids, wait_for: 'INTERRUPTED' }],
        ['terminal_exec', { action: 'close', ...ids }],
        ['automation_exec', { action: 'create', name: 'Packaged workflow', prompt: 'SCHEDULED_WORKFLOW_CHECK', schedule_type: 'every', schedule_expr: '2s', target: 'current-task', max_runs: 1, restart_policy: 'pause' }],
        ['automation_exec', { action: 'list' }],
      ];
      if (previous) report.toolSteps.push({ step: setupStep - 1, result: previous.output });
      if ([3, 5, 8, 10].includes(setupStep)) assert.equal(terminal?.wait, 'matched', JSON.stringify(previous));
      if (setupStep === 3) { assert.equal(terminal.screen[0], 'READY'); assert(!terminal.screen.join('\n').includes('STALE')); }
      const step = steps[setupStep++];
      output = step ? [{ type: 'function_call', id: `fc_${setupStep}`, call_id: `call_${setupStep}`, name: step[0], arguments: JSON.stringify(step[1]) }] : message('SETUP_DONE');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const item of output) for (const type of ['response.output_item.added', 'response.output_item.done']) res.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `response_${setupStep}_${report.scheduledRequests}`, model: 'workflow', status: 'completed', output, usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
  } catch (error) { report.serverError = error.stack; res.writeHead(500).end('{}'); }
});
function message(text) { return [{ type: 'message', id: `msg_${setupStep}_${report.scheduledRequests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }]; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, ws, exited = false;
const pending = new Map(); let sequence = 0;
async function rpc(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error(`Inspector timeout: ${method}`)); }, 60000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
async function renderer(expression) { return evaluate(`globalThis.workflowWindow.webContents.executeJavaScript(${JSON.stringify(expression)})`); }
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(config, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only', models: [{ id: 'workflow', name: 'Workflow fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    fs.writeFileSync(path.join(config, 'auth.json'), '{}');
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'workflow', enabledModels: ['fixture/workflow'], memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, proxyUrl: '', retry: { enabled: false } }));
    const portServer = net.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve)); const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
    const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'appdata'), LOCALAPPDATA: path.join(profile, 'localappdata'), PI_CODING_AGENT_DIR: config };
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; for (const key of Object.keys(env)) if (/^MYBUDDY_/i.test(key)) delete env[key];
    const log = fs.openSync(path.join(out, 'desktop.log'), 'w');
    child = spawn(exe, [`--inspect=127.0.0.1:${port}`, `--user-data-dir=${path.join(profile, 'chromium')}`], { cwd: profile, env, windowsHide: true, stdio: ['ignore', log, log] }); fs.closeSync(log); child.on('exit', () => { exited = true; });
    let target; for (let i = 0; i < 150; i++) { assert(!exited, 'Package exited'); try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())).find(t => t.type === 'node'); } catch {} if (target) break; await wait(200); }
    assert(target, 'Inspector absent'); ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = event => { const msg = JSON.parse(event.data); const entry = pending.get(msg.id); if (!entry) return; pending.delete(msg.id); clearTimeout(entry.timer); msg.error ? entry.reject(Error(JSON.stringify(msg.error))) : entry.resolve(msg.result); };
    assert.equal(await evaluate('process.pid'), child.pid);
    await evaluate(`(async()=>{const req=process.mainModule.require.bind(process.mainModule),{app,BrowserWindow}=req('electron');await app.whenReady();if(req('node:os').homedir()!==${JSON.stringify(profile)}||!app.getPath('userData').startsWith(${JSON.stringify(profile)}))throw Error('Profile isolation failed');for(let i=0;i<150;i++){globalThis.workflowWindow=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('out/renderer/index.html')&&!w.webContents.isLoadingMainFrame());if(globalThis.workflowWindow)break;await new Promise(r=>setTimeout(r,200))}if(!globalThis.workflowWindow)throw Error('Renderer absent '+JSON.stringify(BrowserWindow.getAllWindows().map(w=>({url:w.webContents.getURL(),loading:w.webContents.isLoadingMainFrame()}))));return true})()`);
    report.identity = await evaluate(`(()=>{const {app}=process.mainModule.require('electron');return {version:app.getVersion(),packaged:app.isPackaged,userData:app.getPath('userData'),pid:process.pid}})()`);
    assert(report.identity.packaged); assert.equal(report.identity.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version);
    await renderer(`window.api.db.upsertTask({id:'workflow-acceptance',title:'Workflow acceptance',updatedAt:Date.now(),modelId:'fixture/workflow',permissionMode:'auto',welcomeMode:'working'})`);
    const result = await renderer(`window.api.agent.prompt({taskId:'workflow-acceptance',text:'SETUP_WORKFLOW',modelId:'fixture/workflow',permissionMode:'auto',userMessageId:'workflow-user',assistantMessageId:'workflow-assistant'})`);
    assert(!result.error, JSON.stringify(result)); assert(!report.serverError, report.serverError); assert.equal(setupStep, 14);
    for (let i = 0; i < 200; i++) { report.runs = await renderer('window.api.cron.runs(20)'); if (report.runs.some(run => run.status === 'success')) break; await wait(100); }
    assert.equal(report.scheduledRequests, 1); assert.equal(report.runs.find(run => run.status === 'success')?.taskId, 'workflow-acceptance');
    report.jobs = await renderer('window.api.cron.list()'); assert.equal(report.jobs.length, 1); assert.equal(report.jobs[0].enabled, false); assert.equal(report.jobs[0].runCount, 1);
    await renderer(`document.querySelector('.sidebar-user-main').click()`); await wait(100);
    await renderer(`(()=>{const item=[...document.querySelectorAll('.sidebar-popup-item')].find(e=>e.textContent.includes('自动化'));if(!item)throw Error('Automation menu absent');item.click()})()`); await wait(400);
    const text = await renderer('document.body.innerText'); assert(text.includes('Packaged workflow') && text.includes('Continue task') && text.includes('Pause on restart'), text);
    await evaluate(`(async()=>{const image=await globalThis.workflowWindow.capturePage();process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(path.join(out, 'automation.png'))},image.toPNG());return true})()`);
    report.asarSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe), 'resources/app.asar'))).digest('hex'); report.status = 'passed';
    console.log('PASS actual packaged tools: ConPTY TUI screen/input/resize/Ctrl-C/close, timed continuation with quota, Automation UI, isolated profile');
    await evaluate(`setTimeout(()=>process.mainModule.require('electron').app.quit(),100);true`);
  } catch (error) { report.status = 'failed'; report.error = error.stack; console.error(error.stack); process.exitCode = 1; }
  finally { ws?.close(); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Closed')); } for (let i = 0; i < 50 && !exited; i++) await wait(100); if (child && !exited) child.kill('SIGTERM'); server.closeAllConnections(); server.close(); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); }
})();
