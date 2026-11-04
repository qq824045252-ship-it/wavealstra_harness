import { computeEffectiveArchived as computeEffectiveArchivedShared } from "../../../../../shared/workspace-tree";
import type { Space } from "../../../types";

/** 归一化路径：去掉尾部斜杠 */
export function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/** 生成一个与现有空间不撞名（忽略大小写）的名称：base → base 2 → base 3 ...；按 parentId 作用域计算（NOCASE）。 */
export function nextAvailableSpaceName(
  spaces: Array<{ name: string; parentId?: string | null }>,
  base: string,
  parentId: string | null = null,
): string {
  const names = new Set(
    spaces
      .filter((s) => (s.parentId ?? null) === (parentId ?? null))
      .map((s) => s.name.trim().toLowerCase()),
  );
  const trimmed = base.trim();
  if (!trimmed) return "工作空间";
  if (!names.has(trimmed.toLowerCase())) return trimmed;
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${trimmed} ${n}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${trimmed} ${Date.now()}`;
}

/** Phase 2：统一 effectiveArchived 计算，复用 shared/workspace-tree 单算法源（带环防御），UI 不各自写一套 */
export function recomputeEffectiveArchived(spaces: Space[]): Space[] {
  const m = computeEffectiveArchivedShared(
    spaces.map((s) => ({
      id: s.id,
      parentId: s.parentId ?? null,
      archived: Boolean(s.archived),
    })),
  );
  return spaces.map((s) => ({ ...s, effectiveArchived: m.get(s.id) ?? false }));
}
