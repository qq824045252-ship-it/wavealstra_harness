import { useCallback, useEffect, useRef, useState } from "react";
import ChatInput from "@/components/chat/ChatInput";
import { IconChevronRight, IconFolderKanban } from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";
import {
  syncRailDockFromViewport,
  useProjectConfigRailStore,
} from "@/store/projectConfigRailStore";
import {
  decideProjectNavigation,
  decideTabSwitchGuard,
  PROJECT_PRIMARY_TABS,
  PROJECT_WORKSPACE_TAB_HINTS,
  PROJECT_WORKSPACE_TAB_LABELS,
  resolveUnsavedGuardAction,
  type ProjectNavDestination,
  type ProjectUnsavedGuard,
  type ProjectWorkspaceTab,
} from "@/lib/projectWorkspace";
import { defaultModePresetId } from "@shared/mode-profile";
import { listProjectTemplates } from "@shared/project-template";
import {
  resolveProjectTaskDefaults,
  resolveProjectTemplateTaskSuggestion,
  type TemplateTaskSuggestion,
} from "@shared/project-task-defaults";
import type { ProjectDetailsDto } from "@shared/project-domain";
import NewProjectTaskModal from "./NewProjectTaskModal";
import ProjectActivity from "./ProjectActivity";
import ProjectMaterials from "./ProjectMaterials";
import ProjectCapabilities from "./ProjectCapabilities";
import ProjectConfigRail from "./ProjectConfigRail";
import ProjectPlan from "./ProjectPlan";
import ProjectMemory from "./ProjectMemory";
import ProjectNotes from "./ProjectNotes";
import ProjectSettings from "./ProjectSettings";
import ProjectStatusCard from "./ProjectStatusCard";
import ProjectTasks from "./ProjectTasks";
import UnsavedChangesDialog from "./UnsavedChangesDialog";

interface Props {
  projectId: string;
  showArchived: boolean;
  onToast: (text: string) => void;
}

