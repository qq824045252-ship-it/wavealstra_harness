const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { setTimeout: delay } = require("node:timers/promises");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

const cases = [
  { task: "汇总客户报价", space: "客户交付", command: "安排报价汇总", input: "独立报价汇总" },
  { task: "确认合同口径", space: "客户交付", command: "安排合同确认", input: "独立合同确认" },
  { task: "核对库存数据", space: "运营工作", command: "安排库存核对", input: "独立库存核对" },
];
const deliveryText = "报价已经核对，含税总额为 137 元。";
const questionText = "这次合同按含税口径审阅吗？";
const inventoryEnd = "库存核对记录到此结束。";
const inventoryDelivery = ["已核对库存，共 47 件。", ...Array.from({ length: 40 }, (_, i) =>
  `核对记录 ${i + 1}。已比对台账记录与本次盘点明细。`), inventoryEnd].join("\n\n");
let releaseInventory;
const inventory = new Promise(resolve => { releaseInventory = resolve; });

run(async env => {
  const { evaluate, until, rpc, report } = env;
  const { click, press, screenshot } = routingControls(env);
  const api = (name, ...args) => evaluate(`window.api.${name}(${args.map(arg => JSON.stringify(arg)).join(",")})`);
  const openDots = () => click("MyBuddy Dots", ".sidebar-dots-entry");
  const toggleTasks = () => press("document.querySelector('.chat-header .dots-activity-entry')", "all tasks in Dots header");
  const row = (state, title) => `[...document.querySelectorAll('.dots-all-tasks:popover-open li[data-state="${state}"]')].find(li => li.querySelector('strong')?.textContent === ${JSON.stringify(title)})`;
  const listCount = () => evaluate("document.querySelectorAll('.dots-all-tasks:popover-open li').length");
  const waitingIndicator = '.sidebar-dots-row [aria-label="Dots 正在等待委托结果"]';
  const showsWaitingAnimation = () => evaluate(`document.querySelector(${JSON.stringify(waitingIndicator + ' [data-icon=clock]')})
    ?.getAnimations().some(animation => animation.playState === 'running') === true`);
  const send = async text => {
    await press("document.querySelector('textarea.input-textarea')", "Dots composer");
    await rpc("Input.insertText", { text });
    await press("document.querySelector('button[title=\"发送 (Enter)\"]')", text);
  };
  const waitFor = (title, state) => until(async () => (await api("dots.activity")).some(item => item.title === title && item.state === state), `${title} ${state}`);
  const latestIsVisible = () => evaluate(`(() => {
    const scroll = document.querySelector('.message-scroll');
    const end = [...document.querySelectorAll('.message-list p')].find(node => node.textContent === ${JSON.stringify(inventoryEnd)});
    if (!scroll || !end) return false;
    const viewport = scroll.getBoundingClientRect();
    const last = end.getBoundingClientRect();
    return last.top >= viewport.top && last.bottom <= viewport.bottom
      && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2;
  })()`);

  const pendingIndicators = [
    { label: "Dots 正在接收请求", mark: ".task-status-mark > i", count: 3, messages: [], botPendingSubmissions: [{ submitting: true }] },
    { label: "等待你回答", mark: '[data-icon=messages]', count: 1, messages: [{ blocks: [], interactions: [{ status: "pending" }] }] },
    { label: "等待你确认操作", mark: '[data-icon=permission]', count: 1, messages: [{ blocks: [{ type: "tool", toolCall: { status: "pending_approval" } }] }] },
  ];
  for (const { label, mark, count, messages, botPendingSubmissions } of pendingIndicators) {
    await evaluate(`(async () => {
      const { useAppStore } = await import('/src/store/appStore.ts');
      useAppStore.setState(state => ({
        tasks: [...state.tasks.filter(task => task.id !== 'mybuddy-dots'), {
          id: 'mybuddy-dots', title: 'Dots', status: 'pending', updatedAt: Date.now(),
          messages: ${JSON.stringify(messages)}, botPendingSubmissions: ${JSON.stringify(botPendingSubmissions)},
        }],
      }));
    })()`);
    await until(() => evaluate(`document.querySelector('.sidebar-dots-row [role="img"]')?.ariaLabel === ${JSON.stringify(label)}`), label);
    assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(".sidebar-dots-row " + mark)}).length`), count, label);
  }
  await evaluate(`(async () => {
    const { useAppStore } = await import('/src/store/appStore.ts');
    useAppStore.setState(state => ({ tasks: state.tasks.filter(task => task.id !== 'mybuddy-dots') }));
  })()`);
  report.seededPresentationFacts.push("Receiving a request, waiting for an answer and waiting for approval use three distinct sidebar symbols.");

  for (const space of new Set(cases.map(item => item.space))) {
    const path = join(env.home, space);
    mkdirSync(path);
    if (space === "运营工作") writeFileSync(join(path, "台账.txt"), "库存 47 件\n");
    await api("db.upsertSpace", { id: spaceId(space), name: space, path });
  }
  const fallback = (await api("answerRouting.list")).find(rule => rule.id === "dots-default-policy");
  await api("answerRouting.save", { ...fallback, policy: { ...fallback.policy,
    trackingPolicy: { milestones: true, heartbeatMs: 5_000, silenceMs: 5_000 },
  } }, fallback);
  await openDots();
  await toggleTasks();
  await until(() => evaluate("document.querySelector('.dots-all-tasks:popover-open p')?.textContent === '暂无委派任务'"), "empty all-tasks list");
  assert.deepEqual(await evaluate(`(() => {
    const buttons = document.querySelectorAll('.sidebar-dots-entry button');
    const name = buttons[0].querySelector('.desktop-section-label');
    return [buttons.length, name.innerText.trim(), name.scrollWidth <= name.clientWidth];
  })()`), [1, "MyBuddy Dots", true]);
  await rpc("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await rpc("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(() => evaluate("!document.querySelector('.dots-all-tasks:popover-open')"), "Escape dismissed all tasks");

  await send(cases[0].command);
  await waitFor(cases[0].task, "delivered");
  await toggleTasks();
  await until(() => evaluate(`Boolean(${row("delivered", cases[0].task)})`), "ordinary conclusion listed as delivered");
  assert.equal(await evaluate("document.querySelector('.chat-header .dots-activity-entry').getAttribute('aria-label')"), "所有任务");
  await toggleTasks();
  await send(cases[1].command);
  await waitFor(cases[1].task, "waiting");
  await send(cases[2].command);
  await waitFor(cases[2].task, "running");
  await until(showsWaitingAnimation, "Dots animates while its delegated worker is still running");
  await toggleTasks();
  await until(async () => await listCount() === 3, "all three live tasks in the popup");
  assert.equal(await evaluate("document.querySelector('.chat-header .dots-activity-badge')?.textContent"), "1", "only the unanswered question counts");
  const placement = await evaluate(`(() => {
    const origin = document.querySelector('.chat-header .dots-activity-entry').getBoundingClientRect();
    const panel = document.querySelector('.dots-all-tasks:popover-open').getBoundingClientRect();
    return panel.left >= 0 && panel.right <= window.innerWidth && panel.top >= origin.bottom &&
      Math.abs(origin.right - panel.right) < 30 && document.querySelector('.message-list').checkVisibility();
  })()`);
  assert.equal(placement, true, "all tasks opens under the header button and preserves the visible conversation");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.dots-all-tasks:popover-open .dots-all-tasks-state')].map(el => el.textContent)"), ["等待你回复", "执行中", "已交付"]);
  assert.match(await evaluate(`${row("waiting", cases[1].task)}.innerText`), new RegExp(questionText.replace("？", "[？]")));
  assert.match(await evaluate(`${row("delivered", cases[0].task)}.innerText`), /客户交付[\s\S]*137 元/);
  assert.match(await evaluate(`${row("running", cases[2].task)}.innerText`), /运营工作/);
  await screenshot("dots-all-tasks-live");

  await press(`${row("delivered", cases[0].task)}?.querySelector('button')`, "open the original delivery");
  await until(() => evaluate(`document.activeElement?.closest('.message-list') && document.activeElement.innerText.includes(${JSON.stringify(deliveryText)})`), "focus exact delivered reply");
  await until(() => evaluate("Boolean(document.querySelector('.dots-progress-history summary'))"), "heartbeat folded in chat");
  assert.doesNotMatch(await evaluate("document.querySelector('.message-list').innerText"), /最近观察到工具/);
  await press("document.querySelector('.dots-progress-history summary')", "expand progress history");
  await until(() => evaluate("document.querySelector('.dots-progress-history').innerText.includes('最近观察到工具')"), "durable progress still readable");

  await toggleTasks();
  await press(`${row("waiting", cases[1].task)}?.querySelector('button')`, "open native question from all tasks");
  await until(() => evaluate(`!![...document.querySelectorAll('[data-interaction-id]')].find(card => card.textContent.includes(${JSON.stringify(questionText)}) && card.checkVisibility())`), "exact native question in worker chat");
  assert.equal(await showsWaitingAnimation(), true, "the waiting animation remains when viewing a worker chat");
  await press("[...document.querySelectorAll('[data-interaction-id] button')].find(button => button.textContent.trim() === '确认')", "answer native question");
  await waitFor(cases[1].task, "delivered");
  releaseInventory();
  await waitFor(cases[2].task, "delivered");
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(waitingIndicator)})`), "the waiting animation clears after the last delivery");
  await openDots();
  await until(latestIsVisible, "sidebar Dots click shows the end of the latest long reply from another task");
  const point = await evaluate(`(() => {
    const rect = document.querySelector('.message-scroll').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const scrollToOlderMessages = async () => {
    await rpc("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -6000 });
    await until(() => evaluate("document.querySelector('.message-scroll')?.scrollTop === 0 && !!document.querySelector('.jump-to-bottom')"),
      "reading older Dots messages shows the return button");
    assert.equal(await latestIsVisible(), false);
  };
  await scrollToOlderMessages();
  await press("document.querySelector('.jump-to-bottom')", "回到底部 in Dots");
  await until(latestIsVisible, "the chat button reveals the last paragraph of the newest reply");
  await scrollToOlderMessages();
  await openDots();
  await until(latestIsVisible, "reclicking Dots returns to the newest reply");

  const previousDelivery = (await api("dots.activity")).find(item => item.title === cases[0].task);
  const extra = Array.from({ length: 18 }, (_, index) => ({ id: `dots-list-fixture-${index}`, title: `历史委派 ${index + 1}` }));
  await Promise.all(extra.map(task => api("db.upsertTask", { ...task, spaceId: spaceId("客户交付"), updatedAt: Date.now() })));
  await env.restart(() => {
    const db = new DatabaseSync(join(env.home, ".mybuddy", "app.db"));
    try {
      db.exec("CREATE TABLE IF NOT EXISTS dots_activity_reviews(delivery_key TEXT PRIMARY KEY)");
      db.prepare("INSERT OR IGNORE INTO dots_activity_reviews VALUES (?)").run(previousDelivery.deliveryKey);
      const add = db.prepare(`INSERT INTO dots_delegations(operation_id,task_id,source_message_id,title,status,text,created_at,updated_at)
        VALUES(?,?,'fixture-all-tasks',?,?,?,?,?)`);
      const control = db.prepare("INSERT INTO dots_target_controls VALUES (?,?,?)");
      add.run("previous-fixture-input", extra[0].id, extra[0].title, "completed", "同一原任务的前一次委派", 1, 1);
      extra.forEach((task, index) => {
        const at = Date.now() - 100_000 - index;
        add.run(`${task.id}-input`, task.id, task.title, index === 2 ? "failed" : "completed", "用于验证任务展开与状态展示", at, at);
      });
      control.run(extra[0].id, "paused", "fixture-pause");
      control.run(extra[1].id, "stopped", "fixture-stop");
    } finally {
      db.close();
    }
  });
  await openDots();
  await until(latestIsVisible, "opening Dots after restart waits for history and shows the latest reply");
  await toggleTasks();
  await until(async () => await listCount() === 8, "default eight tasks");
  assert.equal(await evaluate("document.querySelector('.dots-all-tasks:popover-open header span')?.textContent"), "21 项");
  assert.match(await evaluate(`${row("paused", extra[0].title)}.innerText`), /已暂停/);
  assert.match(await evaluate(`${row("stopped", extra[1].title)}.innerText`), /已停止/);
  assert.match(await evaluate(`${row("failed", extra[2].title)}.innerText`), /执行失败/);
  assert.match(await evaluate(`${row("delivered", cases[0].task)}.innerText`), /已交付/);
  await click("查看更多（20 项）", ".dots-all-tasks");
  await until(async () => await listCount() === 20, "twenty tasks after show more");
  await click("展开全部（21 项）", ".dots-all-tasks");
  await until(async () => await listCount() === 21, "all twenty-one tasks without duplicate work");
  assert.equal(await evaluate(`(() => {
    const list = document.querySelector('.dots-all-tasks:popover-open ul');
    list.scrollTop = list.scrollHeight;
    return list.scrollTop > 0 && list.lastElementChild.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1;
  })()`), true);
  await screenshot("dots-all-tasks-expanded");
  await click("收起", ".dots-all-tasks");
  await until(async () => await listCount() === 8, "collapse returns to eight tasks");
  await toggleTasks();
  await toggleTasks();
  await until(async () => await listCount() === 8, "reopening defaults to eight tasks");
  report.actualControlChecks.push("Every distinct Dots task is available in one popup. Live navigation, delivered and paused/stopped/failed statuses, restored previously hidden delivery, and progressive 8/20/all counts passed.");
  report.actualControlChecks.push("Both MyBuddy Dots and the chat return button revealed the last paragraph after user scrolling. The sidebar also did so from another task and after restarting. Activity links kept their exact message targets.");
}, {
  name: "dots-activity-desktop", watchRenderer: false, isolatedDependencyCache: true, settings: { permissionMode: "auto" },
  async fixtureModel(request) {
    const names = request.tools?.map(tool => tool.function.name) ?? [];
    const last = request.messages.at(-1);
    const user = JSON.stringify(request.messages.findLast(message => message.role === "user")?.content ?? "");
    if (names.includes("dots_action")) {
      const item = cases.find(entry => user.includes(entry.command));
      if (!item) return "[]";
      if (last.role === "tool") return "已安排。";
      return { tool: { name: "dots_action", arguments: { action: "delegate", spaceId: spaceId(item.space), name: item.task, text: item.input } } };
    }
    if (user.includes(cases[0].input)) return JSON.stringify({ dotsState: "complete", result: deliveryText });
    if (user.includes(cases[1].input)) {
      if (last.role === "tool") return JSON.stringify({ dotsState: "complete", result: "已按含税口径核对合同。" });
      return { tool: { name: "request_user_input", arguments: { kind: "confirm", title: questionText } } };
    }
    if (user.includes(cases[2].input)) {
      if (last.role !== "tool") return { tool: { name: "read", arguments: { path: "台账.txt" } } };
      await Promise.race([inventory, delay(45_000, undefined, { ref: false })]);
      return JSON.stringify({ dotsState: "complete", result: inventoryDelivery });
    }
    return "[]";
  },
});

function spaceId(space) {
  return space === "客户交付" ? "sp-activity-delivery" : "sp-activity-ops";
}
