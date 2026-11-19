import type { AppDatabase } from "../db/AppDatabase";
import type { TaskExecutionWorkspace } from "./TaskExecutionWorkspace";
import { isTaskWorktreeId } from "../../shared/task-worktree";
import { resolveTaskWorktreeCwd } from "./TaskGitWorktree";

/** Existing user folders must be recovered explicitly; only unbound tasks create isolated folders. */
export function resolveTaskWorkspaceCwd(db: AppDatabase, workspace: TaskExecutionWorkspace, taskId: string): string {
  const task = db.getTask(taskId);
  if (isTaskWorktreeId(taskId)) {
    const worktree = resolveTaskWorktreeCwd(taskId);
    if (task?.cwd !== worktree) db.bindTaskExecutionWorkspaceCwd(taskId, worktree);
    return worktree;
  }
  const bound = db.resolveWorkspaceExecutionPath(task?.spaceId ?? null, { requireExisting: true });
  const cwd = bound ?? workspace.ensureTaskExecutionWorkspace(taskId);
  db.bindTaskExecutionWorkspaceCwd(taskId, cwd);
  return cwd;
}
