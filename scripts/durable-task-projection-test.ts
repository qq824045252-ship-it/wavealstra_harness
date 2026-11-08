/**
 * DurableTaskProjection — Issue #17 C: per-snapshot projection writes are prepared once and only
 * rewrite a row when the stored value actually differs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-durable-task-projection-test-"));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { DurableTaskProjection } = await import("../src/main/agent/durable/DurableTaskProjection");

try {
  const db = new AppDatabase(join(sandbox, "app.db"));
  db.upsertTask({ id: "task", title: "task", updatedAt: 100, welcomeMode: "bot" });
  // The service owns this table (created in DurableBotService); the writer only reads/writes it.
  db.connection.exec(`CREATE TABLE IF NOT EXISTS durable_bot_message_workspaces (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL, cwd TEXT NOT NULL, PRIMARY KEY(task_id, message_id))`);
  const projection = new DurableTaskProjection(db.connection);

  assert.equal(projection.writeStatus("task", "in_progress"), 1, "a changed status is written");
  assert.equal(projection.writeStatus("task", "in_progress"), 0, "an unchanged status rewrites nothing");
  db.connection.prepare("UPDATE tasks SET status = ? WHERE id = ?").run("completed", "task");

  // A per-snapshot prepare would allocate a new statement every callback. Count only prepares
  // issued from here on, after the external edit above used its own statement.
  const prepare = db.connection.prepare.bind(db.connection);
  let prepares = 0;
  (db.connection as { prepare: typeof db.connection.prepare }).prepare = ((sql: string) => {
    prepares += 1;
    return prepare(sql);
  }) as typeof db.connection.prepare;

  assert.equal(projection.writeStatus("task", "in_progress"), 1, "an external edit is never hidden by a cache");
  assert.equal(prepares, 0, "snapshot writes reuse statements prepared at open");

  assert.equal(db.getTask("task")?.status, "in_progress");
  assert.equal(projection.touch("task", 200), 1, "a newer message advances updated_at");
  assert.equal(projection.touch("task", 150), 0, "updated_at never moves backwards");
  assert.equal(projection.touch("task", 200), 0, "the same timestamp rewrites nothing");
  assert.equal(db.getTask("task")?.updatedAt, 200);

  assert.equal(projection.rememberWorkspace("task", "message-1", "/workspace"), 1);
  assert.equal(projection.rememberWorkspace("task", "message-1", "/workspace"), 0, "remembering is idempotent");
  const remembered = db.connection.prepare("SELECT COUNT(*) AS count FROM durable_bot_message_workspaces WHERE task_id = ?").get("task") as { count: number };
  assert.equal(remembered.count, 1);
  console.log("PASS projection writes are prepared once, conditional and idempotent");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
