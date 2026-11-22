const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { run } = require(path.resolve("scripts/desktop-dev-harness.cjs"));
const { routingControls } = require(path.resolve("scripts/answer-routing-desktop-controls.cjs"));

const dots = process.argv.includes("--dots");
const edge = process.argv.includes("--edge");
const url = "https://www.iana.org/help/example-domains";
const quote = "They are not available for registration or transfer.";
const sources = `[IANA Example Domains](${url})\n> ${quote}`;
const filenames = ["app-version.ts", "user-prompt-display.ts", "remote-access.ts"];
const rows = filenames.map(name => [name, fs.statSync(path.join("src/shared", name)).size]);
const ordered = [...rows].sort((a, b) => a[1] - b[1]);
const data = rows.map(([name, bytes]) => `${name},${bytes}`).join("\n");
const reportRequest = `请直接整理这份实际文件大小数据（单位统一用 B）：\n${data}\n先给结论，再分别用一张可排序数据表和一张柱状图对比三个文件。只使用上述数据。`;
const sourceRequest = `另说明示例域名能否注册或转让，并在该结论旁挂一条可点开的行内引用。使用这一条带链接摘录，引用时保留英文原句：\n${sources}`;

const legacy = "旧消息正文\n\n| 旧字段 | 旧值 |\n| --- | --- |\n| 普通 Markdown | 可读 |\n\n"
  + Array.from({ length: 25 }, (_, index) => `第 ${index + 1} 段旧消息。用于在新回复到达时保留阅读位置。`).join("\n\n");
const headings = Array.from({ length: 8 }, (_, index) => ({ label: `对比字段 ${index + 1}（完整列）`, type: "text" }));
const edgeTable = JSON.stringify({ title: "宽表", columns: headings, rows: [
  headings.map((_, i) => `甲行字段 ${i + 1}`), headings.map((_, i) => `乙行字段 ${i + 1}`),
] });
const edgeChart = JSON.stringify({ title: "原始趋势", type: "line", unit: "件", points: [
  { label: "第一天", value: 8 }, { label: "第二天", value: null }, { label: "第三天", value: 17 },
] });
const fixtureModel = request => {
  const user = JSON.stringify(request.messages.findLast(m => m.role === "user")?.content);
  if (!user?.includes("流式场景")) return legacy;
  return ["新正文已开始。\n\n", ...Array.from({ length: 10 }, (_, index) => `新正文第 ${index + 1} 段。\n\n`),
    '```mybuddy-table\n{"invalidProbe":', "true}\n```\n\n", `\`\`\`mybuddy-table\n${edgeTable}\n\`\`\`\n\n`,
    `\`\`\`mybuddy-chart\n${edgeChart}\n\`\`\`\n\n`, "新正文结束。"];
};

