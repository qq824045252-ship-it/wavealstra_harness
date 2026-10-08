import { DEFAULT_WELCOME_MODE } from "@shared/mode-profile";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { relativeTime, useAppStore } from "@/store/appStore";
import { getWorkspaceDisplayPath } from "@/lib/workspaceDisplay";
import { getTaskDisplayStatus, hasPendingConversationInteraction } from "@/utils/taskFilters";
import type { Task } from "@/types";
import {
  IconArchive,
  IconCheck,
  IconChevronRight,
  IconFolder,
  IconFolderKanban,
  IconMore,
  IconPencil,
  IconPin,
  IconShare,
  IconSparkles,
} from "@/components/common/icons";
import WelcomeModeIcon from "@/components/common/WelcomeModeIcon";
import { ExpertBindingModal } from "@/components/hub/ExpertBindingModal";
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
  /** Tree V2：通知 Sidebar 拖拽开始（用于稳定 DnD 状态，不改变原有文件拖拽逻辑） */
  onDragStartNotify?: (taskId: string) => void;
}

type SubMenu = null | "space" | "share" | "review";

const MENU_MIN_WIDTH = 200;
const MENU_MAX_HEIGHT = 420;

export default function TaskItem({ task, nested = false, onDragStartNotify }: Props): React.JSX.Element {
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const page = useAppStore((s) => s.page);
  const pinnedTaskIds = useAppStore((s) => s.pinnedTaskIds);
  const setActiveTask = useAppStore((s) => s.setActiveTask);
  const deleteTask = useAppStore((s) => s.deleteTask);
  const renameTask = useAppStore((s) => s.renameTask);
  const togglePinTask = useAppStore((s) => s.togglePinTask);
  const archiveTask = useAppStore((s) => s.archiveTask);
  const duplicateTaskWithMode = useAppStore((s) => s.duplicateTaskWithMode);
  const createRelatedTask = useAppStore((s) => s.createRelatedTask);
  const setPage = useAppStore((s) => s.setPage);
  const openWorkspaceFolder = useAppStore((s) => s.openWorkspaceFolder);
  const bindTaskSpace = useAppStore((s) => s.bindTaskSpace);
  const shareTaskToConversation = useAppStore((s) => s.shareTaskToConversation);
  const openLocalFolder = useAppStore((s) => s.openLocalFolder);
  const addSpace = useAppStore((s) => s.addSpace);
  const spaces = useAppStore((s) => s.spaces);
  const projectName = useAppStore((s) =>
    task.projectId ? s.projects.find((project) => project.id === task.projectId)?.name : undefined,
  );
  const tasks = useAppStore((s) => s.tasks);
  const experts = useAppStore((s) => s.experts);

  const folderPath =
    task.cwd?.trim() ||
    spaces.find((s) => s.id === task.spaceId)?.path?.trim() ||
    "";

  const [menuOpen, setMenuOpen] = useState(false);
  const [expertManagerOpen, setExpertManagerOpen] = useState(false);
  const [subMenu, setSubMenu] = useState<SubMenu>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [relatedNotice, setRelatedNotice] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [fileDropOver, setFileDropOver] = useState(false);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const dropNoticeTimer = useRef<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; maxHeight: number } | null>(
    null,
  );
  /** 打开后短暂延迟再响应「点外侧关闭」，避免打开当次 pointer 事件误关 */
  const [dismissArmed, setDismissArmed] = useState(false);
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const menuPortalRef = useRef<HTMLDivElement>(null);

  useDismissOnClickOutside(
    menuOpen && dismissArmed,
    () => {
      setMenuOpen(false);
      setSubMenu(null);
      setShareNotice(null);
      setMenuPos(null);
      setDismissArmed(false);
    },
    menuAnchorRef,
    [menuPortalRef],
  );

  const active = page === "chat" && task.id === activeTaskId;
  const displayStatus = getTaskDisplayStatus(task);
  const awaitingInput = hasPendingConversationInteraction(task);
  // Phase 2：pin 以 DB isFavorited 为真相（pinnedTaskIds 仅过渡兼容）
  const pinned = Boolean(task.isFavorited) || pinnedTaskIds.includes(task.id);
  const expertSnapshot = task.expertBinding?.desired ?? (task.expertBinding?.pending ? task.expertBinding.active : null);
  const taskExpert = expertSnapshot ? { name: expertSnapshot.name, emoji: experts.find((e) => e.id === expertSnapshot.sourceExpertId)?.emoji } : task.expertId ? experts.find((e) => e.id === task.expertId) ?? { name: task.expertId, emoji: undefined } : undefined;

  const visibleSpaces = useMemo(
    () => spaces.filter((s) => !(s.effectiveArchived ?? s.archived)).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    [spaces],
  );

  const shareTargets = useMemo(
    () =>
      tasks
        .filter((t) => !t.archived && t.id !== task.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 40),
    [tasks, task.id],
  );

  const reviewExperts = useMemo(
    () =>
      experts
        .filter((e) => e.installed !== false && e.enabled !== false)
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    [experts],
  );

  const syncMenuPos = (): void => {
    const anchor = menuAnchorRef.current;
    if (!anchor) return;
    const el = menuPortalRef.current;
    const placed = placeFixedMenu({
      anchor: layoutRect(anchor),
      // scrollHeight 是内容自然高度，不受当前 maxHeight 压缩
      menuWidth: Math.max(el?.offsetWidth ?? 0, MENU_MIN_WIDTH),
      menuHeight: Math.max(el?.scrollHeight ?? 0, 220),
      viewport: layoutViewportSize(),
      minWidth: MENU_MIN_WIDTH,
      maxHeight: MENU_MAX_HEIGHT,
      align: "end",
    });
    setMenuPos({ top: placed.top, left: placed.left, maxHeight: placed.maxHeight });
  };

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    syncMenuPos();
    // 子菜单展开后高度变化，再校准一次
    const raf = requestAnimationFrame(() => syncMenuPos());
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    menuOpen,
    subMenu,
    relatedNotice,
    shareNotice,
    visibleSpaces.length,
    shareTargets.length,
    reviewExperts.length,
  ]);

  useEffect(() => {
    if (!menuOpen) {
      setDismissArmed(false);
      return;
    }
    // 等当前 pointer/click 序列结束后再允许「点外侧关闭」
    const armTimer = window.setTimeout(() => setDismissArmed(true), 0);

    const onResize = (): void => syncMenuPos();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);

    // 只监听侧栏列表滚动，不挂 window capture（否则菜单内部滚动/布局抖动会误关）
    const scrollRoot =
      menuAnchorRef.current?.closest(".sidebar-scroll") ??
      (document.querySelector(".sidebar-scroll") as HTMLElement | null);
    const onSidebarScroll = (): void => {
      setMenuOpen(false);
      setSubMenu(null);
      setShareNotice(null);
      setMenuPos(null);
      setDismissArmed(false);
    };
    scrollRoot?.addEventListener("scroll", onSidebarScroll, { passive: true });

    return () => {
      window.clearTimeout(armTimer);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
      scrollRoot?.removeEventListener("scroll", onSidebarScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  const commitRename = (): void => {
    if (draft.trim()) renameTask(task.id, draft.trim());
    setEditing(false);
  };

  const closeMenu = (): void => {
    setMenuOpen(false);
    setSubMenu(null);
    setShareNotice(null);
    setMenuPos(null);
    setDismissArmed(false);
  };

  const saveToSpace = (spaceId: string | null): void => {
    bindTaskSpace(task.id, spaceId);
    closeMenu();
  };

  const startExpertReview = (expertId: string, expertName: string): void => {
    setRelatedNotice(null);
    void createRelatedTask({
      sourceTaskId: task.id,
      welcomeMode: task.welcomeMode ?? DEFAULT_WELCOME_MODE,
      modePresetId: task.modePresetId ?? undefined,
      expertId,
      title: `评审：${task.title}`,
      instruction:
        "请以你的专业视角评审引用任务所完成的工作：独立阅读上下文、产物与结论，不要假设原实现正确；" +
        "按严重程度输出结构化问题清单与总体结论。默认只读，不擅自修改。",
    }).then((id) => {
      if (!id) {
        setRelatedNotice(`未能召唤「${expertName}」，请先到「专家中心」确认已安装`);
        setMenuOpen(true);
      } else {
        closeMenu();
      }
    });
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

  const shareToTask = async (targetId: string): Promise<void> => {
    setShareBusy(true);
    setShareNotice(null);
    try {
      const ok = await shareTaskToConversation(task.id, targetId);
      if (!ok) {
        setShareNotice("分享失败：目标任务不可用");
        return;
      }
      closeMenu();
    } catch (err) {
      console.warn("[TaskItem] share failed", err);
      setShareNotice("分享失败，请稍后重试");
    } finally {
      setShareBusy(false);
    }
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
      <div className={`task-context-item-wrap ${subMenu === "space" ? "open" : ""}`}>
        <button
          type="button"
          className={`task-context-item has-sub ${subMenu === "space" ? "active" : ""}`}
          onClick={() => setSubMenu((prev) => (prev === "space" ? null : "space"))}
        >
          <IconFolder size={14} />
          <span className="task-context-item-label">{task.spaceId ? `更改工作空间` : "保存到工作空间"}</span>
          <IconChevronRight size={14} className="task-context-chevron" />
        </button>
        {subMenu === "space" && (
          <div className="task-context-submenu">
            {!task.spaceId ? (
              <>
                <button
                  type="button"
                  className="task-context-item active"
                  onClick={() => saveToSpace(null)}
                >
                  <span className="task-context-none">—</span>
                  <span className="task-context-item-label">独立任务</span>
                  <IconCheck size={14} />
                </button>
                {visibleSpaces.map((space) => (
                  <button
                    key={space.id}
                    type="button"
                    className="task-context-item"
                    title={getWorkspaceDisplayPath(spaces as any, space.id)}
                    onClick={() => saveToSpace(space.id)}
                  >
                    <IconFolder size={14} />
                    <span className="task-context-item-label">{getWorkspaceDisplayPath(spaces as any, space.id)}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                {visibleSpaces.map((space) => (
                  <button
                    key={space.id}
                    type="button"
                    className={`task-context-item ${task.spaceId === space.id ? "active" : ""}`}
                    title={getWorkspaceDisplayPath(spaces as any, space.id)}
                    onClick={() => saveToSpace(space.id)}
                  >
                    <IconFolder size={14} />
                    <span className="task-context-item-label">{getWorkspaceDisplayPath(spaces as any, space.id)}</span>
                    {task.spaceId === space.id && <IconCheck size={14} />}
                  </button>
                ))}
                <div className="task-context-sep" />
                <button type="button" className="task-context-item" onClick={() => saveToSpace(null)}>移出工作空间</button>
              </>
            )}
            {visibleSpaces.length === 0 && (
              <div className="task-context-empty">暂无工作空间</div>
            )}
            <div className="task-context-sep" />
            <button
              type="button"
              className="task-context-item"
              onClick={() => {
                void addSpace().then((id) => {
                  if (id) bindTaskSpace(task.id, id);
                  closeMenu();
                });
              }}
            >
              新建工作空间
            </button>
            <button
              type="button"
              className="task-context-item"
              onClick={() => {
                closeMenu();
                if (useAppStore.getState().activeTaskId !== task.id) {
                  setActiveTask(task.id);
                }
                void openLocalFolder();
              }}
            >
              <IconFolder size={14} /> 打开本地文件夹
            </button>
          </div>
        )}
      </div>
      <div className="task-context-sep" />
      <div className={`task-context-item-wrap ${subMenu === "review" ? "open" : ""}`}>
        <button
          type="button"
          className={`task-context-item has-sub ${subMenu === "review" ? "active" : ""}`}
          onClick={() => {
            setRelatedNotice(null);
            setSubMenu((prev) => (prev === "review" ? null : "review"));
          }}
        >
          <IconSparkles size={14} />
          <span className="task-context-item-label">以专家评审此任务</span>
          <IconChevronRight size={14} className="task-context-chevron" />
        </button>
        {subMenu === "review" && (
          <div className="task-context-submenu">
            <div className="task-context-submenu-title">选择专家</div>
            {reviewExperts.length === 0 ? (
              <div className="task-context-empty">暂无已安装专家</div>
            ) : (
              <>
                {reviewExperts.map((expert) => (
                  <button
                    key={expert.id}
                    type="button"
                    className="task-context-item"
                    title={expert.description || expert.name}
                    onClick={() => startExpertReview(expert.id, expert.name)}
                  >
                    <span className="task-context-emoji">{expert.emoji || "🧙"}</span>
                    <span className="task-context-item-label">{expert.name}</span>
                  </button>
                ))}
              </>
            )}
            <div className="task-context-sep" />
            <button
              type="button"
              className="task-context-item"
              onClick={() => {
                closeMenu();
                setPage("experts");
              }}
            >
              去专家中心
            </button>
          </div>
        )}
      </div>
      {relatedNotice && <div className="task-context-notice">{relatedNotice}</div>}
      <button type="button" className="task-context-item" onClick={() => { closeMenu(); setExpertManagerOpen(true); }}><IconSparkles size={14} />{taskExpert ? "管理当前任务专家" : "绑定专家到此任务"}</button>
      <div className="task-context-sep" />
      <button
        type="button"
        className="task-context-item"
        onClick={() => {
          closeMenu();
          duplicateTaskWithMode("working", task.id);
        }}
      >
        <WelcomeModeIcon mode="working" size={14} /> 复制为办公任务
      </button>
      <button
        type="button"
        className="task-context-item"
        onClick={() => {
          closeMenu();
          duplicateTaskWithMode("coding", task.id);
        }}
      >
        <WelcomeModeIcon mode="coding" size={14} /> 复制为编码任务
      </button>
      <button
        type="button"
        className="task-context-item"
        onClick={() => {
          closeMenu();
          duplicateTaskWithMode("bot", task.id);
        }}
      >
        <WelcomeModeIcon mode="bot" size={14} /> 复制为 Bot 任务
      </button>
      <div className="task-context-sep" />
      <div className={`task-context-item-wrap ${subMenu === "share" ? "open" : ""}`}>
        <button
          type="button"
          className={`task-context-item has-sub ${subMenu === "share" ? "active" : ""}`}
          onClick={() => {
            setShareNotice(null);
            setSubMenu((prev) => (prev === "share" ? null : "share"));
          }}
        >
          <IconShare size={14} />
          <span className="task-context-item-label">分享任务</span>
          <IconChevronRight size={14} className="task-context-chevron" />
        </button>
        {subMenu === "share" && (
          <div className="task-context-submenu">
            <div className="task-context-submenu-title">分享到任务对话</div>
            {shareTargets.length === 0 ? (
              <div className="task-context-empty">暂无其它可分享的任务</div>
            ) : (
              shareTargets.map((target) => {
                const spaceName = target.spaceId
                  ? spaces.find((s) => s.id === target.spaceId)?.name
                  : undefined;
                return (
                  <button
                    key={target.id}
                    type="button"
                    className="task-context-item"
                    disabled={shareBusy}
                    title={spaceName ? `${target.title} · ${spaceName}` : target.title}
                    onClick={() => void shareToTask(target.id)}
                  >
                    <WelcomeModeIcon mode={target.welcomeMode} size={14} />
                    <span className="task-context-item-label">{target.title}</span>
                  </button>
                );
              })
            )}
            {shareNotice && <div className="task-context-notice">{shareNotice}</div>}
          </div>
        )}
      </div>
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
      className={`task-item ${nested ? "nested" : ""} ${active ? "active" : ""} ${pinned ? "pinned" : ""} ${menuOpen ? "menu-open" : ""} ${displayStatus !== "idle" ? `status-${displayStatus}` : ""}${fileDropOver ? " file-drop-target" : ""}${dropNotice ? " has-drop-notice" : ""}`}
      title={editing ? undefined : `${task.title || "未命名任务"} · ${relativeTime(task.updatedAt)}`}
      onClick={() => !editing && setActiveTask(task.id)}
      onKeyDown={(e) => e.key === "Enter" && !editing && setActiveTask(task.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (editing) return;
        setSubMenu(null);
        setShareNotice(null);
        setRelatedNotice(null);
        setMenuOpen(true);
      }}
      draggable={!editing}
      onDragStart={(e) => {
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
        {displayStatus === "pending" && (
          <span className="task-badge" title={awaitingInput ? "等待你回答" : "等待你确认操作"}>
            {awaitingInput ? "待回答" : "待确认"}
          </span>
        )}
        {displayStatus === "running" && (
          <span className="task-status-running" title="进行中">
            <span className="task-status-dot" />
          </span>
        )}
        {displayStatus === "idle" && (
          <span className="task-item-time">{relativeTime(task.updatedAt)}</span>
        )}
        {displayStatus === "running" && (
          <span className="task-item-time dim">{relativeTime(task.updatedAt)}</span>
        )}
      </div>

      <div className="task-item-actions">
        <div className="task-menu-anchor" ref={menuAnchorRef}>
          <button
            type="button"
            className="task-item-action"
            title="更多"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (menuOpen) {
                closeMenu();
              } else {
                setSubMenu(null);
                setShareNotice(null);
                setRelatedNotice(null);
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
      {expertManagerOpen && <ExpertBindingModal taskId={task.id} onClose={() => setExpertManagerOpen(false)} />}
    </div>
  );
}
