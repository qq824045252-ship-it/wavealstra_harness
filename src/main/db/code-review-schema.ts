import type Database from "better-sqlite3";

export function ensureCodeReviewSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_code_review (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      target_key TEXT NOT NULL,
      root_entity TEXT NOT NULL,
      path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
      before_present INTEGER NOT NULL,
      before_stamp TEXT NOT NULL,
      before_bytes BLOB,
      before_mode INTEGER,
      after_present INTEGER NOT NULL,
      after_stamp TEXT NOT NULL,
      after_bytes BLOB,
      after_mode INTEGER,
      additions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      stats_available INTEGER NOT NULL,
      capture_reason TEXT,
      failure_reason TEXT,
      restoring INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, target_key)
    );
    CREATE INDEX IF NOT EXISTS idx_task_code_review_status ON task_code_review(task_id, status);
  `);
}
