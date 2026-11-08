import { z } from "zod";
import type { AppDatabase } from "../../db/AppDatabase";
import type { WorkService } from "./WorkService";

/** Only a host-persisted, versioned Work continuation may share the original
 * execution directory. Renderer Task.cwd and arbitrary task ancestry grant nothing.
 * A new Durable store/Task still owns the continuation's execution identity. */
export function resolveWorkContinuationCwd(db: AppDatabase, works: WorkService, taskId: string): string | undefined {
  const request = z.object({ work_id: z.string(), continuation_plan_id: z.string().nullable(),
    intent_revision: z.number(), input_snapshot_id: z.string(), state: z.string() }).optional()
    .parse(db.connection.prepare("SELECT work_id,continuation_plan_id,intent_revision,input_snapshot_id,state FROM work_dispatch_requests WHERE task_id=?").get(taskId));
  if (!request?.continuation_plan_id) return undefined;
  const work = works.getWork(request.work_id);
  const plan = works.partialResults.plans(request.work_id).find(item => item.planId === request.continuation_plan_id);
  const source = plan && works.repo.getBinding(plan.sourceBindingId);
  if (!work || !plan || !source || request.state === "cancelled" || plan.state === "cancelled"
    || source.workId !== work.workId || request.intent_revision !== work.intentRevision
    || request.input_snapshot_id !== work.inputSnapshotId || plan.intentRevision !== work.intentRevision
    || plan.inputSnapshotId !== work.inputSnapshotId || plan.ownerEpoch !== work.ownerEpoch || plan.ownerBotId !== work.ownerBotId
    || source.intentRevision !== plan.intentRevision || source.inputSnapshotId !== plan.inputSnapshotId
    || !db.getTask(source.taskId) || db.getTaskExecutionWorkspaceState(source.taskId)?.state === "trashed"
    || !source.workspaceBinding.trim()) throw new Error("补跑原执行目录或授权身份已失效，不能改用新目录重跑");
  return source.workspaceBinding;
}
