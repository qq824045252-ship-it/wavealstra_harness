import type { ExecutionAttempt, ExecutionAttemptRepository } from "./ExecutionAttemptRepository";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";
import { BUILTIN_TOOL_NAMES } from "../security/McpSideEffectPolicy";

export function recoveryTargetForAttempt(attempt: ExecutionAttempt): string {
  if (attempt.providerId && attempt.shortToolName) return `mcp:${attempt.providerId}/${attempt.shortToolName}`;
  return attempt.target;
}

function recordInterruptedFailures(failures: ExecutionFailureRepository, interrupted: ExecutionAttempt[]): void {
  for (const attempt of interrupted) {
    // Retained historical Pi attempts are closed for audit only. Native Pi
    // execution does not revive the retired host recovery/verification flow.
    const durable = attempt.executionId.startsWith("durable:");
    if (!durable && (BUILTIN_TOOL_NAMES.has(attempt.toolName) || attempt.toolName === "terminal")) continue;
    failures.record({
      taskId: attempt.taskId,
      executionId: attempt.executionId,
      assistantMessageId: attempt.assistantMessageId,
      causeCode: durable ? "durable-tool-interrupted" : "application-restarted",
      phase: "recover",
      recovery: durable ? "requires-user-action" : "recoverable",
      sideEffects: "unknown",
      target: recoveryTargetForAttempt(attempt),
      message: `${attempt.toolName} was interrupted by an application restart. Partial side effects may exist.`,
      nextAction: "Inspect the affected file or external system before continuing; a verified success on the same target will clear this recovery item.",
    });
  }
}

/** Convert unfinished side-effect attempts left by a crashed/restarted app into explicit recovery records. */
export function recoverInterruptedExecutions(attempts: ExecutionAttemptRepository, failures: ExecutionFailureRepository): ExecutionAttempt[] {
  const interrupted = attempts.recoverInterrupted();
  recordInterruptedFailures(failures, interrupted);
  return interrupted;
}

export async function recoverInterruptedExecutionsAsync(attempts: ExecutionAttemptRepository, failures: ExecutionFailureRepository): Promise<ExecutionAttempt[]> {
  const interrupted = await attempts.recoverInterruptedAsync();
  recordInterruptedFailures(failures, interrupted);
  await failures.flush();
  return interrupted;
}
