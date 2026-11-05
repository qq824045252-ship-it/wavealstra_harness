/**
 * Workspace Tree Selector — Phase 2 基础层（统一数据层，非视觉）
 *
 * 职责：
 * - 从 spaces + tasks（SpaceDto/TaskDto）构造稳定树/扁平混排视图
 * - 支持 space/task mixed order（同父下子空间与直接任务按同一显式排序键交错）
 * - 排序确定性：沿用 Phase 1 冻结的 spaces.sort_order / tasks.space_sort_order 语义（1000 步进，0=未显式，回退确定性 tie-break，与 DB getSpaceChildren 的 sort_order→created_at→id 对齐），不改 DB schema
 * - effectiveArchived 统一消费：自身 archived ∨ 任一祖先 archived（带环防御），不重新 fan-out task.archived，也不在 UI 各自写一套不同算法；shared compute 为唯一口径
 * - pin 语义冻结：isFavorited 仅作 presentation priority（compareMixed 置顶），不改写 sortOrder/spaceSortOrder 持久值；重启后状态/顺序稳定
 *
 * 纯函数，无副作用，可被 main/renderer/shared 共同引用（避免 any / 双重 DTO）。
 */

import type { SpaceDto, TaskDto } from "./agent-ipc";

// ---------------------------------------------------------------------------
// effectiveArchived — 与 AppDatabase.computeEffectiveArchived 同构，单算法源
// ---------------------------------------------------------------------------
export function computeEffectiveArchived(
  entries: Array<{ id: string; parentId: string | null; archived: boolean }>,
): Map<string, boolean> {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const result = new Map<string, boolean>();
  const resolve = (id: string, stack: Set<string>): boolean => {
    const cached = result.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return false; // 脏数据环防御
    const entry = byId.get(id);
    if (!entry) return false;
    stack.add(id);
    const effective = entry.archived || (entry.parentId ? resolve(entry.parentId, stack) : false);
    stack.delete(id);
    result.set(id, effective);
    return effective;
  };
  for (const entry of entries) resolve(entry.id, new Set());
  return result;
}

export function buildSpaceEffectiveMap(spaces: SpaceDto[]): Map<string, boolean> {
  return computeEffectiveArchived(
    spaces.map((s) => ({ id: s.id, parentId: s.parentId ?? null, archived: Boolean(s.archived) })),
  );
}

export function isTaskEffectiveArchived(task: TaskDto, spaceEffectiveMap: Map<string, boolean>): boolean {
  if (task.archived) return true;
  if (!task.spaceId) return false;
  return spaceEffectiveMap.get(task.spaceId) ?? false;
}

// ---------------------------------------------------------------------------
// Mixed order — 同父下 space sort_order 与 task space_sort_order 在同一比较平面
// ---------------------------------------------------------------------------
export type WorkspaceTreeNode =
  | {
      kind: "space";
      id: string;
      parentId: string | null;
      sortOrder: number;
      /** 冻结 DB created_at 的映射（若 SpaceDto 未提供则按 0 回退到 id），用于与 DB getSpaceChildren 的 tie-break 对齐 */
      createdAt: number;
      name: string;
      path?: string;
      archived: boolean;
      effectiveArchived: boolean;
      children: WorkspaceTreeNode[];
      /** 原始 DTO；比较器等仅需结构字段的场景可省略（可选，避免测试/比较器中空对象垫片） */
      raw?: SpaceDto;
    }
  | {
      kind: "task";
      id: string;
      spaceId: string | null;
      spaceSortOrder: number;
      isFavorited: boolean;
      archived: boolean;
      effectiveArchived: boolean;
      updatedAt: number;
      title: string;
      /** 原始 DTO；比较器等仅需结构字段的场景可省略（可选，避免测试/比较器中空对象垫片） */
      raw?: TaskDto;
    };

export interface BuildWorkspaceTreeOptions {
  /** 默认 false：过滤掉 effectiveArchived 节点（侧栏/搜索默认视图）；归档管理场景置 true */
  includeArchived?: boolean;
}

function orderOf(node: WorkspaceTreeNode): number {
  return node.kind === "space" ? node.sortOrder : node.spaceSortOrder;
}

function hasExplicitOrder(node: WorkspaceTreeNode): boolean {
  const o = orderOf(node);
  return Number.isFinite(o) && o > 0;
}

