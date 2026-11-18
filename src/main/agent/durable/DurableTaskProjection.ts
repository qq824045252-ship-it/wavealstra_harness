import type { Database, Statement } from "better-sqlite3";
import { activityTimeOrUndefined } from "../../../../shared/src/activity-time";

/**
 * Durable snapshot → `tasks` projection writes.
 *
 * Statements are prepared once per opened Bot instead of once per snapshot. Equality lives in SQL
 * (`IS NOT`, `<`) rather than an in-memory last-value cache, so an external edit is never hidden:
 * a write happens exactly when the stored value differs, and `updated_at` can only advance.
 *
 * `recordActivity` is the **only** writer of `tasks.updated_at` for a Durable Bot. It also returns
 * the value that ended up stored, so the caller can publish that authoritative value to the UI
 * instead of letting the renderer derive one of its own from message timestamps.
 */
export class DurableTaskProjection {
  private readonly setStatus: Statement;
  private readonly touchUpdatedAt: Statement;
  private readonly readUpdatedAt: Statement;
  private readonly rememberMessage: Statement;

  constructor(db: Database) {
    this.setStatus = db.prepare("UPDATE tasks SET status = ? WHERE id = ? AND status IS NOT ?");
    this.touchUpdatedAt = db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ? AND updated_at < ?");
    this.readUpdatedAt = db.prepare("SELECT updated_at FROM tasks WHERE id = ?");
    this.rememberMessage = db.prepare("INSERT OR IGNORE INTO durable_bot_message_workspaces VALUES (?, ?, ?)");
  }

  /** Returns the number of rows actually rewritten (0 = projection already current). */
  writeStatus(taskId: string, value: string): number {
    return this.setStatus.run(value, taskId, value).changes;
  }

  /**
   * `updated_at` tracks the newest event; it must never move backwards and never hold a non-instant.
   *
   * Returns the value to publish: the authoritative **stored** value when the task row exists,
   * otherwise the valid candidate itself (nothing was persisted, so nothing can be overridden).
   * An invalid candidate never wins: on an existing row the stored instant comes back instead,
   * and with nothing valid on offer the result is `undefined` — “no new activity evidence”.
   */
  recordActivity(taskId: string, at: unknown): number | undefined {
    const candidate = activityTimeOrUndefined(at);
    if (candidate !== undefined && this.touchUpdatedAt.run(candidate, taskId, candidate).changes > 0) return candidate;
    const row = this.readUpdatedAt.get(taskId) as { updated_at: number } | undefined;
    // A legacy row holding 0 is repaired by the write above, so a stored invalid value only
    // reaches here while nothing valid is on offer; then `undefined` says "no authority today".
    return activityTimeOrUndefined(row?.updated_at) ?? candidate;
  }

  rememberWorkspace(taskId: string, messageId: string, cwd: string): number {
    return this.rememberMessage.run(taskId, messageId, cwd).changes;
  }
}