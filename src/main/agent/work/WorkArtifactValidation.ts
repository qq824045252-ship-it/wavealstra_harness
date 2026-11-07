import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";

const fingerprintSchema = z.object({ path: z.string(), digest: z.string(), entity: z.string() }).strict();
export type ArtifactFingerprint = z.infer<typeof fingerprintSchema>;
export interface ArtifactInspection { workId: string; inputSnapshotId: string; intentRevision: number; observed: ArtifactFingerprint[]; }
const rowSchema = z.object({ binding_id: z.string(), path: z.string(), fingerprint_json: z.string(),invalidated_at:z.number().nullable() });
export function ensureWorkArtifactTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_artifact_dependencies (
    binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id), path TEXT NOT NULL,
    work_id TEXT NOT NULL REFERENCES works(work_id), fingerprint_json TEXT NOT NULL CHECK(json_valid(fingerprint_json)),
    invalidated_at INTEGER, PRIMARY KEY(binding_id,path)
  );`);
}
function fingerprint(path: string): ArtifactFingerprint {
  try {
    const canonical = realpathSync.native(path); const stat = statSync(canonical, { bigint: true });
    if (!stat.isFile()) return { path, digest: "unverifiable:not-file", entity: canonical };
    return { path, digest: createHash("sha256").update(readFileSync(canonical)).digest("hex"), entity: `${canonical}:${stat.dev}:${stat.ino}` };
  } catch { return { path, digest: "missing-or-unreadable", entity: "unknown" }; }
}
/** Content inspection is outside business write transactions; facts are saved inside them. */
export class WorkArtifactValidation {
  constructor(private readonly db: Database.Database, private readonly works: WorkService) { ensureWorkArtifactTables(db); }
  register(binding: WorkExecutionBindingDto, refs: string[]): ArtifactFingerprint[] {
    if (!refs.length) return [];
    if (this.db.inTransaction) throw new Error("产物内容读取不得占用 SQLite 写事务");
    return [...new Set(refs)].map(ref => fingerprint(resolve(binding.workspaceBinding, ref)));
  }
  record(binding: WorkExecutionBindingDto, observed: ArtifactFingerprint[]): void {
    if (!this.db.inTransaction) throw new Error("产物依赖必须与接收事实同事务落盘");
    const changedBindings=new Set<string>();
    let added=false;
    const before=this.currentDependencies(binding.workId);
    for (const item of observed) {
      // A new execution may replace a path, but its predecessor's evidence stays historical.
      for(const prior of before.filter(row=>row.path===item.path && row.binding_id!==binding.bindingId && row.invalidated_at===null)) {
        const old=fingerprintSchema.parse(JSON.parse(prior.fingerprint_json));
        if(old.digest!==item.digest || old.entity!==item.entity) {
          changedBindings.add(prior.binding_id);
          this.db.prepare("UPDATE work_artifact_dependencies SET invalidated_at=? WHERE binding_id=? AND path=?").run(Date.now(),prior.binding_id,prior.path);
        }
      }
      const inserted=this.db.prepare(`INSERT OR IGNORE INTO work_artifact_dependencies(binding_id,path,work_id,fingerprint_json) VALUES (?,?,?,?)`)
        .run(binding.bindingId,item.path,binding.workId,JSON.stringify(item));
      added ||= inserted.changes>0 && !before.some(prior=>prior.path===item.path);
    }
    if(changedBindings.size) this.invalidate(binding.workId,changedBindings,Date.now());
    else if(added && this.works.getWork(binding.workId)?.criteria.some(criterion=>criterion.status==="satisfied"))
      this.invalidate(binding.workId,changedBindings,Date.now());
  }
  capture(workId: string): ArtifactInspection {
    if (this.db.inTransaction) throw new Error("验收前内容核对不得占用 SQLite 写事务");
    const work = this.works.getWork(workId);
    const paths = [...new Set(this.currentDependencies(workId).map(row => row.path))];
    return { workId, inputSnapshotId: work?.inputSnapshotId ?? "", intentRevision: work?.intentRevision ?? 0, observed: paths.map(fingerprint) };
  }
  snapshotId(inspection: ArtifactInspection): string {
    return `artifacts:${createHash("sha256").update(JSON.stringify(inspection.observed.map(item => [item.path,item.digest,item.entity]).sort())).digest("hex")}`;
  }
  currentSnapshotId(workId:string):string {
    const work=this.works.getWork(workId);
    const byPath=new Map<string,ArtifactFingerprint>();
    for(const row of this.currentDependencies(workId)) byPath.set(row.path,fingerprintSchema.parse(JSON.parse(row.fingerprint_json)));
    return this.snapshotId({workId,inputSnapshotId:work?.inputSnapshotId ?? "",intentRevision:work?.intentRevision ?? 0,observed:[...byPath.values()]});
  }
  private currentDependencies(workId:string) {
    const work=this.works.getWork(workId);
    if(!work) return [];
    return this.db.prepare(`SELECT dependency.* FROM work_artifact_dependencies dependency
      JOIN work_execution_bindings binding ON binding.binding_id=dependency.binding_id
      WHERE dependency.work_id=? AND binding.intent_revision=? AND binding.input_snapshot_id=?
      ORDER BY binding.admitted_at,dependency.rowid`).all(workId,work.intentRevision,work.inputSnapshotId).map(row=>rowSchema.parse(row));
  }
  validate(inspection: ArtifactInspection, now = Date.now(), bindingIds?: readonly string[]): boolean {
    if (!this.db.inTransaction) throw new Error("产物版本复核必须与验收控制同事务提交");
    const work = this.works.getWork(inspection.workId);
    if (!work || work.inputSnapshotId !== inspection.inputSnapshotId || work.intentRevision !== inspection.intentRevision) return false;
    const changedBindings = new Set<string>();
    const dependencies = this.currentDependencies(work.workId);
    const scope = bindingIds === undefined ? undefined : new Set(bindingIds);
    // A notification about a new verification gap can contain older invalidated
    // facts. Only its still-accepted evidence needs a fresh success proof. An
    // accepted artifact without a registered dependency is never proven by an
    // empty scope/ledger.
    if (scope) for (const bindingId of scope) {
      const binding = this.works.repo.getBinding(bindingId);
      if (!binding || binding.workId !== work.workId || binding.intentRevision !== work.intentRevision
        || binding.inputSnapshotId !== work.inputSnapshotId) return false;
      const accepted = this.works.repo.listDeliverables(work.workId).filter(item => item.executionId === bindingId
        && item.status === "accepted" && work.acceptedDeliverableIds.includes(item.deliverableId));
      for (const deliverable of accepted) for (const ref of deliverable.artifactRefs) {
        if (!dependencies.some(row => row.binding_id === bindingId && row.path === resolve(binding.workspaceBinding, ref))) return false;
      }
    }
    const latest=new Map<string,z.infer<typeof rowSchema>>();
    for(const row of dependencies) if (!scope || scope.has(row.binding_id)) latest.set(row.path,row);
    let invalid=false;
    for (const row of latest.values()) {
      if(row.invalidated_at!==null) {invalid=true;continue;}
      const binding = this.works.repo.getBinding(row.binding_id);
      if (!binding || binding.inputSnapshotId !== work.inputSnapshotId || binding.intentRevision !== work.intentRevision) continue;
      const expected = fingerprintSchema.parse(JSON.parse(row.fingerprint_json));
      const current = inspection.observed.find(item => item.path === row.path);
      if (!current || current.digest.startsWith("unverifiable:") || current.digest === "missing-or-unreadable" || current.digest !== expected.digest || current.entity !== expected.entity) {
        changedBindings.add(row.binding_id);
        invalid=true;
        this.db.prepare("UPDATE work_artifact_dependencies SET invalidated_at=COALESCE(invalidated_at,?) WHERE binding_id=? AND path=?").run(now,row.binding_id,row.path);
      }
    }
    if (changedBindings.size) this.invalidate(work.workId,changedBindings,now);
    return !invalid;
  }
  private invalidate(workId:string,changedBindings:Set<string>,now:number):void {
    const work=this.works.getWork(workId);
    if(!work) return;
    for(const row of this.currentDependencies(workId).filter(row=>changedBindings.has(row.binding_id) && row.invalidated_at!==null)) {
      const binding=this.works.repo.getBinding(row.binding_id);if(binding)this.works.partialResults.artifactGap(binding,row.path,work.criteria.map(criterion=>criterion.id),now);
    }
    for (const deliverable of this.works.repo.listDeliverables(work.workId).filter(item => changedBindings.has(item.executionId) && ["accepted","proposed"].includes(item.status)))
      this.works.repo.updateDeliverableReview(deliverable.deliverableId,{ status: "superseded", reviewedAt: now, reviewedByBotId: work.ownerBotId, rejectedReason: "产物内容或文件身份已改变，需要重新核验" });
    const affectedIds = new Set(this.works.repo.listDeliverables(work.workId).filter(item => changedBindings.has(item.executionId)).map(item => item.deliverableId));
    // Without an exact dependency map all conditions are conservatively reopened.
    this.works.repo.updateWork({ ...work, criteria: work.criteria.map(criterion => criterion.status === "waived" ? criterion : { ...criterion, status: "pending", verifiedIntentRevision: undefined, evidenceRefs: [] }),
      acceptedDeliverableIds: work.acceptedDeliverableIds.filter(id => !affectedIds.has(id)), stateVersion: work.stateVersion + 1, updatedAt: now });
  }
}
