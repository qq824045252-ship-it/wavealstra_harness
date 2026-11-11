import type Database from "better-sqlite3";
import type { MemoryScopeType, MemoryTurnDto } from "../../shared/memory-kernel";

/** Source invalidation, not a second memory store: no forgotten content or history
 * deletion. Call advance in the same transaction as the corresponding removal. */
export class MemoryForgetWatermarks {
  constructor(private readonly db: Database.Database) {}

  advance(scopes: Array<{ scopeType: MemoryScopeType; scopeId?: string }>, cutoffAt = Date.now(), allowedMessageId?: string): void {
    if (!Number.isFinite(cutoffAt) || cutoffAt < 0) throw new Error("遗忘来源时间无效");
    const put = this.db.prepare(`INSERT INTO memory_forget_watermarks(scope_type,scope_id,cutoff_at,allowed_message_id) VALUES (?,?,?,?)
      ON CONFLICT(scope_type,scope_id) DO UPDATE SET cutoff_at=excluded.cutoff_at,allowed_message_id=excluded.allowed_message_id
      WHERE excluded.cutoff_at >= cutoff_at`);
    for (const scope of scopes) put.run(scope.scopeType, scope.scopeId ?? "", cutoffAt, allowedMessageId ?? null);
  }

  newerSources(scopeType: MemoryScopeType, scopeId: string | undefined, turns: readonly MemoryTurnDto[]): MemoryTurnDto[] {
    const row = this.db.prepare("SELECT cutoff_at,allowed_message_id FROM memory_forget_watermarks WHERE scope_type=? AND scope_id=?")
      .get(scopeType, scopeId ?? "") as { cutoff_at: number; allowed_message_id: string | null } | undefined;
    // A mixed forget-A/remember-B request may supply new B evidence in this exact
    // message. The evidence filter still rejects its forget/negative clauses.
    return row ? turns.filter(turn => turn.capturedAt > row.cutoff_at
      || Boolean(row.allowed_message_id && turn.userMessageId === row.allowed_message_id)) : [...turns];
  }
}
