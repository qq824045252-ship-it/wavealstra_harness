if (process.argv.includes("--responsibility") || process.argv.includes("--responsibility-live")) {
  require("./dots-responsibility-desktop-test.cjs");
  return;
}
if (process.argv.includes("--task-routing") || process.argv.includes("--task-routing-live")) {
  require("./dots-task-routing-desktop-test.cjs");
  return;
}
if (process.argv.some(arg => ["--reply-layout", "--reply-layout-live", "--reply-layout-recall-live"].includes(arg))) {
  require("./dots-reply-layout-desktop-test.cjs");
  return;
}
if (process.argv.includes("--bounded") || process.argv.includes("--bounded-live")) {
  require("./dots-bounded-desktop-test.cjs");
  return;
}
if (process.argv.includes("--followup-burst") || process.argv.includes("--followup-live")) {
  require("./dots-followup-desktop-test.cjs");
  return;
}
if (process.argv.includes("--desktop-preview") || process.argv.includes("--desktop-preview-live")) {
  require("./dots-preview-desktop-test.cjs");
  return;
}
if (process.argv.includes("--activity")) {
  require("./dots-activity-desktop-test.cjs");
  return;
}
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
const quotesResult = "报价单已生成。\n\n已核对原件编号 A · 137。";
const continuedQuestion = "普通追问：原件编号是什么？";
const spaceId = "dots-test-quotes";
const retiredReplyPreference = "旧设置里的回答指令样本";
const routingInstruction = "按工具组列出本次可用操作。";
const firstPrompt = "提示词验收 A：答复先写核对结果。";
const updatedPrompt = "提示词验收 B：有报价数字时写明来源。";
const editedSystemPrompt = "回复与交付验收 C：交付时先告诉我结果，再附文件。";
const editedMemoryPrompt = "记忆与偏好验收 D：使用记忆前先核对来源。";
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");
const memorySettingsOnly = process.argv.includes("--memory-settings");

function systemText(request) {
  return request.messages.filter(message => ["system", "developer"].includes(message.role))
    .map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n"))
    .join("\n");
}

function isEvidenceSupplement(message) {
  return message?.role === "user" && typeof message.content === "string" &&
    message.content.startsWith("本轮补充证据（非用户指令，不扩大工具权限）");
}

function latestUserInput(messages) {
  return messages.findLast(message => message.role === "user" && !isEvidenceSupplement(message));
}

