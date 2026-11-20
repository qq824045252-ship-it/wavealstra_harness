import { useEffect, useLayoutEffect, useRef, useState } from "react";
import appIcon from "../../main/assets/app.png";
import { applyTheme } from "@/lib/theme";
import { useAppStore } from "@/store/appStore";
import Sidebar from "@/components/Sidebar";
import ChatView from "@/components/chat/ChatView";
import ArtifactPanel from "@/components/artifact/ArtifactPanel";
import PanelResizeHandle from "@/components/artifact/PanelResizeHandle";
import SettingsModal from "@/components/settings/SettingsModal";
import UsageStatsPage from "@/components/account/UsageStatsPage";
import AssistantPage from "@/components/pages/AssistantPage";
import HubPage from "@/components/pages/HubPage";
import ProjectsPage from "@/components/pages/ProjectsPage";
import AutomationPage from "@/components/pages/AutomationPage";
import FilesPage from "@/components/pages/FilesPage";
import LibraryPage from "@/components/pages/library/LibraryPage";
import MailboxPage from "@/components/pages/MailboxPage";
import NotificationsPage from "@/components/pages/NotificationsPage";
import SubagentDrawer from "@/components/chat/SubagentDrawer";
import PlaceholderPage from "@/components/pages/PlaceholderPage";
import WorkspaceDetail from "@/components/workspace/WorkspaceDetail";
import MyGadgetsView from "@/components/gadget/MyGadgetsView";
import { HOME_BROWSER_KEY } from "@/lib/browserLinks";
import { canvasPanelWidth, PANEL_CHAT_MIN, PANEL_RAIL_WIDTH } from "@/lib/panelWidth";
import { subscribeGadgetBrowser } from "@/lib/gadgetBrowser";
import { DesktopSectionProvider, DesktopSectionSidebar, DesktopSectionVisibility, useDesktopNavigate } from "@/components/desktop/DesktopSection";
import DesktopRail, { isExtensionsPage, isTaskPage } from "@/components/desktop/DesktopRail";
import type { Page } from "@/types";
import "@/components/desktop/desktop.css";

export default function App(): React.JSX.Element {
  const [sectionTarget, setSectionTarget] = useState<HTMLElement | null>(null);
  const toggleSidebar = useAppStore(s => s.toggleSidebar);
  return <DesktopSectionProvider target={sectionTarget} collapseList={toggleSidebar}>
    <DesktopApp setSectionTarget={setSectionTarget} />
  </DesktopSectionProvider>;
}

type Store = ReturnType<typeof useAppStore.getState>;

function chatLocation(s: Store) {
  return {
    activeTaskId: s.activeTaskId,
    draft: s.draft,
    homeSpaceId: s.homeSpaceId,
    activeModelId: s.activeModelId,
    modelExplicit: s.modelExplicit,
    permissionMode: s.permissionMode,
    permissionExplicit: s.permissionExplicit,
    activeConnectorIds: s.activeConnectorIds,
    welcomeMode: s.welcomeMode,
    modePresetId: s.modePresetId,
    panelOpen: s.panelOpen,
    panelExpanded: s.panelExpanded,
    panelMode: s.panelMode,
    panelWidth: s.panelWidth,
    extensionView: s.extensionView,
    artifactTabs: s.artifactTabs,
    activeArtifactId: s.activeArtifactId,
  };
}

