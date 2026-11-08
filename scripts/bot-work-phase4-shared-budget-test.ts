import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";
import type { WorkPhase4ControlRequest } from "../src/shared/bot-work-phase4";

const root = await mkdtemp(join(tmpdir(), "phase4-budget-"));
const path = join(root, "business.db");
const clock = { at: Date.UTC(2026, 0, 20, 12, 0, 0) };
let db = new AppDatabase(path);
const secondDb = new AppDatabase(path);
const makeBots = (database: AppDatabase) => {
  const registry = new BotRegistry(database.connection);
  registry.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
  return registry;
};
let bots = makeBots(db);
const secondBots = makeBots(secondDb);
let works = new WorkService(db.connection, { bots, now: () => clock.at });
const secondWorks = new WorkService(secondDb.connection, { bots: secondBots, now: () => clock.at });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw Error(`${result.code}: ${result.message}`); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const create = (id: string, budget = 100) => unwrap(works.createWork(user, { operationId: id, title: id, inputSnapshotId: `input:${id}`,
  authorization: DESKTOP_USER_GRANTS, workspacePath: root, budget: { maxTokens: budget } }));
const available = (work: WorkDto) => works.budget.summary(work.workId).window.availableTokens;
const reconciliation = (workId: string, reservationId: string, reportedTokens: number,
  resolution: "committed" | "released" = "committed"): Extract<WorkPhase4ControlRequest, { kind: "reconcile-budget-reservation" }> => ({
  kind: "reconcile-budget-reservation", operationId: `reconcile:${reservationId}`, workId, reservationId,
  windowId: works.repo.getReservation(reservationId)!.windowId, resolution, reportedTokens,
  reason: "已核对该请求的供应商账单", evidenceRef: `fixture-receipt:${reservationId}`,
  versionGuard: guard(works.getWork(workId)!),
});
const rejected = (request: unknown, code: string, actor: WorkActor = user) => {
  const result = works.phase4Control(actor, request);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, code);
};
const configureWindow = (work: WorkDto) => {
  assert.equal(works.phase4Control(user, { kind: "set-budget-policy", operationId: `policy:${work.workId}`, workId: work.workId,
    maxTokens: 100, windowMs: 60_000, autoRollover: true, versionGuard: guard(works.getWork(work.workId)!) }).ok, true);
};

