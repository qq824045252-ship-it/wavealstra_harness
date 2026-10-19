/**
 * 真机（安卓）ACP 端到端验收：在手机上真实发起一轮 ACP 委托，观察流式输出与完成态。
 *
 * 前置：手机已配对到电脑端 0.1.37+，电脑端 ACP 目录里至少有一个可用 Agent（本脚本默认 OpenCode）。
 * 断言：
 *  1. 首页可选模式/Tag，发送按钮可用
 *  2. 选 ACP Agent 后发送 → 出现「<Agent> · ACP」气泡（证明委托进入电脑端真实 ACP 进程）
 *  3. 运行中能观察到状态（执行中/等待授权）；如出现权限卡片会自动拒绝，避免测试改动文件
 *  4. 最终气泡结束且带上 ACP Agent 名称
 *
 * 运行：MYBUDDY_ACP_TEST_AGENT=OpenCode pnpm -s test:acp-remote-android-e2e:live
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');

const adb = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const port = Number(process.env.MYBUDDY_ANDROID_CDP_PORT || 9335);
const agentName = process.env.MYBUDDY_ACP_TEST_AGENT || 'OpenCode';
const prompt = process.env.MYBUDDY_ACP_TEST_PROMPT || '只回复一句：手机端 ACP 连通测试通过。不要调用任何工具，不要读写文件。';
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
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(expression, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await wait(800);
  }
  throw Error('timeout waiting for ' + label);
}

const OPEN_SHEET_CHOICES = `[...document.querySelectorAll('.task-setup-options .setup-choice')]`;
const SNAP = `(() => {
  const chips = [...document.querySelectorAll('.task-setup-chip')].map(c => ({ label: c.getAttribute('aria-label'), text: c.textContent.trim(), chosen: c.className.includes('chosen') }));
  const cards = [...document.querySelectorAll('.acp-run-chip')].map(c => ({ text: c.textContent.trim(), running: c.className.includes('running') }));
  const bubbles = [...document.querySelectorAll('.message-bubble-assistant')].map(b => ({
    acp: b.querySelector('.acp-run-chip')?.textContent.trim() ?? null,
    text: b.querySelector('.markdown-body, .remote-markdown, p')?.textContent.trim().slice(0, 200) ?? '',
    streaming: !!b.querySelector('.response-streaming-caret'),
  }));
  return {
    screen: document.querySelector('.remote-screen')?.getAttribute('data-screen') ?? '',
    chips, cards, bubbles,
    approvals: [...document.querySelectorAll('.approval-card')].map(c => ({
      head: c.querySelector('.approval-card-head')?.textContent.trim() ?? '',
      actions: [...c.querySelectorAll('.approval-card-actions button')].map(b => b.textContent.trim()),
    })),
    sendDisabled: document.querySelector('.composer-main-btn')?.disabled ?? null,
    composerText: document.querySelector('.composer-input-area')?.value ?? '',
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
  await wait(1200);

  // 从聊天页回到首页（若有返回按钮），保证在新任务上做干净验收
  await evaluate(`(() => { document.querySelector('.back-btn, button[aria-label="返回"], .header-back-btn')?.click(); return true; })()`);
  await wait(800);
  // 关掉上一轮可能残留的面板（模式/Tag/模型/ACP），避免遮挡点击
  await evaluate(`(() => {
    document.querySelector('.task-setup-sheet.open .setup-icon-button[aria-label="关闭任务设置"]')?.click();
    document.querySelector('.claude-sheet.open .claude-sheet-close-btn')?.click();
    return true;
  })()`);
  await wait(600);
  let snap = await evaluate(SNAP);
  if (snap.screen !== 'home') {
    throw Error('当前不在首页（screen=' + snap.screen + '），请先在手机上返回首页再运行');
  }

  // 1) 选模式 → Tag（选择模式会自动进入 Tag 分区）
  await evaluate(`(() => { document.querySelector('.task-setup-chip[aria-label="新任务模式"]').click(); return true; })()`);
  await wait(600);
  const modePicked = await evaluate(`(() => { const b = ${OPEN_SHEET_CHOICES}.filter(x => (x.getAttribute('aria-label')||'').startsWith('模式：'))[0]; if (!b) return false; b.click(); return b.textContent.trim(); })()`);
  assert(modePicked, '没有可选模式');
  await wait(700);
  // Tag 用 .setup-tag 网格渲染；优先「最小模式」（不追加任何场景提示词，最适合连通性验收）
  const tagPicked = await evaluate(`(() => {
    const tags = [...document.querySelectorAll('.task-setup-sheet.open .setup-tag')];
    const preferred = tags.find(t => (t.getAttribute('aria-label') || '') === 'Tag：最小模式') ?? tags[0];
    if (!preferred) return false;
    const label = preferred.getAttribute('aria-label');
    preferred.click();
    return label;
  })()`);
  assert(tagPicked, '没有可选 Tag');
  await wait(500);

  // 2) 选 ACP Agent
  await evaluate(`(() => { document.querySelector('.composer-acp-pill').click(); return true; })()`);
  await wait(700);
  const picked = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.claude-sheet.open .select-model-item')];
    const row = rows.find(r => r.querySelector('.select-model-name')?.textContent.trim() === ${JSON.stringify(agentName)});
    if (!row) return null;
    row.click();
    return row.querySelector('.select-model-name').textContent.trim();
  })()`);
  assert.equal(picked, agentName, '没有找到 ACP Agent：' + agentName);
  await wait(500);
  const active = await evaluate(`(() => document.querySelector('.composer-acp-pill')?.classList.contains('acp-active') ?? false)()`);
  assert(active, '选择后 ACP 胶囊没有高亮');
  console.log(JSON.stringify({ stage: 'agent-selected', agent: picked }, null, 2));

  // 3) 输入并发送
  await evaluate(`(() => {
    const el = document.querySelector('.composer-input-area');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(prompt)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(500);
  const beforeSend = await evaluate(SNAP);
  assert.equal(beforeSend.sendDisabled, false, '发送按钮不可用（模式/Tag 未选全）');
  await evaluate(`(() => { document.querySelector('.composer-main-btn').click(); return true; })()`);
  console.log(JSON.stringify({ stage: 'sent' }, null, 2));

  // 4) 等 ACP 气泡出现；过程中处理权限卡片（一律拒绝，避免测试改动工作目录）
  let sawRunning = false;
  let denied = false;
  const deadline = Date.now() + 120_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(SNAP);
    if (last.cards.some((card) => card.running)) sawRunning = true;
    if (last.approvals.length && !denied) {
      const clicked = await evaluate(`(() => {
        const card = document.querySelector('.approval-card');
        const buttons = [...card.querySelectorAll('.approval-card-actions button')];
        const reject = buttons.find(b => b.textContent.trim() === '拒绝') ?? buttons[0];
        reject?.click();
        return reject?.textContent.trim() ?? null;
      })()`);
      denied = true;
      console.log(JSON.stringify({ stage: 'approval-handled', clicked }, null, 2));
      await wait(800);
      continue;
    }
    const done = last.cards.length > 0 && !last.cards.some((card) => card.running) && !last.bubbles.some((b) => b.streaming);
    if (done) break;
    await wait(1200);
  }
  console.log(JSON.stringify({ stage: 'final', sawRunning, denied, snapshot: last }, null, 2));

  assert(last.cards.length > 0, '没有出现 ACP 运行标记（委托没有进入 ACP 路径）');
  assert(last.cards.some((card) => card.text.includes(agentName)), 'ACP 气泡没有标注 Agent 名称');
  assert(sawRunning || last.cards.some((card) => card.text.includes('执行中') || card.text.includes('等待授权')), '没有观察到 ACP 运行状态');
  assert(last.cards.every((card) => !card.running), 'ACP 运行没有结束');
  console.log('android ACP E2E: first turn passed');

  // 5) 上下文续接：进程每轮新起，但 session 必须延续（同一任务里问上一轮记住的数字）
  if (process.env.MYBUDDY_ACP_SKIP_CONTINUATION !== '1') {
    const assistantCount = () => evaluate(`document.querySelectorAll('.message-bubble-assistant').length`);
    const before = await assistantCount();
    const sendTurn = async (message) => {
      const count = await assistantCount();
      await evaluate(`(() => {
        const el = document.querySelector('.composer-input-area');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(message)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await wait(400);
      await evaluate(`(() => { document.querySelector('.composer-main-btn').click(); return true; })()`);
      // 等到出现新的助手气泡并结束
      const deadline2 = Date.now() + 180_000;
      while (Date.now() < deadline2) {
        const state = await evaluate(SNAP);
        if (state.approvals.length) {
          await evaluate(`(() => { const card = document.querySelector('.approval-card'); const bs=[...card.querySelectorAll('.approval-card-actions button')]; (bs.find(b=>b.textContent.trim()==='拒绝')??bs[0])?.click(); return true; })()`);
          await wait(800);
          continue;
        }
        const cards = state.cards;
        const streaming = state.bubbles.some((b) => b.streaming);
        if (await assistantCount() > count && cards.length >= before && !streaming && cards.every((c) => !c.running)) return state;
        await wait(1200);
      }
      throw Error('timeout waiting for turn: ' + message);
    };

    await sendTurn('记住一个数字：42。只回复：已记住。不要调用任何工具。');
    const second = await sendTurn('我刚才让你记住的数字是多少？只回复数字，不要调用任何工具。');
    const texts = second.bubbles.map((b) => b.text);
    console.log(JSON.stringify({ stage: 'continuation', texts }, null, 2));
    assert(texts.some((text) => /42/.test(text)), '第二轮没有拿到 42：ACP 会话上下文没有续接（每轮都开了新会话）');
    console.log('android ACP E2E: continuation passed');
  }

  console.log('android ACP E2E: all assertions passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
