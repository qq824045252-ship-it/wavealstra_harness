import { useEffect } from "react";
import { applyTheme } from "@/lib/theme";
import { useAppStore } from "@/store/appStore";
import Sidebar from "@/components/Sidebar";
import ChatView from "@/components/chat/ChatView";
import ArtifactPanel from "@/components/artifact/ArtifactPanel";
import PanelResizeHandle from "@/components/artifact/PanelResizeHandle";
import SettingsModal from "@/components/settings/SettingsModal";
import UsageStatsModal from "@/components/account/UsageStatsModal";
import ApiAggregationModal from "@/components/account/ApiAggregationModal";
import AssistantPage from "@/components/pages/AssistantPage";
import HubPage from "@/components/pages/HubPage";
import ProjectsPage from "@/components/pages/ProjectsPage";
import AutomationPage from "@/components/pages/AutomationPage";
import FilesPage from "@/components/pages/FilesPage";
import LibraryPage from "@/components/pages/library/LibraryPage";
import MailboxPage from "@/components/pages/MailboxPage";
import SearchModal from "@/components/sidebar/SearchModal";
import SubagentDrawer from "@/components/chat/SubagentDrawer";
import PlaceholderPage from "@/components/pages/PlaceholderPage";
import WorkspaceDetail from "@/components/workspace/WorkspaceDetail";
import MyGadgetsView from "@/components/gadget/MyGadgetsView";
import { IconPanel } from "@/components/common/icons";
import { HOME_BROWSER_KEY } from "@/lib/browserLinks";
import { canvasPanelWidth } from "@/lib/panelWidth";
import { subscribeGadgetBrowser } from "@/lib/gadgetBrowser";

export default function App(): React.JSX.Element {
  const page = useAppStore((s) => s.page);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const panelOpen = useAppStore((s) => s.panelOpen);
  const panelMode = useAppStore((s) => s.panelMode);
  const panelExpanded = useAppStore((s) => s.panelExpanded);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const activeTask = useAppStore((s) => s.tasks.find((t) => t.id === s.activeTaskId));
  const theme = useAppStore((s) => s.theme);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        // 终端聚焦时 Ctrl+K 留给 shell（xterm 隐藏 textarea 位于 .xterm 内），不抢搜索框
        const ae = document.activeElement;
        if (ae && typeof ae.closest === "function" && ae.closest(".xterm")) return;
        e.preventDefault();
        const open = useAppStore.getState().searchOpen;
        useAppStore.getState().setSearchOpen(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 挂载与窗口缩放时重新夹紧右栏，保证聊天区不低于 PANEL_CHAT_MIN
  useEffect(() => {
    const reclamp = (): void => {
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
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, []);

  // 主进程专业工具（Penpot open）→ 扩展栏浏览器
  useEffect(() => {
    const api = window.api?.browser;
    if (!api?.onOpenRequest) return;
    return api.onOpenRequest((url) => {
      useAppStore.getState().setBrowserUrl(url);
    });
  }, []);

  const showArtifactPanel =
    panelOpen &&
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
    <div className="app">
      {!sidebarCollapsed && <Sidebar />}
      <div
        className={`main-area ${panelExpanded ? "panel-expanded" : ""} ${showArtifactPanel ? "has-artifact-panel" : ""}`}
      >
        {sidebarCollapsed && page !== "chat" && (
          <button className="icon-btn sidebar-expand-float" title="展开侧边栏" onClick={toggleSidebar}>
            <IconPanel size={15} />
          </button>
        )}
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
          <MailboxPage />
        ) : page === "library" ? (
          <LibraryPage />
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
          <PlaceholderPage
            title="记忆"
            description="跨任务长期记忆的查看与管理（MEMORY.md）"
            phase="规划中 · 阶段 6"
          />
        )}
      </div>
      {settingsOpen && <SettingsModal />}
      <SearchModal />
      <SubagentDrawer />
      <UsageStatsModal />
      <ApiAggregationModal />
    </div>
  );
}

