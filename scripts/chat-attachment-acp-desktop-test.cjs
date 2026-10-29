/** Exercise sent attachments and ACP navigation in the actual app, with an isolated profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const out = path.join(root, 'out/tests/chat-attachment-acp', baseline ? 'before' : 'after');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-attachment-acp-'));
const home = path.join(profile, 'home');
const agentDir = path.join(home, '.mybuddy');
const workspace = path.join(profile, 'workspace');
const taskId = 'attachment-acp-fixture';
const attachment = path.join(workspace, 'sent attachment 中文.txt');
const controlAttachment = path.join(workspace, 'control.txt');
const relativeAttachment = 'relative attachment.txt';
const content = 'ATTACHMENT_DISK_READBACK_' + crypto.randomBytes(8).toString('hex');
const report = { baseline, tests: [], profile, status: 'running' };
for (const dir of [out, agentDir, workspace, path.join(agentDir, 'plugins/mcp'), path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(attachment, content);
fs.writeFileSync(controlAttachment, content);
fs.writeFileSync(path.join(workspace, relativeAttachment), content + '_RELATIVE');
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'unused-fixture', models: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enabledModels: ['fixture/fixture'], memoryEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light' }));
fs.writeFileSync(path.join(agentDir, 'plugins/mcp/mcp.json'), '{"mcpServers":{}}');
fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
const session = path.join(profile, 'fixture.jsonl');
const timestamp = new Date().toISOString();
fs.writeFileSync(session, [
  { type: 'session', version: 3, id: taskId, timestamp, cwd: workspace },
  { type: 'message', id: 'user-fixture', parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text: `查看已发送附件\n\n## 用户附带文件\n- sent attachment 中文.txt: ${attachment}\n- ${relativeAttachment}: ${relativeAttachment}` }], timestamp: Date.now() } },
  { type: 'message', id: 'assistant-fixture', parentId: 'user-fixture', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: `[附件对照入口](${controlAttachment.replace(/\\/g, '/')})` }], api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop', usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } }, timestamp: Date.now() } },
].map(row => JSON.stringify(row)).join('\n') + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(100); } throw Error('Timeout: ' + label); }
let proc, socket, seq = 0, fd;
const pending = new Map();
function rpc(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
const invoke = (method, ...args) => evaluate(`window.api.${method}(${args.map(value => JSON.stringify(value)).join(',')})`);
async function click(selector, text) {
  const point = await evaluate(`(()=>{const all=[...document.querySelectorAll(${JSON.stringify(selector)})];const el=${text === undefined ? 'all[0]' : `all.find(x=>x.textContent.trim()===${JSON.stringify(text)})`};if(!el)throw Error('Missing click target: '+${JSON.stringify(text || selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await delay(100);
}
async function screenshot(name) { const shot = await rpc('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64')); }
async function openMenu() {
  await click('button[title="添加"]');
  const point = await evaluate('(()=>{const el=[...document.querySelectorAll(".add-menu-item")].find(x=>x.textContent.trim()==="外部 Agent");const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await until(() => evaluate('Boolean(document.querySelector(".add-menu-flyout"))'), 'external Agent menu');
}
async function closeMenu() {
  await click('button[title="添加"]');
  await until(() => evaluate('!document.querySelector(".add-menu-item")'), 'add menu unmounted');
}
async function run() {
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PI_CODING_AGENT_DIR;
  for (const key of Object.keys(env)) if (/^MYBUDDY_/i.test(key)) delete env[key];
  const executable = process.env.MYBUDDY_DESKTOP_EXECUTABLE || require('electron');
  fd = fs.openSync(path.join(out, 'desktop.log'), 'w');
  proc = cp.spawn(executable, [...(process.env.MYBUDDY_DESKTOP_EXECUTABLE ? [] : [root]), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--disable-background-timer-throttling'], { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true });
  report.executable = executable;
  const build = process.env.MYBUDDY_DESKTOP_EXECUTABLE ? path.join(path.dirname(executable), 'resources/app.asar') : path.join(root, 'out/main/index.js');
  report.buildSha256 = crypto.createHash('sha256').update(fs.readFileSync(build)).digest('hex');
  // 托管 runner 上 Electron 冷启动可能 >30s（尤其与其它 GUI 用例并发时），放宽等 CDP target。
  const target = await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())).find(x => x.type === 'page' && x.url.includes('index.html')); } catch { return undefined; } }, 'renderer', 90000);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); });
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate('Boolean(window.api?.externalAgent && document.querySelector("button[title=设置]"))'), 'app ready');
  await invoke('db.upsertTask', { id: taskId, title: '附件与 ACP 验收', updatedAt: Date.now(), welcomeMode: 'coding', cwd: workspace, sessionFile: session });
  await rpc('Page.reload');
  await until(() => evaluate('document.body?.innerText.includes("附件与 ACP 验收")'), 'seeded task');
  await click('.task-item-title', '附件与 ACP 验收');
  console.log('STEP task selected');
  await until(() => evaluate('Boolean(document.querySelector(".user-attachment"))'), 'sent attachment');
  report.attachmentElement = await evaluate('document.querySelector(".user-attachment").tagName');
  await click('.user-attachment', 'sent attachment 中文.txt');
  await delay(500);
  report.attachmentOpened = await evaluate(`document.body.innerText.includes(${JSON.stringify(content)})`);
  console.log('STEP attachment', report.attachmentElement, report.attachmentOpened);
  await screenshot('attachment');
  if (!baseline) {
    assert.equal(report.attachmentElement, 'BUTTON'); assert.equal(report.attachmentOpened, true);
    report.tests.push('sent absolute attachment click -> real IPC, registration and disk content preview');
    await click('.user-attachment', relativeAttachment);
    await until(() => evaluate(`document.body.innerText.includes(${JSON.stringify(content + '_RELATIVE')})`), 'relative attachment preview');
    report.tests.push('relative attachment resolves against its task workspace');
  } else {
    assert.equal(report.attachmentOpened, false);
    report.control = await evaluate('[...document.querySelectorAll(".md-file-link")].map(x=>({text:x.textContent,title:x.title}))');
    await click('.md-file-link', '附件对照入口');
    await until(() => evaluate(`document.body.innerText.includes(${JSON.stringify(content)})`), 'control Markdown file opens', 5000);
    report.tests.push('before: attachment span does nothing; control Markdown link previews real disk content');
  }
  await click('button[title="设置"]');
  console.log('STEP settings opened');
  await click('.settings-nav-btn', 'ACP 管理');
  await until(() => evaluate('document.querySelectorAll(".acp-agent-row").length > 0'), 'ACP settings loaded');
  const agentCount = await evaluate('document.querySelectorAll(".acp-agent-row").length');
  await screenshot('acp-settings');
  // Observe both the immediate render and the expensive probe after the former 5s TTL.
  await evaluate('window.__acpLoading=[];new MutationObserver(()=>{const t=document.body.innerText;if(t.includes("正在加载外部 Agent")||t.includes("正在检测本机 ACP"))window.__acpLoading.push(t.slice(-2000));}).observe(document.body,{childList:true,subtree:true});true');
  const buttons = await evaluate('[...document.querySelectorAll("button")].filter(x=>/关闭/.test(x.title||x.getAttribute("aria-label")||"")).map(x=>({title:x.title,aria:x.getAttribute("aria-label"),class:x.className}))');
  report.closeButtons = buttons;
  await click('.settings-content-head .icon-btn');
  console.log('STEP ACP settings ready');
  await delay(6000);
  await openMenu();
  await until(() => evaluate('document.body.innerText.includes("Codex")'), 'ACP menu loaded');
  await closeMenu();
  await openMenu();
  await until(() => evaluate('document.body.innerText.includes("Codex")'), 'ACP reopened');
  report.loadingTransitions = await evaluate('window.__acpLoading.length');
  report.agentCount = agentCount;
  await screenshot('acp-menu');
  if (!baseline) { assert.equal(report.loadingTransitions, 0, 'warm ACP catalog must render immediately across settings and repeated menu mounts'); report.tests.push('settings -> menu after 6s -> menu remount reuses ACP catalog without loading placeholder'); }
  else report.tests.push('before: menu repeatedly shows loading after settings already detected agents');
  report.status = 'passed';
}
run().catch(async error => { report.status = 'failed'; report.error = error.stack; try { report.body = await evaluate('document.body.innerText.slice(-6000)'); await screenshot('failure'); } catch {} }).finally(async () => {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (socket) socket.close();
  if (proc && proc.exitCode === null) { try { cp.execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); } catch {} }
  if (fd !== undefined) fs.closeSync(fd);
  for (const p of pending.values()) clearTimeout(p.timer);
  process.exitCode = report.status === 'passed' ? 0 : 1;
});