export default function ProjectWorkspace({
  projectId,
  showArchived,
  onToast,
}: Props): React.JSX.Element {
  const tasks = useAppStore((state) => state.tasks);
  const spaces = useAppStore((state) => state.spaces);
  const refreshProjects = useAppStore((state) => state.refreshProjects);
  const activeProjectTab = useAppStore((state) => state.activeProjectTab);
  const projectNavRequest = useAppStore((state) => state.projectNavRequest);
  const applyProjectNavigation = useAppStore((state) => state.applyProjectNavigation);
  const clearProjectNavRequest = useAppStore((state) => state.clearProjectNavRequest);
  const setActiveTask = useAppStore((state) => state.setActiveTask);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const [project, setProject] = useState<ProjectDetailsDto | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [pendingNav, setPendingNav] = useState<ProjectNavDestination | null>(null);
  const [guardBusy, setGuardBusy] = useState(false);
  /** 多 Guard：pane（Capabilities/Settings 表单）与 rail（配置栏 Detail）独立注册，互不覆盖 */
  const guardsRef = useRef<Map<string, ProjectUnsavedGuard>>(new Map());

  const registerUnsaved = useCallback((guard: ProjectUnsavedGuard | null, key: string) => {
    const guards = guardsRef.current;
    if (guard) guards.set(key, guard);
    else guards.delete(key);
  }, []);

  const activeDirty = useCallback((): boolean => {
    return [...guardsRef.current.values()].some((guard) => guard.dirty);
  }, []);

  const tabSwitchDirty = useCallback((tab: ProjectWorkspaceTab): boolean => {
    const dirtyByKey: Record<string, boolean> = {};
    for (const [key, guard] of guardsRef.current.entries()) dirtyByKey[key] = guard.dirty;
    return decideTabSwitchGuard(tab, dirtyByKey);
  }, []);

  const load = async (): Promise<void> => {
    setLoadState("loading");
    setError(null);
    try {
      const next = await window.api?.db?.getProject?.(projectId);
      if (!next) {
        setProject(null);
        setLoadState("missing");
        return;
      }
      setProject(next);
      setLoadState("ready");
    } catch (cause) {
      setProject(null);
      setLoadState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    setProject(null);
    void load();
  }, [projectId]);

  const refresh = async (): Promise<void> => {
    const next = await window.api?.db?.getProject?.(projectId);
    if (!next) {
      setProject(null);
      setLoadState("missing");
      return;
    }
    setProject(next);
    setLoadState("ready");
    await refreshProjects(showArchived);
  };

  const requestNavigate = useCallback((dest: ProjectNavDestination): void => {
    if (guardBusy) return;
    if (dest.type === "tab" && dest.tab === useAppStore.getState().activeProjectTab) return;
    const dirty = dest.type === "tab" ? tabSwitchDirty(dest.tab) : activeDirty();
    if (decideProjectNavigation(dirty) === "proceed") {
      // Rail 内部动作 clean 时直接执行（§22：clean collapse 不弹窗）
      if (dest.type === "rail-back") {
        useProjectConfigRailStore.getState().backToSummary();
        return;
      }
      if (dest.type === "rail-collapse") {
        useProjectConfigRailStore.getState().collapse();
        return;
      }
      if (dest.type === "page") {
        // §13/§14：跳全局 Hub 页。结束 Detail（返回时恢复当前 Project），mode/width 保留
        useProjectConfigRailStore.getState().resetForProject();
        applyProjectNavigation(dest);
        return;
      }
      applyProjectNavigation(dest);
      return;
    }
    setPendingNav(dest);
  }, [applyProjectNavigation, guardBusy, activeDirty, tabSwitchDirty]);

  useEffect(() => {
    if (!projectNavRequest) return;
    const dest = projectNavRequest;
    clearProjectNavRequest();
    requestNavigate(dest);
  }, [clearProjectNavRequest, projectNavRequest, requestNavigate]);

  const finishGuard = async (action: "cancel" | "discard" | "save"): Promise<void> => {
    const dest = pendingNav;
    if (!dest) {
      setPendingNav(null);
      return;
    }
    if (action !== "cancel") setGuardBusy(true);
    const guards = [...guardsRef.current.values()];
    const dirtyGuards = guards.filter((guard) => guard.dirty);
    // §7：dirty guard 全量传递（rail + pane 可能同时 dirty）；无 dirty 直接放行
    const result = await resolveUnsavedGuardAction(action, dirtyGuards);
    setGuardBusy(false);
    setPendingNav(null);
    if (result !== "navigate") return;
    // Rail 内部动作（§22/§23）：Guard 通过后执行，不走全局导航
    if (dest.type === "rail-back") {
      useProjectConfigRailStore.getState().backToSummary();
      return;
    }
    if (dest.type === "rail-collapse") {
      useProjectConfigRailStore.getState().collapse();
      return;
    }
    if (dest.type === "page") {
      useProjectConfigRailStore.getState().resetForProject();
      applyProjectNavigation(dest);
      return;
    }
    applyProjectNavigation(dest);
  };

  useEffect(() => {
    const store = useAppStore.getState();
    useAppStore.setState({ activeTaskId: null, draft: store.draft?.projectId === projectId ? store.draft : { projectId } });
    store.setDraftProject(projectId);
    const applyDefaults = (templateSuggestion?: TemplateTaskSuggestion | null): void => {
      const defaults = resolveProjectTaskDefaults({
        tasks: store.tasks.filter((task) => !task.archived),
        projectId,
        templateSuggestion,
      });
      store.setWelcomeMode(defaults.welcomeMode);
      store.setModePreset(defaults.modePresetId ?? defaultModePresetId(defaults.welcomeMode));
      // P0 冻结：Project 模板建议的 spaceId 不写入全局 homeSpaceId，避免污染顶部独立任务。
    };
    applyDefaults();
    void window.api?.db?.getProject?.(projectId).then((details) => {
      if (!details || useAppStore.getState().draft?.projectId !== projectId) return;
      applyDefaults(resolveProjectTemplateTaskSuggestion(details, listProjectTemplates()));
    });
    // 切换 Project：Rail Detail 必须重置为 Summary（§35），collapsed/width 保留
    useProjectConfigRailStore.getState().resetForProject();
  }, [projectId]);

  /** P2-4：视口 dock 监听提升到稳定挂载点（ProjectWorkspace），Rail 卸载（collapsed）时仍生效 */
  useEffect(() => {
    syncRailDockFromViewport();
    const onResize = (): void => syncRailDockFromViewport();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const railMode = useProjectConfigRailStore((state) => state.mode);

  const sendFromProject = useCallback<NonNullable<React.ComponentProps<typeof ChatInput>["onSend"]>>(
    (text, attachments, taskReferences, streamingBehavior, connectorIds, externalAgent) => {
      const state = useAppStore.getState();
      if (!project || state.draft?.projectId !== project.id) return;
      // Only fill an untouched draft. Explicit folder overrides (including no folder) win.
      if (state.draft && !Object.prototype.hasOwnProperty.call(state.draft, "spaceId")) {
        const defaults = resolveProjectTaskDefaults({ tasks: state.tasks.filter((task) => !task.archived), projectId: project.id,
          defaultSpaceId: project.defaultSpaceId });
        if (defaults.spaceId && !state.spaces.some((space) => space.id === defaults.spaceId && !space.archived && !space.effectiveArchived && !space.pathMissing)) {
          onToast("项目工作目录不可用，请在项目资料中重新选择，或通过新建任务指定目录");
          return;
        }
        useAppStore.setState({ draft: { ...state.draft, spaceId: defaults.spaceId } });
      }
      // Project dock materializes the project-bound draft, then moves to the only
      // surface that renders streaming messages so the reply is immediately visible.
      useAppStore.getState().setPage("chat");
      sendMessage(text, attachments, taskReferences, streamingBehavior, connectorIds, undefined, externalAgent);
    },
    [sendMessage, project, onToast],
  );

  return (
    <div className="project-desk">
      {loadState === "loading" && !project && <div className="project-loading">正在加载项目…</div>}
      {loadState === "error" && (
        <div className="empty-block">
          <div className="empty-block-title">项目加载失败</div>
          {error && <div style={{ fontSize: 12.5 }}>{error}</div>}
          <button type="button" className="btn" onClick={() => void load()}>重试</button>
        </div>
      )}
      {loadState === "missing" && (
        <div className="empty-block">
          <div className="empty-block-title">项目不存在或已被删除</div>
          <button type="button" className="btn" onClick={() => requestNavigate({ type: "project-list" })}>返回项目</button>
        </div>
      )}

      {project && (
        <>
          <header className="project-desk-crumb">
            <button type="button" className="project-desk-crumb-link" onClick={() => requestNavigate({ type: "project-list" })}>
              <IconFolderKanban size={14} /> 项目
            </button>
            <span className="project-desk-crumb-sep">/</span>
            <span className="project-desk-crumb-name">
              {project.name}
              {project.archived && <span className="project-archived-badge">已归档</span>}
            </span>
          </header>

          <div className="project-desk-body">
            <div className="project-desk-main">
              <nav className="project-desk-tabs" aria-label="项目分区">
                {PROJECT_PRIMARY_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={`project-desk-tab ${activeProjectTab === tab ? "active" : ""}`}
                    title={PROJECT_WORKSPACE_TAB_HINTS[tab]}
                    onClick={() => requestNavigate({ type: "tab", tab })}
                  >
                    {PROJECT_WORKSPACE_TAB_LABELS[tab]}
                  </button>
                ))}
                <span className="input-spacer" />
                {railMode === "collapsed" && (
                  <button
                    type="button"
                    className="project-rail-toggle"
                    title="展开项目配置"
                    aria-label="展开项目配置"
                    onClick={() => useProjectConfigRailStore.getState().expand()}
                  >
                    <IconChevronRight size={16} strokeWidth={1.7} />
                  </button>
                )}
              </nav>
              <div className="project-desk-scroll">
                <WorkspacePane
                  tab={activeProjectTab}
                  project={project}
                  tasks={tasks}
                  spaces={spaces}
                  showArchived={showArchived}
                  onNewTask={() => setTaskModalOpen(true)}
                  onOpenTask={(taskId) => setActiveTask(taskId)}
                  onOpenTab={(tab) => requestNavigate({ type: "tab", tab })}
                  onRefresh={refresh}
                  onRegisterUnsaved={(guard) => registerUnsaved(guard, "pane")}
                  onArchived={() => applyProjectNavigation({ type: "project-list" })}
                  onDeleted={() => {
                    useAppStore.setState((state) => ({
                      tasks: state.tasks.map((task) =>
                        task.projectId === project.id ? { ...task, projectId: undefined } : task,
                      ),
                    }));
                    applyProjectNavigation({ type: "project-list" });
                    void refreshProjects(showArchived);
                    onToast(`已删除「${project.name}」`);
                  }}
                  onToast={onToast}
                />
              </div>
              <div className="project-desk-dock">
                <ChatInput variant="project" onSend={sendFromProject} />
              </div>
            </div>
            {railMode !== "collapsed" && (
              <ProjectConfigRail
                project={project}
                onOpenSettings={() => requestNavigate({ type: "tab", tab: "settings" })}
                onNavigate={(dest) => requestNavigate(dest)}
                onRegisterUnsaved={(guard) => registerUnsaved(guard, "rail")}
                onRefresh={refresh}
                onToast={onToast}
                onManageConnectors={() => requestNavigate({ type: "page", page: "connectors" })}
                onManageMcp={() => requestNavigate({ type: "page", page: "mcp" })}
              />
            )}
          </div>
        </>
      )}

      {project && (
        <NewProjectTaskModal
          open={taskModalOpen}
          project={project}
          onClose={() => setTaskModalOpen(false)}
        />
      )}
      <UnsavedChangesDialog
        open={pendingNav !== null}
        busy={guardBusy}
        onCancel={() => void finishGuard("cancel")}
        onDiscard={() => void finishGuard("discard")}
        onSave={() => void finishGuard("save")}
      />
    </div>
  );
}

