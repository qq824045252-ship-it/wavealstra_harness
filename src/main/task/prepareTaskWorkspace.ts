import type { AppDatabase } from "../db/AppDatabase";
import type { TaskExecutionWorkspace } from "./TaskExecutionWorkspace";
import { resolveTaskWorkspaceCwd } from "./TaskWorkspaceResolver";
import { WorkspacePathError } from "../workspace/WorkspacePathError";
import type { ExecutionFailureRepository } from "../agent/ExecutionFailureRepository";

export function prepareTaskWorkspace(db: AppDatabase, workspace: TaskExecutionWorkspace, failures: ExecutionFailureRepository, taskId: string, assistantMessageId?: string): string {
  try {
    const cwd = resolveTaskWorkspaceCwd(db, workspace, taskId);
    failures.resolveWorkspaceFailures(taskId);
    return cwd;
  } catch (error) {
    if (error instanceof WorkspacePathError) failures.record({ taskId, assistantMessageId, causeCode: error.causeCode,
      phase: error.phase, recovery: error.recovery, sideEffects: error.sideEffects, message: error.message,
      nextAction: "恢复原目录或重新关联文件夹，然后重试本次请求。", spaceId: error.spaceId, target: error.path });
    throw error;
  }
}