try {
  const shared = create("shared-budget");
  assert.equal(available(shared), 100);
  // Two independent SQLite connections share one ledger: the last slot cannot be double-assigned.
  const first = works.budget.reserve({ workId: shared.workId, reservationId: "last-slot", tokens: 100 });
  assert.equal(first.ok, true);
  const second = secondWorks.budget.reserve({ workId: shared.workId, reservationId: "other-slot", tokens: 1 });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "budget_exhausted");
  assert.equal(available(shared), 0);
  works.budget.release(shared.workId, "last-slot");
  assert.equal(available(shared), 100);
  // A persisted user policy change opens a new ledger window; it never clears the old facts.
  const raised = works.phase4Control(user, { kind: "set-budget-policy", operationId: "raise-budget", workId: shared.workId,
    maxTokens: 500, versionGuard: guard(works.getWork(shared.workId)!) });
  assert.equal(raised.ok, true);
  assert.equal(available(shared), 500);

  // Root, owned child, independent expert root and compaction all resolve to the same Work window.
  unwrap(works.dispatchExecution(user, { operationId: "root-dispatch", workId: shared.workId, botId: DEFAULT_BOT_ID,
    taskId: "root-task", durableStoreKey: "store:root", conversationId: "1", workspaceBinding: root, reserveTokens: 20 }));
  const rootBinding = works.repo.bindingForTask("root-task")!;
  assert.equal(works.repo.getReservation(rootBinding.reservationId!)!.state, "reserved");
  const rootRequest = works.budget.admitProviderRequest({ taskId: "root-task", conversationId: "1", generationTaskId: 1,
    sourceKind: "main", estimatedTokens: 20 });
  assert.equal(rootRequest.allowed, true);
  assert.equal(works.repo.getReservation(rootBinding.reservationId!)!.state, "released", "the dispatch envelope is replaced, not double charged");
  const childRequest = works.budget.admitProviderRequest({ taskId: "root-task", conversationId: "2", generationTaskId: 2,
    sourceKind: "subagent", estimatedTokens: 15 });
  assert.equal(childRequest.allowed, true);
  unwrap(works.dispatchExecution(user, { operationId: "expert-dispatch", workId: shared.workId, botId: DEFAULT_BOT_ID,
    taskId: "expert-task", durableStoreKey: "store:expert", conversationId: "3", workspaceBinding: root }));
  const expertRequest = works.budget.admitProviderRequest({ taskId: "expert-task", conversationId: "3", generationTaskId: 3,
    sourceKind: "main", estimatedTokens: 10 });
  assert.equal(expertRequest.allowed, true);
  const compactionRequest = works.budget.admitProviderRequest({ taskId: "root-task", conversationId: "1", generationTaskId: -2,
    sourceKind: "main", requestKind: "compaction", estimatedTokens: 5 });
  assert.equal(compactionRequest.allowed, true);
  const window = works.budget.summary(shared.workId).window;
  const requests = works.budget.listRequests(shared.workId);
  assert.equal(new Set(requests.map(item => item.window_id)).size, 1, "all collaborators share one durable window");
  assert.equal(requests.length, 4);
  assert.equal(window.reservedTokens, 20 + 15 + 10 + 5);
  assert.equal(window.availableTokens, 500 - window.committedTokens - window.reservedTokens - window.unknownTokens);

  // Replayed reservation identity is idempotent; a real retry gets a new identity.
  const replay = works.budget.reserve({ workId: shared.workId, reservationId: rootRequest.reservationId!, tokens: 20 });
  assert.equal(replay.ok, true);
  assert.equal(works.budget.listRequests(shared.workId).length, 4);
  const retry = works.budget.admitProviderRequest({ taskId: "root-task", conversationId: "1", generationTaskId: 1,
    sourceKind: "main", estimatedTokens: 20 });
  assert.equal(retry.allowed, true);
  assert.equal(works.budget.listRequests(shared.workId).length, 5, "a genuinely new provider request gets a new reservation");

  // Unknown is not zero and is not released.
  const unknown = works.budget.reserve({ workId: shared.workId, reservationId: "unknown-usage", tokens: 7 });
  assert.equal(unknown.ok, true);
  const beforeUnknown = available(shared);
  works.budget.commit(shared.workId, "unknown-usage");
  assert.equal(works.budget.summary(shared.workId).window.unknownTokens, 7);
  assert.equal(available(shared), beforeUnknown - 0, "unknown keeps the same reserved upper bound, never zero consumption");
  assert.equal(works.repo.getReservation("unknown-usage")!.state, "unknown");

  // Framework-synthesized zero is unknown; a trusted explicit zero is a real committed zero.
  const synth = works.budget.reserve({ workId: shared.workId, reservationId: "synth-zero", tokens: 9 });
  assert.equal(synth.ok, true);
  works.budget.settleProviderUsage({ taskId: "root-task", conversationId: "1", generationTaskId: 99, reported: false,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(works.repo.getReservation("synth-zero")!.state, "reserved", "no matching request receipt leaves the reservation in place");
  const explicit = works.budget.reserve({ workId: shared.workId, reservationId: "explicit-zero", tokens: 6 });
  assert.equal(explicit.ok, true);

  // Actual usage above the reservation is not clamped; the delta is fully committed.
  const over = works.budget.reserve({ workId: shared.workId, reservationId: "over-usage", tokens: 10 });
  assert.equal(over.ok, true);
  assert.equal(works.budget.commit(shared.workId, "over-usage", 25).ok, true);
  assert.equal(works.repo.getReservation("over-usage")!.reportedTokens, 25);
  assert.equal(works.getWork(shared.workId)!.budget.committedTokens, 25);

  // Native summary settlement of the released envelope never charges a second time.
  const usedBefore = works.getWork(shared.workId)!.budget.usedTokens;
  assert.equal(works.commitBudgetUsage(shared.workId, rootBinding.reservationId!, 999).ok, true);
  assert.equal(works.getWork(shared.workId)!.budget.usedTokens, usedBefore);

  // Trusted generation receipts settle through the same ledger once.
  const settleTarget = works.budget.listRequests(shared.workId).find(item => item.metering === "reserved")!;
  const actual = 11;
  works.budget.settleProviderUsage({ taskId: settleTarget.task_id, conversationId: settleTarget.conversation_id!,
    generationTaskId: settleTarget.generation_task_id!, reported: true, inputTokens: actual, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0 });
  const targetReservation = works.repo.listReservations(shared.workId).find(item => item.attemptIdentity === settleTarget.attempt_identity)!;
  assert.equal(targetReservation.state, "committed"); assert.equal(targetReservation.reportedTokens, actual);
  works.budget.settleProviderUsage({ taskId: settleTarget.task_id, conversationId: settleTarget.conversation_id!,
    generationTaskId: settleTarget.generation_task_id!, reported: true, inputTokens: actual, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(works.getWork(shared.workId)!.budget.committedTokens, 25 + actual, "the same receipt is idempotent");

  // Window policy: persisted boundaries, no early rollover, no accumulation after missed periods.
  const windowed = create("windowed", 100);
  const policy = works.phase4Control(user, { kind: "set-budget-policy", operationId: "budget-policy", workId: windowed.workId,
    maxTokens: 100, windowMs: 60_000, timezone: "UTC", autoRollover: true, versionGuard: guard(works.getWork(windowed.workId)!) });
  assert.equal(policy.ok, true);
  const firstWindow = works.getWork(windowed.workId)!.budget.windowId;
  assert(works.budget.reserve({ workId: windowed.workId, reservationId: "window-1", tokens: 30 }).ok);
  assert.equal(works.budget.rollover(works.getWork(windowed.workId)!, clock.at + 1_000).ok, false, "outstanding reservations block rollover");
  works.budget.commit(windowed.workId, "window-1", 30);
  clock.at += 5 * 60_000;
  const rolled = works.budget.rollover(works.getWork(windowed.workId)!, clock.at);
  assert.equal(rolled.ok, true);
  assert.notEqual(works.getWork(windowed.workId)!.budget.windowId, firstWindow);
  assert.equal(works.getWork(windowed.workId)!.budget.usedTokens, 0);
  assert.equal(works.budget.listWindows(windowed.workId).filter(item => item.status === "open").length, 1,
    "a multi-period jump opens only the current legal window");
  assert.equal(works.budget.rollover(works.getWork(windowed.workId)!, clock.at).ok, false, "the same period is never opened twice");

  // Explicit reconciliation is guarded, audited and atomic with the operation receipt.
  const review = create("explicit-reconciliation"); configureWindow(review);
  assert(works.budget.reserve({ workId: review.workId, reservationId: "review-unknown", tokens: 30 }).ok);
  assert(works.budget.commit(review.workId, "review-unknown").ok);
  const beforeReview = works.getWork(review.workId)!;
  const request = reconciliation(review.workId, "review-unknown", 17);
  const pending = works.budget.snapshot(review.workId).unknownReservations!;
  assert.equal(pending.length, 1); assert.equal(pending[0].reservationId, request.reservationId);
  assert.equal(pending[0].windowId, request.windowId); assert.equal(pending[0].tokens, 30);
  assert.equal(works.budget.release(review.workId, request.reservationId).ok, false, "ordinary release cannot assume unknown is zero");
  rejected({ ...request, versionGuard: undefined }, "invalid_request");
  rejected({ ...request, versionGuard: { expectedStateVersion: beforeReview.stateVersion } }, "invalid_request");
  rejected({ ...request, reason: "  " }, "invalid_request");
  rejected({ ...request, evidenceRef: "  " }, "invalid_request");
  rejected({ ...request, reportedTokens: -1 }, "invalid_request");
  rejected({ ...request, resolution: "released", reportedTokens: 1 }, "invalid_request");
  rejected({ ...request, windowId: shared.budget.windowId }, "not_found");
  rejected({ ...request, workId: shared.workId, versionGuard: guard(works.getWork(shared.workId)!) }, "not_found");
  rejected({ ...request, versionGuard: { ...request.versionGuard, expectedStateVersion: beforeReview.stateVersion + 1 } }, "version_conflict");
  rejected({ ...request, versionGuard: { ...request.versionGuard, expectedIntentRevision: beforeReview.intentRevision + 1 } }, "version_conflict");
  rejected({ ...request, versionGuard: { ...request.versionGuard, expectedOwnerEpoch: beforeReview.ownerEpoch + 1 } }, "epoch_mismatch");
  bots.registerBot({ botId: "budget-outsider", userId: LOCAL_USER_ID, displayName: "other bot", authorization: DESKTOP_USER_GRANTS });
  const outsider: WorkActor = { kind: "bot", userId: LOCAL_USER_ID, botId: "budget-outsider", host: "foreground", grants: DESKTOP_USER_GRANTS };
  rejected(request, "unauthorized_actor", outsider);
  const readOnlyHost = new WorkService(secondDb.connection, { bots: secondBots, now: () => clock.at, isAuthority: () => false });
  assert.equal(readOnlyHost.phase4Control(user, request).ok, false);
  db.connection.exec(`CREATE TEMP TRIGGER fail_budget_receipt BEFORE INSERT ON work_operation_receipts
    WHEN NEW.operation_type='phase4:reconcile-budget-reservation'
    BEGIN SELECT RAISE(ABORT, 'reconciliation receipt crash'); END;`);
  assert.throws(() => works.phase4Control(user, request), /reconciliation receipt crash/);
  db.connection.exec("DROP TRIGGER fail_budget_receipt");
  assert.equal(works.repo.getReservation(request.reservationId)!.state, "unknown");
  assert.equal(works.repo.getEvidence(`budget-reconciliation:${request.reservationId}`), undefined);
  assert.deepEqual(works.getWork(review.workId), beforeReview, "ledger, audit and control version all roll back with the receipt");
  const reviewed = works.phase4Control(user, request); assert.equal(reviewed.ok, true);
  assert.equal(works.repo.getReservation(request.reservationId)!.reportedTokens, 17);
  assert.equal(works.budget.snapshot(review.workId).unknownTokens, 0);
  assert.equal(works.getWork(review.workId)!.stateVersion, beforeReview.stateVersion + 1);
  assert.equal(works.getWork(review.workId)!.intentRevision, beforeReview.intentRevision);
  const audit = works.repo.getEvidence(`budget-reconciliation:${request.reservationId}`)!;
  const details = JSON.parse(audit.detail!);
  assert.equal(audit.sourceRef, request.evidenceRef); assert.equal(audit.provenance, "user");
  assert.equal(details.actor.userId, LOCAL_USER_ID); assert.equal(details.reason, request.reason);
  assert.equal(details.windowId, request.windowId); assert.equal(details.reportedTokens, 17);
  const repeated = secondWorks.phase4Control(user, request);
  assert(repeated.ok && repeated.replayed, "the same persisted control receipt replays across independent connections");
  assert.equal(works.getWork(review.workId)!.stateVersion, beforeReview.stateVersion + 1);
  rejected({ ...request, reportedTokens: 18 }, "idempotency_conflict");
  rejected({ ...request, operationId: "another-review" }, "version_conflict");
  rejected({ ...request, operationId: "overwrite-review", versionGuard: guard(works.getWork(review.workId)!) }, "invalid_request");

  // Unknown with a zero estimate is still unverified; every window-opening path must wait.
  const zero = create("zero-estimate-unknown"); configureWindow(zero);
  assert(works.budget.reserve({ workId: zero.workId, reservationId: "zero-unknown", tokens: 0 }).ok);
  assert(works.budget.commit(zero.workId, "zero-unknown").ok);
  clock.at += 60_001;
  assert.equal(works.budget.snapshot(zero.workId).unknownUsageCount, 1);
  assert(works.budget.snapshot(zero.workId).pendingRollover);
  assert.equal(works.budget.rollover(works.getWork(zero.workId)!, clock.at).ok, false);
  assert.equal(works.phase4Control(user, { kind: "set-budget-policy", operationId: "zero-change-policy", workId: zero.workId,
    maxTokens: 200, versionGuard: guard(works.getWork(zero.workId)!) }).ok, false);
  assert.equal(works.openBudgetWindow(user, zero.workId, { windowId: "zero-bypass-window", maxTokens: 200 }).ok, false);
  assert.equal(works.phase4Control(user, reconciliation(zero.workId, "zero-unknown", 0)).ok, true);
  assert.equal(works.repo.getReservation("zero-unknown")!.state, "committed", "only explicit confirmed zero can settle zero usage");
  assert.equal(works.budget.rollover(works.getWork(zero.workId)!, clock.at).ok, true);
  assert.equal(works.repo.listOpenBlockers(zero.workId).filter(item => item.reasonCode === "budget-exhausted").length, 0);

  // A missing usage observation must not steal the key of a later trusted receipt.
  const late = create("late-provider-receipt"); configureWindow(late);
  unwrap(works.dispatchExecution(user, { operationId: "late-dispatch", workId: late.workId, botId: DEFAULT_BOT_ID,
    taskId: "late-task", durableStoreKey: "store:late", conversationId: "late", workspaceBinding: root, reserveTokens: 20 }));
  const lateFirst = works.budget.admitProviderRequest({ taskId: "late-task", conversationId: "late", generationTaskId: 10,
    sourceKind: "main", estimatedTokens: 20 }); assert(lateFirst.allowed);
  assert.equal(works.budget.settleProviderUsage({ taskId: "late-task", conversationId: "late", generationTaskId: 10,
    reported: false, inputTokens: 0 }).ok, true);
  assert.equal(works.repo.getReservation(lateFirst.reservationId!)!.state, "unknown");
  assert.equal(works.repo.getReservation(lateFirst.reservationId!)!.receiptKey, undefined);
  assert.equal(works.budget.settleProviderUsage({ taskId: "late-task", conversationId: "late", generationTaskId: 10,
    reported: true, inputTokens: -1 }).ok, false);
  assert.equal(works.budget.settleProviderUsage({ taskId: "late-task", conversationId: "late", generationTaskId: 10,
    reported: true, inputTokens: 11 }).ok, true);
  assert.equal(works.repo.getReservation(lateFirst.reservationId!)!.state, "committed");
  assert.equal(works.budget.snapshot(late.workId).committedTokens, 11);
  assert.equal(works.budget.snapshot(late.workId).unknownUsageCount, 0);

  // After manual reconciliation and rollover a late report stays on the original last
  // attempt; it never charges an earlier retry or silently changes the new window's usage.
  const attemptA = works.budget.admitProviderRequest({ taskId: "late-task", conversationId: "late", generationTaskId: 11,
    sourceKind: "main", estimatedTokens: 20 }); assert(attemptA.allowed);
  const attemptB = works.budget.admitProviderRequest({ taskId: "late-task", conversationId: "late", generationTaskId: 11,
    sourceKind: "main", estimatedTokens: 20 }); assert(attemptB.allowed);
  works.budget.settleProviderUsage({ taskId: "late-task", conversationId: "late", generationTaskId: 11, reported: false });
  assert.equal(works.phase4Control(user, reconciliation(late.workId, attemptB.reservationId!, 0, "released")).ok, true);
  assert.equal(works.phase4Control(user, reconciliation(late.workId, attemptA.reservationId!, 5)).ok, true);
  const originalWindowId = works.getWork(late.workId)!.budget.windowId;
  clock.at += 60_001;
  assert.equal(works.budget.rollover(works.getWork(late.workId)!, clock.at).ok, true);
  const newWindowId = works.getWork(late.workId)!.budget.windowId;
  const lateReport = { taskId: "late-task", conversationId: "late", generationTaskId: 11, reported: true, inputTokens: 13 };
  assert.equal(works.budget.settleProviderUsage(lateReport).ok, true);
  assert.equal(works.repo.getReservation(attemptB.reservationId!)!.reportedTokens, 13);
  assert.equal(works.repo.getReservation(attemptA.reservationId!)!.reportedTokens, 5, "the earlier attempt's confirmed quantity is unchanged");
  assert.equal(works.budget.listWindows(late.workId).find(item => item.windowId === originalWindowId)!.committedTokens, 11 + 5 + 13);
  assert.equal(works.budget.listWindows(late.workId).find(item => item.windowId === originalWindowId)!.status, "closed");
  assert.equal(works.getWork(late.workId)!.budget.windowId, newWindowId);
  assert.equal(works.getWork(late.workId)!.budget.usedTokens, 0);
  assert(works.repo.listOpenBlockers(late.workId).some(item => item.reasonCode === "budget-reconciliation-conflict" && item.windowId === originalWindowId));
  const evidenceCount = works.repo.listEvidence(late.workId).length;
  assert.equal(works.budget.settleProviderUsage(lateReport).ok, true);
  assert.equal(works.repo.listEvidence(late.workId).length, evidenceCount, "duplicate trusted receipts do not duplicate the audit");
  assert.equal(works.budget.settleProviderUsage({ ...lateReport, inputTokens: 8 }).ok, true);
  assert.equal(works.repo.getReservation(attemptB.reservationId!)!.reportedTokens, 13, "contradictory provider reports cannot silently lower usage");
  assert.equal(works.budget.settleProviderUsage({ ...lateReport, inputTokens: 15 }).ok, true);
  assert.equal(works.budget.listWindows(late.workId).find(item => item.windowId === originalWindowId)!.committedTokens, 11 + 5 + 15);

  // Distinct conflicting reservations in one Work share its one open reason-code blocker;
  // both real receipts must commit rather than violating uq_work_blocker_reason.
  const nextConflict = works.budget.admitProviderRequest({ taskId: "late-task", conversationId: "late", generationTaskId: 12,
    sourceKind: "main", estimatedTokens: 20 }); assert(nextConflict.allowed);
  works.budget.settleProviderUsage({ taskId: "late-task", conversationId: "late", generationTaskId: 12, reported: false });
  assert.equal(works.phase4Control(user, reconciliation(late.workId, nextConflict.reservationId!, 0, "released")).ok, true);
  const nextReport = { taskId: "late-task", conversationId: "late", generationTaskId: 12, reported: true, inputTokens: 9 };
  assert.equal(works.budget.settleProviderUsage(nextReport).ok, true);
  assert.equal(works.repo.getReservation(nextConflict.reservationId!)!.reportedTokens, 9);
  assert.equal(works.repo.getReservation(attemptB.reservationId!)!.reportedTokens, 15);
  assert.equal(works.getWork(late.workId)!.budget.usedTokens, 9);
  const conflictBlockers = works.repo.listOpenBlockers(late.workId).filter(item => item.reasonCode === "budget-reconciliation-conflict");
  assert.equal(conflictBlockers.length, 1);
  assert.equal(conflictBlockers[0].windowId, newWindowId, "the aggregate points at the latest conflict's original window");
  assert.equal(conflictBlockers[0].details?.conflictCount, 4);
  const conflictEvidence = works.repo.listEvidence(late.workId).filter(item => item.evidenceId.startsWith("budget-receipt-conflict:"));
  assert.equal(conflictEvidence.length, 4);
  assert.deepEqual(new Set(conflictEvidence.map(item => JSON.parse(item.detail!).reservationId)),
    new Set([attemptB.reservationId, nextConflict.reservationId]));
  assert.equal(works.budget.settleProviderUsage(nextReport).ok, true);
  assert.equal(works.repo.listOpenBlockers(late.workId).find(item => item.reasonCode === "budget-reconciliation-conflict")!.details?.conflictCount, 4);

  // Wall time is an observation, not provider-attempt order. A retry emitted after a
  // clock rollback remains the last actual request and receives the generation receipt.
  const rollback = create("budget-clock-rollback");
  unwrap(works.dispatchExecution(user, { operationId: "rollback-dispatch", workId: rollback.workId, botId: DEFAULT_BOT_ID,
    taskId: "rollback-task", durableStoreKey: "store:rollback", conversationId: "rollback", workspaceBinding: root, reserveTokens: 20 }));
  const beforeRollback = works.budget.admitProviderRequest({ taskId: "rollback-task", conversationId: "rollback", generationTaskId: 1,
    sourceKind: "main", estimatedTokens: 20 }); assert(beforeRollback.allowed);
  clock.at -= 1000;
  const afterRollback = works.budget.admitProviderRequest({ taskId: "rollback-task", conversationId: "rollback", generationTaskId: 1,
    sourceKind: "main", estimatedTokens: 20 }); assert(afterRollback.allowed);
  assert(works.repo.getReservation(beforeRollback.reservationId!)!.createdAt > works.repo.getReservation(afterRollback.reservationId!)!.createdAt);
  assert.equal(works.budget.settleProviderUsage({ taskId: "rollback-task", conversationId: "rollback", generationTaskId: 1,
    reported: true, inputTokens: 7 }).ok, true);
  assert.equal(works.repo.getReservation(afterRollback.reservationId!)!.state, "committed");
  assert.equal(works.repo.getReservation(afterRollback.reservationId!)!.reportedTokens, 7);
  assert.equal(works.repo.getReservation(beforeRollback.reservationId!)!.state, "unknown");
  assert.equal(works.budget.snapshot(rollback.workId).unknownTokens, 20);
  clock.at += 1000;

  // Controls from a previous owner cannot settle the new owner's ledger, even after handoff.
  const handoffGrants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
  const handoffUser: WorkActor = { ...user, grants: handoffGrants };
  bots.registerBot({ botId: "budget-next-owner", userId: LOCAL_USER_ID, displayName: "next owner", authorization: handoffGrants });
  const handed = unwrap(works.createWork(handoffUser, { operationId: "budget-handoff", title: "budget handoff",
    authorization: handoffGrants, inputSnapshotId: "input:handoff", budget: { maxTokens: 100 } }));
  assert(works.budget.reserve({ workId: handed.workId, reservationId: "handoff-unknown", tokens: 10 }).ok);
  works.budget.commit(handed.workId, "handoff-unknown");
  const staleDecision = reconciliation(handed.workId, "handoff-unknown", 4);
  unwrap(works.handoffOwner(handoffUser, { operationId: "budget-transfer", workId: handed.workId, targetBotId: "budget-next-owner" }));
  const oldOwner: WorkActor = { kind: "bot", userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, host: "foreground", grants: handoffGrants };
  const newOwner: WorkActor = { ...oldOwner, botId: "budget-next-owner" };
  rejected(staleDecision, "unauthorized_actor", oldOwner);
  rejected(staleDecision, "epoch_mismatch", newOwner);
  const ownerReview = reconciliation(handed.workId, "handoff-unknown", 4);
  assert.equal(works.phase4Control(newOwner, ownerReview).ok, true);
  assert.equal(JSON.parse(works.repo.getEvidence("budget-reconciliation:handoff-unknown")!.detail!).actor.botId, "budget-next-owner");

  // Settling an already emitted request remains available after cancellation and expiry;
  // unknown usage holds closing until verified, without restoring execution permission.
  const expired = unwrap(works.createWork(user, { operationId: "expired-budget", title: "expired budget",
    authorization: { ...DESKTOP_USER_GRANTS, expiresAt: clock.at + 1 }, budget: { maxTokens: 100 } }));
  assert(works.budget.reserve({ workId: expired.workId, reservationId: "expired-unknown", tokens: 10 }).ok);
  works.budget.commit(expired.workId, "expired-unknown"); clock.at += 2;
  unwrap(works.cancelWork(user, { operationId: "expired-cancel", workId: expired.workId }));
  assert.equal(works.getWork(expired.workId)!.lifecycle, "closing", "expiry and cancellation cannot erase unbound unknown usage");
  assert.equal(works.repo.getReservation("expired-unknown")!.state, "unknown");
  assert.equal(works.phase4Control(user, reconciliation(expired.workId, "expired-unknown", 3)).ok, true);
  assert.equal(works.getWork(expired.workId)!.lifecycle, "closed", "verified final obligation settles the pending cancellation");
  assert.equal(works.getWork(expired.workId)!.closureConclusion, "cancelled");
  assert.equal(works.repo.getReservation("expired-unknown")!.state, "committed");
  assert.equal(works.repo.getReservation("expired-unknown")!.reportedTokens, 3);
  assert.equal(works.budget.snapshot(expired.workId).unknownTokens, 0);
  assert.equal(works.phase4Control(user, { kind: "set-budget-policy", operationId: "expired-policy", workId: expired.workId,
    maxTokens: 200, versionGuard: guard(works.getWork(expired.workId)!) }).ok, false);

  // Exhaustion on one Work must not overwrite or clear another Work's persisted blocker.
  const blockedA = create("budget-blocker-a", 1), blockedB = create("budget-blocker-b", 1);
  assert.equal(works.budget.reserve({ workId: blockedA.workId, reservationId: "blocked-a", tokens: 2 }).ok, false);
  assert.equal(works.budget.reserve({ workId: blockedB.workId, reservationId: "blocked-b", tokens: 2 }).ok, false);
  const blockerA = works.repo.listOpenBlockers(blockedA.workId).find(item => item.reasonCode === "budget-exhausted")!;
  const blockerB = works.repo.listOpenBlockers(blockedB.workId).find(item => item.reasonCode === "budget-exhausted")!;
  assert(blockerA && blockerB); assert.notEqual(blockerA.blockerId, blockerB.blockerId);
  works.budget.summary(blockedA.workId);
  assert.deepEqual(works.repo.getBlocker(blockerA.blockerId), blockerA,
    "reading the ledger cannot clear an unmet request merely because some smaller amount is available");
  assert(works.budget.reserve({ workId: blockedA.workId, reservationId: "fits-a", tokens: 1 }).ok);
  assert.equal(works.repo.getBlocker(blockerB.blockerId)!.status, "open");

  const restored = create("budget-restored-capacity", 100);
  assert(works.budget.reserve({ workId: restored.workId, reservationId: "held-capacity", tokens: 80 }).ok);
  assert.equal(works.budget.reserve({ workId: restored.workId, reservationId: "needs-30", tokens: 30 }).ok, false);
  const capacityBlocker = works.repo.listOpenBlockers(restored.workId).find(item => item.reasonCode === "budget-exhausted")!;
  works.budget.summary(restored.workId);
  assert.equal(works.repo.getBlocker(capacityBlocker.blockerId)!.status, "open");
  assert(works.budget.commit(restored.workId, "held-capacity", 40).ok);
  assert.equal(works.repo.getBlocker(capacityBlocker.blockerId)!.status, "cleared", "real settlement restores enough capacity for the refused amount");

  // Restart and handoff keep the same window and outstanding reservations.
  const persistedBefore = works.getWork(shared.workId)!.budget;
  const pendingBefore = works.repo.listReservations(shared.workId).filter(item => item.state === "reserved" || item.state === "unknown").length;
  db.close(); secondDb.close();
  db = new AppDatabase(path); bots = makeBots(db);
  works = new WorkService(db.connection, { bots, now: () => clock.at });
  const persistedAfter = works.getWork(shared.workId)!.budget;
  assert.equal(persistedAfter.windowId, persistedBefore.windowId);
  assert.equal(persistedAfter.usedTokens, persistedBefore.usedTokens);
  assert.equal(works.repo.listReservations(shared.workId).filter(item => item.state === "reserved" || item.state === "unknown").length, pendingBefore);
  assert.equal(works.repo.listReservations(shared.workId).some(item => item.attemptIdentity), true);
  assert.deepEqual(works.repo.getEvidence(`budget-reconciliation:${request.reservationId}`), audit);
  assert.equal(works.budget.listWindows(late.workId).find(item => item.windowId === originalWindowId)!.committedTokens, 11 + 5 + 15);
  assert.equal(works.budget.settleProviderUsage({ ...lateReport, inputTokens: 15 }).ok, true);
  const restartedReplay = works.phase4Control(user, request); assert(restartedReplay.ok && restartedReplay.replayed);
  console.log("Phase 4 BW-A40 budget: shared ledger, guarded audited unknown reconciliation, rollback/owner/expiry guards, zero-estimate safety, late receipts in original windows, scoped blockers, restart idempotency and controlled rollover passed");
} finally {
  try { secondDb.close(); } catch { /* already closed */ }
  db.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
