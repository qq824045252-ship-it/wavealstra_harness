import type { AppDatabase } from "../db/AppDatabase";
import type { TaskExecutionWorkspace } from "./TaskExecutionWorkspace";

/** Existing user folders must be recovered explicitly; only unbound tasks create isolated folders. */
export function resolveTaskWorkspaceCwd(db: AppDatabase, workspace: TaskExecutionWorkspace, taskId: string): string {
  const task = db.getTask(taskId);
  const bound = db.resolveWorkspaceExecutionPath(task?.spaceId ?? null, { requireExisting: true });
  const cwd = bound ?? workspace.ensureTaskExecutionWorkspace(taskId);
  db.bindTaskExecutionWorkspaceCwd(taskId, cwd);
  return cwd;
}
