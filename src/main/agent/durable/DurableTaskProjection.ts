import type { Database, Statement } from "better-sqlite3";

/**
 * Durable snapshot → `tasks` projection writes.
 *
 * Statements are prepared once per opened Bot instead of once per snapshot. Equality lives in SQL
 * (`IS NOT`, `<`) rather than an in-memory last-value cache, so an external edit is never hidden:
 * a write happens exactly when the stored value differs, and `updated_at` can only advance.
 */
export class DurableTaskProjection {
  private readonly setStatus: Statement;
  private readonly touchUpdatedAt: Statement;
  private readonly rememberMessage: Statement;

  constructor(db: Database) {
    this.setStatus = db.prepare("UPDATE tasks SET status = ? WHERE id = ? AND status IS NOT ?");
    this.touchUpdatedAt = db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ? AND updated_at < ?");
    this.rememberMessage = db.prepare("INSERT OR IGNORE INTO durable_bot_message_workspaces VALUES (?, ?, ?)");
  }

  /** Returns the number of rows actually rewritten (0 = projection already current). */
  writeStatus(taskId: string, value: string): number {
    return this.setStatus.run(value, taskId, value).changes;
  }

  /** `updated_at` tracks the newest message; it must never move backwards. */
  touch(taskId: string, at: number): number {
    return this.touchUpdatedAt.run(at, taskId, at).changes;
  }

  rememberWorkspace(taskId: string, messageId: string, cwd: string): number {
    return this.rememberMessage.run(taskId, messageId, cwd).changes;
  }
}
