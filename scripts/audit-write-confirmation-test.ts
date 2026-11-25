/**
 * An unconfirmed worker write is "unknown", and the recovery policy depends on the mutation.
 *
 * - Idempotent/guarded writes (cron plan, cron run, done ack, sidebar edit) may be replayed on
 *   the host, because the replay converges to the same state. That replay is a degradation, so
 *   it must be *counted* instead of looking like a normal write.
 * - Writes that are not replay-safe (gateway append, durable projection status) never fall back;
 *   those are pinned by their own suites.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-audit-write-confirmation-"));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { RuntimeAuditReader } = await import("../src/main/platform/runtime-audit");
const { encodeCronPlan } = await import("../src/main/db/CronPlanPersistence");
type Reader = import("../src/main/platform/runtime-audit").RuntimeAuditReader;

const db = new AppDatabase(join(sandbox, "app.db"));
const job = {
  id: "job-1", name: "Fixture", prompt: "run", scheduleType: "every", scheduleExpr: "30m",
  timezone: "UTC", enabled: true, createdAt: 1_000, updatedAt: 1_000,
};

const fallbacks: string[] = [];
const noteFallback = (domain: string) => { fallbacks.push(domain); };
function withReader(reader: object | undefined): void {
  Object.assign(db, { runtimeAuditReader: reader });
}

try {
  db.upsertTask({ id: "task-1", title: "Task", updatedAt: 100, welcomeMode: "general", status: "in_progress" });

  // 1. Cron plan: an unconfirmed write is replayed on the host and counted as a fallback.
  withReader({ writeCronPlan: async () => undefined, noteFallback });
  assert.equal(await db.writeCronPlan({ kind: "save", row: encodeCronPlan(job as never), expected: null } as never), true,
    "the guarded upsert converges when replayed");
  assert.equal(db.getCronJob("job-1")?.id, "job-1", "the replay actually stored the plan");
  assert.deepEqual(fallbacks, ["cronPlan"]);

  // 2. A definite answer is never replayed.
  fallbacks.length = 0;
  withReader({ writeCronPlan: async () => false, noteFallback });
  assert.equal(await db.writeCronPlan({ kind: "save", row: encodeCronPlan(job as never), expected: null } as never), false);
  assert.deepEqual(fallbacks, [], "a definite 'not applied' must not be treated as unknown");

  // 3. Cron run: same rule.
  withReader({ writeCronRun: async () => undefined, noteFallback });
  const run = { id: "run-1", jobId: "job-1", status: "success", startedAt: 2_000 };
  assert.equal(await db.writeCronRun({ kind: "record", run } as never), true);
  assert.deepEqual(db.listCronRuns().map(item => item.id), ["run-1"]);
  assert.deepEqual(fallbacks, ["cronRun"]);

  // 4. Done ack: max(done_acked_at, at) makes the replay converge; it is counted.
  fallbacks.length = 0;
  withReader({ acknowledgeTaskDone: async () => undefined, noteFallback });
  assert.equal(await db.writeTaskDoneAck("task-1", 5_000), true);
  assert.equal(db.getTask("task-1")?.doneAckedAt, 5_000);
  assert.deepEqual(fallbacks, ["taskDoneAck"]);
  // Replaying the same ack later does not move the timestamp.
  assert.equal(await db.writeTaskDoneAck("task-1", 4_000), true);
  assert.equal(db.getTask("task-1")?.doneAckedAt, 5_000, "the ack is monotonic");

  // 5. Sidebar edit: same monotonic replay, counted.
  fallbacks.length = 0;
  withReader({ editTaskSidebar: async () => undefined, noteFallback });
  assert.equal(await db.writeTaskSidebar({ kind: "rename", id: "task-1", title: "Renamed", updatedAt: 9_000 }), undefined);
  assert.equal(db.getTask("task-1")?.title, "Renamed");
  assert.deepEqual(fallbacks, ["taskSidebar"]);

  // 6. A definite `missing` and a missing reader both still use the host without counting.
  fallbacks.length = 0;
  withReader({ editTaskSidebar: async () => ({ status: "missing" }), noteFallback });
  assert.equal(await db.writeTaskSidebar({ kind: "rename", id: "task-1", title: "FromHost", updatedAt: 9_500 }), undefined);
  assert.equal(db.getTask("task-1")?.title, "FromHost");
  withReader(undefined);
  assert.equal(await db.writeTaskSidebar({ kind: "rename", id: "task-1", title: "NoReader", updatedAt: 9_600 }), undefined);
  assert.equal(db.getTask("task-1")?.title, "NoReader");
  assert.deepEqual(fallbacks, [], "non-unknown paths are not fallbacks");

  // 7. The counter that makes fallbacks visible is per domain.
  const counts = new Map<string, number>();
  const fakeReader = {
    noteFallback: (domain: string) => counts.set(domain, (counts.get(domain) ?? 0) + 1),
    writeCronRun: async () => undefined,
  };
  withReader(fakeReader);
  await db.writeCronRun({ kind: "record", run: { ...run, id: "run-2" } } as never);
  await db.writeCronRun({ kind: "record", run: { ...run, id: "run-3" } } as never);
  assert.equal(counts.get("cronRun"), 2);

  // 8. The reader-level counter is what makes the degradation visible in the app.
  const reader = new RuntimeAuditReader(undefined, ":memory:");
  reader.noteFallback("cronRun");
  reader.noteFallback("cronRun");
  reader.noteFallback("gateway");
  assert.deepEqual(reader.fallbackTotals(), { cronRun: 2, gateway: 1 });
  assert.deepEqual(reader.laneDiagnostics().queued, { database: 0, inference: 0, maintenance: 0, scan: 0 });

  console.log("PASS unknown write results replay only idempotent mutations, and every replay is counted");
} finally {
  const reader = db.runtimeAuditReader as { close?: () => Promise<void> } | undefined;
  Object.assign(db, { runtimeAuditReader: undefined });
  await reader?.close?.();
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
}
