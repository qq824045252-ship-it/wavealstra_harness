/**
 * 安卓端（app/remote 打进 APK 的那份 UI）状态点验收：offscreen Electron + 真实 App 组件。
 *
 * 断言：
 *  1. 最近对话 + 抽屉任务列表：进行中 = 蓝点，已结束未查看 = 绿点，已确认 = 无点
 *  2. 点开「已结束未查看」任务 → 调用 ackDone(该任务) → 绿点消失（本机乐观清除）
 *  3. 整页重载（= 重开 App）后绿点仍不复活（本机确认水位落盘；服务端 ack 由 test:remote-done-ack 覆盖）
 *
 * 运行：pnpm -s test:remote-task-dot-ui-desktop
 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
process.chdir(path.resolve(__dirname, '..'));
const outDir = path.resolve('out/remote-tests/task-dot-ui');
if (!process.versions.electron) {
  fs.mkdirSync(outDir, { recursive: true });
  require('esbuild').buildSync({
    entryPoints: ['scripts/remote-task-dot-ui-fixture.tsx'], bundle: true, platform: 'browser', format: 'iife',
    jsx: 'automatic', outfile: path.join(outDir, 'task-dot-ui.js'), define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.writeFileSync(path.join(outDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="task-dot-ui.css"></head><body><div id="root"></div><script src="task-dot-ui.js"></script></body></html>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [__filename]; if (env.REMOTE_TEST_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-gpu');
  const r = require('node:child_process').spawnSync(require('electron'), args, { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  process.exit(r.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.resolve('out/remote-tests/task-dot-ui-profile'));
let win;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = (expression) => win.webContents.executeJavaScript(expression, true);
async function until(expression, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await evalJs(expression)) return; await delay(30); }
  throw Error('Timeout: ' + label);
}
const pass = (name) => console.log('PASS ' + name);
/** offscreen 窗口的 capturePage 在部分 GPU 组合下不可用：截图只做留证，失败不影响结论 */
async function screenshot(file) {
  try {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, file), image.toPNG());
    return true;
  } catch (error) {
    console.log('（截图跳过：' + (error && error.message) + '）');
    return false;
  }
}
/** 最近对话卡片 / 抽屉行 的点的探测表达式 */
const probeCard = (title) => `(() => {
  const card = [...document.querySelectorAll('.home-recent-card')].find(el => el.querySelector('.home-recent-title')?.textContent.trim() === ${JSON.stringify(title)});
  if (!card) return 'missing';
  if (card.querySelector('.task-status-dot--running')) return 'running';
  if (card.querySelector('.task-status-dot--done-unread')) return 'done-unread';
  return 'none';
})()`;
const probeDrawerRow = (title) => `(() => {
  const row = [...document.querySelectorAll('.drawer-item-btn')].find(el => el.querySelector('.drawer-task-title')?.textContent.trim() === ${JSON.stringify(title)});
  if (!row) return 'missing';
  if (row.querySelector('.task-status-dot--running')) return 'running';
  if (row.querySelector('.task-status-dot--done-unread')) return 'done-unread';
  return 'none';
})()`;

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      width: 390, height: 844, useContentSize: true, show: false, offscreen: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    await win.loadFile(path.join(outDir, 'index.html'));
    await until('!!window.harness && document.querySelectorAll(".home-recent-card").length === 3', 'home recents rendered');

    // 1. 最近对话卡片
    assert.equal(await evalJs(probeCard('DOT_RUNNING')), 'running', '进行中卡片 = 蓝点');
    assert.equal(await evalJs(probeCard('DOT_DONE_UNREAD')), 'done-unread', '已结束未查看卡片 = 绿点');
    assert.equal(await evalJs(probeCard('DOT_DONE_ACKED')), 'none', '已确认卡片 = 无点');
    pass('最近对话：蓝点 / 绿点 / 无点 与桌面端同语义');

    // 2. 抽屉任务列表同样的点
    await evalJs('window.harness.store.getState().setDrawerOpen(true)');
    await until('document.querySelectorAll(".drawer-item-btn").length === 3', 'drawer rows rendered');
    assert.equal(await evalJs(probeDrawerRow('DOT_RUNNING')), 'running', '抽屉行：进行中 = 蓝点');
    assert.equal(await evalJs(probeDrawerRow('DOT_DONE_UNREAD')), 'done-unread', '抽屉行：已结束未查看 = 绿点');
    assert.equal(await evalJs(probeDrawerRow('DOT_DONE_ACKED')), 'none', '抽屉行：已确认 = 无点');
    pass('抽屉任务列表：同一个判定，行内状态点一致');

    await screenshot('before-open.png');

    // 3. 点开「已结束未查看」→ ackDone + 绿点消失
    await evalJs(`[...document.querySelectorAll('.home-recent-card')].find(el => el.querySelector('.home-recent-title')?.textContent.trim() === 'DOT_DONE_UNREAD').click()`);
    await until('window.harness.ackCalls.length > 0', 'ackDone called');
    assert.deepEqual(await evalJs('window.harness.ackCalls'), ['t-done-unread'], '点开任务只对目标任务调用 ackDone');
    const ackedAt = await evalJs(`window.harness.state().tasks.find(t => t.id === 't-done-unread').doneAckedAt`);
    assert.equal(typeof ackedAt, 'number', '本机状态立即写入确认水位（绿点同帧消失）');
    pass('点开任务 → POST ackDone + 绿点立即消失');

    await evalJs('window.harness.store.getState().goHome()');
    await until('document.querySelectorAll(".home-recent-card").length === 3', 'back home');
    assert.equal(await evalJs(probeCard('DOT_DONE_UNREAD')), 'none', '返回首页后绿点不再出现');
    assert.equal(await evalJs(probeCard('DOT_RUNNING')), 'running', '同一时刻进行中的蓝点不受影响');
    pass('返回首页：已确认任务不再亮绿点，进行中任务照常亮蓝点');

    // 4. 整页重载 = 重开 App：本机水位落盘 → 绿点仍不复活
    win.webContents.reload();
    await until('!!window.harness && document.querySelectorAll(".home-recent-card").length === 3', 'reload home recents', 12000);
    assert.equal(await evalJs(probeCard('DOT_DONE_UNREAD')), 'none', '重开 App 后绿点不复活（本机水位持久）');
    assert.equal(await evalJs(probeCard('DOT_DONE_ACKED')), 'none', '已确认任务保持无点');
    assert.equal(await evalJs(probeCard('DOT_RUNNING')), 'running', '重开 App 后进行中任务仍是蓝点');
    pass('重开 App：绿点不复活（旧版电脑端也能保证点了就消失）');

    await evalJs('window.harness.store.getState().setDrawerOpen(true)');
    await screenshot('after-open.png');

    console.log('remote task dot ui: all assertions passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
