import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";

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
console.log("Execution failure dismiss checks passed: hide != resolve, recurrence resurfaces, real recovery resolves");