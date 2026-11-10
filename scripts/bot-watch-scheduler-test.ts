import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { localParts } from "../src/main/agent/work/WorkWatchScheduler";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkDto } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "watch-scheduler-"));
const path = join(root, "watch.db");
let now = Date.UTC(2026, 0, 1);
let db!: AppDatabase;
let works!: WorkService;
const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const open = () => {
  db = new AppDatabase(path);
  const bots = new BotRegistry(db.connection);
  bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "test", authorization: DESKTOP_USER_GRANTS });
  works = new WorkService(db.connection, { bots, now: () => now });
};
const guard = (id: string) => {
  const work = works.getWork(id)!;
  return { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch };
};
let sequence = 0;
const create = (policy: "latest" | "each" | "skip", depth = 64, expression = "* * * * *", timezone = "UTC") => {
  const id = `test-${++sequence}`;
  const result = works.createWork(actor, { operationId: id, title: id, inputSnapshotId: id,
    workspacePath: root, mode: "watch", authorization: DESKTOP_USER_GRANTS });
  assert(result.ok);
  const work = result.work;
  const configured = works.phase4Control(actor, { kind: "configure-subscription", operationId: `${id}-sub`,
    workId: work.workId, source: "cron", catchUpPolicy: policy, cronExpression: expression, timezone,
    maxQueueDepth: depth, versionGuard: guard(work.workId) });
  assert(configured.ok);
  return { work, sub: configured.subscriptionId! };
};
const events = (work: WorkDto) => works.repo.listInbox(work.workId, ["pending", "merged", "blocked"]).filter(e => e.eventType === "work.tick");
const tick = () => works.scheduler.tick(now);
open();
try {
  const latest = create("latest");
  const each = create("each", 128);
  const small = create("each", 3);
  const skip = create("skip");
  const first = works.repo.getSubscription(latest.sub)!.nextWakeAt!;
  // A real close/reopen with years of missed minute slots must be bounded.
  db.close(); now = Date.UTC(2036, 0, 1, 0, 0, 17); open();
  const gaps = works.scheduler.beginHostSession({ heartbeatAt: first - 60_000 }, now);
  for (const gap of gaps) works.scheduler.applyGap(gap.gapId);
  assert.equal(events(latest.work).length, 0, "host startup must not enqueue a second generic cron readback");
  tick();
  assert.equal(works.scheduler.gaps(latest.work.workId)[0].state, "recovered");
  assert.equal(works.scheduler.gaps(skip.work.workId)[0].state, "recovered");
  assert.equal(works.scheduler.gaps(each.work.workId)[0].state, "recovering", "bounded each backlog stays visibly unfinished");
  assert.equal(works.repo.listOpenBlockers(latest.work.workId).length, 0);
  assert(!works.repo.listInbox(latest.work.workId).some(e => e.eventType === "work.offline_catchup"));
  assert.equal(events(latest.work).length, 1);
  assert.equal(events(latest.work)[0].payload.authoritativeReadbackRequired, true);
  assert.equal(events(latest.work)[0].payload.catchUpFrom, first);
  assert.equal(events(latest.work)[0].payload.scheduledAt, now - 17_000);
  assert.equal(events(each.work).length, 64, "each has a 64-slot pass limit");
  assert.equal(events(small.work).length, 3, "queue capacity limits catch-up");
  assert.equal(events(skip.work).length, 0, "skip does not replay stale slots");
  const smallCursor = works.repo.getSubscription(small.sub)!.nextWakeAt;
  tick(); tick();
  assert.equal(events(latest.work).length, 1, "repeated ticks do not duplicate latest readback");
  assert.equal(events(each.work).length, 128, "repeated passes cannot grow past queue capacity");
  assert.equal(works.repo.getSubscription(small.sub)!.nextWakeAt, smallCursor);
  const consumed = events(small.work)[0];
  db.connection.prepare("UPDATE work_events_inbox SET status='processed' WHERE event_id=?").run(consumed.eventId);
  db.close(); open(); tick();
  assert.equal(events(small.work).length, 3);
  assert.equal(events(small.work).at(-1)!.payload.scheduledAt, smallCursor, "reopen resumes the persisted continuation without loss");

  // On-time and ordinary polling delay must still fire with skip.
  const online = create("skip");
  now = works.repo.getSubscription(online.sub)!.nextWakeAt! + 4_000;
  tick(); assert.equal(events(online.work).length, 1);
  tick(); assert.equal(events(online.work).length, 1);

  for (const policy of ["latest", "each", "skip"] as const) {
    const fixture = create(policy, 3);
    const wake = works.repo.getSubscription(fixture.sub)!.nextWakeAt!;
    assert(works.pauseWork(actor, { operationId: `pause-${policy}`, workId: fixture.work.workId, versionGuard: guard(fixture.work.workId) }).ok);
    now = wake + 10 * 60_000 + 17_000;
    tick(); assert.equal(events(fixture.work).length, 0);
    assert.equal(works.repo.getSubscription(fixture.sub)!.nextWakeAt, wake);
    assert(works.resumeWork(actor, { operationId: `resume-${policy}`, workId: fixture.work.workId, versionGuard: guard(fixture.work.workId) }).ok);
    tick(); assert.equal(events(fixture.work).length, policy === "latest" ? 1 : policy === "each" ? 3 : 0);
  }

  // A slow consumer gets only the newest unclaimed check, with old tick audit retained.
  const slow = create("latest", 3);
  now = works.repo.getSubscription(slow.sub)!.nextWakeAt!; tick();
  const superseded = events(slow.work)[0];
  now += 60_000; tick();
  assert.equal(events(slow.work).length, 1);
  assert.equal(works.repo.getInbox(superseded.eventId)!.status, "skipped");
  assert.equal((db.connection.prepare("SELECT status FROM work_schedule_ticks WHERE inbox_event_id=?")
    .get(superseded.eventId) as { status: string }).status, "skipped");
  const frozen = events(slow.work)[0];
  db.connection.prepare("UPDATE work_events_inbox SET frozen_at=?,frozen_payload_json=payload_json WHERE event_id=?")
    .run(now, frozen.eventId);
  now += 60_000; tick();
  assert.equal(events(slow.work).length, 2, "the frozen check keeps its snapshot");
  assert.equal(works.repo.getInbox(frozen.eventId)!.status, "pending");
  const admitted = events(slow.work).find(e => e.eventId !== frozen.eventId)!;
  const dispatched = works.dispatchExecution(actor, { operationId: "admit-slow", workId: slow.work.workId,
    botId: DEFAULT_BOT_ID, taskId: "slow-check", durableStoreKey: "slow-check-store", conversationId: "slow-check",
    workspaceBinding: root, inboxEventId: admitted.eventId,
    causal: { source: "system", sourceEventId: admitted.sourceEventId, trustedRoot: true } });
  assert(dispatched.ok);
  // Recovery may expose an admitted binding before the inbox watermark is settled.
  db.connection.prepare("UPDATE work_events_inbox SET status='pending' WHERE event_id=?").run(admitted.eventId);
  now += 60_000; tick();
  assert.equal(works.repo.getInbox(admitted.eventId)!.status, "pending", "binding-owned check is never coalesced");

  // A future one-shot must not be cleared by an early scan.
  const once = create("latest");
  const onceAt = now + 30_000;
  works.repo.updateSubscription({ ...works.repo.getSubscription(once.sub)!, cronExpression: undefined,
    nextWakeAt: onceAt, updatedAt: now });
  tick(); assert.equal(works.repo.getSubscription(once.sub)!.nextWakeAt, onceAt);
  now = onceAt; tick(); tick();
  assert.equal(events(once.work).length, 1);
  assert.equal(works.repo.getSubscription(once.sub)!.nextWakeAt, undefined);

  // Nominal local slot identity and configured-zone offsets survive DST boundaries.
  now = Date.UTC(2026, 2, 7, 12);
  const spring = create("latest", 3, "30 2 * * *", "America/Los_Angeles");
  now = works.repo.getSubscription(spring.sub)!.nextWakeAt!;
  tick();
  assert.equal(events(spring.work)[0].payload.logicalSlotKey, "2026-03-08T02:30");
  assert.equal(localParts(now, "America/Los_Angeles").offsetMinutes, -420);
  now = Date.UTC(2026, 9, 31, 12);
  const fall = create("latest", 3, "30 1 * * *", "America/Los_Angeles");
  now = works.repo.getSubscription(fall.sub)!.nextWakeAt!;
  tick(); now += 3_600_000; tick();
  assert.equal(events(fall.work).length, 1);
  assert.equal(localParts(now, "America/Los_Angeles").offsetMinutes, -480);
  assert.equal(localParts(now, "Asia/Shanghai").offsetMinutes, 480);

  // Blockers belong to their individual work, not a global reason-code identity.
  for (let i = 0; i < 2; i++) {
    const fixture = create("latest");
    assert(works.phase4Control(actor, { kind: "set-deadline", operationId: `deadline-${i}`, workId: fixture.work.workId,
      deadlineAt: now + 1_000, versionGuard: guard(fixture.work.workId) }).ok);
    assert(works.pauseWork(actor, { operationId: `pause-deadline-${i}`, workId: fixture.work.workId, versionGuard: guard(fixture.work.workId) }).ok);
    now += 2_000; tick();
    assert(works.repo.listOpenBlockers(fixture.work.workId).some(b => b.reasonCode === "deadline-follow-up"));
  }
  // Settled deadlines cannot occupy the bounded scan forever. This is a
  // normal many-commitment flow, not crash/fault injection.
  const deadlineWork = () => {
    const id = `deadline-population-${++sequence}`;
    const result = works.createWork(actor, { operationId: id, title: id, inputSnapshotId: id,
      workspacePath: root, mode: "once", deadlineAt: now - 1, authorization: DESKTOP_USER_GRANTS });
    assert(result.ok); return result.work;
  };
  const deadlineEvents = (work: WorkDto) => works.repo.listInbox(work.workId).filter(event => event.eventType === "deadline_expired");
  const population = Array.from({ length: 130 }, deadlineWork);
  tick(); tick(); tick();
  assert.equal(population.filter(work => deadlineEvents(work).length === 1).length, 130,
    "more than 64 deadlines must all advance across bounded passes");
  tick(); assert(population.every(work => deadlineEvents(work).length === 1), "settled deadlines never repeat");
  const pausedDeadline = deadlineWork();
  assert(works.pauseWork(actor, { operationId: "pause-overdue", workId: pausedDeadline.workId, versionGuard: guard(pausedDeadline.workId) }).ok);
  tick(); tick();
  assert.equal(deadlineEvents(pausedDeadline).length, 0, "paused expiry must not execute");
  assert(works.repo.listOpenBlockers(pausedDeadline.workId).some(item => item.reasonCode === "deadline-follow-up"));
  assert(works.resumeWork(actor, { operationId: "resume-overdue", workId: pausedDeadline.workId, versionGuard: guard(pausedDeadline.workId) }).ok);
  tick(); tick();
  assert.equal(deadlineEvents(pausedDeadline).length, 1, "resume catches up the missed commitment once");
  assert(!works.repo.listOpenBlockers(pausedDeadline.workId).some(item => item.reasonCode === "deadline-follow-up"),
    "queued follow-up clears the obsolete pause diagnostic");
  assert(works.pauseWork(actor, { operationId: "pause-already-followed", workId: pausedDeadline.workId, versionGuard: guard(pausedDeadline.workId) }).ok);
  tick();
  assert(works.resumeWork(actor, { operationId: "resume-already-followed", workId: pausedDeadline.workId, versionGuard: guard(pausedDeadline.workId) }).ok);
  tick(); assert.equal(deadlineEvents(pausedDeadline).length, 1, "already emitted follow-up cannot repeat after another pause");
  const pausedPopulation = Array.from({ length: 70 }, deadlineWork);
  for (const work of pausedPopulation) assert(works.pauseWork(actor, { operationId: `pause-${work.workId}`, workId: work.workId, versionGuard: guard(work.workId) }).ok);
  tick(); tick();
  const afterPaused = deadlineWork(); tick();
  assert.equal(deadlineEvents(afterPaused).length, 1, "paused deadline facts cannot starve an active commitment");
  assert(pausedPopulation.every(work => deadlineEvents(work).length === 0));
  const revised = deadlineWork();
  assert(works.pauseWork(actor, { operationId: "pause-revised", workId: revised.workId, versionGuard: guard(revised.workId) }).ok);
  tick();
  assert(works.phase4Control(actor, { kind: "set-deadline", operationId: "move-revised", workId: revised.workId,
    deadlineAt: now + 10_000, versionGuard: guard(revised.workId) }).ok);
  assert(works.resumeWork(actor, { operationId: "resume-revised", workId: revised.workId, versionGuard: guard(revised.workId) }).ok);
  tick(); assert.equal(deadlineEvents(revised).length, 0, "revised deadline must not resurrect the old overdue instance");
  now += 10_000; tick(); assert.equal(deadlineEvents(revised).length, 1);
  const cancelledDeadline = deadlineWork();
  assert(works.pauseWork(actor, { operationId: "pause-cleared-deadline", workId: cancelledDeadline.workId, versionGuard: guard(cancelledDeadline.workId) }).ok);
  tick();
  assert(works.phase4Control(actor, { kind: "set-deadline", operationId: "clear-deadline", workId: cancelledDeadline.workId,
    deadlineAt: null, versionGuard: guard(cancelledDeadline.workId) }).ok);
  assert(works.resumeWork(actor, { operationId: "resume-cleared-deadline", workId: cancelledDeadline.workId, versionGuard: guard(cancelledDeadline.workId) }).ok);
  tick(); assert.equal(deadlineEvents(cancelledDeadline).length, 0, "removed commitment must stay removed");
  // Large populations use a persistent fair 128-subscription pass. Full each
  // queues at the front may not starve new watches, including after host reopen.
  for (const subscription of works.repo.listActiveSubscriptions()) works.repo.updateSubscription({ ...subscription, stoppedAt: now, updatedAt: now });
  const many = Array.from({ length: 140 }, () => create("each", 1));
  now = works.repo.getSubscription(many[0].sub)!.nextWakeAt! + 120_000;
  assert.equal(tick().length, 128);
  assert.equal(many.filter(item => events(item.work).length === 1).length, 128);
  db.close(); open();
  assert(tick().length <= 128);
  assert.equal(many.filter(item => events(item.work).length === 1).length, 140,
    "persisted cursor reaches the remaining watches despite saturated earlier queues");
  console.log("PASS: watch scheduler policies, bounded catch-up/queues, persisted restart, pause/resume, online skip, DST and per-work blockers");
} finally { db!.close(); rmSync(root, { recursive: true, force: true }); }
