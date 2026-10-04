/** Actual Electron settings flow with an isolated profile; no model requests or Python installs. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const invalidShell = process.argv.includes('--invalid-shell');
const out = path.join(root, 'artifacts/local-capabilities', invalidShell ? 'invalid-shell' : 'desktop-live');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-capabilities-ui-'));
const agentDir = path.join(profile, '.mybuddy');
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light', language: 'zh-CN', ...(invalidShell ? { shellPath: path.join(profile, 'missing', 'bash.exe') } : {}) }));
fs.writeFileSync(path.join(agentDir, 'mcp.json'), '{"mcpServers":{}}');
for (const dir of ['AppData/Roaming', 'AppData/Local']) fs.mkdirSync(path.join(profile, dir), { recursive: true });
const report = { startedAt: new Date().toISOString(), tests: [], status: 'running' };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child, socket, fd, id = 0;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(Error('CDP timeout: ' + method)); }, 20000);
    pending.set(n, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: n, method, params }));
  });
}
async function evaluate(expression) {
  const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function until(expression, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await evaluate(expression); if (value) return value; await delay(100); }
  throw Error('Timed out: ' + expression);
}
async function click(selector) {
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await delay(150);
}
async function screenshot(name) {
  const r = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64'));
}
async function test(name, action) {
  const row = { name, status: 'running' }; report.tests.push(row); save();
  try { row.details = await action(); row.status = 'passed'; console.log('PASS ' + name); }
  catch (error) { row.status = 'failed'; row.error = error.message; console.error('FAIL ' + name + ': ' + error.message); }
  save();
}
const row = (id) => `[data-capability-id="${id}"]`;
async function check(id) {
  await click(row(id) + ' .capability-check-btn');
  await until(`!document.querySelector(${JSON.stringify(row(id) + ' .capability-check-btn')}).disabled`, 30000);
  return evaluate(`({text:document.querySelector(${JSON.stringify(row(id))}).innerText,message:document.querySelector('.capability-message')?.textContent})`);
}
(async () => {
  try {
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
    const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'), PI_CODING_AGENT_DIR: agentDir };
    delete env.ELECTRON_RUN_AS_NODE;
    fd = fs.openSync(path.join(out, 'desktop.log'), 'w');
    child = cp.spawn(require('electron'), [path.join(root, 'out/main/index.js'), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port], { cwd: profile, env, stdio: ['ignore', fd, fd], windowsHide: true });
    let page;
    for (let n = 0; n < 120; n++) {
      try { page = (await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json())).find((item) => item.type === 'page' && !item.url.startsWith('devtools')); if (page) break; } catch {}
      if (child.exitCode !== null) throw Error('Electron exited: ' + child.exitCode);
      await delay(250);
    }
    assert(page, 'No Electron renderer');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', (event) => { const m = JSON.parse(event.data), request = pending.get(m.id); if (!request) return; pending.delete(m.id); clearTimeout(request.timer); m.error ? request.reject(Error(JSON.stringify(m.error))) : request.resolve(m.result); });
    await rpc('Runtime.enable');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1360, height: 1080, deviceScaleFactor: 1, mobile: false });
    await until(`Boolean(window.api?.agent?.getBuiltinCapabilities && document.querySelector('button[title="设置"]'))`, 30000);
    await click('button[title="设置"]');
    const tab = await until(`(() => { const tabs = [...document.querySelectorAll('.settings-nav-btn')]; return tabs.findIndex(e => e.textContent.trim() === '工具能力') + 1; })()`);
    await click('.settings-nav-btn:nth-child(' + tab + ')');
    await until('Boolean(document.querySelector(".capabilities-page"))');
    await click('details:has([data-capability-id="terminal"]) > summary');
    await click('details:has([data-capability-id="runtime-diagnostics"]) > summary');

    await test('local tools start unverified and show only canonical bash', async () => {
      const state = await evaluate(`({terminal:document.querySelector(${JSON.stringify(row('terminal'))}).innerText,code:document.querySelector(${JSON.stringify(row('code-execution'))}).innerText,browser:document.querySelector(${JSON.stringify(row('browser'))}).innerText,diagnostics:document.querySelector(${JSON.stringify(row('runtime-diagnostics'))}).closest('details').querySelector('h3').textContent})`);
      assert.match(state.terminal, /待检查/); assert.match(state.terminal, /bash/); assert(!state.terminal.includes('terminal'));
      assert.match(state.code, /待检查/); assert(!state.browser.includes('runtime_probe')); assert.equal(state.diagnostics, '开发诊断');
      await screenshot('initial-local-tools'); return state;
    });
    if (invalidShell) {
      await test('failed command check remains visible after status refresh', async () => {
        const state = await check('terminal');
        assert.match(state.text, /离线/); assert.match(state.message, /Custom shell path not found/);
        assert(await evaluate('Boolean(document.querySelector(".capability-message.is-error"))'));
        const saved = await evaluate('window.api.agent.getBuiltinCapabilities()');
        assert.equal(saved.capabilities.find(item => item.id === 'terminal').state, 'offline');
        await screenshot('failed-check-visible'); return state;
      });
      report.status = report.tests.every(item => item.status === 'passed') ? 'passed' : 'failed'; save();
      if (report.status !== 'passed') process.exitCode = 1;
      return;
    }
    await test('command check actually executes and updates badge', async () => { const state = await check('terminal'); assert.match(state.text, /已就绪/); assert.match(state.message, /实际执行 Bash/); return state; });
    await test('missing Python is partial availability without installation', async () => { const state = await check('code-execution'); assert.match(state.text, /部分可用/); assert.match(state.message, /JavaScript/); assert.match(state.message, /Python.*尚未准备/); const environments = path.join(agentDir, 'runtimes/python/environments'); assert(!fs.existsSync(environments) || fs.readdirSync(environments).length === 0, 'Check must not install Python'); return state; });
    await test('UI and desktop probes read actual targets', async () => { const state = await check('browser'); assert.match(state.message, /实际读取通过/); assert.match(state.message, /应用界面/); assert.match(state.message, /Windows 桌面/); return state; });
    await test('runtime diagnostics reads attached renderer', async () => { const state = await check('runtime-diagnostics'); assert.match(state.text, /已就绪/); assert.match(state.message, /实际读取运行状态/); return state; });
    await test('subagent check starts trusted worker entry without model inference', async () => { const state = await check('subagent'); assert.match(state.text, /已就绪/); assert.match(state.message, /实际启动.*版本/); return state; });
    await test('checking another capability preserves unsaved draft', async () => {
      await click(row('subagent') + ' .switch');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row('subagent') + ' .switch')}).getAttribute('aria-pressed')`), 'false');
      await check('terminal');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row('subagent') + ' .switch')}).getAttribute('aria-pressed')`), 'false');
      await click(row('subagent') + ' .switch'); return { unsavedDraftPreserved: true };
    });
    await test('command and diagnostics switches save independently', async () => {
      await click(row('terminal') + ' .switch'); await click(row('browser') + ' .switch');
      await click('.capabilities-footer .btn.primary');
      const config = await until(`window.api.agent.getBuiltinCapabilities().then(s=>!s.config.execution.terminalEnabled&&!s.config.browser.enabled&&s.config.diagnostics.enabled?s.config:false)`);
      assert.equal(config.diagnostics.enabled, true);
      assert.match((await evaluate(`document.querySelector(${JSON.stringify(row('terminal'))}).innerText`)), /已关闭/);
      await screenshot('independent-switches'); return { commandEnabled: config.execution.terminalEnabled, uiEnabled: config.browser.enabled, diagnosticsEnabled: config.diagnostics.enabled };
    });
    report.status = report.tests.every((item) => item.status === 'passed') ? 'passed' : 'failed'; save();
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) { report.status = 'failed'; report.error = error.stack; save(); console.error(error); process.exitCode = 1; }
  finally {
    try { if (socket?.readyState === WebSocket.OPEN) await rpc('Browser.close'); } catch {}
    socket?.close(); for (const request of pending.values()) clearTimeout(request.timer); pending.clear();
    await delay(800); if (child?.exitCode === null) child.kill(); if (fd !== undefined) fs.closeSync(fd);
  }
})();
