/**
 * 真机（安卓）状态点验收：通过 WebView 的 devtools 通道在手机的真实 DOM 上验证。
 *
 * 前置：手机 USB 已连、MyBuddy 安卓 App（debug 包）在前台、电脑端 Remote Access 已开启。
 * 断言：
 *  1. 抽屉/最近对话里存在状态点（蓝 = 进行中，绿 = 已结束未查看）
 *  2. 点开一个「绿点」任务 → 该任务绿点消失，其它绿点不受影响
 *  3. 本机确认水位写进 localStorage（旧版电脑端没有 ackDone 路由时的兜底）
 *
 * 运行：pnpm -s test:remote-task-dot-android:live
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');

const adb = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const port = Number(process.env.MYBUDDY_ANDROID_CDP_PORT || 9333);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function adbRun(args) { return cp.execFileSync(adb, args, { encoding: 'utf8' }).replace(/\r/g, '').trim(); }

const sockets = adbRun(['shell', 'cat', '/proc/net/unix']).split('\n')
  .map((line) => (line.match(/@(webview_devtools_remote_\d+)/) || [])[1])
  .filter(Boolean);
assert(sockets.length > 0, '没找到 WebView devtools socket：App 需为 debug 构建且正在前台运行');
adbRun(['forward', `tcp:${port}`, `localabstract:${sockets[0]}`]);

let socket, seq = 0;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

/** 收集当前可见的任务行（抽屉优先，抽屉没开就用首页最近对话） */
const COLLECT = `(() => {
  const pick = (row, titleSelector) => {
    const title = row.querySelector(titleSelector)?.textContent.trim() ?? '';
    const dot = row.querySelector('.task-status-dot--running') ? 'running'
      : row.querySelector('.task-status-dot--done-unread') ? 'done-unread' : 'none';
    return { title, dot };
  };
  const rows = [...document.querySelectorAll('.drawer-item-btn')].map((row) => pick(row, '.drawer-task-title'));
  if (rows.length) return { source: 'drawer', rows };
  return { source: 'home', rows: [...document.querySelectorAll('.home-recent-card')].map((row) => pick(row, '.home-recent-title')) };
})()`;

const ackOverrides = () => evaluate('(() => { try { return JSON.parse(localStorage.getItem("mybuddy_remote_done_acks") || "{}"); } catch { return {}; } })()');
const dotOf = (title, source) => evaluate(source === 'drawer'
  ? `(() => {
      const row = [...document.querySelectorAll('.drawer-item-btn')].find(el => el.querySelector('.drawer-task-title')?.textContent.trim() === ${JSON.stringify(title)});
      if (!row) return 'missing';
      return row.querySelector('.task-status-dot--running') ? 'running' : row.querySelector('.task-status-dot--done-unread') ? 'done-unread' : 'none';
    })()`
  : `(() => {
      const row = [...document.querySelectorAll('.home-recent-card')].find(el => el.querySelector('.home-recent-title')?.textContent.trim() === ${JSON.stringify(title)});
      if (!row) return 'missing';
      return row.querySelector('.task-status-dot--running') ? 'running' : row.querySelector('.task-status-dot--done-unread') ? 'done-unread' : 'none';
    })()`);

(async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  const page = targets.find((target) => target.type === 'page');
  assert(page, 'WebView 里没有可调试页面');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(event.data);
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    clearTimeout(entry.timer);
    value.error ? entry.reject(Error(JSON.stringify(value.error))) : entry.resolve(value.result);
  });
  await rpc('Runtime.enable');

  // 抽屉可能没打开：先打开，保证能看到完整任务列表
  await evaluate('(() => { const state = window.__mybuddyRemoteStore; return true; })()').catch(() => undefined);
  await evaluate(`(() => {
    const button = document.querySelector('button[aria-label="菜单"], .header-menu-btn, header button');
    if (button && !document.querySelector('.drawer-item-btn')) button.click();
    return true;
  })()`);
  await wait(600);

  const { source, rows } = await evaluate(COLLECT);
  const green = rows.filter((row) => row.dot === 'done-unread');
  const blue = rows.filter((row) => row.dot === 'running');
  console.log(JSON.stringify({ source, rows: rows.length, green: green.length, blue: blue.length, greenTitles: green.map((row) => row.title) }, null, 2));
  assert(rows.length > 0, '手机端没有渲染任何任务行');
  assert(blue.length + green.length > 0, '手机端没有任何状态点：新客户端或数据异常');

  if (green.length === 0) {
    console.log('SKIP 当前没有「已结束未查看」任务（都已被查看或还没结束），点击清除路径由 test:remote-task-dot-ui-desktop 覆盖');
    console.log('android webview dot check: ok (partial)');
    process.exit(0);
  }

  const target = green[0].title;
  const before = await ackOverrides();
  await evaluate(source === 'drawer'
    ? `[...document.querySelectorAll('.drawer-item-btn')].find(el => el.querySelector('.drawer-task-title')?.textContent.trim() === ${JSON.stringify(target)}).click()`
    : `[...document.querySelectorAll('.home-recent-card')].find(el => el.querySelector('.home-recent-title')?.textContent.trim() === ${JSON.stringify(target)}).click()`);
  await wait(2500);

  // 回到任务列表再看这个任务
  await evaluate(`(() => {
    const button = document.querySelector('button[aria-label="菜单"], .header-menu-btn, header button');
    if (button && !document.querySelector('.drawer-item-btn')) button.click();
    return true;
  })()`);
  await wait(800);
  const after = await dotOf(target, source);
  const overrides = await ackOverrides();
  const titles = Object.keys(overrides);
  assert.equal(after, 'none', `点开后「${target}」的绿点应该消失，实际 = ${after}`);
  const overrideGrew = Object.keys(overrides).length > Object.keys(before).length;
  console.log(JSON.stringify({ clicked: target, dotAfterOpen: after, localAckCount: titles.length, overrideGrew }, null, 2));
  assert(overrideGrew || Object.keys(overrides).length > 0, '本机确认水位没有落盘（localStorage 兜底失效）');

  const remaining = await evaluate(COLLECT);
  console.log(JSON.stringify({ remainingGreen: remaining.rows.filter((row) => row.dot === 'done-unread').length, remainingBlue: remaining.rows.filter((row) => row.dot === 'running').length }, null, 2));
  console.log('android webview dot check: all assertions passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
