import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { z } from "zod";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import { WorkCompletionCoordinator, type WorkCompletionOptions } from "../src/main/agent/work/WorkCompletionCoordinator";
import { completionEvidence, completionFingerprint } from "../src/main/agent/work/WorkCompletionEvidence";
import { WorkResultLifecycleError } from "../src/main/agent/work/WorkResultLifecycleError";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";
import type { WorkResultDecision } from "../src/main/agent/work/WorkResultDecision";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";

const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const complete = (): WorkResultDecision => ({ decision: "deliver", outcome: "completed", reply: "已完成全部要求。", missing: [] });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const turnSchema = z.object({ context_json: z.string(), decision_json: z.string().nullable(), state: z.string(), attempts: z.number(), error: z.string().nullable() });

if (process.argv[2] === "--crash-apply") {
  const db = new AppDatabase(z.string().parse(process.argv[3]));
  const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(db.connection, { bots });
  const coordinator = new WorkCompletionCoordinator({ db: db.connection, works, isAuthority: () => true, wake: () => {},
    review: async () => complete(), deliver: input => {
      if (input.category === "progress") return true;
      const row = turnSchema.parse(db.connection.prepare("SELECT * FROM work_completion_turns WHERE binding_id=?").get(input.bindingId));
      assert(row.decision_json); writeSync(1, "review-committed-before-delivery\n"); process.kill(process.pid, "SIGKILL"); return false;
    } });
  coordinator.wake(); await flush(); throw Error("crash fixture did not terminate");
}

