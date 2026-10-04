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
  IconBook,
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

function notificationTimeLabel(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return "刚刚";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))} 小时前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default function Sidebar(): React.JSX.Element {
  const tasks = useSidebarTasks();
  const spaces = useAppStore((s) => s.spaces);
  const page = useAppStore((s) => s.page);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const draft = useAppStore((s) => s.draft);
  const openUsageStats = useAppStore((s) => s.openUsageStats);
  const openApiAggregation = useAppStore((s) => s.openApiAggregation);
  const collapsedSpaceIds = useAppStore((s) => s.collapsedSpaceIds);
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
  // compressed indent: 8 + min(depth,4)*12
  const spaceIndent = (depth: number): number => 8 + Math.min(depth, 4) * 12;
  const taskIndent = (depth: number): number => Math.min(depth, 4) * 12;

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
      updatedAt: t.updatedAt,
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
      updatedAt: t.updatedAt,
      archived: Boolean(t.archived),
    })) as TaskDto[];
  }, [tasks, taskFilterStatus, taskFilterTime, pinnedTaskIds]);

  const treeAll = useMemo(() => {
    return buildWorkspaceTree(spacesDto, tasksDtoAll, { includeArchived: false });
  }, [spacesDto, tasksDtoAll]);

  const tree = useMemo(() => {
    return buildWorkspaceTree(spacesDto, tasksDto, { includeArchived: false });
  }, [spacesDto, tasksDto]);

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
    const collapsedSet = new Set(collapsedSpaceIds);
    const walk = (nodes: WorkspaceTreeNode[], depth: number): void => {
      for (const n of nodes) {
        if (n.kind === "space") {
          const space = spaces.find((s) => s.id === n.id);
          if (!space) continue;
          const collapsed = collapsedSet.has(n.id);
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
  }, [tree, spaces, tasks, collapsedSpaceIds]);

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
    if (curKindIdx !== -1 && targetIndex === curKindIdx) {
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
        style={{ paddingLeft: taskIndent(depth) }}
        onDragOver={(e) => handleRowDragOver(e, row)}
        onDragLeave={(e) => handleRowDragLeave(e, row)}
        onDrop={(e) => void handleRowDrop(e, row)}
      >
        <TaskItem task={task} nested={depth > 0} onDragStartNotify={handleTaskNotifyDragStart} />
      </div>
    );
  };

  const go = (p: Page): void => {
    setPage(p);
    setPopup(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title-group">
          <div className="sidebar-title">
            <span className="brand-mybuddy"><span className="brand-my">My</span><span className="brand-buddy">Buddy</span></span>
          </div>
          <div className="sidebar-version">v0.1.0</div>
        </div>
        <div className="sidebar-header-actions">
          <button className="icon-btn" title="收起侧边栏" onClick={toggleSidebar}><IconPanel size={15} /></button>
          <button className="icon-btn" title="搜索 (Ctrl+K)" onClick={() => setSearchOpen(true)}><IconSearch size={15} /></button>
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
        const independentRows = visibleRows.filter((r) => r.kind === "task" && (r.task.spaceId == null));
        const workspaceRows = visibleRows.filter((r) => !(r.kind === "task" && (r.task.spaceId == null)));
        // 计数统计的是任务数量（与侧栏列表同源、同筛选）：
        // 独立任务 = 无 spaceId 的任务；工作空间 = 有 spaceId 的任务（含嵌套，折叠不影响计数）。
        const independentTaskCount = tasksDto.filter((t) => t.spaceId == null).length;
        const workspaceTaskCount = tasksDto.filter((t) => t.spaceId != null).length;
        return (
          <div className="sidebar-scroll" ref={sidebarScrollRef} onDragOver={handleRootDragOver} onDrop={handleRootDrop}>
            <div className="sidebar-ia-label">工作</div>
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
                <div className="sidebar-empty">暂无独立任务</div>
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

      <div className="sidebar-user nav-popup-anchor" ref={accountAnchorRef}>
        {popup === "account" && (
          <div className="sidebar-popup account-popup">
            <div className="account-popup-name">{userLabel}</div>
            <button className="sidebar-popup-item" onClick={() => go("assistant")}><IconSparkles size={14} /> 助手</button>
            <button className="sidebar-popup-item" onClick={() => { useAppStore.getState().requestProjectsRoot(); setPopup(null); }}><IconFolderKanban size={14} /> 项目</button>
            <button className="sidebar-popup-item" onClick={() => go("automation")}><IconZap size={14} /> 自动化</button>
            <button className="sidebar-popup-item" onClick={() => go("experts")}><IconPuzzle size={14} /> 插件</button>
            <div className="sidebar-popup-sep" />
            <button className="sidebar-popup-item" onClick={() => go("gadgets")}><IconGrid size={14} /> 我的小工具</button>
            <button className="sidebar-popup-item" onClick={() => go("library")}><IconBook size={14} /> 资料库</button>
            <button className="sidebar-popup-item" onClick={() => go("files")}><IconFile size={14} /> 文件</button>
            <div className="sidebar-popup-sep" />
            <button className="sidebar-popup-item" onClick={() => { setSettingsOpen(true); setPopup(null); }}><IconSettings size={14} /> 设置</button>
            <button className="sidebar-popup-item" onClick={() => { openUsageStats(); setPopup(null); }}><IconBarChart size={14} /> 用量统计</button>
            <button className="sidebar-popup-item" onClick={() => { openApiAggregation(); setPopup(null); }}><IconKeyRound size={14} /> API 聚合</button>
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
                onClick={() => { setNotificationOpen(false); setSettingsOpen(true, "notifications"); }}
              >
                通知设置
              </button>
            </div>
          )}
        </div>
        <button className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}><IconSettings size={15} /></button>
      </div>
      <ConfirmDialog open={relocateNotice !== null} title="无法重新定位" body={relocateNotice} confirmLabel="知道了" onCancel={() => setRelocateNotice(null)} onConfirm={() => setRelocateNotice(null)} />
      <ConfirmDialog open={confirmDeleteSpace !== null} title="删除空间？" body={confirmDeleteSpace ? (<>确定要删除空间「{confirmDeleteSpace.name}」吗？<br />仅空空间可删除：该空间下不能有子空间或任务，请先移走子空间和任务后再删除。<br />若为空空间，删除时会一并清理该空间的记忆，操作不可恢复。</>) : null} confirmLabel="删除" danger onCancel={() => setConfirmDeleteSpace(null)} onConfirm={async () => { const target = confirmDeleteSpace; setConfirmDeleteSpace(null); if (!target) return; try { await deleteSpace(target.id); } catch (err) { const msg = err instanceof Error ? err.message : String(err); if (msg.includes("非空") || msg.includes("workspace_not_empty") || msg.includes("尚有")) { setDeleteError("该空间下还有子空间或任务，请先移走子空间和任务后再删除（V2 安全语义：仅允许删除空叶子空间）。"); } else { setDeleteError(msg || "删除失败，请稍后重试"); } } }} />
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
