import assert from "node:assert/strict";
import { phase4ControlRequestSchema } from "../src/shared/bot-work-phase4";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "phase4-schedule-"));
const path = join(root, "business.db");
const clock = { at: Date.UTC(2026, 2, 7, 12, 0, 0) };
let db = new AppDatabase(path);
let bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
let works = new WorkService(db.connection, { bots, now: () => clock.at });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw Error(`${result.code}: ${result.message}`); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const create = (id: string, extra: Partial<Parameters<WorkService["createWork"]>[1]> = {}) =>
  unwrap(works.createWork(user, { operationId: id, title: id, inputSnapshotId: `input:${id}`, authorization: DESKTOP_USER_GRANTS,
    workspacePath: root, mode: "watch", ...extra }));
const ticks = (workId?: string) => (workId
  ? db.connection.prepare("SELECT * FROM work_schedule_ticks WHERE work_id=? ORDER BY planned_at").all(workId)
  : db.connection.prepare("SELECT * FROM work_schedule_ticks ORDER BY planned_at").all()) as Array<{ subscription_id: string; logical_slot_key: string;
    planned_at: number; effective_at: number; schedule_revision: number; status: string; inbox_event_id: string | null }>;
const inbox = (workId: string, type?: string) => works.repo.listInbox(workId, ["pending", "merged", "skipped", "blocked", "processed"])
  .filter(item => !type || item.eventType === type);

function cron(work: WorkDto, id: string, expression: string, timezone: string, policy: "latest" | "each" | "skip" = "each") {
  const result = works.phase4Control(user, { kind: "configure-subscription", operationId: id, workId: work.workId,
    source: "cron", catchUpPolicy: policy, cronExpression: expression, timezone, maxMergeWaitMs: 100, maxQueueDepth: 64,
    versionGuard: guard(works.getWork(work.workId)!) });
  if (!result.ok) throw Error(`${result.code}: ${result.message}`);
  return result.subscriptionId!;
}

