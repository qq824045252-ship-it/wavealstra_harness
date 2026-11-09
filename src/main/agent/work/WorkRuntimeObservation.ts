import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkRuntimeObservationDto } from "../../../shared/bot-work-phase3";
import type { WorkExecutionObservation } from "./WorkExecutionAdapter";

/** Process-local liveness facts. Never resurrect a previous host's persisted 'running'. */
export class WorkRuntimeObservation {
  private readonly observed = new Map<string, WorkRuntimeObservationDto>();
  constructor(private readonly bindings: (workId: string) => WorkExecutionBindingDto[]) {}
  record(binding: WorkExecutionBindingDto, observation: WorkExecutionObservation): boolean {
    if (observation.status !== "running") { return this.observed.delete(binding.bindingId); }
    return this.set({ bindingId: binding.bindingId,
      state: observation.runtimeState ?? "recovering",
      reason: observation.runtimeReason ?? "正在核对本次宿主的执行状态，历史运行记录不代表当前仍在执行",
      observedAt: Date.now() });
  }
  readFailed(binding: WorkExecutionBindingDto, error: unknown): boolean {
    return this.set({ bindingId: binding.bindingId, state: "interrupted",
      reason: `无法核对原执行状态：${error instanceof Error ? error.message : String(error)}。保留原始回执，不判定成功或重新提交`, observedAt: Date.now() });
  }
  private set(value: WorkRuntimeObservationDto): boolean {
    const previous = this.observed.get(value.bindingId);
    this.observed.set(value.bindingId, value);
    return previous?.state !== value.state || previous?.reason !== value.reason;
  }
  forWork(workId: string): WorkRuntimeObservationDto[] {
    return this.bindings(workId).filter(binding => ["pending", "submitted", "running", "unknown"].includes(binding.status)).map(binding =>
      this.observed.get(binding.bindingId) ?? { bindingId: binding.bindingId, state: "recovering",
        reason: "当前宿主尚未核对这项执行；正在恢复状态，历史记录不代表任务仍在运行" });
  }
}
