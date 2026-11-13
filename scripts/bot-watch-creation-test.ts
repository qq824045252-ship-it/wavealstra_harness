import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botForegroundTools } from "../src/main/agent/work/BotForegroundTools";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto, type WorkExecutionBindingDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "watch-frontdoor-"));
const path = join(root, "business.db");
let db!: AppDatabase;
let bots!: BotRegistry;
let works!: WorkService;
let messages!: BotConversationRepository;
let queue!: WorkDispatchQueue;
let count = 0;
const start = Date.now();
const clock = { at: start };
const scheduled: string[] = [];
const dispatched: string[] = [];
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const unwrap = (value: unknown) => { const result = value as WorkControlResult; assert(result.ok, JSON.stringify(result)); return result.work; };
function open() {
  db = new AppDatabase(path);
  bots = new BotRegistry(db.connection);
  bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "watch fixture", authorization: DESKTOP_USER_GRANTS });
  works = new WorkService(db.connection, { bots, now: () => clock.at });
  messages = new BotConversationRepository(db.connection);
  // Only native model execution is replaced here: the scheduler, dispatch queue,
  // guarded service, durable request identity and execution input are real.
  const adapter = { dispatch: async (actor, params) => {
    const result = works.dispatchExecution(actor, { ...params, durableStoreKey: `store:${params.taskId}`, conversationId: "1", workspaceBinding: root });
    if (result.ok) dispatched.push(params.taskId);
    return result;
  }, onProgress: () => () => {}, wake: () => {}, flush: async () => {} } as Pick<WorkExecutionAdapter, "dispatch" | "flush" | "wake" | "onProgress">;
  queue = new WorkDispatchQueue(db, works, adapter as WorkExecutionAdapter, () => true, () => undefined);
}
open();
const first = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "watch-create", text: "每小时帮我查进展，明天到期跟进" });
let requestId = first.requestId;
function request(text: string, workId: string) {
  requestId = `watch-request-${++count}`;
  messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: first.conversationId, requestId, selectedWorkId: workId, text });
}
async function invoke(name: string, args: unknown) {
  const tools = botForegroundTools({ db: db.connection, userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID,
    conversationId: first.conversationId, bots, messages, works, isAuthority: () => true,
    schedule: work => { scheduled.push(work.workId); queue.enqueue(work, `immediate:${++count}`); }, wake: () => {}, memorySearch: () => [] });
  const tool = tools.find(item => item.name === name)!;
  const api = { callId: `call-${++count}`, taskId: `tool-${count}`, memo: async () => requestId } as unknown as ToolExecutionApi;
  const result = await tool.execute(args as never, api, BACKGROUND_CONTEXT);
  const text = result.output?.find(item => item.type === "text"); assert(text?.type === "text");
  return JSON.parse(text.text);
}
async function read(workId: string) {
  const result = await invoke("work_query_status", { workId });
  assert.equal(result.length, 1); return result[0].versionGuard;
}
function settle(workId: string) {
  for (const binding of works.repo.listBindings(workId).filter(item => item.status === "pending"))
    unwrap(works.reconcileExecution({ kind: "system", reason: "fixture observation completed" }, { bindingId: binding.bindingId, outcome: "completed" }));
}
// Exercise the production adapter against a persisted but not yet attempted binding.
// These isolated databases keep the legacy fake-adapter fixture out of native recovery.
async function checkPendingNativeBinding(change: "stop" | "revise" | "skip", hasReceipt: boolean) {
  const key = `${change}-${hasReceipt ? "receipt" : "unattempted"}`;
  const nativeDb = new AppDatabase(join(root, `adapter-${key}.db`));
  const nativeBots = new BotRegistry(nativeDb.connection);
  nativeBots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: key, authorization: DESKTOP_USER_GRANTS });
  let nativeNow = Date.now();
  const service = new WorkService(nativeDb.connection, { bots: nativeBots, now: () => nativeNow });
  const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
  const watch = unwrap(service.createWork(actor, { operationId: `create-${key}`, title: key, mode: "watch",
    workspacePath: root, inputSnapshotId: `input-${key}`, authorization: DESKTOP_USER_GRANTS,
    watchRule: { scheduleBasis: "user_specified", subscriptions: ["cron"], cronExpression: "* * * * *", timezone: "UTC",
      catchUpPolicy: change === "skip" ? "each" : "latest", maxMergeWaitMs: 1_000, maxQueueDepth: 8 } }));
  nativeNow = service.repo.listSubscriptions(watch.workId)[0].nextWakeAt!;
  if (change === "skip") nativeNow += 5 * 60_000;
  service.scheduler.tick(nativeNow);
  if (change === "skip") assert(service.repo.listInbox(watch.workId).length > 1, "each has a real persisted backlog before the policy change");
  const event = service.repo.listInbox(watch.workId).find(item => item.eventType === "work.tick")!;
  assert(event);
  unwrap(service.dispatchExecution(actor, { operationId: `dispatch-${key}`, workId: watch.workId,
    botId: DEFAULT_BOT_ID, taskId: `task-${key}`, durableStoreKey: `store-${key}`, conversationId: `conversation-${key}`,
    workspaceBinding: root, inboxEventId: event.eventId,
    causal: { source: "system", sourceEventId: event.sourceEventId, trustedRoot: true } }));
  const binding = service.repo.listBindings(watch.workId)[0];
  assert.equal(binding.status, "pending"); assert.equal(binding.attemptId, undefined);
  const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId,
    submissionId: 1, status: "done" };
  let submits = 0;
  let inspections = 0;
  const errors: unknown[] = [];
  const native: WorkExecutionPort = {
    prepare: async taskId => ({ taskId, durableStoreKey: `store-${key}`, conversationId: `conversation-${key}`, workspaceBinding: root }),
    find: async () => hasReceipt ? receipt : undefined,
    submit: async () => { submits++; return receipt; },
    inspect: async () => { inspections++; return { status: "completed", summary: `retained native result ${key}`,
      artifactRefs: [], hasWriteConflicts: false }; },
    stop: async () => {},
  };
  const adapter = new WorkExecutionAdapter(service, native, LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
  try {
    unwrap(service.amendWork(actor, { operationId: `change-${key}`, workId: watch.workId,
      versionGuard: guard(service.getWork(watch.workId)!),
      watchRule: change === "stop" ? null : change === "skip" ? { catchUpPolicy: "skip" } : { cronExpression: "0 9 * * *", timezone: "UTC" } }));
    await adapter.flush(); await adapter.flush();
    assert.equal(submits, 0, `${key}: never submit an obsolete scheduled check`);
    assert.deepEqual(errors, []);
    const recovered = service.repo.getBinding(binding.bindingId)!;
    if (hasReceipt) {
      assert(inspections >= 1, `${key}: recover the existing native receipt even after schedule changes`);
      assert.equal(recovered.submissionReceipt, JSON.stringify(receipt));
      assert(service.repo.listDeliverables(watch.workId).some(item => item.summary.includes(`retained native result ${key}`)),
        `${key}: retain an already-produced result instead of dropping it`);
    } else {
      assert.equal(inspections, 0);
      assert.equal(recovered.submissionReceipt, undefined);
      assert(["stopped", "invalidated"].includes(recovered.status));
    }
  } finally { await adapter.close(); nativeDb.close(); }
}