/**
 * 同父 mixed 比较器（确定性，与 DB getSpaceChildren 的 sort_order→created_at→id 对齐）：
 * 1) isFavorited 置顶（仅 task；spaces 永不置顶）— 仅 presentation priority，不改写 sortOrder/spaceSortOrder
 * 2) 显式排序键：sort_order / space_sort_order 在同一平面直接数值比较（1000 步进，显式 > 隐式；NaN/负数/非有限按隐式处理）
 * 3) 显式相同或同为隐式时：同类内按确定性回退（task: updatedAt DESC → id；space: createdAt ASC → id），跨类隐式：space 在前（文件夹优先）
 *
 * 注意：
 * - space 的 fallback 与冻结 DB getSpaceChildren 的 ORDER BY sort_order ASC, created_at ASC, id ASC 保持一致，不使用 name 改写结构排序。
 * - Task drag insertion uses this displayed sibling order in both renderer and database.
 */
export function compareMixed(a: WorkspaceTreeNode, b: WorkspaceTreeNode): number {
  const aPinned = a.kind === "task" && a.isFavorited ? 1 : 0;
  const bPinned = b.kind === "task" && b.isFavorited ? 1 : 0;
  if (aPinned !== bPinned) return bPinned - aPinned;

  const aHas = hasExplicitOrder(a);
  const bHas = hasExplicitOrder(b);
  const aOrder = orderOf(a);
  const bOrder = orderOf(b);
  if (aHas && bHas) {
    if (aOrder !== bOrder) return aOrder - bOrder;
    // 同显式值：落到同类/跨类确定性回退（避免 ID 随机）
  } else if (aHas && !bHas) {
    return -1;
  } else if (!aHas && bHas) {
    return 1;
  }

  // 同为显式且值相同，或同为隐式 → 确定性回退
  if (a.kind === "task" && b.kind === "task") {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt; // 新在前（沿用侧栏 sortTasks 历史语义）
    return a.id.localeCompare(b.id);
  }
  if (a.kind === "space" && b.kind === "space") {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt; // 与 DB created_at ASC 对齐
    return a.id.localeCompare(b.id);
  }
  // 跨类：显式同值或同隐式时，文件夹在前（常见树 UX），保证全序
  return a.kind === "space" ? -1 : 1;
}

export function buildWorkspaceTree(
  spaces: SpaceDto[],
  tasks: TaskDto[],
  opts: BuildWorkspaceTreeOptions = {},
): WorkspaceTreeNode[] {
  const includeArchived = opts.includeArchived ?? false;
  const spaceEffective = buildSpaceEffectiveMap(spaces);

  const effectiveSpaces = includeArchived
    ? spaces
    : spaces.filter((s) => !(spaceEffective.get(s.id) ?? false));
  const effectiveTasks = (includeArchived ? tasks : tasks.filter((t) => !isTaskEffectiveArchived(t, spaceEffective)));

  // 索引
  const spacesByParent = new Map<string | null, SpaceDto[]>();
  for (const s of effectiveSpaces) {
    const key = (s.parentId ?? null) as string | null;
    const arr = spacesByParent.get(key);
    if (arr) arr.push(s);
    else spacesByParent.set(key, [s]);
  }
  const tasksBySpace = new Map<string | null, TaskDto[]>();
  for (const t of effectiveTasks) {
    const key = (t.spaceId ?? null) as string | null;
    const arr = tasksBySpace.get(key);
    if (arr) arr.push(t);
    else tasksBySpace.set(key, [t]);
  }

  const visitedSpaces = new Set<string>();

  const build = (parentId: string | null): WorkspaceTreeNode[] => {
    const childSpaces = spacesByParent.get(parentId) ?? [];
    const childTasks = tasksBySpace.get(parentId) ?? [];

    const nodes: WorkspaceTreeNode[] = [
      ...childSpaces.map((s): WorkspaceTreeNode => ({
        kind: "space",
        id: s.id,
        parentId: s.parentId ?? null,
        sortOrder: s.sortOrder ?? 0,
        createdAt: s.createdAt ?? 0,
        name: s.name,
        path: s.path,
        archived: Boolean(s.archived),
        effectiveArchived: spaceEffective.get(s.id) ?? false,
        children: [],
        raw: s,
      })),
      ...childTasks.map((t): WorkspaceTreeNode => ({
        kind: "task",
        id: t.id,
        spaceId: t.spaceId ?? null,
        spaceSortOrder: t.spaceSortOrder ?? 0,
        isFavorited: Boolean(t.isFavorited),
        archived: Boolean(t.archived),
        effectiveArchived: isTaskEffectiveArchived(t, spaceEffective),
        updatedAt: t.updatedAt,
        title: t.title,
        raw: t,
      })),
    ];

    nodes.sort(compareMixed);

    // 为 space 递归填充 children（带环防御：已访问过的 space 不再展开）
    for (const n of nodes) {
      if (n.kind === "space") {
        if (visitedSpaces.has(n.id)) {
          n.children = [];
        } else {
          visitedSpaces.add(n.id);
          n.children = build(n.id);
        }
      }
    }
    return nodes;
  };

  return build(null);
}

