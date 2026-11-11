import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkRepository } from "./WorkRepository";

type SubmissionRepository = Pick<WorkRepository, "updateBinding" | "listOutbox" | "markOutboxAttempt" | "markOutboxDelivered">;

/** Called in the facade transaction. Existing submission identities may settle in any lifecycle. */
export function markWorkDispatchAttempt(repo: SubmissionRepository, binding: WorkExecutionBindingDto, attemptId: string): void {
  repo.updateBinding({ ...binding, attemptId, status: binding.status === "pending" ? "submitted" : binding.status });
  const instruction = repo.listOutbox(binding.workId, ["pending", "attempted"])
    .find(item => item.bindingId === binding.bindingId && item.eventType === "work.execution.dispatch_requested");
  if (instruction) repo.markOutboxAttempt(instruction.eventId, attemptId);
}

export function recordWorkSubmissionReceipt(repo: SubmissionRepository, binding: WorkExecutionBindingDto, submissionReceipt: string, now: () => number): void {
  repo.updateBinding({
    ...binding, submissionReceipt, status: binding.status === "pending" ? "submitted" : binding.status,
    submittedAt: binding.submittedAt ?? now(),
  });
  const instruction = repo.listOutbox(binding.workId, ["pending", "attempted"])
    .find(item => item.bindingId === binding.bindingId && item.eventType === "work.execution.dispatch_requested");
  if (instruction) repo.markOutboxDelivered(instruction.eventId, now());
}