function assertUnrestrictedAdmission(taskId: string, label: string) {
  for (const actionKind of ["workspace:write", "send", "delegate", "workspace:read"]) {
    const operationId = `${label}:${actionKind}`;
    assert.equal(works.admitTaskAction(taskId, { operationId, actionKind }), undefined,
      `${label}: legacy follow-up scopes do not impose application permissions for ${actionKind}`);
    works.settleTaskAction(taskId, operationId, "consumed");
  }
}

const testActor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const receiptFor = (binding: WorkExecutionBindingDto): AgentSubmissionReceipt => ({ taskId: binding.taskId,
  operationId: binding.operationId, submissionId: 1, status: "done" });
async function newImmediateWatch(title: string) {
  const work = unwrap(await invoke("work_create", { requestedOutcome: "one_time", title, mode: "watch", startImmediately: true,
    watchRule: { executionMode: "observe", scheduleBasis: "user_specified", nextWakeAt: clock.at + 24 * 60 * 60_000 } }));
  await queue.drain();
  const binding = works.repo.listBindings(work.workId)[0]; assert(binding);
  return { work, binding };
}
async function checkManualWatchGap() {
  const { work, binding } = await newImmediateWatch("手工补齐普通检查缺项");
  const itemId = "missing-observation";
  assert.deepEqual(works.nativeResults.receive(binding, receiptFor(binding), { status: "completed",
    summary: "本轮仍有明确缺项", artifactRefs: [], hasWriteConflicts: false, subitems: [{ itemId,
      task: "核对尚未得到的来源事实", required: true, dependencies: [], criterionIds: [], nativeStatus: "completed",
      outcome: "blocked", artifactRefs: [], writeConflicts: [], origin: "native", summary: "未获取到来源事实" }] }), []);
  const original = works.partialResults.gaps(work.workId).find(item => item.itemId === itemId)!;
  assert(original); assert.equal(original.origin, "native");
  unwrap(works.continueWork(testActor, { operationId: "manual-watch-gap", workId: work.workId,
    sourceBindingId: binding.bindingId, gapItemIds: [itemId], reason: "只补齐这一缺项",
    versionGuard: guard(works.getWork(work.workId)!) }));
  const plan = works.partialResults.plans(work.workId).find(item => item.sourceBindingId === binding.bindingId)!;
  assert(plan); assert.equal(works.partialResults.recovery.record(plan.planId), undefined);
  assert.equal(works.partialResults.isReadOnlyPlan(plan), true, "a normal watch continuation is read-only without being artifact revalidation");
  await queue.drain();
  const continuation = works.repo.listBindings(work.workId).find(item => item.bindingId !== binding.bindingId)!;
  assert(continuation);
  assert.deepEqual(works.nativeResults.receive(continuation, receiptFor(continuation), { status: "completed",
    summary: "原生整体结束，但没有提供该子项证据", artifactRefs: [], hasWriteConflicts: false }), []);
  const remaining = works.partialResults.gaps(work.workId).find(item => item.itemId === itemId);
  assert(remaining, "overall completion without a matching subitem does not resolve a native gap");
  assert.equal(remaining.outcome, "blocked"); assert.equal(remaining.origin, "native");
  assert.equal(works.partialResults.list(work.workId).filter(item => item.bindingId === continuation.bindingId).length, 0,
    "empty artifactRefs must not vacuously produce a synthetic artifact-revalidation success");
}
async function checkStoppedWatchReadback(outcome: "completed" | "failed" | "pending") {
  const { work, binding } = await newImmediateWatch(`停止后旧只读恢复-${outcome}`);
  const failAndPlan = (source: WorkExecutionBindingDto) => {
    assert.deepEqual(works.nativeResults.receive(source, receiptFor(source), { status: "failed", summary: "",
      failureReason: "同一来源读取失败，没有新增证据", artifactRefs: [], hasWriteConflicts: false }), []);
    works.partialResults.recovery.markEvidenceRead(source.bindingId);
    const failed = works.repo.getBinding(source.bindingId)!;
    works.transaction(() => assert(works.partialResults.recovery.prepare(works.getWork(work.workId)!, failed, clock.at)));
    return works.partialResults.plans(work.workId).find(item => item.sourceBindingId === source.bindingId)!;
  };
  const firstPlan = failAndPlan(binding);
  assert.equal(works.partialResults.recovery.record(firstPlan.planId)!.mode, "recover");
  await queue.drain();
  const retry = works.repo.listBindings(work.workId).find(item => item.bindingId !== binding.bindingId)!;
  assert(retry);
  const readbackPlan = failAndPlan(retry);
  assert.equal(works.partialResults.recovery.record(readbackPlan.planId)!.mode, "readback", "unchanged failed evidence reaches the actual readback path");
  let readback: WorkExecutionBindingDto | undefined;
  if (outcome !== "pending") {
    await queue.drain();
    readback = works.repo.listBindings(work.workId).find(item => item.bindingId !== binding.bindingId && item.bindingId !== retry.bindingId)!;
    assert(readback);
    assert.equal(works.partialResults.recovery.readOnlyTask(readback.taskId), true);
    assert(works.markDispatchAttempt(readback.bindingId, `attempt:${readback.bindingId}`).ok);
    assert(works.recordSubmissionReceipt(readback.bindingId, JSON.stringify(receiptFor(readback))).ok);
  }
  unwrap(works.amendWork(testActor, { operationId: `stop-old-readback-${outcome}`, workId: work.workId,
    versionGuard: guard(works.getWork(work.workId)!), watchRule: null }));
  assert.equal(works.getWork(work.workId)!.mode, "once");
  const bindingCount = works.repo.listBindings(work.workId).length;
  const planCount = works.partialResults.plans(work.workId).length;
  if (readback) {
    assert.deepEqual(works.nativeResults.receive(works.repo.getBinding(readback.bindingId)!, receiptFor(readback), {
      status: outcome === "completed" ? "completed" : "failed", summary: outcome === "completed" ? "旧检查的只读结果" : "",
      artifactRefs: [], hasWriteConflicts: false }), []);
    works.partialResults.recovery.markEvidenceRead(readback.bindingId);
  }
  await queue.drain(); await queue.drain();
  assert.equal(works.getWork(work.workId)!.lifecycle, "active", `${outcome}: stopping a schedule never authorizes closing the underlying Work`);
  assert.equal(works.repo.listBindings(work.workId).length, bindingCount, `${outcome}: no new continuation after stopping the schedule`);
  assert.equal(works.partialResults.plans(work.workId).length, planCount);
  if (outcome === "pending") assert.equal(works.partialResults.plans(work.workId).find(item => item.planId === readbackPlan.planId)!.state, "cancelled");
}