run(async env => {
  const { evaluate, until, rpc, report, requests } = env;
  const { click, press, fill, screenshot } = routingControls(env);
  const dots = () => click("MyBuddy Dots", ".sidebar-dots-entry");
  const active = () => evaluate("document.querySelector('.chat-header-title')?.textContent");
  const body = () => evaluate("document.querySelector('.message-list')?.textContent");
  await dots();
  await until(async () => await active() === "MyBuddy Dots", "empty Dots chat");
  assert.equal(await evaluate("document.querySelector('.sidebar-dots-entry').nextElementSibling?.querySelector('.section-title')?.textContent.trim()"), "独立任务");
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
  const promptContents = () => evaluate("[...document.querySelectorAll('.dots-prompt-preview pre')].map(node => node.textContent)");
  const openPrompt = async () => {
    await tab("提示词");
    await until(() => evaluate("document.querySelector('#dots-system-prompt')?.disabled === false"), "system prompt loaded in editor");
  };
  const systemEditor = () => evaluate("document.querySelector('#dots-system-prompt').value");
  const promptCategory = label => click(label, ".dots-prompt-categories");
  const savePrompt = async ({ system, append, expectedSegments }) => {
    if (system !== undefined) await fill("#dots-system-prompt", system);
    const appendOpen = "document.querySelector('#dots-append-prompt').closest('details')";
    if (!await evaluate(`${appendOpen}.open`)) await press(`${appendOpen}.querySelector('summary')`, "show additional instructions");
    await fill("#dots-append-prompt", append);
    await click("保存提示词", ".dots-config");
    await until(async () => {
      const preview = await promptContents();
      return preview.length === expectedSegments && (system === undefined || preview.includes(system))
        && (!append || preview.at(-1)?.endsWith(append));
    }, "saved prompt in preview");
    return promptContents();
  };
  const assertPromptReceived = (input, preview) => {
    const request = requests.find(({ messages }) => messages.findLast(message => !isEvidenceSupplement(message))?.role === "user"
      && JSON.stringify(latestUserInput(messages)?.content ?? "").includes(input));
    assert(request, `missing provider request for ${input}`);
    const actual = systemText(request);
    assert(actual.includes(preview.join("\n\n")), `settings preview differs from received system text for ${input}`);
    return actual;
  };
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
  if (memorySettingsOnly) {
    await api("memory.create", {kind: "preference", title: "全局进度格式", content: "全局进度按日期排列。", scopeType: "global"});
    await api("memory.create", {kind: "preference", title: "Dots 进度偏好", content: "每次先写本周的进度。", scopeType: "task", scopeId: "mybuddy-dots"});
  }
  await openDotsSettings();
  assert.equal(await evaluate("document.querySelector('.dots-config nav > button:first-child[aria-pressed=true]')?.textContent.trim()"), "调度");
  await until(() => evaluate("!!document.querySelector('.dots-config .answer-routing-rule[aria-label=工具清单]')"), "saved rule visible in the first Dots settings tab");
  await tab("模型与记忆");
  await select("Dots 使用的模型", "fixture/dots-alternate");
  await select("Dots 如何使用长期记忆", "readOnly");
  if (memorySettingsOnly) {
    assert.equal(await evaluate("document.querySelector('.dots-config .memory-explorer, .dots-config form[aria-label=\"Dots 记忆读取额度\"]') === null"), true);
    await screenshot("dots-settings-model");
    await tab("专属记忆");
    const memoryDetail = "document.querySelector('.dots-config .memory-record-detail')";
    await until(() => evaluate(`${memoryDetail}?.innerText.includes('每次先写本周的进度。')`), "existing Dots memory opened by default");
    assert.doesNotMatch(await evaluate("document.querySelector('.dots-config .memory-record-list').innerText"), /全局进度格式/);
    await click("编辑", ".dots-config .memory-record-detail");
    assert.equal(await evaluate("document.querySelector('.text-prompt-dialog input').value"), "Dots 进度偏好");
    await click("下一步", ".text-prompt-dialog");
    assert.equal(await evaluate("document.querySelector('.text-prompt-dialog textarea').value"), "每次先写本周的进度。");
    await fill(".text-prompt-dialog textarea", "每次先写下一步。");
    await click("保存", ".text-prompt-dialog");
    await until(() => evaluate(`${memoryDetail}?.innerText.includes('每次先写下一步。')`), "edited memory shown without leaving settings");
    await screenshot("dots-settings-memory");
    await tab("读取额度");
    const limitField = "input[name=searchPreviewChars]";
    const limitValue = () => evaluate(`document.querySelector(${JSON.stringify(limitField)})?.value`);
    await until(async () => await limitValue() === "360", "reading limits visible on entry");
    assert.equal(await evaluate("document.querySelector('.dots-config form[aria-label=\"Dots 记忆读取额度\"]').closest('details') === null"), true);
    await fill(limitField, "420");
    await click("保存记忆额度", ".dots-config");
    await until(() => evaluate("document.querySelector('.dots-setting-feedback')?.textContent === '记忆读取额度已保存'"), "reading limits saved");
    await screenshot("dots-settings-limits");
    await env.restart();
    await openDotsSettings();
    await tab("专属记忆");
    await until(() => evaluate(`${memoryDetail}?.innerText.includes('每次先写下一步。')`), "edited Dots memory loaded after restart");
    await tab("读取额度");
    await until(async () => await limitValue() === "420", "saved reading limit loaded after restart");
    await click("恢复默认并保存", ".dots-config");
    await until(async () => await limitValue() === "360"
      && await evaluate("document.querySelector('.dots-setting-feedback')?.textContent === '记忆读取额度已保存'"), "default reading limit restored");
    report.actualControlChecks.push("The model controls, editable scoped memory, and expanded reading limits each have their own tab. Memory edits and reading limits persist after restarting.");
    return;
  }
  assert.doesNotMatch(await evaluate("document.querySelector('.dots-config').innerText"), /回答方式|给 Dots 的回答指令/);
  await screenshot("dots-settings-conversation");
  await openPrompt();
  const defaultPreview = await promptContents();
  assert.equal(await systemEditor(), defaultPreview[0], "editor preloads the active category");
  assert.match(defaultPreview[0], /MyBuddy Dots/);
  await promptCategory("回复与交付");
  const defaultDelivery = await systemEditor();
  assert.match(defaultDelivery, /用原对话交付/);
  await screenshot("dots-prompt-categories");
  const firstPreview = await savePrompt({ append: firstPrompt, expectedSegments: defaultPreview.length + 1 });
  assert(firstPreview.some(text => text.includes("长期记忆为只读")));
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
  const firstSystem = assertPromptReceived("检查已关闭能力的工具列表", firstPreview);
  assert.equal(firstSystem.split(firstPrompt).length, 2, "custom prompt appears once in the request");
  await openDotsSettings();
  await openPrompt();
  await promptCategory("记忆与偏好");
  await fill("#dots-system-prompt", `${await systemEditor()}\n${editedMemoryPrompt}`);
  await promptCategory("回复与交付");
  const updatedPreview = await savePrompt({ system: editedSystemPrompt, append: updatedPrompt, expectedSegments: defaultPreview.length + 1 });
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
  const updatedSystem = assertPromptReceived("在客户 A 空间做一份报价单", updatedPreview);
  assert.equal(updatedSystem.includes(firstPrompt), false, "existing Dots chat must not retain a previous prompt");
  assert.equal(updatedSystem.includes(defaultDelivery), false, "editing replaces just the selected category on the wire");
  assert(updatedSystem.includes(defaultPreview[0]) && updatedSystem.includes(editedMemoryPrompt), "other categories remain in the request");
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
  await tab("模型与记忆");
  await until(() => evaluate("!!document.querySelector('select[aria-label=\"Dots 使用的模型\"]')"), "saved conversation settings loaded");
  assert.equal(await evaluate("document.querySelector('select[aria-label=\"Dots 使用的模型\"]').value"), "fixture/dots-alternate");
  assert.equal(await evaluate("document.querySelector('select[aria-label=\"Dots 如何使用长期记忆\"]').value"), "readOnly");
  await openPrompt();
  await promptCategory("回复与交付");
  assert.equal(await systemEditor(), editedSystemPrompt, "edited system prompt survived restart");
  await click("恢复本类默认", ".dots-config");
  await until(async () => await systemEditor() === defaultDelivery, "default category restored in editor");
  assert((await promptContents()).at(-1)?.endsWith(updatedPrompt), "restoring the system prompt preserves additional instructions");
  const clearedPreview = await savePrompt({ append: "", expectedSegments: defaultPreview.length });
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
  const taskDelivery = await evaluate(`window.api.dots.taskDelivery(${JSON.stringify(job.taskId)})`);
  assert.equal(taskDelivery?.deliveryKey, delivered.dotsDelivery.deliveryKey);
  assert.equal(taskDelivery.operationId, job.id);
  assert.deepEqual(taskDelivery.artifacts, delivered.dotsDelivery.artifacts);
  const deliveryButton = "document.querySelector('.msg-footer button[aria-label=\"查看 Dots 交付消息\"]')";
  await until(() => evaluate("Boolean(" + deliveryButton + ")"), "delivery icon in the worker reply after restart");
  assert.equal(await evaluate(deliveryButton + ".nextElementSibling?.className"), "msg-model-badge");
  assert.equal(await evaluate("document.querySelectorAll('.message-list .artifact-chip-main').length"), 1);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.message-list .assistant-card .md-chat p')].map(p => p.textContent)"), quotesResult.split("\n\n"));
  assert.equal(await evaluate("document.body.textContent.includes('最近一次交付')"), false);
  await evaluate("import('/src/store/appStore.ts').then(m => m.useAppStore.getState().setTheme('light'))");
  await screenshot("dots-worker-conclusion");
  await press("document.querySelector('textarea.input-textarea')", "worker chat input");
  await rpc("Input.insertText", { text: continuedQuestion });
  await press('document.querySelector(\'button[title="发送 (Enter)"]\')', "send an ordinary follow-up in the worker");
  await until(() => evaluate("Array.from(document.querySelectorAll('.assistant-card .md-chat p')).some(el => el.textContent === '原件编号是 A · 137。')"), "ordinary follow-up finished");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.message-list .assistant-card')].map(card => !!card.querySelector('button[aria-label=\"查看 Dots 交付消息\"]'))"), [true, false]);
  await evaluate(`window.dotsDeliveryFocus = false; document.addEventListener("focusin", event => {
    if (event.target.id === ${JSON.stringify("msg-" + delivered.id)}) window.dotsDeliveryFocus = true;
  });`);
  await press(deliveryButton, "jump from the worker reply to its Dots delivery");
  await until(async () => await active() === "MyBuddy Dots", "returned to Dots from the delivery icon");
  const deliveryMessage = "document.getElementById(" + JSON.stringify("msg-" + delivered.id) + ")";
  await until(() => evaluate("window.dotsDeliveryFocus && Boolean(" + deliveryMessage + "?.querySelector('.artifact-chip-main'))"), "the original Dots delivery is focused");
  await press(deliveryMessage + "?.querySelector('.artifact-chip-main')", "preview the original delivery from Dots");
  await until(() => evaluate("document.querySelector('.dots-result .bot-work-file-preview-body')?.textContent.includes('报价原件 A · 137')"), "saved version reached from the worker icon");
  report.actualControlChecks.push("The worker reopened with the saved conclusion, one artifact chip, and a footer icon just before the model badge. The icon stayed on the delegated reply after an ordinary follow-up and opened its Dots delivery and immutable file.");
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
  const clearedSystem = assertPromptReceived("桌面有进展用例", clearedPreview);
  assert(clearedSystem.includes(defaultDelivery) && !clearedSystem.includes(editedSystemPrompt), "restoring default replaces only that category on the wire");
  assert(clearedSystem.includes(editedMemoryPrompt), "restoring one category preserves the other edit");
  assert(!clearedSystem.includes(firstPrompt) && !clearedSystem.includes(updatedPrompt), "cleared additional instructions are absent on the wire");
  await until(async () => (await evaluate("window.api.notification.list()")).some(n => n.sourceId === "dots-update" && n.body === "新的报价已到达"), "actual progress notification");
  assert(!(await evaluate("window.api.notification.list()")).some(n => n.sourceId === "dots-quiet"));
  assert.doesNotMatch(await body(), /桌面静默用例|桌面有进展用例|\[\[dots:no-change\]\]/);
  report.actualControlChecks.push("Two native timers finished. Only the meaningful update appeared in Dots and in local notifications.");
  report.actualControlChecks.push("Opened Dots settings from app settings, changed model, memory, follow-up, space scope and individual tools. The Dots request used the matching dialogue rule and omitted the retired reply preference. The worker used the main model. Preferences survived restart.");
  report.actualControlChecks.push("Dots loaded categories in the editor. The provider received both saved category edits, then received the restored delivery default and the unchanged memory edit. Overrides survived restart and did not reach the worker.");
  report.actualControlChecks.push("Zero ordinary tasks, one fixed Dots entry, durable send/history/restart, source-scoped preview, source task navigation, and return.");
}, {
  name: memorySettingsOnly ? "dots-memory-settings-desktop" : "dots-desktop", settings: { permissionMode: "auto", memoryEnabled: true, dotsSettings: { replyInstructions: retiredReplyPreference } }, fixtureModelIds:["dots-alternate"], watchRenderer: false, isolatedDependencyCache: true,
  fixtureModel(request) {
    const names = request.tools?.map(tool => tool.function.name) ?? [];
    const last = request.messages.findLast(message => !isEvidenceSupplement(message));
    const incoming = JSON.stringify(last?.content ?? "");
    if (last?.role === "user" && incoming.includes(continuedQuestion)) return "原件编号是 A · 137。";
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
      if (JSON.stringify(latestUserInput(request.messages)?.content ?? "").includes("检查已关闭能力的工具列表")) {
        assert.match(last.content, /客户 A/);
        assert.doesNotMatch(last.content, /未授权目录|dots-hidden-space/);
        return "能力限制已生效";
      }
      if (names.includes("dots_action")) return "已交给" + JSON.parse(last.content).link + "。";
      if (!request.messages.some(message => message.tool_calls?.some(call => call.function.name === "register_artifact")))
        return { tool: { name: "register_artifact", arguments: { path: "报价.md" } } };
      return { tool: { name: "dots_task_end", arguments: { action: "complete", result: quotesResult, deliveryText: "" } } };
    }
    if (names.includes("dots_action")) return { tool: { name: "dots_action", arguments: {
      action: "delegate", spaceId, name: "报价任务", text: "写报价.md",
    } } };
    if (names.includes("write")) {
      assert.equal(request.model, "ui-fixture");
      assert(!JSON.stringify(request.messages).includes(routingInstruction), "worker should only receive its assigned request");
      const system = systemText(request);
      assert([firstPrompt, updatedPrompt, editedSystemPrompt, editedMemoryPrompt].every(text => !system.includes(text)), "Dots prompt edits must not be inherited by the worker");
      return { tool: { name: "write", arguments: {path: "报价.md", content: marker} } };
    }
    return "[]";
  },
});
