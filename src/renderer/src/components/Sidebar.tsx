import { GATEWAY_SIDEBAR_CHANNELS, type GatewaySidebarChannelId } from "../../../shared/gateway-task";
import "./sidebar/SidebarNavigation.css";
import { DesktopSectionRow, DesktopSectionSidebar, useDesktopSectionScroll, useDesktopSectionState, useDesktopShell } from "./desktop/DesktopSection";
import "./workspace/WorkspaceForeground.css";
import { useBotWorkspaceNavigation, openWorkspaceRequest, foregroundStatus } from "@/hooks/useBotWorkspaceNavigation";
import type { BotWorkspaceRequestDto, BotWorkspaceConversationDto } from "@shared/bot-workspace-navigation";
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
import { FOREGROUND_TASK_STATUS, matchesTaskFilter, matchesTaskTimeFilter } from "@/utils/taskFilters";
import TaskStatusIndicator from "@/components/sidebar/TaskStatusIndicator";
import TaskFilterControls from "@/components/sidebar/TaskFilterControls";
import TaskItem from "@/components/sidebar/TaskItem";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import CreateWorkspaceDialog from "@/components/workspace/CreateWorkspaceDialog";
import WorkspaceIcon from "@/components/workspace/WorkspaceIcon";
import type { Space, Task, TaskFilterStatus, TaskFilterTime } from "@/types";
import {
  IconAlert,
  IconArchive,
  IconBot,
  IconMessageDashed,
  IconChevronDown,
  IconChevronRight,
  IconFilter,
  IconFolder,
  IconLink,
  IconPencil,
  IconPlus,
  IconMore,
  IconTrash,
} from "@/components/common/icons";



type TreeRow =
  | { key: string; kind: "space"; space: Space; depth: number; collapsed: boolean; node: WorkspaceTreeNode; hasChildren: boolean }
  | { key: string; kind: "task"; task: Task; depth: number; node: WorkspaceTreeNode };

type VisibleRow = TreeRow | {key:string;kind:"conversation";conversation:BotWorkspaceConversationDto;depth:number;expanded:boolean;count:number} | { key: string; kind: "foreground"; request: BotWorkspaceRequestDto; depth: number } | { key: string; kind: "foreground-more"; spaceId: string; remaining: number; depth: number };

const TASK_DRAG_TYPE = "application/x-mybuddy-task";
const SPACE_DRAG_TYPE = "application/x-mybuddy-space";

const isTaskDrag = (types: readonly string[]): boolean => types.includes(TASK_DRAG_TYPE);
const isSpaceDrag = (types: readonly string[]): boolean => types.includes(SPACE_DRAG_TYPE);
const isTreeDrag = (types: readonly string[]): boolean => isTaskDrag(types) || isSpaceDrag(types);

function matchesForegroundSearch(request: BotWorkspaceRequestDto, term: string, status: TaskFilterStatus, time: TaskFilterTime): boolean {
  return request.title.toLowerCase().includes(term) &&
    (status === "all" || FOREGROUND_TASK_STATUS[request.status] === status) && matchesTaskTimeFilter(request.updatedAt, time);
}

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

