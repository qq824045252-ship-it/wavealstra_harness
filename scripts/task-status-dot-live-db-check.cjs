/**
 * 真实数据验收（发布前体检，不进默认门禁）：拿一份**线上库的副本**，用真实应用跑一遍，
 * 回答「升级后旧任务的绿点会不会集体亮起来 / 点击能否清除」。
 *
 * 只读源库（整份复制到隔离 profile，应用只写副本，绝不触碰 ~/.mybuddy/app.db）。
 *
 * 运行：
 *   MYBUDDY_DESKTOP_EXECUTABLE=<MyBuddy.exe> MYBUDDY_STATUS_DOT_LIVE_DB=<~/.mybuddy/app.db> pnpm -s test:task-status-dot:live
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const os = require('node:os'), cp = require('node:child_process'), net = require('node:net');
const root = path.resolve(__dirname, '..');
const executable = process.env.MYBUDDY_DESKTOP_EXECUTABLE;
const sourceDb = process.env.MYBUDDY_STATUS_DOT_LIVE_DB || path.join(os.homedir(), '.mybuddy', 'app.db');
const out = path.resolve(process.env.MYBUDDY_STATUS_DOT_OUT || path.join(root, 'out/tests/task-status-dot-live'));
fs.mkdirSync(out, { recursive: true });
const report = { sourceDb, executable: executable || 'out/main/index.js (dev electron)', tests: [], status: 'running' };

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-status-dot-live-'));
const home = path.join(temp, 'home'), agentDir = path.join(home, '.mybuddy');
for (const p of [agentDir, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local'), path.join(agentDir, 'plugins/mcp')]) fs.mkdirSync(p, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'plugins/mcp/mcp.json'), '{"mcpServers":{}}');
// 整份复制（含 WAL/SHM，保证看到的是线上真实最新状态）
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(sourceDb + suffix)) fs.copyFileSync(sourceDb + suffix, path.join(agentDir, 'app.db' + suffix));
}
report.dbBytes = fs.statSync(path.join(agentDir, 'app.db')).size;
// 复制的库与线上同版本；不写 settings/models：默认模型缺失不影响侧栏渲染
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false }));

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
async function launch() {
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local') };
  delete env.ELECTRON_RUN_AS_NODE;
  fd = fs.openSync(path.join(out, 'app.log'), 'w');
  const args = ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
  proc = executable
    ? cp.spawn(executable, args, { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true })
    : cp.spawn(require('electron'), [path.join(root, 'out/main/index.js'), ...args], { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true });
  let target;
  await until(async () => {
    if (proc.exitCode !== null) throw Error('app exited ' + proc.exitCode);
    try { target = (await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())).find(t => t.type === 'page' && t.url.includes('index.html')); return !!target; } catch { return false; }
  }, 'renderer target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  socket.addEventListener('message', e => { const v = JSON.parse(e.data), p = pending.get(v.id); if (!p) return; pending.delete(v.id); clearTimeout(p.timer); v.error ? p.reject(Error(JSON.stringify(v.error))) : p.resolve(v.result); });
  await rpc('Runtime.enable');
  await until(() => evaluate('Boolean(window.api?.db?.listTasks)'), 'preload api');
}

(async () => {
  try {
    await launch();
    // 等侧栏把任务渲染出来（真实库任务多，给足时间）
    await until(() => evaluate('document.querySelectorAll(".task-item").length > 0'), 'sidebar tasks rendered', 90000);
    await wait(2000);
    const dom = await evaluate(`(() => {
      const items = [...document.querySelectorAll('.task-item')];
      return {
        rows: items.length,
        green: items.filter(el => el.querySelector('.task-status-dot--done')).length,
        blue: items.filter(el => el.querySelector('.task-status-dot--running')).length,
        greenTitles: items.filter(el => el.querySelector('.task-status-dot--done')).map(el => el.querySelector('.task-item-title')?.textContent.trim()).slice(0, 10),
      };
    })()`);
    const db = await evaluate(`window.api.db.listTasks().then(rows => ({
      total: rows.length,
      nonArchived: rows.filter(r => !r.archived).length,
      acked: rows.filter(r => typeof r.doneAckedAt === 'number').length,
      unacked: rows.filter(r => r.doneAckedAt === null || r.doneAckedAt === undefined).length,
    }))`);
    report.dom = dom; report.db = db;
    assert(db.acked > 0, '升级已回填历史任务的 done_acked_at（不是全库未确认）');
    report.tests.push(`真实库迁移：${db.acked}/${db.total} 行已回填确认水位，${db.unacked} 行保持未确认`);
    report.tests.push(`侧栏 ${dom.rows} 行中绿点 ${dom.green} 个、蓝点 ${dom.blue} 个（升级后不应集体亮绿点）`);
    const shot = await rpc('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'live-db-sidebar.png'), Buffer.from(shot.data, 'base64'));

    if (dom.green > 0) {
      const before = await evaluate(`(() => {
        const item = [...document.querySelectorAll('.task-item')].find(el => el.querySelector('.task-status-dot--done'));
        return item.querySelector('.task-item-title').textContent.trim();
      })()`);
      await evaluate(`(() => {
        const item = [...document.querySelectorAll('.task-item')].find(el => el.querySelector('.task-status-dot--done'));
        item.click(); return true;
      })()`);
      await until(async () => await evaluate(`(() => {
        const item = [...document.querySelectorAll('.task-item')].find(el => el.querySelector('.task-item-title')?.textContent.trim() === ${JSON.stringify(before)});
        return item ? !item.querySelector('.task-status-dot--done') : true;
      })()`), 'green dot cleared after click', 20000);
      report.tests.push(`点击「${before}」→ 绿点消失（真实库任务）`);
      const after = await evaluate(`window.api.db.listTasks().then(rows => rows.filter(r => typeof r.doneAckedAt === 'number').length)`);
      assert(after >= db.acked, '点击后确认行数不减少');
    } else {
      report.tests.push('真实库升级后没有任何残留绿点：点击清除路径由隔离库桌面用例覆盖');
    }

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
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.rmSync(temp, { recursive: true, force: true }); break; } catch { await wait(500); }
      }
    }
  }
})();
