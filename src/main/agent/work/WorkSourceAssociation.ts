import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { enqueueWorkOp, overlayFindAll, overlaySet, requiresWorkRustWrites, workDomainInTx } from "./WorkDomainRuntime";
const keyPart = z.string().trim().min(1).max(500);
/** Stable provider identifiers, never model summaries or titles. Version is not
 * part of the source identity; it distinguishes repeated from new observations. */
export const workSourceIdentitySchema = z.object({ provider: keyPart, account: keyPart,
  objectId: keyPart, action: keyPart, version: keyPart, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict();
export type WorkSourceIdentity = z.infer<typeof workSourceIdentitySchema>;
type AssocRow = { user_id: string; source_key: string; source_version: string; work_id: string; previous_work_id: string | null; source_revision: number | null; observed_at: number };
export class WorkSourceAssociation {
  constructor(private readonly db: Database.Database) {
    if (!db.readonly) {
      db.exec(`CREATE TABLE IF NOT EXISTS work_source_associations (
      user_id TEXT NOT NULL, source_key TEXT NOT NULL, source_version TEXT NOT NULL,
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
      previous_work_id TEXT, source_revision INTEGER, observed_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,source_key,source_version));
      CREATE INDEX IF NOT EXISTS work_source_associations_latest ON work_source_associations(user_id,source_key,observed_at DESC)`);
      const columns = db.pragma("table_info(work_source_associations)") as Array<{name:string}>;
      if (!columns.some(column => column.name === "source_revision")) db.exec("ALTER TABLE work_source_associations ADD COLUMN source_revision INTEGER");
    }
  }
  key(source: WorkSourceIdentity): string {
    return createHash("sha256").update(JSON.stringify([source.provider, source.account, source.objectId, source.action])).digest("hex");
  }
  find(userId: string, source: WorkSourceIdentity): { workId: string; duplicate: boolean; versionVerified: boolean; previousWorkId?: string } | undefined {
    const key = this.key(source);
    const dbRows = this.db.prepare("SELECT user_id,source_key,source_version,work_id,previous_work_id,source_revision,observed_at FROM work_source_associations WHERE user_id=? AND source_key=? ORDER BY observed_at DESC,rowid DESC")
      .all(userId, key) as AssocRow[];
    const rows = overlayFindAll(this.db, "work_source_associations", dbRows,
      r => `${r.user_id}\0${r.source_key}\0${r.source_version}`,
      r => r.user_id === userId && r.source_key === key,
      (a, b) => b.observed_at - a.observed_at);
    const exact = rows.find(r => r.source_version === source.version);
    const row = exact ?? rows[0];
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
    if (!workDomainInTx(this.db)) throw new Error("来源事项关联必须与 Work 受理同事务保存");
    const sourceKey = this.key(source);
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_source_associations", `${userId}\0${sourceKey}\0${source.version}`, {
        user_id: userId, source_key: sourceKey, source_version: source.version,
        work_id: workId, previous_work_id: previousWorkId ?? null, source_revision: source.revision ?? null, observed_at: now,
      });
      enqueueWorkOp(this.db, {
        op: "workSourceAssociationInsert", userId, sourceKey, sourceVersion: source.version,
        workId, previousWorkId: previousWorkId ?? null, sourceRevision: source.revision ?? null, observedAt: now,
      });
      return;
    }
    this.db.prepare(`INSERT INTO work_source_associations(user_id,source_key,source_version,work_id,previous_work_id,source_revision,observed_at)
      VALUES (?,?,?,?,?,?,?)`).run(userId, sourceKey, source.version, workId, previousWorkId ?? null, source.revision ?? null, now);
  }
}
