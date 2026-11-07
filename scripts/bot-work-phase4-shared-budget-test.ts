import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

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
  console.log("Phase 4 BW-A40 budget: shared window ledger, envelope-to-request replacement, root/child/expert/compaction identity, unknown vs explicit zero, over-reservation, idempotent receipts and controlled rollover passed");
} finally {
  try { secondDb.close(); } catch { /* already closed */ }
  db.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
