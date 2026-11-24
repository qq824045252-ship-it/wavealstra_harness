import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { defaultAnswerRuleId, newAnswerRule } from "../src/shared/answer-routing";
import type { AnswerRoutingFlow } from "../src/shared/answer-routing-flow";
import { DotsDelegations } from "../src/main/dots/DotsDelegations";
import type { CronJobDto } from "../src/shared/agent-ipc";

const root = mkdtempSync(join(tmpdir(), "mybuddy-dots-delivery-"));
process.env.USERPROFILE = root;
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy", "plugins", "mcp"), { recursive: true });
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { createArtifactDomain } = await import("../src/main/artifact/ArtifactDomainSetup");
const { DotsActions } = await import("../src/main/dots/DotsActions");
const { CronService } = await import("../src/main/cron/CronService");
const { TerminalHost } = await import("../src/main/terminal/TerminalHost");
const { TaskTerminalService } = await import("../src/main/terminal/TaskTerminalService");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
const db = new AppDatabase(join(root, "app.db"));
const space = db.createSpace({ id: "sp-quotes", name: "客户 A", path: root });
const marker = "a quotation for exactly 137";
let calls = 0;
let releaseWorker!: () => void;
const workerGate = new Promise<void>(resolve => { releaseWorker = resolve; });
const fixture = await createAgentDurableFixture(root, db, async input => {
  const latest = input.messages.at(-1);
  if (latest?.role === "toolResult" && latest.toolCallId.startsWith("draft-")) {
    await workerGate;
    return [{ type: "toolCall", id: "final-" + ++calls, name: "write",
      arguments: { path: "quote.txt", content: marker } }];
  }
  if (latest?.role === "toolResult") return [{ type: "text", text: "已处理" }];
  const tools = getCurrentTools(input.messages);
  if (tools.some(tool => tool.name === "dots_action")) return [{ type: "toolCall", id: "delegate-" + ++calls, name: "dots_action",
    arguments: { action: "delegate", spaceId: space.id, name: "报价", text: "写出报价单" } }];
  if (tools.some(tool => tool.name === "write")) return [{ type: "toolCall", id: "draft-" + ++calls, name: "write",
    arguments: { path: "quote.txt", content: "Draft quotation" } }];
  return [{ type: "text", text: '{"candidates":[]}' }];
});
const { agent } = fixture;
const cron = new CronService(db, agent);
const terminal = new TerminalHost({resolveCwd:()=>root});
agent.setLocalWorkflowServices({cron,terminal:new TaskTerminalService(terminal)});
const domain = createArtifactDomain(db.connection);
agent.setArtifactDomain(domain.service, domain.coordinator);
const deliveries = new DotsDelegations(db.connection, (id, operation) => agent.dotsSubmission(id, operation), () => {});
const actions = new DotsActions(db, agent, { link: (...args) => deliveries.link(...args), changed: () => deliveries.refresh(),
  observeTool: event => deliveries.observeTool(event),
  observeProgress: (...args) => deliveries.observeProgress(...args),
  rememberOrigin: (source, origin) => deliveries.rememberOrigin(source, origin),
  list: () => deliveries.list(), failed: (...args) => deliveries.failed(...args) });
agent.setDotsActions(actions);
deliveries.connect(async () => ({ kind: "quiet" }), (reply, current) => agent.appendDotsReply(reply, current));
const fallback = agent.answerRouting.list().find(rule => rule.id === defaultAnswerRuleId)!;
const quoteRule = agent.answerRouting.save({ ...newAnswerRule(), title: "报价确认", include: ["正式报价"],
  exclude: ["翻译"], instruction: "报价规则测试标记 4C82。" });
