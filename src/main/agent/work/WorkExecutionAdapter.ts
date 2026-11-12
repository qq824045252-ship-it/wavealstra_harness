import { watchTimeExpired } from "../../../shared/work-watch-expiry";
import type { z } from "zod";
import type { workExecutionObservationSchema } from "../../../shared/bot-work-phase3";
import type { AgentSubmissionReceipt } from "../../../shared/agent-ipc";
import type { DispatchExecutionParams, WorkActor, WorkControlResult, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { WorkService } from "./WorkService";

export interface WorkExecutionNamespace {
  taskId: string;
  durableStoreKey: string;
  conversationId: string;
  workspaceBinding: string;
}

export type WorkExecutionObservation = z.infer<typeof workExecutionObservationSchema>;

/** The port delegates execution and recovery to the existing native Durable store. */
export interface WorkExecutionPort {
  prepare(taskId: string): Promise<WorkExecutionNamespace>;
  find(binding: WorkExecutionBindingDto): Promise<AgentSubmissionReceipt | undefined>;
  submit(binding: WorkExecutionBindingDto, text: string): Promise<AgentSubmissionReceipt>;
  inspect(binding: WorkExecutionBindingDto, receipt: AgentSubmissionReceipt): Promise<WorkExecutionObservation>;
  stop(binding: WorkExecutionBindingDto): Promise<void>;
  /** Optional disposable scan cursor, advanced only after durable inbox ingestion. */
  acknowledgeObservation?(binding: WorkExecutionBindingDto, receipt: AgentSubmissionReceipt, observation: WorkExecutionObservation): void;
}

/** Delivers persisted instructions, never retries the underlying business execution. */
export class WorkExecutionAdapter {
  private readonly bindingFlights = new Map<string, Promise<void>>();
  private readonly progressListeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly service: WorkService,
    private readonly native: WorkExecutionPort,
    private readonly userId: string,
    private readonly isAuthority: () => boolean,
    private readonly onError: (bindingId: string, error: unknown) => void,
  ) {}

  async dispatch(actor: WorkActor, input: Omit<DispatchExecutionParams, keyof WorkExecutionNamespace> & { taskId: string }, canDispatch: () => boolean = () => true): Promise<WorkControlResult> {
    if (!this.available() || !canDispatch()) return { ok: false, code: "invalid_lifecycle_transition", message: "执行适配器已停止或失去执行权" };
    const namespace = await this.native.prepare(input.taskId);
    if (!this.available() || !canDispatch()) return { ok: false, code: "invalid_lifecycle_transition", message: "执行适配器已停止或失去执行权" };
    if (namespace.taskId !== input.taskId) throw new Error("原生准备返回了另一任务的命名空间");
    const result = this.service.dispatchExecution(actor, { ...input, ...namespace });
    if (result.ok) this.wake();
    return result;
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.wake(), 1_000);
    this.timer.unref?.();
    this.wake();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.progressListeners.clear();
  }

  onProgress(listener: () => void): () => void {
    this.progressListeners.add(listener);
    return () => { this.progressListeners.delete(listener); };
  }

  private available(): boolean { return !this.closed && this.isAuthority(); }

  wake(taskId?: string): void {
    if (!this.available()) return;
    if (taskId) {
      const binding = this.service.repo.bindingForTask(taskId);
      if (binding) this.service.nativeResults.allowInspect(binding.bindingId);
    }
    try { this.deliver(); }
    catch (error) { this.onError("scheduler", error); }
  }

  wakeWork(workId: string): void {
    if (!this.available()) return;
    for (const binding of this.service.repo.listBindings(workId)) this.service.nativeResults.allowInspect(binding.bindingId);
    this.wake();
  }

  flush(): Promise<void> {
    if (!this.available()) return Promise.resolve();
    this.deliver();
    // An explicit caller may wait for this snapshot. Scheduling never waits on it.
    return Promise.all(this.bindingFlights.values()).then(() => {});
  }

  private deliver(): void {
    if (!this.available()) return;
    for (const failure of this.service.nativeResults.consume()) this.onError(failure.bindingId, failure.error);
    for (const work of this.service.listWorks(this.userId, { includeClosed: true })) {
      for (const binding of this.service.repo.listBindings(work.workId)) {
        if (this.bindingFlights.has(binding.bindingId)) continue;
        const terminal = ["completed", "failed", "stopped", "invalidated"].includes(binding.status);
        if (terminal && this.service.partialResults.recovery.evidenceRead(binding.bindingId)) continue;
        if (!this.service.nativeResults.shouldInspect(binding.bindingId)) continue;
        if (!this.available()) return;
        const version = this.service.getWork(work.workId)?.stateVersion;
        const flight = this.deliverBinding(binding).catch(error => {
          if (!this.available()) return;
          this.service.nativeResults.readFailed(binding, error); this.onError(binding.bindingId, error);
        }).finally(() => {
          this.bindingFlights.delete(binding.bindingId);
          if (this.available() && this.service.getWork(work.workId)?.stateVersion !== version)
            for (const listener of this.progressListeners) listener();
        });
        this.bindingFlights.set(binding.bindingId, flight);
        void flight.catch(error => { if (this.available()) this.onError("scheduler", error); });
      }
      // Retired uncertainty must not strand an already requested cancellation
      // merely because its terminal native receipt was consumed before upgrade.
      this.service.settlePendingClosure(work.workId);
    }
  }

  private async deliverBinding(binding: WorkExecutionBindingDto): Promise<void> {
    // Recovery is deliberately before the new-business filter (BW-A15).
    let receipt = await this.native.find(binding);
    if (!this.available()) return;
    let work = this.service.getWork(binding.workId);
    if (!work) return;
    const current = this.service.repo.getBinding(binding.bindingId);
    if (!current) return;
    const canStart = !watchTimeExpired(work, Date.now()) && work.lifecycle === "active" && !current.invalidatedAt
      && !["completed", "failed", "stopped", "invalidated"].includes(current.status)
      && this.service.scheduledBindingCurrent(current)
      && current.intentRevision === work.intentRevision && current.inputSnapshotId === work.inputSnapshotId;
    if (!receipt) {
      if (["completed", "failed", "stopped", "invalidated"].includes(current.status)) {
        if (!current.attemptId && !current.submissionReceipt && !current.submittedAt) {
          this.service.partialResults.recovery.markEvidenceRead(current.bindingId);
          return;
        }
        throw new Error("终态成果补读缺少原始回执，不重新执行原业务");
      }
      if (!canStart) {
        if (work.lifecycle === "paused" && !current.invalidatedAt && !current.attemptId && this.service.scheduledBindingCurrent(current)) return;
        if (current.attemptId || current.submissionReceipt || current.submittedAt) throw new Error("已尝试的原始提交缺少可核对回执，结果保留未知");
        this.requireSuccess(this.service.reconcileExecution({ kind: "system", reason: "native-submission-absent" }, {
          bindingId: current.bindingId, outcome: "stopped", note: "原生存储确认没有该逻辑提交，未启动新的业务执行",
          usageTokens: 0,
        }));
        return;
      }
      this.service.markDispatchAttempt(current.bindingId, current.attemptId ?? `attempt:${current.bindingId}`);
      const input = this.service.revisionHandoff.executionInput(current,
        this.service.partialResults.executionInput(current) ?? this.service.repo.executionInput(current));
      this.service.repo.captureReportContext(current, input);
      receipt = await this.native.submit(current, input + this.service.repo.attachmentInput(current));
    }
    if (!this.available()) return;
    if (receipt.taskId !== current.taskId || receipt.operationId !== current.operationId) throw new Error("原生回执不属于原执行身份");
    this.service.recordSubmissionReceipt(current.bindingId, JSON.stringify(receipt));
    let observation = await this.native.inspect(current, receipt);
    if (!this.available()) return;
    // A lost receipt may belong to an already completed input in an older native
    // conversation. Reconcile that result without aborting a newer active one.
    if (observation.status === "running") {
      work = this.service.getWork(current.workId);
      const latestBinding = this.service.repo.getBinding(current.bindingId);
      if (!work || !latestBinding) return;
      if (watchTimeExpired(work, Date.now()) || work.lifecycle !== "active" || latestBinding.invalidatedAt || !this.service.scheduledBindingCurrent(latestBinding)
        || latestBinding.intentRevision !== work.intentRevision || latestBinding.inputSnapshotId !== work.inputSnapshotId) {
        await this.native.stop(current);
        if (!this.available()) return;
        observation = await this.native.inspect(current, receipt);
      }
    }
    if (!this.available()) return;
    const failures = this.service.nativeResults.receive(current, receipt, observation);
    for (const failure of failures) this.onError(failure.bindingId, failure.error);
    if (!failures.length) {
      this.native.acknowledgeObservation?.(current, receipt, observation);
      this.service.nativeResults.readRecovered(current);
      if (observation.status !== "running") this.service.partialResults.recovery.markEvidenceRead(current.bindingId);
    }
    this.service.emitCurrentProjection(current.workId, { force: this.service.repo.consumeMetricsChange(current.bindingId) });
  }

  private requireSuccess(result: WorkControlResult): void {
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  }

}
