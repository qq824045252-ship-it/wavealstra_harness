const assert = require("node:assert/strict");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

run(async env => {
  const { evaluate, until, report } = env;
  const { click, openSettings, fill, screenshot } = routingControls(env);
  const tab = ".native-hooks-tab";
  const list = () => evaluate("window.api.nativeHooks.list()");
  const persist = async version => {
    await click("验证并发布", tab);
    await until(async () => {
      const error = await evaluate("document.querySelector('.native-hooks-tab [role=alert]')?.textContent");
      if (error) throw Error(error);
      return (await list())[0]?.revision === version;
    }, "published version " + version);
  };
  await openSettings("nativeHooks");
  await persist(1);
  await fill('[aria-label="名称"]', "空文件检查第二版");
  await persist(2);
  await fill('[aria-label="已验证版本"]', "1");
  await click("切换到此版本", tab);
  await until(async () => (await list())[0].revision === 1, "rolled back");
  await click("停用", tab);
  await until(async () => !(await list())[0].enabled, "disabled");
  await click("启用", tab);
  await until(async () => (await list())[0].enabled, "enabled");
  const taskId = "native-hook-desktop";
  const api = (method, arg) => evaluate("window.api." + method + "(" + JSON.stringify(arg) + ")");
  await api("db.upsertTask", { id: taskId, title: "Hook 验收", welcomeMode: "general", permissionMode: "auto", updatedAt: Date.now() });
  const { receipt } = await api("agent.prompt", { taskId, text: "HOOK_WRITE_DEMO", userMessageId: "demo", assistantMessageId: "response" });
  assert(receipt);
  const done = await api("agent.waitForSubmission", receipt);
  assert.equal(done.receipt.status, "done");
  const [hook] = await list();
  const rows = await api("nativeHooks.receipts", hook.id);
  assert(rows.some(r => r.taskId === taskId && r.tool === "write" && r.revision === 1 && r.outcome === "feedback"), JSON.stringify(rows));
  await click("刷新记录", tab);
  await until(() => evaluate("document.querySelector('.native-hooks-tab')?.textContent.includes('已反馈')"), "visible execution receipt");
  await screenshot("native-hooks");
  report.actualControlChecks.push("已验证发布、修订、版本回退、停用及重新启用；真实桌面会话触发检查，设置页展示 v1 拦截记录。");
}, { name: "native-hooks", settings: { permissionMode: "auto" }, watchRenderer: false,
  fixtureModel: request => request.messages.at(-1)?.role === "tool" ? "收到检查结果。"
    : JSON.stringify(request.messages.at(-1)).includes("HOOK_WRITE_DEMO") ? { tool: { name: "write", arguments: { path: "empty.txt", content: "" } } } : "收到。" });
