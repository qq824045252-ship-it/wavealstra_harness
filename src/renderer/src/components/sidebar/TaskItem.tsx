import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isGatewayConversation } from "../../../../shared/gateway-task";
import { createPortal } from "react-dom";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { relativeTime, useAppStore } from "@/store/appStore";
import { deriveTaskStatus, isTaskDoneUnread, taskActionLabel } from "@/utils/taskFilters";
import type { Task } from "@/types";
import {
  IconArchive,
  IconFolder,
  IconFolderKanban,
  IconMore,
  IconPencil,
  IconPin,
  IconSparkles,
} from "@/components/common/icons";
import WelcomeModeIcon from "@/components/common/WelcomeModeIcon";
import TaskStatusIndicator from "./TaskStatusIndicator";
import { layoutRect, layoutViewportSize, placeFixedMenu } from "@/lib/placeFixedMenu";
import {
  fileNameFromPath,
  isFileLikeDrag,
  isTaskDrag,
  notifyWorkspaceFilesChanged,
  pathsFromWorkspaceDrop,
} from "@/lib/workspaceFileDrag";

interface Props {
  task: Task;
  /** 空间内任务：标题与空间文件夹名称左对齐 */
  nested?: boolean;
  /** 树内缩进（px），由 Sidebar 按 depth 计算，使任务图标与下一级空间文件夹图标对齐 */
  indent?: number;
  /** Tree V2：通知 Sidebar 拖拽开始（用于稳定 DnD 状态，不改变原有文件拖拽逻辑） */
  onDragStartNotify?: (taskId: string) => void;
}

const MENU_MIN_WIDTH = 200;
const MENU_MAX_HEIGHT = 420;

