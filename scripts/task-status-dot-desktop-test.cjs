/**
 * 真实 Electron 验收：侧栏状态点（bug: 「绿点一直存在、点击不清除」）。
 *
 * 隔离 profile + 种子库 → 启动真实应用 → 断言：
 *  1. 已结束未查看的任务显示绿点；进行中的任务显示蓝点
 *  2. 点击该任务 → 绿点消失（DOM），且 DB done_acked_at 被写入
 *  3. 重启应用 → 绿点仍然不出现（持久化，这是原 bug 的核心）
 *
 * 运行：
 *   MYBUDDY_DESKTOP_EXECUTABLE=<安装包 MyBuddy.exe> node scripts/test-guard.mjs scripts/task-status-dot-desktop-test.cjs
 *   （不设环境变量时走本地构建 out/main/index.js + node_modules/electron）
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const os = require('node:os'), cp = require('node:child_process'), net = require('node:net');
const root = path.resolve(__dirname, '..');
const seedBundle = path.join(root, 'out/tests/task-status-dot-seed.cjs');
const executable = process.env.MYBUDDY_DESKTOP_EXECUTABLE;
const out = path.resolve(process.env.MYBUDDY_STATUS_DOT_OUT || path.join(root, 'out/tests/task-status-dot-desktop'));
fs.mkdirSync(out, { recursive: true });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-status-dot-desktop-'));
const home = path.join(temp, 'home'), agentDir = path.join(home, '.mybuddy');
for (const p of [agentDir, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local'), path.join(agentDir, 'plugins/mcp')]) fs.mkdirSync(p, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'plugins/mcp/mcp.json'), '{"mcpServers":{}}');
const dbPath = path.join(agentDir, 'app.db');
const report = { executable: executable || 'out/main/index.js (dev electron)', temp, dbPath, tests: [], status: 'running' };
report.version = require('../package.json').version;

// 固定 fixture provider（指向一个不监听任何端口的地址：本用例不发 prompt，只需要应用能正常启动）
const deadPort = 1;
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'dot-fixture': { baseUrl: 'http://127.0.0.1:' + deadPort + '/v1', api: 'openai-completions', apiKey: 'fixture-only', models: [{ id: 'fixture', name: 'Dot Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'dot-fixture', defaultModel: 'fixture', enabledModels: ['dot-fixture/fixture'], memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, permissionMode: 'auto' }));

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await wait(120); } throw Error('Timeout: ' + label); }

let proc, socket, fd, seq = 0; const pending = new Map();
function rpc(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }

function closeApp() {
  try { if (socket) socket.close(); } catch {}
  socket = undefined;
  if (proc && proc.exitCode === null) { try { cp.execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
  proc = undefined;
  if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
}

/** 启动一次真实应用（打包 exe 或本地 electron + out/main/index.js），返回 CDP 就绪后的操作句柄 */
async function launch(label) {
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local') };
  delete env.ELECTRON_RUN_AS_NODE;
  fd = fs.openSync(path.join(out, label + '.log'), 'w');
  const args = ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
  proc = executable
    ? cp.spawn(executable, args, { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true })
    : cp.spawn(require('electron'), [path.join(root, 'out/main/index.js'), ...args], { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true });
  let target;
  await until(async () => {
    if (proc.exitCode !== null) throw Error(`${label}: app exited ${proc.exitCode}`);
    try { target = (await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())).find(t => t.type === 'page' && t.url.includes('index.html')); return !!target; } catch { return false; }
  }, label + ': renderer target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  socket.addEventListener('message', e => { const v = JSON.parse(e.data), p = pending.get(v.id); if (!p) return; pending.delete(v.id); clearTimeout(p.timer); v.error ? p.reject(Error(JSON.stringify(v.error))) : p.resolve(v.result); });
  await rpc('Runtime.enable');
  await until(() => evaluate('Boolean(window.api?.db?.listTasks)'), label + ': preload api');
  await until(() => evaluate('document.querySelectorAll(".task-item").length > 0'), label + ': sidebar tasks rendered');
}

