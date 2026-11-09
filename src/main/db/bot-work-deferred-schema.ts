import type Database from "better-sqlite3";

/** Additive current-schema materialization. No version bump or user-data rebuild. */
export function ensureWorkDeferredTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_deferred_actions (
      approval_id TEXT PRIMARY KEY REFERENCES work_action_approvals(approval_id),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_hash TEXT NOT NULL,
      state TEXT NOT NULL, delivery_generation INTEGER NOT NULL DEFAULT 0, attempt_operation_id TEXT UNIQUE, reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
  const columns = db.prepare("PRAGMA table_info(work_deferred_actions)").all() as { name: string }[];
  if (!columns.some(column => column.name === "delivery_generation"))
    db.exec("ALTER TABLE work_deferred_actions ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 0");
}
