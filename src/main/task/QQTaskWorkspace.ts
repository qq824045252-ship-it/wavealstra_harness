import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isGatewayConversation } from "../../shared/gateway-task";
import { MANIFEST_FILENAME, normalizePathForComparison, TaskExecutionWorkspace, TaskPathBoundaryError } from "./TaskExecutionWorkspace";

export const GATEWAY_TASK_FOLDER = "gateway";
export const QQ_CHANNEL = "qq-default";

export function isQQTask(task: { id: string; gatewaySidebarChannelId?: string } | undefined): boolean {
  return Boolean(task && isGatewayConversation(task.id) && task.gatewaySidebarChannelId === QQ_CHANNEL);
}

export function qqTaskWorkspace(workspace: TaskExecutionWorkspace, taskId: string): string {
  return join(workspace.getTaskExecutionWorkspacesRoot(), GATEWAY_TASK_FOLDER, "qq", workspace.getTaskDirectoryName(taskId));
}

export function sameWorkspacePath(a: string, b: string): boolean {
  return normalizePathForComparison(a) === normalizePathForComparison(b);
}

function inspectPath(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Strict even for dangling symlinks and Windows directory junctions. */
export function isPlainDirectory(path: string): boolean {
  const stat = inspectPath(path);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TaskPathBoundaryError("QQ 工作目录不是普通目录");
  return true;
}

export function validatePlainTaskManifest(path: string): void {
  const stat = inspectPath(join(path, MANIFEST_FILENAME));
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new TaskPathBoundaryError("QQ 工作目录的任务清单无效");
}

/** Validate every app-owned path component before creating an immediate child. */
export function prepareQQWorkspaceParent(workspace: TaskExecutionWorkspace, create: boolean): boolean {
  const root = workspace.getTaskExecutionWorkspacesRoot();
  for (const [index, part] of [root, join(root, GATEWAY_TASK_FOLDER), join(root, GATEWAY_TASK_FOLDER, "qq")].entries()) {
    if (!isPlainDirectory(part)) {
      if (!create) return false;
      mkdirSync(part, index === 0 ? { recursive: true } : {});
      if (!isPlainDirectory(part)) throw new TaskPathBoundaryError("QQ 执行目录父路径消失");
    }
  }
  return true;
}

export function ensureQQTaskWorkspace(workspace: TaskExecutionWorkspace, taskId: string): string {
  prepareQQWorkspaceParent(workspace, true);
  const cwd = qqTaskWorkspace(workspace, taskId);
  if (isPlainDirectory(cwd)) validatePlainTaskManifest(cwd);
  const qw = new TaskExecutionWorkspace(dirname(cwd));
  const result = qw.ensureTaskExecutionWorkspace(taskId);
  if (!isPlainDirectory(result)) throw new TaskPathBoundaryError("QQ 执行目录不存在");
  validatePlainTaskManifest(result);
  qw.readManifest(taskId);
  return result;
}