try {
  // A receipt must return its own generated subscription, not another call's scratch state.
  const replayA = create("replay-a"), replayB = create("replay-b");
  const requestA = { kind: "configure-subscription", operationId: "configure-replay-a", workId: replayA.workId,
    source: "cron", catchUpPolicy: "each", cronExpression: "0 3 * * *", timezone: "Asia/Shanghai",
    versionGuard: guard(replayA) };
  const resultA = works.phase4Control(user, requestA); assert(resultA.ok && resultA.subscriptionId);
  const resultB = works.phase4Control(user, { ...requestA, operationId: "configure-replay-b", workId: replayB.workId, versionGuard: guard(replayB) });
  assert(resultB.ok && resultB.subscriptionId && resultB.subscriptionId !== resultA.subscriptionId);
  const replay = works.phase4Control(user, requestA); assert(replay.ok && replay.replayed);
  assert.equal(replay.subscriptionId, resultA.subscriptionId, "interleaved replay returns its own persisted subscription ID");
  const replayControl = works.runCardControl(user, "phase4:configure-subscription",
    phase4ControlRequestSchema.parse(requestA), { guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused"] },
    () => { throw Error("replay must not invoke mutation"); });
  assert(replayControl.ok && replayControl.replayed);
  assert.equal("_controlResult" in replayControl.work, false, "internal receipt metadata never leaks into replayed Work DTO");
  const savedReceipt = works.repo.getReceipt(LOCAL_USER_ID, requestA.operationId)!;
  const legacySnapshot = JSON.parse(savedReceipt.result_snapshot_json); delete legacySnapshot._controlResult;
  db.connection.prepare("UPDATE work_operation_receipts SET result_snapshot_json=? WHERE user_id=? AND operation_id=?")
    .run(JSON.stringify(legacySnapshot), LOCAL_USER_ID, requestA.operationId);
  const legacyReplay = works.phase4Control(user, requestA); assert(legacyReplay.ok && legacyReplay.replayed);
  assert.equal(legacyReplay.subscriptionId, undefined, "legacy generated ID must not be guessed from another subscription");
  db.connection.prepare("UPDATE work_operation_receipts SET result_snapshot_json=? WHERE user_id=? AND operation_id=?")
    .run(savedReceipt.result_snapshot_json, LOCAL_USER_ID, requestA.operationId);

  // Spring forward: 02:30 does not exist in Los Angeles on 2026-03-08.
  const spring = create("spring");
  const springSub = cron(spring, "spring-cron", "30 2 * * *", "America/Los_Angeles");
  const springNext = works.repo.getSubscription(springSub)!.nextWakeAt!;
  assert.equal(new Date(springNext).toISOString(), "2026-03-08T10:30:00.000Z");
  clock.at = springNext;
  works.tick(clock.at);
  const springTicks = ticks(spring.workId);
  assert.equal(springTicks.length, 1);
  assert.equal(springTicks[0].logical_slot_key, "2026-03-08T02:30", "the missing local slot keeps its nominal identity");
  assert.equal(springTicks[0].effective_at, springNext, "the missing slot runs once at the first valid instant");
  assert.equal(springTicks[0].status, "dispatched"); assert(springTicks[0].inbox_event_id);
  works.tick(clock.at);
  assert.equal(ticks(spring.workId).length, 1, "the same logical slot never creates a second tick");

  // Fall back: 01:30 repeats in Los Angeles; only the first occurrence becomes a business slot.
  const fall = create("fall");
  clock.at = Date.UTC(2026, 9, 31, 12, 0, 0);
  const fallSub = cron(fall, "fall-cron", "30 1 * * *", "America/Los_Angeles");
  const fallNext = works.repo.getSubscription(fallSub)!.nextWakeAt!;
  assert.equal(new Date(fallNext).toISOString(), "2026-11-01T08:30:00.000Z");
  clock.at = fallNext;
  works.tick(clock.at);
  clock.at = Date.UTC(2026, 10, 1, 9, 30, 0); // the repeated 01:30 PST
  works.tick(clock.at);
  assert.equal(ticks(fall.workId).length, 1, "the repeated local hour is not a second slot");
  assert.equal(ticks(fall.workId)[0].logical_slot_key, "2026-11-01T01:30");

  // Shanghai has no DST: the same expression maps directly to its local slot.
  const shanghai = create("shanghai");
  clock.at = Date.UTC(2026, 2, 7, 12, 0, 0);
  const shanghaiSub = cron(shanghai, "shanghai-cron", "30 2 * * *", "Asia/Shanghai");
  assert.equal(new Date(works.repo.getSubscription(shanghaiSub)!.nextWakeAt!).toISOString(), "2026-03-07T18:30:00.000Z");
  clock.at = works.repo.getSubscription(shanghaiSub)!.nextWakeAt!;
  works.tick(clock.at);
  assert.equal(ticks(shanghai.workId)[0].logical_slot_key, "2026-03-08T02:30");
  assert.equal(ticks(shanghai.workId)[0].effective_at, Date.UTC(2026, 2, 7, 18, 30, 0));

  // Rollback does not replay a persisted slot; forward jumps catch up in bounded pages.
  const jump = create("jump");
  clock.at = Date.UTC(2026, 4, 1, 12, 0, 0);
  const jumpSub = cron(jump, "jump-cron", "*/5 * * * *", "UTC");
  clock.at = works.repo.getSubscription(jumpSub)!.nextWakeAt!;
  works.tick(clock.at);
  const afterFirst = ticks(jump.workId).length;
  clock.at -= 20 * 60_000;
  works.tick(clock.at);
  assert.equal(ticks(jump.workId).length, afterFirst, "a wall-clock rollback never replays an existing slot");
  clock.at += 60 * 60_000;
  works.tick(clock.at);
  const caughtUp = ticks(jump.workId).length;
  assert(caughtUp > afterFirst && caughtUp <= afterFirst + 64, "missed slots are caught up in a bounded page");
  const firstPage = caughtUp;
  clock.at += 10 * 60 * 60_000;
  works.tick(clock.at);
  assert(ticks(jump.workId).length - firstPage <= 64, "a very long jump uses a continuation rather than one unbounded transaction");
  assert(ticks(jump.workId).length > firstPage);

  // Rule changes get a new revision and do not replay the old rule's history.
  const rule = works.phase4Control(user, { kind: "configure-subscription", operationId: "change-rule", workId: jump.workId,
    subscriptionId: jumpSub, source: "cron", catchUpPolicy: "each", cronExpression: "0 3 * * *", timezone: "UTC",
    scheduleRevision: works.repo.getSubscription(jumpSub)!.scheduleRevision, versionGuard: guard(works.getWork(jump.workId)!) });
  assert.equal(rule.ok, true); assert.equal(rule.ok ? rule.subscriptionId : "", jumpSub);
  const revised = works.repo.getSubscription(jumpSub)!;
  assert.equal(revised.scheduleRevision, 2);
  const beforeRevision = ticks(jump.workId).filter(item => item.schedule_revision === 2).length;
  clock.at = Date.UTC(2026, 4, 2, 3, 0, 0);
  works.tick(clock.at);
  assert.equal(ticks(jump.workId).filter(item => item.schedule_revision === 2).length, beforeRevision + 1);

  // Zero-hook commitment deadline: one instance, one read-only follow-up, no original side effect replay.
  const deadline = create("deadline");
  const deadlineSet = works.phase4Control(user, { kind: "set-deadline", operationId: "set-deadline", workId: deadline.workId,
    deadlineAt: clock.at + 60_000, versionGuard: guard(works.getWork(deadline.workId)!) });
  assert.equal(deadlineSet.ok, true); assert.equal(deadlineSet.ok ? deadlineSet.deadlineAt : 0, clock.at + 60_000);
  clock.at += 120_000;
  works.tick(clock.at);
  const deadlineEvents = inbox(deadline.workId, "deadline_expired");
  assert.equal(deadlineEvents.length, 1);
  works.tick(clock.at);
  assert.equal(inbox(deadline.workId, "deadline_expired").length, 1, "restart/rollback does not duplicate a deadline instance");
  const beforeInput = works.getWork(deadline.workId)!.inputSnapshotId;
  unwrap(works.dispatchExecution(user, { operationId: "deadline-follow-up", workId: deadline.workId, botId: DEFAULT_BOT_ID,
    taskId: "deadline-task", durableStoreKey: "store:deadline", conversationId: "1", workspaceBinding: root,
    inboxEventId: deadlineEvents[0].eventId, causal: { source: "system", sourceEventId: deadlineEvents[0].sourceEventId, trustedRoot: true } }));
  const followUp = works.repo.bindingForTask("deadline-task")!;
  assert.deepEqual(followUp.delegatedScope, ["workspace:read"]);
  assert.equal(followUp.inputSnapshotId, beforeInput);
  const followUpInput = JSON.parse(works.repo.executionInput(followUp));
  assert.equal(followUpInput.deadlineFollowUp.readOnly, true);
  assert.equal(followUpInput.deadlineFollowUp.deadlineRevision, works.getWork(deadline.workId)!.deadlineRevision);

  // Paused work records the deadline and a follow-up blocker without starting new work.
  const paused = create("paused-deadline", { mode: "once" });
  works.phase4Control(user, { kind: "set-deadline", operationId: "paused-deadline-set", workId: paused.workId,
    deadlineAt: clock.at + 30_000, versionGuard: guard(works.getWork(paused.workId)!) });
  unwrap(works.pauseWork(user, { operationId: "pause-deadline", workId: paused.workId, versionGuard: guard(works.getWork(paused.workId)!) }));
  const pausedControl = works.phase4Control(user, { kind: "set-deadline", operationId: "paused-deadline-2", workId: paused.workId,
    deadlineAt: clock.at + 60_000, versionGuard: guard(works.getWork(paused.workId)!) });
  assert.equal(pausedControl.ok, true, "paused work can record a committed deadline");
  clock.at += 120_000;
  works.tick(clock.at);
  assert.equal(inbox(paused.workId, "deadline_expired").length, 0);
  assert(works.repo.listOpenBlockers(paused.workId).some(item => item.reasonCode === "deadline-follow-up"));

  // A frozen merge batch is never revived by a wall-clock rollback.
  const frozenWork = create("frozen");
  const frozenSub = works.phase4Control(user, { kind: "configure-subscription", operationId: "frozen-sub", workId: frozenWork.workId,
    source: "hook", catchUpPolicy: "latest", maxMergeWaitMs: 100, maxQueueDepth: 8, versionGuard: guard(works.getWork(frozenWork.workId)!) });
  if (!frozenSub.ok) throw Error(frozenSub.message);
  works.ingestSourceEvent({ source: "hook", sourceEventId: "frozen-1", eventType: "changed", sourceVersion: "1",
    workId: frozenWork.workId, subscriptionId: frozenSub.subscriptionId, payload: { v: 1 } });
  const deadlineAt = works.repo.listInbox(frozenWork.workId, ["merged"])[0].batchDeadlineAt!;
  clock.at = deadlineAt + 1;
  const frozenDue = works.listDueInbox(frozenWork.workId, clock.at);
  assert(frozenDue[0].frozenAt !== undefined);
  clock.at -= 5_000;
  works.tick(clock.at);
  clock.at = deadlineAt + 50_000;
  const stillFrozen = works.listDueInbox(frozenWork.workId, clock.at);
  assert.equal(stillFrozen[0].eventId, frozenDue[0].eventId);
  assert.equal(stillFrozen[0].batchDeadlineAt, deadlineAt, "a clock rollback cannot reopen or postpone a frozen batch");

  // Invalid timezone is refused at the guarded entry.
  const invalid = works.phase4Control(user, { kind: "configure-subscription", operationId: "invalid-tz", workId: jump.workId,
    source: "cron", catchUpPolicy: "each", cronExpression: "0 3 * * *", timezone: "Not/AZone",
    versionGuard: guard(works.getWork(jump.workId)!) });
  assert.equal(invalid.ok, false);

  // Reopen: the same logical slot stays unique and no duplicate tick appears.
  const springTicksBefore = ticks(spring.workId).length;
  db.close(); db = new AppDatabase(path); bots = new BotRegistry(db.connection);
  bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
  works = new WorkService(db.connection, { bots, now: () => clock.at });
  const restartedReplay = works.phase4Control(user, requestA); assert(restartedReplay.ok && restartedReplay.replayed);
  assert.equal(restartedReplay.subscriptionId, resultA.subscriptionId, "replay keeps generated subscription identity after restart");
  works.tick(clock.at);
  assert.equal(ticks(spring.workId).length, springTicksBefore);
  console.log("Phase 4 BW-A38 schedule: IANA spring/fall normalization, unique logical ticks, rollback/jump bounds, rule revision, deadline-only wakeup and read-only follow-up passed");
} finally {
  db.close(); await rm(root, { recursive: true, force: true });
}
