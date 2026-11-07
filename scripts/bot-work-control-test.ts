import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DESKTOP_USER_GRANTS, WorkService } from "../src/main/agent/work/WorkService";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import { runWorkRegressions } from "./bot-work-regressions";
import {
  DEFAULT_BOT_ID,
  LOCAL_USER_ID,
  type CreateWorkParams,
  type ExpectedVersionGuard,
  type WorkActor,
  type WorkAuthorizationDto,
  type WorkControlErrorCode,
  type WorkControlResult,
  type WorkDto,
  type WorkProjectionDto,
} from "../src/shared/bot-work";

const wide: WorkAuthorizationDto = {
  allowedScopes: ["workspace:read", "workspace:write"],
  targetWhitelist: [],
  allowGitBranchOrWorktree: false,
  allowRedelegation: true,
};

const root = mkdtempSync(join(tmpdir(), "mybuddy-bot-work-"));
const dbPath = join(root, "work.db");
const db = new AppDatabase(dbPath);
const projections: WorkProjectionDto[] = [];
const bots = new BotRegistry(db.connection);
bots.ensureDefaultBot(LOCAL_USER_ID);
const service = new WorkService(db.connection, {
  bots,
  emitProjection: (projection) => projections.push(projection),
});

function user(userId: string, grants: WorkAuthorizationDto = DESKTOP_USER_GRANTS): WorkActor {
  return { kind: "user", userId, entry: "desktop", grants };
}

function botActor(botId: string, userId: string, grants: WorkAuthorizationDto = DESKTOP_USER_GRANTS): WorkActor {
  return { kind: "bot", botId, userId, host: "foreground", grants };
}

function unwrap(result: WorkControlResult, label: string): Extract<WorkControlResult, { ok: true }> {
  if (!result.ok) throw new Error(`${label}: ${result.code} ${result.message}`);
  return result;
}

function expectCode(result: WorkControlResult, code: WorkControlErrorCode, label: string): void {
  assert.equal(result.ok, false, label);
  if (result.ok) return;
  assert.equal(result.code, code, `${label}: ${result.message}`);
}

function guardOf(work: WorkDto): ExpectedVersionGuard {
  return {
    expectedStateVersion: work.stateVersion,
    expectedIntentRevision: work.intentRevision,
    expectedOwnerEpoch: work.ownerEpoch,
  };
}

function snapshotRows(workId: string): Array<{ intent_revision: number; source_version: number }> {
  return db.connection.prepare(
    "SELECT intent_revision, source_version FROM work_intent_snapshots WHERE work_id=? ORDER BY intent_revision, source_version",
  ).all(workId) as Array<{ intent_revision: number; source_version: number }>;
}

function createWork(operationId: string, title: string, extra: Partial<CreateWorkParams> = {}): Extract<WorkControlResult, { ok: true }> {
  return unwrap(service.createWork(user(LOCAL_USER_ID, wide), {
    operationId,
    title,
    criteria: [{ id: `${operationId}-c`, text: "验收通过" }],
    inputSnapshotId: `input-${operationId}`,
    authorization: wide,
    ownerBotId: DEFAULT_BOT_ID,
    conversationId: `conv-${operationId}`,
    ...extra,
  }), operationId);
}