/** 读取指定标题任务的状态点（"done" 绿点 / "running" 蓝点 / null 无点） */
function dotProbe(title) {
  return `(() => {
    const item = [...document.querySelectorAll('.task-item')].find(el => el.querySelector('.task-item-title')?.textContent.trim() === ${JSON.stringify(title)});
    if (!item) return { found: false };
    return {
      found: true,
      done: Boolean(item.querySelector('.task-status-dot--done')),
      running: Boolean(item.querySelector('.task-status-dot--running')),
      classes: item.className,
    };
  })()`;
}

(async () => {
  try {
    // 阶段 1：启动前把库喂好（应用启动时会在同一 profile 里打开它）
    cp.execFileSync(process.execPath, [seedBundle, dbPath], { cwd: root, stdio: 'inherit' });

    await launch('boot-1');
    const doneBefore = await evaluate(dotProbe('DOT_DONE_UNREAD'));
    assert(doneBefore.found, '种子任务出现在侧栏');
    assert.equal(doneBefore.done, true, '已结束未查看的任务显示绿点');
    const runningBefore = await evaluate(dotProbe('DOT_RUNNING'));
    assert.equal(runningBefore.running, true, '进行中的任务显示蓝点');
    assert.equal(runningBefore.done, false, '进行中的任务不带绿点');
    report.tests.push('侧栏：已结束未查看 = 绿点，进行中 = 蓝点');
    const shot1 = await rpc('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'before-click.png'), Buffer.from(shot1.data, 'base64'));

    // 点击任务 → 绿点消失（这是原始 bug：点了也不消失）
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.task-item')].find(el => el.querySelector('.task-item-title')?.textContent.trim() === 'DOT_DONE_UNREAD');
      item.click(); return true;
    })()`);
    await until(async () => !(await evaluate(dotProbe('DOT_DONE_UNREAD'))).done, '点击后绿点消失（DOM）', 20000);
    report.tests.push('点击任务 → 绿点立即消失');

    // 持久化：DB 写入 done_acked_at（IPC 异步，重试到落库）
    let persisted;
    await until(async () => {
      persisted = await evaluate(`window.api.db.listTasks().then(rows => rows.find(t => t.id === 'dot-done-unread'))`);
      return Boolean(persisted) && typeof persisted.doneAckedAt === 'number' && persisted.doneAckedAt > 0;
    }, 'DB done_acked_at written', 20000);
    assert.equal(persisted.updatedAt < Date.now() - 30_000, true, '确认动作不推进 updatedAt（不重排侧栏）');
    report.ackedAt = persisted.doneAckedAt;
    report.tests.push('点击写入 DB done_acked_at，且不触碰 updated_at');

    closeApp();
    await wait(1500);

    // 阶段 2：重启应用 → 已确认的任务不得再亮绿点（原 bug 的重启回归）
    await launch('boot-2');
    const doneAfter = await evaluate(dotProbe('DOT_DONE_UNREAD'));
    assert.equal(doneAfter.found, true, '重启后任务仍在侧栏');
    assert.equal(doneAfter.done, false, '重启后绿点不复活（持久化生效）');
    const runningAfter = await evaluate(dotProbe('DOT_RUNNING'));
    assert.equal(runningAfter.running, true, '重启后进行中任务仍显示蓝点');
    const persistedAfter = await evaluate(`window.api.db.listTasks().then(rows => rows.find(t => t.id === 'dot-done-unread'))`);
    assert(
      typeof persistedAfter.doneAckedAt === 'number' && persistedAfter.doneAckedAt >= report.ackedAt,
      '重启后 DB 中确认水位仍在（未被退回未确认）',
    );
    report.tests.push('重启应用后已查看的绿点不复活，进行中蓝点不受影响');
    const shot2 = await rpc('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'after-restart.png'), Buffer.from(shot2.data, 'base64'));

    closeApp();
    report.status = 'passed';
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    report.status = 'failed';
    report.error = e.stack;
    console.error(e);
    process.exitCode = 1;
  } finally {
    closeApp();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    if (report.status === 'passed') {
      // Windows 上刚被 taskkill 的 Electron 仍可能短暂持有 profile 文件句柄：清理失败不影响结论。
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.rmSync(temp, { recursive: true, force: true }); break; }
        catch { await wait(500); }
      }
    }
  }
})();
