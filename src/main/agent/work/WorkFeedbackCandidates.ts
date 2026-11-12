import type Database from "better-sqlite3";
import { z } from "zod";

export const WORK_FEEDBACK_BATCH_SIZE = 64;
const candidateSchema = z.object({ workId: z.string(), sequence: z.number(), projected: z.number(), images: z.number() });
export type WorkFeedbackCandidate = z.infer<typeof candidateSchema>;

// Only invalidation identities and retry receipts live here. Work and delivery
// facts remain in their existing tables. SQLite triggers cover direct side-table
// writes and roll back with the source transaction, including across processes.
export class WorkFeedbackCandidates {
  private schemaVersion = -1;
  private readonly sources = new Set<string>();
  private after = "";
  private recovering = true;

  constructor(private readonly db: Database.Database, private readonly userId: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_feedback_pending (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL UNIQUE REFERENCES works(work_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, projected INTEGER NOT NULL DEFAULT 0, images INTEGER NOT NULL DEFAULT 0,
      ready_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_work_feedback_ready ON work_feedback_pending(user_id,ready_at,sequence);
    CREATE INDEX IF NOT EXISTS idx_works_feedback_recovery ON works(user_id,work_id);`);
    this.syncSources();
  }

  private syncSources(): void {
    const version = this.db.pragma("schema_version", { simple: true });
    if (version === this.schemaVersion) return;
    const tables = new Set(z.array(z.object({ name: z.string() })).parse(
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).map(row => row.name));
    const direct = ["works", "work_execution_bindings", "work_deliverables", "work_blockers", "work_evidence", "work_participants",
      "work_conversations", "work_team_executions", "work_teams", "work_automatic_completion", "work_report_contexts", "bot_collaborations",
      "work_subitem_results", "work_continuation_plans"];
    const byBinding = ["work_generated_artifacts", "work_watch_reviews", "work_automatic_completion_deliveries", "work_native_inbox"];
    for (const table of [...direct, ...byBinding, "work_continuation_gaps", "bot_work_feedback"]) {
      if (!tables.has(table) || this.sources.has(table)) continue;
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const rows = action === "UPDATE" ? ["OLD", "NEW"] : [action === "DELETE" ? "OLD" : "NEW"];
        const statements = rows.map(row => {
          const id = table === "bot_work_feedback" ? `json_extract(${row}.metadata_json,'$.workId')`
            : table === "work_continuation_gaps" ? `(SELECT work_id FROM work_continuation_plans WHERE plan_id=${row}.plan_id)`
            : byBinding.includes(table) ? `(SELECT work_id FROM work_execution_bindings WHERE binding_id=${row}.binding_id)`
            : `${row}.work_id`;
          const images = table === "work_generated_artifacts" ? "1" : table === "bot_work_feedback"
            ? `CASE WHEN json_extract(${row}.metadata_json,'$.executionId') IS NOT NULL THEN 1 ELSE 0 END` : "0";
          return `INSERT INTO work_feedback_pending(work_id,user_id,images)
            SELECT work_id,user_id,${images} FROM works WHERE work_id=${id}
            ON CONFLICT(work_id) DO UPDATE SET sequence=excluded.sequence,projected=0,ready_at=0,
              images=MAX(work_feedback_pending.images,excluded.images);`;
        }).join("\n");
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS feedback_${table}_${action.toLowerCase()} AFTER ${action} ON ${table}
          BEGIN ${statements} END;`);
      }
      this.sources.add(table);
      // Some domains create their tables lazily. Reconcile writes made before
      // their triggers were installed using the same bounded recovery census.
      this.recover();
    }
    this.schemaVersion = Number(this.db.pragma("schema_version", { simple: true }));
  }

  recover(): void { this.after = ""; this.recovering = true; }

  enqueue(workId: string): void {
    this.db.prepare(`INSERT INTO work_feedback_pending(work_id,user_id)
      SELECT work_id,user_id FROM works WHERE work_id=? AND user_id=?
      ON CONFLICT(work_id) DO UPDATE SET sequence=excluded.sequence,projected=0,ready_at=0`).run(workId, this.userId);
  }

  batch(now: number, workId?: string): WorkFeedbackCandidate[] {
    this.syncSources();
    if (workId) this.enqueue(workId);
    else if (this.recovering) {
      const page = z.array(z.object({ work_id: z.string() })).parse(this.db.prepare(
        "SELECT work_id FROM works WHERE user_id=? AND work_id>? ORDER BY work_id LIMIT ?")
        .all(this.userId, this.after, WORK_FEEDBACK_BATCH_SIZE));
      this.db.transaction(() => {
        const insert = this.db.prepare(`INSERT OR IGNORE INTO work_feedback_pending(work_id,user_id) VALUES (?,?)`);
        for (const row of page) insert.run(row.work_id, this.userId);
      })();
      this.after = page.at(-1)?.work_id ?? this.after;
      this.recovering = page.length === WORK_FEEDBACK_BATCH_SIZE;
    }
    return z.array(candidateSchema).parse(workId
      ? this.db.prepare("SELECT work_id workId,sequence,projected,images FROM work_feedback_pending WHERE user_id=? AND work_id=?").all(this.userId, workId)
      : this.db.prepare(`SELECT work_id workId,sequence,projected,images FROM work_feedback_pending
          WHERE user_id=? AND ready_at<=? ORDER BY ready_at,sequence LIMIT ?`).all(this.userId, now, WORK_FEEDBACK_BATCH_SIZE));
  }

  projected(workId: string, prepareImages: boolean): WorkFeedbackCandidate | undefined {
    this.db.prepare("UPDATE work_feedback_pending SET projected=1 WHERE work_id=? AND user_id=?").run(workId, this.userId);
    const candidate = candidateSchema.optional().parse(this.db.prepare(
      "SELECT work_id workId,sequence,projected,images FROM work_feedback_pending WHERE work_id=? AND user_id=?").get(workId, this.userId));
    if (candidate && prepareImages && candidate.images) return candidate;
    if (candidate) this.acknowledge(candidate);
    return undefined;
  }

  current(workId: string): WorkFeedbackCandidate | undefined {
    return candidateSchema.optional().parse(this.db.prepare(
      "SELECT work_id workId,sequence,projected,images FROM work_feedback_pending WHERE work_id=? AND user_id=?").get(workId, this.userId));
  }

  acknowledge(candidate: WorkFeedbackCandidate): void {
    this.db.prepare("DELETE FROM work_feedback_pending WHERE work_id=? AND user_id=? AND sequence=? AND projected=1")
      .run(candidate.workId, this.userId, candidate.sequence);
  }

  defer(candidate: WorkFeedbackCandidate, until: number): void {
    this.db.prepare("UPDATE work_feedback_pending SET ready_at=? WHERE work_id=? AND user_id=? AND sequence=?")
      .run(until, candidate.workId, this.userId, candidate.sequence);
  }

  hasMore(now: number): boolean {
    return this.recovering || Boolean(this.db.prepare("SELECT 1 FROM work_feedback_pending WHERE user_id=? AND ready_at<=? LIMIT 1").get(this.userId, now));
  }
}