function WorkspacePane({
  tab,
  project,
  tasks,
  spaces,
  showArchived,
  onNewTask,
  onOpenTask,
  onOpenTab,
  onRefresh,
  onRegisterUnsaved,
  onArchived,
  onDeleted,
  onToast,
}: {
  tab: ProjectWorkspaceTab;
  project: ProjectDetailsDto;
  tasks: ReturnType<typeof useAppStore.getState>["tasks"];
  spaces: ReturnType<typeof useAppStore.getState>["spaces"];
  showArchived: boolean;
  onNewTask: () => void;
  onOpenTask: (taskId: string) => void;
  onOpenTab: (tab: ProjectWorkspaceTab) => void;
  onRefresh: () => Promise<void>;
  onRegisterUnsaved: (guard: ProjectUnsavedGuard | null) => void;
  onArchived: () => void;
  onDeleted: () => void;
  onToast: (text: string) => void;
}): React.JSX.Element {
  if (tab === "activity") {
    return <ProjectActivity project={project} tasks={tasks} onOpenTask={onOpenTask} />;
  }
  if (tab === "health") {
    return (
      <div className="project-desk-pane project-health" aria-label="项目健康度">
        <ProjectStatusCard
          project={project}
          onOpenTask={onOpenTask}
          onNavigateTab={(next) => onOpenTab(next)}
          onToast={onToast}
        />
      </div>
    );
  }
  if (tab === "plan") {
    return (
      <ProjectPlan
        projectId={project.id}
        archived={Boolean(project.archived)}
      />
    );
  }
  if (tab === "notes") {
    return <ProjectNotes key={project.id} projectId={project.id} archived={Boolean(project.archived)} />;
  }
  if (tab === "memory") {
    return (
      <ProjectMemory
        projectId={project.id}
        archived={Boolean(project.archived)}
      />
    );
  }
  if (tab === "assets") {
    return <ProjectMaterials key={project.id} project={project} onRefresh={onRefresh} onRegisterUnsaved={onRegisterUnsaved} />;
  }
  if (tab === "tasks") {
    return (
      <ProjectTasks
        projectId={project.id}
        archived={Boolean(project.archived)}
        tasks={tasks}
        spaces={spaces}
        onNewTask={onNewTask}
        onOpenTask={onOpenTask}
      />
    );
  }
  if (tab === "capabilities") {
    return (
      <ProjectCapabilities
        project={project}
        onRefresh={onRefresh}
        onToast={onToast}
        onRegisterUnsaved={onRegisterUnsaved}
      />
    );
  }
  return (
    <ProjectSettings
      project={project}
      showArchived={showArchived}
      onRefresh={onRefresh}
      onArchived={onArchived}
      onDeleted={onDeleted}
      onToast={onToast}
      onRegisterUnsaved={onRegisterUnsaved}
    />
  );
}
