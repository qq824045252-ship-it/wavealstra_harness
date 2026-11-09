import { APP_VERSION } from "@shared/app-version";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useAppStore, useSidebarTasks } from "@/store/appStore";
import {
  buildWorkspaceTree,
  findWorkspaceNode,
  mixedIndexToKindIndex,
  validateDrop,
  resolveDraggedFromTransfer,
  calcAutoScrollDelta,
  shouldVirtualize,
  TREE_VIRTUALIZE_THRESHOLD,
} from "../../../shared/workspace-tree";
import type { WorkspaceTreeNode } from "../../../shared/workspace-tree";
import type { SpaceDto, TaskDto } from "../../../shared/agent-ipc";
import type { NotificationDto } from "../../../shared/notification";
import { matchesTaskFilter } from "@/utils/taskFilters";
import FilterPopup from "@/components/sidebar/FilterPopup";
import TaskItem from "@/components/sidebar/TaskItem";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import CreateWorkspaceDialog from "@/components/workspace/CreateWorkspaceDialog";
import type { Page, Space, Task } from "@/types";
import {
  IconAlert,
  IconArchive,
  IconBarChart,
  IconBell,
  IconBot,
  IconMessageDashed,
  IconListTodo,
  IconBroom,
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFilter,
  IconFolder,
  IconFolderOpen,
  IconFolderKanban,
  IconGrid,
  IconKeyRound,
  IconLink,
  IconPanel,
  IconPalette,
  IconPencil,
  IconPlus,
  IconPuzzle,
  IconMore,
  IconTrash,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconZap,
} from "@/components/common/icons";



type VisibleRow =
  | { key: string; kind: "space"; space: Space; depth: number; collapsed: boolean; node: WorkspaceTreeNode; hasChildren: boolean }
  | { key: string; kind: "task"; task: Task; depth: number; node: WorkspaceTreeNode };

const TASK_DRAG_TYPE = "application/x-mybuddy-task";
const SPACE_DRAG_TYPE = "application/x-mybuddy-space";

const isTaskDrag = (types: readonly string[]): boolean => types.includes(TASK_DRAG_TYPE);
const isSpaceDrag = (types: readonly string[]): boolean => types.includes(SPACE_DRAG_TYPE);
const isTreeDrag = (types: readonly string[]): boolean => isTaskDrag(types) || isSpaceDrag(types);

/**
 * 侧栏树排序用的时间键：量化到分钟。
 * 流式/回放事件可能把 task.updatedAt 刷成毫秒级 now（一条含 38 图的消息会连发
 * 几十条 artifact_ref），而 compareMixed 用 updatedAt DESC 排序 —— 两条任务会
 * 在同一秒内反复交换位置，看起来像"一直在加载"。量化后同一分钟内排序键恒定，
 * 退化为 compareMixed 的 id 确定性兜底；跨分钟最多变更一次。
 */
function stableSortAt(timestamp: number): number {
  return Math.floor(timestamp / 60_000) * 60_000;
}

/** 置顶只改展示位置：从整棵筛选后的树里抽出已置顶任务，折叠的空间也算。 */
function collectPinnedRows(nodes: WorkspaceTreeNode[], tasks: Task[]): Array<Extract<VisibleRow, { kind: "task" }>> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rows: Array<Extract<VisibleRow, { kind: "task" }>> = [];
  const walk = (list: WorkspaceTreeNode[]): void => {
    for (const node of list) {
      if (node.kind === "space") {
        walk(node.children);
        continue;
      }
      if (!node.isFavorited) continue;
      const task = byId.get(node.id);
      if (!task) continue;
      rows.push({ key: `pinned-${node.id}`, kind: "task", task, depth: 0, node });
    }
  };
  walk(nodes);
  return rows;
}

function notificationTimeLabel(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return "刚刚";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))} 小时前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function AccountNavigation({ go, openProjects }: { go: (page: Page) => void; openProjects: () => void }): React.JSX.Element {
  return <>
    <button className="sidebar-popup-item" onClick={() => go("assistant")}><IconSparkles size={14} /> 助手</button>
    <button className="sidebar-popup-item" onClick={openProjects}><IconFolderKanban size={14} /> 项目</button>
    <button className="sidebar-popup-item" onClick={() => go("bot")}><IconBot size={14} /> Bot 模式</button>
    <button className="sidebar-popup-item" onClick={() => go("automation")}><IconZap size={14} /> 自动化</button>
    <button className="sidebar-popup-item" onClick={() => go("experts")}><IconPuzzle size={14} /> 插件</button>
  </>;
}

function botPresenceLabel(status: "active" | "paused" | "disabled", hostOnline: boolean | null): string {
  if (status === "disabled") return "已停用";
  if (status === "paused") return "已暂停";
  if (hostOnline === null) return "未核实";
  return hostOnline ? "在线" : "离线";
}