try {
  runWorkRegressions();
  assert.equal(db.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "opened database follows the current schema constant");
  const tasksBefore = (db.connection.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

  // P01 — same operation id, different body, different user.
  const p01Params: CreateWorkParams = {
    operationId: "p01-create",
    title: "甲",
    criteria: [{ id: "p01-c", text: "甲的条件" }],
    inputSnapshotId: "input-p01",
    ownerBotId: DEFAULT_BOT_ID,
  };
  const p01 = unwrap(service.createWork(user(LOCAL_USER_ID), p01Params), "P01 create");
  expectCode(service.createWork(user(LOCAL_USER_ID), { ...p01Params, criteria: [{ id: "p01-c", text: "乙的条件" }] }), "idempotency_conflict", "P01 nested criteria");
  expectCode(service.createWork(user(LOCAL_USER_ID), { ...p01Params, title: "乙" }), "idempotency_conflict", "P01 different title");
  const p01Replay = unwrap(service.createWork(user(LOCAL_USER_ID), p01Params), "P01 replay");
  assert.equal(p01Replay.replayed, true, "P01 replay");
  assert.equal(p01Replay.work.workId, p01.work.workId, "P01 replay returns the same work");
  assert.equal(service.listWorks(LOCAL_USER_ID).filter((item) => item.workId === p01.work.workId).length, 1, "P01 does not create a second work");
  bots.registerBot({ botId: "bot-other-user", userId: "user-other", displayName: "别人的 Bot" });
  const p01Other = unwrap(service.createWork(user("user-other"), {
    ...p01Params,
    title: "别人的事项",
    ownerBotId: "bot-other-user",
  }), "P01 other user");
  assert.notEqual(p01Other.work.workId, p01.work.workId, "P01 other user does not receive the first work");
  assert.equal(service.getWork(p01.work.workId)?.title, "甲", "P01 original title stays");
  assert.equal(service.listWorks("user-other").some((item) => item.workId === p01.work.workId), false, "P01 listing does not leak the other user's work");
  assert.equal((db.connection.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, tasksBefore, "creating a bot and a work does not insert a task");

  // P02 — an amend id cannot be replayed as cancel.
  const p02 = createWork("p02", "可取消的事项");
  unwrap(service.amendWork(user(LOCAL_USER_ID, wide), {
    operationId: "p02-shared",
    workId: p02.work.workId,
    progressSummary: "记了一笔",
  }), "P02 amend");
  expectCode(service.cancelWork(user(LOCAL_USER_ID, wide), {
    operationId: "p02-shared",
    workId: p02.work.workId,
    reason: "取消",
  }), "idempotency_conflict", "P02 cancel reuses amend id");
  assert.equal(service.getWork(p02.work.workId)?.lifecycle, "active", "P02 work stays active");
  assert.equal(snapshotRows(p02.work.workId).length, 1, "P02 progress amend does not insert another intent snapshot");

  // P03 — bot control needs a current version guard.
  const p03 = createWork("p03", "要改的事项");
  expectCode(service.pauseWork(botActor(DEFAULT_BOT_ID, LOCAL_USER_ID), {
    operationId: "p03-bare",
    workId: p03.work.workId,
  }), "invalid_request", "P03 pause without guard");
  unwrap(service.amendWork(user(LOCAL_USER_ID, wide), {
    operationId: "p03-amend",
    workId: p03.work.workId,
    title: "改过的要求",
  }), "P03 amend");
  expectCode(service.pauseWork(botActor(DEFAULT_BOT_ID, LOCAL_USER_ID), {
    operationId: "p03-stale",
    workId: p03.work.workId,
    versionGuard: { expectedStateVersion: p03.work.stateVersion, expectedIntentRevision: p03.work.intentRevision, expectedOwnerEpoch: p03.work.ownerEpoch },
  }), "version_conflict", "P03 stale pause");
  assert.equal(service.getWork(p03.work.workId)?.lifecycle, "active", "P03 stale pause does not pause");
  assert.equal(service.getWork(p03.work.workId)?.intentRevision, p03.work.intentRevision + 1, "P03 amend bumps intent");

  // P04 — another user's bot cannot pause this work.
  const p04 = createWork("p04", "别人不能停");
  expectCode(service.pauseWork(botActor("bot-other-user", "user-other"), {
    operationId: "p04-pause",
    workId: p04.work.workId,
    versionGuard: guardOf(p04.work),
  }), "not_found", "P04 other user");
  assert.equal(service.getWork(p04.work.workId)?.lifecycle, "active", "P04 work stays active");

  // P05 — a missing execution cannot submit a deliverable.
  const p05 = createWork("p05", "没有执行");
  expectCode(service.submitDeliverable(user(LOCAL_USER_ID, wide), {
    operationId: "p05-submit",
    workId: p05.work.workId,
    bindingId: "binding-missing",
    summary: "伪造成果",
  }), "unauthorized_actor", "P05 fake binding");
  assert.equal(service.getProjection(p05.work.workId)?.deliverables.length, 0, "P05 writes no deliverable");

  // P06 — editing criteria cannot mark them satisfied.
  const p06 = createWork("p06", "不能改写成通过");
  const p06Current = service.getWork(p06.work.workId)!;
  expectCode(service.amendWork(botActor(DEFAULT_BOT_ID, LOCAL_USER_ID, wide), {
    operationId: "p06-amend",
    workId: p06.work.workId,
    criteria: [{ id: "p06-c", text: "验收通过", status: "satisfied" }],
    versionGuard: guardOf(p06Current),
  }), "invalid_request", "P06 satisfied status");
  assert.equal(service.getWork(p06.work.workId)?.criteria[0]?.status, "pending", "P06 criterion stays pending");
  expectCode(service.closeWork(user(LOCAL_USER_ID, wide), {
    operationId: "p06-close",
    workId: p06.work.workId,
    conclusion: "succeeded",
  }), "unmet_acceptance_criteria", "P06 close");

  // P07 — write conflicts block acceptance and success.
  const p07 = createWork("p07", "写入被阻止");
  const p07Dispatch = unwrap(service.dispatchExecution(user(LOCAL_USER_ID, wide), {
    operationId: "p07-dispatch",
    workId: p07.work.workId,
    botId: DEFAULT_BOT_ID,
    taskId: "task-p07",
    durableStoreKey: "store-p07",
    conversationId: "conv-p07",
    workspaceBinding: "ws-p07",
  }), "P07 dispatch");
  const p07Binding = p07Dispatch.work.activeExecutionIds[0]!;
  unwrap(service.submitDeliverable({ kind: "worker", botId: DEFAULT_BOT_ID, bindingId: p07Binding }, {
    operationId: "p07-submit",
    workId: p07.work.workId,
    bindingId: p07Binding,
    deliverableId: "del-p07",
    summary: "有冲突的写入",
    hasWriteConflicts: true,
  }), "P07 submit");
  expectCode(service.acceptDeliverable(user(LOCAL_USER_ID, wide), {
    operationId: "p07-accept",
    workId: p07.work.workId,
    deliverableId: "del-p07",
  }), "unmet_acceptance_criteria", "P07 accept");
  unwrap(service.reconcileExecution(user(LOCAL_USER_ID, wide), { bindingId: p07Binding, outcome: "completed" }), "P07 reconcile");
  expectCode(service.closeWork(user(LOCAL_USER_ID, wide), {
    operationId: "p07-close",
    workId: p07.work.workId,
    conclusion: "succeeded",
  }), "unmet_acceptance_criteria", "P07 close");
  assert.equal(service.getWork(p07.work.workId)?.criteria[0]?.status, "pending", "P07 criterion stays pending");
  assert.equal(service.getWork(p07.work.workId)?.lifecycle, "active", "P07 stays open");

  // P08 — unsettled execution cannot reach closed.
  const p08 = createWork("p08", "在途执行");
  const p08Dispatch = unwrap(service.dispatchExecution(user(LOCAL_USER_ID, wide), {
    operationId: "p08-dispatch",
    workId: p08.work.workId,
    botId: DEFAULT_BOT_ID,
    taskId: "task-p08",
    durableStoreKey: "store-p08",
    conversationId: "conv-p08",
    workspaceBinding: "ws-p08",
  }), "P08 dispatch");
  const p08Binding = p08Dispatch.work.activeExecutionIds[0]!;
  const p08Cancel = unwrap(service.cancelWork(user(LOCAL_USER_ID, wide), {
    operationId: "p08-cancel",
    workId: p08.work.workId,
    reason: "停止",
  }), "P08 cancel");
  assert.equal(p08Cancel.work.lifecycle, "closing", "P08 cancel stays closing");
  assert.equal(p08Cancel.work.closureConclusion, undefined, "P08 has no final conclusion yet");
  const p08Close = createWork("p08b", "在途关闭");
  const p08CloseDispatch = unwrap(service.dispatchExecution(user(LOCAL_USER_ID, wide), {
    operationId: "p08b-dispatch",
    workId: p08Close.work.workId,
    botId: DEFAULT_BOT_ID,
    taskId: "task-p08b",
    durableStoreKey: "store-p08b",
    conversationId: "conv-p08b",
    workspaceBinding: "ws-p08b",
  }), "P08 close dispatch");
  const p08ClosedAttempt = unwrap(service.closeWork(user(LOCAL_USER_ID, wide), {
    operationId: "p08b-close",
    workId: p08Close.work.workId,
    conclusion: "cancelled",
    closureSummary: "取消",
  }), "P08 close cancelled");
  assert.equal(p08ClosedAttempt.work.lifecycle, "closing", "P08 close cancelled stays closing");
  const p08Settled = unwrap(service.reconcileExecution(user(LOCAL_USER_ID, wide), {
    bindingId: p08Binding,
    outcome: "completed",
  }), "P08 settle");
  assert.equal(p08Settled.work.lifecycle, "closed", "P08 closes only after settlement");
  assert.equal(p08Settled.work.closureConclusion, "cancelled", "P08 keeps the pending cancellation");

  // P09 — unknown external effect survives cancel.
  const p09 = createWork("p09", "未知外部效果");
  const p09Dispatch = unwrap(service.dispatchExecution(user(LOCAL_USER_ID, wide), {
    operationId: "p09-dispatch",
    workId: p09.work.workId,
    botId: DEFAULT_BOT_ID,
    taskId: "task-p09",
    durableStoreKey: "store-p09",
    conversationId: "conv-p09",
    workspaceBinding: "ws-p09",
  }), "P09 dispatch");
  const p09Binding = p09Dispatch.work.activeExecutionIds[0]!;
  unwrap(service.reconcileExecution(user(LOCAL_USER_ID, wide), {
    bindingId: p09Binding,
    outcome: "unknown",
    unknownExternalEffectRef: "ext-p09",
  }), "P09 unknown");
  const p09Cancel = unwrap(service.cancelWork(user(LOCAL_USER_ID, wide), {
    operationId: "p09-cancel",
    workId: p09.work.workId,
    reason: "取消",
  }), "P09 cancel");
  assert.equal(p09Cancel.work.lifecycle, "closing", "P09 stays closing");
  assert.notEqual(p09Cancel.work.lifecycle, "closed", "P09 is not closed");
  assert.equal(service.getProjection(p09.work.workId)?.blockers.some((blocker) => blocker.status === "open"), true, "P09 keeps the open blocker");

  // P10 — handoff does not reject the old worker's own deliverable.
  bots.registerBot({ botId: "bot-worker", userId: LOCAL_USER_ID, displayName: "执行 Bot" });
  bots.registerBot({ botId: "bot-next", userId: LOCAL_USER_ID, displayName: "下一任", authorization: wide });
  const p10 = createWork("p10", "交接后仍可提交", { ownerBotId: DEFAULT_BOT_ID });
  const p10Dispatch = unwrap(service.dispatchExecution(user(LOCAL_USER_ID, wide), {
    operationId: "p10-dispatch",
    workId: p10.work.workId,
    botId: "bot-worker",
    taskId: "task-p10",
    durableStoreKey: "store-p10",
    conversationId: "conv-p10",
    workspaceBinding: "ws-p10",
  }), "P10 dispatch");
  const p10Binding = p10Dispatch.work.activeExecutionIds[0]!;
  unwrap(service.handoffOwner(user(LOCAL_USER_ID, wide), {
    operationId: "p10-handoff",
    workId: p10.work.workId,
    targetBotId: "bot-next",
  }), "P10 handoff");
  unwrap(service.submitDeliverable({ kind: "worker", botId: "bot-worker", bindingId: p10Binding }, {
    operationId: "p10-submit",
    workId: p10.work.workId,
    bindingId: p10Binding,
    deliverableId: "del-p10",
    summary: "交接前就开始的成果",
  }), "P10 submit");
  const p10Deliverable = service.getProjection(p10.work.workId)?.deliverables.find((item) => item.deliverableId === "del-p10");
  assert.equal(p10Deliverable?.status, "proposed", "P10 deliverable stays current");
  assert.equal(p10Deliverable?.ownerEpoch, 1, "P10 deliverable keeps the binding epoch");
  assert.equal(service.getWork(p10.work.workId)?.ownerEpoch, 2, "P10 owner epoch advanced");
  const p10Now = service.getWork(p10.work.workId)!;
  expectCode(service.pauseWork(botActor(DEFAULT_BOT_ID, LOCAL_USER_ID, wide), {
    operationId: "p10-old-pause",
    workId: p10.work.workId,
    versionGuard: guardOf(p10Now),
  }), "unauthorized_actor", "P10 old owner");
  assert.equal(service.getWork(p10.work.workId)?.ownerBotId, "bot-next", "P10 owner stays with the new bot");

  // P11 — a result from the previous requirement is historical.
  const p11 = createWork("p11", "旧要求");
  const p11Dispatch = unwrap(service.dispatchExecution(user(LOCAL_USER_ID, wide), {
    operationId: "p11-dispatch",
    workId: p11.work.workId,
    botId: DEFAULT_BOT_ID,
    taskId: "task-p11",
    durableStoreKey: "store-p11",
    conversationId: "conv-p11",
    workspaceBinding: "ws-p11",
  }), "P11 dispatch");
  const p11Binding = p11Dispatch.work.activeExecutionIds[0]!;
  unwrap(service.amendWork(user(LOCAL_USER_ID, wide), {
    operationId: "p11-amend",
    workId: p11.work.workId,
    title: "新要求",
  }), "P11 amend");
  unwrap(service.submitDeliverable({ kind: "worker", botId: DEFAULT_BOT_ID, bindingId: p11Binding }, {
    operationId: "p11-submit",
    workId: p11.work.workId,
    bindingId: p11Binding,
    deliverableId: "del-p11",
    summary: "按旧要求做完",
  }), "P11 submit");
  const p11Deliverable = service.getProjection(p11.work.workId)?.deliverables.find((item) => item.deliverableId === "del-p11");
  assert.equal(p11Deliverable?.status, "superseded", "P11 deliverable is historical");
  assert.equal(p11Deliverable?.intentRevision, 1, "P11 deliverable keeps the binding requirement");
  expectCode(service.acceptDeliverable(user(LOCAL_USER_ID, wide), {
    operationId: "p11-accept",
    workId: p11.work.workId,
    deliverableId: "del-p11",
  }), "version_conflict", "P11 accept");
  assert.equal(service.getWork(p11.work.workId)?.criteria[0]?.status, "pending", "P11 current criterion stays pending");
  assert.equal(service.getWork(p11.work.workId)?.intentRevision, 2, "P11 current requirement is the new one");

  // P12 — a later close cannot rewrite a finished conclusion.
  const p12 = createWork("p12", "将要完成");
  unwrap(service.attestCriteria(user(LOCAL_USER_ID, wide), {
    operationId: "p12-attest",
    workId: p12.work.workId,
    criterionUpdates: [{ criterionId: "p12-c", status: "met", evidence: "用户确认" }],
  }), "P12 attest");
  const p12Close = unwrap(service.closeWork(user(LOCAL_USER_ID, wide), {
    operationId: "p12-close",
    workId: p12.work.workId,
    conclusion: "succeeded",
    closureSummary: "完成",
  }), "P12 close");
  assert.equal(p12Close.work.closureConclusion, "succeeded", "P12 succeeded");
  const p12ClosedAt = p12Close.work.closedAt;
  expectCode(service.closeWork(user(LOCAL_USER_ID, wide), {
    operationId: "p12-rewrite",
    workId: p12.work.workId,
    conclusion: "cancelled",
    closureSummary: "改写成取消",
  }), "invalid_lifecycle_transition", "P12 rewrite");
  const p12Latest = service.getWork(p12.work.workId);
  assert.equal(p12Latest?.closureConclusion, "succeeded", "P12 conclusion stays succeeded");
  assert.equal(p12Latest?.closedAt, p12ClosedAt, "P12 close time stays");
  const p12Replay = unwrap(service.closeWork(user(LOCAL_USER_ID, wide), {
    operationId: "p12-close",
    workId: p12.work.workId,
    conclusion: "succeeded",
    closureSummary: "完成",
  }), "P12 replay");
  assert.equal(p12Replay.replayed, true, "P12 replay uses the receipt");
  assert.equal(service.getWork(p12.work.workId)?.closureConclusion, "succeeded", "P12 replay does not rewrite");

  // P13 — replaying pause returns the old receipt and does not emit it as current.
  const p13 = createWork("p13", "会暂停再恢复");
  const p13Pause = unwrap(service.pauseWork(user(LOCAL_USER_ID, wide), {
    operationId: "p13-pause",
    workId: p13.work.workId,
    reason: "先停",
  }), "P13 pause");
  assert.equal(p13Pause.work.lifecycle, "paused", "P13 paused");
  unwrap(service.resumeWork(user(LOCAL_USER_ID, wide), {
    operationId: "p13-resume",
    workId: p13.work.workId,
  }), "P13 resume");
  const p13Emitted = projections.filter((item) => item.workId === p13.work.workId);
  const p13EmitCount = p13Emitted.length;
  assert.equal(p13Emitted.at(-1)?.lifecycle, "active", "P13 last projection is active");
  const p13Replay = unwrap(service.pauseWork(user(LOCAL_USER_ID, wide), {
    operationId: "p13-pause",
    workId: p13.work.workId,
    reason: "先停",
  }), "P13 replay");
  assert.equal(p13Replay.replayed, true, "P13 replay");
  assert.equal(p13Replay.work.lifecycle, "paused", "P13 receipt keeps the historical pause");
  assert.equal(service.getWork(p13.work.workId)?.lifecycle, "active", "P13 current fact stays active");
  const p13After = projections.filter((item) => item.workId === p13.work.workId);
  assert.equal(p13After.length, p13EmitCount, "P13 replay emits nothing");
  assert.equal(p13After.at(-1)?.lifecycle, "active", "P13 current projection stays active");

  // R06 — same requirement, newer source. Late feedback for A does not pass B.
  const r06Input = "input-r06-a";
  const r06 = createWork("r06", "检查最新版本", {
    inputSnapshotId: r06Input,
    criteria: [{ id: "r06-c", text: "最新版本通过", requiresRealEnvironmentCheck: true, requiredEnvironment: "omarchy" }],
  });
  unwrap(service.amendWork(user(LOCAL_USER_ID, wide), {
    operationId: "r06-source",
    workId: r06.work.workId,
    inputSnapshotId: "input-r06-b",
  }), "R06 new source");
  const r06AfterSource = service.getWork(r06.work.workId)!;
  assert.equal(r06AfterSource.intentRevision, 1, "R06 source change does not bump the requirement");
  assert.equal(r06AfterSource.sourceVersion, 2, "R06 source version advances");
  assert.deepEqual(snapshotRows(r06.work.workId), [
    { intent_revision: 1, source_version: 1 },
    { intent_revision: 1, source_version: 2 },
  ], "R06 keeps both source snapshots");
  unwrap(service.recordUserFeedback(user(LOCAL_USER_ID, wide), {
    operationId: "r06-feedback-a",
    workId: r06.work.workId,
    criterionIds: ["r06-c"],
    environment: "omarchy",
    sourceRef: "commit-a",
    sourceSha: "sha-a",
    inputSnapshotId: r06Input,
    failed: false,
    detail: "A 的实测晚到",
  }), "R06 feedback A");
  assert.equal(service.getWork(r06.work.workId)?.criteria[0]?.status, "pending", "R06 A does not satisfy B");
  unwrap(service.recordUserFeedback(user(LOCAL_USER_ID, wide), {
    operationId: "r06-feedback-b",
    workId: r06.work.workId,
    criterionIds: ["r06-c"],
    environment: "omarchy",
    sourceRef: "commit-b",
    sourceSha: "sha-b",
    inputSnapshotId: "input-r06-b",
    failed: false,
    detail: "B 的实测",
  }), "R06 feedback B");
  assert.equal(service.getWork(r06.work.workId)?.criteria[0]?.status, "satisfied", "R06 B satisfies the current source");
  const r06Evidence = db.connection.prepare(
    "SELECT input_snapshot_id FROM work_evidence WHERE work_id=? ORDER BY recorded_at",
  ).all(r06.work.workId) as Array<{ input_snapshot_id: string }>;
  assert.deepEqual(r06Evidence.map((row) => row.input_snapshot_id), [r06Input, "input-r06-b"], "R06 evidence keeps both tested snapshots");

  // Desktop grants stay inside the host envelope. A new bot does not grow them.
  const desktop = unwrap(service.createWork(user(LOCAL_USER_ID), {
    operationId: "desktop-plain",
    title: "桌面默认授权",
    ownerBotId: DEFAULT_BOT_ID,
    authorization: { allowGitBranchOrWorktree: true, allowRedelegation: true },
  }), "desktop grants");
  assert.equal(desktop.work.authorization.allowGitBranchOrWorktree, false, "desktop grants do not add branch permission");
  assert.equal(desktop.work.authorization.allowRedelegation, false, "desktop grants do not add redelegation");
  assert.deepEqual(desktop.work.authorization.allowedScopes, ["workspace:read"], "desktop grants default to read when no write scope is requested");
  expectCode(service.dispatchExecution(user(LOCAL_USER_ID), {
    operationId: "desktop-dispatch",
    workId: desktop.work.workId,
    botId: DEFAULT_BOT_ID,
    taskId: "task-desktop",
    durableStoreKey: "store-desktop",
    conversationId: "conv-desktop",
    workspaceBinding: "ws-desktop",
  }), "unauthorized_actor", "read-only work cannot dispatch a write");
  const desktopWrite = unwrap(service.createWork(user(LOCAL_USER_ID), {
    operationId: "desktop-write",
    title: "桌面写入授权",
    ownerBotId: DEFAULT_BOT_ID,
    authorization: { allowedScopes: ["workspace:read", "workspace:write"], allowRedelegation: true },
  }), "desktop write overlap");
  assert.deepEqual(desktopWrite.work.authorization.allowedScopes, ["workspace:read", "workspace:write"], "desktop grants keep the overlapping write scope");
  assert.equal(desktopWrite.work.authorization.allowRedelegation, false, "write overlap still cannot add redelegation");

  // R09 — adopt the reviewed version, and leave an in-flight snapshot alone.
  bots.registerBot({ botId: "bot-expert", userId: LOCAL_USER_ID, displayName: "专家 Bot" });
  const expertWork = createWork("expert", "在途配置", { ownerBotId: DEFAULT_BOT_ID });
  const expertDispatch = unwrap(service.dispatchExecution(user(LOCAL_USER_ID, wide), {
    operationId: "expert-dispatch",
    workId: expertWork.work.workId,
    botId: "bot-expert",
    taskId: "task-expert",
    durableStoreKey: "store-expert",
    conversationId: "conv-expert",
    workspaceBinding: "ws-expert",
  }), "R09 dispatch");
  const expertHashBefore = service.getProjection(expertWork.work.workId)?.executions[0]?.expertSnapshot.systemPromptHash;
  const stagedOld = bots.stageExpertVersion("bot-expert", {
    expertId: "expert-duty",
    sourceRevision: "rev-2",
    systemPromptHash: "hash-v2",
    allowedMcpIds: ["mcp-old"],
    allowedSkillIds: ["skill-old"],
    stagedBy: LOCAL_USER_ID,
  });
  assert.equal(stagedOld.ok, true, "R09 stage v2");
  if (!stagedOld.ok) throw new Error("stage");
  const stagedNew = bots.stageExpertVersion("bot-expert", {
    expertId: "expert-duty",
    sourceRevision: "rev-3",
    systemPromptHash: "hash-v3",
    allowedMcpIds: ["mcp-new"],
    allowedSkillIds: ["skill-new"],
    allowedConnectorIds: ["connector-new"],
    stagedBy: LOCAL_USER_ID,
  });
  assert.equal(stagedNew.ok, true, "R09 stage v3");
  if (!stagedNew.ok) throw new Error("stage");
  const adoptOld = bots.adoptExpertVersion("bot-expert", { pendingVersion: stagedOld.pendingVersion, snapshotId: `expert:bot-expert:v${stagedOld.pendingVersion}` });
  assert.equal(adoptOld.ok, false, "R09 old version conflicts");
  if (!adoptOld.ok) assert.equal(adoptOld.code, "version_conflict", adoptOld.message);
  const adoptNew = bots.adoptExpertVersion("bot-expert", { pendingVersion: stagedNew.pendingVersion });
  assert.equal(adoptNew.ok, true, "R09 adopt current");
  const expertBot = bots.getBot("bot-expert");
  assert.equal(expertBot?.expertProfile.activeVersion, stagedNew.pendingVersion, "R09 active version");
  assert.equal(expertBot?.expertProfile.systemPromptHash, "hash-v3", "R09 hash matches the adopted row");
  assert.deepEqual(expertBot?.expertProfile.allowedMcpIds, ["mcp-new"], "R09 capability list matches the adopted row");
  assert.equal(service.getProjection(expertWork.work.workId)?.executions[0]?.expertSnapshot.systemPromptHash, expertHashBefore, "R09 in-flight execution keeps its snapshot");
  assert.equal(expertDispatch.work.activeExecutionIds.length, 1, "R09 dispatch kept one binding");
  assert.equal(bots.getBot(DEFAULT_BOT_ID)?.expertProfile.systemPromptHash === "hash-v3", false, "R09 does not rewrite another bot");

  // R08 — disable keeps the work; archive and reopen keep it too.
  bots.registerBot({ botId: "bot-hold", userId: LOCAL_USER_ID, displayName: "值班" });
  const held = createWork("hold", "停用后仍负责", { ownerBotId: "bot-hold", conversationId: "task-hold", legacyTaskId: "task-hold" });
  db.upsertTask({ id: "task-hold", title: "会被归档的对话", updatedAt: Date.now() });
  const disabled = bots.disableBot("bot-hold");
  assert.equal(disabled.ok, true, "R08 disable");
  assert.equal(disabled.affectedActiveWorkIds.includes(held.work.workId), true, "R08 reports the work still held");
  assert.equal(service.getWork(held.work.workId)?.lifecycle, "active", "R08 disable does not close the work");
  assert.equal(service.getWork(held.work.workId)?.ownerBotId, "bot-hold", "R08 owner stays");
  expectCode(service.dispatchExecution(user(LOCAL_USER_ID, wide), {
    operationId: "hold-dispatch",
    workId: held.work.workId,
    botId: "bot-hold",
    taskId: "task-hold-exec",
    durableStoreKey: "store-hold",
    conversationId: "conv-hold",
    workspaceBinding: "ws-hold",
  }), "bot_disabled", "R08 disabled bot cannot take new execution");
  const deleted = bots.deleteBot("bot-hold");
  assert.equal(deleted.ok, false, "R08 delete refused");
  if (!deleted.ok) assert.equal(deleted.code, "has_responsibility", deleted.message);
  db.archiveTask("task-hold", true);
  assert.equal(service.getWork(held.work.workId)?.title, "停用后仍负责", "R08 archive keeps the work");
  assert.equal(service.listWorksByConversation("task-hold").some((item) => item.workId === held.work.workId), true, "R08 conversation link stays");

  const goals = new ConversationGoalService(service, () => {}, { userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID });
  db.upsertTask({ id: "task-goal", title: "目标对话", updatedAt: Date.now() });
  const goal = goals.create({ taskId: "task-goal", title: "交付", criteria: [{ text: "类型检查通过" }] });
  if (!goal.ok) throw new Error(goal.message);
  const progressed = goals.update({
    goalId: goal.goal.id,
    progressSummary: "主链完成",
    criterionUpdates: [{ id: goal.goal.criteria[0]!.id, status: "met", evidence: "typecheck" }],
  });
  if (!progressed.ok) throw new Error(progressed.message);
  assert.equal(snapshotRows(goal.goal.id).length, 1, "goal progress shares the create snapshot");

  const heldTitle = service.getWork(held.work.workId)?.title;
  db.close();
  const reopened = new AppDatabase(dbPath);
  try {
    assert.equal(reopened.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "reopen keeps the current schema");
    const again = new WorkService(reopened.connection, { bots: new BotRegistry(reopened.connection) });
    assert.equal(again.getWork(held.work.workId)?.title, heldTitle, "reopen keeps the work");
    assert.equal(again.getWork(held.work.workId)?.ownerBotId, "bot-hold", "reopen keeps ownership");
  } finally {
    reopened.close();
  }

  console.log("bot work control tests: ok");
} finally {
  try { db.close(); } catch { /* already closed on the reopen path */ }
  rmSync(root, { recursive: true, force: true });
}
