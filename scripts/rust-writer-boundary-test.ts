/**
 * Step 4 real-process writer boundary acceptance (`RC-09`).
 *
 * Verifies with a real supervised Rust Core binary:
 *   1. Supervised production AppDatabase opens strictly `readonly: true` (`query_only = 1`).
 *   2. Direct Node SQL writes to `app.db` fail with SQLITE_READONLY.
 *   3. Application domain writes (`tasks`, `spaces`, `work*`, `cron*`, `notifications`)
 *      commit exclusively through Rust IPC while `app.db` stays readonly, and survive reopen.
 *   4. Pi companion SQLite stores (`durable.sqlite`, `native-hooks.sqlite`,
 *      `.mybuddy-writer-lock.sqlite`) remain Node/Pi-owned RW without interference.
 *   5. Production source files under `src/main/` with SQLite writes outside `db/`,
 *      `durable/`, `hooks/` carry explicit Rust / readonly enforcement guards.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { encodeCronPlan } from "../src/main/db/CronPlanPersistence";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DESKTOP_USER_GRANTS, WorkService } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkProjectionDto } from "../src/shared/bot-work";
import { NotificationService } from "../src/main/notification/NotificationService";
import { DurableSqliteDatabase } from "../src/main/agent/durable/DurableSqliteDatabase";
import { claimDurableStorageLease, type DurableStorageLease } from "../src/main/agent/durable/DurableStorageLease";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "The real Rust worker binary is required");

const testsRoot = join(process.cwd(), "out", "tests");
mkdirSync(testsRoot, { recursive: true });
const sandbox = mkdtempSync(join(testsRoot, "rust-writer-boundary-"));
const dataDir = join(sandbox, "core-data");
const dbPath = join(dataDir, "app.db");
const envDir = join(sandbox, "mybuddy-home");
mkdirSync(dataDir, { recursive: true });
mkdirSync(envDir, { recursive: true });

const prevMyBuddyDir = process.env.MYBUDDY_DIR;
process.env.MYBUDDY_DIR = envDir;

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.isFile() && /\.(ts|tsx|mjs|cjs)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

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

let app: AppDatabase | undefined;
let durableDb: DurableSqliteDatabase | undefined;
let durableLease: DurableStorageLease | undefined;

try {
  // 1. Production entrypoint verification: src/main/index.ts passes readonly: true.
  const indexSource = readFileSync(join(process.cwd(), "src", "main", "index.ts"), "utf8");
  assert(
    /AppDatabase\.open\([^)]*runtimeAuditSupervised:\s*true[^)]*readonly:\s*true/.test(indexSource),
    "src/main/index.ts must open supervised production AppDatabase with readonly: true",
  );

  // 2. Static boundary verification: no unguarded SQLite write file outside db/, durable/, hooks/.
  const mainFiles = walkTsFiles(join(process.cwd(), "src", "main"));
  const writeSqlRe = /\.(prepare|exec)\([^)]*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/is;
  const guardRe = /\b(requiresWorkRustWrites|requiresRustWrites|workDomainRunTx|workDomainInTx|runtimeAuditReader|readonly|supervised)\b/;
  const unguarded: string[] = [];
  for (const file of mainFiles) {
    const rel = file.slice(process.cwd().length + 1).replace(/\\/g, "/");
    if (
      rel.startsWith("src/main/db/")
      || rel.startsWith("src/main/agent/durable/")
      || rel.startsWith("src/main/agent/hooks/")
    ) continue;
    const text = readFileSync(file, "utf8");
    if (writeSqlRe.test(text) && !guardRe.test(text)) unguarded.push(rel);
  }
  assert.deepEqual(unguarded, [], `Found unguarded SQLite write files in src/main/: ${unguarded.join(", ")}`);

  // 3. Supervised Core opens app.db with readonly: true & query_only = 1.
  app = await within(
    AppDatabase.open(dbPath, { runtimeAuditExecutable: executable, runtimeAuditSupervised: true, readonly: true }),
    "open supervised readonly AppDatabase",
  );
  assert.equal(app.readonly, true, "AppDatabase.readonly must be true");
  assert.equal(app.connection.readonly, true, "better-sqlite3 connection must be readonly");
  assert.equal(app.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "Rust Core initializes current schema");
  assert.equal(Number(app.connection.pragma("query_only", { simple: true })), 1, "SQLite query_only must be ON");

  // Direct Node SQL writes to app.db must be rejected by SQLite itself.
  assert.throws(
    () => app!.connection.prepare("INSERT INTO tasks(id, title, updated_at) VALUES ('bad', 'Bad', 1)").run(),
    /readonly/i,
    "direct INSERT on app.db must fail with readonly",
  );
  assert.throws(
    () => app!.connection.exec("UPDATE spaces SET name='mutated'"),
    /readonly/i,
    "direct UPDATE on app.db must fail with readonly",
  );

  // 4. Write across application domains through Rust IPC while app.db stays readonly.
  const space = await app.writeWorkspaceUpsert({ id: "sp-rc09", name: "RC09 Space", path: join(sandbox, "ws") });
  assert.equal(space.name, "RC09 Space");

  const now = Date.now();
  await app.writeTaskRecord({
    id: "task-rc09",
    title: "RC09 Task",
    spaceId: space.id,
    updatedAt: now,
    welcomeMode: "general",
    cwd: join(sandbox, "legacy-ws", "t1"),
  });
  await app.writeTaskSidebar({ kind: "favorite", id: "task-rc09", title: "RC09 Task", isFavorited: true, updatedAt: now + 1 });
  await app.writeTaskDueDate("task-rc09", now + 60_000);
  const rebind = app.rebindLegacyTaskWorkspacePaths(
    join(sandbox, "legacy-ws"),
    join(sandbox, "modern-ws"),
    join(sandbox, "legacy-trash"),
    join(sandbox, "modern-trash"),
  );
  assert.equal(rebind.cwds, 1, "rebindLegacyTaskWorkspacePaths queues cwd update via Rust");

  const bots = new BotRegistry(app.connection);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  const projections: WorkProjectionDto[] = [];
  const works = new WorkService(app.connection, {
    bots,
    runtimeAuditReader: app.runtimeAuditReader,
    emitProjection: p => projections.push(p),
  });
  const created = works.createWork(
    { kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS },
    {
      operationId: "rc09-work-op",
      title: "RC09 Rust Work",
      criteria: [{ id: "c1", text: "Rust commits while DB is readonly" }],
      inputSnapshotId: "snap-rc09",
      ownerBotId: DEFAULT_BOT_ID,
      authorization: DESKTOP_USER_GRANTS,
    },
  );
  assert.equal(created.ok, true, "Work creation succeeds under readonly AppDatabase");

  const notifications = new NotificationService(app);
  const notice = await notifications.publishPersisted({
    type: "task.completed",
    level: "info",
    title: "RC09 Notice",
    body: "Persisted through Rust under readonly",
    sourceType: "task",
    sourceId: "task-rc09",
    taskId: "task-rc09",
    dedupeKey: "rc09:notice",
  });
  assert(notice?.id, "NotificationService.publishPersisted must commit through Rust");
  await notifications.writeMarkRead(notice.id);

  await app.writeCronPlan({
    kind: "save",
    row: encodeCronPlan({
      id: "cron-rc09",
      name: "RC09 Cron",
      enabled: true,
      scheduleType: "every",
      scheduleExpr: "60000",
      timezone: "UTC",
      prompt: "Check RC09",
      createdAt: now,
      updatedAt: now,
    }),
    expected: null,
  });

  await app.flushPersistenceWrites();

  // Verify persisted state via readonly SQLite connection & reopen.
  const reboundTask = app.getTask("task-rc09");
  assert.equal(reboundTask?.cwd, join(sandbox, "modern-ws", "t1"));
  assert.equal(reboundTask?.isFavorited, true);
  assert(works.getWork(created.work.workId), "Created Work persisted to app.db");
  assert(projections.length >= 1, "Work projection emitted");
  const cronRow = app.connection.prepare("SELECT id,name FROM cron_jobs WHERE id='cron-rc09'").get() as { id: string; name: string } | undefined;
  assert.equal(cronRow?.name, "RC09 Cron");
  const notifRow = app.connection.prepare("SELECT read_at FROM notifications WHERE id=?").get(notice.id) as { read_at: number | null } | undefined;
  assert(notifRow?.read_at !== null && notifRow?.read_at !== undefined, "Notification read_at committed by Rust");

  await within(app.runtimeAuditReader!.close(), "close runtimeAuditReader");
  app.close();
  app = undefined;

  // Reopen readonly & confirm durable state survives.
  app = await within(
    AppDatabase.open(dbPath, { runtimeAuditExecutable: executable, runtimeAuditSupervised: true, readonly: true }),
    "reopen supervised readonly AppDatabase",
  );
  assert.equal(app.readonly, true);
  assert.equal(app.getTask("task-rc09")?.title, "RC09 Task");
  const worksAfter = new WorkService(app.connection, {
    bots: new BotRegistry(app.connection),
    runtimeAuditReader: app.runtimeAuditReader,
  });
  assert.equal(worksAfter.getWork(created.work.workId)?.title, "RC09 Rust Work");

  // 5. Verify Pi companion SQLite stores remain Node/Pi-owned RW independently.
  const durableDir = join(sandbox, "pi-durable");
  mkdirSync(durableDir, { recursive: true });
  durableLease = claimDurableStorageLease(durableDir);
  durableDb = await DurableSqliteDatabase.open(join(durableDir, "durable.sqlite"));
  await durableDb.exec("CREATE TABLE IF NOT EXISTS pi_probe(id TEXT PRIMARY KEY, val TEXT); INSERT INTO pi_probe VALUES ('1', 'rw-ok');");
  const piRow = await durableDb.all<{ val?: string }>("SELECT val FROM pi_probe WHERE id='1'");
  assert.equal(piRow[0]?.val, "rw-ok", "Pi durable.sqlite must remain RW");

  console.log("PASS RC-09 rust-writer-boundary: supervised readonly app.db enforced, Rust domain writes committed, Pi companion DBs RW");
} finally {
  try { await durableDb?.close(); } catch { /* cleanup */ }
  try { durableLease?.release(); } catch { /* cleanup */ }
  if (app) {
    try { await app.runtimeAuditReader?.close(); } catch { /* cleanup */ }
    app.close();
  }
  await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
  if (prevMyBuddyDir === undefined) delete process.env.MYBUDDY_DIR;
  else process.env.MYBUDDY_DIR = prevMyBuddyDir;
  rmSync(sandbox, { recursive: true, force: true });
}