export default function Sidebar({ onClose, onCreateBot }: { onClose?: () => void; onCreateBot?: () => void } = {}): React.JSX.Element {
  const tasks = useSidebarTasks();
  const spaces = useAppStore((s) => s.spaces);
  const page = useAppStore((s) => s.page);
  const botIdentities = useAppStore((s) => s.botIdentities);
  const activeBotId = useAppStore((s) => s.activeBotId);
  const botHostStatus = useAppStore((s) => s.botHostStatus);
  const setActiveBotId = useAppStore((s) => s.setActiveBotId);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const draft = useAppStore((s) => s.draft);
  const openUsageStats = useAppStore((s) => s.openUsageStats);
  const openApiAggregation = useAppStore((s) => s.openApiAggregation);
  const expandedSpaceIds = useAppStore((s) => s.expandedSpaceIds);
  const taskFilterStatus = useAppStore((s) => s.taskFilterStatus);
  const taskFilterTime = useAppStore((s) => s.taskFilterTime);
  const pinnedTaskIds = useAppStore((s) => s.pinnedTaskIds);
  const archiveSpace = useAppStore((s) => s.archiveSpace);
  const deleteSpace = useAppStore((s) => s.deleteSpace);
  const setPage = useAppStore((s) => s.setPage);
  const newTask = useAppStore((s) => s.newTask);
  const openLocalFolder = useAppStore((s) => s.openLocalFolder);
  const toggleSpaceCollapsed = useAppStore((s) => s.toggleSpaceCollapsed);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const soul = useAppStore((s) => s.soul);
  const moveSpace = useAppStore((s) => s.moveSpace);
  const moveTaskInWorkspaceTree = useAppStore((s) => s.moveTaskInWorkspaceTree);
  const openWorkspaceDetail = useAppStore((s) => s.openWorkspaceDetail);
  const userLabel = soul.alias.trim() || "我";
  const userInitial = userLabel.slice(0, 1).toUpperCase();
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationFilter, setNotificationFilter] = useState<"all" | "unread">("all");
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);

  // UX-2: derive current space states from single source of truth (store.page/activeWorkspaceId/activeTaskId/draft)
  // compressed indent: 8 + min(depth,4)*8（每级 8px）
  const spaceIndent = (depth: number): number => 8 + Math.min(depth, 4) * 8;
  // 任务行与同级空间行同一起点，补 chevron(14)+gap(6)=20 占位，使任务图标与同级空间文件夹图标对齐。
  // 不补 .space-header 的 3px 边框：任务首元素 .task-mode-icon 是 16px 居中盒（内含 13px svg，绘制左缘再右偏 1.5px），
  // 两边一抵消，20 才是视觉对齐值（+23 实测偏右约 3px）。
  const taskIndent = (depth: number): number => spaceIndent(depth) + 20;

  // 构建 DTO（过滤仅做 task 归档+筛选，effectiveArchived 由 shared/workspace-tree 统一过滤）
  const spacesDto = useMemo(() => {
    return spaces.map((s) => ({
      id: s.id,
      name: s.name,
      parentId: s.parentId ?? null,
      sortOrder: s.sortOrder ?? 0,
      createdAt: s.createdAt ?? 0,
      archived: Boolean(s.archived),
      path: s.path,
    })) as SpaceDto[];
  }, [spaces]);

  // P2-4 双树：tasksDtoAll 为全量（仅去 archived），tasksDto 为筛选后；渲染用 filtered，DnD 用全量保证 DB siblings 对齐
  const tasksDtoAll = useMemo(() => {
    const filtered = tasks.filter((t) => !t.archived);
    return filtered.map((t) => ({
      id: t.id,
      title: t.title,
      spaceId: t.spaceId ?? null,
      spaceSortOrder: t.spaceSortOrder ?? 0,
      isFavorited: Boolean(t.isFavorited) || pinnedTaskIds.includes(t.id),
      updatedAt: stableSortAt(t.updatedAt),
      archived: Boolean(t.archived),
    })) as TaskDto[];
  }, [tasks, pinnedTaskIds]);

  const tasksDto = useMemo(() => {
    const filtered = tasks.filter((t) => {
      if (t.archived) return false;
      return matchesTaskFilter(t, taskFilterStatus, taskFilterTime);
    });
    return filtered.map((t) => ({
      id: t.id,
      title: t.title,
      spaceId: t.spaceId ?? null,
      spaceSortOrder: t.spaceSortOrder ?? 0,
      isFavorited: Boolean(t.isFavorited) || pinnedTaskIds.includes(t.id),
      updatedAt: stableSortAt(t.updatedAt),
      archived: Boolean(t.archived),
    })) as TaskDto[];
  }, [tasks, taskFilterStatus, taskFilterTime, pinnedTaskIds]);

  const treeAll = useMemo(() => {
    return buildWorkspaceTree(spacesDto, tasksDtoAll, { includeArchived: false });
  }, [spacesDto, tasksDtoAll]);

  const tree = useMemo(() => {
    return buildWorkspaceTree(spacesDto, tasksDto, { includeArchived: false });
  }, [spacesDto, tasksDto]);

  const pinnedRows = useMemo(() => collectPinnedRows(tree, tasks), [tree, tasks]);
  const pinnedTaskIdSet = useMemo(() => new Set(pinnedRows.map((row) => row.task.id)), [pinnedRows]);

  const getParentChildren = useCallback(
    (parentId: string | null): WorkspaceTreeNode[] => {
      if (parentId == null) return treeAll;
      const node = findWorkspaceNode(treeAll, parentId);
      return node?.children ?? [];
    },
    [treeAll],
  );

  const visibleRows = useMemo((): VisibleRow[] => {
    const rows: VisibleRow[] = [];
    // 默认全部收起：只有用户显式展开过（expandedSpaceIds）的空间才展开
    const expandedSet = new Set(expandedSpaceIds);
    const walk = (nodes: WorkspaceTreeNode[], depth: number): void => {
      for (const n of nodes) {
        if (n.kind === "space") {
          const space = spaces.find((s) => s.id === n.id);
          if (!space) continue;
          const collapsed = !expandedSet.has(n.id);
          const hasChildren = n.children.length > 0;
          rows.push({ key: `space-${n.id}`, kind: "space", space, depth, collapsed, node: n, hasChildren });
          if (!collapsed && n.children.length) walk(n.children, depth + 1);
        } else {
          const task = tasks.find((t) => t.id === n.id);
          if (!task) continue;
          rows.push({ key: `task-${n.id}`, kind: "task", task, depth, node: n });
        }
      }
    };
    walk(tree, 0);
    return rows;
  }, [tree, spaces, tasks, expandedSpaceIds]);

  const [popup, setPopup] = useState<"more" | "account" | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [spaceMenuId, setSpaceMenuId] = useState<string | null>(null);
  const [spaceAddMenuId, setSpaceAddMenuId] = useState<string | null>(null);
  const [renamingSpaceId, setRenamingSpaceId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmDeleteSpace, setConfirmDeleteSpace] = useState<Space | null>(null);
  const [relocateNotice, setRelocateNotice] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [spaceMenuUp, setSpaceMenuUp] = useState(false);
  const [dndError, setDndError] = useState<string | null>(null);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceParentId, setCreateWorkspaceParentId] = useState<string | null>(null);
  const [dragged, setDragged] = useState<{ id: string; kind: "space" | "task"; parentId: string | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: "before" | "after" | "inside" } | null>(null);

  const renameSpace = useAppStore((s) => s.renameSpace);
  const relocateSpace = useAppStore((s) => s.relocateSpace);
  const refreshSpacePathStatus = useAppStore((s) => s.refreshSpacePathStatus);

  const runRelocate = async (space: Space): Promise<void> => {
    setSpaceMenuId(null);
    const result = await relocateSpace(space.id);
    if (result.ok || result.reason === "cancel") return;
    if (result.reason === "occupied") {
      setRelocateNotice(`该文件夹已被空间「${result.otherName}」使用。若那是挪动后新打开的空空间，先删除它，再对本空间重新定位。`);
      return;
    }
    setRelocateNotice("重新定位失败，请稍后重试。");
  };

  const accountAnchorRef = useRef<HTMLDivElement>(null);
  const notificationAnchorRef = useRef<HTMLDivElement>(null);
  const spaceMenuAnchorRef = useRef<HTMLDivElement>(null);
  const spaceAddMenuAnchorRef = useRef<HTMLDivElement>(null);
  const filterAnchorRef = useRef<HTMLDivElement>(null);

  const closeSidebarPopups = (): void => {
    setPopup(null);
    setNotificationOpen(false);
    setFilterOpen(false);
    setSpaceMenuId(null);
    setSpaceAddMenuId(null);
  };

  const startRename = (space: Space): void => {
    setSpaceMenuId(null);
    setRenamingSpaceId(space.id);
    setRenameValue(space.name);
    setRenameError(null);
  };

  const submitRename = async (id: string): Promise<void> => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError("名称不能为空");
      return;
    }
    const target = spaces.find((s) => s.id === id);
    const parentId = target?.parentId ?? null;
    const conflict = spaces.some((s) => s.id !== id && (s.parentId ?? null) === parentId && s.name.trim().toLowerCase() === trimmed.toLowerCase());
    if (conflict) {
      setRenameError("同级已存在同名空间，请换一个名称");
      return;
    }
    const ok = await renameSpace(id, trimmed);
    if (!ok) {
      setRenameError("重命名失败：名称冲突或写入出错");
      return;
    }
    setRenamingSpaceId(null);
    setRenameError(null);
  };

  const cancelRename = (): void => {
    setRenamingSpaceId(null);
    setRenameError(null);
  };

  useDismissOnClickOutside(popup === "account", () => setPopup(null), accountAnchorRef);
  useDismissOnClickOutside(notificationOpen, () => setNotificationOpen(false), notificationAnchorRef);
  useDismissOnClickOutside(spaceMenuId !== null, () => setSpaceMenuId(null), spaceMenuAnchorRef);
  useDismissOnClickOutside(spaceAddMenuId !== null, () => setSpaceAddMenuId(null), spaceAddMenuAnchorRef);
  useDismissOnClickOutside(filterOpen, () => setFilterOpen(false), filterAnchorRef);

  const refreshNotifications = useCallback(async (filter: "all" | "unread"): Promise<void> => {
    const api = window.api?.notification;
    if (!api) return;
    try {
      const [items, count] = await Promise.all([
        api.list({ unreadOnly: filter === "unread", limit: 120 }),
        api.unreadCount(),
      ]);
      setNotifications(items ?? []);
      setNotificationUnreadCount(count ?? 0);
    } catch (error) {
      console.warn("[Sidebar] refresh notifications failed", error);
    }
  }, []);

  useEffect(() => {
    void refreshNotifications(notificationFilter);
    return window.api?.notification?.onChanged?.((event) => {
      setNotificationUnreadCount(event.unreadCount);
      void refreshNotifications(notificationFilter);
    });
  }, [notificationFilter, refreshNotifications]);

  const openNotificationTarget = useCallback((notification: NotificationDto): void => {
    if (notification.taskId) {
      useAppStore.getState().setActiveTask(notification.taskId);
      return;
    }
    if (notification.projectId) {
      useAppStore.getState().openProjectDetails(notification.projectId);
      return;
    }
    if (notification.sourceType === "automation") {
      useAppStore.getState().setPage("automation");
      return;
    }
    if (notification.sourceType === "runtime") {
      useAppStore.getState().setSettingsOpen(true, "extensions");
    }
  }, []);

  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const useTreeVirtual = shouldVirtualize(visibleRows.length);
  const treeVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => sidebarScrollRef.current,
    estimateSize: (index) => {
      const row = visibleRows[index]!;
      return row.kind === "space" ? 32 : 48;
    },
    overscan: 12,
    enabled: useTreeVirtual,
  });

  // DnD helpers
  const isFiltered = taskFilterStatus !== "all" || taskFilterTime !== "all";

  const handleRowDragStart = (e: React.DragEvent, row: VisibleRow): void => {
    if (isFiltered) {
      e.preventDefault();
      setDndError("筛选状态下暂不支持拖拽排序，请先清除筛选");
      return;
    }
    if (row.kind === "space") {
      e.dataTransfer.setData(SPACE_DRAG_TYPE, row.space.id);
      e.dataTransfer.setData("text/plain", row.space.name);
      e.dataTransfer.effectAllowed = "move";
      setDragged({ id: row.space.id, kind: "space", parentId: row.space.parentId ?? null });
    } else {
      try {
        e.dataTransfer.setData(TASK_DRAG_TYPE, row.task.id);
        e.dataTransfer.setData("text/plain", row.task.title);
      } catch {}
      e.dataTransfer.effectAllowed = "move";
      setDragged({ id: row.task.id, kind: "task", parentId: row.task.spaceId ?? null });
    }
  };

  const handleTaskNotifyDragStart = (taskId: string): void => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    setDragged({ id: taskId, kind: "task", parentId: t.spaceId ?? null });
  };

  const handleRowDragOver = (e: React.DragEvent, row: VisibleRow): void => {
    if (isFiltered) { e.preventDefault(); e.dataTransfer.dropEffect = "none"; return; }
    const types = Array.from(e.dataTransfer.types);
    if (!isTreeDrag(types)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height || 32;
    let pos: "before" | "after" | "inside" = "before";
    if (row.kind === "space") {
      if (y > h * 0.3 && y < h * 0.7) pos = "inside";
      else if (y < h / 2) pos = "before";
      else pos = "after";
    } else {
      pos = y < h / 2 ? "before" : "after";
    }
    if (dragged && dragged.id === (row.kind === "space" ? row.space.id : row.task.id)) {
      if (pos === "inside" && row.kind === "space") {
        e.dataTransfer.dropEffect = "none";
        setDropTarget({ id: row.space.id, position: pos });
        return;
      }
    }
    e.dataTransfer.dropEffect = "move";
    setDropTarget({ id: row.kind === "space" ? row.space.id : row.task.id, position: pos });
    const scrollEl = sidebarScrollRef.current;
    if (scrollEl) {
      const containerRect = scrollEl.getBoundingClientRect();
      const delta = calcAutoScrollDelta(containerRect, e.clientY);
      if (delta !== 0) scrollEl.scrollTop += delta;
    }
  };

  const handleRowDragLeave = (e: React.DragEvent, row: VisibleRow): void => {
    const targetId = row.kind === "space" ? row.space.id : row.task.id;
    if (dropTarget?.id === targetId) {
      const related = e.relatedTarget as Node | null;
      if (related && (e.currentTarget as HTMLElement).contains(related)) return;
      setDropTarget(null);
    }
  };

  const handleRowDrop = async (e: React.DragEvent, targetRow: VisibleRow): Promise<void> => {
    if (isFiltered) { e.preventDefault(); setDndError("筛选状态下暂不支持拖拽排序，请先清除筛选"); setDragged(null); setDropTarget(null); return; }
    const types = Array.from(e.dataTransfer.types);
    if (!isTreeDrag(types) && !dragged) return;
    e.preventDefault();
    e.stopPropagation();
    const curDragged = dragged;
    let activeDragged = curDragged;
    if (!activeDragged) {
      const resolved = resolveDraggedFromTransfer({
        dataTransfer: e.dataTransfer as unknown as { getData: (t: string) => string; types?: readonly string[] },
        spaces: spaces as unknown as Array<{ id: string; parentId?: string | null }>,
        tasks: tasks as unknown as Array<{ id: string; spaceId?: string | null }>,
        taskDragType: TASK_DRAG_TYPE,
        spaceDragType: SPACE_DRAG_TYPE,
      });
      if (resolved) {
        activeDragged = resolved;
        setDragged(resolved);
      }
    }
    if (!activeDragged) {
      setDropTarget(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height || 32;
    let position: "before" | "after" | "inside" = "before";
    if (targetRow.kind === "space") {
      if (y > h * 0.3 && y < h * 0.7) position = "inside";
      else if (y < h / 2) position = "before";
      else position = "after";
    } else {
      position = y < h / 2 ? "before" : "after";
    }
    setDropTarget(null);
    if (activeDragged.kind === "space" && position === "inside" && targetRow.kind === "space" && targetRow.space.id === activeDragged.id) {
      setDndError("不能把空间移动到其自身之下");
      setDragged(null);
      return;
    }
    if (activeDragged.id === (targetRow.kind === "space" ? targetRow.space.id : targetRow.task.id) && position !== "inside") {
      setDragged(null);
      return;
    }

    let targetParentId: string | null;
    let originalChildren: WorkspaceTreeNode[];
    let dropMixedIndex: number;

    if (position === "inside") {
      if (targetRow.kind !== "space") {
        position = "after";
      } else {
        targetParentId = targetRow.space.id;
        originalChildren = getParentChildren(targetParentId);
        const filtered = originalChildren.filter((n) => n.id !== activeDragged.id);
        dropMixedIndex = filtered.length;
        const vd = validateDrop({ draggedId: activeDragged.id, draggedKind: activeDragged.kind, targetParentId, spaces: spacesDto, tasks: tasksDtoAll });
        if (!vd.ok) {
          setDndError(vd.reason);
          setDragged(null);
          return;
        }
        const targetIndex = mixedIndexToKindIndex(originalChildren, activeDragged.id, activeDragged.kind, dropMixedIndex);
        if (activeDragged.kind === "space") {
          const res = await moveSpace({ spaceId: activeDragged.id, targetParentId, targetIndex });
          if (!res.ok) setDndError(res.error);
        } else {
          const res = await moveTaskInWorkspaceTree({ taskId: activeDragged.id, targetSpaceId: targetParentId, targetIndex });
          if (!res.ok) setDndError(res.error);
        }
        setDragged(null);
        return;
      }
    }
    targetParentId = targetRow.kind === "space" ? (targetRow.space.parentId ?? null) : (targetRow.task.spaceId ?? null);
    originalChildren = getParentChildren(targetParentId);
    const filtered = originalChildren.filter((n) => n.id !== activeDragged.id);
    const targetId = targetRow.kind === "space" ? targetRow.space.id : targetRow.task.id;
    const idx = filtered.findIndex((n) => n.id === targetId);
    if (idx === -1) {
      setDragged(null);
      return;
    }
    dropMixedIndex = position === "before" ? idx : idx + 1;
    const vd = validateDrop({ draggedId: activeDragged.id, draggedKind: activeDragged.kind, targetParentId, spaces: spacesDto, tasks: tasksDtoAll });
    if (!vd.ok) {
      setDndError(vd.reason);
      setDragged(null);
      return;
    }
    const targetIndex = mixedIndexToKindIndex(originalChildren, activeDragged.id, activeDragged.kind, dropMixedIndex);
    const curKindIdx = (() => {
      const siblingsKind = originalChildren.filter((n) => n.kind === activeDragged.kind).map((n) => n.id);
      return siblingsKind.indexOf(activeDragged.id);
    })();
    // Task targetIndex is a database rank; curKindIdx is a visual rank.
    // They differ for implicit time ordering and pinned tasks.
    if (activeDragged.kind === "space" && curKindIdx !== -1 && targetIndex === curKindIdx) {
      setDragged(null);
      return;
    }
    if (activeDragged.kind === "space") {
      const res = await moveSpace({ spaceId: activeDragged.id, targetParentId, targetIndex });
      if (!res.ok) setDndError(res.error);
    } else {
      const res = await moveTaskInWorkspaceTree({ taskId: activeDragged.id, targetSpaceId: targetParentId, targetIndex });
      if (!res.ok) setDndError(res.error);
    }
    setDragged(null);
  };

  const handleDragEnd = (): void => {
    setDragged(null);
    setDropTarget(null);
  };

  const handleRootDragOver = (e: React.DragEvent): void => {
    if (isFiltered) return;
    const types = Array.from(e.dataTransfer.types);
    if (!isTreeDrag(types)) return;
    if (dropTarget) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const scrollEl = sidebarScrollRef.current;
    if (scrollEl) {
      const delta = calcAutoScrollDelta(scrollEl.getBoundingClientRect(), e.clientY);
      if (delta !== 0) scrollEl.scrollTop += delta;
    }
  };

  const handleRootDrop = async (e: React.DragEvent): Promise<void> => {
    if (isFiltered) { setDndError("筛选状态下暂不支持拖拽排序，请先清除筛选"); return; }
    const types = Array.from(e.dataTransfer.types);
    let activeDragged = dragged;
    if (!activeDragged && isTreeDrag(types)) {
      const resolved = resolveDraggedFromTransfer({
        dataTransfer: e.dataTransfer as unknown as { getData: (t: string) => string; types?: readonly string[] },
        spaces: spaces as unknown as Array<{ id: string; parentId?: string | null }>,
        tasks: tasks as unknown as Array<{ id: string; spaceId?: string | null }>,
        taskDragType: TASK_DRAG_TYPE,
        spaceDragType: SPACE_DRAG_TYPE,
      });
      if (resolved) {
        activeDragged = resolved;
        setDragged(resolved);
      }
    }
    if (!activeDragged) return;
    if (!isTreeDrag(types) && !dragged) return;
    if (dropTarget) return;
    e.preventDefault();
    e.stopPropagation();
    if (!activeDragged) return;
    const targetParentId: string | null = null;
    const originalChildren = getParentChildren(null);
    const filtered = originalChildren.filter((n) => n.id !== activeDragged.id);
    const dropMixedIndex = filtered.length;
    const vd = validateDrop({ draggedId: activeDragged.id, draggedKind: activeDragged.kind, targetParentId, spaces: spacesDto, tasks: tasksDtoAll });
    if (!vd.ok) {
      setDndError(vd.reason);
      setDragged(null);
      return;
    }
    const targetIndex = mixedIndexToKindIndex(originalChildren, activeDragged.id, activeDragged.kind, dropMixedIndex);
    if (activeDragged.kind === "space") {
      const res = await moveSpace({ spaceId: activeDragged.id, targetParentId, targetIndex });
      if (!res.ok) setDndError(res.error);
    } else {
      const res = await moveTaskInWorkspaceTree({ taskId: activeDragged.id, targetSpaceId: targetParentId, targetIndex });
      if (!res.ok) setDndError(res.error);
    }
    setDragged(null);
    setDropTarget(null);
  };

  const renderRow = (row: VisibleRow): React.JSX.Element => {
    const isDrop = dropTarget?.id === (row.kind === "space" ? row.space.id : row.task.id);
    const dropPos = isDrop ? dropTarget!.position : null;
    const isDragged = dragged?.id === (row.kind === "space" ? row.space.id : row.task.id);
    const dropClass = isDrop ? (dropPos === "inside" ? "drop-inside" : dropPos === "before" ? "drop-before" : "drop-after") : "";
    const dragClass = isDragged ? "dragging" : "";

    if (row.kind === "space") {
      const { space, depth, collapsed, hasChildren } = row;
      const isActiveSpace = page === "workspace" && activeWorkspaceId === space.id;
      const stateClass = isActiveSpace ? "space-active" : "";
      if (renamingSpaceId === space.id) {
        return (
          <div
            className={`space-header space-renaming ${stateClass} ${dragClass} ${dropClass}`}
            data-depth={Math.min(depth, 4)}
            style={{ paddingLeft: spaceIndent(depth) }}
            onDragOver={(e) => handleRowDragOver(e, row)}
            onDragLeave={(e) => handleRowDragLeave(e, row)}
            onDrop={(e) => void handleRowDrop(e, row)}
            onDragEnd={handleDragEnd}
          >
            <span className="space-icon"><IconFolder size={14} /></span>
            <form
              className="space-rename-form"
              onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); void submitRename(space.id); }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                className="space-rename-input"
                autoFocus
                value={renameValue}
                onChange={(e) => { setRenameValue(e.target.value); setRenameError(null); }}
                onBlur={() => { if (!renameError) cancelRename(); }}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancelRename(); } }}
              />
              <div className="space-rename-actions">
                <button type="submit" className="space-rename-confirm" onMouseDown={(e) => e.preventDefault()}>确定</button>
                <button type="button" className="space-rename-cancel" onMouseDown={(e) => e.preventDefault()} onClick={cancelRename}>取消</button>
              </div>
              {renameError && <span className="space-rename-error">{renameError}</span>}
            </form>
          </div>
        );
      }
      return (
        <div
          role="button"
          tabIndex={0}
          draggable
          onDragStart={(e) => handleRowDragStart(e, row)}
          onDragOver={(e) => handleRowDragOver(e, row)}
          onDragLeave={(e) => handleRowDragLeave(e, row)}
          onDrop={(e) => void handleRowDrop(e, row)}
          onDragEnd={handleDragEnd}
          className={`space-header ${spaceMenuId === space.id || spaceAddMenuId === space.id ? "menu-open" : ""} ${space.pathMissing ? "path-missing" : ""} ${stateClass} ${dragClass} ${dropClass}`}
          data-depth={Math.min(depth, 4)}
          style={{ paddingLeft: spaceIndent(depth) }}
          onClick={() => openWorkspaceDetail(space.id)}
          onKeyDown={(e) => e.key === "Enter" && openWorkspaceDetail(space.id)}
          onContextMenu={(e) => {
            e.preventDefault(); e.stopPropagation();
            setSpaceMenuUp(window.innerHeight - e.clientY < 200);
            setSpaceAddMenuId(null);
            setSpaceMenuId(space.id);
            void refreshSpacePathStatus(space.id);
          }}
          title={space.pathMissing ? `文件夹已不在原位置：${space.path}\n点击警告或菜单「重新定位文件夹」即可找回任务` : (space.path ?? space.name)}
        >
          <span className="space-chevron" role="button" tabIndex={0} style={{ width: 14, display: "inline-flex", justifyContent: "center" }} onClick={(e) => { e.stopPropagation(); toggleSpaceCollapsed(space.id); }} onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); toggleSpaceCollapsed(space.id); } }}>
            {hasChildren ? (collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />) : <span style={{ width: 12 }} />}
          </span>
          <span className="space-icon">{collapsed ? <IconFolder size={14} /> : <IconFolderOpen size={14} />}</span>
          <span className="space-name" title={space.name}>{space.name}</span>
          {space.pathMissing && (
            <button type="button" className="space-path-missing" title="文件夹已移动，点击重新定位" onClick={(e) => { e.stopPropagation(); void runRelocate(space); }}>
              <IconAlert size={12} />
            </button>
          )}
          <div className="space-header-actions" onClick={(e) => e.stopPropagation()}>
            <div className="space-menu-anchor" ref={spaceMenuId === space.id ? spaceMenuAnchorRef : undefined}>
              <button
                type="button"
                className="space-more"
                title="更多"
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setSpaceMenuUp(window.innerHeight - rect.bottom < 200);
                  const next = spaceMenuId === space.id ? null : space.id;
                  setSpaceAddMenuId(null);
                  setSpaceMenuId(next);
                  if (next) void refreshSpacePathStatus(space.id);
                }}
              >
                <IconMore size={13} />
              </button>
              {spaceMenuId === space.id && (
                <div className={`task-context-menu space-context-menu ${spaceMenuUp ? "open-up" : ""}`} onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="task-context-item" disabled={!space.path || space.pathMissing} onClick={() => { setSpaceMenuId(null); if (space.path) void window.api?.openFolder?.(space.path); }}>
                    <IconFolder size={14} /> 打开文件夹
                  </button>
                  <button type="button" className="task-context-item" onClick={() => void runRelocate(space)}>
                    <IconLink size={14} /> {space.path ? "重新定位文件夹" : "绑定文件夹"}
                  </button>
                  <button type="button" className="task-context-item" onClick={() => startRename(space)}>
                    <IconPencil size={14} /> 重命名
                  </button>
                  <button type="button" className="task-context-item" onClick={() => { setSpaceMenuId(null); void archiveSpace(space.id); }}>
                    <IconArchive size={14} /> 归档
                  </button>
                  <button type="button" className="task-context-item danger" onClick={() => { setSpaceMenuId(null); setConfirmDeleteSpace(space); }}>
                    <IconTrash size={14} /> 删除
                  </button>
                </div>
              )}
            </div>
            <div className="space-add-anchor" ref={spaceAddMenuId === space.id ? spaceAddMenuAnchorRef : undefined}>
              <button
                type="button"
                className="space-add-dialog"
                title="添加到此工作空间"
                aria-label="添加到此工作空间"
                aria-haspopup="menu"
                aria-expanded={spaceAddMenuId === space.id}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setSpaceMenuUp(window.innerHeight - rect.bottom < 150);
                  setSpaceMenuId(null);
                  setSpaceAddMenuId((current) => current === space.id ? null : space.id);
                }}
              >
                <IconPlus size={13} />
              </button>
              {spaceAddMenuId === space.id && (
                <div className={`task-context-menu space-add-menu ${spaceMenuUp ? "open-up" : ""}`} role="menu" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="task-context-item" role="menuitem" onClick={() => {
                    setSpaceAddMenuId(null);
                    setCreateWorkspaceParentId(space.id);
                    setCreateWorkspaceOpen(true);
                  }}>
                    <IconFolder size={14} /> 新建子工作空间
                  </button>
                  <button type="button" className="task-context-item" role="menuitem" onClick={() => {
                    setSpaceAddMenuId(null);
                    newTask(space.id);
                  }}>
                    <IconPlus size={14} /> 新建任务
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }
    const { task, depth } = row;
    return (
      <div
        className={`tree-task-wrap ${dragClass} ${dropClass}`}
        onDragOver={(e) => handleRowDragOver(e, row)}
        onDragLeave={(e) => handleRowDragLeave(e, row)}
        onDrop={(e) => void handleRowDrop(e, row)}
      >
        <TaskItem
          task={task}
          nested={depth > 0}
          indent={taskIndent(depth)}
          onDragStartNotify={handleTaskNotifyDragStart}
        />
      </div>
    );
  };

  const go = (p: Page): void => {
    setPage(p);
    setPopup(null);
    onClose?.();
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title-group">
          <div className="sidebar-title">
            <span className="brand-mybuddy"><span className="brand-my">My</span><span className="brand-buddy">Buddy</span></span>
          </div>
          <div className="sidebar-version">v{APP_VERSION}</div>
        </div>
        <div className="sidebar-header-actions">
          <button className="icon-btn" title="收起侧边栏" onClick={onClose ?? toggleSidebar}><IconPanel size={15} /></button>
          <button className="icon-btn" title="搜索 (Ctrl+K)" onClick={() => { onClose?.(); setSearchOpen(true); }}><IconSearch size={15} /></button>
          <div className="filter-anchor" ref={filterAnchorRef}>
            <button className={`icon-btn ${filterOpen ? "toggled" : ""}`} title="筛选" onClick={() => { const next = !filterOpen; closeSidebarPopups(); setFilterOpen(next); }}>
              <IconFilter size={15} />
            </button>
            {filterOpen && (
              <>
                <div className="filter-backdrop" onClick={() => setFilterOpen(false)} />
                <FilterPopup onClose={() => setFilterOpen(false)} />
              </>
            )}
          </div>
        </div>
      </div>

      <nav className="sidebar-mode-nav" aria-label="工作模式">
        <button type="button" aria-current={page === "chat" ? "page" : undefined} onClick={() => go("chat")}><IconMessageDashed size={16} />普通模式</button>
        <button type="button" aria-current={page === "bot" ? "page" : undefined} onClick={() => go("bot")}><IconBot size={16} />Bot 模式</button>
      </nav>
      {page === "bot" ? (
        <div className="sidebar-scroll" aria-label="Bot 导航">
          <div className="sidebar-tree-header"><span className="section-title">我的 Bot</span><span className="sidebar-section-count">{botIdentities.length}</span>{onCreateBot && <button type="button" className="sidebar-bot-create" onClick={() => { onClose?.(); onCreateBot(); }}>+ 新建 Bot</button>}</div>
          {botIdentities.length === 0 ? <div className="sidebar-empty">还没有 Bot，点击「新建 Bot」开始。</div> : botIdentities.map(bot => (
            <button key={bot.botId} type="button" className="sidebar-bot-row sidebar-bot-identity" aria-pressed={bot.botId === activeBotId} onClick={() => { setActiveBotId(bot.botId); onClose?.(); }}>
              <span className="sidebar-bot-avatar"><IconBot size={18} /></span><span><strong>{bot.displayName}</strong><small>{botPresenceLabel(bot.status, botHostStatus ? botHostStatus.online : null)}</small></span>
            </button>
          ))}
          <div className="sidebar-bot-tip"><IconListTodo size={18} /><strong>事项始终在手边</strong><p>在顶部查看进行中和已结束的事项。对话与记录，随时接着聊。</p></div>
        </div>
      ) : <>
      <div className="sidebar-primary-action">
        <button
          type="button"
          className="sidebar-cta-btn"
          onClick={() => newTask()}
          title="新建任务"
        >
          <span className="sidebar-cta-icon"><IconPlus size={14} strokeWidth={2} /></span>
          <span className="sidebar-cta-text">新建任务</span>
        </button>
      </div>

      {(() => {
        const independentRows = visibleRows.filter((r) => r.kind === "task" && r.task.spaceId == null && !pinnedTaskIdSet.has(r.task.id));
        const workspaceRows = visibleRows.filter((r) => !(r.kind === "task" && (r.task.spaceId == null || pinnedTaskIdSet.has(r.task.id))));
        // 计数与下面看得见的行一致。置顶任务已经抽到顶部，不重复计入这两个数。
        const independentTaskCount = tasksDto.filter((t) => t.spaceId == null && !t.isFavorited).length;
        const workspaceTaskCount = tasksDto.filter((t) => t.spaceId != null && !t.isFavorited).length;
        const pinnedIndependent = pinnedRows.some((row) => row.task.spaceId == null);
        return (
          <div className="sidebar-scroll" ref={sidebarScrollRef} onDragOver={handleRootDragOver} onDrop={handleRootDrop}>
            <div className="sidebar-ia-label">工作</div>
            {pinnedRows.length > 0 && (
              <div className="sidebar-pinned">
                <div className="sidebar-tree-header">
                  <span className="section-title">置顶 ({pinnedRows.length})</span>
                </div>
                <div className="sidebar-section-list">
                  {pinnedRows.map((row) => (
                    <div key={row.key} className="sidebar-pinned-row">
                      <TaskItem
                        task={row.task}
                        indent={taskIndent(0)}
                        onDragStartNotify={handleTaskNotifyDragStart}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="sidebar-tree-header">
              <span className="section-title">独立任务</span>
              <span className="sidebar-section-count">{independentTaskCount}</span>
              <button
                type="button"
                className="sidebar-section-add"
                title="新建独立任务"
                aria-label="新建独立任务"
                onClick={() => newTask()}
              >
                <IconPlus size={13} strokeWidth={2} />
              </button>
            </div>
            <div className="sidebar-section-list">
              {independentRows.length === 0 ? (
                pinnedIndependent ? null : <div className="sidebar-empty">暂无独立任务</div>
              ) : (
                independentRows.map((row) => <div key={row.key}>{renderRow(row)}</div>)
              )}
            </div>
            <div className="sidebar-tree-header sidebar-tree-header--spaced">
              <span className="section-title">工作空间</span>
              <span className="sidebar-section-count">{workspaceTaskCount}</span>
              <button type="button" className="sidebar-section-add" title="新建工作空间" aria-label="新建工作空间" onClick={() => { setCreateWorkspaceParentId(null); setCreateWorkspaceOpen(true); }}>
                <IconPlus size={13} strokeWidth={2} />
              </button>
            </div>
            <div className="sidebar-section-list">
              {workspaceRows.length === 0 ? (
                <div className="sidebar-empty sidebar-empty--cta">
                  <div>还没有工作空间</div>
                  <div className="sidebar-empty-actions">
                    <button type="button" className="sidebar-empty-cta" onClick={() => { setCreateWorkspaceParentId(null); setCreateWorkspaceOpen(true); }}>新建工作空间</button>
                    <button type="button" className="sidebar-empty-cta sidebar-empty-cta--ghost" onClick={() => void openLocalFolder()}>绑定本地文件夹</button>
                  </div>
                </div>
              ) : (
                workspaceRows.map((row) => <div key={row.key}>{renderRow(row)}</div>)
              )}
            </div>
            <div className="sidebar-root-dropzone" style={{ height: 24 }} onDragOver={handleRootDragOver} onDrop={handleRootDrop} />
          </div>
        );
      })()}
      </>}

      <div className="sidebar-user nav-popup-anchor" ref={accountAnchorRef}>
        {popup === "account" && (
          <div className="sidebar-popup account-popup">
            <div className="account-popup-name">{userLabel}</div>
            <AccountNavigation go={go} openProjects={() => { useAppStore.getState().requestProjectsRoot(); setPopup(null); onClose?.(); }} />
            <div className="sidebar-popup-sep" />
            <button className="sidebar-popup-item" onClick={() => go("gadgets")}><IconGrid size={14} /> 我的工作台</button>
            <button className="sidebar-popup-item" onClick={() => go("files")}><IconFile size={14} /> 任务成果</button>
            <div className="sidebar-popup-sep" />
            <button className="sidebar-popup-item" onClick={() => { onClose?.(); setSettingsOpen(true); setPopup(null); }}><IconSettings size={14} /> 设置</button>
            <button className="sidebar-popup-item" onClick={() => { onClose?.(); openUsageStats(); setPopup(null); }}><IconBarChart size={14} /> 用量统计</button>
            <button className="sidebar-popup-item" onClick={() => { onClose?.(); openApiAggregation(); setPopup(null); }}><IconKeyRound size={14} /> API 聚合</button>
            <div className="sidebar-popup-item spread as-row">
              <span className="sidebar-popup-item-label">
                <IconPalette size={14} /> 外观
              </span>
              <span className="theme-switch">
                <button type="button" className={`theme-switch-btn ${theme === "light" ? "active" : ""}`} onClick={() => setTheme("light")}>浅色</button>
                <button type="button" className={`theme-switch-btn ${theme === "dark" ? "active" : ""}`} onClick={() => setTheme("dark")}>深色</button>
              </span>
            </div>
          </div>
        )}
        <div role="button" tabIndex={0} className="sidebar-user-main" onClick={() => { setNotificationOpen(false); setFilterOpen(false); setSpaceMenuId(null); setPopup(popup === "account" ? null : "account"); }} onKeyDown={(e) => { if (e.key === "Enter") { setNotificationOpen(false); setFilterOpen(false); setSpaceMenuId(null); setPopup(popup === "account" ? null : "account"); } }}>
          <div className="user-avatar">{userInitial}</div><span className="user-name">{userLabel}</span>
        </div>
        <div className="notification-anchor" ref={notificationAnchorRef}>
          <button
            className={`icon-btn notification-bell ${notificationOpen ? "active" : ""}`}
            title="通知"
            aria-label={`通知${notificationUnreadCount > 0 ? `，${notificationUnreadCount} 条未读` : ""}`}
            onClick={() => {
              setPopup(null);
              setNotificationOpen((open) => {
                const next = !open;
                if (next) void refreshNotifications(notificationFilter);
                return next;
              });
            }}
          >
            <IconBell size={15} />
            {notificationUnreadCount > 0 && <span className="notification-bell-dot" />}
          </button>
          {notificationOpen && (
            <div className="sidebar-popup notification-popup" role="dialog" aria-label="通知中心">
              <div className="notification-popup-head">
                <strong>通知</strong>
                <span className="notification-popup-head-actions">
                  <button
                    type="button"
                    className="notification-clear-all"
                    title="清除全部通知"
                    aria-label="清除全部通知"
                    disabled={notifications.length === 0 && notificationUnreadCount === 0}
                    onClick={() => {
                      setNotifications([]);
                      setNotificationUnreadCount(0);
                      void window.api?.notification?.dismissAll?.().then(() => refreshNotifications(notificationFilter));
                    }}
                  >
                    <IconBroom size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={notificationUnreadCount === 0}
                    onClick={() => {
                      void window.api?.notification?.markAllRead?.().then(() => refreshNotifications(notificationFilter));
                    }}
                  >
                    全部已读
                  </button>
                </span>
              </div>
              <div className="notification-filter-tabs">
                <button
                  type="button"
                  className={notificationFilter === "all" ? "active" : ""}
                  onClick={() => { setNotificationFilter("all"); void refreshNotifications("all"); }}
                >全部</button>
                <button
                  type="button"
                  className={notificationFilter === "unread" ? "active" : ""}
                  onClick={() => { setNotificationFilter("unread"); void refreshNotifications("unread"); }}
                >未读{notificationUnreadCount > 0 ? ` ${notificationUnreadCount}` : ""}</button>
              </div>
              <div className="notification-list">
                {notifications.length === 0 ? (
                  <div className="notification-empty">{notificationFilter === "unread" ? "没有未读通知" : "暂无通知"}</div>
                ) : notifications.map((notification) => (
                  <div
                    role="button"
                    tabIndex={0}
                    key={notification.id}
                    className={`notification-item ${notification.readAt ? "read" : "unread"} level-${notification.level}`}
                    onClick={() => {
                      void window.api?.notification?.markRead?.(notification.id);
                      setNotifications((items) => items.map((item) => item.id === notification.id ? { ...item, readAt: item.readAt ?? Date.now() } : item));
                      setNotificationUnreadCount((count) => notification.readAt ? count : Math.max(0, count - 1));
                      setNotificationOpen(false);
                      openNotificationTarget(notification);
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                      event.preventDefault();
                      void window.api?.notification?.markRead?.(notification.id);
                      setNotificationOpen(false);
                      openNotificationTarget(notification);
                    }}
                  >
                    <span className="notification-item-mark" />
                    <span className="notification-item-copy">
                      <span className="notification-item-title">{notification.title}</span>
                      {notification.body && <span className="notification-item-body">{notification.body}</span>}
                      <span className="notification-item-time">{notificationTimeLabel(notification.createdAt)}</span>
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      className="notification-item-dismiss"
                      aria-label="删除通知"
                      title="删除"
                      onClick={(event) => {
                        event.stopPropagation();
                        void window.api?.notification?.dismiss?.(notification.id).then(() => refreshNotifications(notificationFilter));
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        void window.api?.notification?.dismiss?.(notification.id).then(() => refreshNotifications(notificationFilter));
                      }}
                    >×</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="notification-settings-link"
                onClick={() => { setNotificationOpen(false); onClose?.(); setSettingsOpen(true, "notifications"); }}
              >
                通知设置
              </button>
            </div>
          )}
        </div>
        <button className="icon-btn" title="设置" onClick={() => { onClose?.(); setSettingsOpen(true); }}><IconSettings size={15} /></button>
      </div>
      <ConfirmDialog open={relocateNotice !== null} title="无法重新定位" body={relocateNotice} confirmLabel="知道了" onCancel={() => setRelocateNotice(null)} onConfirm={() => setRelocateNotice(null)} />
      <ConfirmDialog open={confirmDeleteSpace !== null} title="删除空间？" body={confirmDeleteSpace ? (<>确定要删除空间「{confirmDeleteSpace.name}」吗？<br />仅空空间可删除：该空间下不能有子空间、任务或自有资料，请先处理这些内容后再删除。<br />若为空空间，删除时会一并清理该空间的记忆，操作不可恢复。</>) : null} confirmLabel="删除" danger onCancel={() => setConfirmDeleteSpace(null)} onConfirm={async () => { const target = confirmDeleteSpace; setConfirmDeleteSpace(null); if (!target) return; try { await deleteSpace(target.id); } catch (err) { const msg = err instanceof Error ? err.message : String(err); if (msg.includes("非空") || msg.includes("workspace_not_empty") || msg.includes("尚有")) { setDeleteError("该空间下还有子空间、任务或自有资料，请先处理后再删除。取消资料引用不会删除原文。"); } else { setDeleteError(msg || "删除失败，请稍后重试"); } } }} />
      <ConfirmDialog open={deleteError !== null} title="无法删除" body={deleteError} confirmLabel="知道了" onCancel={() => setDeleteError(null)} onConfirm={() => setDeleteError(null)} />
      <ConfirmDialog open={dndError !== null} title="无法移动" body={dndError} confirmLabel="知道了" onCancel={() => setDndError(null)} onConfirm={() => setDndError(null)} />
      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        parentId={createWorkspaceParentId}
        parentName={createWorkspaceParentId ? spaces.find((item) => item.id === createWorkspaceParentId)?.name : undefined}
        onClose={() => { setCreateWorkspaceOpen(false); setCreateWorkspaceParentId(null); }}
      />
    </aside>
  );
}
