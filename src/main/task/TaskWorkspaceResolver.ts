import type { AppDatabase } from "../db/AppDatabase";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isPlainDirectory, prepareQQWorkspaceParent, qqTaskWorkspace, sameWorkspacePath, validatePlainTaskManifest } from "./QQTaskWorkspace";
import { randomUUID } from "node:crypto";
import { TaskExecutionWorkspace, assertPathInsideTask } from "./TaskExecutionWorkspace";
import { TaskWorkspaceBrancher } from "./TaskWorkspaceBrancher";
import { isTaskWorktreeId } from "../../shared/task-worktree";
import { resolveTaskWorktreeCwd } from "./TaskGitWorktree";
import { gatewayChannelForSpace, gatewayChannelSpaceId, isGatewayConversation } from "../../shared/gateway-task";
import { gatewayChannelDirectory } from "../gateway/gateway-task-space";
import { DOTS_TASK_ID } from "../../shared/dots";
import { RuntimeAuditUnknownOperationError } from "../platform/runtime-audit";
import { WorkspacePathError } from "../workspace/WorkspacePathError";

export interface TaskWorkspaceAuthority {
  version: string;
  spaceId: string | null;
  cwd: string | null;
  archived: boolean;
  trashed: boolean;
  spaceChain: Array<{ id: string; parentId: string | null; path: string | null; archived: boolean }>;
  binding: { directory: string; cwd: string } | null;
  workspaceMove: { fromCwd: string; toCwd: string } | null;
}

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
  validateOwnedWorkspace(workspace, id, cwd);
}

function validateOwnedWorkspace(workspace: TaskExecutionWorkspace, id: string, cwd: string): void {
  if (!isPlainDirectory(workspace.getTaskExecutionWorkspacesRoot()) || !isPlainDirectory(cwd)) throw new Error("渠道任务工作目录缺失");
  validatePlainTaskManifest(cwd);
  workspace.readManifest(id);
}

export function ensureGatewayTaskCwd(db: AppDatabase, ordinary: TaskExecutionWorkspace, taskId: string): string {
  if (db.getTaskExecutionWorkspaceState(taskId)?.state === "trashed") throw new Error("请先恢复渠道任务");
  const workspace = gatewayTaskWorkspace(db, taskId);
  const previous = currentTaskWorkspace(db, ordinary, taskId);
  return prepareGatewayWorkspace(workspace, previous, taskId, false);
}

function prepareGatewayWorkspace(workspace: TaskExecutionWorkspace, previous: TaskExecutionWorkspace, taskId: string,
  requirePrevious: boolean): string {
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
    validateOwnedWorkspace(previous, taskId, old);
    const brancher = new TaskWorkspaceBrancher(workspace);
    const request = randomUUID();
    try {
      const { pendingDir } = brancher.copySnapshotToPending(old, taskId, request);
      return brancher.commitPending(taskId, request, pendingDir);
    } finally { brancher.cleanupPending(taskId, request); }
  }
  if (requirePrevious) throw new Error("渠道任务原工作目录已丢失，请先恢复目录");
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

function verifySpaceChain(authority: TaskWorkspaceAuthority): void {
  if (authority.archived || authority.trashed) throw new Error("任务已归档或在回收站中，请先恢复任务");
  const seen = new Set<string>();
  let cursor = authority.spaceId;
  for (const space of authority.spaceChain) {
    if (space.id !== cursor) throw new WorkspacePathError(cursor ?? space.id, undefined, "workspace-binding-missing");
    if (space.archived) throw new Error("工作空间已归档，请先恢复工作空间");
    seen.add(space.id);
    cursor = space.parentId;
  }
  if (cursor !== null) {
    throw new WorkspacePathError(cursor, undefined, seen.has(cursor) ? "workspace-binding-cycle" : "workspace-binding-missing");
  }
}

function readBoundDirectory(authority: TaskWorkspaceAuthority): string | undefined {
  for (const space of authority.spaceChain) {
    const raw = space.path?.trim();
    if (!raw) continue;
    if (!isAbsolute(raw)) throw new WorkspacePathError(space.id, raw, "workspace-path-invalid");
    const cwd = resolve(raw);
    try {
      if (!statSync(cwd).isDirectory()) throw new WorkspacePathError(space.id, cwd, "workspace-path-invalid");
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new WorkspacePathError(space.id, cwd, code === "ENOENT" ? "workspace-path-missing" : "workspace-path-invalid");
    }
    return cwd;
  }
}

