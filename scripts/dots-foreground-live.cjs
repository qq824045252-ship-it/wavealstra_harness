const assert = require("node:assert/strict");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { run } = require("./desktop-dev-harness.cjs");

run(async ({ evaluate, until, home, out, report }) => {
  const workspace = join(home, "灯塔登记演练");
  mkdirSync(workspace);
  const code = process.argv.includes("--code-diagnosis-live");
  const files = {
    "convert.cjs": "exports.cents = value => Math.round(value * 100);",
    "invoice.cjs": "const {cents} = require('./convert.cjs'); exports.invoice = value => cents(value) * 100;",
    "invoice.test.cjs": "const test=require('node:test'); const assert=require('node:assert/strict'); const {invoice}=require('./invoice.cjs'); test('invoice applies scaling once',()=>assert.equal(invoice(1.25),125));",
  };
  if (code) {
    for (const [file, content] of Object.entries(files)) writeFileSync(join(workspace, file), content + "\n");
  } else {
    const westEntries = [...Array.from({ length: 26 }, (_, index) => `W${index + 1} 5`), "B34 43"].join("\n");
    writeFileSync(join(workspace, "west.txt"), `西侧台账\n${westEntries}\n`);
    writeFileSync(join(workspace, "east.txt"), "东侧台账\nC55 29\nD40 11\n");
  }
  const api = (name, ...args) => evaluate("window.api." + name + "(" + args.map(arg => JSON.stringify(arg)).join(",") + ")");
  await api("db.upsertSpace", { id: "sp-lighthouse-fixture", name: "灯塔登记演练", path: workspace });
  const { id: dots } = await api("dots.open");
  const fallback = (await api("answerRouting.list")).find(rule => rule.id === "dots-default-policy");
  assert.equal(fallback.policy.routeMode, "auto");
  assert.deepEqual(fallback.policy.trackingPolicy, { milestones: true, heartbeatMs: null, silenceMs: 120_000 });
  if (!code) {
    // Exercise the fallback without putting the internal limits in the user's request.
    await api("answerRouting.save", { ...fallback, policy: { ...fallback.policy,
      foregroundReadLimits: { characters: 150, calls: 4, sources: 4 },
    } }, fallback);
  }
  const source = "lighthouse-accounting";
  const clock = {};
  report.foregroundHandoff = { clock };
  if (code) {
    const rule = await api("answerRouting.save", {
      title: "开票金额说明", include: ["开票金额"], exclude: [],
      instruction: "先说清原因，再给出实际验证结果。", enabled: true,
      evidenceFile: "", projectId: null, sourceMemoryId: null,
    });
    const directSource = "lighthouse-explanation";
    const direct = await api("agent.prompt", { taskId: dots, userMessageId: directSource, assistantMessageId: "lighthouse-explanation-reply",
      text: "帮我在这条对话里看看「灯塔登记演练」里 invoice.cjs 的开票金额为什么会多算。先别改文件，也别开新任务。" });
    assert(direct.receipt);
    assert.equal((await api("agent.waitForSubmission", direct.receipt)).receipt?.status, "done");
    const directReceipt = (await api("answerRouting.history", { taskId: dots, inputId: directSource }))[0];
    assert.equal(directReceipt?.ruleId, rule.id);
    assert.deepEqual(directReceipt.policy, fallback.policy);
    assert.deepEqual(await api("dots.list", [directSource]), []);
    assert.match(readFileSync(join(workspace, "invoice.cjs"), "utf8"), /\* 100/);
    const directHistory = (await api("agent.loadTaskHistory", dots)).messages;
    const directInput = directHistory.find(row => row.inputRequestId === directSource);
    const explanation = directHistory.find(row => row.role === "assistant" && directInput && Number(row.entryId) > Number(directInput.entryId)
      && /convert\.cjs/.test(row.text) && /100/.test(row.text));
    report.directOverride = { ruleId: rule.id, receipt: directReceipt, explanation: explanation?.text };
    assert(explanation, "the in-chat response explains the extra factor of 100 using the conversion code");
  }
  clock.inputAt = Date.now();
  const initial = await api("agent.prompt", { taskId: dots, userMessageId: source, assistantMessageId: "lighthouse-reply",
    text: code ? "「灯塔登记演练」里的开票金额算错了。帮我找出原因，修好后跑一下相关测试，告诉我结果。"
      : "麻烦把「灯塔登记演练」这笔对账做完，东、西两份台账都要核对。最后只告诉我合计是多少。" });
  assert(initial.receipt);
  const readHandoff = operations => {
    const ledger = join(home, ".mybuddy", "durable", createHash("sha256").update(dots).digest("hex"), "durable.sqlite");
    const db = new DatabaseSync(ledger, { readOnly: true, timeout: 1_000 });
    try {
      for (const row of db.prepare(`SELECT record FROM entries WHERE json_extract(record,'$.kind')='pi.tool-result' ORDER BY id`).all()) {
        const result = JSON.parse(row.record).model?.[0];
        if (result?.toolName !== "dots_action") continue;
        const value = result.content?.find(part => part.type === "text")?.text;
        if (!value) continue;
        try {
          const parsed = JSON.parse(value);
          const receipt = parsed.handoff?.receipt ?? parsed.receipt;
          if (receipt && operations.has(receipt.operationId)) return { mode: parsed.foreground ?? "delegate", receipt };
        } catch { /* Other tool results are outside this assertion. */ }
      }
    } finally { db.close(); }
  };
  let handoff;
  await until(async () => {
    const jobs = await api("dots.list", [source]);
    if (!jobs.length) return false;
    try { handoff = readHandoff(new Set(jobs.map(job => job.id))); }
    catch (error) { if (error.errcode === 5 || error.errcode === 6) return false; throw error; }
    return Boolean(handoff);
  }, "a natural request admits exactly one ordinary task");
  report.foregroundHandoff.firstUseful = handoff;
  if (!code) assert.equal(handoff.mode, "delegated", "the internal foreground limit triggered the handoff");
  clock.handoffAt = Date.now();
  const native = handoff.receipt;
  const applied = (await api("answerRouting.history", { taskId: dots, inputId: source }))[0];
  if (code) {
    assert.equal(applied?.ruleId, report.directOverride.ruleId);
    assert.deepEqual(applied.policy, fallback.policy);
  }
  report.foregroundHandoff.applied = applied;
  assert(native.taskId && native.operationId && Number.isSafeInteger(native.submissionId));
  report.foregroundHandoff.receipt = native;
  assert.equal((await api("agent.waitForSubmission", initial.receipt)).receipt?.status, "done");
  clock.frontReleasedAt = Date.now();
  const next = await api("agent.prompt", { taskId: dots, userMessageId: "lighthouse-independent-question",
    assistantMessageId: "lighthouse-independent-answer", text: "对了，3 加 4 等于几？" });
  assert(next.receipt);
  clock.nextAdmittedAt = Date.now();
  assert.equal((await api("agent.waitForSubmission", next.receipt)).receipt?.status, "done");
  clock.nextDoneAt = Date.now();
  const nextHistory = (await api("agent.loadTaskHistory", dots)).messages;
  if (!code) {
    const link = `mybuddy://task/${native.taskId}`;
    const receiptText = nextHistory.find(row => row.role === "assistant" && row.text.includes(link))?.text;
    assert(receiptText?.includes("结果会回到这里"));
    assert(!/读取上限|字符数|读取额度/.test(receiptText), "the intake reply keeps the read limit internal");
    report.foregroundHandoff.intakeReply = receiptText;
  }
  const nextInput = nextHistory.find(row => row.inputRequestId === "lighthouse-independent-question");
  assert(nextInput && nextHistory.some(row => row.role === "assistant" && !row.dotsDelivery
    && Number(row.entryId) > Number(nextInput.entryId) && /7|七/.test(row.text)), "the independent question gets a direct answer");
  assert.deepEqual(await api("dots.list", ["lighthouse-independent-question"]), []);
  let job, delivered;
  await until(async () => {
    const jobs = await api("dots.list", [source]);
    if (jobs[0]?.activity?.lastActivityAt && !clock.activityObservedAt) clock.activityObservedAt = Date.now();
    if (jobs.length) {
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].id, native.operationId);
      assert.equal(jobs[0].taskId, native.taskId);
      job = jobs[0];
    }
    const history = await api("agent.loadTaskHistory", dots);
    delivered = history.messages.filter(message => message.dotsDelivery?.operationId === native.operationId);
    return delivered.some(message => ["conclusion", "question"].includes(message.dotsDelivery.kind));
  }, "ordinary worker terminal delivery or explicit validation failure");
  clock.terminalObservedAt = Date.now();
  const requests = readFileSync(join(out, "provider-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).body);
  const foreground = requests.filter(request => request.tools?.some(tool => tool.function.name === "dots_action"));
  const ordinary = requests.filter(request => request.tools?.some(tool => tool.function.name === "read"));
  report.foregroundHandoff = { ...report.foregroundHandoff, clock, receipt: native, firstUseful: handoff, job, providerCalls: {
    foreground: foreground.length, ordinary: ordinary.length, total: requests.length,
  }, deliveries: delivered.map(message => ({ kind: message.dotsDelivery.kind, id: message.dotsDelivery.deliveryKey,
    at: message.createdAt, text: message.text })) };
  assert(job.activity?.lastActivityAt);
  assert.equal(new Set(delivered.map(message => message.dotsDelivery.deliveryKey)).size, delivered.length);
  if (code) {
    const ledger = join(home, ".mybuddy", "durable", createHash("sha256").update(native.taskId).digest("hex"), "durable.sqlite");
    const store = new DatabaseSync(ledger, { readOnly: true, timeout: 1_000 });
    try {
      const records = store.prepare("SELECT record FROM entries ORDER BY id").all().map(row => JSON.parse(row.record));
      const calls = records.flatMap(row => row.model ?? []).filter(message => message.role === "assistant")
        .flatMap(message => message.content ?? []).filter(part => part.type === "toolCall");
      const results = records.flatMap(row => row.model ?? []).filter(message => message.role === "toolResult");
      for (const file of ["invoice.cjs", "convert.cjs"]) {
        const evidence = results.find(result => result.content?.some(part => part.text?.includes(files[file])));
        assert(evidence, "native tool returned the source of " + file);
      }
      const testCalls = calls.filter(call => ["bash", "powershell"].includes(call.name) && /node\s+--test(?:\s|$)/.test(call.arguments?.command));
      const result = results.find(result => testCalls.some(call => call.id === result.toolCallId) && !result.isError &&
        /(?:#|ℹ) pass 1/.test(JSON.stringify(result.content)) && /(?:#|ℹ) fail 0/.test(JSON.stringify(result.content)));
      assert(result, "native receipt for successful fixture test");
      const test = testCalls.find(call => call.id === result.toolCallId);
      report.foregroundHandoff.test = { command: test.arguments.command, output: result.content, calls: calls.map(call => call.name) };
      assert.notEqual(readFileSync(join(workspace, "invoice.cjs"), "utf8").trim(), files["invoice.cjs"]);
    } finally { store.close(); }
  }
  const finals = delivered.filter(message => message.dotsDelivery.kind === "conclusion");
  assert.equal(finals.length, 1, "one validated conclusion in the original conversation");
  if (code) assert.match(finals[0].text, /125/);
  else assert.match(finals[0].text.trim(), /^(?:合计\s*[：:]?\s*)?213[。]?$/, "only the total is delivered, with no breakdown");
  assert(delivered.filter(message => message.dotsDelivery.kind === "progress")
    .every(message => !/最近观察到工具|未观察到新的工具活动/.test(message.text)), "no routine heartbeat with the default policy");
}, { name: process.argv.includes("--code-diagnosis-live") ? "dots-code-diagnosis-live" : "dots-foreground-live", liveModel: true, isolatedDependencyCache: true, watchRenderer: false,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } }, rpcTimeoutMs: 150_000 });
