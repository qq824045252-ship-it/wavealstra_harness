/**
 * 手机 → 桌面实时同步验收（真机 + 真桌面）：
 *  桌面端打开 ACP 任务 → 手机发送一轮 → 桌面端必须「不刷新任务」就出现该轮用户气泡与流式回复。
 *
 * 前置：
 *  - 桌面 MyBuddy 以 --remote-debugging-port=<port> 启动，且停在目标任务
 *  - 手机 App 在前台、已配对，且停在同一个任务
 *
 * 说明：这条链路专门覆盖「ACP 事件补历史」修复 —— 修复前桌面端只会更新已存在的消息，
 * 手机发起的轮次在桌面上永远不出现，直到手动切走再切回。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdp(port, pick) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find(pick);
  if (!page) throw new Error(`CDP :${port} 没找到目标页`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(event.data);
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    value.error ? entry.reject(Error(JSON.stringify(value.error))) : entry.resolve(value.result);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await rpc('Runtime.enable');
  const evaluate = async (expression) => {
    const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  return { evaluate, close: () => socket.close() };
}

const DESKTOP_PORT = Number(process.env.MYBUDDY_DESKTOP_CDP_PORT || 9223);
const PHONE_PORT = Number(process.env.MYBUDDY_ANDROID_CDP_PORT || 9338);
const message = process.env.MYBUDDY_SYNC_TEST_MESSAGE || `只回复一句：ACP 实时同步 OK #${Date.now().toString(36)}。不要调用任何工具。`;

(async () => {
  // 1) 手机：找到 WebView devtools 并转发端口
  const cp = require('node:child_process');
  const adb = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
  const unix = cp.execFileSync(adb, ['shell', 'cat', '/proc/net/unix'], { encoding: 'utf8' }).replace(/\r/g, '');
  const socketName = (unix.split('\n').map((line) => (line.match(/@(webview_devtools_remote_\d+)/) || [])[1]).filter(Boolean))[0];
  assert(socketName, '手机 WebView devtools socket 不存在（App 需在前台且为 debug 包）');
  cp.execFileSync(adb, ['forward', `tcp:${PHONE_PORT}`, `localabstract:${socketName}`]);

  const desktop = await cdp(DESKTOP_PORT, (t) => t.type === 'page' && String(t.url).startsWith('file://'));
  const phone = await cdp(PHONE_PORT, (t) => t.type === 'page');

  // 桌面端：确保停在 ACP 任务（按任务标题点开）
  const taskTitleFragment = process.env.MYBUDDY_SYNC_TASK_TITLE || '只回复一句';
  await desktop.evaluate(`(() => {
    const row = [...document.querySelectorAll('.task-item')].find(n => (n.textContent || '').includes(${JSON.stringify(taskTitleFragment)}));
    row?.click();
    return !!row;
  })()`);
  await wait(2500);

  // 手机端：确保当前任务选中了 ACP Agent（否则会走内置 Pi，测不到 ACP 链路）
  const phoneState = await phone.evaluate(`(() => ({
    screen: document.querySelector('.remote-screen')?.getAttribute('data-screen') ?? '',
    acpActive: !!document.querySelector('.composer-acp-pill.acp-active'),
    pill: !!document.querySelector('.composer-acp-pill'),
    body: document.body.innerText.slice(0, 160),
  }))()`);
  console.log(JSON.stringify({ stage: 'phone-state', phoneState }, null, 2));
  assert(phoneState.screen.startsWith('chat:'), '手机端不在任务页（请先在手机上打开该 ACP 任务）');
  assert(phoneState.pill, '手机端没有 ACP 胶囊：电脑端 ACP 目录为空或包版本过旧');
  if (!phoneState.acpActive) {
    await phone.evaluate(`(() => { document.querySelector('.composer-acp-pill').click(); return true; })()`);
    await wait(800);
    const picked = await phone.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.claude-sheet.open .select-model-item')];
      const row = rows.find(r => r.querySelector('.select-model-name')?.textContent.trim() === ${JSON.stringify(process.env.MYBUDDY_ACP_TEST_AGENT || 'OpenCode')});
      row?.click();
      return row ? row.querySelector('.select-model-name').textContent.trim() : null;
    })()`);
    assert(picked, '手机端没能选中 ACP Agent');
    await wait(600);
  }

  const deskSnapshot = `(() => {
    const text = document.querySelector('.chat-scroll, [class*="chat-"]')?.innerText ?? document.body.innerText;
    return {
      body: text.replace(/\\s+/g, ' '),
      messages: [...document.querySelectorAll('[data-message-id]')].map(n => (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 120)),
      streaming: !!document.querySelector('[class*="streaming"], [class*="typing"]'),
    };
  })()`;

  const before = await desktop.evaluate(deskSnapshot);
  assert(!before.body.includes(message.slice(0, 12)), '测试消息不应已存在于桌面端（请用新的测试文案）');
  console.log(JSON.stringify({ stage: 'before', messages: before.messages.length }, null, 2));

  // 2) 手机发送
  await phone.evaluate(`(() => {
    const el = document.querySelector('.composer-input-area');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(message)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(500);
  await phone.evaluate(`(() => { document.querySelector('.composer-main-btn').click(); return true; })()`);
  console.log(JSON.stringify({ stage: 'phone-sent' }, null, 2));

  // 3) 桌面端：不等刷新，观察实时出现（同一 token 出现 2 次 = 用户气泡 + 回复）
  const token = (message.match(/#([a-z0-9]+)/) || [])[1] || '';
  const countToken = (text) => token ? text.split(token).length - 1 : 0;
  const deadline = Date.now() + 120_000;
  let sawUser = false;
  let sawReply = false;
  let last = before;
  while (Date.now() < deadline) {
    last = await desktop.evaluate(deskSnapshot);
    if (countToken(last.body) >= 1) sawUser = true;
    if (sawUser && countToken(last.body) >= 2) { sawReply = true; break; }
    await wait(1500);
  }
  console.log(JSON.stringify({ stage: 'after', token, occurrences: countToken(last.body), sawUser, sawReply, tail: last.body.slice(-400) }, null, 2));

  assert(sawUser, '桌面端没有实时出现手机发起的用户消息（ACP 事件补历史失效）');
  assert(sawReply, '桌面端没有实时出现手机这一轮的回复');
  assert(last.body.includes('OpenCode'), '桌面端的这一轮没有标注 OpenCode（可能被路由到内置 Pi）');

  desktop.close();
  phone.close();
  console.log('phone→desktop ACP live sync: all assertions passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