function DesktopApp({ setSectionTarget }: { setSectionTarget: (element: HTMLElement | null) => void }): React.JSX.Element {
  const page = useAppStore((s) => s.page);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const panelOpen = useAppStore((s) => s.panelOpen);
  const panelMode = useAppStore((s) => s.panelMode);
  const panelExpanded = useAppStore((s) => s.panelExpanded);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const activeTask = useAppStore((s) => s.tasks.find((t) => t.id === s.activeTaskId));
  const theme = useAppStore((s) => s.theme);
  const navigate = useDesktopNavigate();
  const mainRef = useRef<HTMLDivElement>(null);
  const [compactPreview, setCompactPreview] = useState(false);
  const lastChat = useRef<ReturnType<typeof chatLocation> | null>(null);
  const lastWorkspace = useRef<string | null>(null);
  const lastExtension = useRef<"experts" | "skills" | "mcp" | "connectors">("experts");
  const lastBeforeNotifications = useRef<Page>("chat");

  useLayoutEffect(() => useAppStore.subscribe((current, previous) => {
    if (current.page === "notifications" && previous.page !== "notifications") lastBeforeNotifications.current = previous.page;
    if (isExtensionsPage(current.page)) lastExtension.current = current.page;
    if (previous.page === "chat" && current.page !== "chat") lastChat.current = chatLocation(previous);
    if (current.page === "workspace") lastWorkspace.current = current.activeWorkspaceId;
    else if (current.page === "chat") lastWorkspace.current = null;
  }), []);

  const selectModule = (destination: Page): void => {
    const state = useAppStore.getState();
    if (!state.settingsOpen && (
      state.page === destination ||
      (destination === "chat" && isTaskPage(state.page)) ||
      (destination === "experts" && isExtensionsPage(state.page))
    )) return;
    void navigate?.(() => {
      const current = useAppStore.getState();
      if (current.settingsOpen) current.setSettingsOpen(false);
      if (destination !== "chat") {
        current.setPage(destination === "experts" ? lastExtension.current : destination);
        if (current.page !== destination && current.panelOpen) current.closePanel();
        return;
      }
      if (isTaskPage(current.page)) return;
      const space = lastWorkspace.current;
      if (space && current.spaces.some(candidate => candidate.id === space && !candidate.effectiveArchived)) {
        current.openWorkspaceDetail(space);
        return;
      }
      const saved = lastChat.current;
      if (!saved) { current.setPage("chat"); return; }
      const { activeTaskId, draft, panelOpen, panelExpanded, panelMode, panelWidth, extensionView, artifactTabs, activeArtifactId } = saved;
      if (activeTaskId && current.tasks.some(candidate => candidate.id === activeTaskId && !candidate.archived)) {
        current.setActiveTask(activeTaskId);
        useAppStore.setState({ panelOpen, panelExpanded, panelMode, panelWidth, extensionView, artifactTabs, activeArtifactId });
      } else if (activeTaskId) {
        current.newTask();
      } else {
        useAppStore.setState({ ...saved, page: "chat", draft, activeWorkspaceId: null });
      }
    });
  };

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => subscribeGadgetBrowser(), []);

  useEffect(() => {
    const unsub = useAppStore.getState().initRuntime();
    return () => {
      unsub?.();
    };
  }, []);

  useEffect(() => {
    // Returning from Magpie or a text editor reconciles the model files through
    // Main/Pi and updates the picker without changing an existing task's model.
    const refresh = (): void => { void useAppStore.getState().refreshModelConfiguration(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  // 挂载与窗口缩放时重新夹紧右栏，保证聊天区不低于 PANEL_CHAT_MIN
  useEffect(() => {
    const reclamp = (): void => {
      const width = mainRef.current?.clientWidth;
      if (width) setCompactPreview(width < PANEL_CHAT_MIN + PANEL_RAIL_WIDTH + 20);
      const {
        activeTaskId,
        browserUrlByTask,
        panelMode,
        panelOpen,
        panelWidth,
        setPanelWidth,
        sidebarCollapsed,
      } = useAppStore.getState();
      if (!panelOpen) return;

      const browserKey = activeTaskId ?? HOME_BROWSER_KEY;
      const browserOpen = panelMode === "browser" && Boolean(browserUrlByTask[browserKey]);
      setPanelWidth(browserOpen ? canvasPanelWidth(sidebarCollapsed) : panelWidth);
    };
    reclamp();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(reclamp);
    if (mainRef.current) observer?.observe(mainRef.current);
    return () => observer?.disconnect();
  }, []);

  // 主进程专业工具（Penpot open）→ 扩展栏浏览器
  useEffect(() => {
    const api = window.api?.browser;
    if (!api?.onOpenRequest) return;
    return api.onOpenRequest((url, retained) => {
      if (retained?.taskId) {
        const taskId = retained.taskId;
        useAppStore.setState(state => ({ browserTabByTask: { ...state.browserTabByTask, [taskId]: { id: retained.tabId, key: retained.key, url } }, browserUrlByTask: { ...state.browserUrlByTask, [taskId]: url } }));
        if (useAppStore.getState().activeTaskId === taskId) useAppStore.getState().showBrowser();
        return;
      }
      useAppStore.getState().setBrowserUrl(url);
    });
  }, []);

  const showArtifactPanel =
    !settingsOpen && panelOpen &&
    (page === "chat"
      ? // Empty tasks also need the side tools; home can open browser/terminal without a task.
        Boolean(activeTask) ||
        panelMode === "browser" ||
        panelMode === "gadgets" ||
        panelMode === "terminal"
      : page === "workspace" || page === "gadgets");

  // 原生 WebContentsView 不在 React DOM 树内，页面切换/右栏卸载时不能只依赖
  // 局部 cleanup；统一在宿主面板消失时关闭产物/浏览器原生视图。
  useEffect(() => {
    if (showArtifactPanel) return;
    window.api?.artifact?.close();
    window.api?.browser?.close();
  }, [showArtifactPanel]);

  return (
    <div className="app desktop-app">
      <div className="desktop-titlebar-brand" aria-hidden="true">
        <img src={appIcon} alt="" width={16} height={16} draggable={false} />
        <span>MyBuddy</span>
      </div>
      <DesktopRail onNavigate={selectModule} onSettings={() => {
        if (!useAppStore.getState().settingsOpen) void navigate?.(() => useAppStore.getState().setSettingsOpen(true));
      }} />
      <aside id="desktop-module-list" className="desktop-section" aria-label="当前模块的列表"
        hidden={sidebarCollapsed || (page === "notifications" && !settingsOpen)} ref={setSectionTarget} />
      <div
        ref={mainRef}
        data-desktop-main
        className={`main-area ${showArtifactPanel && (panelExpanded || compactPreview) ? "panel-expanded" : ""} ${showArtifactPanel ? "has-artifact-panel" : ""}`}
      >
        <DesktopSectionVisibility visible={!settingsOpen}>
        <div className="desktop-page-underlay" hidden={settingsOpen}>
        {isTaskPage(page) && <Sidebar />}
        {page === "chat" ? (
          <>
            <div className="content-col">
              <ChatView />
            </div>
            {showArtifactPanel && (
              <>
                <PanelResizeHandle />
                <ArtifactPanel />
              </>
            )}
          </>
        ) : page === "assistant" ? (
          <AssistantPage />
        ) : page === "projects" ? (
          <ProjectsPage />
        ) : page === "experts" || page === "skills" || page === "mcp" || page === "connectors" ? (
          <HubPage tab={page} />
        ) : page === "automation" ? (
          <AutomationPage />
        ) : page === "files" ? (
          <FilesPage />
        ) : page === "mailbox" ? (
          <><DesktopSectionSidebar title="收件箱" /><MailboxPage /></>
        ) : page === "library" ? (
          <LibraryPage />
        ) : page === "usage" ? (
          <UsageStatsPage />
        ) : page === "notifications" ? (
          <NotificationsPage onBack={() => selectModule(isTaskPage(lastBeforeNotifications.current) ? "chat" : lastBeforeNotifications.current)} />
        ) : page === "gadgets" ? (
          <>
            <div className="content-col"><MyGadgetsView /></div>
            {showArtifactPanel && <><PanelResizeHandle /><ArtifactPanel /></>}
          </>
        ) : page === "workspace" ? (
          <>
            <div className="content-col">
              <WorkspaceDetail />
            </div>
            {showArtifactPanel && (
              <>
                <PanelResizeHandle />
                <ArtifactPanel />
              </>
            )}
          </>
        ) : (
          <><DesktopSectionSidebar title="记忆" /><PlaceholderPage
            title="记忆"
            description="跨任务长期记忆的查看与管理（MEMORY.md）"
            phase="规划中 · 阶段 6"
          /></>
        )}
        </div>
        </DesktopSectionVisibility>
        {settingsOpen && <SettingsModal desktop />}
      </div>
      <SubagentDrawer />
    </div>
  );
}

