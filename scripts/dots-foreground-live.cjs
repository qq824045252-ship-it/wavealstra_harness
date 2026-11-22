const assert = require("node:assert/strict");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { run } = require("./desktop-dev-harness.cjs");

run(async ({ evaluate, until, home, out, report }) => {
  const workspace = join(home, "灯塔登记演练");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "west.txt"), "西侧台账\nA21 130\nB34 43\n");
  writeFileSync(join(workspace, "east.txt"), "东侧台账\nC55 29\nD40 11\n");
  const code = process.argv.includes("--code-diagnosis-live");
  if (code) {
    writeFileSync(join(workspace, "convert.cjs"), "exports.cents = value => Math.round(value * 100);\n");
    writeFileSync(join(workspace, "invoice.cjs"), "const {cents} = require('./convert.cjs'); exports.invoice = value => cents(value) * 100;\n");
    writeFileSync(join(workspace, "invoice.test.cjs"), "const test=require('node:test'); const assert=require('node:assert/strict'); const {invoice}=require('./invoice.cjs'); test('invoice applies scaling once',()=>assert.equal(invoice(1.25),125));\n");
  }
  const api = (name, ...args) => evaluate("window.api." + name + "(" + args.map(arg => JSON.stringify(arg)).join(",") + ")");
  await api("db.upsertSpace", { id: "sp-lighthouse-fixture", name: "灯塔登记演练", path: workspace });
  const { id: dots } = await api("dots.open");
  const fallback = (await api("answerRouting.list")).find(rule => rule.id === "dots-default-policy");
  await api("answerRouting.save", { ...fallback, policy: { ...fallback.policy,
    foregroundReadLimits: { characters: 12, calls: 1, sources: 2 },
    trackingPolicy: { milestones: true, heartbeatMs: 5_000, silenceMs: 5_000 },
  } }, fallback);
  const source = "lighthouse-accounting";
  const clock = { inputAt: Date.now() };
  report.foregroundHandoff = { clock };
  const initial = await api("agent.prompt", { taskId: dots, userMessageId: source, assistantMessageId: "lighthouse-reply",
    text: code ? "诊断 sp-lighthouse-fixture 内 invoice.cjs 的金额错误。前台首次用 dots_action.read_file 读 invoice.cjs，spaceId 为 sp-lighthouse-fixture，allowHandoff 为 true；不要主动委派，达到上限让系统自动移交。普通任务须实际读取 invoice.cjs 与 convert.cjs，修复错误并实际运行 node --test invoice.test.cjs。只有测试通过才在标准交付封套中返回结果，结果正文只用 DUPLICATE_SCALING_FIXED。" : "在「灯塔登记演练」空间先由 Dots 前台打开 west.txt 作定位，再核对 west.txt 和 east.txt 全部编号的数量，最终回到 Dots 的内容只能是表示总数的阿拉伯数字，不要标点、解释、过程或附件。请不要列目录或主动派工。第一次用 dots_action 的 read_file 打开 west.txt，spaceId 用 sp-lighthouse-fixture。达到系统前台上限时，我明确允许自动移交给该空间的普通任务继续核算，所以本次读取的 allowHandoff 请填 true。" });
  assert(initial.receipt);
  const readHandoff = () => {
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
          if (["delegated", "limit", "blocked"].includes(parsed.foreground)) return parsed;
        } catch { /* Other tool results are outside this assertion. */ }
      }
    } finally { db.close(); }
  };
  let handoff;
  await until(() => {
    try { handoff = readHandoff(); }
    catch (error) { if (error.errcode === 5 || error.errcode === 6) return false; throw error; }
    return Boolean(handoff);
  }, "service-owned automatic handoff with actual task and operation receipt");
  report.foregroundHandoff.firstUseful = handoff;
  assert.equal(handoff.foreground, "delegated", handoff.message);
  clock.handoffAt = Date.now();
  const native = handoff.handoff.receipt;
  assert(native.taskId && native.operationId && Number.isSafeInteger(native.submissionId));
  report.foregroundHandoff.receipt = native;
  assert.equal((await api("agent.waitForSubmission", initial.receipt)).receipt?.status, "done");
  clock.frontReleasedAt = Date.now();
  const next = await api("agent.prompt", { taskId: dots, userMessageId: "lighthouse-independent-question",
    assistantMessageId: "lighthouse-independent-answer", text: "独立的短问题，3 加 4 等于几？只回答数字。" });
  assert(next.receipt);
  clock.nextAdmittedAt = Date.now();
  assert.equal((await api("agent.waitForSubmission", next.receipt)).receipt?.status, "done");
  clock.nextDoneAt = Date.now();
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
  report.foregroundHandoff = { clock, receipt: native, firstUseful: handoff, job, providerCalls: {
    foreground: foreground.length, ordinary: ordinary.length, total: requests.length,
  }, deliveries: delivered.map(message => ({ kind: message.dotsDelivery.kind, id: message.dotsDelivery.deliveryKey,
    at: message.createdAt, text: message.text })) };
  assert(job.activity?.lastActivityAt);
  assert.equal(new Set(delivered.map(message => message.dotsDelivery.deliveryKey)).size, delivered.length);
  if (code) {
    const workerContext = JSON.stringify(ordinary[0]?.messages ?? []);
    assert(workerContext.includes("前台取得的有界文件佐证"));
    assert(workerContext.includes("const {cents"));
    assert(workerContext.includes("invoice.cjs"));
    const ledger = join(home, ".mybuddy", "durable", createHash("sha256").update(native.taskId).digest("hex"), "durable.sqlite");
    const store = new DatabaseSync(ledger, { readOnly: true, timeout: 1_000 });
    try {
      const records = store.prepare("SELECT record FROM entries ORDER BY id").all().map(row => JSON.parse(row.record));
      const calls = records.flatMap(row => row.model ?? []).filter(message => message.role === "assistant")
        .flatMap(message => message.content ?? []).filter(part => part.type === "toolCall");
      const results = records.flatMap(row => row.model ?? []).filter(message => message.role === "toolResult");
      for (const file of ["invoice.cjs", "convert.cjs"]) {
        const read = calls.find(call => call.name === "read" && String(call.arguments?.path).endsWith(file));
        assert(read && results.some(result => result.toolCallId === read.id && !result.isError), "native read of " + file);
      }
      const testCalls = calls.filter(call => call.name === "bash" && /node --test invoice.test.cjs/.test(call.arguments?.command));
      const result = results.find(result => testCalls.some(call => call.id === result.toolCallId) && !result.isError &&
        /(?:#|ℹ) pass 1/.test(JSON.stringify(result.content)) && /(?:#|ℹ) fail 0/.test(JSON.stringify(result.content)));
      assert(result, "native receipt for successful fixture test");
      const test = testCalls.find(call => call.id === result.toolCallId);
      report.foregroundHandoff.test = { command: test.arguments.command, output: result.content, calls: calls.map(call => call.name) };
      assert.match(readFileSync(join(workspace, "invoice.cjs"), "utf8"), /cents\(value\);/);
    } finally { store.close(); }
  }
  assert(delivered.some(message => message.dotsDelivery.kind === "conclusion" && message.text.trim() === (code ? "DUPLICATE_SCALING_FIXED" : "213")),
    "worker did not provide a validated conclusion");
}, { name: process.argv.includes("--code-diagnosis-live") ? "dots-code-diagnosis-live" : "dots-foreground-live", liveModel: true, isolatedDependencyCache: true, watchRenderer: false,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } }, rpcTimeoutMs: 150_000 });
