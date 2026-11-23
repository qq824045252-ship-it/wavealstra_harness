const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
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
let releaseInventory;
const inventory = new Promise(resolve => { releaseInventory = resolve; });

run(async env => {
  const { evaluate, until, rpc, report } = env;
  const { click, press, screenshot } = routingControls(env);
  const api = (name, ...args) => evaluate(`window.api.${name}(${args.map(arg => JSON.stringify(arg)).join(",")})`);
  const openRecent = () => press("document.querySelector('.chat-header .dots-activity-entry')", "recent Activity in Dots header");
  const openActivity = async () => {
    await click("MyBuddy Dots", ".sidebar-dots-entry");
    await openRecent();
    await click("查看全部", ".dots-recent-activity");
  };
  const row = (state, title) => `[...document.querySelectorAll('.dots-activity-group[data-state="${state}"] li')].find(li => li.querySelector('h3')?.textContent === ${JSON.stringify(title)})`;
  const send = async text => {
    await until(() => evaluate("!document.querySelector('.dots-activity-page')"), "Dots conversation visible");
    await press("document.querySelector('textarea.input-textarea')", "Dots composer");
    await rpc("Input.insertText", { text });
    await press("document.querySelector('button[title=\"发送 (Enter)\"]')", text);
  };
  const waitFor = (title, state) => until(async () => (await api("dots.activity")).some(item => item.title === title && item.state === state), `${title} ${state}`);

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
  await openActivity();
  await until(() => evaluate("document.querySelector('.dots-activity-empty')?.textContent.includes('暂无任务动态')"), "Activity empty page");
  assert.equal(await evaluate("document.querySelector('.dots-activity-page') instanceof HTMLElement && !document.querySelector('dialog[open]')"), true);
  assert.deepEqual(await evaluate(`(() => {
    const buttons = document.querySelectorAll('.sidebar-dots-entry button');
    const name = buttons[0].querySelector('.desktop-section-label');
    return [buttons.length, name.innerText.trim(), name.scrollWidth <= name.clientWidth];
  })()`), [1, "MyBuddy Dots", true]);
  await click("返回 Dots 对话", ".dots-activity-page");
  await openRecent();
  await until(() => evaluate("document.querySelector('.dots-recent-activity:popover-open p')?.textContent === '最近无活动'"), "empty recent Activity");
  await rpc("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await rpc("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(() => evaluate("!document.querySelector('.dots-recent-activity:popover-open')"), "Escape dismissed recent Activity");

  await send(cases[0].command);
  await waitFor(cases[0].task, "delivered");
  await openRecent();
  await until(() => evaluate("document.querySelector('.dots-recent-activity:popover-open li[data-state=delivered] strong')?.textContent === '汇总客户报价'"), "ordinary conclusion listed as delivered");
  assert.equal(await evaluate("document.querySelector('.chat-header .dots-activity-entry').getAttribute('aria-label')"), "近期活动");
  await openRecent();
  await send(cases[1].command);
  await waitFor(cases[1].task, "waiting");
  await send(cases[2].command);
  await waitFor(cases[2].task, "running");
  await openRecent();
  await until(() => evaluate("document.querySelectorAll('.dots-recent-activity:popover-open li').length === 3"), "all three live statuses in recent Activity");
  assert.equal(await evaluate("document.querySelector('.chat-header .dots-activity-badge')?.textContent"), "1", "only the unanswered question counts");
  await screenshot("dots-recent-activity");
  const placement = await evaluate(`(() => {
    const origin = document.querySelector('.chat-header .dots-activity-entry').getBoundingClientRect();
    const panel = document.querySelector('.dots-recent-activity:popover-open').getBoundingClientRect();
    return panel.left >= 0 && panel.right <= window.innerWidth && panel.top >= origin.bottom &&
      Math.abs(origin.right - panel.right) < 30 && document.querySelector('.message-list').checkVisibility();
  })()`);
  assert.equal(placement, true, "recent Activity is a compact popup under the header button and preserves the visible conversation");
  await click("查看全部", ".dots-recent-activity");
  await until(() => evaluate(`Boolean(${row("running", cases[2].task)})`), "all Activity groups visible");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.dots-activity-group h2')].map(h => h.textContent.trim())"), ["等待你", "运行中", "已交付"]);
  assert.match(await evaluate(`${row("waiting", cases[1].task)}.innerText`), new RegExp(questionText.replace("？", "[？]")));
  assert.match(await evaluate(`${row("delivered", cases[0].task)}.innerText`), /客户交付[\s\S]*137 元/);
  assert.match(await evaluate(`${row("running", cases[2].task)}.innerText`), /运营工作[\s\S]*执行中/);
  await screenshot("dots-activity-three-states");

  await press("document.querySelector('.dots-activity-filters [data-state=delivered]')", "filter deliveries");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.dots-activity-group h2')].map(h => h.textContent.trim())"), ["已交付"]);
  await click("查看交付", ".dots-activity-page");
  await until(() => evaluate(`document.activeElement?.closest('.message-list') && document.activeElement.innerText.includes(${JSON.stringify(deliveryText)})`), "focus exact delivered reply");
  await until(() => evaluate("Boolean(document.querySelector('.dots-progress-history summary'))"), "heartbeat folded in chat");
  assert.doesNotMatch(await evaluate("document.querySelector('.message-list').innerText"), /最近观察到工具/);
  await press("document.querySelector('.dots-progress-history summary')", "expand progress history");
  await until(() => evaluate("document.querySelector('.dots-progress-history').innerText.includes('最近观察到工具')"), "durable progress still readable");

  await openRecent();
  await press("document.querySelector('.dots-recent-activity:popover-open [data-state=waiting] button')", "open native question from recent Activity");
  await until(() => evaluate(`!![...document.querySelectorAll('[data-interaction-id]')].find(card => card.textContent.includes(${JSON.stringify(questionText)}) && card.checkVisibility())`), "exact native question in worker chat");
  await press("[...document.querySelectorAll('[data-interaction-id] button')].find(button => button.textContent.trim() === '确认')", "answer native question");
  await waitFor(cases[1].task, "delivered");
  await openActivity();
  await press(`${row("delivered", cases[0].task)}?.querySelector('.dots-activity-dismiss')`, "remove quote from Activity");
  await until(async () => !(await api("dots.activity")).some(item => item.title === cases[0].task), "dismissal receipt committed");
  releaseInventory();
  await waitFor(cases[2].task, "delivered");

  await env.restart();
  await openActivity();
  await until(() => evaluate(`Boolean(${row("delivered", cases[2].task)})`), "remaining results after restart");
  assert.deepEqual((await api("dots.activity")).map(item => [item.title, item.state]).sort(), [
    [cases[1].task, "delivered"], [cases[2].task, "delivered"],
  ].sort());
  report.actualControlChecks.push("Sidebar has only MyBuddy Dots. Recent Activity counts only replies needed. Completed deliveries stay informational, can open the original reply, and can be dismissed across restart.");
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
      return JSON.stringify({ dotsState: "complete", result: "已核对库存，共 47 件。" });
    }
    return "[]";
  },
});

function spaceId(space) {
  return space === "客户交付" ? "sp-activity-delivery" : "sp-activity-ops";
}