export default function Sidebar({ onClose }: { onClose?: () => void } = {}): React.JSX.Element {
  const desktop = useDesktopShell();
  const tasks = useSidebarTasks();
  const { requests: foregroundRequests, conversations: foregroundConversations, error: foregroundError } = useBotWorkspaceNavigation();
  const [expandedConversations, setExpandedConversations] = useDesktopSectionState<Record<string, boolean>>("task:expanded-conversations", {});
  const [foregroundLimits, setForegroundLimits] = useDesktopSectionState<Record<string, number>>("task:foreground-limits", {});
  const [searchQuery, setSearchQuery] = useDesktopSectionState("task:search-query", "");
  const searchTerm = searchQuery.trim().toLowerCase();
  const spaces = useAppStore((s) => s.spaces);
  const page = useAppStore((s) => s.page);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const draft = useAppStore((s) => s.draft);
  const expandedSpaceIds = useAppStore((s) => s.expandedSpaceIds);
  const taskFilterStatus = useAppStore((s) => s.taskFilterStatus);
  const taskFilterTime = useAppStore((s) => s.taskFilterTime);
  const pinnedTaskIds = useAppStore((s) => s.pinnedTaskIds);
  const archiveSpace = useAppStore((s) => s.archiveSpace);
  const deleteSpace = useAppStore((s) => s.deleteSpace);
  const newTask = useAppStore((s) => s.newTask);
  const openLocalFolder = useAppStore((s) => s.openLocalFolder);
  const toggleSpaceCollapsed = useAppStore((s) => s.toggleSpaceCollapsed);
  const moveSpace = useAppStore((s) => s.moveSpace);
  const moveTaskInWorkspaceTree = useAppStore((s) => s.moveTaskInWorkspaceTree);
  const openWorkspaceDetail = useAppStore((s) => s.openWorkspaceDetail);

  // UX-2: derive current space states from single source of truth (store.page/activeWorkspaceId/activeTaskId/draft)
  const spaceIndent = (depth: number): number => Math.min(depth, 4) * 8;
  // Task icons start after the same 19px gutter that holds the workspace toggle.
  const taskIndent = (depth: number): number => spaceIndent(depth) + 19;

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
      if (t.archived || (searchTerm && !t.title.toLowerCase().includes(searchTerm))) return false;
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
  }, [tasks, taskFilterStatus, taskFilterTime, pinnedTaskIds, searchTerm]);

  const treeAll = useMemo(() => {
    return buildWorkspaceTree(spacesDto, tasksDtoAll, { includeArchived: false });
  }, [spacesDto, tasksDtoAll]);

  const tree = useMemo(() => {
    return buildWorkspaceTree(spacesDto, tasksDto, { includeArchived: false });
  }, [spacesDto, tasksDto]);

  const pinnedRows = useMemo(() => collectPinnedRows(tree, tasks), [tree, tasks]);
  const pinnedTaskIdSet = useMemo(() => new Set(pinnedRows.map((row) => row.task.id)), [pinnedRows]);
  const [gatewayGroupsClosed, setGatewayGroupsClosed] = useState<Partial<Record<GatewaySidebarChannelId, boolean>>>({});

  const getParentChildren = useCallback(
    (parentId: string | null): WorkspaceTreeNode[] => {
      if (parentId == null) return treeAll;
      const node = findWorkspaceNode(treeAll, parentId);
      return node?.children ?? [];
    },
    [treeAll],
  );

  const visibleRows = useMemo((): VisibleRow[] => {
    let tasksById: Map<string, Task> | undefined;
    const rows: VisibleRow[] = [];
    // 默认全部收起：只有用户显式展开过（expandedSpaceIds）的空间才展开
    const expandedSet = new Set(expandedSpaceIds);
    const walk = (nodes: WorkspaceTreeNode[], depth: number): void => {
      for (const n of nodes) {
        if (n.kind === "space") {
          const space = spaces.find((s) => s.id === n.id);
          if (!space) continue;
          const collapsed = !searchTerm && !expandedSet.has(n.id);
          const requests = foregroundRequests.filter(request => request.spaceId === n.id &&
            (!searchTerm || matchesForegroundSearch(request, searchTerm, taskFilterStatus, taskFilterTime)))
            .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
          const conversations = foregroundConversations.filter(conversation => conversation.spaceId === n.id);
          const hasChildren = n.children.length > 0 || conversations.length > 0;
          const start = rows.length;
          rows.push({ key: `space-${n.id}`, kind: "space", space, depth, collapsed, node: n, hasChildren });
          if (!collapsed) {
            for (const conversation of conversations) {
              const items = requests.filter(request => request.conversationId === conversation.conversationId);
              if (searchTerm && items.length === 0) continue;
              const expanded = Boolean(searchTerm || expandedConversations[conversation.conversationId]);
              rows.push({key:`conversation-${conversation.conversationId}`,kind:"conversation",conversation,depth:depth+1,expanded,count:items.length});
              if (!expanded) continue;
              const limit = foregroundLimits[conversation.conversationId] ?? 20;
              for (const request of items.slice(0,limit)) rows.push({key:request.id,kind:"foreground",request,depth:depth+2});
              if (items.length>limit) rows.push({key:`more-${conversation.conversationId}`,kind:"foreground-more",spaceId:conversation.conversationId,remaining:items.length-limit,depth:depth+2});
            }
            if (n.children.length) walk(n.children, depth + 1);
          }
          if (searchTerm && rows.length === start + 1) rows.pop();
        } else {
          if (searchTerm && pinnedTaskIdSet.has(n.id)) continue;
          if (!tasksById) {
            tasksById = new Map<string, Task>();
            for (const task of tasks) if (!tasksById.has(task.id)) tasksById.set(task.id, task);
          }
          const task = tasksById.get(n.id);
          if (!task) continue;
          rows.push({ key: `task-${n.id}`, kind: "task", task, depth, node: n });
        }
      }
    };
    walk(tree, 0);
    return rows;
  }, [tree, spaces, tasks, expandedSpaceIds, foregroundRequests, foregroundConversations, foregroundLimits, expandedConversations,
    pinnedTaskIdSet, searchTerm, taskFilterStatus, taskFilterTime]);

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

  const spaceMenuAnchorRef = useRef<HTMLDivElement>(null);
  const spaceAddMenuAnchorRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);

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

  useDismissOnClickOutside(spaceMenuId !== null, () => setSpaceMenuId(null), spaceMenuAnchorRef);
  useDismissOnClickOutside(spaceAddMenuId !== null, () => setSpaceAddMenuId(null), spaceAddMenuAnchorRef);
  useEffect(() => {
    if (sidebarCollapsed) setFilterOpen(false);
  }, [sidebarCollapsed]);

  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const rememberScroll = useDesktopSectionScroll(sidebarScrollRef, "tasks:tree");
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
  const isFiltered = Boolean(searchTerm) || taskFilterStatus !== "all" || taskFilterTime !== "all";

  const handleRowDragStart = (e: React.DragEvent, row: TreeRow): void => {
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

  const handleRowDragOver = (e: React.DragEvent, row: TreeRow): void => {
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

  const handleRowDragLeave = (e: React.DragEvent, row: TreeRow): void => {
    const targetId = row.kind === "space" ? row.space.id : row.task.id;
    if (dropTarget?.id === targetId) {
      const related = e.relatedTarget as Node | null;
      if (related && (e.currentTarget as HTMLElement).contains(related)) return;
      setDropTarget(null);
    }
  };

  const handleRowDrop = async (e: React.DragEvent, targetRow: TreeRow): Promise<void> => {
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
    if (row.kind === "conversation") return <button type="button" className="workspace-conversation-row" data-conversation-id={row.conversation.conversationId} aria-expanded={row.expanded} style={{paddingLeft:taskIndent(row.depth)}} title={`${row.conversation.title} · ${row.conversation.conversationId}`} onClick={()=>setExpandedConversations(current=>({...current,[row.conversation.conversationId]:!row.expanded}))}><span aria-hidden="true">{row.expanded ? '▾' : '▸'}</span><span>{row.conversation.title}</span><small>{row.conversation.archived ? '历史 · ' : ''}{row.count}</small></button>;
    if (row.kind === "foreground-more") return <button type="button" className="workspace-foreground-row" style={{ paddingLeft: taskIndent(row.depth) }} onClick={() => setForegroundLimits(current => ({ ...current, [row.spaceId]: (current[row.spaceId] ?? 20) + 30 }))}>再看 30 条前台任务 · 还有 {row.remaining} 条</button>;
    if (row.kind === "foreground") return <button type="button" className="workspace-foreground-row" style={{ paddingLeft: taskIndent(row.depth) }} title={row.request.title} onClick={() => { openWorkspaceRequest(row.request); onClose?.(); }}>
      <IconMessageDashed size={14} /><span className="workspace-foreground-title">{row.request.title}</span>
      <TaskStatusIndicator status={FOREGROUND_TASK_STATUS[row.request.status]} label={foregroundStatus(row.request.status)} />
    </button>;
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
            style={{ paddingLeft: taskIndent(depth) }}
            onDragOver={(e) => handleRowDragOver(e, row)}
            onDragLeave={(e) => handleRowDragLeave(e, row)}
            onDrop={(e) => void handleRowDrop(e, row)}
            onDragEnd={handleDragEnd}
          >
            <span className="space-icon"><WorkspaceIcon icon={space.icon} size={14} /></span>
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
          <span className="space-entry-icons">
            {hasChildren && (
              <button type="button" className="space-chevron" disabled={Boolean(searchTerm)} aria-expanded={!collapsed} aria-label={`${collapsed ? "展开" : "收起"}${space.name}`}
                onClick={(e) => { e.stopPropagation(); toggleSpaceCollapsed(space.id); }} onKeyDown={(e) => e.stopPropagation()}>
                {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
              </button>
            )}
            <span className="space-icon"><WorkspaceIcon icon={space.icon} open={!collapsed} size={14} /></span>
          </span>
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

  const actions = <button ref={filterButtonRef} type="button" className={`icon-btn task-filter-toggle ${filterOpen ? "toggled" : ""}`}
    title="筛选" aria-label={isFiltered ? "筛选任务，筛选条件已启用" : "筛选任务"}
    aria-expanded={filterOpen} aria-controls={filterOpen ? "task-sidebar-filters" : undefined}
    onClick={() => { setSpaceMenuId(null); setSpaceAddMenuId(null); setFilterOpen(open => !open); }}>
    <IconFilter size={15} />
    {isFiltered && <span className="task-filter-dot" aria-hidden="true" />}
  </button>;

  const createRootWorkspace = (): void => {
    setCreateWorkspaceParentId(null);
    setCreateWorkspaceOpen(true);
  };

  const body = (
    <div className="sidebar desktop-task-tree">
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
      {filterOpen && <TaskFilterControls query={searchQuery} onQueryChange={(value) => {
        setSearchQuery(value);
        sidebarScrollRef.current?.scrollTo({ top: 0 });
      }} onClose={() => {
        setFilterOpen(false);
        filterButtonRef.current?.focus();
      }} />}

      {(() => {
        const unpinnedRootTasks = visibleRows.filter((r): r is Extract<VisibleRow, { kind: "task" }> =>
          r.kind === "task" && r.task.spaceId == null && !pinnedTaskIdSet.has(r.task.id));
        const independentRows = unpinnedRootTasks.filter((row) => !row.task.gatewaySidebarChannelId);
        const gatewayGroups = new Map<GatewaySidebarChannelId, typeof unpinnedRootTasks>();
        for (const row of unpinnedRootTasks) {
          const id = row.task.gatewaySidebarChannelId;
          if (!id) continue;
          const rows = gatewayGroups.get(id) ?? [];
          rows.push(row);
          gatewayGroups.set(id, rows);
        }
        const workspaceRows = visibleRows.filter((r) => !(r.kind === "task" && (r.task.spaceId == null || pinnedTaskIdSet.has(r.task.id))));
        // 计数与下面看得见的行一致。置顶任务已经抽到顶部，不重复计入这两个数。
        const independentTaskCount = independentRows.length;
        const workspaceTaskCount = searchTerm ? workspaceRows.filter(row => row.kind === "task" || row.kind === "foreground").length :
          tasksDto.filter((t) => t.spaceId != null && !t.isFavorited).length + foregroundRequests.filter(request => spaces.some(space => space.id === request.spaceId && !space.effectiveArchived && !space.archived)).length;
        return (
          <div className="sidebar-scroll" ref={sidebarScrollRef} onScroll={rememberScroll} onDragOver={handleRootDragOver} onDrop={handleRootDrop}>
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
            {independentRows.length > 0 && (
              <>
                <div className="sidebar-tree-header">
                  <span className="section-title">独立任务</span>
                  {independentTaskCount > 0 && <span className="sidebar-section-count">{independentTaskCount}</span>}
                </div>
                <div className="sidebar-section-list">
                  {independentRows.map((row) => <div key={row.key}>{renderRow(row)}</div>)}
                </div>
              </>
            )}
            {gatewayGroups.size > 0 && (
              <section aria-label="网关助理">
                <div className="sidebar-tree-header sidebar-tree-header--spaced">
                  <span className="section-title">网关助理</span>
                  <span className="sidebar-section-count">{unpinnedRootTasks.length - independentRows.length}</span>
                </div>
                <div className="sidebar-section-list">
                  {(Object.keys(GATEWAY_SIDEBAR_CHANNELS) as GatewaySidebarChannelId[]).map((id) => {
                    const rows = gatewayGroups.get(id);
                    if (!rows?.length) return null;
                    const closed = !searchTerm && Boolean(gatewayGroupsClosed[id]);
                    return <div key={id} data-gateway-channel={id}>
                      <button type="button" className="workspace-conversation-row" aria-expanded={!closed}
                        style={{ paddingLeft: taskIndent(0) }}
                        onClick={() => setGatewayGroupsClosed(current => ({ ...current, [id]: !closed }))}>
                        <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          {closed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                          <IconFolder size={14} />
                        </span>
                        <span>{GATEWAY_SIDEBAR_CHANNELS[id]}</span><small>{rows.length}</small>
                      </button>
                      {!closed && rows.map(({ key, task }) => <div key={key}>
                        <TaskItem task={task} nested indent={taskIndent(1)} />
                      </div>)}
                    </div>;
                  })}
                </div>
              </section>
            )}
            {isFiltered && !pinnedRows.length && !independentRows.length && !gatewayGroups.size && !workspaceTaskCount && (
              <div className="sidebar-empty" role="status">没有符合筛选条件的任务</div>
            )}
            {(!searchTerm || workspaceRows.length > 0 || foregroundError) && (
              <>
                <div className="sidebar-tree-header sidebar-tree-header--spaced">
                  <span className="section-title">工作空间</span>
                  {workspaceTaskCount > 0 && <span className="sidebar-section-count">{workspaceTaskCount}</span>}
                  {workspaceRows.length > 0 && (
                    <button type="button" className="sidebar-section-add" title="新建工作空间" aria-label="新建工作空间" onClick={createRootWorkspace}>
                      <IconPlus size={13} strokeWidth={2} />
                    </button>
                  )}
                </div>
                <div className="sidebar-section-list">
                  {foregroundError && <p className="bot-alert" role="status">前台任务加载失败：{foregroundError}</p>}
                  {!searchTerm && workspaceRows.length === 0 ? (
                    <div className="sidebar-workspace-actions">
                      <DesktopSectionRow icon={<IconFolder size={14} />} onClick={createRootWorkspace}>新建工作空间</DesktopSectionRow>
                      <DesktopSectionRow icon={<IconLink size={14} />} onClick={() => void openLocalFolder()}>绑定本地文件夹</DesktopSectionRow>
                    </div>
                  ) : workspaceRows.map((row) => <div key={row.key}>{renderRow(row)}</div>)}
                </div>
              </>
            )}
            <div className="sidebar-root-dropzone" style={{ height: 24 }} onDragOver={handleRootDragOver} onDrop={handleRootDrop} />
          </div>
        );
      })()}

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
    </div>
  );
  if (!desktop) return <aside className="sidebar"><div className="sidebar-header">{actions}</div>{body}</aside>;
  return <DesktopSectionSidebar title="MyBuddy" actions={actions} ownScroll>{body}</DesktopSectionSidebar>;
}
