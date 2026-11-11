import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
const keyPart = z.string().trim().min(1).max(500);
/** Stable provider identifiers, never model summaries or titles. Version is not
 * part of the source identity; it distinguishes repeated from new observations. */
export const workSourceIdentitySchema = z.object({ provider: keyPart, account: keyPart,
  objectId: keyPart, action: keyPart, version: keyPart, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict();
export type WorkSourceIdentity = z.infer<typeof workSourceIdentitySchema>;
export class WorkSourceAssociation {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_source_associations (
      user_id TEXT NOT NULL, source_key TEXT NOT NULL, source_version TEXT NOT NULL,
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
      previous_work_id TEXT, source_revision INTEGER, observed_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,source_key,source_version));
      CREATE INDEX IF NOT EXISTS work_source_associations_latest ON work_source_associations(user_id,source_key,observed_at DESC)`);
    const columns = db.pragma("table_info(work_source_associations)") as Array<{name:string}>;
    if (!columns.some(column => column.name === "source_revision")) db.exec("ALTER TABLE work_source_associations ADD COLUMN source_revision INTEGER");
  }
  key(source: WorkSourceIdentity): string {
    return createHash("sha256").update(JSON.stringify([source.provider, source.account, source.objectId, source.action])).digest("hex");
  }
  find(userId: string, source: WorkSourceIdentity): { workId: string; duplicate: boolean; versionVerified: boolean; previousWorkId?: string } | undefined {
    const key = this.key(source);
    type Row = { work_id: string; previous_work_id: string | null; source_revision: number | null };
    const exact = this.db.prepare("SELECT work_id,previous_work_id,source_revision FROM work_source_associations WHERE user_id=? AND source_key=? AND source_version=?")
      .get(userId, key, source.version) as Row | undefined;
    const row = exact ?? this.db.prepare("SELECT work_id,previous_work_id,source_revision FROM work_source_associations WHERE user_id=? AND source_key=? ORDER BY observed_at DESC,rowid DESC LIMIT 1")
      .get(userId, key) as Row | undefined;
    if (!row) return undefined;
    // Opaque tokens cannot be ordered by arrival time. Only source-provided
    // monotonic revisions distinguish a fresh observation from a delayed event.
    // This orders observations; it does not certify a model argument as host readback.
    const comparable = source.revision !== undefined && row.source_revision !== null;
    const older = comparable && source.revision! < row.source_revision!;
    return { workId: row.work_id, duplicate: !!exact || older,
      versionVerified: !!exact || (comparable && source.revision! > row.source_revision!),
      ...(row.previous_work_id ? { previousWorkId: row.previous_work_id } : {}) };
  }
  record(userId: string, source: WorkSourceIdentity, workId: string, now: number, previousWorkId?: string): void {
    if (!this.db.inTransaction) throw new Error("来源事项关联必须与 Work 受理同事务保存");
    this.db.prepare(`INSERT INTO work_source_associations(user_id,source_key,source_version,work_id,previous_work_id,source_revision,observed_at)
      VALUES (?,?,?,?,?,?,?)`).run(userId, this.key(source), source.version, workId, previousWorkId ?? null, source.revision ?? null, now);
  }
}
