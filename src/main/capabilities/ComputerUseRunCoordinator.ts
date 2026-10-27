import type { ComputerExecInput, ComputerExecOutput } from "../platform/computer-use/protocol";
import { computerUseOverlayService } from "./ComputerUseOverlayService";
import { prepareComputerUseInput, verificationFor, type ComputerUsePhase } from "./ComputerUsePolicy";
import type { ComputerUseRecoveryPlan } from "./ComputerUseRecoveryPolicy";
import { WindowsAutomationError, type WindowInfo } from "../platform/computer-use/protocol";

interface RunState {
  taskId: string;
  runId: string;
  step: number;
  startedAt: number;
  touchedAt: number;
  lastTarget?: WindowInfo;
  controller: AbortController;
}

function runId(taskId: string, startedAt: number): string {
  return `${taskId}:${startedAt.toString(36)}`;
}

export class ComputerUseRunCoordinator {
  private readonly runs = new Map<string, RunState>();
  private readonly scopeOwners = new WeakMap<AbortSignal, RunState>();

  scope(taskId: string, agentSignal?: AbortSignal): AbortSignal {
    const state = this.getRun(taskId);
    this.requireActive(state);
    const signal = agentSignal ? AbortSignal.any([agentSignal, state.controller.signal]) : state.controller.signal;
    this.scopeOwners.set(signal, state);
    return signal;
  }

  cancel(taskId: string): void {
    const state = this.runs.get(taskId);
    if (!state) return;
    state.controller.abort(new WindowsAutomationError("REQUEST_CANCELLED", "用户已停止本轮 Computer Use；请通过其他方式继续，不要再次操作桌面。"));
    computerUseOverlayService.settle(taskId, "failed", 500);
  }

  prepare(input: ComputerExecInput): ComputerExecInput {
    const prepared = prepareComputerUseInput(input);
    const taskId = prepared.taskId?.trim();
    if (!taskId) return prepared;
    const state = this.getRun(taskId);
    this.requireActive(state);
    state.step += 1;
    state.touchedAt = Date.now();
    // Computer Use is visibly active from the beginning of the tool call, even
    // before a concrete HWND is resolved. Targeted actions will move the stable
    // screen border to the target monitor once inspection completes.
    computerUseOverlayService.presentDesktop({ taskId, phase: "observing", action: prepared.action ?? "batch" });
    return prepared;
  }

  presentTarget(input: ComputerExecInput, target: WindowInfo, phase: ComputerUsePhase = "observing", cursor?: { x: number; y: number; clicking?: boolean }): void {
    const taskId = input.taskId?.trim();
    if (!taskId) return;
    const state = this.getRun(taskId);
    this.requireActive(state);
    state.lastTarget = target;
    state.touchedAt = Date.now();
    computerUseOverlayService.present({ taskId, target, phase, action: input.action ?? "batch", cursor });
  }

  presentDesktop(input: ComputerExecInput, phase: ComputerUsePhase = "acting", cursor?: { x?: number; y?: number; clicking?: boolean }): void {
    const taskId = input.taskId?.trim();
    if (!taskId) return;
    const state = this.getRun(taskId);
    this.requireActive(state);
    state.touchedAt = Date.now();
    computerUseOverlayService.presentDesktop({
      taskId,
      phase,
      action: input.action ?? "batch",
      xPhysical: cursor?.x,
      yPhysical: cursor?.y,
      clicking: cursor?.clicking,
    });
  }

  recovering(input: ComputerExecInput, plan: ComputerUseRecoveryPlan): void {
    const taskId = input.taskId?.trim();
    if (!taskId) return;
    const state = this.getRun(taskId);
    this.requireActive(state);
    if (state.lastTarget) {
      computerUseOverlayService.present({ taskId, target: state.lastTarget, phase: "recovering", action: `${input.action ?? "batch"}:${plan.reason}` });
    }
  }

  complete(input: ComputerExecInput, output: ComputerExecOutput, recovery?: ComputerUseRecoveryPlan): ComputerExecOutput {
    const taskId = input.taskId?.trim();
    if (!taskId) return output;
    const state = this.getRun(taskId);
    this.requireActive(state);
    state.touchedAt = Date.now();
    const target = output.observation?.targetAfter ?? output.window ?? state.lastTarget;
    if (target) {
      state.lastTarget = target;
      computerUseOverlayService.present({ taskId, target, phase: "verifying", action: input.action ?? "batch" });
    } else {
      computerUseOverlayService.presentDesktop({ taskId, phase: "verifying", action: input.action ?? "batch" });
    }
    // A verified action is not the end of Computer Use. Keep the screen-level
    // mode visible while the Agent reasons about the next step.
    computerUseOverlayService.waitForNextStep(taskId);
    return {
      ...output,
      computerUseRun: {
        runId: state.runId,
        taskId,
        step: state.step,
        action: input.action ?? "batch",
        phase: "verified",
        verification: verificationFor(input, output),
        recovery: recovery ? { reason: recovery.reason, guidance: recovery.guidance, retried: true } : undefined,
      },
    };
  }

  fail(input: ComputerExecInput, scopeSignal?: AbortSignal): void {
    const taskId = input.taskId?.trim();
    if (!taskId) return;
    const state = this.runs.get(taskId);
    // An ended call can fail after the same task has started another run.
    // Only its captured scope proves that it still owns the current overlay.
    if (!state || (scopeSignal && this.scopeOwners.get(scopeSignal) !== state)) return;
    state.touchedAt = Date.now();
    computerUseOverlayService.settle(taskId, "failed");
  }

  endTask(taskId: string, outcome: "completed" | "failed" = "completed"): void {
    const state = this.runs.get(taskId);
    if (!state) return;
    state.controller.abort(new WindowsAutomationError("REQUEST_CANCELLED", "Computer Use 所属执行已结束"));
    this.runs.delete(taskId);
    computerUseOverlayService.settle(taskId, outcome);
  }

  private getRun(taskId: string): RunState {
    const existing = this.runs.get(taskId);
    if (existing) return existing;
    const startedAt = Date.now();
    const state: RunState = { taskId, runId: runId(taskId, startedAt), step: 0, startedAt, touchedAt: startedAt, controller: new AbortController() };
    this.runs.set(taskId, state);
    return state;
  }

  private requireActive(state: RunState): void {
    if (state.controller.signal.aborted) throw state.controller.signal.reason;
  }
}

export const computerUseRunCoordinator = new ComputerUseRunCoordinator();