run(async env => {
  const { evaluate, until, rpc, home, report, restart } = env;
  const { press, click, screenshot, openTopBarMenu } = routingControls(env);
  const select = css => `document.querySelector(${JSON.stringify(css)})`;
  const api = (method, ...args) => evaluate(`window.api.${method}(${args.map(value => JSON.stringify(value)).join(",")})`);
  const store = expression => evaluate(`import('/src/store/appStore.ts').then(m => { const s = m.useAppStore.getState(); return ${expression}; })`);
  const task = "desktop-chat-reply";
  const dotsId = "mybuddy-dots";
  const ordinaryTitle = "结构化输出普通任务";
  const openTask = async () => {
    const title = await store(`s.tasks.find(t => t.id === ${JSON.stringify(task)})?.title`) ?? ordinaryTitle;
    await openTopBarMenu("desktop-module-list");
    await press(`[...document.querySelectorAll('.task-item-title')].find(el => el.textContent === ${JSON.stringify(title)})`, "打开普通任务");
  };
  const openDots = async () => { await openTopBarMenu("desktop-module-list"); await click("MyBuddy Dots", ".sidebar-scroll"); };
  const history = async id => (await api("agent.loadTaskHistory", id)).messages;
  const send = async text => {
    await press(select("textarea.input-textarea"), "聊天输入");
    await rpc("Input.insertText", { text });
    await press(select('button[title="发送 (Enter)"]'), "发送任务");
  };
  const settled = async (id, count) => {
    await until(async () => {
      const messages = await history(id);
      return messages.filter(m => m.role === "user").length === count && messages.at(-1)?.role === "assistant" && messages.at(-1)?.text;
    }, "回复持久化");
    await until(() => store(`s.tasks.find(t => t.id === ${JSON.stringify(id)})?.durable?.busy === false`), "任务结束");
  };
  const verify = async (scope, sourceLabel) => {
    const selector = css => select(`${scope} ${css}`);
    const read = css => evaluate(`${selector(css)}?.textContent`);
    await until(() => evaluate(`Boolean(${selector(".chat-reply-table")} && ${selector(".chat-reply-chart")} && ${selector(".chat-reply-citation-chip")})`), "三种回复内容可见");
    assert.match(await read(".chat-reply-table thead"), /\(B\)/);
    const heading = `[...document.querySelectorAll(${JSON.stringify(scope + " .chat-reply-table thead th button")})].find(el => el.textContent.includes('(B)'))`;
    const numbers = () => evaluate(`[...document.querySelectorAll(${JSON.stringify(scope + " .chat-reply-table tbody tr")})].map(row => Number(row.cells[(${heading}).closest('th').cellIndex].textContent.replaceAll(',', '')))`);
    await press(heading, "表头数值升序");
    assert.deepEqual(await numbers(), ordered.map(row => row[1]));
    await press(heading, "表头数值降序");
    assert.deepEqual(await numbers(), [...ordered].reverse().map(row => row[1]));
    assert.match(await read(".chat-reply-chart figcaption"), /\(B\)/);
    assert.equal(await evaluate(`${selector(".chat-reply-chart svg")}.getAttribute('aria-label')`), "柱状图");
    const point = selector(`.chat-reply-point[aria-label*="${ordered[0][0]}"]`);
    await evaluate(`${point}.focus()`);
    assert.match(await read(".chat-reply-point-value"), new RegExp(`${ordered[0][1]} B`));
    await press(selector(".chat-reply-citation-chip"), "展开行内引用");
    const popup = await read(".chat-reply-citation-popup:popover-open");
    assert.match(popup, new RegExp(sourceLabel));
    assert.ok(popup.includes(quote), popup);
    assert.equal(await evaluate(`${selector(".chat-reply-citation-popup:popover-open a")}.href`), url);
    await screenshot(dots ? `dots-${sourceLabel}` : "ordinary-reply");
    await press(selector(".chat-reply-citation-popup:popover-open a"), "打开引用出处");
    await until(() => store(`s.browserUrlInput === ${JSON.stringify(url)}`), "浏览器导航到引用网址");
    assert.ok(!(await read(".assistant-card")).includes("mybuddy-table"));
    report.actualControlChecks.push(`${scope} 数值双向排序、图表单位和数据点、${sourceLabel}、引用导航正确`);
  };

  await api("db.upsertTask", { id: task, title: ordinaryTitle, welcomeMode: "general", updatedAt: Date.now() });
  if (dots) {
    const workspace = path.join(home, "文件尺寸样本");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "文件大小.csv"), "文件,字节\n" + data + "\n");
    await api("db.upsertSpace", { id: "reply-sample", name: "文件尺寸样本", path: workspace });
  }
  await rpc("Page.reload");
  await until(() => evaluate("Boolean(document.querySelector('.sidebar-scroll'))"), "侧栏加载");
  if (dots) await openDots(); else await openTask();
  const id = dots ? dotsId : task;
  if (edge) {
    await send("旧消息场景，请保留普通 Markdown。");
    await settled(id, 1);
    await restart();
    await openTask();
    await until(() => evaluate("document.querySelector('.assistant-card .md table')?.textContent.includes('普通 Markdown')"), "旧消息重开可读");
    await rpc("Emulation.setDeviceMetricsOverride", { width: 660, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.invalidReplyVisible = false; new MutationObserver(() => {
      if (document.querySelector('.message-list')?.innerText.includes('invalidProbe')) window.invalidReplyVisible = true;
    }).observe(document.querySelector('.message-list'), { subtree: true, childList: true, characterData: true });`);
    await send("流式场景，请生成后续回复。");
    await until(() => evaluate("document.querySelector('.message-list')?.innerText.includes('新正文已开始')"), "前半段正文已流出");
    assert.equal(await store(`s.tasks.find(t => t.id === ${JSON.stringify(id)})?.durable?.busy`), true);
    const point = await evaluate(`(() => { const r = document.querySelector('.message-scroll').getBoundingClientRect(); return {x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2}; })()`);
    await rpc("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -3000 });
    await until(() => evaluate("document.querySelector('.message-scroll').scrollTop < 2"), "滚轮返回旧消息");
    const anchor = await evaluate("document.querySelector('.assistant-card').getBoundingClientRect().top");
    await settled(id, 2);
    await until(() => evaluate("Boolean(document.querySelector('.chat-reply-chart') && document.querySelector('.chat-reply-table'))"), "后半段图表已渲染");
    assert.equal(await evaluate("window.invalidReplyVisible"), false);
    assert.ok(await evaluate("document.querySelector('.message-list').innerText.includes('新正文结束。')"));
    assert.ok(Math.abs(await evaluate("document.querySelector('.assistant-card').getBoundingClientRect().top") - anchor) < 2);
    const narrow = await evaluate(`(() => {
      const el = document.querySelector('.chat-reply-table');
      const last = el.querySelector('tbody tr:last-child td:last-child');
      el.scrollLeft = el.scrollWidth;
      return [el.scrollWidth > el.clientWidth, last.textContent, last.getBoundingClientRect().right <= el.getBoundingClientRect().right + 1];
    })()`);
    assert.deepEqual(narrow, [true, "乙行字段 8", true]);
    assert.equal(await evaluate("document.querySelector('.chat-reply-point[aria-label=\"第二天 · 缺失\"]').getAttribute('aria-label')"), "第二天 · 缺失");
    report.actualControlChecks.push("旧 Markdown 消息重开，流式期间无效载荷不显示，滚轮回读位置保持，窄窗可滚至第八列，折线缺失值保留");
    return;
  }
  await send(`${reportRequest}\n\n${sourceRequest}`);
  await settled(id, 1);
  const direct = (await history(id)).findLast(m => m.role === "assistant" && m.text);
  const directScope = `#msg-${direct.id}`;
  await verify(directScope, "用户提供的摘录");
  let delivery;
  if (dots) {
    await send(`请把下列任务委派给「文件尺寸样本」空间里的一个普通任务。请完整转交任务要求，完成后在本对话回传正文。\n任务：读取文件大小.csv。${reportRequest}\n两者都内嵌在聊天最终回复正文，禁止生成 HTML、写文件或用文件预览。再读取 ${url} 原文，说明示例域名能否注册或转让，在结论旁加 MyBuddy 行内引用。请核对并使用原文摘录「${quote}」。`);
    await until(async () => {
      delivery = (await history(dotsId)).findLast(m => m.dotsDelivery?.kind === "conclusion");
      return Boolean(delivery);
    }, "委派结果正式追加到 Dots 对话");
    await verify(`#msg-${delivery.id}`, "已读原文");
    assert.ok(delivery.dotsDelivery.citations.some(c => c.kind === "page" && c.url === url && c.excerpt.includes(quote)));
  }
  await restart();
  await until(() => evaluate("Boolean(document.querySelector('.sidebar-scroll'))"), "重开后侧栏加载");
  if (dots) await openDots(); else await openTask();
  for (const message of [direct, ...(delivery ? [delivery] : [])]) {
    await until(() => evaluate(`document.querySelectorAll(${JSON.stringify(`#msg-${message.id} :is(.chat-reply-table,.chat-reply-chart,.chat-reply-citation-chip)`)}).length === 3`), "重开后三种内容仍可读");
  }
  report.actualControlChecks.push(delivery ? "直接回复和独立正式回流重开后仍可读" : "重开对话后三种内容仍可读");
  if (!dots) {
    await send("只用纯文本回复‘收到’，其余不用输出。");
    await settled(task, 2);
    const plain = (await history(task)).findLast(m => m.role === "assistant" && m.text);
    assert.match(plain.text, /收到/);
    assert.equal(await evaluate(`document.querySelectorAll('#msg-${plain.id} .chat-reply-surface').length`), 0);
    assert.match(await evaluate(`document.querySelector('#msg-${plain.id} .assistant-card').textContent`), /收到/);
  }
}, { name: edge ? "chat-reply-edge-desktop" : dots ? "chat-reply-dots-live" : "chat-reply-ordinary-live", liveModel: !edge,
  fixtureModel: edge ? fixtureModel : undefined,
  isolatedDependencyCache: true, watchRenderer: false,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } }, rpcTimeoutMs: 100_000 });
