import type { WorkAdmissionDto, WorkBlockerDto, WorkExecutionStatus } from "./bot-work";

/** Uncertainty is evidence, not permission and not a whole-Work execution lock.
 * Keep the original operation/receipt and never turn this disposition into success
 * or an instruction to replay it. Tool permissions and native replay rules remain
 * independent of this user-selected continue policy. */
export const WORK_EFFECT_DISPOSITION = "continue_without_replay" as const;

export function isWorkEffectDiagnostic(blocker: Pick<WorkBlockerDto, "kind" | "unknownExternalEffectRef">): boolean {
  return blocker.kind === "external_effect" || !!blocker.unknownExternalEffectRef;
}

export function nonBlockingEffect(blocker: WorkBlockerDto): WorkBlockerDto {
  if (!isWorkEffectDiagnostic(blocker) || blocker.status !== "open") return blocker;
  return { ...blocker, status: "cleared", waitingForUserInput: false,
    clearedAt: blocker.clearedAt ?? blocker.createdAt,
    details: { ...blocker.details, effectDisposition: WORK_EFFECT_DISPOSITION } };
}

export function workAdmissionInFlight(admission: Pick<WorkAdmissionDto, "state">): boolean {
  return admission.state === "admitted";
}

export function workExecutionInFlight(status: WorkExecutionStatus): boolean {
  // Unknown execution liveness is different from an unknown EFFECT of a finished
  // tool. Do not launch a competing execution or claim a live process stopped.
  return status === "pending" || status === "submitted" || status === "running" || status === "unknown";
}
