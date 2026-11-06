import type { AgentSubmissionReceipt } from "../../../shared/agent-ipc";
import type { DispatchExecutionParams, WorkActor, WorkControlResult, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { WorkService } from "./WorkService";

export interface WorkExecutionNamespace {
  taskId: string;
  durableStoreKey: string;
  conversationId: string;
  workspaceBinding: string;
}

export type WorkExecutionObservation =
  | { status: "running" }
  | { status: "completed" | "failed" | "stopped"; summary: string; hasWriteConflicts: boolean; artifactRefs: string[] };

/** The port delegates execution and recovery to the existing native Durable store. */
export interface WorkExecutionPort {
  prepare(taskId: string): Promise<WorkExecutionNamespace>;
  find(binding: WorkExecutionBindingDto): Promise<AgentSubmissionReceipt | undefined>;
  submit(binding: WorkExecutionBindingDto, text: string): Promise<AgentSubmissionReceipt>;
  inspect(binding: WorkExecutionBindingDto, receipt: AgentSubmissionReceipt): Promise<WorkExecutionObservation>;
  stop(binding: WorkExecutionBindingDto): Promise<void>;
}

/** Delivers persisted instructions, never retries the underlying business execution. */
export class WorkExecutionAdapter {
  private flushing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly service: WorkService,
    private readonly native: WorkExecutionPort,
    private readonly userId: string,
    private readonly isAuthority: () => boolean,
    private readonly onError: (bindingId: string, error: unknown) => void,
  ) {}

  async dispatch(actor: WorkActor, input: Omit<DispatchExecutionParams, keyof WorkExecutionNamespace> & { taskId: string }): Promise<WorkControlResult> {
    const namespace = await this.native.prepare(input.taskId);
    const result = this.service.dispatchExecution(actor, { ...input, ...namespace });
    if (result.ok) void this.flush();
    return result;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, 1_000);
    this.timer.unref?.();
    void this.flush();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flushing;
  }

  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.deliver().finally(() => { this.flushing = undefined; });
    }
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    if (!this.isAuthority()) return;
    for (const work of this.service.listWorks(this.userId, { includeClosed: true })) {
      for (const binding of this.service.repo.listBindings(work.workId)) {
        if (["completed", "failed", "stopped", "invalidated"].includes(binding.status)) continue;
        if (!this.isAuthority()) return;
        try { await this.deliverBinding(binding); }
        catch (error) { this.onError(binding.bindingId, error); }
      }
    }
  }

  private async deliverBinding(binding: WorkExecutionBindingDto): Promise<void> {
    // Recovery is deliberately before the new-business filter (BW-A15).
    let receipt = await this.native.find(binding);
    let work = this.service.getWork(binding.workId);
    if (!work || !this.isAuthority()) return;
    const current = this.service.repo.getBinding(binding.bindingId);
    if (!current) return;
    const canStart = work.lifecycle === "active" && !current.invalidatedAt
      && current.intentRevision === work.intentRevision && current.inputSnapshotId === work.inputSnapshotId;
    if (!receipt) {
      if (!canStart) {
        if (work.lifecycle === "paused" && !current.invalidatedAt && !current.attemptId) return;
        this.requireSuccess(this.service.reconcileExecution({ kind: "system", reason: "native-submission-absent" }, {
          bindingId: current.bindingId, outcome: "stopped", note: "原生存储确认没有该逻辑提交，未启动新的业务执行",
        }));
        return;
      }
      this.service.markDispatchAttempt(current.bindingId, current.attemptId ?? `attempt:${current.bindingId}`);
      receipt = await this.native.submit(current, this.service.repo.executionInput(current));
    }
    if (!this.isAuthority()) return;
    this.service.recordSubmissionReceipt(current.bindingId, JSON.stringify(receipt));
    work = this.service.getWork(current.workId);
    if (!work) return;
    const latestBinding = this.service.repo.getBinding(current.bindingId);
    if (work.lifecycle !== "active" || latestBinding?.invalidatedAt) await this.native.stop(current);
    const observation = await this.native.inspect(current, receipt);
    if (!this.isAuthority() || observation.status === "running") return;
    // Result, settlement and their receipts commit together. Re-reading the same
    // native result after a crash cannot create another deliverable (BW-A16).
    this.service.transaction(() => {
      if (observation.status === "completed" || observation.status === "failed") {
        this.requireSuccess(this.service.submitDeliverable({ kind: "worker", botId: current.botId, bindingId: current.bindingId }, {
          operationId: `result:${current.bindingId}`, workId: current.workId, bindingId: current.bindingId,
          deliverableId: `result:${current.bindingId}`, summary: observation.summary || "原生执行已结束，成果仍待负责人核验",
          artifactRefs: observation.artifactRefs, hasWriteConflicts: observation.hasWriteConflicts,
          uncoveredScope: observation.status === "failed" ? ["本次执行失败，必要目标仍待核验"] : [],
        }));
      }
      this.requireSuccess(this.service.reconcileExecution({ kind: "system", reason: "native-submission-result" }, {
        bindingId: current.bindingId, outcome: observation.status, note: observation.summary,
      }));
    });
    this.service.emitCurrentProjection(current.workId);
  }

  private requireSuccess(result: WorkControlResult): void {
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  }
}
