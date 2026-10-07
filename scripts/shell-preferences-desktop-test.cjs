/** Packaged Electron acceptance: legacy migration, both agent backends, and the real terminal PTY. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const os = require('node:os'), cp = require('node:child_process'), http = require('node:http'), net = require('node:net');
const root = path.resolve(__dirname, '..');
const executable = process.env.MYBUDDY_DESKTOP_EXECUTABLE;
assert(executable, 'Set MYBUDDY_DESKTOP_EXECUTABLE to the package under test');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-shell-desktop-'));
const home = path.join(temp, 'home'), agentDir = path.join(home, '.mybuddy');
const out = path.join(root, 'out/tests/shell-preferences-desktop'); fs.mkdirSync(out, { recursive: true });
for (const p of [agentDir, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local'), path.join(agentDir, 'plugins/mcp')]) fs.mkdirSync(p, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'plugins/mcp/mcp.json'), '{"mcpServers":{}}');
const ps = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const report = { executable, temp, tests: [], status: 'running' };
report.version = require('../package.json').version;
report.asarSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(path.dirname(executable), 'resources/app.asar'))).digest('hex');
let proc, socket, fd, seq = 0; const pending = new Map();
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, ms = 45000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await wait(100); } throw Error('Timeout: ' + label); }
function rpc(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), messages = body.messages;
    // Each case creates a fresh task; context projections can append user-role messages after a tool.
    const done = messages.some(m => m.role === 'tool');
    const names = (body.tools || []).map(t => t.function.name);
    const tool = names.includes('codemode')
      ? { name: 'codemode', arguments: JSON.stringify({ code: 'text(await tools.bash({command:"ls -la"}));' }) }
      : { name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) };
    const delta = done ? { role: 'assistant', content: 'SHELL_DESKTOP_COMPLETE' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'shell-call-' + Date.now(), type: 'function', function: tool }] };
    const packet = (delta, finish_reason) => ({ id: 'shell-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify(packet(delta, null)) + '\n\n');
    res.end('data: ' + JSON.stringify(packet({}, done ? 'stop' : 'tool_calls')) + '\n\ndata: [DONE]\n\n');
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
async function newTask(label) {
  await evaluate('document.querySelector(\'button[title="新建任务"]\')?.click();true');
  await until(() => evaluate('Boolean(document.querySelector(".hero textarea"))'), 'new task');
  await evaluate(`(()=>{const e=[...document.querySelectorAll('.hero-categories button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Missing category');e.click();return true})()`);
  await wait(100);
  await evaluate(`(()=>{const e=document.querySelector('.hero textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'SHELL_REGRESSION ${label}');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await wait(100); await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(() => evaluate('document.body.innerText.includes("SHELL_DESKTOP_COMPLETE")'), label + ' shell result');
  assert(!await evaluate('document.body.innerText.includes("Get-ChildItem:")'), 'PowerShell must never parse Bash');
  const tasks = await evaluate('window.api.db.listTasks()');
  return tasks.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
(async () => {
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'shell-fixture': { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', api: 'openai-completions', apiKey: 'fixture-only', models: [{ id: 'fixture', name: 'Shell Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ shellPath: ps, defaultProvider: 'shell-fixture', defaultModel: 'fixture', enabledModels: ['shell-fixture/fixture'], memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, permissionMode: 'auto' }));
    const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local') }; delete env.ELECTRON_RUN_AS_NODE;
    fd = fs.openSync(path.join(out, 'desktop.log'), 'w');
    proc = cp.spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port], { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true });
    let target; await until(async () => { if (proc.exitCode !== null) throw Error('App exited ' + proc.exitCode); try { target = (await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())).find(t => t.type === 'page' && t.url.includes('index.html')); return !!target; } catch { return false; } }, 'renderer');
    socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
    socket.addEventListener('message', e => { const v = JSON.parse(e.data), p = pending.get(v.id); if (!p) return; pending.delete(v.id); clearTimeout(p.timer); v.error ? p.reject(Error(JSON.stringify(v.error))) : p.resolve(v.result); });
    await rpc('Runtime.enable'); await until(() => evaluate('Boolean(window.api?.agent&&document.querySelector("textarea"))'), 'app ready');
    assert.equal(await evaluate('document.querySelector(".sidebar-version")?.textContent.trim()'), 'v' + report.version, 'The actual desktop must show the new version');
    const settings = await evaluate('window.api.agent.getAppSettings()'); assert.equal(settings.terminalShellPath, ps);
    const persisted = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')); assert.equal(persisted.shellPath, undefined); assert.equal(persisted.terminalShellPath, ps); report.tests.push('packaged startup migrates the legacy PowerShell preference');
    const office = await newTask('日常办公'); assert.equal(office.welcomeMode, 'working'); report.officeTask = office.id;
    let transcript = ''; for (const d of fs.readdirSync(path.join(agentDir, 'sessions'))) for (const f of fs.readdirSync(path.join(agentDir, 'sessions', d))) if (f.endsWith('.jsonl')) transcript += fs.readFileSync(path.join(agentDir, 'sessions', d, f), 'utf8');
    const results = transcript.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.message?.role === 'toolResult');
    assert(results.some(e => e.message.toolName === 'bash' && !e.message.isError && JSON.stringify(e.message.content).includes('total ')), 'Native Pi must persist a successful directory listing'); report.tests.push('office AgentSession executes ls -la successfully');
    const info = await evaluate(`window.api.terminal.open({taskId:${JSON.stringify(office.id)},cols:90,rows:30})`); assert.equal(info.shell, ps); assert.equal(info.alive, true);
    await evaluate(`window.api.terminal.input({taskId:${JSON.stringify(office.id)},sessionId:${JSON.stringify(info.sessionId)},data:"Write-Output ('TERMINAL_' + 'POWERSHELL_OK'); $PSVersionTable.PSVersion.Major\\r"});true`);
    await until(async () => (await evaluate(`window.api.terminal.tail({taskId:${JSON.stringify(office.id)},maxBytes:8192})`)).text.includes('TERMINAL_POWERSHELL_OK'), 'real PowerShell terminal output');
    await evaluate(`window.api.terminal.close({taskId:${JSON.stringify(office.id)},sessionId:${JSON.stringify(info.sessionId)}});true`); report.tests.push('real terminal PTY remains PowerShell and executes PowerShell syntax');
    const bot = await newTask('Bot'); assert.equal(bot.welcomeMode, 'bot');
    const durable = fs.readdirSync(path.join(agentDir, 'durable')).flatMap(d => fs.readFileSync(path.join(agentDir, 'durable', d, 'main.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(l => (JSON.parse(l).writes || []).flatMap(w => w.value?.model || [])));
    assert(durable.some(m => m.role === 'toolResult' && m.toolName === 'bash' && !m.isError && JSON.stringify(m.content).includes('total ')), 'Durable must persist a successful Bash directory listing');
    report.tests.push('Bot Durable executes ls -la successfully');
    const shot = await rpc('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'verified.png'), Buffer.from(shot.data, 'base64'));
    report.status = 'passed'; console.log(JSON.stringify(report, null, 2));
  } catch (e) { report.status = 'failed'; report.error = e.stack; console.error(e); process.exitCode = 1; }
  finally {
    if (socket) { try { await rpc('Browser.close'); } catch {} socket.close(); }
    if (proc) { await wait(400); if (proc.exitCode === null) cp.execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    if (fd !== undefined) fs.closeSync(fd); server.close(); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    // Isolated profile contains no user credentials; retain it on failure to diagnose the actual transcript.
    if (report.status === 'passed') fs.rmSync(temp, { recursive: true, force: true });
  }
})();
