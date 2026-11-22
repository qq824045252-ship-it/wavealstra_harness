import { useEffect, useRef, useState, type MouseEvent, type RefCallback } from "react";
import { DOTS_TASK_ID } from "@shared/dots";
import appIcon from "../../../../shared/assets/app.png";
import WorkspacePicker from "@/components/chat/WorkspacePicker";
import { IconChevronDown, IconMore, IconPlus } from "@/components/common/icons";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import { useAppStore } from "@/store/appStore";
import type { Page, Task } from "@/types";
import DesktopNotifications from "./DesktopNotifications";
import DesktopModuleMenu, { isTaskPage } from "./DesktopModuleMenu";
import { useDesktopNavigate } from "./DesktopSection";

export type DesktopMenu = "modules" | "workspace" | "section" | "actions";

function TaskTitle({ task }: { task: Task }): React.JSX.Element {
  const renameTask = useAppStore(s => s.renameTask);
  const [draft, setDraft] = useState<string | null>(null);
  const label = task.id === DOTS_TASK_ID ? "MyBuddy Dots" : task.title || "任务";
  const commit = (): void => {
    const title = draft?.trim();
    if (title && title !== task.title) void renameTask(task.id, title);
    setDraft(null);
  };
  if (task.id === DOTS_TASK_ID) return <span className="desktop-task-title-label" title={label}>{label}</span>;
  if (draft !== null) return <input className="desktop-task-title-input" aria-label="任务名称" autoFocus
    value={draft} onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)}
    onBlur={commit} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") commit();
      if (event.key === "Escape") { event.stopPropagation(); setDraft(null); }
    }} />;
  return <>
    <button type="button" className="desktop-task-title-label" title={label}
      onDoubleClick={() => setDraft(task.title)} onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setDraft(task.title); }
      }}>
      {label}
    </button>
    <span className="desktop-task-title-tooltip" aria-hidden="true">{label}</span>
  </>;
}

export default function DesktopTopBar({ menu, setMenu, activeTask, setSectionTarget, setActionsTarget, onNavigate, onSettings }: {
  menu: DesktopMenu | null;
  setMenu: (menu: DesktopMenu | null) => void;
  activeTask: Task | undefined;
  setSectionTarget: RefCallback<HTMLElement>;
  setActionsTarget: RefCallback<HTMLDivElement>;
  onNavigate: (page: Page) => void;
  onSettings: () => void;
}): React.JSX.Element {
  const page = useAppStore(s => s.page);
  const settingsOpen = useAppStore(s => s.settingsOpen);
  const workspaceId = useAppStore(s => s.page === "workspace" ? s.activeWorkspaceId : s.draft?.spaceId ?? s.homeSpaceId);
  const draftProjectId = useAppStore(s => s.draft?.projectId);
  const subagentView = useAppStore(s => s.subagentView);
  const showingTasks = isTaskPage(page) && !settingsOpen;
  const hasList = page !== "notifications" || settingsOpen;
  const navigate = useDesktopNavigate();
  const triggerRef = useRef<HTMLElement | null>(null);
  const toggle = (next: DesktopMenu, event: MouseEvent<HTMLButtonElement>): void => {
    triggerRef.current = event.currentTarget;
    setMenu(menu === next ? null : next);
  };

  useBlockNativeSurfaces(menu !== null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      setMenu(null);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [menu, setMenu]);

  const guarded = (action: () => void): void => {
    setMenu(null);
    void navigate?.(action);
  };
  const showTaskTitle = showingTasks && page === "chat" && activeTask;
  const hasActions = activeTask ? activeTask.id !== DOTS_TASK_ID && subagentView?.taskId !== activeTask.id : Boolean(draftProjectId);

  return <>
    {menu && <div className="desktop-popup-backdrop" aria-hidden="true" onClick={() => setMenu(null)} />}
    <header className="desktop-topbar">
      <div className="desktop-topbar-content">
        <div className="desktop-topbar-anchor">
          <button type="button" className="desktop-topbar-button desktop-brand" aria-label="MyBuddy 主导航"
            aria-expanded={menu === "modules"} aria-controls="desktop-module-menu" onClick={event => toggle("modules", event)}>
            <img src={appIcon} alt="" width={16} height={16} draggable={false} />
            <span>MyBuddy</span><IconChevronDown size={12} />
          </button>
          <nav className="desktop-popup desktop-module-menu" id="desktop-module-menu" aria-label="主导航" hidden={menu !== "modules"}>
            <DesktopModuleMenu onNavigate={destination => { setMenu(null); onNavigate(destination); }}
              onSettings={() => { setMenu(null); onSettings(); }} />
          </nav>
        </div>
        {showingTasks && <div className="desktop-workspace-picker" onClick={event => {
          if (event.target instanceof Element) triggerRef.current = event.target.closest(".workspace-trigger");
        }}>
          <WorkspacePicker mode="selection" compact open={menu === "workspace"}
            selectedSpaceId={page === "chat" && activeTask ? activeTask.spaceId : workspaceId}
            onToggle={() => setMenu(menu === "workspace" ? null : "workspace")} onClose={() => setMenu(null)}
            onSelectSpace={id => { if (id) guarded(() => useAppStore.getState().openWorkspaceDetail(id)); }}
            allowIndependent={false} showCreateActions={false} />
        </div>}
        <div className="desktop-task-title">
          {showTaskTitle && <><span className="desktop-title-divider" aria-hidden="true">/</span>
            <TaskTitle key={showTaskTitle.id} task={showTaskTitle} /></>}
        </div>
        <div className="desktop-topbar-drag" aria-hidden="true" />
        <div className="desktop-topbar-anchor">
          {hasList && <button type="button" className="desktop-topbar-button" aria-expanded={menu === "section"}
            aria-label={showingTasks ? "任务列表" : "模块列表"}
            aria-controls="desktop-module-list" onClick={event => toggle("section", event)}>
            {showingTasks ? "任务" : "列表"}<IconChevronDown size={12} />
          </button>}
          <aside id="desktop-module-list" className="desktop-popup desktop-section" aria-label={showingTasks ? "任务列表" : "当前模块的列表"}
            hidden={!hasList || menu !== "section"} ref={setSectionTarget} />
        </div>
        <button type="button" className="desktop-topbar-button" title="新建任务" aria-label="新建任务" onClick={() => guarded(() => {
          const state = useAppStore.getState();
          if (state.settingsOpen) state.setSettingsOpen(false);
          state.newTask();
        })}><IconPlus size={15} /><span>新建</span></button>
        {showingTasks && page === "chat" && <div className="desktop-topbar-anchor">
          {hasActions && <button type="button" className="desktop-topbar-button" title="更多任务操作"
            aria-label="更多任务操作" aria-controls="desktop-task-actions" aria-expanded={menu === "actions"}
            onClick={event => toggle("actions", event)}><IconMore size={16} /></button>}
          <div id="desktop-task-actions" className="desktop-popup desktop-task-actions" hidden={menu !== "actions"} ref={setActionsTarget} />
        </div>}
        <DesktopNotifications onOpen={() => { setMenu(null); onNavigate("notifications"); }} />
      </div>
    </header>
  </>;
}
