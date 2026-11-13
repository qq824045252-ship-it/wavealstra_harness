import type { WorkProjectionDto } from "./bot-work";

/** Archive is presentation/lifecycle management, never evidence of task success. */
export function isWorkArchived(work: WorkProjectionDto): boolean {
  // Only an explicit user archive operation changes list placement. Outcome is separate.
  return work.archive?.archivedAt !== undefined;
}
export function hasWorkExecutionInFlight(work: WorkProjectionDto): boolean {
  return work.executions.some(item => ["pending", "submitted", "running", "unknown"].includes(item.status))
    || Boolean(work.phase3?.settlingActions) || Boolean(work.runtimeObservations?.some(item => ["running", "recovering", "waiting"].includes(item.state)));
}
export function canArchiveWork(work: WorkProjectionDto): boolean {
  if (isWorkArchived(work) || work.archive?.deletedAt) return false;
  if (hasWorkExecutionInFlight(work)) return false;
  if (work.lifecycle === "closed") return true;
  if (work.lifecycle === "closing" || work.mode === "watch") return false;
  const current = work.executions.filter(item => !item.invalidatedAt && item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId);
  return current.length > 0 && current.some(item => item.status === "failed" || item.status === "stopped")
    && current.every(item => ["completed", "failed", "stopped", "invalidated"].includes(item.status));
}