async function coreGatewayWorkspace(db: AppDatabase, taskId: string, authority: TaskWorkspaceAuthority) {
  const channel = gatewayChannelForSpace(authority.spaceId ?? "");
  const task = await db.readTask(taskId, { includeExpertBinding: false });
  if (!channel || task?.gatewaySidebarChannelId !== channel || task.spaceId !== authority.spaceId) {
    throw new Error("渠道任务缺少可信的空间归属");
  }
  const root = gatewayChannelDirectory(db, channel, false);
  const configured = authority.spaceChain[0]?.path;
  if (!configured || !isAbsolute(configured) || !sameWorkspacePath(configured, root)) {
    throw new WorkspacePathError(gatewayChannelSpaceId(channel), configured ?? undefined, "workspace-path-invalid");
  }
  if (!isPlainDirectory(root)) throw new WorkspacePathError(gatewayChannelSpaceId(channel), root, "workspace-path-missing");
  return { channel, workspace: new TaskExecutionWorkspace(root) };
}

function coreGatewayOwner(ordinary: TaskExecutionWorkspace, gateway: Awaited<ReturnType<typeof coreGatewayWorkspace>>, taskId: string,
  cwd: string): TaskExecutionWorkspace {
  if (sameWorkspacePath(cwd, gateway.workspace.resolveTaskExecutionWorkspaceDir(taskId))) return gateway.workspace;
  if (sameWorkspacePath(cwd, ordinary.resolveTaskExecutionWorkspaceDir(taskId))) return ordinary;
  if (gateway.channel === "qq-default" && sameWorkspacePath(cwd, qqTaskWorkspace(ordinary, taskId))) {
    if (!prepareQQWorkspaceParent(ordinary, false)) throw new Error("渠道任务原工作目录已丢失，请先恢复目录");
    return new TaskExecutionWorkspace(dirname(cwd));
  }
  throw new Error("渠道任务的工作目录不属于该会话");
}

function verifyWorkspaceMove(authority: TaskWorkspaceAuthority, cwd: string): void {
  if (authority.workspaceMove && !sameWorkspacePath(authority.workspaceMove.toCwd, cwd)) {
    throw new Error("任务已有另一个工作目录变更，请核对当前工作空间");
  }
}

/** Same canonical and legacy Gateway directories as the fixture path, under a current Core scope. */
export async function validateGatewayTaskCwdAsync(db: AppDatabase, ordinary: TaskExecutionWorkspace, id: string,
  cwd: string, from?: string): Promise<void> {
  if (!db.coreIdentity) return validateGatewayTaskCwd(db, ordinary, id, cwd, from);
  const authority = await db.runtimeAuditReader?.readTaskWorkspaceAuthority(id);
  if (!authority) throw new Error("Core 未确认渠道任务工作目录");
  verifySpaceChain(authority);
  const gateway = await coreGatewayWorkspace(db, id, authority);
  if (from) coreGatewayOwner(ordinary, gateway, id, from);
  validateOwnedWorkspace(coreGatewayOwner(ordinary, gateway, id, cwd), id, cwd);
}

async function selectCoreWorkspace(db: AppDatabase, workspace: TaskExecutionWorkspace, taskId: string,
  authority: TaskWorkspaceAuthority, candidateOnly: boolean): Promise<string> {
  verifySpaceChain(authority);
  // An existing native binding remains authoritative until an idle workspace move commits.
  const pinned = !candidateOnly ? authority.binding?.cwd : undefined;
  if (isGatewayConversation(taskId)) {
    const gateway = await coreGatewayWorkspace(db, taskId, authority);
    if (pinned) {
      validateOwnedWorkspace(coreGatewayOwner(workspace, gateway, taskId, pinned), taskId, pinned);
      return pinned;
    }
    verifyWorkspaceMove(authority, gateway.workspace.resolveTaskExecutionWorkspaceDir(taskId));
    const priorCwd = authority.cwd ?? authority.binding?.cwd;
    const previous = priorCwd ? coreGatewayOwner(workspace, gateway, taskId, priorCwd) : gateway.workspace;
    return prepareGatewayWorkspace(gateway.workspace, previous, taskId, Boolean(priorCwd));
  }
  if (isTaskWorktreeId(taskId)) return resolveTaskWorktreeCwd(taskId);
  if (pinned) {
    if (!isAbsolute(pinned)) throw new Error("原会话工作目录必须是绝对路径");
    if (taskId === DOTS_TASK_ID && !isPlainDirectory(pinned)) throw new Error("Dots 原工作目录不可用");
    if (sameWorkspacePath(pinned, workspace.resolveTaskExecutionWorkspaceDir(taskId))) {
      if (!isPlainDirectory(workspace.getTaskExecutionWorkspacesRoot()) || !isPlainDirectory(pinned)) {
        throw new Error("任务原工作目录已丢失，请先恢复目录");
      }
      validatePlainTaskManifest(pinned);
      workspace.readManifest(taskId);
    }
    return pinned;
  }
  const bound = readBoundDirectory(authority);
  if (bound) return bound;

  const cwd = workspace.resolveTaskExecutionWorkspaceDir(taskId);
  verifyWorkspaceMove(authority, cwd);
  isPlainDirectory(workspace.getTaskExecutionWorkspacesRoot());
  if (isPlainDirectory(cwd)) {
    validatePlainTaskManifest(cwd);
    workspace.readManifest(taskId);
    return cwd;
  }
  if ([authority.cwd, authority.binding?.cwd].some(previous => previous && sameWorkspacePath(previous, cwd))) {
    throw new Error("任务原工作目录已丢失，请先恢复目录");
  }
  const prepared = workspace.ensureTaskExecutionWorkspace(taskId);
  if (!isPlainDirectory(prepared)) throw new Error("任务工作目录创建后不可用");
  validatePlainTaskManifest(prepared);
  return prepared;
}