const flow: AnswerRoutingFlow = { enabled: true, branches: [
  { id: "delivery", title: "客户报价", checks: [
    { id: "customer", operator: "all", phrases: ["客户 A"] },
    { id: "topic", operator: "any", phrases: ["发票", "报价单"] },
  ], ruleId: quoteRule.id, routeMode: "delegate" },
  { id: "other", title: "普通报价", checks: [{ id: "quote", operator: "all", phrases: ["报价单"] }],
    ruleId: null, routeMode: "direct" },
] };
const policy = { ...fallback.policy!, trackingPolicy: { milestones: true, heartbeatMs: 6_000, silenceMs: 5_000 } };
const promptText = "在客户 A 空间做一份报价单";
const reversed = agent.answerRouting.save({ ...fallback, policy: { ...policy, flow: { ...flow, branches: [...flow.branches].reverse() } } }, fallback);
assert.equal(agent.answerRouting.preview(promptText, null)?.flow?.routeMode, "direct");
assert.throws(() => agent.answerRouting.save({ ...fallback, policy: { ...policy, flow } }, fallback), /已变化/);
assert.throws(() => agent.answerRouting.save({ ...fallback, policy: { ...policy, flow: { ...flow, branches: [flow.branches[0], flow.branches[0]] } } }, reversed), /分支重复/);
const configured = agent.answerRouting.save({ ...fallback, policy: { ...policy, flow } }, reversed);
const preview = agent.answerRouting.preview(promptText, null);
assert.equal(preview?.rule.id, quoteRule.id);
assert.equal(preview.flow?.routeMode, "delegate");
assert.deepEqual(preview.flow?.steps[0]?.checks[1]?.phrases, [{ phrase: "发票", matched: false }, { phrase: "报价单", matched: true }]);
assert.equal(agent.answerRouting.preview("做一份报价单", null)?.flow?.steps[0]?.checks.length, 1);
assert.equal(agent.answerRouting.preview("翻译：在客户 A 空间做一份报价单", null)?.flow?.steps[0]?.outcome, "rule-unavailable");
assert.equal(agent.answerRouting.preview("正式报价", null)?.rule.id, quoteRule.id);
assert.equal(agent.answerRouting.preview("/new", null), null);
const off = agent.onPatch(patch => {
  if (patch.type === "durable_delta" && !patch.delta.state.busy) deliveries.refresh(patch.taskId);
});
try {
  assert.equal(db.openDots().id, DOTS_TASK_ID);
  assert.equal(db.openDots().id, DOTS_TASK_ID);
  assert.equal(db.listTasks().length, 0);
  assert.throws(() => db.moveTaskInWorkspaceTree({ taskId: DOTS_TASK_ID, targetSpaceId: space.id }), /主页/);
  assert.throws(() => db.archiveTask(DOTS_TASK_ID, true), /Dots/);
  assert.throws(() => db.deleteTask(DOTS_TASK_ID), /Dots/);
  assert.equal(db.getTask(DOTS_TASK_ID)?.spaceId ?? null, null);
  await fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: "quote-request", assistantMessageId: "dots-reply", text: promptText });
  const [routed] = agent.answerRouting.history({ taskId: DOTS_TASK_ID, inputId: "quote-request" });
  assert.equal(routed?.ruleId, quoteRule.id);
  assert.equal(routed.policy?.routeMode, "delegate");
  assert.equal(routed.detail, "流程采用「客户报价」");
  const dotsRequest = fixture.requests.find(request => request.tools.includes("dots_action"));
  assert.match(JSON.stringify(dotsRequest?.input.messages), /优先交给普通任务.*报价规则测试标记 4C82/s);
  agent.answerRouting.save({ ...fallback, policy: { ...policy, flow: { ...flow, enabled: false } } }, configured);
  assert.equal(agent.answerRouting.preview(promptText, null)?.rule.id, defaultAnswerRuleId);
  agent.answerRouting.clearPreparedTurns(DOTS_TASK_ID);
  const cwd = db.getTask(DOTS_TASK_ID)?.cwd;
  assert.ok(cwd);
  const retried = await agent.answerRouting.prepare({ taskId: DOTS_TASK_ID, query: promptText, inputId: "quote-request", cwd,
    canRead: () => true });
  assert.equal(retried?.rule.policy?.routeMode, "delegate");
  assert.equal(retried.rule.id, quoteRule.id);
  console.log("PASS 预览与实际 Dots 调度复用判断，串行短路、并行汇合、拖动顺序、关闭回退和快照重试有效");
  const progressReports = async () => (await agent.loadTaskHistory(DOTS_TASK_ID)).messages.filter(message => message.dotsDelivery?.kind === "progress");
  const silent = /工具 write 返回.*未观察到新的工具活动/;
  const observationDeadline = Date.now() + 18_000;
  let reports = await progressReports();
  while (!reports.some(message => silent.test(message.text)) && Date.now() < observationDeadline) {
    await new Promise(done => setTimeout(done, 100));
    reports = await progressReports();
  }
  const reporting = deliveries.list()[0]?.activity;
  assert(reporting?.lastProgressAt);
  assert(reporting.lastReportAt, JSON.stringify(deliveries.list()));
  assert(reporting.lastReportAt >= reporting.lastActivityAt + 5_000);
  assert.match(reports.at(-1)?.text ?? "", silent);
  assert.equal(deliveries.list()[0].activity?.lastActivityAt, reporting.lastActivityAt);
  assert.equal(deliveries.list()[0].activity?.lastProgressAt, reporting.lastProgressAt);
  assert.equal(fixture.requests.filter(request => request.tools.includes("dots_action")).length, 2,
    "heartbeat starts no foreground generation");
  console.log("PASS native tool heartbeat with independent progress and receipt clocks", {
    heartbeatMs: 6_000, silenceMs: 5_000,
    activityToReportMs: reporting.lastReportAt - reporting.lastActivityAt,
    verifiedProgressToReportMs: reporting.lastReportAt - reporting.lastProgressAt,
    progressMessages: reports.length, extraForegroundModelCalls: 0,
  });
  await actions.execute(DOTS_TASK_ID, "pause-observation", { action: "pause_proactive" });
  const parkDeadline = Date.now() + 10_000;
  const nextObservation = db.connection.prepare(
    "SELECT next_at FROM dots_tool_observations WHERE operation_id=?"
  ).pluck();
  const observedOperation = deliveries.list()[0].id;
  while (nextObservation.get(observedOperation) !== null && Date.now() < parkDeadline)
    await new Promise(done => setTimeout(done, 25));
  assert.equal(nextObservation.get(observedOperation), null);
  assert.equal((await progressReports()).length, reports.length);
  await actions.execute(DOTS_TASK_ID, "resume-observation", { action: "resume_proactive" });
  assert.equal(typeof nextObservation.get(observedOperation), "number");
  releaseWorker();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && deliveries.list()[0]?.status !== "completed") {
    deliveries.refresh();
    await deliveries.drain();
    await new Promise(done => setTimeout(done, 40));
  }
  const [job] = deliveries.list();
  assert.ok(job, "Dots really invoked the delegate tool: " + fixture.requests.map(r => r.tools.join(",")).join(" | ").slice(-1600));
  assert.equal(job.sourceMessageId, "quote-request");
  assert.deepEqual(deliveries.list(["quote-request"]), [job]);
  assert.deepEqual(deliveries.list(["unrelated-dots-turn"]), []);
  assert.deepEqual(deliveries.list([]), []);
  assert.equal(db.listTasks().length, 1);
  assert.equal(db.getTask(job.taskId)?.spaceId, space.id);
  assert.equal(job.status, "completed", JSON.stringify(job));
  assert.equal(job.activity?.tool, "write");
  assert.equal(job.activity?.phase, "finish");
  assert.equal(job.activity?.lastReportAt, reporting.lastReportAt);
  assert.equal(job.artifacts.length, 1, JSON.stringify(job));
  const file = domain.service.get(job.artifacts[0]!.id)!;
  assert.equal(file.taskId, job.taskId);
  assert.equal(file.source.type, "workspace-file");
  if (file.source.type === "workspace-file") {
    const path = resolve(file.source.rootDir, file.source.entryFile);
    assert.equal(readFileSync(path, "utf8"), marker);
    writeFileSync(path, "new quotation from a different task");
    assert.equal(readFileSync(job.artifacts[0]!.saved!.snapshotPath, "utf8"), marker);
  }
  assert.ok(fixture.requests.some(r => r.tools.includes("dots_action") && !r.tools.includes("write")));
  assert.ok(fixture.requests.some(r => r.tools.includes("write") && !r.tools.includes("dots_action")));
  const reloaded = new DotsDelegations(db.connection, (id, op) => agent.dotsSubmission(id, op), () => {});
  assert.deepEqual(reloaded.list(), deliveries.list());
  reloaded.close();
  // Process died between recording the job and submitting. Only redo native admission with the same input id.
  const frozen = { taskId: job.taskId, userMessageId: "dots-input-recovery", assistantMessageId: "recovery-answer",
    spaceId: space.id, text: "接上原来的报价", modelId: "fixture/model" };
  deliveries.link(job.taskId, frozen.userMessageId, "after-restart", false, frozen);
  // Releasing the old host while a native read or admission is in flight retires its continuation.
  let releaseRead!: () => void;
  const reading = new Promise<void>(done => { releaseRead = done; });
  const retiringReader = new DotsDelegations(db.connection, async () => { await reading; return undefined; }, () => {});
  let oldAdmissions = 0;
  const priorRead = retiringReader.recover(async () => { oldAdmissions++; return {}; }, () => true);
  retiringReader.close();
  releaseRead();
  await priorRead;
  assert.equal(oldAdmissions, 0);

  let started!: () => void, releaseAdmission!: () => void;
  const submitting = new Promise<void>(done => { started = done; });
  const reply = new Promise<void>(done => { releaseAdmission = done; });
  const retiringSender = new DotsDelegations(db.connection, async () => undefined, () => {});
  const priorSend = retiringSender.recover(async () => {
    started();
    await reply;
    return { cancelled: true };
  }, () => true);
  await submitting;
  retiringSender.close();
  releaseAdmission();
  await priorSend;
  assert.equal(retiringSender.list().find(link => link.id === frozen.userMessageId)?.status, "pending");
  let canInspect = false;
  let unavailableReads = 0;
  let announceThirdRead!: () => void;
  const thirdRead = new Promise<void>(resolve => { announceThirdRead = resolve; });
  const restart = new DotsDelegations(db.connection, (id, op) => agent.dotsSubmission(id, op), () => {});
  const confirmAdmission = async (id: string, op: string) => {
    if (op === frozen.userMessageId && !canInspect) {
      if (++unavailableReads === 3) announceThirdRead();
      throw Error("temporary receipt read failure");
    }
    return Boolean((await agent.findSubmission(id, op))?.receipt);
  };
  let admissions = 0;
  await restart.recover(async request => {
    admissions++;
    assert.deepEqual(request, frozen);
    const submitted = await agent.prompt(request);
    assert.ok(submitted.receipt);
    throw Error("admission completed before transport disconnected");
  }, () => true, confirmAdmission);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([thirdRead, new Promise<void>((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error("recovery stopped checking")), 5000);
    })]);
  } finally { clearTimeout(deadlineTimer); }
  assert.equal(admissions, 0);
  const uncertain = restart.list().find(link => link.id === frozen.userMessageId);
  assert.equal(uncertain?.status, "pending");
  assert.match(uncertain.text, /继续核对/);
  canInspect = true;
  for (let i=0; i<200 && restart.list().find(row => row.id === frozen.userMessageId)?.status !== "completed"; i++) {
    await new Promise(done => setTimeout(done, 35));
  }
  const recovered = await agent.findSubmission(job.taskId, frozen.userMessageId);
  assert.ok(recovered?.receipt);
  await agent.waitForSubmission(recovered.receipt);
  restart.refresh(); await restart.drain();
  assert.equal(restart.list().find(link => link.id === frozen.userMessageId)?.status, "completed");
  assert.equal(admissions, 1);
  restart.close();
  await restart.drain();

  // An older native completion can arrive after a replacement. It must never win the next read.
  const race = new DotsDelegations(db.connection, async (_id, op) => op === "new-quote"
    ? { status: "blocked", interactionId: "exact-question", text: "用哪种货币？", artifacts: [] }
    : { status: "completed", text: "旧报价", artifacts: [] }, () => {});
  race.link(job.taskId, "prior-quote", "older");
  race.link(job.taskId, "new-quote", "newer", true);
  race.refresh(job.taskId); await race.drain();
  assert.equal(race.list().find(row => row.id === "prior-quote")?.status, "superseded");
  assert.equal(race.list().find(row => row.id === "new-quote")?.interactionId, "exact-question");
  race.close();
  const library = agent.dotsLibrary();
  const notes = library.ensureOwnedSpace({ type: "workspace", workspaceId: space.id });
  const note = library.createItem({ spaceId: notes.id, kind: "markdown", title: "报价约定", content: "报价有效七天" });
  const readNote = (scope: { spaceId?: string; targetTaskId?: string }, version?: number) =>
    actions.execute(DOTS_TASK_ID, undefined, { action: "read_material", itemId: note.id, ...scope, version });
  const search = await actions.execute(DOTS_TASK_ID, undefined, { action: "materials", spaceId: space.id, query: "报价约定" });
  assert.ok(search && "items" in search && search.items?.some(item => item.id === note.id));
  library.updateTextContent({ id: note.id, content: "报价有效十天" });
  const latest = await readNote({ spaceId: space.id });
  assert.ok(latest && "text" in latest && latest.text === "报价有效十天" && "versions" in latest);
  const version = latest.versions?.[0]?.version;
  assert.ok(version);
  const earlier = await readNote({ spaceId: space.id }, version);
  assert.ok(earlier && "text" in earlier && earlier.text === "报价有效七天");
  const otherSpace = db.createSpace({ id: "sp-other", name: "客户 B" });
  await assert.rejects(() => readNote({ spaceId: otherSpace.id }, version), /范围/);
  library.attachToTask({ taskId: DOTS_TASK_ID, itemId: note.id });
  await readNote({}, version);
  library.detachFromTask({ taskId: DOTS_TASK_ID, itemId: note.id });
  await assert.rejects(() => readNote({}, version), /范围/);
  library.deleteItem(note.id);
  await assert.rejects(() => readNote({ spaceId: space.id }, version), /范围/);
  console.log("PASS Dots scoped material lookup, latest and pinned read, revoked and deleted material");
  db.transaction(() => {
    for (let index = 0; index < 1000; index++) {
      const id = "quote-board-" + index.toString().padStart(4, "0");
      db.upsertTask({ id, title: id, spaceId: space.id, updatedAt: Date.now() });
    }
  });
  const timings: number[] = [];
  for (let sample = 0; sample < 60; sample++) {
    const id = "quote-board-" + ((sample * 23) % 1000).toString().padStart(4, "0");
    const start = performance.now();
    const page = await actions.execute(DOTS_TASK_ID, undefined, { action: "board", spaceId: space.id, query: id });
    assert.ok(page && "tasks" in page && page.tasks?.some(task => task.id === id), "Dots found the exact task");
    timings.push(performance.now() - start);
  }
  const p95 = timings.sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1]!;
  console.log(`Dots local board query: 1,000 tasks, 60 queries, p95 ${p95.toFixed(1)} ms on ${cpus()[0]?.model}`);
  assert.ok(p95 < 1000, "local task lookup p95 should stay below one second");
  // The host was offline for three intervals. Replay only one live native input.
  const now = Date.now();
  const recurring: CronJobDto = { id: "dots-missed", name: "到期报价", prompt: "跟进上次报价", scheduleType: "every",
    scheduleExpr: "1h", timezone: "UTC", cwd: root, enabled: true, maxRuns: 1,
    sourceTaskId: DOTS_TASK_ID, target: { kind: "task", taskId: DOTS_TASK_ID }, missedRuns: "coalesce",
    createdAt: now - 3 * 3600000, updatedAt: now - 3 * 3600000 };
  db.upsertCronJob(recurring);
  db.upsertCronJob({ ...recurring, id: "skip-stale", missedRuns: "skip" });
  db.upsertCronJob({ ...recurring, id: "past-deadline", effectiveTo: now - 60000 });
  cron.start();
  const until = Date.now() + 20000;
  while (Date.now() < until && !db.listCronJobRuns(recurring.id, 1).some(run => run.status === "success")) {
    await new Promise(done => setTimeout(done, 30));
  }
  assert.equal(db.listCronJobRuns(recurring.id, 2).length, 1);
  assert.equal(db.listCronJobRuns(recurring.id, 1)[0]?.status, "success");
  assert.equal(db.listCronJobRuns("skip-stale", 1).length, 0);
  assert.equal(db.listCronJobRuns("past-deadline", 1).length, 0);
  cron.stop(); cron.start();
  assert.equal(db.listCronJobRuns(recurring.id, 2).length, 1);
  cron.suspendDotsTimers();
  const wakeTime = Date.now() + 160;
  for (const policy of ["coalesce", "skip"] as const) {
    cron.createForTask(DOTS_TASK_ID, root, { name: policy, prompt: "刷新报价", scheduleType: "at",
      scheduleExpr: new Date(wakeTime).toISOString(), timezone: "UTC", target: "current-task", missedRuns: policy }, policy);
  }
  await new Promise(done => setTimeout(done, 210));
  assert.equal(db.listCronJobRuns("cron-request-coalesce", 1).length, 0);
  cron.resumeDotsTimers();
  const wakeDeadline = Date.now() + 20000;
  while (Date.now() < wakeDeadline && db.listCronJobRuns("cron-request-coalesce", 1)[0]?.status !== "success")
    await new Promise(done => setTimeout(done, 30));
  assert.equal(db.listCronJobRuns("cron-request-coalesce", 1)[0]?.status, "success");
  assert.equal(db.listCronJobRuns("cron-request-skip", 1).length, 0);
  console.log("PASS missed Dots timer coalesces native execution and respects skip, deadline and restart");
  console.log("PASS Dots native chat → native delegate → ordinary task → real file → persisted Dots delivery");
} finally {
  releaseWorker();
  cron.stop(); terminal.dispose(); off(); deliveries.close(); await deliveries.drain(); await fixture.close(); db.close();
}

await (await import("./dots-foreground-scenario")).verifyForegroundScheduling(join(root, "foreground"));
