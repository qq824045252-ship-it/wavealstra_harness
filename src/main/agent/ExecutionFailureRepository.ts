import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExecutionFailureDto } from "../../shared/execution-recovery";

export class ExecutionFailureRepository {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS execution_failures (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, cause_code TEXT NOT NULL,
      record_json TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER
    ); CREATE INDEX IF NOT EXISTS idx_execution_failures_task ON execution_failures(task_id, created_at);`);
    const columns = db.prepare("PRAGMA table_info(execution_failures)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "dismissed_at")) db.exec("ALTER TABLE execution_failures ADD COLUMN dismissed_at INTEGER");
    // Legacy MyBuddy versions persisted every shell non-zero exit as a Recovery card. Those are ordinary tool failures, not unresolved recovery state.
    db.prepare("UPDATE execution_failures SET dismissed_at = COALESCE(dismissed_at, ?) WHERE cause_code = 'shell-exit-nonzero' AND resolved_at IS NULL AND dismissed_at IS NULL").run(Date.now());
  }

  record(input: Omit<ExecutionFailureDto, "id" | "createdAt" | "resolvedAt" | "dismissedAt">): ExecutionFailureDto {
    const record = { ...input, message: input.message.slice(0, 8000), nextAction: input.nextAction.slice(0, 2000), id: randomUUID(), createdAt: Date.now() };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO execution_failures(id,task_id,cause_code,record_json,created_at) VALUES (?,?,?,?,?)")
        .run(record.id, record.taskId, record.causeCode, JSON.stringify(record), record.createdAt);
      this.db.prepare("DELETE FROM execution_failures WHERE task_id = ? AND id NOT IN (SELECT id FROM execution_failures WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100)").run(record.taskId, record.taskId);
    })();
    return record;
  }

  recordIfAbsent(input: Omit<ExecutionFailureDto, "id" | "createdAt" | "resolvedAt" | "dismissedAt">): ExecutionFailureDto {
    // Dismissed failures are intentionally absent from list(); if the same failure happens again,
    // create a fresh visible record instead of reviving or silently swallowing the old one.
    const existing = this.list(input.taskId).find((item) => !item.resolvedAt && item.causeCode === input.causeCode
      && item.target === input.target && item.recovery === input.recovery && item.phase === input.phase);
    return existing ?? this.record(input);
  }

  list(taskId: string): ExecutionFailureDto[] {
    const rows = this.db.prepare("SELECT record_json, resolved_at, dismissed_at FROM execution_failures WHERE task_id = ? AND dismissed_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 100").all(taskId) as Array<{ record_json: string; resolved_at: number | null; dismissed_at: number | null }>;
    return rows.flatMap((row) => {
      try {
        const record = JSON.parse(row.record_json) as ExecutionFailureDto;
        if (record.taskId !== taskId || typeof record.id !== "string" || typeof record.message !== "string"
          || typeof record.causeCode !== "string" || typeof record.nextAction !== "string"
          || !["retryable", "recoverable", "requires-user-action", "terminal"].includes(record.recovery)
          || !["prepare", "execute", "observe", "verify", "recover"].includes(record.phase)
          || !["none", "known", "unknown"].includes(record.sideEffects) || !Number.isFinite(record.createdAt)) return [];
        return [{ ...record, resolvedAt: row.resolved_at ?? undefined, dismissedAt: row.dismissed_at ?? undefined }];
      } catch { return []; } // Keep the original corrupt row for diagnosis.
    });
  }

  resolveWorkspaceFailures(taskId: string): void {
    this.db.prepare("UPDATE execution_failures SET resolved_at = ? WHERE task_id = ? AND resolved_at IS NULL AND cause_code IN ('workspace-path-missing','workspace-path-invalid','workspace-binding-missing','workspace-binding-cycle')").run(Date.now(), taskId);
  }

  /** Hide one recovery card without claiming the underlying failure is resolved. */
  dismiss(taskId: string, id: string): boolean {
    const change = this.db.prepare("UPDATE execution_failures SET dismissed_at = ? WHERE id = ? AND task_id = ? AND resolved_at IS NULL AND dismissed_at IS NULL").run(Date.now(), id, taskId);
    return change.changes > 0;
  }

  resolveMatching(taskId: string, input: { target?: string; causeCodes?: readonly string[] }): number {
    const rows = this.db.prepare("SELECT id, cause_code, record_json FROM execution_failures WHERE task_id = ? AND resolved_at IS NULL ORDER BY created_at DESC, rowid DESC").all(taskId) as Array<{ id: string; cause_code: string; record_json: string }>;
    const ids = rows.flatMap((row) => {
      if (input.causeCodes?.length && !input.causeCodes.includes(row.cause_code)) return [];
      if (input.target !== undefined) {
        try { if ((JSON.parse(row.record_json) as ExecutionFailureDto).target !== input.target) return []; }
        catch { return []; }
      }
      return [row.id];
    });
    if (!ids.length) return 0;
    const update = this.db.prepare("UPDATE execution_failures SET resolved_at = ? WHERE id = ? AND task_id = ? AND resolved_at IS NULL");
    const now = Date.now();
    return this.db.transaction(() => ids.reduce((count, id) => count + update.run(now, id, taskId).changes, 0))();
  }
}