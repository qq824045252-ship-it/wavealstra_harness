import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { WORK_PROJECTION_EVENT_RETENTION } from "../src/main/db/bot-work-phase2-schema";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkProjectionJournal } from "../src/main/agent/work/WorkProjectionJournal";
import { mergeWorkList } from "../src/renderer/src/store/app/slices/botWorkSync";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "bot-work-projection-retention-"));
const path = join(root, "business.db");
let db = new AppDatabase(path);
let bots = new BotRegistry(db.connection);
bots.ensureDefaultBot(LOCAL_USER_ID);
const foreignUserId = "projection-other-user";
bots.registerBot({ botId: "projection-other-bot", userId: foreignUserId, displayName: "Other" });
let works = new WorkService(db.connection, { bots });
let journal = new WorkProjectionJournal(db.connection, works);
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.work;
};
const stats = (userId = LOCAL_USER_ID) => z.object({ count: z.number(), first: z.number(), last: z.number() }).parse(
  db.connection.prepare("SELECT count(*) AS count, min(sequence) AS first, max(sequence) AS last FROM work_projection_events WHERE user_id=?").get(userId),
);
const bump = (workId: string, times: number) => db.transaction(() => {
  const update = db.connection.prepare("UPDATE works SET state_version=state_version+1 WHERE work_id=?");
  for (let index = 0; index < times; index++) update.run(workId);
});

try {
  const active = unwrap(works.createWork(user, { operationId: "active", title: "Current", authorization: DESKTOP_USER_GRANTS }));
  const closed = unwrap(works.createWork(user, { operationId: "closed", title: "Close offline", authorization: DESKTOP_USER_GRANTS }));
  unwrap(works.createWork({ ...user, userId: foreignUserId }, { operationId: "foreign", ownerBotId: "projection-other-bot",
    title: "Independent user", authorization: DESKTOP_USER_GRANTS }));
  const foreignBefore = stats(foreignUserId);
  const stale = journal.sync(LOCAL_USER_ID, { includeClosed: false });
  assert.equal(stale.kind, "snapshot");
  if (stale.kind !== "snapshot") throw new Error("expected snapshot");
  unwrap(works.cancelWork(user, { operationId: "cancel-offline", workId: closed.workId }));
  assert.equal(works.getWork(closed.workId)?.lifecycle, "closed");

  // Exercise the actual SQL write path without any sync reader driving cleanup.
  bump(active.workId, WORK_PROJECTION_EVENT_RETENTION + 3);
  const retained = stats();
  assert.equal(retained.count, WORK_PROJECTION_EVENT_RETENTION);
  assert.equal(retained.first, retained.last - WORK_PROJECTION_EVENT_RETENTION + 1);
  assert.deepEqual(stats(foreignUserId), foreignBefore, "retention is scoped to the event's user");
  assert.deepEqual(journal.sync(LOCAL_USER_ID, { includeClosed: false, cursor: stale.cursor }), { kind: "resync_required" });
  const fresh = journal.sync(LOCAL_USER_ID, { includeClosed: false });
  assert.equal(fresh.kind, "snapshot");
  if (fresh.kind !== "snapshot") throw new Error("expected fresh snapshot");
  assert.equal(fresh.cursor.epoch, stale.cursor.epoch, "cleanup does not reset the stream epoch");
  assert.equal(fresh.cursor.sequence, retained.last, "cleanup does not rewind or reuse a sequence");
  const merged = mergeWorkList(stale.works, stale.cursor, fresh);
  assert.deepEqual(merged?.works.map(work => work.workId), [active.workId], "snapshot removes a closed card even after its tombstone was pruned");
  console.log("PASS projection retention: bounded writes, per-user isolation and expired tombstone recovery");

  const boundary = { ...fresh.cursor, sequence: retained.first - 1 };
  const delta = journal.sync(LOCAL_USER_ID, { includeClosed: false, cursor: boundary });
  assert.equal(delta.kind, "delta");
  if (delta.kind !== "delta") throw new Error("expected boundary delta");
  assert.equal(delta.events.length, 200);
  assert.equal(delta.events[0]?.sequence, retained.first);
  assert.equal(delta.hasMore, true);
  assert.deepEqual(journal.sync(LOCAL_USER_ID, { includeClosed: false, cursor: { ...boundary, sequence: boundary.sequence - 1 } }), { kind: "resync_required" });
  const caughtUp = journal.sync(LOCAL_USER_ID, { includeClosed: false, cursor: fresh.cursor });
  assert(caughtUp.kind === "delta" && caughtUp.events.length === 0 && !caughtUp.hasMore);
  assert.deepEqual(journal.sync(LOCAL_USER_ID, { includeClosed: true, cursor: fresh.cursor }), { kind: "resync_required" });
  const all = journal.sync(LOCAL_USER_ID, { includeClosed: true });
  assert(all.kind === "snapshot" && all.works.some(work => work.workId === closed.workId));
  console.log("PASS projection retention: exact replay boundary, pagination and open/all views");

  assert.throws(() => db.transaction(() => {
    bump(active.workId, 1);
    throw new Error("rollback write and pruning");
  }), /rollback write and pruning/);
  assert.deepEqual(stats(), retained, "the discarded oldest event returns when its new write rolls back");
  const afterRollback = journal.sync(LOCAL_USER_ID, { includeClosed: false });
  assert(afterRollback.kind === "snapshot" && afterRollback.cursor.sequence === fresh.cursor.sequence);
  const removed = unwrap(works.createWork(user, { operationId: "remove-after-gc", title: "Close after pruning", authorization: DESKTOP_USER_GRANTS }));
  unwrap(works.cancelWork(user, { operationId: "cancel-after-gc", workId: removed.workId }));
  const removals = journal.sync(LOCAL_USER_ID, { includeClosed: false, cursor: fresh.cursor });
  assert(removals.kind === "delta" && removals.events.some(event => event.kind === "remove" && event.workId === removed.workId));
  assert.equal(stats().count, WORK_PROJECTION_EVENT_RETENTION);
  console.log("PASS projection retention: transactional rollback and fresh tombstones");

  // Seed accumulated current-schema history, then verify startup cleanup without a reader.
  db.connection.exec("DROP TRIGGER projection_event_retention");
  bump(active.workId, 13);
  const beforeRestart = journal.sync(LOCAL_USER_ID, { includeClosed: false });
  assert.equal(stats().count, WORK_PROJECTION_EVENT_RETENTION + 13);
  db.close();
  db = new AppDatabase(path);
  bots = new BotRegistry(db.connection);
  works = new WorkService(db.connection, { bots });
  journal = new WorkProjectionJournal(db.connection, works);
  assert.equal(stats().count, WORK_PROJECTION_EVENT_RETENTION);
  const afterRestart = journal.sync(LOCAL_USER_ID, { includeClosed: false });
  assert(beforeRestart.kind === "snapshot" && afterRestart.kind === "snapshot");
  assert.deepEqual(afterRestart.cursor, beforeRestart.cursor);
  assert.deepEqual(stats(foreignUserId), foreignBefore);
  bump(active.workId, 1);
  assert.equal(stats().count, WORK_PROJECTION_EVENT_RETENTION, "startup reinstates ongoing bounded writes");
  assert.equal(works.getWork(active.workId)?.ownerBotId, DEFAULT_BOT_ID);
  console.log("PASS projection retention: restart compaction preserves epoch, sequence and other users");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