/**
 * 比较器专用轻量节点工厂（P3 清理：raw 可选，避免测试/比较器中空对象垫片与 as unknown）
 * 仅需结构排序键时使用，无需构造完整 DTO/raw。
 */
export function createSpaceComparatorNode(overrides: {
  id: string;
  sortOrder?: number;
  createdAt?: number;
  name?: string;
  parentId?: string | null;
  archived?: boolean;
  effectiveArchived?: boolean;
}): Extract<WorkspaceTreeNode, { kind: "space" }> {
  return {
    kind: "space",
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0,
    name: overrides.name ?? overrides.id,
    archived: overrides.archived ?? false,
    effectiveArchived: overrides.effectiveArchived ?? false,
    children: [],
  };
}

export function createTaskComparatorNode(overrides: {
  id: string;
  spaceSortOrder?: number;
  updatedAt?: number;
  isFavorited?: boolean;
  spaceId?: string | null;
  archived?: boolean;
  effectiveArchived?: boolean;
  title?: string;
}): Extract<WorkspaceTreeNode, { kind: "task" }> {
  return {
    kind: "task",
    id: overrides.id,
    spaceId: overrides.spaceId ?? null,
    spaceSortOrder: overrides.spaceSortOrder ?? 0,
    isFavorited: overrides.isFavorited ?? false,
    archived: overrides.archived ?? false,
    effectiveArchived: overrides.effectiveArchived ?? false,
    updatedAt: overrides.updatedAt ?? 0,
    title: overrides.title ?? overrides.id,
  };
}

