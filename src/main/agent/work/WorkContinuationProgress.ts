import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function ensureWorkContinuationProgress(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_continuation_progress (
    binding_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, intent_revision INTEGER NOT NULL,
    input_snapshot_id TEXT NOT NULL, fingerprint TEXT NOT NULL, recorded_at INTEGER NOT NULL)`);
}

/** Durable progress of one requirement revision: verified artifact bytes plus
 * completed current-version subitems. Rewording the same report is not progress,
 * and an older revision's artifacts cannot make a new revision look advanced. */
export function continuationProgress(works: WorkService, work: WorkDto): string {
  const bindings = works.repo.listBindings(work.workId).filter(binding =>
    binding.intentRevision === work.intentRevision && binding.inputSnapshotId === work.inputSnapshotId
    && works.collaboration.isDelegationAdopted(binding, work));
  return digest([works.artifacts.progressSnapshotId(work.workId, bindings.map(binding => binding.bindingId)),
    [...new Set(works.partialResults.list(work.workId).filter(item => item.outcome === "completed" && !item.itemId.startsWith("recover:")
      && item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId
      && works.collaboration.isDelegationAdopted(works.repo.getBinding(item.bindingId)!, work))
      .map(item => JSON.stringify([item.task, [...item.artifactRefs].sort()])))].sort()]);
}

/** The progress basis recorded when this revision's previous continuation was
 * admitted. Missing history (an upgraded host) proves nothing either way. */
export function lastContinuationProgress(db: Database.Database, work: WorkDto): { bindingId: string; fingerprint: string } | undefined {
  ensureWorkContinuationProgress(db);
  const row = db.prepare(`SELECT binding_id,fingerprint FROM work_continuation_progress
    WHERE work_id=? AND intent_revision=? AND input_snapshot_id=? ORDER BY recorded_at DESC,rowid DESC LIMIT 1`)
    .get(work.workId, work.intentRevision, work.inputSnapshotId) as { binding_id: string; fingerprint: string } | undefined;
  return row && { bindingId: row.binding_id, fingerprint: row.fingerprint };
}

/** Written only after the host admits a continuation, never from a model reply. */
export function recordContinuationProgress(db: Database.Database, binding: WorkExecutionBindingDto,
  work: WorkDto, fingerprint: string, now: number): void {
  ensureWorkContinuationProgress(db);
  db.prepare(`INSERT INTO work_continuation_progress(binding_id,work_id,intent_revision,input_snapshot_id,fingerprint,recorded_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(binding_id) DO UPDATE SET fingerprint=excluded.fingerprint,recorded_at=excluded.recorded_at`)
    .run(binding.bindingId, work.workId, work.intentRevision, work.inputSnapshotId, fingerprint, now);
}