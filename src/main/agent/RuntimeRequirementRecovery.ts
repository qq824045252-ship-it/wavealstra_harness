import type { ModePresetDto } from "../../shared/mode-profile";
import { resolveRuntimeRequirementList } from "../../shared/runtime-requirement";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";

export function runtimeRequirementRecoveryTarget(preset?: ModePresetDto | null): string | null {
  const ids = resolveRuntimeRequirementList(preset?.requiredRuntimes).map((item) => item.providerId).sort();
  return ids.length ? `runtime-requirements:${ids.join(",")}` : null;
}

export async function ensurePresetRuntimeReadyWithRecovery(input: {
  failures: ExecutionFailureRepository;
  taskId: string;
  assistantMessageId?: string;
  preset?: ModePresetDto | null;
  ensureReady: () => Promise<void>;
}): Promise<void> {
  const target = runtimeRequirementRecoveryTarget(input.preset);
  try {
    await input.ensureReady();
    if (target) input.failures.resolveMatching(input.taskId, { target, causeCodes: ["runtime-requirement-not-ready"] });
  } catch (error) {
    if (target) input.failures.record({
      taskId: input.taskId,
      assistantMessageId: input.assistantMessageId,
      causeCode: "runtime-requirement-not-ready",
      phase: "prepare",
      recovery: "recoverable",
      sideEffects: "none",
      target,
      message: error instanceof Error ? error.message : String(error),
      nextAction: "Repair or restart the required runtime, then retry after its readiness check succeeds. The task has not started.",
    });
    throw error;
  }
}