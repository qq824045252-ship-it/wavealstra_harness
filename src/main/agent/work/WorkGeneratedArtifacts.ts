import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { generatedArtifactSchema, type GeneratedArtifact } from "../../../shared/bot-work-phase3";
import type { WorkService } from "./WorkService";

export function ensureWorkGeneratedArtifactTables(db: Database.Database): void {
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
    if (!this.db.inTransaction) throw new Error("产物登记必须与原生结果接收同事务落盘");
    let changed = false;
    for (const value of artifacts) {
      const artifact = generatedArtifactSchema.parse(value);
      // Storage identity includes the web resource version; payload.digest remains the entry bytes SHA.
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO work_generated_artifacts(binding_id,path,digest,payload_json)
        VALUES (?,?,?,?)`).run(binding.bindingId, artifact.path, artifact.previewManifestPath ? `${artifact.digest}:${artifact.previewManifestPath}` : artifact.digest, JSON.stringify(artifact));
      changed ||= inserted.changes > 0;
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
    return this.db.prepare(`SELECT a.binding_id,a.payload_json FROM work_generated_artifacts a
      JOIN work_execution_bindings b ON b.binding_id=a.binding_id
      WHERE b.work_id=? AND (? OR (b.intent_revision=? AND b.input_snapshot_id=?)) ORDER BY a.rowid`)
      .all(work.workId, includeHistory ? 1 : 0, work.intentRevision, work.inputSnapshotId).map(value => {
        const row = z.object({ binding_id: z.string(), payload_json: z.string() }).parse(value);
        return { ...generatedArtifactSchema.parse(JSON.parse(row.payload_json)), bindingId: row.binding_id };
      });
  }
}
