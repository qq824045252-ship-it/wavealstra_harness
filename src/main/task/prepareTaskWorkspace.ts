import type { AppDatabase } from "../db/AppDatabase";
import type { TaskExecutionWorkspace } from "./TaskExecutionWorkspace";
import { resolveTaskWorkspaceCwd, resolveTaskWorkspaceCwdAsync } from "./TaskWorkspaceResolver";
import { WorkspacePathError } from "../workspace/WorkspacePathError";
import type { ExecutionFailureRepository } from "../agent/ExecutionFailureRepository";

export function prepareTaskWorkspace(db: AppDatabase, workspace: TaskExecutionWorkspace, failures: ExecutionFailureRepository, taskId: string, assistantMessageId?: string, resolveCwd: () => string = () => resolveTaskWorkspaceCwd(db, workspace, taskId)): string {
  try {
    const cwd = resolveCwd();
    failures.resolveWorkspaceFailures(taskId);
    return cwd;
  } catch (error) {
    recordWorkspaceFailure(failures, taskId, assistantMessageId, error);
    throw error;
  }
}

export async function prepareTaskWorkspaceAsync(db: AppDatabase, workspace: TaskExecutionWorkspace, failures: ExecutionFailureRepository,
  taskId: string, assistantMessageId?: string, resolveFixtureCwd?: () => string): Promise<string> {
  if (!db.coreIdentity) return prepareTaskWorkspace(db, workspace, failures, taskId, assistantMessageId, resolveFixtureCwd);
  try {
    const cwd = await resolveTaskWorkspaceCwdAsync(db, workspace, taskId);
    failures.resolveWorkspaceFailures(taskId);
    return cwd;
  } catch (error) {
    recordWorkspaceFailure(failures, taskId, assistantMessageId, error);
    throw error;
  }
}

function recordWorkspaceFailure(failures: ExecutionFailureRepository, taskId: string, assistantMessageId: string | undefined,
  error: unknown): void {
  if (error instanceof WorkspacePathError) failures.record({ taskId, assistantMessageId, causeCode: error.causeCode,
    phase: error.phase, recovery: error.recovery, sideEffects: error.sideEffects, message: error.message,
    nextAction: "恢复原目录或重新关联文件夹，然后重试本次请求。", spaceId: error.spaceId, target: error.path });
}
