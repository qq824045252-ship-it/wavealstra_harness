import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { locateRuntimeAudit, RuntimeAuditReader } from "../src/main/platform/runtime-audit";

const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks(id) VALUES ('task-1');");
// Simulate an existing pre-dismiss schema to prove additive migration is safe.
db.exec(`CREATE TABLE execution_failures (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, cause_code TEXT NOT NULL,
  record_json TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER
)`);
const failures = new ExecutionFailureRepository(db);
const columns = db.prepare("PRAGMA table_info(execution_failures)").all() as Array<{ name: string }>;
assert(columns.some(c => c.name === "dismissed_at"), "legacy DB gains dismissed_at additively");

const input = {
  taskId: "task-1",
  causeCode: "workspace-path-missing",
  phase: "prepare" as const,
  recovery: "requires-user-action" as const,
  sideEffects: "none" as const,
  message: "workspace unavailable",
  nextAction: "rebind workspace",
  target: "C:/missing",
};
const first = failures.recordIfAbsent(input);
assert.equal(failures.recordIfAbsent(input).id, first.id, "visible unresolved failure is deduplicated");
assert.equal(failures.dismiss("task-1", first.id), true, "visible card can be hidden");
assert.equal(failures.list("task-1").some(x => x.id === first.id), false, "dismissed card disappears from UI list");
const rawFirst = db.prepare("SELECT resolved_at, dismissed_at FROM execution_failures WHERE id = ?").get(first.id) as { resolved_at: number | null; dismissed_at: number | null };
assert.equal(rawFirst.resolved_at, null, "dismissing does not pretend the failure is resolved");
assert.ok(rawFirst.dismissed_at, "dismiss time is persisted");

const repeated = failures.recordIfAbsent(input);
assert.notEqual(repeated.id, first.id, "same failure occurring again becomes visible as a fresh record");
assert.equal(failures.list("task-1")[0]?.id, repeated.id);
assert.equal(failures.resolveMatching("task-1", { target: "C:/missing", causeCodes: ["workspace-path-missing"] }), 2, "real recovery resolves both hidden history and current visible failure");
const raw = db.prepare("SELECT id, resolved_at, dismissed_at FROM execution_failures ORDER BY created_at, rowid").all() as Array<{ id: string; resolved_at: number | null; dismissed_at: number | null }>;
assert(raw.every(row => row.resolved_at), "real recovery is still the only resolved signal");
assert(raw.find(row => row.id === first.id)?.dismissed_at, "historical dismissal remains auditable");
assert.equal(failures.list("task-1").filter(x => !x.resolvedAt).length, 0, "no unresolved visible card after real recovery");

db.close();

async function checkDisplay(): Promise<void> {
  const native = process.argv.includes("--native");
  const executable = native ? locateRuntimeAudit(process.cwd()) : undefined;
  if (native) assert(executable && existsSync(executable));
  const root = executable ? mkdtempSync(join(tmpdir(), "mybuddy-execution-failure-")) : undefined;
  const path = root ? join(root, "app.db") : ":memory:";
  const connection = new Database(path);
  const worker = executable ? new RuntimeAuditReader(executable, path) : undefined;
  try {
    connection.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks(id) VALUES ('task-1'), ('task-2');");
    const repository = new ExecutionFailureRepository(connection, worker);
    const resolved = repository.record({ ...input, message: "workspace restored" });
    repository.resolveWorkspaceFailures("task-1");
    repository.record({ ...input, taskId: "task-2", message: "belongs to another task" });
    const earlier = repository.record({ ...input, message: "older failure" });
    const latest = repository.record({ ...input, message: "latest failure", nextAction: "review the workspace path" });
    repository.record({
      ...input, message: "locator feedback", causeCode: "browser-selector-not-found",
      phase: "observe", recovery: "recoverable",
    });
    connection.prepare("UPDATE execution_failures SET created_at = 1 WHERE task_id = ?").run("task-1");
    if (worker) connection.exec("CREATE TEMP TABLE execution_failures AS SELECT * FROM main.execution_failures WHERE 0");
    assert.deepEqual((await repository.listForDisplay("task-1")).map(item => [item.message, item.nextAction, !!item.resolvedAt]), [
      ["latest failure", "review the workspace path", false],
      ["older failure", "rebind workspace", false],
      ["workspace restored", "rebind workspace", true],
    ]);
    if (worker) {
      connection.exec("DROP TABLE temp.execution_failures");
      connection.pragma("query_only = ON");
    }
    assert.equal(await repository.dismissForDisplay("task-2", latest.id), false);
    assert.equal(await repository.dismissForDisplay("task-1", resolved.id), false);
    assert.deepEqual(await Promise.all([
      repository.dismissForDisplay("task-1", latest.id),
      repository.dismissForDisplay("task-1", latest.id),
    ]), [true, false]);
    assert.deepEqual((await repository.listForDisplay("task-1")).map(item => item.id), [earlier.id, resolved.id]);
    const history = repository.list("task-1", { includeDismissed: true }).find(item => item.id === latest.id);
    assert.equal(history?.message, "latest failure");
    assert.equal(history?.resolvedAt, undefined);
    assert(Number.isFinite(history?.dismissedAt));
  } finally {
    await worker?.close();
    connection.close();
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

await checkDisplay();
console.log("Execution failure dismiss checks passed: hide != resolve, recurrence resurfaces, real recovery resolves");
