import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppDatabase } from "../../db/AppDatabase";
import type { WorkActor, WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";
import type { WorkExecutionAdapter } from "./WorkExecutionAdapter";
import { DESKTOP_USER_GRANTS } from "./WorkService";

const rowSchema = z.object({ operation_id: z.string(), work_id: z.string(), task_id: z.string(), bot_id: z.string(),
  intent_revision: z.number(), input_snapshot_id: z.string() });
const sameInput = (binding: WorkExecutionBindingDto, work: WorkDto) => binding.intentRevision === work.intentRevision
  && binding.inputSnapshotId === work.inputSnapshotId;
// Invalidating a result never erases execution/effect history. Only an explicitly
// invalidated binding with no possible submission is safe to replace unchanged.
const retainsInput = (binding: WorkExecutionBindingDto, work: WorkDto) => sameInput(binding, work)
  && (binding.status !== "invalidated" || binding.attemptId !== undefined || binding.submissionReceipt !== undefined || binding.submittedAt !== undefined);

/** Business transaction persists the execution intent; native preparation can be resumed separately. */
export class WorkDispatchQueue {
  private flushing?: Promise<void>;
  private dirty = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly db: AppDatabase, private readonly works: WorkService,
    private readonly adapter: WorkExecutionAdapter, private readonly isAuthority: () => boolean,
    private readonly defaultModel: () => string | undefined) {}

  enqueue(work: WorkDto, operationId: string, retryBlocked = false): void {
    const current = this.works.getWork(work.workId);
    if (!current || current.lifecycle !== "active" || current.intentRevision !== work.intentRevision || current.inputSnapshotId !== work.inputSnapshotId) return;
    work = current;
    if (this.db.connection.prepare("SELECT 1 FROM work_dispatch_requests WHERE operation_id=?").get(operationId)) return;
    const bindings = this.works.repo.listBindings(work.workId);
    this.syncContinuationBlockers(work, bindings);
    if (retryBlocked) this.db.connection.prepare("UPDATE work_dispatch_requests SET state='pending',attempts=0 WHERE work_id=? AND intent_revision=? AND input_snapshot_id=? AND state='blocked'")
      .run(work.workId, work.intentRevision, work.inputSnapshotId);
    if (this.db.connection.prepare("SELECT 1 FROM work_dispatch_requests WHERE work_id=? AND intent_revision=? AND input_snapshot_id=? AND state IN ('pending','blocked')")
      .get(work.workId, work.intentRevision, work.inputSnapshotId)) return;
    // Resume changes control state, not input identity. Preserve completed results
    // and partial/failed executions too: a fresh root would repeat their effects.
    // Pending bindings resume through the adapter; only a new input/revision can
    // authorize a separately planned continuation.
    if (bindings.some(binding => retainsInput(binding, work))) return;
    const taskId = `work-execution-${randomUUID()}`;
    this.db.upsertTask({ id: taskId, title: work.title, updatedAt: Date.now(), cwd: work.workspacePath,
      projectId: work.projectId, modelId: this.defaultModel(), permissionMode: "default", modePresetId: "native" });
    this.db.connection.prepare(`INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at)
      VALUES (?,?,?,?,?,?,'pending',?)`).run(operationId, work.workId, taskId, work.ownerBotId, work.intentRevision, work.inputSnapshotId, Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref?.();
    this.wake();
  }
  wake(): void { void this.flush().catch(error => console.warn("[Work] 派发恢复待核对", error)); }
  async close(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.flushing; }
  flush(): Promise<void> {
    this.dirty = true;
    if (!this.flushing) this.flushing = (async () => {
      do { this.dirty = false; await this.deliver(); } while (this.dirty);
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    if (!this.isAuthority()) return;
    for (const request of this.db.connection.prepare("SELECT * FROM work_dispatch_requests WHERE state='pending' ORDER BY created_at,rowid").all().map(row => rowSchema.parse(row))) {
      if (!this.isAuthority()) return;
      const original = this.works.repo.getBindingByOperation(request.work_id, `dispatch:${request.operation_id}`);
      if (original) {
        if (original.taskId !== request.task_id || original.botId !== request.bot_id || original.intentRevision !== request.intent_revision || original.inputSnapshotId !== request.input_snapshot_id) throw new Error("原始派发命名空间不匹配");
        this.finishRequest(request.operation_id, request.work_id, "dispatched");
        continue;
      }
      const work = this.works.getWork(request.work_id);
      if (!work || work.lifecycle === "closed" || work.lifecycle === "closing" || work.intentRevision !== request.intent_revision || work.inputSnapshotId !== request.input_snapshot_id) {
        this.db.connection.prepare("UPDATE work_dispatch_requests SET state='cancelled' WHERE operation_id=?").run(request.operation_id);
        continue;
      }
      if (work.lifecycle !== "active") continue;
      // A pending request can outlive the caller/crash that created it. Apply the
      // same input dedupe on recovery, before preparing another native namespace.
      // The matching operation above keeps its original binding/receipt instead.
      if (this.works.repo.listBindings(work.workId).some(binding => retainsInput(binding, work))) {
        this.finishRequest(request.operation_id, request.work_id, "cancelled");
        continue;
      }
      try {
        const actor: WorkActor = { kind: "bot", userId: work.userId, botId: work.ownerBotId, host: "background", grants: DESKTOP_USER_GRANTS };
        const result = await this.adapter.dispatch(actor, { taskId: request.task_id, operationId: `dispatch:${request.operation_id}`,
          workId: work.workId, botId: request.bot_id, delegatedScope: work.authorization.allowedScopes,
          reserveTokens: Math.min(4096, Math.max(1, work.budget.maxTokens - work.budget.usedTokens - work.budget.reservedTokens)),
          versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch } });
        if (!result.ok) {
          if (["version_conflict", "epoch_mismatch", "invalid_lifecycle_transition"].includes(result.code)) continue;
          throw new Error(`${result.code}: ${result.message}`);
        }
        this.finishRequest(request.operation_id, request.work_id, "dispatched");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.works.transaction(() => {
          if (!this.isAuthority()) return;
          this.db.connection.prepare("UPDATE work_dispatch_requests SET attempts=attempts+1,error=?,state=CASE WHEN attempts>=2 THEN 'blocked' ELSE 'pending' END WHERE operation_id=?")
            .run(message, request.operation_id);
          const current = this.works.getWork(request.work_id);
          if (current && !this.works.repo.getBlocker(`dispatch:${request.operation_id}`)) {
            this.works.repo.insertBlocker({ blockerId: `dispatch:${request.operation_id}`, workId: current.workId,
              reason: `后台准备受阻，保留原派发身份；核验后暂停/恢复可再次尝试：${message}`,
              kind: "operational", waitingForUserInput: false, status: "open", createdAt: Date.now() });
            this.works.repo.updateWork({ ...current, stateVersion: current.stateVersion + 1, updatedAt: Date.now() });
          }
        });
        this.works.emitCurrentProjection(request.work_id);
        console.warn("[Work] 派发受阻", request.work_id, message);
      }
    }
    await this.adapter.flush();
    for (const row of this.db.connection.prepare(`SELECT DISTINCT request.work_id FROM work_dispatch_requests request
      JOIN works work ON work.work_id=request.work_id WHERE request.state='dispatched' AND work.lifecycle='active'`).all()) {
      const work = this.works.getWork(z.object({ work_id: z.string() }).parse(row).work_id);
      if (work) this.syncContinuationBlockers(work, this.works.repo.listBindings(work.workId));
    }
  }

  private syncContinuationBlockers(work: WorkDto, bindings: WorkExecutionBindingDto[]): void {
    const changed = this.works.transaction(() => {
      if (!this.isAuthority()) return false;
      let changed = false;
      const now = Date.now();
      for (const binding of bindings) {
        const blockerId = `continuation:${binding.bindingId}`;
        const blocker = this.works.repo.getBlocker(blockerId);
        const incomplete = retainsInput(binding, work)
          && (binding.invalidatedAt !== undefined || ["failed", "stopped", "invalidated"].includes(binding.status));
        if (!incomplete && blocker?.status === "open") {
          this.works.repo.clearBlocker(blockerId, work.workId, now); changed = true;
        } else if (incomplete && !blocker) {
          this.works.repo.insertBlocker({ blockerId, workId: work.workId, kind: "operational",
            reason: "原执行已失败、停止或失效，已有成果与执行事实仍保留。请核对未完成部分并修改要求后继续；恢复不会重新执行整个原始输入。",
            waitingForUserInput: true, status: "open", createdAt: now });
          changed = true;
        }
      }
      if (changed) {
        const latest = this.works.getWork(work.workId);
        if (latest) this.works.repo.updateWork({ ...latest, stateVersion: latest.stateVersion + 1, updatedAt: now });
      }
      return changed;
    });
    if (changed) this.works.emitCurrentProjection(work.workId);
  }

  private finishRequest(operationId: string, workId: string, state: "dispatched" | "cancelled"): void {
    this.works.transaction(() => {
      if (!this.isAuthority()) return;
      this.db.connection.prepare("UPDATE work_dispatch_requests SET state=?,error=NULL WHERE operation_id=?").run(state, operationId);
      const blocker = this.works.repo.getBlocker(`dispatch:${operationId}`);
      const work = this.works.getWork(workId);
      if (blocker?.status === "open" && work) {
        this.works.repo.clearBlocker(blocker.blockerId, workId, Date.now());
        this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: Date.now() });
      }
    });
    this.works.emitCurrentProjection(workId);
  }
}