try {
  const deadline = start + 24 * 60 * 60_000;
  const created = await invoke("work_create", { requestedOutcome: "ongoing", title: "跟进进展", mode: "watch",
    watchRule: { scheduleBasis: "user_specified", cronExpression: "0 * * * *", timezone: "Asia/Shanghai", catchUpPolicy: "latest", stopConditionText: "发布成功" }, deadlineAt: deadline });
  let work = unwrap(created);
  assert(created.tracking.nextWakeAt > start, "the tool returns the actual first wake, not only the Cron input");
  assert.equal(created.tracking.timezone, "Asia/Shanghai");
  assert.equal(work.mode, "watch"); assert.equal(work.deadlineAt, deadline);
  assert.equal(scheduled.length, 0, "a future watch does not execute the original task immediately");
  let subscription = works.repo.listSubscriptions(work.workId)[0];
  assert.equal(subscription.source, "cron"); assert.equal(subscription.timezone, "Asia/Shanghai");
  assert(subscription.nextWakeAt && subscription.nextWakeAt > start);
  assert.equal(works.repo.listBindings(work.workId).length, 0);
  const initialInput = work.inputSnapshotId;
  const initialRevision = work.intentRevision;

  // The next due slot survives a real SQLite close/reopen, and executes even
  // when no external source is registered and the previous check already ended.
  await queue.close(); db.close(); open();
  subscription = works.repo.listSubscriptions(work.workId)[0];
  clock.at = subscription.nextWakeAt!;
  works.tick(clock.at); await queue.drain();
  let bindings = works.repo.listBindings(work.workId);
  assert.equal(bindings.length, 1);
  assert.deepEqual(bindings[0].delegatedScope, ["workspace:read"]);
  const input = JSON.parse(works.repo.executionInput(bindings[0]));
  assert.equal(input.watchFollowUp.readOnly, true);
  assert.deepEqual(input.watchFollowUp.previousReports, []);
  assert.equal(input.watchFollowUp.comparisonState, "no_baseline", "the first native tick has no comparison baseline");
  assert.match(input.watchLifetimeControl, /由前台自主判断/);
  assert.match(input.watchLifetimeControl, /不调用 conversation_goal_propose_complete/);
  assert.match(input.watchLifetimeControl, /不使用 automation_exec/);
  assert.equal(input.watchFollowUp.watchRule.stopConditionText, "发布成功");
  assert.match(input.watchFollowUp.instructions, /不自行循环/);
  // Exercise the production history query, including out-of-order completion
  // and equal timestamps. These synthetic bindings never reach the dispatcher.
  {
    const at = bindings[0].admittedAt + 100;
    const ids: string[] = [];
    const seed = (name: string, admittedAt: number, createdAt: number,
      bindingPatch: Partial<WorkExecutionBindingDto> = {}, resultPatch: Record<string, unknown> = {}) => {
      const id = `baseline-${name}`; ids.push(id);
      const binding = { ...bindings[0], bindingId: id, operationId: id, taskId: id,
        admittedAt, status: "completed" as const, inboxEventId: `tick:${id}`, ...bindingPatch };
      works.repo.insertBinding(binding);
      works.repo.insertDeliverable({ deliverableId: `result:${id}`, workId: work.workId,
        executionId: id, producerBotId: binding.botId, intentRevision: binding.intentRevision,
        ownerEpoch: binding.ownerEpoch, inputSnapshotId: binding.inputSnapshotId, status: "proposed",
        summary: name, artifactRefs: [], evidenceRefs: [], uncoveredScope: [], uncoveredCriterionIds: [],
        isSpeculation: false, hasWriteConflicts: false, createdAt, ...resultPatch });
      return binding;
    };
    try {
      seed("older-structured", at - 30, at - 30, {}, { summary: JSON.stringify({ protocol: "watch-observation-v1",
        status: "observed", facts: [{ source: "/source", key: "value", value: "A" }], summary: "older baseline" }) });
      seed("previous", at - 20, at - 20);
      seed("incomplete", at - 10, at - 10, {}, { uncoveredScope: ["partial source"] });
      seed("old-intent", at - 10, at - 10, { intentRevision: work.intentRevision + 1 });
      seed("old-input", at - 10, at - 10, { inputSnapshotId: "other-input" });
      seed("old-owner", at - 10, at - 10, { ownerEpoch: work.ownerEpoch + 1 });
      seed("other-producer", at - 10, at - 10, { botId: "other-bot" });
      seed("invalidated", at - 10, at - 10, { invalidatedAt: at - 5 });
      seed("invalidated-status", at - 10, at - 10, { status: "invalidated" });
      seed("rejected", at - 10, at - 10, {}, { status: "rejected" });
      seed("superseded", at - 10, at - 10, {}, { status: "superseded" });
      seed("late-result", at - 10, at + 1);
      seed("same-round", at - 10, at - 10, { inboxEventId: bindings[0].inboxEventId });
      seed("same-time-before", at, at);
      const target = seed("current", at, at + 10, { inboxEventId: bindings[0].inboxEventId });
      seed("same-time-after", at, at);
      seed("future-finishes-first", at + 1, at - 1);
      const history = works.repo.previousWatchReports(target);
      assert.deepEqual(history.map(r => r.summary), ["previous", "incomplete", "same-time-before"],
        "only prior same-identity observations present at admission can be baseline candidates");
      const comparisonHistory = works.repo.previousWatchReports(target, true);
      assert.equal(comparisonHistory.length, 4, "bounded recent history may retain one older structured baseline");
      assert.equal(comparisonHistory[0].executionId, "baseline-older-structured");
      const native = JSON.parse(works.repo.executionInput(target)).watchFollowUp;
      assert.equal(native.comparisonState, "unverified", "existing history is not proof of equality");
      assert.deepEqual(native.previousReports.map((r: { summary: string }) => r.summary), history.map(r => r.summary));
      for (const row of comparisonHistory) db.connection.prepare("DELETE FROM work_deliverables WHERE deliverable_id=?").run(row.deliverableId);
      const isolated = JSON.parse(works.repo.executionInput(target)).watchFollowUp;
      assert.deepEqual(isolated.previousReports, [], "own/future/stale results never reconstruct a baseline on review or recovery");
      assert.equal(isolated.comparisonState, "no_baseline");
    } finally {
      for (const id of ids) {
        db.connection.prepare("DELETE FROM work_deliverables WHERE execution_id=?").run(id);
        db.connection.prepare("DELETE FROM work_execution_bindings WHERE binding_id=?").run(id);
      }
    }
  }
  settle(work.workId);
  works.tick(clock.at); await queue.drain();
  assert.equal(works.repo.listBindings(work.workId).length, 1, "same slot never starts a duplicate execution");
  clock.at = works.repo.listSubscriptions(work.workId)[0].nextWakeAt!;
  works.tick(clock.at); await queue.drain();
  bindings = works.repo.listBindings(work.workId);
  assert.equal(bindings.length, 2, "a later slot must run even when source/input content is unchanged");
  assert.equal(new Set(bindings.map(item => item.inboxEventId)).size, 2);
  assert.equal(works.getWork(work.workId)?.inputSnapshotId, initialInput);
  settle(work.workId);

  request("改成每天上海时间早上9点", work.workId);
  work = unwrap(await invoke("work_amend", { workId: work.workId, versionGuard: await read(work.workId),
    watchRule: { scheduleBasis: "user_specified", cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" } }));
  const changed = works.repo.listSubscriptions(work.workId)[0];
  assert.equal(changed.subscriptionId, subscription.subscriptionId);
  assert.equal(changed.cronExpression, "0 9 * * *"); assert.equal(changed.scheduleRevision, 2);
  assert.equal(work.inputSnapshotId, initialInput, "changing timing does not invalidate prior results");
  assert.equal(work.intentRevision, initialRevision);
  assert.equal(scheduled.length, 0, "changing timing must not immediately rerun old business actions");
  const expected = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(changed.nextWakeAt);
  assert.equal(expected, "09:00");

  request("暂停跟踪", work.workId);
  work = unwrap(await invoke("work_pause", { workId: work.workId, versionGuard: await read(work.workId) }));
  clock.at = changed.nextWakeAt! + 2 * 24 * 60 * 60_000;
  works.tick(clock.at); await queue.drain();
  assert.equal(works.repo.listBindings(work.workId).length, 2);
  request("恢复跟踪", work.workId);
  unwrap(await invoke("work_resume", { workId: work.workId, versionGuard: await read(work.workId) }));
  works.tick(clock.at); await queue.drain();
  assert.equal(works.repo.listBindings(work.workId).length, 3, "latest catches up once after pause");
  settle(work.workId);

  request("停止持续跟踪但保留这项事项", work.workId);
  work = unwrap(await invoke("work_amend", { workId: work.workId, versionGuard: await read(work.workId), watchRule: null }));
  assert.equal(work.mode, "once"); assert.equal(work.watchRule, undefined);
  assert(works.repo.listSubscriptions(work.workId).every(item => item.stoppedAt));
  clock.at += 24 * 60 * 60_000; works.tick(clock.at); await queue.drain();
  assert.equal(works.repo.listBindings(work.workId).length, 4, "the missed independent deadline is still followed up after the watch is stopped");
  const resumedDeadline = works.repo.listBindings(work.workId).at(-1)!;
  assert.equal(works.repo.getInbox(resumedDeadline.inboxEventId!)?.eventType, "deadline_expired");
  settle(work.workId);

  request("明天安排一次跟进", work.workId);
  work = unwrap(await invoke("work_amend", { workId: work.workId, versionGuard: await read(work.workId),
    watchRule: { scheduleBasis: "user_specified", nextWakeAt: clock.at + 60_000 }, deadlineAt: clock.at + 120_000 }));
  assert.equal(work.mode, "watch"); assert(work.deadlineRevision > 1);
  clock.at += 60_000; works.tick(clock.at); await queue.drain(); settle(work.workId);
  const onceCount = works.repo.listBindings(work.workId).length;
  assert.equal(onceCount, 5);
  clock.at += 60_000; works.tick(clock.at); await queue.drain();
  const due = works.repo.listBindings(work.workId).at(-1)!;
  assert.equal(works.repo.getInbox(due.inboxEventId!)?.eventType, "deadline_expired");
  assert.equal(JSON.parse(works.repo.executionInput(due)).deadlineFollowUp.readOnly, true);
  settle(work.workId);
  await queue.close(); db.close(); open();
  works.tick(clock.at); await queue.drain();
  assert.equal(works.repo.listBindings(work.workId).length, onceCount + 1, "deadline instance survives restart without duplicate follow-up");

  const before = works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length;
  await assert.rejects(() => invoke("work_create", { requestedOutcome: "one_time", title: "missing timing", mode: "watch" }), /执行时间或已支持事件来源/);
  const invalidZone = await invoke("work_create", { requestedOutcome: "ongoing", title: "bad zone", mode: "watch", watchRule: { scheduleBasis: "user_specified", cronExpression: "0 9 * * *", timezone: "Not/AZone" } });
  assert.equal(invalidZone.ok, false);
  const invalidCron = await invoke("work_create", { requestedOutcome: "ongoing", title: "bad schedule", mode: "watch", watchRule: { scheduleBasis: "user_specified", cronExpression: "bad bad bad bad bad" } });
  assert.equal(invalidCron.ok, false);
  assert.equal(works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length, before, "bad schedules leave no partially-created Work");
  request("取消这个跟踪事项", work.workId);
  unwrap(await invoke("work_cancel", { workId: work.workId, versionGuard: await read(work.workId) }));
  assert.equal(works.getWork(work.workId)?.lifecycle, "closed");
  assert(dispatched.length >= 5);
  // An explicitly requested first check must still use the read-only timer path,
  // including when a separate one-shot future check is also requested.
  clock.at = Date.now();
  const immediate = unwrap(await invoke("work_create", { requestedOutcome: "one_time", title: "现在和明天各检查一次", mode: "watch", startImmediately: true,
    watchRule: { executionMode: "observe", scheduleBasis: "user_specified", nextWakeAt: clock.at + 24 * 60 * 60_000 } }));
  assert.equal(scheduled.length, 0);
  await queue.drain();
  const firstCheck = works.repo.listBindings(immediate.workId)[0];
  assert(firstCheck); assert.deepEqual(firstCheck.delegatedScope, ["workspace:read"]);
  assert(works.repo.listSubscriptions(immediate.workId)[0].nextWakeAt! > clock.at);
  // Retired scope labels are not an approval framework. The persisted task
  // purpose still matters: an observation cannot silently become a write/send.
  for (const actionKind of ["workspace:write", "send", "delegate"]) {
    const operationId = `watch-owner:${actionKind}`;
    assert.equal(typeof works.admitTaskAction(firstCheck.taskId, { operationId, actionKind }), "string",
      `persisted read-only observation rejects ${actionKind}`);
    assert(!works.repo.listAdmissions(immediate.workId).some(item => item.operationId === operationId),
      "rejected actions have no effect admission");
  }
  assert.equal(works.admitTaskAction(firstCheck.taskId, { operationId: "watch-owner:read", actionKind: "workspace:read" }), undefined);
  works.settleTaskAction(firstCheck.taskId, "watch-owner:read", "consumed");
  unwrap(works.reconcileExecution({ kind: "system", reason: "test interrupted check" }, {
    bindingId: firstCheck.bindingId, outcome: "failed", note: "read interrupted before producing a result" }));
  works.partialResults.recovery.markEvidenceRead(firstCheck.bindingId);
  const failedCheck = works.repo.getBinding(firstCheck.bindingId)!;
  works.transaction(() => assert(works.partialResults.recovery.prepare(works.getWork(immediate.workId)!, failedCheck, clock.at)));
  await queue.drain();
  const recovery = works.repo.listBindings(immediate.workId).find(item => item.bindingId !== firstCheck.bindingId)!;
  assert(recovery, "the interrupted check creates a real continuation binding");
  assert(works.partialResults.recovery.ancestry(recovery).some(item => item.bindingId === firstCheck.bindingId));
  for (const actionKind of ["workspace:write", "send", "delegate"])
    assert(works.admitTaskAction(recovery.taskId, { operationId: `readback:${actionKind}`, actionKind }),
      "dedicated result-readback recovery must not replay original business actions");
  assert.equal(works.admitTaskAction(recovery.taskId, { operationId: "readback:read", actionKind: "workspace:read" }), undefined);
  works.settleTaskAction(recovery.taskId, "readback:read", "consumed");
  settle(immediate.workId);
  // Continuous authorized execution is not observation: neither mode=watch nor
  // a legacy scope label may accidentally turn all ongoing work read-only.
  const continuous = unwrap(await invoke("work_create", { requestedOutcome: "ongoing", title: "持续完成当前可执行任务", mode: "watch", startImmediately: true }));
  await queue.drain();
  const continuousBinding = works.repo.listBindings(continuous.workId)[0];
  assert(continuousBinding);
  assert.equal(works.getWork(continuous.workId)?.watchRule?.executionMode, "continuous");
  assertUnrestrictedAdmission(continuousBinding.taskId, "continuous-execution");
  settle(continuous.workId);
  const expiredPause = unwrap(await invoke("work_create", { requestedOutcome: "one_time", title: "暂停期间到期后仍可取消", mode: "watch",
    watchRule: { scheduleBasis: "user_specified", nextWakeAt: clock.at + 60_000 }, deadlineAt: clock.at + 1000 }));
  request("暂停", expiredPause.workId);
  unwrap(await invoke("work_pause", { workId: expiredPause.workId, versionGuard: await read(expiredPause.workId) }));
  clock.at += 2000; works.tick(clock.at);
  assert(works.repo.listOpenBlockers(expiredPause.workId).some(item => item.reasonCode === "deadline-follow-up"));
  request("取消这个事项", expiredPause.workId);
  unwrap(await invoke("work_cancel", { workId: expiredPause.workId, versionGuard: await read(expiredPause.workId) }));
  assert.equal(works.getWork(expiredPause.workId)?.lifecycle, "closed", "past scheduling diagnostics cannot indefinitely prevent explicit cancellation");
  // Converting an ordinary item and changing its goal in the same request must
  // not schedule an unrestricted immediate run before the future read-only check.
  const ordinary = unwrap(await invoke("work_create", { requestedOutcome: "one_time", title: "普通事项", goalDescription: "原目标", mode: "once" }));
  await queue.drain(); settle(ordinary.workId);
  const schedulesBeforeConversion = scheduled.length;
  const bindingsBeforeConversion = works.repo.listBindings(ordinary.workId).length;
  request("改目标并从明天开始持续检查", ordinary.workId);
  const converted = unwrap(await invoke("work_amend", { workId: ordinary.workId,
    versionGuard: await read(ordinary.workId), goalDescription: "只在计划时间读取新目标进展",
    watchRule: { scheduleBasis: "user_specified", nextWakeAt: clock.at + 24 * 60 * 60_000 } }));
  assert.equal(converted.mode, "watch");
  assert.equal(scheduled.length, schedulesBeforeConversion, "once-to-watch plus new content must not enqueue ordinary execution");
  await queue.drain();
  assert.equal(works.repo.listBindings(ordinary.workId).length, bindingsBeforeConversion);
  for (const change of ["stop", "revise", "skip"] as const) {
    await checkPendingNativeBinding(change, false);
    await checkPendingNativeBinding(change, true);
  }
  await checkManualWatchGap();
  for (const outcome of ["completed", "failed", "pending"] as const) await checkStoppedWatchReadback(outcome);

  // Team work has its own coordinator. Adding a timer/deadline must fail at both
  // guarded entry points instead of silently installing a never-dispatched watch.
  const teamGrants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
  for (const botId of ["watch-team-owner", "watch-team-member"]) bots.registerBot({
    userId: LOCAL_USER_ID, botId, displayName: botId, authorization: teamGrants });
  const teamActor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: teamGrants };
  const formalTemplate = works.teams.handle(teamActor, { kind: "save_template", request: { operationId: "fixture-formal-team", name: "Formal fixture team",
    plan: { ownerBotId: "watch-team-owner", ownerResponsibility: "Summarize", members: [{ botId: "watch-team-member", responsibility: "Inspect", delegatedScope: ["workspace:read"] }] } } });
  assert(formalTemplate.ok && formalTemplate.template);
  const teamResult = works.teams.handle(teamActor, { kind: "create", request: { templateId: formalTemplate.template.templateId,
    operationId: "watch-team-create", title: "真实团队委托", goalDescription: "独立检查并汇总",
    workspacePath: root, ownerBotId: "watch-team-owner", ownerResponsibility: "只读汇总",
    members: [{ botId: "watch-team-member", responsibility: "只读检查", delegatedScope: ["workspace:read"] }],
    criteria: ["有来源的检查结果"],
  } });
  assert(teamResult.ok, JSON.stringify(teamResult));
  const teamWork = teamResult.work!; assert(works.teams.get(teamWork.workId));
  const rejectTeam = (result: { ok: boolean; message?: string }) => {
    assert.equal(result.ok, false); assert.match(result.message ?? "", /团队/);
  };
  rejectTeam(works.amendWork(teamActor, { operationId: "team-amend-watch", workId: teamWork.workId,
    versionGuard: guard(works.getWork(teamWork.workId)!), watchRule: { scheduleBasis: "user_specified", nextWakeAt: clock.at + 60_000 } }));
  rejectTeam(works.amendWork(teamActor, { operationId: "team-amend-deadline", workId: teamWork.workId,
    versionGuard: guard(works.getWork(teamWork.workId)!), deadlineAt: clock.at + 60_000 }));
  rejectTeam(works.phase4Control(teamActor, { kind: "configure-subscription", operationId: "team-configure-watch",
    workId: teamWork.workId, versionGuard: guard(works.getWork(teamWork.workId)!), source: "cron", catchUpPolicy: "latest",
    cronExpression: "0 9 * * *", timezone: "UTC" }));
  rejectTeam(works.phase4Control(teamActor, { kind: "set-deadline", operationId: "team-configure-deadline",
    workId: teamWork.workId, versionGuard: guard(works.getWork(teamWork.workId)!), deadlineAt: clock.at + 60_000 }));
  assert.equal(works.repo.listSubscriptions(teamWork.workId).length, 0);
  assert.equal(works.getWork(teamWork.workId)!.deadlineAt, undefined);
  assert.equal(works.getWork(teamWork.workId)!.mode, "once");
  console.log("PASS watch frontdoor: persisted schedule, read-only owner/recovery admission, native pending-binding stop/revision/policy guards, receipt recovery, once-to-watch amendment, team schedule rejection, disk reopen, dedupe, timezone, pause/resume, one-shot and deadlines");
} finally { await queue.close(); db.close(); await rm(root, { recursive: true, force: true }); }
