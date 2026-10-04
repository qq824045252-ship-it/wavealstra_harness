import type { Space, Task } from "@/types";

export const COPY = {
  independentTask: "独立任务",
  workspace: "工作空间",
  saveToWorkspace: "保存到工作空间",
  changeWorkspace: "更改工作空间",
  removeFromWorkspace: "移出工作空间",
  currentWorkspace: "当前工作空间",
  inheritedFromParent: "继承自上级",
  isolated: "隔离",
} as const;

/** 统一 Workspace 路径 formatter - 单一真相 */
export function getWorkspaceBreadcrumb(spaces: Space[], targetId: string | null): Array<Space> {
  if (!targetId) return [];
  const byId = new Map(spaces.map((s) => [s.id, s] as const));
  const chain: Space[] = [];
  const seen = new Set<string>();
  let cur: string | null = targetId;
  let steps = 0;
  while (cur && steps < 32) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const s = byId.get(cur);
    if (!s) break;
    chain.unshift(s);
    cur = (s.parentId ?? null) as string | null;
    steps += 1;
  }
  return chain;
}

export function getWorkspaceDisplayPath(spaces: Space[], targetId: string | null): string {
  if (!targetId) return COPY.independentTask;
  const chain = getWorkspaceBreadcrumb(spaces, targetId);
  if (chain.length === 0) return "工作空间不可用";
  return chain.map((s) => s.name).join(" › ");
}

/** 紧凑省略：保留首尾 + 当前，中间用 … */
export function getCompactBreadcrumb(spaces: Space[], targetId: string | null, maxVisible = 3): Array<Space | null> {
  const chain = getWorkspaceBreadcrumb(spaces, targetId);
  if (chain.length <= maxVisible) return chain;
  return [chain[0], null, ...chain.slice(-(maxVisible - 1))];
}

export function getTaskWorkspaceLabel(task: Pick<Task, "spaceId">, spaces: Space[]): string {
  if (!task.spaceId) return COPY.independentTask;
  return getWorkspaceDisplayPath(spaces, task.spaceId);
}

export function getTaskWorkspaceBreadcrumb(task: Pick<Task, "spaceId">, spaces: Space[]): Array<Space> {
  if (!task.spaceId) return [];
  return getWorkspaceBreadcrumb(spaces, task.spaceId);
}

export function formatWorkspacePickerPath(spaces: Space[], id: string): string {
  return getWorkspaceDisplayPath(spaces, id);
}
