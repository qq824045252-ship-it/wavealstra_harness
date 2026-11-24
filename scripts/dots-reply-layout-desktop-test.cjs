const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

const recallOnly = process.argv.includes("--reply-layout-recall-live");
const liveModel = recallOnly || process.argv.includes("--reply-layout-live");
const spaceId = "dots-reply-layout-space";
const checkTask = "在「排版验收」空间委派普通任务，汇报 check.txt 里三项检查的结果。只读取这个文件，不运行命令。";
const legacyTask = "在「排版验收」空间交办普通任务，汇报这次交付核对的情况。";
const exactTask = "在「排版验收」空间交办普通任务，核对有两项通过的记录。只回复单行 JSON，键名依次是 ok、n。";
const fileTask = "在「排版验收」空间交办普通任务，生成 layout-proof.txt，内容是已完成排版核对。只给我 layout-proof.txt。";
const shortQuestion = "18 减去 7 等于多少？";
const diagnosis = "进讨论，只按以下事实分析。样品盒已打包并扫码留档。交接表的自动规则是取件单号留空就显示待发，填入就显示待取件。单号现在已拿到。为什么卡着，怎么解决？";
const status = "交接进度如下：甲已收到样品，乙还在等取件，丙暂停是因为地址要复核。帮我汇报当前进度。";
const denseQuestion = "说说交接核对的结果。";
const literalQuestion = "请原样复述交接核对记录，保持单段。";
const recallQuestion = "带回交接核对报告的原文和原任务入口。";
const liveRecallQuestion = "排版验收空间里，之前汇报 check.txt 三项检查的委派做完了吗？哪项没通过？给我原任务入口。只查已有结果，别重跑。";
const denseParagraphs = [
  "这次交接核对已经完成，现场负责人、日期和批次三项都同登记记录一致。",
  "到货时先检查了外箱、封签、随箱单和内盒，一共核对了两个外箱与四个内盒。随后分别复核甲班和乙班留存的交接单，把时间、批次和数量逐项比对。两份交接单记录的批次一致，数量也和记录中的封签编号一一对应。",
  "本轮检查确认了交接资料齐备，后续可以沿用同一份已签字的登记记录供有关同事查阅。相关现场照片已由核对人员保留在执行记录，交接原件已归还。",
];
const denseText = denseParagraphs.join("");
const exactJson = '{"ok":true,"n":2}';
const fileProof = "已完成排版核对。";
const tool = (name, arguments_) => ({ tool: { name, arguments: arguments_ } });

function fixtureModel(request) {
  const user = JSON.stringify(request.messages.findLast(message => message.role === "user")?.content ?? "");
  const foreground = request.tools?.some(item => item.function.name === "dots_action");
  if (foreground) {
    if (user.includes(recallQuestion)) {
      const last = request.messages.at(-1);
      if (last?.role !== "tool") return tool("dots_action", { action: "deliveries", spaceId, query: "交接核对报告" });
      const found = JSON.parse(last.content).results.find(item => item.title === "交接核对报告");
      assert.equal(found.text, denseText, "recall provides the original completed body");
      return "### 原任务原文\n\n> " + found.text + "\n\n" + found.link;
    }
    if (request.messages.at(-1)?.role === "tool") return "已交给原任务核对。";
    if (user.includes(denseQuestion) || user.includes(literalQuestion)) return denseText;
    if (user.includes(legacyTask)) return tool("dots_action", { action: "delegate", spaceId, name: "交接核对报告", text: "汇报这次交付核对的情况。" });
    if (user.includes("核对有两项通过的记录")) return tool("dots_action", { action: "delegate", spaceId,
      name: "交接精确 JSON", text: "核对有两项通过的记录。", deliveryInstruction: "只回复单行 JSON，键名依次是 ok、n。" });
    if (user.includes(fileTask)) return tool("dots_action", { action: "delegate", spaceId,
      name: "布局佐证文件", text: "生成 layout-proof.txt，内容是已完成排版核对。", deliveryInstruction: "只给我 layout-proof.txt。" });
  } else {
    if (user.includes("核对有两项通过的记录"))
      return tool("dots_task_end", { action: "complete", result: "已确认两项通过。", deliveryText: exactJson });
    if (user.includes("汇报这次交付核对")) return JSON.stringify({ dotsState: "complete", result: denseText });
    if (user.includes("生成 layout-proof.txt")) {
      const calls = request.messages.flatMap(message => message.tool_calls ?? []).map(call => call.function.name);
      if (!calls.includes("write")) return tool("write", { path: "layout-proof.txt", content: fileProof });
      if (!calls.includes("register_artifact")) return tool("register_artifact", { path: "layout-proof.txt" });
      return JSON.stringify({ dotsState: "complete", result: "文件已生成并登记。", delivery: { text: "" } });
    }
  }
  throw new Error("Unexpected reply-layout fixture request");
}

