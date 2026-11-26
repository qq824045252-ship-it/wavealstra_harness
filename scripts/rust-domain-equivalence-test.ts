/**
 * Step 4 host-vs-Rust domain equivalence acceptance (`RC-10`).
 *
 * Runs identical operations side-by-side against:
 *   - Host RW (`new AppDatabase(hostDbPath)`)
 *   - Supervised Rust Readonly (`AppDatabase.open(rustDbPath, { runtimeAuditExecutable, runtimeAuditSupervised: true, readonly: true })`)
 *
 * Compares returned DTOs, error classifications, atomic transaction rollback behavior,
 * emitted Work projections, and final persisted SQLite rows across both databases.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DESKTOP_USER_GRANTS, WorkService } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkProjectionDto } from "../src/shared/bot-work";
import { NotificationService } from "../src/main/notification/NotificationService";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "The real Rust worker binary is required");

const testsRoot = join(process.cwd(), "out", "tests");
mkdirSync(testsRoot, { recursive: true });
const sandbox = mkdtempSync(join(testsRoot, "rust-domain-equivalence-"));
const hostDir = join(sandbox, "host");
const rustDir = join(sandbox, "rust");
const envDir = join(sandbox, "mybuddy-home");
mkdirSync(hostDir, { recursive: true });
mkdirSync(rustDir, { recursive: true });
mkdirSync(envDir, { recursive: true });

const prevMyBuddyDir = process.env.MYBUDDY_DIR;
process.env.MYBUDDY_DIR = envDir;

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout (${timeoutMs}ms): ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

interface ScenarioTrace {
  spaceName: string;
  taskTitle: string | undefined;
  taskDueAt: number | undefined;
  taskDoneAckedAt: number | undefined;
  workTitle: string | undefined;
  workLifecycleAfterPause: string;
  workLifecycleAfterResume: string;
  workIntentRevAfterAmend: number;
  conflictCode: string;
  rollbackCount: number;
  subscriptionCount: number;
  inboxCount: number;
  projectionCount: number;
  notificationRead: boolean;
}

async function runScenario(app: AppDatabase, fixedNow: number): Promise<ScenarioTrace> {
  const space = await app.writeWorkspaceUpsert({ id: "sp-eq", name: "Equiv Workspace", path: join(sandbox, "ws-eq") });
  await app.writeTaskRecord({
    id: "task-eq",
    title: "Equiv Task",
    spaceId: space.id,
    updatedAt: fixedNow,
    welcomeMode: "general",
  });
  await app.writeTaskDueDate("task-eq", fixedNow + 120_000);
  await app.writeTaskDoneAck("task-eq", fixedNow + 10);

  let clock = fixedNow;
  const projections: WorkProjectionDto[] = [];
  const bots = new BotRegistry(app.connection);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(app.connection, {
    bots,
    now: () => clock,
    runtimeAuditReader: app.runtimeAuditReader,
    emitProjection: p => projections.push(p),
  });
  const actor = { kind: "user" as const, userId: LOCAL_USER_ID, entry: "desktop" as const, grants: DESKTOP_USER_GRANTS };
  const created = works.createWork(actor, {
    operationId: "eq-create",
    title: "Equivalence Goal",
    criteria: [{ id: "c1", text: "Match host and rust" }],
    inputSnapshotId: "snap-1",
    ownerBotId: DEFAULT_BOT_ID,
    authorization: DESKTOP_USER_GRANTS,
    mode: "watch",
  });
  assert.equal(created.ok, true);

  const sub = works.phase4Control(actor, {
    kind: "configure-subscription",
    operationId: "eq-sub",
    workId: created.work.workId,
    source: "cron",
    catchUpPolicy: "latest",
    cronExpression: "* * * * *",
    timezone: "UTC",
    maxQueueDepth: 64,
    versionGuard: {
      expectedStateVersion: created.work.stateVersion,
      expectedIntentRevision: created.work.intentRevision,
      expectedOwnerEpoch: created.work.ownerEpoch,
    },
  });
  assert.equal(sub.ok, true);

  // Idempotency conflict check must produce the exact same error code.
  const conflict = works.createWork(actor, {
    operationId: "eq-create",
    title: "Conflicting Title",
    criteria: [{ id: "c1", text: "Diff" }],
    inputSnapshotId: "snap-1",
    ownerBotId: DEFAULT_BOT_ID,
    authorization: DESKTOP_USER_GRANTS,
  });
  assert.equal(conflict.ok, false);
  const conflictCode = conflict.code;

  // Pause -> Resume -> Amend
  clock += 100;
  const latestAfterSub = works.getWork(created.work.workId)!;
  const paused = works.pauseWork(actor, {
    operationId: "eq-pause",
    workId: created.work.workId,
    versionGuard: {
      expectedStateVersion: latestAfterSub.stateVersion,
      expectedIntentRevision: latestAfterSub.intentRevision,
      expectedOwnerEpoch: latestAfterSub.ownerEpoch,
    },
  });
  assert.equal(paused.ok, true);

  clock += 100;
  const resumed = works.resumeWork(actor, {
    operationId: "eq-resume",
    workId: created.work.workId,
    versionGuard: {
      expectedStateVersion: paused.work.stateVersion,
      expectedIntentRevision: paused.work.intentRevision,
      expectedOwnerEpoch: paused.work.ownerEpoch,
    },
  });
  assert.equal(resumed.ok, true);

  clock += 100;
  const amended = works.amendWork(actor, {
    operationId: "eq-amend",
    workId: created.work.workId,
    title: "Equivalence Goal v2",
    versionGuard: {
      expectedStateVersion: resumed.work.stateVersion,
      expectedIntentRevision: resumed.work.intentRevision,
      expectedOwnerEpoch: resumed.work.ownerEpoch,
    },
  });
  assert.equal(amended.ok, true);

  // Atomic rollback check: throw inside transaction leaves zero persistent traces.
  assert.throws(() => {
    works.transaction(() => {
      const r = works.createWork(actor, {
        operationId: "eq-rollback-op",
        title: "Should Rollback",
        criteria: [{ id: "cr", text: "Never committed" }],
        inputSnapshotId: "snap-rb",
        ownerBotId: DEFAULT_BOT_ID,
        authorization: DESKTOP_USER_GRANTS,
      });
      assert.equal(r.ok, true);
      throw new Error("injected_tx_abort");
    });
  }, /injected_tx_abort/);

  // Ingress accept + Scheduler tick
  clock += 120_000;
  works.ingress.setReceiverAvailable("cron", true);
  works.ingress.accept({
    source: "cron",
    sourceEventId: "cron-ev-1",
    eventType: "work.tick",
    occurredAt: clock,
    payload: { tick: 1 },
  }, { workId: created.work.workId, trust: "system" });
  works.scheduler.tick(clock);

  const notifications = new NotificationService(app);
  const n = await notifications.publishPersisted({
    type: "task.completed",
    level: "info",
    title: "Equiv Notice",
    sourceType: "task",
    sourceId: "task-eq",
    taskId: "task-eq",
    dedupeKey: "eq:notice",
    createdAt: fixedNow,
  });
  assert(n?.id, "notification published");
  await notifications.writeMarkRead(n.id);

  await app.flushPersistenceWrites();

  const savedTask = app.getTask("task-eq");
  const savedWork = works.getWork(created.work.workId);
  const rollbackWorks = works.listWorks(LOCAL_USER_ID).filter(w => w.title === "Should Rollback");
  const subscriptions = app.connection.prepare("SELECT * FROM work_subscriptions WHERE work_id=?").all(created.work.workId);
  const inboxRows = app.connection.prepare("SELECT * FROM work_events_inbox WHERE work_id=?").all(created.work.workId);
  const notifRow = app.connection.prepare("SELECT read_at FROM notifications WHERE id=?").get(n.id) as { read_at: number | null } | undefined;

  return {
    spaceName: space.name,
    taskTitle: savedTask?.title,
    taskDueAt: savedTask?.dueAt ?? undefined,
    taskDoneAckedAt: savedTask?.doneAckedAt ?? undefined,
    workTitle: savedWork?.title,
    workLifecycleAfterPause: paused.work.lifecycle,
    workLifecycleAfterResume: resumed.work.lifecycle,
    workIntentRevAfterAmend: amended.work.intentRevision,
    conflictCode,
    rollbackCount: rollbackWorks.length,
    subscriptionCount: subscriptions.length,
    inboxCount: inboxRows.length,
    projectionCount: projections.length,
    notificationRead: Boolean(notifRow?.read_at),
  };
}

let hostApp: AppDatabase | undefined;
let rustApp: AppDatabase | undefined;
const rustDbPath = join(rustDir, "app.db");

try {
  hostApp = new AppDatabase(join(hostDir, "app.db"));
  rustApp = await within(
    AppDatabase.open(rustDbPath, { runtimeAuditExecutable: executable, runtimeAuditSupervised: true, readonly: true }),
    "open supervised readonly AppDatabase",
  );

  const fixedNow = 1_760_000_000_000;
  const hostTrace = await runScenario(hostApp, fixedNow);
  const rustTrace = await runScenario(rustApp, fixedNow);

  assert.deepEqual(rustTrace, hostTrace, "Rust supervised readonly execution must match Host RW domain behavior");
  assert.equal(rustTrace.rollbackCount, 0, "aborted transaction must leave zero works");
  assert.equal(rustTrace.conflictCode, "idempotency_conflict");
  assert.equal(rustTrace.notificationRead, true);
  assert(rustTrace.inboxCount >= 1, "inbox event persisted in both host and rust");

  console.log("PASS RC-10 rust-domain-equivalence:", JSON.stringify(rustTrace));
} finally {
  hostApp?.close();
  if (rustApp) {
    try { await rustApp.runtimeAuditReader?.close(); } catch { /* cleanup */ }
    rustApp.close();
  }
  await shutdownCoreWorker(rustDir, rustDbPath).catch(() => undefined);
  if (prevMyBuddyDir === undefined) delete process.env.MYBUDDY_DIR;
  else process.env.MYBUDDY_DIR = prevMyBuddyDir;
  rmSync(sandbox, { recursive: true, force: true });
}
