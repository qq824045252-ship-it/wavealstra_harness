import type Database from "better-sqlite3";
import type { WorkActor, WorkControlResult, WorkProjectionDto } from "../../../shared/bot-work";
import { canArchiveWork, hasWorkExecutionInFlight, isWorkArchived } from "../../../shared/bot-work-archive";
import type { WorkService } from "./WorkService";

export class WorkRecordArchive {
  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly now: () => number, private readonly isAuthority: () => boolean) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_record_archive (
      work_id TEXT PRIMARY KEY REFERENCES works(work_id), archived_at INTEGER NOT NULL, deleted_at INTEGER);`);
  }
  get(workId: string): WorkProjectionDto["archive"] {
    const row = this.db.prepare("SELECT archived_at,deleted_at FROM work_record_archive WHERE work_id=?").get(workId) as { archived_at: number; deleted_at: number | null } | undefined;
    return row ? { archivedAt: row.archived_at, ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}) } : undefined;
  }
  clearOnExplicitResume(workId: string): void {
    this.db.prepare("DELETE FROM work_record_archive WHERE work_id=?").run(workId);
  }
  control(actor: WorkActor, request: { workId: string; operationId: string; action: "archive" | "delete" | "restore" }): WorkControlResult {
    if (actor.kind !== "user") return { ok: false, code: "unauthorized_actor", message: "请从当前用户入口管理归档" };
    return this.works.transaction(() => {
      if (!this.isAuthority()) return { ok: false, code: "unauthorized_actor", message: "当前宿主不可修改归档" };
      let work = this.works.getWork(request.workId);
      if (!work || work.userId !== actor.userId) return { ok: false, code: "not_found", message: "找不到事项" };
      const projection = this.works.getProjection(work.workId)!;
      const archive = this.get(work.workId);
      const success = (replayed = false): WorkControlResult => ({ ok: true, replayed, operationId: request.operationId, work: this.works.getWork(work!.workId)! });
      if (request.action === "archive") {
        if (isWorkArchived(projection)) return success(true);
        if (!canArchiveWork(projection)) return { ok: false, code: "invalid_lifecycle_transition", message: "仅可归档已结束或执行失败且不再运行的事项；正在执行的任务不会被停止" };
        if (work.lifecycle === "active") {
          const paused = this.works.pauseWork(actor, { workId: work.workId, operationId: request.operationId + ":pause", reason: "用户归档失败事项，停止后续自动重试，保留已有记录和成果", versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch } });
          if (!paused.ok) return paused;
          work = paused.work;
        }
        this.db.prepare("INSERT INTO work_record_archive(work_id,archived_at) VALUES (?,?) ON CONFLICT(work_id) DO NOTHING").run(work.workId, this.now());
      } else if (request.action === "delete") {
        if (!isWorkArchived(projection)) return { ok: false, code: "invalid_lifecycle_transition", message: "请先归档，再删除此记录" };
        if (archive?.deletedAt) return success(true);
        if (hasWorkExecutionInFlight(projection))
          return { ok: false, code: "invalid_lifecycle_transition", message: "事项仍有执行正在处理，暂不能删除记录" };
        this.db.prepare("INSERT INTO work_record_archive(work_id,archived_at,deleted_at) VALUES (?,?,?) ON CONFLICT(work_id) DO UPDATE SET deleted_at=excluded.deleted_at").run(work.workId, this.now(), this.now());
      } else {
        if (!archive?.deletedAt) return success(true);
        this.db.prepare("UPDATE work_record_archive SET deleted_at=NULL WHERE work_id=?").run(work.workId);
      }
      const current = this.works.getWork(work.workId)!;
      this.works.repo.updateWork({ ...current, stateVersion: current.stateVersion + 1, updatedAt: this.now() });
      this.works.emitCurrentProjection(work.workId);
      return success();
    });
  }
}