export default function TaskItem({ task, nested = false, indent, onDragStartNotify }: Props): React.JSX.Element {
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const page = useAppStore((s) => s.page);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const pinnedTaskIds = useAppStore((s) => s.pinnedTaskIds);
  const setActiveTask = useAppStore((s) => s.setActiveTask);
  const deleteTask = useAppStore((s) => s.deleteTask);
  const renameTask = useAppStore((s) => s.renameTask);
  const togglePinTask = useAppStore((s) => s.togglePinTask);
  const archiveTask = useAppStore((s) => s.archiveTask);
  const openWorkspaceFolder = useAppStore((s) => s.openWorkspaceFolder);
  const spaces = useAppStore((s) => s.spaces);
  const projectName = useAppStore((s) =>
    task.projectId ? s.projects.find((project) => project.id === task.projectId)?.name : undefined,
  );
  const experts = useAppStore((s) => s.experts);

  const folderPath =
    task.cwd?.trim() ||
    spaces.find((s) => s.id === task.spaceId)?.path?.trim() ||
    "";

  const [menuRequested, setMenuOpen] = useState(false);
  const menuOpen = menuRequested && !sidebarCollapsed;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [aiTitleBusy, setAiTitleBusy] = useState(false);
  const [aiTitleNotice, setAiTitleNotice] = useState<string | null>(null);
  const [fileDropOver, setFileDropOver] = useState(false);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const dropNoticeTimer = useRef<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; maxHeight: number } | null>(
    null,
  );
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const menuPortalRef = useRef<HTMLDivElement>(null);
  const menuRevision = useRef(0);

  const closeMenu = useCallback((): void => {
    menuRevision.current++;
    setMenuOpen(false);
    setAiTitleNotice(null);
    setMenuPos(null);
  }, []);

  useBlockNativeSurfaces(menuOpen);
  useDismissOnClickOutside(menuOpen, closeMenu, menuAnchorRef, [menuPortalRef]);
  useLayoutEffect(() => {
    if (sidebarCollapsed && menuRequested) closeMenu();
  }, [sidebarCollapsed, menuRequested, closeMenu]);

  const active = page === "chat" && task.id === activeTaskId;
  const actionLabel = taskActionLabel(task);
  const status = deriveTaskStatus(task, actionLabel);
  const doneUnread = isTaskDoneUnread(task, status);
  const ackTaskDone = useAppStore((s) => s.ackTaskDone);

  // 正看着它跑完 → 不需要再让用户点一次。仅当它是当前打开的任务、停在聊天页、
  // 且窗口在前台时自动确认；在后台跑完则保留未读强调。
  useEffect(() => {
    if (!doneUnread || !active) return;
    if (typeof document !== "undefined") {
      if (document.visibilityState !== "visible") return;
      if (typeof document.hasFocus === "function" && !document.hasFocus()) return;
    }
    void ackTaskDone(task.id);
  }, [doneUnread, active, task.id, ackTaskDone]);
  // Phase 2：pin 以 DB isFavorited 为真相（pinnedTaskIds 仅过渡兼容）
  const pinned = Boolean(task.isFavorited) || pinnedTaskIds.includes(task.id);
  const expertSnapshot = task.expertBinding?.desired ?? (task.expertBinding?.pending ? task.expertBinding.active : null);
  const taskExpert = expertSnapshot ? { name: expertSnapshot.name, emoji: experts.find((e) => e.id === expertSnapshot.sourceExpertId)?.emoji } : task.expertId ? experts.find((e) => e.id === task.expertId) ?? { name: task.expertId, emoji: undefined } : undefined;

  const syncMenuPos = (): void => {
    const anchor = menuAnchorRef.current;
    if (!anchor) return;
    const el = menuPortalRef.current;
    // Include borders and use the real natural height; a minimum estimate leaves
    // short menus floating away from the trigger when placement flips upward.
    const measuredHeight = el ? el.scrollHeight + el.offsetHeight - el.clientHeight : 0;
    const placed = placeFixedMenu({
      anchor: layoutRect(anchor),
      // scrollHeight 是内容自然高度，不受当前 maxHeight 压缩
      menuWidth: Math.max(el?.offsetWidth ?? 0, MENU_MIN_WIDTH),
      menuHeight: measuredHeight > 0 ? measuredHeight : 220,
      viewport: layoutViewportSize(),
      minWidth: MENU_MIN_WIDTH,
      maxHeight: MENU_MAX_HEIGHT,
      align: "end",
    });
    setMenuPos({ top: placed.top, left: placed.left, maxHeight: placed.maxHeight });
  };

  useLayoutEffect(() => {
    if (!menuOpen) return;
    syncMenuPos();
    // 子菜单展开后高度变化，再校准一次
    const raf = requestAnimationFrame(() => syncMenuPos());
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, aiTitleNotice]);

  useEffect(() => {
    if (!menuOpen) return;

    const onResize = (): void => syncMenuPos();
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);

    // 只监听侧栏列表滚动，不挂 window capture（否则菜单内部滚动/布局抖动会误关）
    const scrollRoot =
      menuAnchorRef.current?.closest(".sidebar-scroll") ??
      (document.querySelector(".sidebar-scroll") as HTMLElement | null);
    scrollRoot?.addEventListener("scroll", closeMenu, { passive: true });

    return () => {
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
      scrollRoot?.removeEventListener("scroll", closeMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, closeMenu]);

  const commitRename = (): void => {
    if (draft.trim()) renameTask(task.id, draft.trim());
    setEditing(false);
  };

  /** AI 命名：模型读对话开头约 1024 token 生成任务名，填入重命名输入框由用户确认。 */
  const renameTaskWithAi = async (): Promise<void> => {
    const revision = menuRevision.current;
    setAiTitleBusy(true);
    setAiTitleNotice(null);
    try {
      const suggestion = await window.api?.agent?.generateTaskTitle?.(task.id);
      if (revision !== menuRevision.current) return;
      const title = suggestion?.title?.trim();
      if (!title) throw new Error("模型没有返回任务名");
      setDraft(title);
      closeMenu();
      setEditing(true);
    } catch (error) {
      if (revision === menuRevision.current) {
        setAiTitleNotice(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setAiTitleBusy(false);
    }
  };

  const flashDropNotice = (text: string): void => {
    setDropNotice(text);
    if (dropNoticeTimer.current) window.clearTimeout(dropNoticeTimer.current);
    dropNoticeTimer.current = window.setTimeout(() => {
      setDropNotice(null);
      dropNoticeTimer.current = null;
    }, 2200);
  };

  useEffect(() => {
    return () => {
      if (dropNoticeTimer.current) window.clearTimeout(dropNoticeTimer.current);
    };
  }, []);

  const acceptFileDrop = (event: React.DragEvent): void => {
    if (editing || isTaskDrag(event.dataTransfer.types)) return;
    if (!isFileLikeDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setFileDropOver(true);
  };

  const handleFileDrop = (event: React.DragEvent): void => {
    if (editing || isTaskDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    setFileDropOver(false);
    const paths = pathsFromWorkspaceDrop(event);
    if (!paths.length) return;
    void (async () => {
      const result = await window.api?.copyIntoTaskWorkspace?.(task.id, paths);
      if (!result?.ok) {
        flashDropNotice(result?.error || "复制失败");
        return;
      }
      const copied = result.items.filter((item) => !item.alreadyThere);
      const same = result.items.length - copied.length;
      if (copied.length && same) {
        flashDropNotice(`已复制 ${copied.length} 项（${same} 项已在该任务）`);
      } else if (copied.length === 1) {
        flashDropNotice(`已复制「${fileNameFromPath(copied[0]!.source)}」`);
      } else if (copied.length > 1) {
        flashDropNotice(`已复制 ${copied.length} 项`);
      } else {
        flashDropNotice("该任务已使用同一工作区");
      }
      if (copied.length && activeTaskId === task.id) {
        notifyWorkspaceFilesChanged();
      }
    })();
  };

  const menuContent = menuOpen ? (
    <div
      ref={menuPortalRef}
      className="task-context-menu task-context-menu-portal"
      style={
        menuPos
          ? {
              top: menuPos.top,
              left: menuPos.left,
              maxHeight: menuPos.maxHeight,
            }
          : { visibility: "hidden", top: 0, left: 0 }
      }
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="task-context-item"
        title={folderPath || "当前任务未绑定工作区文件夹"}
        disabled={!folderPath}
        onClick={() => {
          closeMenu();
          void openWorkspaceFolder(undefined, task.id);
        }}
      >
        <IconFolder size={14} /> 打开文件夹
      </button>
      <button
        type="button"
        className="task-context-item"
        onClick={() => {
          closeMenu();
          setDraft(task.title);
          setEditing(true);
        }}
      >
        <IconPencil size={14} /> 重命名
      </button>
      <button
        type="button"
        className="task-context-item"
        disabled={aiTitleBusy}
        title="AI 读取对话开头约 1024 token，生成新的任务名"
        onClick={() => void renameTaskWithAi()}
      >
        <IconSparkles size={14} /> {aiTitleBusy ? "AI 重命名（生成中…）" : "AI 重命名"}
      </button>
      {aiTitleNotice && <div className="task-context-notice">{aiTitleNotice}</div>}
      <div className="task-context-sep" />
      <button
        type="button"
        className="task-context-item danger"
        onClick={() => {
          closeMenu();
          deleteTask(task.id);
        }}
      >
        删除任务
      </button>
    </div>
  ) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      className={`task-item ${nested ? "nested" : ""} ${active ? "active" : ""} ${pinned ? "pinned" : ""} ${menuOpen ? "menu-open" : ""} status-${status}${fileDropOver ? " file-drop-target" : ""}${dropNotice ? " has-drop-notice" : ""}`}
      style={indent != null ? { paddingLeft: indent } : undefined}
      title={editing ? undefined : `${task.title || "未命名任务"} · ${relativeTime(task.updatedAt)}`}
      onClick={() => !editing && setActiveTask(task.id)}
      onKeyDown={(e) => e.key === "Enter" && !editing && setActiveTask(task.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (editing) return;
        setMenuOpen(true);
      }}
      draggable={!editing && !isGatewayConversation(task.id)}
      onDragStart={(e) => {
        if (isGatewayConversation(task.id)) { e.preventDefault(); return; }
        e.dataTransfer.setData("application/x-mybuddy-task", task.id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.title);
        onDragStartNotify?.(task.id);
      }}
      onDragEnter={acceptFileDrop}
      onDragOver={acceptFileDrop}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setFileDropOver(false);
      }}
      onDrop={handleFileDrop}
    >
      <WelcomeModeIcon mode={task.welcomeMode} size={13} className="task-mode-icon" />
      {task.projectId && (
        <span className="task-project-mark" title={projectName ? `项目：${projectName}` : "项目任务"}>
          <IconFolderKanban size={12} />
        </span>
      )}

      {editing ? (
        <input
          className="task-item-edit"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraft(task.title);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="task-item-title">{task.title}</span>
      )}

      <div className="task-item-meta">
        {taskExpert && (
          <span className="task-expert-badge" title={`专家：${taskExpert.name}`}>
            {taskExpert.emoji || "🧙"}
          </span>
        )}
        {pinned && (
          <span className="task-pin-badge" title="已置顶">
            <IconPin size={11} fill="currentColor" strokeWidth={1.6} />
          </span>
        )}
        <span className="task-item-time">{relativeTime(task.updatedAt, { compact: true })}</span>
      </div>

      <TaskStatusIndicator status={status} label={actionLabel ?? undefined} unread={doneUnread} />

      <div className="task-item-actions">
        <div className="task-menu-anchor" ref={menuAnchorRef}>
          <button
            type="button"
            className="task-item-action"
            title="更多"
            aria-expanded={menuOpen}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (menuOpen) {
                closeMenu();
              } else {
                setAiTitleNotice(null);
                setMenuOpen(true);
              }
            }}
          >
            <IconMore size={13} />
          </button>
        </div>
        <button
          type="button"
          className="task-item-action"
          title="归档"
          onClick={(e) => {
            e.stopPropagation();
            void archiveTask(task.id);
          }}
        >
          <IconArchive size={13} />
        </button>
        <button
          type="button"
          className={`task-item-action task-item-action-pin ${pinned ? "is-pinned" : ""}`}
          title={pinned ? "取消置顶" : "置顶"}
          aria-pressed={pinned}
          onClick={(e) => {
            e.stopPropagation();
            togglePinTask(task.id);
          }}
        >
          <IconPin size={13} fill={pinned ? "currentColor" : "none"} strokeWidth={1.7} />
        </button>
      </div>

      {dropNotice && <span className="task-drop-notice">{dropNotice}</span>}
      {menuContent && createPortal(menuContent, document.body)}
    </div>
  );
}
