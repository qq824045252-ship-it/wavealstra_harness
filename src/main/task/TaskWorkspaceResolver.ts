import type { AppDatabase } from "../db/AppDatabase";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { isPlainDirectory, prepareQQWorkspaceParent, qqTaskWorkspace, sameWorkspacePath, validatePlainTaskManifest } from "./QQTaskWorkspace";
import { randomUUID } from "node:crypto";
import { TaskExecutionWorkspace, assertPathInsideTask } from "./TaskExecutionWorkspace";
import { TaskWorkspaceBrancher } from "./TaskWorkspaceBrancher";
import { isTaskWorktreeId } from "../../shared/task-worktree";
import { resolveTaskWorktreeCwd } from "./TaskGitWorktree";
import { gatewayChannelSpaceId, isGatewayConversation } from "../../shared/gateway-task";
import { gatewayChannelDirectory } from "../gateway/gateway-task-space";

/** Workspace files and Durable's database are separate children of the same channel directory. */
export function gatewayTaskWorkspace(db: AppDatabase, taskId: string): TaskExecutionWorkspace {
  const task = db.getTask(taskId);
  const channel = task?.gatewaySidebarChannelId;
  if (!channel || task.spaceId !== gatewayChannelSpaceId(channel)) throw new Error("渠道任务缺少可信的空间归属");
  const root = gatewayChannelDirectory(db, channel, false);
  const workspace = new TaskExecutionWorkspace(root);
  const dir = workspace.resolveTaskExecutionWorkspaceDir(taskId);
  isPlainDirectory(dir); // Reject links, including dangling junctions.
  return workspace;
}

/** Resolve only directories issued by the host, including the former flat and nested QQ layouts. */
function ownedWorkspace(db: AppDatabase, ordinary: TaskExecutionWorkspace, id: string, cwd?: string): TaskExecutionWorkspace {
  if (cwd && sameWorkspacePath(cwd, ordinary.resolveTaskExecutionWorkspaceDir(id))) return ordinary;
  if (cwd && db.getTask(id)?.gatewaySidebarChannelId === "qq-default" && sameWorkspacePath(cwd, qqTaskWorkspace(ordinary, id))) {
    prepareQQWorkspaceParent(ordinary, false);
    return new TaskExecutionWorkspace(dirname(cwd));
  }
  const current = gatewayTaskWorkspace(db, id);
  if (cwd && !sameWorkspacePath(cwd, current.resolveTaskExecutionWorkspaceDir(id))) throw new Error("渠道任务的工作目录不属于该会话");
  return current;
}

export function currentTaskWorkspace(db: AppDatabase, ordinary: TaskExecutionWorkspace, id: string): TaskExecutionWorkspace {
  if (!isGatewayConversation(id) || !db.getTask(id)?.gatewaySidebarChannelId) return ordinary;
  return ownedWorkspace(db, ordinary, id, db.getTask(id)?.cwd);
}

export function validateGatewayTaskCwd(db: AppDatabase, ordinary: TaskExecutionWorkspace, id: string, cwd: string, from?: string): void {
  const workspace = ownedWorkspace(db, ordinary, id, cwd);
  if (from) ownedWorkspace(db, ordinary, id, from);
  if (!isPlainDirectory(workspace.getTaskExecutionWorkspacesRoot()) || !isPlainDirectory(cwd)) throw new Error("渠道任务工作目录缺失");
  validatePlainTaskManifest(cwd);
  workspace.readManifest(id);
}

export function ensureGatewayTaskCwd(db: AppDatabase, ordinary: TaskExecutionWorkspace, taskId: string): string {
  if (db.getTaskExecutionWorkspaceState(taskId)?.state === "trashed") throw new Error("请先恢复渠道任务");
  const workspace = gatewayTaskWorkspace(db, taskId);
  const previous = currentTaskWorkspace(db, ordinary, taskId);
  const old = previous.resolveTaskExecutionWorkspaceDir(taskId);
  const target = workspace.resolveTaskExecutionWorkspaceDir(taskId);
  if (isPlainDirectory(target)) {
    validatePlainTaskManifest(target);
    workspace.readManifest(taskId);
    return target;
  }
  if (!sameWorkspacePath(old, target) && existsSync(old)) {
    // Keep historical absolute file references valid when Durable switches to the channel directory.
    assertPathInsideTask(previous.getTaskExecutionWorkspacesRoot(), old);
    validateGatewayTaskCwd(db, ordinary, taskId, old);
    const brancher = new TaskWorkspaceBrancher(workspace);
    const request = randomUUID();
    try {
      const { pendingDir } = brancher.copySnapshotToPending(old, taskId, request);
      return brancher.commitPending(taskId, request, pendingDir);
    } finally { brancher.cleanupPending(taskId, request); }
  }
  return workspace.ensureTaskExecutionWorkspace(taskId);
}

/** Existing user folders must be recovered explicitly; only unbound tasks create isolated folders. */
export function resolveTaskWorkspaceCwd(db: AppDatabase, workspace: TaskExecutionWorkspace, taskId: string): string {
  const task = db.getTask(taskId);
  if (isTaskWorktreeId(taskId)) {
    const worktree = resolveTaskWorktreeCwd(taskId);
    if (task?.cwd !== worktree) db.bindTaskExecutionWorkspaceCwd(taskId, worktree);
    return worktree;
  }
  const cwd = isGatewayConversation(taskId) ? ensureGatewayTaskCwd(db, workspace, taskId)
    : db.resolveWorkspaceExecutionPath(task?.spaceId ?? null, { requireExisting: true }) ?? workspace.ensureTaskExecutionWorkspace(taskId);
  db.bindTaskExecutionWorkspaceCwd(taskId, cwd);
  return cwd;
}