async function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `completion-${name}-`)), path = join(root, "app.db");
  let db = new AppDatabase(path);
  let authority = true;
  const open = () => {
    const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
    const works = new WorkService(db.connection, { bots, isAuthority: () => authority });
    const feedback = new WorkConversationFeedback({ db: db.connection, works, userId: LOCAL_USER_ID, isAuthority: () => authority });
    return { works, feedback };
  };
  let { works, feedback } = open();
  const coordinators: WorkCompletionCoordinator[] = [];
  const receipt = feedback.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: name, text: name });
  feedback.messages.update(receipt.assistantMessageId, "completed", "已受理");
  const result = works.createWork(user, { operationId: name, title: name, sourceMessageId: receipt.userMessageId,
    conversationId: receipt.conversationId, inputSnapshotId: `input:${receipt.userMessageId}`, authorization: DESKTOP_USER_GRANTS });
  assert(result.ok, JSON.stringify(result));
  const workId = result.work.workId;
  let running = true, submits = 0;
  const receipts = new Map<string, AgentSubmissionReceipt>();
  const port: WorkExecutionPort = {
    prepare: async taskId => ({ taskId, durableStoreKey: taskId, conversationId: "1", workspaceBinding: root }),
    find: async binding => receipts.get(binding.bindingId),
    submit: async binding => { submits++; const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" };
      receipts.set(binding.bindingId, receipt); return receipt; },
    inspect: async () => running ? { status: "running" } : { status: "completed", summary: "真实执行成果", artifactRefs: [], hasWriteConflicts: false },
    stop: async () => {},
  };
  const adapter = new WorkExecutionAdapter(works, port, LOCAL_USER_ID, () => authority, (_id, error) => { throw error; });
  const queue = new WorkDispatchQueue(db, works, adapter, () => authority, () => "fixture");
  works.transaction(() => queue.enqueue(result.work, name));
  await queue.flush();
  const binding = works.repo.listBindings(workId)[0]!;
  assert(binding);
  const finish = async () => { running = false; await queue.flush(); assert(works.automaticCompletion.outcome(binding.bindingId)); };
  const start = (review: WorkCompletionOptions["review"], deliver?: WorkCompletionOptions["deliver"]) => {
    const coordinator = new WorkCompletionCoordinator({ db: db.connection, works, isAuthority: () => authority,
      review, deliver: deliver ?? (input => feedback.deliverCompletion(input)), wake: () => {} });
    coordinators.push(coordinator); return coordinator;
  };
  return { root, workId, binding, finish, start, get db() { return db; }, get works() { return works; }, get feedback() { return feedback; },
    get submits() { return submits; }, setAuthority: (value: boolean) => { authority = value; },
    addCompleted: async (name: string) => {
      const source = feedback.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: name, text: name });
      const created = works.createWork(user, { operationId: name, title: name, sourceMessageId: source.userMessageId,
        conversationId: source.conversationId, inputSnapshotId: `input:${source.userMessageId}`, authorization: DESKTOP_USER_GRANTS });
      assert(created.ok); works.transaction(() => queue.enqueue(created.work, name)); await queue.flush();
      return { workId: created.work.workId, binding: works.repo.listBindings(created.work.workId)[0]! };
    },
    turn: () => turnSchema.parse(db.connection.prepare("SELECT * FROM work_completion_turns WHERE binding_id=?").get(binding.bindingId)),
    retry: () => db.connection.prepare("UPDATE work_completion_turns SET retry_at=0 WHERE binding_id=?").run(binding.bindingId),
    reports: () => feedback.messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: receipt.conversationId }).messages
      .filter(message => message.workFeedback?.report?.completion),
    restart: () => { coordinators.forEach(item => item.close()); feedback.close(); db.close(); db = new AppDatabase(path); ({ works, feedback } = open()); },
    close: () => { coordinators.forEach(item => item.close()); feedback.close(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const guard = (f: Fixture) => { const work = f.works.getWork(f.workId)!; return { expectedStateVersion: work.stateVersion,
  expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch }; };
const blocker = (f: Fixture, waitingForUserInput = false) => {
  const result = f.works.reportBlocker(user, { operationId: "new-blocker", workId: f.workId,
    reason: "新发现必要资料缺失", kind: "operational", waitingForUserInput, versionGuard: guard(f) });
  assert(result.ok, JSON.stringify(result));
};
const gap = (f: Fixture) => f.works.transaction(() => f.works.partialResults.record(f.binding, [{ itemId: "new-gap", task: "核对附件",
  required: true, dependencies: [], criterionIds: [], nativeStatus: "failed", outcome: "failed", artifactRefs: [], writeConflicts: [], summary: "附件缺失" }]));

const changes: Array<[string, (f: Fixture) => void, string]> = [
  ["required-gap", gap, "actualMissing"],
  ["unknown-effect", f => f.works.transaction(() => {
    // Late native receipt import, followed by the real task settlement entry.
    f.works.repo.insertAdmission({ admissionId: "late-admission", operationId: "effect", workId: f.workId, bindingId: f.binding.bindingId,
      state: "admitted", actionKind: "workspace:write", intentRevision: f.binding.intentRevision, ownerEpoch: f.binding.ownerEpoch, admittedAt: 1 });
    f.works.settleTaskAction(f.binding.taskId, "effect", "unknown");
  }), "unknownEffects"],
  ["operational-blocker", f => blocker(f), "blockers"],
  ["user-question", f => blocker(f, true), "pendingQuestions"],
  ["rejected", f => { const result = f.works.rejectDeliverable(user, { operationId: "reject", workId: f.workId,
    deliverableId: f.works.repo.listDeliverables(f.workId)[0]!.deliverableId, reason: "内容核验不通过", versionGuard: guard(f) }); assert(result.ok, JSON.stringify(result)); }, "resultVerification"],
  ["write-conflict", f => f.db.connection.prepare("UPDATE work_deliverables SET has_write_conflicts=1 WHERE work_id=?").run(f.workId), "resultVerification"],
  ["speculation", f => f.db.connection.prepare("UPDATE work_deliverables SET is_speculation=1 WHERE work_id=?").run(f.workId), "resultVerification"],
];
for (const [name, change, field] of changes) {
  const f = await fixture(name);
  try {
    await f.finish();
    let reviews = 0, first = "";
    const coordinator = f.start(async input => {
      reviews++;
      if (reviews === 1) {
        first = JSON.stringify(input.context[field]);
        change(f); return complete();
      }
      assert.notEqual(JSON.stringify(input.context[field]), first, `${field} refreshed after restart`);
      return { decision: name === "user-question" ? "ask" : "deliver", outcome: "partial", reply: "已有成果保留，新发现的缺项仍未完成。", missing: [] };
    });
    coordinator.wake(); await flush();
    assert.equal(reviews, 1); assert.equal(f.turn().decision_json, null);
    assert.equal(f.works.getWork(f.workId)?.lifecycle, "active"); assert.equal(f.reports().length, 0, "stale success never delivered");
    f.restart();
    const recovered = f.start(async input => {
      reviews++; assert.notEqual(JSON.stringify(input.context[field]), first);
      return { decision: name === "user-question" ? "ask" : "deliver", outcome: "partial", reply: "已有成果保留，新发现的缺项仍未完成。", missing: [] };
    });
    recovered.wake(); await flush();
    assert.equal(reviews, 2); assert.equal(f.submits, 1);
    assert.equal(f.reports().at(-1)?.workFeedback?.report?.completion?.outcome, "partial");
    assert(!f.reports().at(-1)?.text.includes("已完成全部要求"));
    assert.equal(f.works.getWork(f.workId)?.lifecycle, name === "user-question" ? "active" : "closed");
    console.log(`PASS #37 ${name}: real WorkService/SQLite write during review, fresh context after restart, no stale success or business replay`);
  } finally { f.close(); }
}

for (const kind of ["deliver", "ask", "continue"] as const) {
  const f = await fixture(`delivery-${kind}`);
  try {
    await f.finish(); let reviews = 0, failures = 2;
    const review: WorkCompletionOptions["review"] = async () => { reviews++; return kind === "deliver" ? complete()
      : { decision: kind, outcome: "partial", reply: "保留已完成成果，继续核对缺项", missing: kind === "continue" ? [{ task: "核对缺项", requestExcerpt: `delivery-${kind}` }] : [] }; };
    const deliver: WorkCompletionOptions["deliver"] = input => {
      if (input.eventId === `completion:${f.binding.bindingId}` && failures-- > 0) throw Error("local conversation write failed");
      return f.feedback.deliverCompletion(input);
    };
    let coordinator = f.start(review, deliver);
    coordinator.wake(); await flush();
    assert(f.turn().decision_json, "review survives failed application transaction");
    assert.match(f.turn().error ?? "", /^delivery:/);
    assert.equal(f.works.partialResults.plans(f.workId).length, 0, "continuation rolls back with failed message");
    assert.equal(f.works.repo.listOpenBlockers(f.workId).length, 0, "question rolls back with failed message");
    f.retry(); coordinator.wake(); await flush();
    assert.equal(reviews, 1); assert.equal(f.turn().attempts, 1);
    assert.equal(f.works.getWork(f.workId)?.lifecycle, "active", "delivery failure never becomes unsuccessful closure");
    assert.equal(f.reports().length, 0, "no misleading model failure fallback");
    f.restart(); coordinator = f.start(review, deliver); f.retry(); coordinator.wake(); await flush();
    assert.equal(reviews, 1, "restart reuses valid decision");
    assert.equal(f.turn().state, kind === "deliver" ? "delivered" : kind === "ask" ? "asking" : "continued");
    assert.equal(f.works.partialResults.plans(f.workId).length, kind === "continue" ? 1 : 0);
    assert.equal(f.works.repo.listOpenBlockers(f.workId).length, kind === "ask" ? 1 : 0);
    assert.equal(f.reports().length, 1);
    coordinator.wake(); await flush(); assert.equal(f.reports().length, 1); assert.equal(f.submits, 1);
    console.log(`PASS #38 ${kind}: two delivery failures, atomic rollback, restart reuses decision, one plan/question/delivery`);
  } finally { f.close(); }
}

for (const change of ["evidence", "cancel", "amend", "telemetry"] as const) {
  const f = await fixture(`retry-${change}`);
  try {
    await f.finish(); let reviews = 0, available = false;
    const coordinator = f.start(async () => { reviews++; return complete(); }, input => input.category === "progress" || available && f.feedback.deliverCompletion(input));
    coordinator.wake(); await flush(); assert.equal(reviews, 1); assert(f.turn().decision_json);
    if (change === "evidence") gap(f);
    if (change === "cancel") assert(f.works.cancelWork(user, { operationId: "cancel", workId: f.workId, versionGuard: guard(f) }).ok);
    if (change === "amend") assert(f.works.amendWork(user, { operationId: "amend", workId: f.workId, goalDescription: "新的要求", versionGuard: guard(f) }).ok);
    if (change === "telemetry") f.works.recordTelemetryProgress({ workId: f.workId, executionId: f.binding.bindingId, streamingText: "telemetry only" });
    available = true; f.retry(); coordinator.wake(); await flush();
    assert.equal(reviews, change === "evidence" ? 2 : 1);
    assert.equal(f.reports().length, ["cancel", "amend"].includes(change) ? 0 : 1);
    if (change === "cancel" || change === "amend") assert.notEqual(f.works.getWork(f.workId)?.closureConclusion, "succeeded");
    assert.equal(f.submits, 1);
    console.log(`PASS #37/#38 retry ${change}: current facts/intent/cancellation respected, telemetry does not force review`);
  } finally { f.close(); }
}

for (const kind of ["ask", "continue"] as const) {
  const f = await fixture(`application-${kind}`);
  try {
    await f.finish(); let reviews = 0;
    const review: WorkCompletionOptions["review"] = async () => { reviews++; return { decision: kind, outcome: "partial",
      reply: "保留成果，补齐必要缺项", missing: kind === "continue" ? [{ task: "补齐缺项", requestExcerpt: `application-${kind}` }] : [] }; };
    const reportBlocker = f.works.reportBlocker.bind(f.works), continueWork = f.works.continueWork.bind(f.works);
    const fault = kind === "ask"
      ? mock.method(f.works, "reportBlocker", (...args: Parameters<WorkService["reportBlocker"]>) => { reportBlocker(...args); throw Error("application interrupted after question write"); })
      : mock.method(f.works, "continueWork", (...args: Parameters<WorkService["continueWork"]>) => { continueWork(...args); throw Error("application interrupted after continuation write"); });
    const coordinator = f.start(review); coordinator.wake(); await flush();
    assert.match(f.turn().error ?? "", /^application:/); assert(f.turn().decision_json);
    assert.equal(f.works.partialResults.plans(f.workId).length, 0); assert.equal(f.works.repo.listOpenBlockers(f.workId).length, 0);
    fault.mock.restore(); f.retry(); coordinator.wake(); await flush();
    assert.equal(reviews, 1); assert.equal(f.reports().length, 1);
    assert.equal(f.works.partialResults.plans(f.workId).length, kind === "continue" ? 1 : 0);
    assert.equal(f.works.repo.listOpenBlockers(f.workId).length, kind === "ask" ? 1 : 0);
  } finally { mock.restoreAll(); f.close(); }
}

{
  const f = await fixture("downgrade");
  try {
    await f.finish(); f.db.connection.prepare("UPDATE work_deliverables SET has_write_conflicts=1 WHERE work_id=?").run(f.workId);
    const coordinator = f.start(async () => complete()); coordinator.wake(); await flush();
    const report = f.reports().at(-1)!.workFeedback!.report!;
    assert.equal(report.completion?.outcome, "partial"); assert.match(report.summary, /未完成部分/);
    assert(!report.summary.includes("已完成全部要求")); assert.equal(f.works.getWork(f.workId)?.closureConclusion, "ended_unsuccessfully");
  } finally { f.close(); }
}

{
  const f = await fixture("delayed-drain");
  try {
    await f.finish(); const hold = mock.method(f.works.automaticCompletion, "drain", () => {});
    const coordinator = f.start(async () => complete()); coordinator.wake(); await flush(); hold.mock.restore();
    assert.equal(f.turn().state, "delivered"); gap(f); f.works.automaticCompletion.drain();
    assert.equal(f.works.getWork(f.workId)?.lifecycle, "active", "a reviewed receipt cannot settle changed facts");
    assert.equal(f.turn().state, "queued"); assert.equal(f.turn().decision_json, null);
    const binding = f.works.repo.getBinding(f.binding.bindingId)!, facts = f.works.automaticCompletion.outcome(binding.bindingId)!;
    const fingerprint = completionFingerprint(completionEvidence(f.db.connection, f.works, binding, facts));
    f.works.recordTelemetryProgress({ workId: f.workId, streamingText: "time and telemetry" });
    assert.equal(completionFingerprint(completionEvidence(f.db.connection, f.works, binding, facts)), fingerprint);
  } finally { f.close(); }
}

{
  const f = await fixture("lifecycle-retry");
  try {
    await f.finish(); const ids: string[] = [];
    const coordinator = f.start(async input => { ids.push(input.eventId); if (ids.length < 3) throw new WorkResultLifecycleError("idle", "idle timeout"); return complete(); });
    for (let n = 0; n < 3; n++) { f.retry(); coordinator.wake(); await flush(); }
    assert.equal(new Set(ids).size, 1, "native recovery retains exact request identity");
    assert.equal(f.turn().attempts, 1); assert.equal(f.works.getWork(f.workId)?.closureConclusion, "succeeded"); assert.equal(f.submits, 1);
  } finally { f.close(); }
}
{
  const f = await fixture("crash-before-delivery");
  try {
    await f.finish();
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--crash-apply", join(f.root, "app.db")],
      { encoding: "utf8", timeout: 20000, windowsHide: true });
    assert.match(child.stdout, /review-committed-before-delivery/); assert.notEqual(child.status, 0);
    f.restart(); let reviews = 0;
    const coordinator = f.start(async () => { reviews++; return complete(); }); coordinator.wake(); await flush();
    assert.equal(reviews, 0, "abrupt process death after saved verdict does not call review again");
    assert.equal(f.reports().length, 1); assert.equal(f.works.getWork(f.workId)?.closureConclusion, "succeeded");
    assert.equal(f.submits, 1);
    console.log("PASS #38 real process SIGKILL before delivery: committed review survives SQLite rollback and delivers once on restart");
  } finally { f.close(); }
}
for (const failure of ["target", "sqlite-write"] as const) {
  const f = await fixture(`local-${failure}`);
  try {
    await f.finish(); let reviews = 0;
    const missingTarget = failure === "target" ? mock.method(f.feedback.messages, "resolveWorkDelivery", () => undefined) : undefined;
    if (failure === "sqlite-write") f.db.connection.exec(`CREATE TRIGGER completion_write_fault BEFORE INSERT ON bot_messages
      WHEN instr(NEW.text,'已完成全部要求')>0 BEGIN SELECT RAISE(ABORT,'injected local SQLite write failure'); END`);
    const coordinator = f.start(async () => { reviews++; return complete(); }); coordinator.wake(); await flush();
    assert(f.turn().decision_json); assert.match(f.turn().error ?? "", /^delivery:/); assert.equal(f.reports().length, 0);
    missingTarget?.mock.restore();
    if (failure === "sqlite-write") f.db.connection.exec("DROP TRIGGER completion_write_fault");
    f.retry(); coordinator.wake(); await flush();
    assert.equal(reviews, 1); assert.equal(f.reports().length, 1); assert.equal(f.works.getWork(f.workId)?.closureConclusion, "succeeded");
    console.log(`PASS #38 production local delivery ${failure}: saved review and exact delivery recovered once`);
  } finally { f.close(); }
}
{
  const f = await fixture("two-stalled-reviews");
  try {
    await f.finish();
    const second = await f.addCompleted("second-stalled-review"), third = await f.addCompleted("third-independent-review");
    const fail: Array<(reason: Error) => void> = [], reviewed: string[] = [];
    const coordinator = f.start(async input => {
      reviewed.push(String(input.context.title));
      if (input.context.title !== "third-independent-review") return new Promise<WorkResultDecision>((_resolve, reject) => fail.push(reject));
      return complete();
    });
    coordinator.wake(); await flush(); assert.equal(reviewed.length, 2);
    assert.equal(f.works.getWork(third.workId)?.lifecycle, "active");
    fail.forEach(reject => reject(new WorkResultLifecycleError("idle", "controlled idle deadline")));
    await flush(); coordinator.wake(); await flush();
    assert.equal(f.works.getWork(third.workId)?.closureConclusion, "succeeded", "third Work proceeds when two bounded failures release result slots");
    assert.equal(f.works.getWork(second.workId)?.lifecycle, "active");
    assert.equal(f.turn().attempts, 1); assert.match(f.turn().error ?? "", /^runtime:idle:/);
    assert.equal(f.submits, 3, "only the three original business submissions");
    console.log("PASS #39 coordinator: two stalled review ports release both slots after lifecycle failure; third real Work settles");
  } finally { f.close(); }
}
console.log("PASS completion recovery: factual freshness, durable review receipt, phase-specific retries and consistent downgraded delivery");
