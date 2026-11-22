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
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

run(async env => {
  const { evaluate, until, rpc, report } = env;
  const { click, press } = routingControls(env);
  const dots = () => click("MyBuddy Dots", ".sidebar-scroll");
  const active = () => evaluate("document.querySelector('.chat-header-title')?.textContent");
  const body = () => evaluate("document.querySelector('.message-list')?.textContent");
  await dots();
  await until(async () => await active() === "MyBuddy Dots", "empty Dots chat");
  assert.equal(await evaluate("document.querySelector('.desktop-section-row[aria-current=true]').nextElementSibling.textContent.trim()"), "独立任务");
  assert.equal(await evaluate("window.api.db.listTasks().then(rows => rows.length)"), 0);
  const workspace = path.join(env.home, "报价空间");
  mkdirSync(workspace);
  const api = (method, arg) => evaluate("window.api." + method + "(" + JSON.stringify(arg) + ")");
  await api("db.upsertSpace", {id: spaceId, name: "客户 A", path: workspace});
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
  report.actualControlChecks.push("Zero ordinary tasks, one fixed Dots entry, durable send/history/restart, source-scoped preview, source task navigation, and return.");
}, {
  name: "dots-desktop", settings: { permissionMode: "auto" }, watchRenderer: false, isolatedDependencyCache: true,
  fixtureModel(request) {
    const names = request.tools?.map(tool => tool.function.name) ?? [];
    const last = request.messages.at(-1);
    const incoming = JSON.stringify(last?.content ?? "");
    if (last?.role === "user" && incoming.includes("桌面静默用例")) return "[[dots:no-change]]";
    if (last?.role === "user" && incoming.includes("桌面有进展用例")) return "新的报价已到达";
    if (last?.role === "tool") {
      if (names.includes("dots_action")) return "已交给" + JSON.parse(last.content).link + "。";
      return "报价文件已写入";
    }
    if (names.includes("dots_action")) return { tool: { name: "dots_action", arguments: {
      action: "delegate", spaceId, name: "报价任务", text: "写报价.md",
    } } };
    if (names.includes("write")) return { tool: { name: "write", arguments: {path: "报价.md", content: marker} } };
    return "[]";
  },
});