/** DFS 前序扁平化（父在子前；同级已按 mixed 排序） */
export function flattenWorkspaceTree(tree: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
  const out: WorkspaceTreeNode[] = [];
  const walk = (nodes: WorkspaceTreeNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      if (n.kind === "space" && n.children.length) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/**
 * 根级混合视图（与 buildWorkspaceTree 的根层语义唯一）：
 * 返回 `parentId===null` 层的混合排序根节点列表（按 compareMixed 排序，根级即 mixed order）。
 * 每个根 space 节点的 `children` 已递归填充并按同一 mixed 规则排序（与 buildWorkspaceTree 完整树一致），
 * 因此 `getRootMixedView(...)` 等价于 `buildWorkspaceTree(... )` 的根切片；
 * 如仅需浅层根列表（不展开子空间），请取返回值后映射 `n.id` / `n.name`，不要假设 `children` 为空。
 * 与“完整树”无歧义：完整树 = 本函数返回值本身（根即树）；扁平前序请用 flattenWorkspaceTree。
 */
export function getRootMixedView(
  spaces: SpaceDto[],
  tasks: TaskDto[],
  opts: BuildWorkspaceTreeOptions = {},
): WorkspaceTreeNode[] {
  return buildWorkspaceTree(spaces, tasks, opts);
}

/**
 * 按 parentId 取该空间下的直接子（spaces+tasks 已按 compareMixed 混排）。
 * - `parentId===null` 等价于 getRootMixedView（根层）。
 * - 其它 parentId 返回该 space 节点的 `children`（已排序；不含更深孙节点，需逐层展开）。
 * - `includeArchived` 语义与 buildWorkspaceTree 一致：默认过滤 effectiveArchived，归档管理场景传 true 可展开已归档子节点。
 * 性能：单次 build + 单次索引（DFS 查找，不做全量 flatten+find 的二次遍历）；批量查询请复用 `buildWorkspaceTree` 后自行索引，避免循环内重复 build。
 */
export function getChildrenMixed(
  parentId: string | null,
  spaces: SpaceDto[],
  tasks: TaskDto[],
  opts: BuildWorkspaceTreeOptions = {},
): WorkspaceTreeNode[] {
  const tree = buildWorkspaceTree(spaces, tasks, opts);
  if (parentId == null) return tree;
  return findWorkspaceNode(tree, parentId)?.children ?? [];
}

/** 收集某空间的所有后代空间 id（含间接子孙），用于 cycle 检测（环防御） */
export function collectDescendantSpaceIds(tree: WorkspaceTreeNode[], ancestorId: string): Set<string> {
  const ancestor = findWorkspaceNode(tree, ancestorId);
  if (!ancestor) return new Set();
  const out = new Set<string>();
  const stack: WorkspaceTreeNode[] = [...ancestor.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.kind === "space") {
      out.add(n.id);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
  }
  return out;
}

/** 基于 spaces parentId 链的轻量 cycle 检测（无需 build 树，适用于 DB 层与 UI 预校验） */
export function isSpaceDescendant(
  spaces: Array<{ id: string; parentId?: string | null }>,
  ancestorId: string,
  descendantId: string | null,
): boolean {
  if (descendantId == null) return false;
  if (ancestorId === descendantId) return true;
  const byId = new Map(spaces.map((s) => [s.id, s.parentId ?? null]));
  let cursor: string | null = descendantId;
  const seen = new Set<string>();
  while (cursor != null) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    if (cursor === ancestorId) return true;
    cursor = byId.get(cursor) ?? null;
  }
  return false;
}

/** Convert a drop position into a same-kind index in the displayed sibling order.
 * Both the optimistic update and database insertion must use that same order.
 */
export function mixedIndexToKindIndex(
  parentChildrenMixed: WorkspaceTreeNode[],
  draggedId: string | null,
  draggedKind: "space" | "task",
  dropMixedIndex: number,
): number {
  const filtered = draggedId ? parentChildrenMixed.filter((n) => n.id !== draggedId) : parentChildrenMixed;
  const clamped = Math.max(0, Math.min(dropMixedIndex, filtered.length));
  if (draggedKind === "space") {
    let count = 0;
    for (let i = 0; i < clamped; i++) {
      if (filtered[i]!.kind === draggedKind) count++;
    }
    return count;
  }
  return filtered.slice(0, clamped).filter(node => node.kind === "task").length;
}

/**
 * P1-3：同步解析 DnD dataTransfer 兜底（可测试纯函数，不依赖异步 setState）。
 * 适用于 handleRowDrop 中 dragged 为空时，从 dataTransfer 恢复被拖拽对象，避免依赖异步 setDragged。
 */
export function resolveDraggedFromTransfer(opts: {
  dataTransfer: { getData: (type: string) => string; types?: readonly string[] } | null;
  spaces: Array<{ id: string; parentId?: string | null }>;
  tasks: Array<{ id: string; spaceId?: string | null }>;
  taskDragType?: string;
  spaceDragType?: string;
}): { id: string; kind: "space" | "task"; parentId: string | null } | null {
  if (!opts.dataTransfer) return null;
  const TASK_DRAG_TYPE = opts.taskDragType ?? "application/x-mybuddy-task";
  const SPACE_DRAG_TYPE = opts.spaceDragType ?? "application/x-mybuddy-space";
  try {
    const taskId = opts.dataTransfer.getData(TASK_DRAG_TYPE);
    if (taskId) {
      const t = opts.tasks.find((x) => x.id === taskId);
      if (t) return { id: taskId, kind: "task", parentId: t.spaceId ?? null };
      // data 存在但本地无该任务（如已被删除），仍返回 id 供 validateDrop 拒绝
      return { id: taskId, kind: "task", parentId: null };
    }
    const spaceId = opts.dataTransfer.getData(SPACE_DRAG_TYPE);
    if (spaceId) {
      const s = opts.spaces.find((x) => x.id === spaceId);
      if (s) return { id: spaceId, kind: "space", parentId: s.parentId ?? null };
      return { id: spaceId, kind: "space", parentId: null };
    }
  } catch {
    return null;
  }
  return null;
}

/** P2-3：虚拟化阈值与 auto-scroll 纯逻辑（可单元测试，不依赖真实 DOM / useVirtualizer） */
export const TREE_VIRTUALIZE_THRESHOLD = 50;
export function shouldVirtualize(rowCount: number, threshold: number = TREE_VIRTUALIZE_THRESHOLD): boolean {
  return rowCount > threshold;
}
/**
 * 根据指针 Y 与容器上下边缘计算自动滚动增量（pure）。
 * - containerRect: 滚动容器视口 rect
 * - pointerY: clientY
 * - edgeThreshold: 距边缘触发阈值（默认 64px）
 * - maxSpeed: 最大每帧滚动（默认 18px）
 * 返回 0 表示不滚动，负值向上，正值向下。
 */
export function calcAutoScrollDelta(
  containerRect: { top: number; bottom: number },
  pointerY: number,
  edgeThreshold = 64,
  maxSpeed = 18,
): number {
  const distTop = pointerY - containerRect.top;
  const distBottom = containerRect.bottom - pointerY;
  if (distTop < edgeThreshold && distTop >= 0) {
    const ratio = (edgeThreshold - distTop) / edgeThreshold; // 0..1 越近边缘越大
    return -Math.ceil(ratio * maxSpeed);
  }
  if (distBottom < edgeThreshold && distBottom >= 0) {
    const ratio = (edgeThreshold - distBottom) / edgeThreshold;
    return Math.ceil(ratio * maxSpeed);
  }
  return 0;
}
/**
 * 计算虚拟窗口切片（pure，不依赖 TanStack）。用于 §37 诚实单元验证：大列表线性与折叠截断。
 * P3-3 清理：单次 prefix 构建复用 offset，避免三段重复累加；魔数 40 改为基于 estimateSize 的 overscanPx（首行高度或回退 40，附注释）。
 */
export function getVirtualSlice<T>(rows: T[], scrollTop: number, viewportHeight: number, estimateSize: (index: number, row: T) => number, overscan?: number): { start: number; end: number; offset: number } {
  const over = overscan ?? 12;
  if (rows.length === 0) return { start: 0, end: 0, offset: 0 };
  // 单次构建高度与 prefix，避免后续重复累加
  const heights: number[] = new Array(rows.length);
  const prefix: number[] = new Array(rows.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < rows.length; i++) {
    const h = estimateSize(i, rows[i]!);
    heights[i] = h;
    prefix[i + 1] = prefix[i]! + h;
  }
  const totalHeight = prefix[rows.length]!;
  if (scrollTop >= totalHeight) {
    const start = Math.max(0, rows.length - over * 2);
    return { start, end: rows.length, offset: prefix[start]! };
  }
  let start = 0;
  for (let i = 0; i < rows.length; i++) {
    if (prefix[i]! + heights[i]! > scrollTop) {
      start = Math.max(0, i - over);
      break;
    }
  }
  const offset = prefix[start]!;
  // 替代魔数 40：基于实际行高（首个可视行或首行）的 overscan 像素缓冲，旧 40 为 space(32)/task(48) 均值，保留回退值以兼容空行
  const referenceHeight = heights[start] ?? heights[0] ?? 40;
  const overscanPx = over * referenceHeight;
  let visibleHeight = 0;
  let end = start;
  for (let i = start; i < rows.length && visibleHeight < viewportHeight + overscanPx; i++) {
    visibleHeight += heights[i]!;
    end = i + 1;
  }
  end = Math.min(rows.length, end + over);
  return { start, end, offset };
}

/**
 * 校验 drop 是否合法（cycle / archived / 非法）。返回 {ok, reason}，ok=false 时 UI 应明确拒绝且不做乐观更新。
 * - spaces：全量 SpaceDto（含 parentId/archived，用于 cycle 与 effectiveArchived 判定）
 * - tasks：可选（task 拖拽时判定 task 自身 archived）
 * - targetParentId：目标父空间 id（null=根）
 */
export function validateDrop(opts: {
  draggedId: string;
  draggedKind: "space" | "task";
  targetParentId: string | null;
  spaces: SpaceDto[];
  tasks?: TaskDto[];
}): { ok: true } | { ok: false; reason: string } {
  const { draggedId, draggedKind, targetParentId, spaces, tasks } = opts;
  // 非法：拖到自身
  if (draggedKind === "space" && targetParentId === draggedId) {
    return { ok: false, reason: "不能把空间移动到其自身之下（cycle）" };
  }
  // archived：目标父若 effectiveArchived 则拒绝（隐藏子树，不应作为 drop 目标）
  if (targetParentId != null) {
    const eff = buildSpaceEffectiveMap(spaces);
    if (eff.get(targetParentId)) {
      return { ok: false, reason: "不能移动到已归档空间" };
    }
    const target = spaces.find((s) => s.id === targetParentId);
    if (!target) return { ok: false, reason: "目标空间不存在" };
  }
  // cycle：space 不能移到自身后代
  if (draggedKind === "space" && targetParentId != null) {
    if (isSpaceDescendant(spaces, draggedId, targetParentId)) {
      return { ok: false, reason: "不能把空间移动到其子孙空间之下（cycle）" };
    }
  }
  // task 自身若已归档（极少可见），也拒绝 DnD（保持与列表过滤一致）
  if (draggedKind === "task" && tasks) {
    const t = tasks.find((x) => x.id === draggedId);
    if (t?.archived) return { ok: false, reason: "已归档任务不能移动" };
    // 任务所属目标空间若有效归档，已在上面拒绝
  }
  // space 自身若有效归档，拖拽本身应已被过滤，此处防御
  if (draggedKind === "space") {
    const eff = buildSpaceEffectiveMap(spaces);
    if (eff.get(draggedId)) return { ok: false, reason: "已归档空间不能移动" };
  }
  return { ok: true };
}

/** P2-1/P3-1：collapsed 集合纯操作（可测：删除清理 / 回滚） */
export function purgeCollapsedAfterDelete(collapsedIds: string[], deletedId: string): string[] {
  return collapsedIds.filter((id) => id !== deletedId);
}
export function nextCollapsedAfterExpand(collapsedIds: string[], targetId: string | null): string[] {
  if (!targetId) return collapsedIds;
  if (!collapsedIds.includes(targetId)) return collapsedIds;
  return collapsedIds.filter((id) => id !== targetId);
}
/** P2-2：pending 串行纯逻辑（可测） */
export function tryAcquirePending(pending: Set<string>, id: string): boolean {
  if (pending.has(id)) return false;
  pending.add(id);
  return true;
}
export function releasePending(pending: Set<string>, id: string): void {
  pending.delete(id);
}

/** 可视扁平：按 collapsedIds 过滤后的 DFS 前序（用于虚拟化渲染与 sibling 计算） */
export function flattenVisible(
  tree: WorkspaceTreeNode[],
  collapsedIds: Set<string> | string[],
): WorkspaceTreeNode[] {
  const collapsed = collapsedIds instanceof Set ? collapsedIds : new Set(collapsedIds);
  const out: WorkspaceTreeNode[] = [];
  const walk = (nodes: WorkspaceTreeNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      if (n.kind === "space" && n.children.length && !collapsed.has(n.id)) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** 在已构建的树中按 id 查找 space 节点（DFS，遇即停，不全量 flatten） */
export function findWorkspaceNode(
  tree: WorkspaceTreeNode[],
  id: string,
): Extract<WorkspaceTreeNode, { kind: "space" }> | undefined {
  const stack: WorkspaceTreeNode[] = [...tree];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.kind === "space" && node.id === id) return node as Extract<WorkspaceTreeNode, { kind: "space" }>;
    if (node.kind === "space" && node.children.length) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
    }
  }
  return undefined;
}

/**
 * 为批量查询复用的索引结构：一次 build + 一次遍历建 Map，避免在循环中重复 build。
 * 纯函数，无缓存状态；调用方可持有 `{ tree, byId }` 并多次调用 `byId.get(parentId)?.children`。
 */
export function buildWorkspaceTreeIndex(
  spaces: SpaceDto[],
  tasks: TaskDto[],
  opts: BuildWorkspaceTreeOptions = {},
): { tree: WorkspaceTreeNode[]; byId: Map<string, Extract<WorkspaceTreeNode, { kind: "space" }>> } {
  const tree = buildWorkspaceTree(spaces, tasks, opts);
  const byId = new Map<string, Extract<WorkspaceTreeNode, { kind: "space" }>>();
  const stack: WorkspaceTreeNode[] = [...tree];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.kind === "space") {
      byId.set(n.id, n as Extract<WorkspaceTreeNode, { kind: "space" }>);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
  }
  return { tree, byId };
}
