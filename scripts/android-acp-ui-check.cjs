/**
 * 真机（安卓）ACP 入口验收：通过 WebView devtools 通道在真实 DOM 上验证。
 *
 * 前置：手机 USB 已连、MyBuddy 安卓 App（1.1.23+）在前台并已配对到电脑端。
 * 断言：
 *  1. composer 上存在 ACP 胶囊（证明 bootstrap.acpAgents 已下发）
 *  2. 点开面板后能看到「内置 MyBuddy（默认）」与至少一个电脑端 ACP Agent
 *  3. 面板能正常关闭
 *
 * 运行：pnpm -s test:acp-remote-android:live
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');

const adb = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const port = Number(process.env.MYBUDDY_ANDROID_CDP_PORT || 9334);
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

const STATE = `(() => {
  const pill = document.querySelector('.composer-acp-pill');
  return {
    url: location.href,
    screen: document.querySelector('.remote-screen')?.getAttribute('data-screen') ?? 'unknown',
    hasComposer: !!document.querySelector('.claude-composer-card'),
    hasAcpPill: !!pill,
    acpActive: !!document.querySelector('.composer-acp-pill.acp-active'),
    bodyText: document.body.innerText.slice(0, 300),
  };
})()`;

const SHEET = `(() => {
  const sheet = document.querySelector('.claude-sheet.open');
  if (!sheet) return { open: false };
  return {
    open: true,
    title: sheet.querySelector('.claude-sheet-title')?.textContent.trim() ?? '',
    items: [...sheet.querySelectorAll('.select-model-item, .add-to-chat-row')].map((row) => ({
      name: row.querySelector('.select-model-name, .add-to-chat-row-title')?.textContent.trim() ?? '',
      desc: row.querySelector('.select-model-desc, .add-to-chat-row-subtitle')?.textContent.trim() ?? '',
      disabled: row.disabled === true,
    })),
  };
})()`;

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
  // 等首屏与 bootstrap 落地（冷启动可能还在连接）
  await wait(1500);

  let state = await evaluate(STATE);
  for (let i = 0; i < 20 && !state.hasComposer; i += 1) {
    await wait(500);
    state = await evaluate(STATE);
  }
  console.log(JSON.stringify(state, null, 2));
  assert(state.hasComposer, '当前不是聊天界面（未配对或仍在连接页），无法验收 ACP 入口');
  assert(state.hasAcpPill, 'composer 上没有 ACP 胶囊：电脑端 ACP 目录为空，或客户端仍是旧包');

  await evaluate(`(() => { document.querySelector('.composer-acp-pill').click(); return true; })()`);
  await wait(700);
  const sheet = await evaluate(SHEET);
  console.log(JSON.stringify(sheet, null, 2));
  assert(sheet.open, '点 ACP 胶囊后面板没有打开');
  assert.equal(sheet.title, 'ACP Agent');
  const names = sheet.items.map((item) => item.name);
  assert(names.includes('内置 MyBuddy（默认）'), '面板缺少「内置 MyBuddy（默认）」');
  const acpAgents = sheet.items.filter((item) => !item.name.startsWith('内置 MyBuddy') && !item.name.includes('重新探测'));
  assert(acpAgents.length > 0, '面板里没有任何电脑端 ACP Agent（目录为空）');
  console.log(JSON.stringify({ acpAgents: acpAgents.map((item) => item.name) }, null, 2));

  await evaluate(`(() => { document.querySelector('.claude-sheet.open .claude-sheet-close-btn')?.click(); return true; })()`);
  await wait(500);
  const closed = await evaluate(SHEET);
  assert.equal(closed.open, false, '面板没有关闭');
  console.log('android ACP UI check: all assertions passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