run(async env => {
  const { evaluate, until, home, report, restart, requests, rpc } = env;
  const { click, askInChat, press, screenshot } = routingControls(env);
  const api = (name, ...args) => evaluate("window.api." + name + "(" + args.map(arg => JSON.stringify(arg)).join(",") + ")");
  const folder = join(home, "layout-check");
  mkdirSync(folder);
  writeFileSync(join(folder, "check.txt"), "启动：通过\n导入：通过\n导出：失败（目标目录无写权限）\n");
  await until(() => evaluate("Boolean(window.api?.db && document.querySelector('.sidebar-dots-entry'))"), "ready for Dots");
  const parentId = "dots-reply-layout-parent";
  await api("db.upsertSpace", { id: parentId, name: "客户交付" });
  await api("db.upsertSpace", { id: spaceId, parentId, name: "排版验收", path: folder });
  const foreground = liveModel && process.env.MYBUDDY_DOTS_LIVE_FOREGROUND;
  if (foreground) await api("agent.updateAppSettings", { dotsSettings: { modelId: "fixture/" + foreground } });
  const open = async () => {
    await click("MyBuddy Dots", ".sidebar-dots-entry");
    await until(() => evaluate("Boolean(document.querySelector('.chat-header-title')?.textContent.includes('MyBuddy Dots'))"), "Dots chat");
  };
  await open();
  const taskId = "mybuddy-dots";
  const history = async () => (await api("agent.loadTaskHistory", taskId)).messages;
  const lastDirect = async () => (await history()).findLast(message => message.role === "assistant" && message.text && !message.dotsDelivery);
  const selector = id => "document.getElementById(" + JSON.stringify("msg-" + id) + ")";
  const layout = id => evaluate("(() => { const body = " + selector(id) + "?.querySelector('.assistant-card'); "
    + "if (!body) return; const texts = sel => Array.from(body.querySelectorAll(sel), node => node.textContent.trim()); "
    + "return { paragraphs: texts('.md-chat p'), headings: texts('.md-chat :is(h1,h2,h3,h4,h5,h6)'), "
    + "items: texts('.md-chat li'), rows: texts('.md-chat table tbody tr'), "
    + "exactJson: body.querySelector('.dots-literal-json')?.textContent }; })()");
  const paragraphGaps = id => evaluate("(() => { const body = " + selector(id) + "; "
    + "const rects = Array.from(body.querySelectorAll('.assistant-card .md-chat p'), node => node.getBoundingClientRect()); "
    + "return rects.slice(1).map((rect, i) => Math.round(rect.top - rects[i].bottom)); })()");
  const observed = async reply => {
    assert(reply?.id, "stored assistant reply");
    let state;
    await until(async () => Boolean(state = await layout(reply.id)), "rendered assistant reply " + reply.id);
    return state;
  };
  const send = async (userMessageId, text) => {
    const result = await api("agent.prompt", { taskId, userMessageId, assistantMessageId: userMessageId + "-answer", text });
    assert(result.receipt, JSON.stringify(result));
  };
  const readDelivery = async inputId => {
    const matches = async () => (await history()).filter(message =>
      message.dotsDelivery?.kind === "conclusion" && message.dotsDelivery.sourceMessageId === inputId);
    await until(async () => (await matches()).length > 0, "completion in the original Dots conversation for " + inputId);
    const deliveries = await matches();
    assert.equal(deliveries.length, 1);
    return deliveries[0];
  };

  if (liveModel) {
    if (!recallOnly) {
      await askInChat(taskId, shortQuestion);
      const short = await lastDirect();
      assert.match(short.text, /\b11\b/);
      const shortLayout = await observed(short);
      assert.equal(shortLayout.paragraphs.length, 1);
      assert.deepEqual(shortLayout.headings, []);
      assert.deepEqual(shortLayout.items, []);
      assert(short.text.length <= 50, short.text);

      await askInChat(taskId, diagnosis);
      const analysis = await lastDirect();
      const diagnosisLayout = await observed(analysis);
      assert.match(diagnosisLayout.paragraphs[0], /单号/);
      assert(diagnosisLayout.headings.some(text => /原因|为什么|卡/.test(text)), analysis.text);
      assert(diagnosisLayout.headings.some(text => /怎么|解决|处理|下一步/.test(text)), analysis.text);
      await screenshot("dots-diagnosis-structured");

      await askInChat(taskId, status);
      const progress = await lastDirect();
      const statusLayout = await observed(progress);
      const statusEntries = [...statusLayout.items, ...statusLayout.rows];
      for (const name of ["甲", "乙", "丙"]) assert(statusEntries.some(item => item.startsWith(name)), progress.text);
      report.actualControlChecks.push({ short: short.text, diagnosis: analysis.text, status: progress.text });
    }

    await send("worker-read-three-checks", checkTask);
    const delivery = await readDelivery("worker-read-three-checks");
    const workerLayout = await observed(delivery);
    for (const word of ["启动", "导入", "导出", "权限"]) assert(delivery.text.includes(word), delivery.text);
    assert(delivery.text.length <= 120, delivery.text);
    assert(workerLayout.paragraphs.length > 1 || workerLayout.items.length > 1 || workerLayout.rows.length > 1, delivery.text);
    assert(requests.some(request => request.messages.some(message => message.role === "tool"
      && JSON.stringify(message.content).includes("目标目录无写权限"))), "the ordinary task read the test file");
    await screenshot("dots-real-worker-delivery");
    const requestCount = requests.length;
    const jobs = (await api("dots.list")).map(job => job.id);
    await press("document.querySelector('textarea.input-textarea')", "chat input for new conversation");
    await rpc("Input.insertText", { text: "/new" });
    await press('document.querySelector(\'button[title="发送 (Enter)"]\')', "start a fresh Dots conversation");
    await until(async () => (await history()).length === 0, "empty conversation for independent recall");
    const originalLink = "mybuddy://task/" + delivery.dotsDelivery.taskId;
    await askInChat(taskId, liveRecallQuestion + " [原任务](" + originalLink + ")");
    const recalled = await lastDirect();
    assert.match(recalled.text, /导出/);
    assert(recalled.text.includes(originalLink), recalled.text);
    assert(recalled.text.length <= 340, recalled.text);
    assert((await observed(recalled)).paragraphs.length > 0, recalled.text);
    assert(requests.slice(requestCount).some(request => request.messages.some(message => message.role === "tool"
      && JSON.stringify(message.content).includes(delivery.dotsDelivery.taskId)
      && JSON.stringify(message.content).includes("目标目录无写权限"))), "the model recalled the completed result from the app");
    await screenshot("dots-recalled-delivery");

    await askInChat(taskId, "把这项委派交付时的原文带回来，给我原任务入口。");
    const original = await lastDirect();
    const originalLayout = await observed(original);
    assert(originalLayout.headings.some(heading => heading.includes("原文")), original.text);
    assert(original.text.includes(originalLink), original.text);
    const visibleOriginal = await evaluate(selector(original.id) + ".querySelector('.assistant-card').textContent");
    for (const line of new Set(workerLayout.paragraphs)) assert(visibleOriginal.includes(line), original.text);
    assert.deepEqual((await api("dots.list")).map(job => job.id), jobs, "recall does not repeat the worker");
    await screenshot("dots-recalled-original");
    report.actualControlChecks.push({ worker: delivery.text, workerLayout, recall: recalled.text, original: original.text,
      originalConversationDeliveryCount: 1 });
    return;
  }

  await askInChat(taskId, denseQuestion);
  const direct = await lastDirect();
  assert.equal(direct.text, denseText, "direct history preserves the original body");
  const directLayout = await observed(direct);
  assert(directLayout.paragraphs.length > 1, JSON.stringify(directLayout));
  assert.equal(directLayout.paragraphs.join(""), denseText);
  const gaps = await paragraphGaps(direct.id);
  assert(gaps.every(gap => gap >= 8), "paragraphs need visible separation, got " + gaps.join(", "));
  await screenshot("dots-dense-history");

  await askInChat(taskId, literalQuestion);
  const literal = await lastDirect();
  assert.deepEqual((await observed(literal)).paragraphs, [denseText]);

  await send("legacy-result-only", legacyTask);
  const legacy = await readDelivery("legacy-result-only");
  assert.equal(legacy.text, denseText);
  const legacyLayout = await observed(legacy);
  assert.deepEqual(legacyLayout, directLayout);

  await send("explicit-json", exactTask);
  const exact = await readDelivery("explicit-json");
  assert.equal(exact.text, exactJson);
  assert.equal((await observed(exact)).exactJson, exactJson);

  await send("file-only", fileTask);
  const file = await readDelivery("file-only");
  assert.equal(file.text, "");
  assert.deepEqual((await observed(file)).paragraphs, []);
  assert.deepEqual(file.dotsDelivery.artifacts.map(artifact => artifact.name), ["layout-proof.txt"]);
  await press(selector(file.id) + "?.querySelector('.artifact-chip-main')", "open the only delivered file");
  await until(() => evaluate("document.querySelector('.bot-work-file-preview-body')?.textContent.includes("
    + JSON.stringify(fileProof) + ")"), "file preview shows the saved result");

  await Promise.all(Array.from({ length: 40 }, (_, index) => api("db.upsertTask", {
    id: `sidebar-scroll-task-${index}`, title: `独立验收任务 ${index + 1}`, updatedAt: Date.now(),
  })));
  await restart();
  await open();
  assert.equal((await readDelivery("legacy-result-only")).id, legacy.id);
  assert.deepEqual(await observed(legacy), legacyLayout);
  assert.equal((await observed(exact)).exactJson, exactJson);
  await askInChat(taskId, recallQuestion);
  const recalled = await lastDirect();
  const recallLayout = await observed(recalled);
  assert.deepEqual(recallLayout.headings, ["原任务原文"]);
  const quoted = await evaluate("Array.from(" + selector(recalled.id) + ".querySelectorAll('blockquote p'), node => node.textContent.trim())");
  assert(quoted.length > 1, JSON.stringify(recallLayout));
  assert.equal(quoted.join(""), denseText, "reflow preserves the text of the recalled quotation");
  assert(recalled.text.includes("> " + denseText), "stored recalled quote keeps its original wording");
  const quoteGaps = (await paragraphGaps(recalled.id)).slice(0, quoted.length - 1);
  assert(quoteGaps.every(gap => gap >= 8), "quoted paragraphs need visible separation, got " + quoteGaps.join(", "));
  assert.equal(await evaluate("getComputedStyle(" + selector(recalled.id) + ".querySelector('blockquote')).fontStyle"), "normal");
  await screenshot("dots-recalled-original");
  assert.equal(await evaluate("document.querySelector('.sidebar-scroll button[aria-label=展开客户交付]')?.getAttribute('aria-expanded')"), "false");
  await click("收起模块列表", "#desktop-module-list");
  await until(() => evaluate("document.querySelector('#desktop-module-list').hidden"), "sidebar closed before navigating");
  await press(selector(recalled.id) + "?.querySelector('a[href^=\"mybuddy://task/\"]')", "open recalled task link");
  await until(() => evaluate(`(() => {
    const list = document.querySelector(".sidebar-scroll");
    const row = list.querySelector(".task-item.active");
    if (row?.querySelector(".task-item-title")?.textContent !== "交接核对报告") return false;
    const viewport = list.getBoundingClientRect(), target = row.getBoundingClientRect();
    return list.querySelector('button[aria-label="收起客户交付"]')?.getAttribute("aria-expanded") === "true"
      && list.querySelector('button[aria-label="收起排版验收"]')?.getAttribute("aria-expanded") === "true"
      && list.scrollTop > 0 && target.top >= viewport.top && target.bottom <= viewport.bottom;
  })()`), "both workspace levels open and the selected task row is visible");
  report.actualControlChecks.push({ originalBodyCharacters: denseText.length, directLayout, legacyLayout, gaps,
    literalParagraphs: 1, exactJson, fileOnly: fileProof, sameDeliveryAfterRestart: true, originalQuoteParagraphs: quoted, quoteGaps,
    originalTaskRevealedInSidebar: true });
}, {
  name: recallOnly ? "dots-reply-layout-recall-live" : liveModel ? "dots-reply-layout-live" : "dots-reply-layout-desktop",
  liveModel,
  ...(liveModel ? {} : { fixtureModel }),
  watchRenderer: false,
  isolatedDependencyCache: true,
});
