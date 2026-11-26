import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { generatedArtifactSchema, type GeneratedArtifact } from "../../../shared/bot-work-phase3";
import { enqueueWorkOp, overlayFindAll, overlayMutate, requiresWorkRustWrites, workDomainInTx } from "./WorkDomainRuntime";
import type { WorkService } from "./WorkService";

export function ensureWorkGeneratedArtifactTables(db: Database.Database): void {
  if (db.readonly) return;
  db.exec(`CREATE TABLE IF NOT EXISTS work_generated_artifacts (
    binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id) ON DELETE CASCADE,
    path TEXT NOT NULL, digest TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    PRIMARY KEY(binding_id,path,digest)
  )`);
}
/** Host-registered files are visible before completion, not accepted deliverables. */
export class WorkGeneratedArtifacts {
  constructor(private readonly db: Database.Database, private readonly works: WorkService) { ensureWorkGeneratedArtifactTables(db); }
  record(binding: WorkExecutionBindingDto, artifacts: GeneratedArtifact[]): void {
    if (!workDomainInTx(this.db)) throw new Error("产物登记必须与原生结果接收同事务落盘");
    const rust = requiresWorkRustWrites(this.db);
    let changed = false;
    for (const value of artifacts) {
      const artifact = generatedArtifactSchema.parse(value);
      // Storage identity includes the web resource version; payload.digest remains the entry bytes SHA.
      const digest = artifact.previewManifestPath ? `${artifact.digest}:${artifact.previewManifestPath}` : artifact.digest;
      const payloadJson = JSON.stringify(artifact);
      if (rust) {
        let updated = false;
        overlayMutate(
          this.db,
          "work_generated_artifacts",
          `${binding.bindingId}\0${artifact.path}\0${digest}`,
          () => this.db.prepare("SELECT binding_id,path,digest,payload_json FROM work_generated_artifacts WHERE binding_id=? AND path=? AND digest=?")
            .get(binding.bindingId, artifact.path, digest) as Record<string, unknown> | undefined,
          cur => {
            if (!cur) {
              updated = true;
              return { binding_id: binding.bindingId, path: artifact.path, digest, payload_json: payloadJson };
            }
            const curEntry = (JSON.parse(String(cur.payload_json)) as { sourceEntryId?: number }).sourceEntryId ?? -Infinity;
            if (artifact.sourceEntryId > curEntry) {
              updated = true;
              return { binding_id: binding.bindingId, path: artifact.path, digest, payload_json: payloadJson };
            }
            return cur;
          },
        );
        enqueueWorkOp(this.db, { op: "workGeneratedArtifactUpsert", bindingId: binding.bindingId, path: artifact.path, digest, payloadJson });
        changed ||= updated;
      } else {
        const recorded = this.db.prepare(`INSERT INTO work_generated_artifacts(binding_id,path,digest,payload_json)
          VALUES (?,?,?,?) ON CONFLICT(binding_id,path,digest) DO UPDATE SET payload_json=excluded.payload_json
          WHERE json_extract(excluded.payload_json,'$.sourceEntryId') > json_extract(work_generated_artifacts.payload_json,'$.sourceEntryId')`)
          .run(binding.bindingId, artifact.path, digest, payloadJson);
        changed ||= recorded.changes > 0;
      }
    }
    if (changed) {
      const work = this.works.getWork(binding.workId);
      if (work) this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: Date.now() });
      this.works.emitCurrentProjection(binding.workId);
    }
  }
  list(workId: string, includeHistory = false): Array<GeneratedArtifact & { bindingId: string }> {
    const work = this.works.getWork(workId);
    if (!work) return [];
    return this.listForWork(work, includeHistory);
  }
  listForWork(work: WorkDto, includeHistory = false): Array<GeneratedArtifact & { bindingId: string }> {
    const bindings = new Set(
      this.works.repo.listBindings(work.workId)
        .filter(b => includeHistory || (b.intentRevision === work.intentRevision && b.inputSnapshotId === work.inputSnapshotId))
        .map(b => b.bindingId),
    );
    const dbRows = this.db.prepare(`SELECT a.binding_id,a.path,a.digest,a.payload_json FROM work_generated_artifacts a
      JOIN work_execution_bindings b ON b.binding_id=a.binding_id
      WHERE b.work_id=? AND (? OR (b.intent_revision=? AND b.input_snapshot_id=?)) ORDER BY a.rowid`)
      .all(work.workId, includeHistory ? 1 : 0, work.intentRevision, work.inputSnapshotId) as Array<{
        binding_id: string; path: string; digest: string; payload_json: string;
      }>;
    return overlayFindAll(
      this.db,
      "work_generated_artifacts",
      dbRows,
      r => `${r.binding_id}\0${r.path}\0${r.digest}`,
      r => bindings.has(r.binding_id),
    ).map(value => {
      const row = z.object({ binding_id: z.string(), payload_json: z.string() }).parse(value);
      return { ...generatedArtifactSchema.parse(JSON.parse(row.payload_json)), bindingId: row.binding_id };
    });
  }
}
