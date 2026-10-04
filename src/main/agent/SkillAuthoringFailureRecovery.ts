import { createHash } from "node:crypto";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";
import { SkillAuthoringPartialStateError } from "../skills/SkillAuthoringService";

export interface SkillAuthoringRecoveryBridge {
  resolveContext: () => ConversationExecutionContext | undefined;
  failures: ExecutionFailureRepository;
}

function targetForIntent(intent: string): string {
  const hash = createHash("sha256").update(intent.trim(), "utf8").digest("hex");
  return `skill-authoring:${hash}`;
}

export function recordSkillAuthoringFailureRecovery(
  bridge: SkillAuthoringRecoveryBridge | undefined,
  intent: string,
  error: unknown,
): boolean {
  if (!bridge || !(error instanceof SkillAuthoringPartialStateError)) return false;
  const ctx = bridge.resolveContext();
  if (!ctx) return false;
  const validation = error.stage === "validation";
  bridge.failures.recordIfAbsent({
    ...ctx,
    causeCode: validation ? "skill-authoring-validation-failed" : "skill-authoring-install-failed",
    phase: validation ? "verify" : "execute",
    recovery: "recoverable",
    sideEffects: "known",
    target: targetForIntent(intent),
    message: `${error.message} Authored package remains available for diagnosis/retry: ${error.packagePath}`,
    nextAction: validation
      ? `Inspect the generated package for Skill ${error.skillId}, correct the validation issue, then retry creation.`
      : `Inspect the generated package for Skill ${error.skillId} and the install destination, then retry without regenerating unrelated work.`,
  });
  return true;
}

export function settleSkillAuthoringRecovery(
  bridge: SkillAuthoringRecoveryBridge | undefined,
  intent: string,
  result: unknown,
): void {
  if (!bridge || !result || typeof result !== "object" || (result as { created?: unknown }).created !== true) return;
  const ctx = bridge.resolveContext();
  if (!ctx) return;
  bridge.failures.resolveMatching(ctx.taskId, {
    target: targetForIntent(intent),
    causeCodes: ["skill-authoring-validation-failed", "skill-authoring-install-failed", "application-restarted"],
  });
}

export function skillAuthoringRecoveryTarget(intent: string): string {
  return targetForIntent(intent);
}