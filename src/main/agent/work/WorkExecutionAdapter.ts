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
  private readonly workFlights = new Map<string, Promise<void>>();
  private readonly dirtyWorks = new Set<string>();
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
    if (result.ok) this.wake();
    return result;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), 1_000);
    this.timer.unref?.();
    this.wake();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.workFlights.values()]);
  }

  wake(taskId?: string): void {
    if (taskId && this.isAuthority()) {
      const binding = this.service.repo.bindingForTask(taskId);
      if (binding) this.service.nativeResults.allowInspect(binding.bindingId);
    }
    void this.flush().catch(error => this.onError("scheduler", error));
  }

  wakeWork(workId: string): void {
    if (this.isAuthority()) for (const binding of this.service.repo.listBindings(workId)) this.service.nativeResults.allowInspect(binding.bindingId);
    this.wake();
  }

  flush(): Promise<void> {
    if (!this.isAuthority()) return Promise.resolve();
    for (const failure of this.service.nativeResults.consume()) this.onError(failure.bindingId, failure.error);
    // A native read or cancellation may wait for an unresponsive tool. Serialize
    // revisions within each Work, not all Work in the application. A later wake
    // can still collect an unrelated result without replaying the blocked input.
    for (const work of this.service.listWorks(this.userId, { includeClosed: true })) {
      const workId = work.workId;
      this.dirtyWorks.add(workId);
      if (this.workFlights.has(workId)) continue;
      const flight = Promise.resolve().then(async () => {
        do {
          this.dirtyWorks.delete(workId);
          await this.deliverWork(workId);
        } while (this.dirtyWorks.has(workId) && this.isAuthority());
      }).finally(() => {
        this.dirtyWorks.delete(workId);
        if (this.workFlights.get(workId) === flight) this.workFlights.delete(workId);
      });
      this.workFlights.set(workId, flight);
    }
    return Promise.all([...this.workFlights.values()]).then(() => undefined);
  }

  private async deliverWork(workId: string): Promise<void> {
    if (!this.isAuthority() || !this.service.getWork(workId)) return;
    for (const binding of this.service.repo.listBindings(workId)) {
      const terminal = ["completed", "failed", "stopped", "invalidated"].includes(binding.status);
      if (terminal && this.service.partialResults.recovery.evidenceRead(binding.bindingId)) continue;
      if (!this.service.nativeResults.shouldInspect(binding.bindingId)) continue;
      if (!this.isAuthority()) return;
      try { await this.deliverBinding(binding); }
      catch (error) { this.service.nativeResults.readFailed(binding, error); this.onError(binding.bindingId, error); }
    }
    // Retired uncertainty must not strand an already requested cancellation
    // merely because its terminal native receipt was consumed before upgrade.
    if (this.isAuthority()) this.service.settlePendingClosure(workId);
  }

  private async deliverBinding(binding: WorkExecutionBindingDto): Promise<void> {
    // Recovery is deliberately before the new-business filter (BW-A15).
    let receipt = await this.native.find(binding);
    let work = this.service.getWork(binding.workId);
    if (!work || !this.isAuthority()) return;
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
    if (!this.isAuthority()) return;
    this.service.recordSubmissionReceipt(current.bindingId, JSON.stringify(receipt));
    let observation = await this.native.inspect(current, receipt);
    if (!this.isAuthority()) return;
    // A lost receipt may belong to an already completed input in an older native
    // conversation. Reconcile that result without aborting a newer active one.
    if (observation.status === "running") {
      work = this.service.getWork(current.workId);
      const latestBinding = this.service.repo.getBinding(current.bindingId);
      if (!work || !latestBinding) return;
      if (watchTimeExpired(work, Date.now()) || work.lifecycle !== "active" || latestBinding.invalidatedAt || !this.service.scheduledBindingCurrent(latestBinding)) {
        await this.native.stop(current);
        if (!this.isAuthority()) return;
        observation = await this.native.inspect(current, receipt);
      }
    }
    if (!this.isAuthority()) return;
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
