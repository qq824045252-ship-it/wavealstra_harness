if (process.argv.includes("--activity-live")) {
  require("./dots-activity-live.cjs");
  return;
}
if (process.argv.includes("--foreground-live")) {
  require("./dots-foreground-live.cjs");
  return;
}
if (process.argv.includes("--live-handoff")) {
  require("./dots-handoff-live.cjs");
  return;
}
if (process.argv.includes("--proactive")) {
  require("./dots-proactive-desktop-test.cjs");
  return;
}
if (process.argv.includes("--excel")) {
  require("./dots-office-desktop-test.cjs");
  return;
}
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const marker = "报价原件 A · 137";
const spaceId = "dots-test-quotes";
const retiredReplyPreference = "旧设置里的回答指令样本";
const routingInstruction = "按工具组列出本次可用操作。";
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

run(async env => {
  const { evaluate, until, rpc, report } = env;
  const { click, press, fill, screenshot } = routingControls(env);
  const dots = () => click("MyBuddy Dots", ".sidebar-scroll");
  const active = () => evaluate("document.querySelector('.chat-header-title')?.textContent");
  const body = () => evaluate("document.querySelector('.message-list')?.textContent");
  await dots();
  await until(async () => await active() === "MyBuddy Dots", "empty Dots chat");
  assert.equal(await evaluate("document.querySelector('.desktop-section-row[aria-current=true]').nextElementSibling.textContent.trim()"), "独立任务");
  assert.equal(await evaluate("window.api.db.listTasks().then(rows => rows.length)"), 0);
  const openDotsSettings = async () => {
    assert.equal(await evaluate("!!document.querySelector('.chat-header button[aria-label=\"Dots 设置\"]')"), false);
    await click("设置", ".desktop-rail");
    await press("[...document.querySelectorAll('button.settings-nav-btn')].find(b=>b.textContent.trim()==='Dots 设置')", "Dots settings in app settings");
    await until(() => evaluate("!!document.querySelector('.dots-config nav')"), "Dots settings loaded");
  };
  const switchFor = label => `document.querySelector('[role="switch"][aria-label="${label}"]')`;
  const setCapability = async (label, checked) => {
    const selector = switchFor(label);
    await until(() => evaluate(`Boolean(${selector} && !${selector}.disabled)`), label);
    await press(selector, label);
    await until(() => evaluate(`${selector}?.getAttribute("aria-checked") === "${checked}"`), label + " saved");
  };
  const closeSettings = () => press('document.querySelector("button[aria-label=关闭设置]")', "close settings");
  const tab = label => click(label, ".dots-config nav");
  const select = async (label, value) => {
    await fill('select[aria-label="' + label + '"]', value);
    await until(() => evaluate("document.querySelector('.dots-setting-feedback')?.textContent.includes('已保存') && !document.querySelector('.dots-config fieldset').disabled"), label + " saved");
  };
  const checkbox = label => `[...document.querySelectorAll('.dots-config-check')].find(el=>el.textContent.startsWith(${JSON.stringify(label)}))?.querySelector('input')`;
  const expandSpace = () => press("[...document.querySelectorAll('.dots-tool-group summary')].find(el=>el.textContent.startsWith('管理工作空间'))", "space operations");
  const workspace = path.join(env.home, "报价空间");
  mkdirSync(workspace);
  const api = (method, arg) => evaluate("window.api." + method + "(" + JSON.stringify(arg) + ")");
  await api("db.upsertSpace", {id: spaceId, name: "客户 A", path: workspace});
  await api("db.upsertSpace", {id: "dots-hidden-space", name: "未授权目录"});
  await api("answerRouting.save", {title: "工具清单", include: ["检查已关闭能力的工具列表"], exclude: [], instruction: routingInstruction,
    evidenceFile: "", projectId: null, sourceMemoryId: null, enabled: true});
  await openDotsSettings();
  assert.equal(await evaluate("document.querySelector('.dots-config nav > button:first-child[aria-pressed=true]')?.textContent.trim()"), "对话调度");
  await until(() => evaluate("!!document.querySelector('.dots-config .answer-routing-rule[aria-label=工具清单]')"), "saved rule visible in the first Dots settings tab");
  await tab("对话与记忆");
  await select("Dots 使用的模型", "fixture/dots-alternate");
  await select("Dots 如何使用长期记忆", "readOnly");
  assert.doesNotMatch(await evaluate("document.querySelector('.dots-config').innerText"), /回答方式|给 Dots 的回答指令/);
  await screenshot("dots-settings-conversation");
  await tab("跟进与空间");
  await select("到时间或有实质进展时", "notify");
  await select("空间范围", "selected");
  await press(checkbox("客户 A"), "allow customer space");
  await until(() => evaluate(checkbox("客户 A") + "?.checked"), "space allowed");
  await screenshot("dots-settings-followup");
  await tab("工具与操作");
  await expandSpace();
  await press(checkbox("重命名空间"), "disable rename only");
  await until(() => evaluate(checkbox("重命名空间") + "?.checked === false"), "rename disabled");
  await setCapability("委派和接续任务", false);
  await setCapability("定时计划和文件订阅", false);
  await screenshot("dots-settings-tools");
  await closeSettings();
  await press("document.querySelector('textarea.input-textarea')", "Dots input");
  await rpc("Input.insertText", { text: "检查已关闭能力的工具列表" });
  await press('document.querySelector(\'button[title="发送 (Enter)"]\')', "send Dots policy check");
  await until(async () => (await body())?.includes("能力限制已生效"), "provider received restricted Dots tools");
  await openDotsSettings();
  await tab("工具与操作");
  await setCapability("委派和接续任务", true);
  await closeSettings();
  await api("db.upsertTask", {id: "dots-other", title: "另一任务", welcomeMode: "general", updatedAt: Date.now()});
  await api("artifactDomain.register", {id: "dots-other-file", taskId: "dots-other", title: "报价.md", kind: "markdown", content: "同名文件 B"});
  report.seededPresentationFacts.push("Created a customer workspace and a separate ordinary task with an unrelated file of the same name.");
  await press("document.querySelector('textarea.input-textarea')", "Dots input");
  await rpc("Input.insertText", { text: "在客户 A 空间做一份报价单" });
  await press('document.querySelector(\'button[title="发送 (Enter)"]\')', "send Dots question");
  await until(async () => (await body())?.includes("已交给"), "Dots replied to its caller");
  await until(() => evaluate("window.api.dots.list().then(rows => rows.some(row => row.status === 'completed' && row.artifacts.length === 1))"), "native task delivered its file");
  const [job] = await evaluate("window.api.dots.list()");
  assert.equal(job.title, "报价任务");
  assert.equal(job.artifacts[0].name, "报价.md");
  assert.equal(readFileSync(path.join(workspace, "报价.md"), "utf8"), marker);
  assert.equal(await evaluate("window.api.db.listTasks().then(rows=>rows.length)"), 2);
  await env.restart();
  await dots();
  await until(async () => (await body())?.includes("已交给"), "Dots history restored");
  await openDotsSettings();
  await tab("对话与记忆");
  await until(() => evaluate("!!document.querySelector('select[aria-label=\"Dots 使用的模型\"]')"), "saved conversation settings loaded");
  assert.equal(await evaluate("document.querySelector('select[aria-label=\"Dots 使用的模型\"]').value"), "fixture/dots-alternate");
  assert.equal(await evaluate("document.querySelector('select[aria-label=\"Dots 如何使用长期记忆\"]').value"), "readOnly");
  await tab("跟进与空间");
  assert.equal(await evaluate(checkbox("客户 A") + "?.checked"), true);
  assert.equal(await evaluate("document.querySelector('select[aria-label=\"到时间或有实质进展时\"]').value"), "notify");
  await select("到时间或有实质进展时", "continue");
  await select("空间范围", "all");
  await tab("工具与操作");
  await expandSpace();
  assert.equal(await evaluate(checkbox("重命名空间") + "?.checked"), false);
  await until(() => evaluate(`${switchFor("定时计划和文件订阅")}?.getAttribute("aria-checked") === "false"`), "saved Dots setting survived restart");
  await closeSettings();
  await until(() => evaluate("!!document.querySelector('.dots-result .artifact-chip-main')"), "delivered file");
  assert.equal(await evaluate("document.querySelector('.dots-result').textContent.trim()"), "报价.md");
  const chatImage = await rpc("Page.captureScreenshot", {format: "png"});
  writeFileSync(path.join(env.out, "dots-home.png"), Buffer.from(chatImage.data, "base64"));
  const delivered = (await evaluate("window.api.agent.loadTaskHistory('mybuddy-dots').then(h=>h.messages)"))
    .find(message => message.role === "assistant" && message.dotsDelivery?.operationId === job.id);
  assert(delivered, "file belongs to its own stored Dots assistant reply");
  assert.equal(await evaluate("document.getElementById(" + JSON.stringify("msg-" + delivered.id) + ")?.querySelectorAll('.assistant-card .artifact-chip-main').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('.message-list .artifact-chip-main').length"), 1);
  assert.equal(await evaluate("[...document.querySelectorAll('.task-item-title')].some(el => el.textContent === 'MyBuddy Dots')"), false);
  assert.ok(await evaluate("!!document.querySelector('.message-list [id^=msg-] .dots-result')"), "native delivery is in a Dots assistant message");
  assert.ok(job.artifacts[0].saved?.snapshotPath);
  writeFileSync(path.join(workspace, "报价.md"), "覆盖后的版本");
  await press("document.querySelector('.dots-result .artifact-chip-main')", "preview source artifact");
  await until(() => evaluate("document.querySelector('.dots-result .bot-work-file-preview-body')?.textContent.includes('报价原件 A · 137')"), "saved original after workspace overwrite");
  assert.equal(await active(), "MyBuddy Dots");
  await click("报价任务", ".dots-result");
  await until(async () => await active() === "报价任务", "source task opened");
  assert.equal(await evaluate("!!document.querySelector('.dots-result')"), false);
  await dots();
  await until(async () => (await body())?.includes("已交给"), "return to original Dots conversation");
  await press("document.querySelector('.message-list a.md-link')", "open task link in Dots reply");
  await until(async () => await active() === "报价任务", "native task link opened");
  await dots();
  const check = { name: "检查报价是否变化", prompt: "桌面静默用例", sourceTaskId: "mybuddy-dots",
    target: {kind: "task", taskId: "mybuddy-dots"}, enabled: true, scheduleType: "every", scheduleExpr: "1h",
    timezone: "UTC", cwd: workspace, createdAt: Date.now(), updatedAt: Date.now() };
  for (const [id, prompt] of [["dots-quiet", "桌面静默用例"], ["dots-update", "桌面有进展用例"]]) {
    await api("cron.upsert", { ...check, id, prompt });
    await api("cron.runNow", id);
    await until(async () => (await api("cron.runs", 10)).some(run => run.jobId === id && run.status === "success"), id);
  }
  await until(async () => (await body())?.includes("新的报价已到达"), "meaningful result in Dots");
  await until(async () => (await evaluate("window.api.notification.list()")).some(n => n.sourceId === "dots-update" && n.body === "新的报价已到达"), "actual progress notification");
  assert(!(await evaluate("window.api.notification.list()")).some(n => n.sourceId === "dots-quiet"));
  assert.doesNotMatch(await body(), /桌面静默用例|桌面有进展用例|\[\[dots:no-change\]\]/);
  report.actualControlChecks.push("Two native timers finished. Only the meaningful update appeared in Dots and in local notifications.");
  report.actualControlChecks.push("Opened Dots settings from app settings, changed model, memory, follow-up, space scope and individual tools. The Dots request used the matching dialogue rule and omitted the retired reply preference. The worker used the main model. Preferences survived restart.");
  report.actualControlChecks.push("Zero ordinary tasks, one fixed Dots entry, durable send/history/restart, source-scoped preview, source task navigation, and return.");
}, {
  name: "dots-desktop", settings: { permissionMode: "auto", memoryEnabled: true, dotsSettings: { replyInstructions: retiredReplyPreference } }, fixtureModelIds:["dots-alternate"], watchRenderer: false, isolatedDependencyCache: true,
  fixtureModel(request) {
    const names = request.tools?.map(tool => tool.function.name) ?? [];
    const last = request.messages.at(-1);
    const incoming = JSON.stringify(last?.content ?? "");
    if (last?.role === "user" && incoming.includes("检查已关闭能力的工具列表")) {
      const actions = name => JSON.stringify(request.tools.find(tool => tool.function.name === name).function.parameters.properties.action);
      assert.equal(request.model, "dots-alternate");
      assert(incoming.includes(routingInstruction), "matching dialogue rule reached the Dots request");
      assert(!JSON.stringify(request.messages).includes(retiredReplyPreference), "old standalone reply preference was ignored");
      assert(names.includes("memory_search") && !names.includes("memory_create"));
      assert.doesNotMatch(actions("dots_action"), /"delegate"|"rename"|"watch_file"/);
      assert.match(actions("dots_action"), /"create_space"/);
      assert.match(actions("dots_action"), /"stop"/);
      assert.doesNotMatch(actions("automation_exec"), /"create"|"resume"/);
      assert.match(actions("automation_exec"), /"cancel"/);
      return { tool: {name: "dots_action", arguments: {action: "spaces"}} };
    }
    if (last?.role === "user" && incoming.includes("桌面静默用例")) return "[[dots:no-change]]";
    if (last?.role === "user" && incoming.includes("桌面有进展用例")) return "新的报价已到达";
    if (last?.role === "tool") {
      if (JSON.stringify(request.messages.filter(m => m.role === "user").at(-1)?.content).includes("检查已关闭能力的工具列表")) {
        assert.match(last.content, /客户 A/);
        assert.doesNotMatch(last.content, /未授权目录|dots-hidden-space/);
        return "能力限制已生效";
      }
      if (names.includes("dots_action")) return "已交给" + JSON.parse(last.content).link + "。";
      return JSON.stringify({dotsState:"complete",result:""});
    }
    if (names.includes("dots_action")) return { tool: { name: "dots_action", arguments: {
      action: "delegate", spaceId, name: "报价任务", text: "写报价.md",
    } } };
    if (names.includes("write")) {
      assert.equal(request.model, "ui-fixture");
      assert(!JSON.stringify(request.messages).includes(routingInstruction), "worker should only receive its assigned request");
      return { tool: { name: "write", arguments: {path: "报价.md", content: marker} } };
    }
    return "[]";
  },
});
