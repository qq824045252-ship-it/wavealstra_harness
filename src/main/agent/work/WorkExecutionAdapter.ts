import type { WorkResourceRecovery } from "./WorkResourceRecovery";
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
  /** Set only by the host composition that installs its gate on every real leaf entry. */
  resourceBoundary?: "host-action-gate";
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
  private dirty = false;

  constructor(
    private readonly service: WorkService,
    private readonly native: WorkExecutionPort,
    private readonly userId: string,
    private readonly isAuthority: () => boolean,
    private readonly onError: (bindingId: string, error: unknown) => void,
    private readonly resourceRecovery?: Pick<WorkResourceRecovery, "recover" | "retryWork">,
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
    await this.flushing;
  }

  wake(taskId?: string): void {
    if (taskId && this.isAuthority()) {
      const binding = this.service.repo.bindingForTask(taskId);
      if (binding) this.service.nativeResults.allowInspect(binding.bindingId);
    }
    void this.flush().catch(error => this.onError("scheduler", error));
  }

  wakeWork(workId: string): void {
    if (this.isAuthority()) this.resourceRecovery?.retryWork(workId);
    if (this.isAuthority()) for (const binding of this.service.repo.listBindings(workId)) this.service.nativeResults.allowInspect(binding.bindingId);
    this.wake();
  }

  flush(): Promise<void> {
    this.dirty = true;
    if (!this.flushing) {
      this.flushing = (async () => {
        do { this.dirty = false; await this.deliver(); } while (this.dirty);
      })().finally(() => { this.flushing = undefined; });
    }
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    if (!this.isAuthority()) return;
    await this.resourceRecovery?.recover();
    if (!this.isAuthority()) return;
    for (const failure of this.service.nativeResults.consume()) this.onError(failure.bindingId, failure.error);
    for (const work of this.service.listWorks(this.userId, { includeClosed: true })) {
      for (const binding of this.service.repo.listBindings(work.workId)) {
        const pendingUsage = binding.reservationId && ["reserved", "unknown"].includes(this.service.repo.getReservation(binding.reservationId)?.state ?? "");
        if (["completed", "failed", "stopped", "invalidated"].includes(binding.status) && !pendingUsage) continue;
        if (!this.service.nativeResults.shouldInspect(binding.bindingId)) continue;
        if (!this.isAuthority()) return;
        try { await this.deliverBinding(binding); }
        catch (error) { this.service.nativeResults.readFailed(binding, error); this.onError(binding.bindingId, error); }
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
      && !["completed", "failed", "stopped", "invalidated"].includes(current.status)
      && current.intentRevision === work.intentRevision && current.inputSnapshotId === work.inputSnapshotId;
    if (!receipt) {
      if (["completed", "failed", "stopped", "invalidated"].includes(current.status)) throw new Error("终态预算补读缺少原始回执，保留未知额度且不重新执行");
      if (!canStart) {
        if (work.lifecycle === "paused" && !current.invalidatedAt && !current.attemptId) return;
        if (current.attemptId || current.submissionReceipt) throw new Error("已尝试的原始提交缺少可核对回执，结果与用量保留未知");
        this.requireSuccess(this.service.reconcileExecution({ kind: "system", reason: "native-submission-absent" }, {
          bindingId: current.bindingId, outcome: "stopped", note: "原生存储确认没有该逻辑提交，未启动新的业务执行",
          usageTokens: 0,
        }));
        return;
      }
      if (!this.resourceAvailable(current)) return;
      this.service.markDispatchAttempt(current.bindingId, current.attemptId ?? `attempt:${current.bindingId}`);
      receipt = await this.native.submit(current, this.service.partialResults.executionInput(current) ?? this.service.repo.executionInput(current));
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
      if (work.lifecycle !== "active" || latestBinding.invalidatedAt) {
        await this.native.stop(current);
        if (!this.isAuthority()) return;
        observation = await this.native.inspect(current, receipt);
      }
    }
    if (!this.isAuthority()) return;
    const failures = this.service.nativeResults.receive(current, receipt, observation);
    for (const failure of failures) this.onError(failure.bindingId, failure.error);
    if (!failures.length && (observation.status === "running" || observation.usageTokens !== undefined || !current.reservationId)) this.service.nativeResults.readRecovered(current);
    if (observation.status !== "running" && observation.usageTokens === undefined && current.reservationId) {
      this.service.nativeResults.readFailed(current, new Error("原生终态用量尚未完整返回"));
    }
    this.service.emitCurrentProjection(current.workId);
  }

  private requireSuccess(result: WorkControlResult): void {
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  }

  private resourceAvailable(candidate: WorkExecutionBindingDto): boolean {
    if (this.native.resourceBoundary === "host-action-gate") {
      // A verified native leaf boundary permits inference for independent roots.
      // Legacy/unclassified unknown effects without resource evidence remain coarse.
      for (const work of this.service.listWorks(this.userId, { includeClosed: true })) {
        if (this.service.repo.listOpenBlockers(work.workId).some(blocker => blocker.kind === "external_effect"
          && !blocker.unknownExternalEffectRef?.startsWith("native-read:"))) return false;
      }
      return !this.service.resourceGate.live().some(lease => lease.owner.bindingId === candidate.bindingId);
    }
    const readOnly = (binding: WorkExecutionBindingDto) => binding.delegatedScope.length > 0
      && binding.delegatedScope.every(scope => scope === "workspace:read");
    for (const work of this.service.listWorks(this.userId, { includeClosed: true })) {
      for (const binding of this.service.repo.listBindings(work.workId)) {
        const unknownEffect = this.service.repo.listOpenBlockers(work.workId).some(blocker => blocker.kind === "external_effect"
          && blocker.unknownExternalEffectRef !== `native-read:${binding.bindingId}`);
        if (binding.bindingId === candidate.bindingId || !binding.attemptId
          || ["completed", "failed", "stopped", "invalidated"].includes(binding.status) && !unknownEffect) continue;
        // Ports without the real host action boundary cannot prove independent writes.
        // Keep their conservative admission; ordinary recovery never bypasses it.
        if (!readOnly(candidate) || !readOnly(binding)) return false;
      }
    }
    return true;
  }
}
