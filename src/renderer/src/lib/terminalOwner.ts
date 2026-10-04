/**
 * 扩展栏终端的 UI owner 解析（纯函数，可单测）。
 *
 * 计划口径：Workspace Folder 是唯一 cwd Source of Truth。
 * - 有空间上下文（空间页 / 空间任务 / 草稿所选空间）→ 空间终端
 * - 空间未绑定或文件夹不可用 → unbound（禁止 spawn，禁止静默回退）
 * - 独立任务（无空间）→ 任务终端（保持原权威 cwd）
 * - 无任务且无空间 → none
 *
 * taskId 不参与 cwd 解析。
 */
export type TerminalUiOwner =
  | { kind: "none" }
  | { kind: "task"; taskId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "unbound"; workspaceId: string; reason: "missing-folder" | "folder-unavailable" };

export interface TerminalUiOwnerInput {
  activeTaskId?: string | null;
  /** 空间详情页当前空间 */
  activeWorkspaceId?: string | null;
  /** 当前任务所属空间 */
  taskSpaceId?: string | null;
  /** 首页草稿所选空间 */
  draftSpaceId?: string | null;
  space?: { id: string; path?: string; pathMissing?: boolean } | null;
}

/** 当前 Workspace 上下文 id：空间页 > 任务所属空间 > 草稿空间。taskId 不参与。 */
export function resolveWorkspaceContextId(input: TerminalUiOwnerInput): string | null {
  return (
    input.activeWorkspaceId?.trim() ||
    input.taskSpaceId?.trim() ||
    input.draftSpaceId?.trim() ||
    null
  );
}

export function resolveTerminalUiOwner(input: TerminalUiOwnerInput): TerminalUiOwner {
  const workspaceId = resolveWorkspaceContextId(input);
  if (workspaceId) {
    const space = input.space && input.space.id === workspaceId ? input.space : null;
    if (!space) return { kind: "unbound", workspaceId, reason: "missing-folder" };
    const folder = space.path?.trim() ?? "";
    if (!folder) return { kind: "unbound", workspaceId: space.id, reason: "missing-folder" };
    if (space.pathMissing) return { kind: "unbound", workspaceId: space.id, reason: "folder-unavailable" };
    return { kind: "workspace", workspaceId: space.id };
  }

  const taskId = input.activeTaskId?.trim();
  if (taskId) return { kind: "task", taskId };
  return { kind: "none" };
}

/** 可 spawn 的 IPC owner 字段；unbound/none 返回 null（禁止打开终端） */
export function terminalOwnerIdsOf(
  owner: TerminalUiOwner,
): { taskId: string } | { workspaceId: string } | null {
  if (owner.kind === "task") return { taskId: owner.taskId };
  if (owner.kind === "workspace") return { workspaceId: owner.workspaceId };
  return null;
}

/** effect / session 查找用的稳定键；同空间下切任务保持不变 */
export function terminalUiSpawnKey(owner: TerminalUiOwner): string | null {
  if (owner.kind === "task") return `task:${owner.taskId}`;
  if (owner.kind === "workspace") return `ws:${owner.workspaceId}`;
  return null;
}