function directoryIdentity(path: string) {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) throw new Error("任务工作目录不是文件夹");
  return JSON.stringify([realpathSync(path), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
}

function samePinnedWorkspace(previous: TaskWorkspaceAuthority, current: TaskWorkspaceAuthority, cwd: string): boolean {
  if (!previous.binding || !sameWorkspacePath(previous.binding.cwd, cwd) || previous.workspaceMove || current.workspaceMove) return false;
  const { version: _previousVersion, ...previousScope } = previous;
  const { version: _currentVersion, ...currentScope } = current;
  return JSON.stringify(previousScope) === JSON.stringify(currentScope);
}

/** Persist only the directory selected from the current authority, independent of renderer input. */
export async function resolveTaskWorkspaceCwdAsync(db: AppDatabase, workspace: TaskExecutionWorkspace, taskId: string,
  options: { candidateOnly?: boolean } = {}): Promise<string> {
  if (!db.coreIdentity) return resolveTaskWorkspaceCwd(db, workspace, taskId);
  const core = db.runtimeAuditReader;
  if (!core) throw new Error("任务工作目录需要 Rust Core");
  const authority = await core.readTaskWorkspaceAuthority(taskId);
  if (authority === undefined) throw new Error("Core 未确认任务工作目录");
  if (!authority) throw new Error("任务已删除");
  const candidateOnly = options.candidateOnly === true;
  const cwd = await selectCoreWorkspace(db, workspace, taskId, authority, candidateOnly);
  if (candidateOnly || !authority.binding || !sameWorkspacePath(authority.binding.cwd, cwd)) {
    verifyWorkspaceMove(authority, cwd);
  }
  const identity = directoryIdentity(cwd);
  let version = authority.version;
  if (!candidateOnly && authority.cwd !== cwd) {
    let reply: unknown;
    try {
      reply = await core.writeDurableTaskProjection({ kind: "bindWorkspaceCwd", taskId, expectedVersion: authority.version, cwd, at: Date.now() });
    } catch (error) {
      if (!(error instanceof RuntimeAuditUnknownOperationError)) throw error;
      const receipt = await core.queryOperation(error.requestId).catch(() => undefined);
      if (receipt?.state !== "committed" || !receipt.result) throw error;
      reply = receipt.result;
    }
    const binding = reply as { status?: string; version?: string; message?: string } | undefined;
    if (binding?.status !== "workspaceBound" || typeof binding.version !== "string") {
      throw new Error(binding?.message ?? "Core 未确认任务工作目录绑定");
    }
    version = binding.version;
  }
  const current = await core.readTaskWorkspaceAuthority(taskId);
  if (current && current.version === version && (candidateOnly || current.cwd === cwd) && directoryIdentity(cwd) === identity) return cwd;

  // Activity writes can advance the stamp while recovering an already bound task.
  // Re-evaluate once only when the candidate keeps that exact binding.
  if (candidateOnly && current && current.version !== version && samePinnedWorkspace(authority, current, cwd)) {
    const selected = await selectCoreWorkspace(db, workspace, taskId, current, true);
    const checked = await core.readTaskWorkspaceAuthority(taskId);
    if (checked?.version === current.version && sameWorkspacePath(selected, cwd) && directoryIdentity(selected) === identity) return selected;
  }
  throw new Error("任务或工作空间已变化，请核对后重新发送");
}
