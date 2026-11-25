import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-durable-task-projection-test-"));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { DurableTaskProjection } = await import("../src/main/agent/durable/DurableTaskProjection");
const { locateRuntimeAudit } = await import("../src/main/platform/runtime-audit");
const native = process.argv.includes("--native");
const runtimeAuditExecutable = native ? locateRuntimeAudit(process.cwd()) : undefined;
if (native) assert.ok(runtimeAuditExecutable && existsSync(runtimeAuditExecutable));

const db = new AppDatabase(join(sandbox, "app.db"), { runtimeAuditExecutable });
const projection = new DurableTaskProjection(db.connection, db.runtimeAuditReader);
const projected = (taskId: string) => {
  const task = db.getTask(taskId);
  return task && { status: task.status, updatedAt: task.updatedAt };
};
async function write<T>(operation: () => Promise<T>): Promise<T> {
  if (native) db.connection.pragma("query_only = ON");
  try { return await operation(); }
  finally { if (native) db.connection.pragma("query_only = OFF"); }
}

try {
  db.upsertTask({ id: "task", title: "task", updatedAt: 100, welcomeMode: "general" });
  db.connection.exec(`CREATE TABLE IF NOT EXISTS durable_bot_message_workspaces (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL, cwd TEXT NOT NULL, PRIMARY KEY(task_id, message_id));
    CREATE TRIGGER reject_projection_origin BEFORE INSERT ON durable_bot_message_workspaces
    WHEN NEW.message_id = 'reject'
    BEGIN SELECT RAISE(ABORT, 'origin rejected'); END;`);

  assert.deepEqual(await write(() => projection.writeSnapshot("task", "in_progress", 200, [
    { messageId: "message-1", cwd: "/workspace" },
  ])), { activityAt: 200, workspaces: [{ messageId: "message-1", cwd: "/workspace" }] });
  assert.deepEqual(projected("task"), { status: "in_progress", updatedAt: 200 });
  db.connection.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run("completed", 250, "task");
  assert.equal((await write(() => projection.writeSnapshot("task", "in_progress", 150, []))).activityAt, 250);
  // Ordering guard: a projection older than the stored activity must not move the status back.
  assert.deepEqual(projected("task"), { status: "completed", updatedAt: 250 },
    "a stale projection must not overwrite a newer status");

  for (const at of [0, NaN, Infinity, undefined, "500"]) {
    assert.equal((await write(() => projection.writeSnapshot("task", "in_progress", at, []))).activityAt, 250);
  }
  assert.equal((await write(() => projection.writeSnapshot("missing-task", "in_progress", 5_000, []))).activityAt, 5_000);
  assert.deepEqual(await write(() => projection.writeSnapshot("missing-task", "in_progress", 0, [
    { messageId: "missing", cwd: "/workspace" },
  ])), { activityAt: undefined, workspaces: [] });

  db.connection.prepare("UPDATE tasks SET updated_at = 0 WHERE id = ?").run("task");
  assert.equal((await write(() => projection.writeSnapshot("task", "in_progress", 900.5, []))).activityAt, 900.5);
  assert.deepEqual(projected("task"), { status: "in_progress", updatedAt: 900.5 });


  await assert.rejects(write(() => projection.writeSnapshot("task", "completed", 1000, [
    { messageId: "reject", cwd: "/destination" },
  ])), /origin rejected/);
  assert.deepEqual(projected("task"), { status: "in_progress", updatedAt: 900.5 });
  await write(() => projection.rememberWorkspaces("task", [
    { messageId: "message-1", cwd: "/destination" },
    { messageId: "message-2", cwd: "/destination" },
  ]));
  assert.deepEqual(db.connection.prepare(`SELECT task_id AS taskId, message_id AS messageId, cwd
    FROM durable_bot_message_workspaces ORDER BY message_id`).all(), [
    { taskId: "task", messageId: "message-1", cwd: "/workspace" },
    { taskId: "task", messageId: "message-2", cwd: "/destination" },
  ]);
  const reopened = new DurableTaskProjection(db.connection, db.runtimeAuditReader);
  assert.deepEqual(await write(() => reopened.writeSnapshot("task", "completed", 1_000, [
    { messageId: "message-1", cwd: "/destination" },
  ])), {
    activityAt: 1_000,
    workspaces: [{ messageId: "message-1", cwd: "/workspace" }],
  });
  // An unanswered native write is "unknown", never a reason to write the host copy.
  db.upsertTask({ id: "unknown-task", title: "unknown", updatedAt: 100, welcomeMode: "general", status: "waiting" });
  const unknown = new DurableTaskProjection(db.connection, {
    writeDurableTaskProjection: async () => undefined,
  } as unknown as typeof db.runtimeAuditReader);
  await assert.rejects(write(() => unknown.writeSnapshot("unknown-task", "completed", 5_000, [
    { messageId: "message-unknown", cwd: "/workspace" },
  ])), (error: Error & { code?: string }) => error.code === "DURABLE_PROJECTION_UNKNOWN");
  assert.equal(db.getTask("unknown-task")?.status, "waiting", "an unknown result must not rewrite the host row");
  assert.equal((db.connection.prepare(
    "SELECT COUNT(*) AS n FROM durable_bot_message_workspaces WHERE message_id='message-unknown'").get() as { n: number }).n, 0);
  await assert.rejects(write(() => unknown.rememberWorkspaces("task", [
    { messageId: "message-unknown", cwd: "/elsewhere" },
  ])), /结果未知/);

  // An explicit needsHost still falls back, and an applied write never touches the host.
  db.upsertTask({ id: "fallback-task", title: "fallback", updatedAt: 100, welcomeMode: "general", status: "waiting" });
  const fallback = new DurableTaskProjection(db.connection, {
    writeDurableTaskProjection: async () => ({ status: "needsHost" }),
  } as unknown as typeof db.runtimeAuditReader);
  // An explicit needsHost is allowed to write the host copy, so this call runs outside the read-only guard.
  assert.deepEqual(await fallback.writeSnapshot("fallback-task", "completed", 4_000, []), { activityAt: 4_000, workspaces: [] });
  assert.equal(db.getTask("fallback-task")?.status, "completed");
  const applied = new DurableTaskProjection(db.connection, {
    writeDurableTaskProjection: async () => ({ status: "applied", activityAt: 7_000, workspaces: [] }),
  } as unknown as typeof db.runtimeAuditReader);
  // Interleaved delivery: a newer snapshot that lands first wins, the late older one is ignored,
  // and a genuinely newer status still applies afterwards.
  assert.equal((await write(() => projection.writeSnapshot("task", "completed", 1_200, []))).activityAt, 1_200);
  assert.equal((await write(() => projection.writeSnapshot("task", "in_progress", 1_000, []))).activityAt, 1_200);
  assert.deepEqual(projected("task"), { status: "completed", updatedAt: 1_200 },
    "an out-of-order retry must not reopen a completed task");
  assert.equal((await write(() => projection.writeSnapshot("task", "in_progress", 1_300, []))).activityAt, 1_300);
  assert.deepEqual(projected("task"), { status: "in_progress", updatedAt: 1_300 },
    "a newer projection still updates the status");
  const beforeApplied = projected("task");
  assert.deepEqual(await write(() => applied.writeSnapshot("task", "completed", 1_000, [])), { activityAt: 7_000, workspaces: [] });
  assert.deepEqual(projected("task"), beforeApplied, "a native reply must not be rewritten on the host");
  console.log(`PASS status, monotonic activity, rollback, unknown-result refusal and first-observed workspaces (${native ? "Rust" : "host"})`);
} finally {
  await db.runtimeAuditReader?.close();
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
}
