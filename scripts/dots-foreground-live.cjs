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
    text: "在「灯塔登记演练」空间先由 Dots 前台打开 west.txt 作定位，再核对 west.txt 和 east.txt 全部编号的数量，最终回我一个总数。请先读取，不要主动派工。达到系统前台上限时允许它自动交给该空间内的普通任务继续读和核算。" });
  assert(initial.receipt);
  const readHandoff = () => {
    const ledger = join(home, ".mybuddy", "durable", createHash("sha256").update(dots).digest("hex"), "durable.sqlite");
    const db = new DatabaseSync(ledger, { readOnly: true });
    try {
      for (const row of db.prepare(`SELECT record FROM entries WHERE json_extract(record,'$.kind')='pi.tool-result' ORDER BY id`).all()) {
        const result = JSON.parse(row.record).model?.[0];
        if (result?.toolName !== "dots_action") continue;
        const value = result.content?.find(part => part.type === "text")?.text;
        if (!value) continue;
        try {
          const parsed = JSON.parse(value);
          if (parsed.foreground === "delegated") return parsed;
        } catch { /* Other tool results are outside this assertion. */ }
      }
    } finally { db.close(); }
  };
  let handoff;
  await until(() => {
    handoff = readHandoff();
    return Boolean(handoff?.handoff?.receipt);
  }, "service-owned automatic handoff with actual task and operation receipt");
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
  report.foregroundHandoff = { clock, receipt: native, job, providerCalls: {
    foreground: foreground.length, ordinary: ordinary.length, total: requests.length,
  }, deliveries: delivered.map(message => ({ kind: message.dotsDelivery.kind, id: message.dotsDelivery.deliveryKey,
    at: message.createdAt, text: message.text })) };
  assert(job.activity?.lastActivityAt);
  assert.equal(new Set(delivered.map(message => message.dotsDelivery.deliveryKey)).size, delivered.length);
  assert(delivered.some(message => message.dotsDelivery.kind === "conclusion" && message.text.trim() === "213"),
    "worker did not provide a validated conclusion");
}, { name: "dots-foreground-live", liveModel: true, isolatedDependencyCache: true, watchRenderer: false,
  settings: { permissionMode: "auto", notificationPreferences: { desktopEnabled: false } }, rpcTimeoutMs: 150_000 });
