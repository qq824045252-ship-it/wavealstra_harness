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

const db = new AppDatabase(join(sandbox, "app.db"));
try {
  db.upsertTask({ id: "task", title: "task", updatedAt: 100, welcomeMode: "general" });
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
  // recordActivity 返回的是「库里最终的值」，而不是 changes：调用方要拿它回填 UI 快照。
  assert.equal(projection.recordActivity("task", 200), 200, "a newer event advances updated_at");
  assert.equal(projection.recordActivity("task", 150), 200, "updated_at never moves backwards");
  assert.equal(projection.recordActivity("task", 200), 200, "the same timestamp rewrites nothing");
  assert.equal(db.getTask("task")?.updatedAt, 200);

  // 非法的候选值（epoch 0 / NaN / 缺失）不得成为任务时间，也不得丢掉已有权威值。
  assert.equal(projection.recordActivity("task", 0), 200, "epoch 0 never becomes the task time");
  assert.equal(projection.recordActivity("task", Number.NaN), 200, "NaN never becomes the task time");
  assert.equal(projection.recordActivity("task", undefined), 200, "a missing time keeps the stored one");
  assert.equal(db.getTask("task")?.updatedAt, 200);
  assert.equal(projection.recordActivity("missing-task", 5_000), 5_000, "with no row to persist, the valid candidate is echoed for the UI");
  assert.equal(projection.recordActivity("missing-task", 0), undefined, "no row and no valid candidate leaves nothing to publish");

  // 旧数据里的 0 会被下一次真实写入修好（单调条件 0 < candidate 成立）。
  db.connection.prepare("UPDATE tasks SET updated_at = 0 WHERE id = ?").run("task");
  assert.equal(projection.recordActivity("task", 900), 900, "a legacy 0 row is repaired by the next real event");
  assert.equal(db.getTask("task")?.updatedAt, 900);

  assert.equal(projection.rememberWorkspace("task", "message-1", "/workspace"), 1);
  assert.equal(projection.rememberWorkspace("task", "message-1", "/workspace"), 0, "remembering is idempotent");
  const remembered = db.connection.prepare("SELECT COUNT(*) AS count FROM durable_bot_message_workspaces WHERE task_id = ?").get("task") as { count: number };
  assert.equal(remembered.count, 1);
  console.log("PASS projection writes are prepared once, conditional and idempotent");
} finally {
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
}
