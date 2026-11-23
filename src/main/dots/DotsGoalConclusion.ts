import type Database from "better-sqlite3";
import { isDotsAutomaticInput, type DotsDelegation, type DotsReplyOrigin } from "../../shared/dots";

export interface DotsGoalAcceptance {
  taskId: string;
  operationId: string;
  sourceMessageId: string;
  destination: { sourceMessageId: string; origin?: DotsReplyOrigin };
  native: { conversationId: number; submissionId: number; entryId: number; toolConversationId: number; toolTaskId: number; callId: string };
  text: string;
  citations: import("../../shared/chat-reply-content").ReplyCitation[];
  artifacts: DotsDelegation["artifacts"];
  registrations: { entryId: number; digest: string }[];
}

export interface DotsGoalCompletion extends DotsGoalAcceptance {
  id: string;
  workId: string;
  intentRevision: number;
  stateVersion: number;
  ownerEpoch: number;
  inputSnapshotId: string;
  evidenceRefs: string[];
  observations: readonly import("../agent/work/WorkClosureMutations").GoalCompletionObservation[];
}

export function dotsOriginalDestination(db: Database.Database, sourceMessageId: string): DotsGoalAcceptance["destination"] {
  if (sourceMessageId.startsWith("cron-") && isDotsAutomaticInput(sourceMessageId)) {
    const runId = sourceMessageId.slice("cron-".length, -"-input".length);
    const timer = db.prepare(`SELECT o.source,o.conversation,o.entry FROM cron_runs r
      JOIN dots_schedule_origins o ON o.job_id=r.job_id WHERE r.id=?`).get(runId) as
      { source: string; conversation: number; entry: number } | undefined;
    if (timer) return { sourceMessageId: timer.source, origin: { conversationId: timer.conversation, entryId: timer.entry } };
  }
  const origin = db.prepare("SELECT conversation AS conversationId,entry AS entryId FROM dots_reply_origins WHERE source=?")
    .get(sourceMessageId) as DotsReplyOrigin | undefined;
  return { sourceMessageId, origin };
}

export function dotsGoalConclusion(db: Database.Database, taskId: string, operationId: string) {
  const id = `dots-goal-close:${operationId}`;
  const row = db.prepare(`SELECT COALESCE(w.closure_summary, '') AS text, d.source_message_id,
      w.work_id, w.intent_revision, w.owner_epoch, w.input_snapshot_id, w.closed_at,
      json_extract(r.result_snapshot_json, '$.stateVersion') AS receipt_state_version,
      json_extract(r.result_snapshot_json, '$._controlResult.dotsGoalCompletion') AS packet
    FROM dots_delegations d JOIN works w ON w.work_id=d.goal_id
    LEFT JOIN work_operation_receipts r ON r.work_id=w.work_id AND r.user_id=w.user_id AND r.operation_id=w.close_operation_id
      AND r.operation_type='closeWork'
    WHERE d.task_id=? AND d.operation_id=? AND w.close_operation_id=?
      AND w.lifecycle='closed' AND w.closure_conclusion='succeeded'`)
    .get(taskId, operationId, id) as {
      text: string; source_message_id: string; work_id: string; intent_revision: number;
      owner_epoch: number; input_snapshot_id: string; receipt_state_version: number | null; closed_at: number; packet: string | null;
    } | undefined;
  if (!row) return;
  const closure = { closure_conclusion: "succeeded" as const, closed_at: row.closed_at, input_snapshot_id: row.input_snapshot_id };
  if (!row.packet) return { text: row.text, completion: undefined, closure };
  const completion = JSON.parse(row.packet) as DotsGoalCompletion;
  if (completion.id !== id || completion.taskId !== taskId || completion.operationId !== operationId ||
    completion.sourceMessageId !== row.source_message_id || completion.workId !== row.work_id ||
    completion.intentRevision !== row.intent_revision || completion.ownerEpoch !== row.owner_epoch ||
    completion.inputSnapshotId !== row.input_snapshot_id || completion.stateVersion !== row.receipt_state_version) return;
  return { text: completion.text, completion, closure };
}
