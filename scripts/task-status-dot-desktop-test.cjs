/**
 * 真实 Electron 验收：侧栏状态与未查看强调。
 *
 * 隔离 profile + 种子库 → 启动真实应用 → 断言：
 *  1. 已完成未确认的结果显示静态绿点，进行中任务显示动画。
 *  2. 从侧栏和看板打开任务后，两处同步清除未确认标记。
 *  3. 重启后两处都保持已确认。
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

/** 读取指定任务行显示的状态和正在播放的动画。 */
function dotProbe(title) {
  return `(() => {
    const item = [...document.querySelectorAll('.task-item')].find(el => el.querySelector('.task-item-title')?.textContent.trim() === ${JSON.stringify(title)});
    if (!item) return { found: false };
    const indicator = item.querySelector('[role="img"].task-status-indicator');
    const mark = indicator?.querySelector('.task-status-mark > *');
    const style = mark ? getComputedStyle(mark) : null;
    const bounds = mark?.getBoundingClientRect();
    return {
      found: true,
      label: indicator?.getAttribute('aria-label') ?? null,
      visible: Boolean(bounds?.width && bounds?.height),
      color: style?.backgroundColor ?? null,
      round: style?.borderRadius === '50%',
      animating: indicator?.getAnimations({ subtree: true }).some(animation => animation.playState === 'running') ?? false,
    };
  })()`;
}

const completedDot = {
  found: true,
  label: '已完成 · 未确认',
  visible: true,
  color: 'rgb(22, 163, 74)',
  round: true,
  animating: false,
};

const boardCardSelector = title => `.task-board-card[title="${title}"]`;

async function openBoard() {
  await evaluate('document.querySelector(\'.desktop-rail-module[aria-label="任务看板"]\').click()');
  await until(() => evaluate('document.querySelector(".task-board-views") !== null'), 'task board mounted');
  await evaluate(`[...document.querySelectorAll('.task-board-views button')].find(button => button.textContent.trim() === '全部').click()`);
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(boardCardSelector('DOT_DONE_UNREAD'))}))`), 'finished card visible');
}

function readBoardCard(title) {
  return evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(boardCardSelector(title))});
    if (!card) return null;
    const badge = card.querySelector('.task-board-unread');
    return {
      status: card.querySelector('.task-board-status').textContent,
      confirmation: badge?.textContent ?? null,
      dotColor: badge ? getComputedStyle(badge, '::before').backgroundColor : null,
    };
  })()`);
}

const boardUnconfirmed = { status: '已完成', confirmation: '未确认', dotColor: 'rgb(22, 163, 74)' };
const boardConfirmed = { status: '已完成', confirmation: null, dotColor: null };

(async () => {
  try {
    // 阶段 1：启动前把库喂好（应用启动时会在同一 profile 里打开它）
    cp.execFileSync(process.execPath, [seedBundle, dbPath], { cwd: root, stdio: 'inherit' });

    await launch('boot-1');
    const doneBefore = await evaluate(dotProbe('DOT_DONE_UNREAD'));
    assert.deepEqual(doneBefore, completedDot, '未查看的已完成任务显示静态绿点');
    const runningBefore = await evaluate(dotProbe('DOT_RUNNING'));
    assert.equal(runningBefore.label, '进行中');
    assert.equal(runningBefore.visible, true, '进行中图标可见');
    assert.equal(runningBefore.animating, true, '进行中动画正在播放');
    report.tests.push('已完成任务显示静态绿点，进行中任务显示动画');
    const shot1 = await rpc('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'before-click.png'), Buffer.from(shot1.data, 'base64'));

    await openBoard();
    assert.deepEqual(await readBoardCard('DOT_DONE_UNREAD'), boardUnconfirmed);
    assert.deepEqual(await readBoardCard('DOT_BOARD_UNREAD'), boardUnconfirmed);
    await evaluate('document.querySelector(\'.desktop-rail-module[aria-label="MyBuddy"]\').click()');
    await until(() => evaluate(`(${dotProbe('DOT_DONE_UNREAD')}).label === '已完成 · 未确认'`), 'sidebar task visible');

    // 从侧栏打开任务，确认同一结果。
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.task-item')].find(el => el.querySelector('.task-item-title')?.textContent.trim() === 'DOT_DONE_UNREAD');
      item.click(); return true;
    })()`);

    // 持久化：DB 写入 done_acked_at（IPC 异步，重试到落库）
    let persisted;
    await until(async () => {
      persisted = await evaluate(`window.api.db.listTasks().then(rows => rows.find(t => t.id === 'dot-done-unread'))`);
      return Boolean(persisted) && typeof persisted.doneAckedAt === 'number' && persisted.doneAckedAt > 0;
    }, 'DB done_acked_at written', 20000);
    assert.equal((await evaluate(dotProbe('DOT_DONE_UNREAD'))).label, null, '侧栏点击后绿点消失');
    assert.equal(persisted.updatedAt < Date.now() - 30_000, true, '确认动作不推进 updatedAt（不重排侧栏）');
    report.ackedAt = persisted.doneAckedAt;
    await openBoard();
    assert.deepEqual(await readBoardCard('DOT_DONE_UNREAD'), boardConfirmed, '侧栏确认同步到看板');

    // 新产物的结果时间可晚于对话与任务更新时间，打开看板卡片也应确认。
    assert.deepEqual(await readBoardCard('DOT_BOARD_UNREAD'), boardUnconfirmed);
    await evaluate(`document.querySelector(${JSON.stringify(boardCardSelector('DOT_BOARD_UNREAD'))}).click()`);
    await until(() => evaluate(`document.querySelector('.task-item.active .task-item-title')?.textContent === 'DOT_BOARD_UNREAD'`), 'board card opened the task');
    assert.equal((await evaluate(dotProbe('DOT_BOARD_UNREAD'))).label, null, '看板确认后侧栏也没有标记');
    await openBoard();
    assert.deepEqual(await readBoardCard('DOT_BOARD_UNREAD'), boardConfirmed, '看板点击后绿点消失');
    report.tests.push('从侧栏和看板打开结果后，两处同步清除未确认标记，且不触碰 updated_at');

    closeApp();
    await wait(1500);

    // 重启后验证查看确认水位。
    await launch('boot-2');
    const doneAfter = await evaluate(dotProbe('DOT_DONE_UNREAD'));
    assert.equal(doneAfter.found, true);
    assert.equal(doneAfter.label, null, '重启后已确认任务仍没有绿点');
    const runningAfter = await evaluate(dotProbe('DOT_RUNNING'));
    assert.equal(runningAfter.label, '进行中');
    assert.equal(runningAfter.animating, true, '重启后进行中动画仍在播放');
    const persistedAfter = await evaluate(`window.api.db.listTasks().then(rows => rows.find(t => t.id === 'dot-done-unread'))`);
    assert(
      typeof persistedAfter.doneAckedAt === 'number' && persistedAfter.doneAckedAt >= report.ackedAt,
      '重启后 DB 中确认水位仍在（未被退回未确认）',
    );
    await openBoard();
    assert.deepEqual(await readBoardCard('DOT_DONE_UNREAD'), boardConfirmed);
    assert.deepEqual(await readBoardCard('DOT_BOARD_UNREAD'), boardConfirmed);
    report.tests.push('重启后两处仍显示已确认，进行中动画保留');
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
