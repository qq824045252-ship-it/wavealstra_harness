import { useMemo } from "react";
import type { PanelMode } from "@/store/appStore";
import {
  useActiveTerminalTabs,
  useAppStore,
  useVisibleTaskArtifacts,
  useActiveTaskArtifacts,
} from "@/store/appStore";
import type { Artifact } from "@/types";
import { FileBadge } from "@/components/common/FileBadge";
import { canNativeDrag, startNativeFileDrag } from "@/lib/nativeFileDrag";
import {
  IconExpand,
  IconFileBox,
  IconFolder,
  IconGitBranch,
  IconGlobe,
  IconPanel,
  IconPin,
  IconPlus,
  IconPuzzle,
  IconTerminal,
  IconX,
  IconZap,
} from "@/components/common/icons";
import { hasActiveExecutionMessages } from "@/utils/taskFilters";
import { resolveTaskFileChanges } from "@/lib/taskFileChanges";
import TerminalTabsBar from "./TerminalTabsBar";

interface Props {
  tabs: Artifact[];
  activeId: string | undefined;
  onWiden: () => void;
  onOpenTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  wsSearch?: string;
}

export default function ExtensionTopBar({
  tabs,
  activeId,
  onWiden,
  onOpenTab,
  onCloseTab,
}: Props): React.JSX.Element {
  const panelMode = useAppStore((s) => s.panelMode);
  const closePanel = useAppStore((s) => s.closePanel);
  const panelPinned = useAppStore((s) => s.panelPinned);
  const togglePanelPinned = useAppStore((s) => s.togglePanelPinned);
  const panelExpanded = useAppStore((s) => s.panelExpanded);
  const showOverview = useAppStore((s) => s.showOverview);
  const showArtifacts = useAppStore((s) => s.showArtifacts);
  const showWorkspace = useAppStore((s) => s.showWorkspace);
  const showGadgets = useAppStore((s) => s.showGadgets);
  const showTerminal = useAppStore((s) => s.showTerminal);
  const showBrowser = useAppStore((s) => s.showBrowser);
  const showChanges = useAppStore((s) => s.showChanges);

  const { tabs: terminalTabs } = useActiveTerminalTabs();

  const visibleArtifacts = useVisibleTaskArtifacts();
  const artifactsCount = visibleArtifacts.length;
  const allArtifacts = useActiveTaskArtifacts();
  const workspaceFilesCount = useAppStore((s) => s.workspaceFilesCount);
  const gadgetsCount = useAppStore((s) => s.gadgetsCount);

  const currentTask = useAppStore((s) => s.tasks.find((t) => t.id === s.activeTaskId));
  const fileChangesCount = useMemo(() => {
    return resolveTaskFileChanges(currentTask?.fileChanges, allArtifacts, currentTask?.messages).length;
  }, [currentTask?.fileChanges, allArtifacts, currentTask?.messages]);

  // 判定当前任务是否在执行（主 agent 或 subagent 运行中）
  const isRunning = useMemo(() => {
    if (!currentTask) return false;
    return hasActiveExecutionMessages(currentTask.messages ?? []) || currentTask.status === "in_progress";
  }, [currentTask]);

  const showFileSubBar = panelMode === "file" && tabs.length > 0;
  const showSubBar = showFileSubBar || panelMode === "terminal";

  return (
    <div className={`extension-top-bar-container ${showSubBar ? "has-sub-bar" : ""}`}>
      {/* 第一行：主功能 Tab 栏（纯图标模式，间距舒适，高辨识度） */}
      <div className="extension-top-bar">
        <div className="extension-nav-tabs">
          {/* ⚡ 概览与运行态 */}
          <button
            type="button"
            className={`extension-tab-btn ${panelMode === "overview" ? "active" : ""}`}
            onClick={showOverview}
            title="概览与运行态"
          >
            <IconZap size={16} />
            {isRunning && <span className="extension-tab-dot" title="正在运行中" />}
          </button>

          {/* 📦 产物列表 */}
          <button
            type="button"
            className={`extension-tab-btn ${panelMode === "artifacts" ? "active" : ""}`}
            onClick={showArtifacts}
            title={artifactsCount > 0 ? `任务产物 (${artifactsCount})` : "任务产物"}
          >
            <IconFileBox size={16} />
            {artifactsCount > 0 && (
              <span className="extension-tab-badge">
                {artifactsCount > 99 ? "99+" : artifactsCount}
              </span>
            )}
          </button>

          {/* 🔀 代码变更 */}
          <button
            type="button"
            className={`extension-tab-btn ${panelMode === "changes" ? "active" : ""}`}
            onClick={showChanges}
            title={fileChangesCount > 0 ? `代码变更 (${fileChangesCount})` : "代码变更"}
          >
            <IconGitBranch size={16} />
            {fileChangesCount > 0 && (
              <span className="extension-tab-badge changes">
                {fileChangesCount > 99 ? "99+" : fileChangesCount}
              </span>
            )}
          </button>

          <div className="extension-nav-divider" />

          {/* 📁 工作空间文件 */}
          <button
            type="button"
            className={`extension-tab-btn ${panelMode === "workspace" ? "active" : ""}`}
            onClick={showWorkspace}
            title={workspaceFilesCount > 0 ? `工作空间文件 (${workspaceFilesCount})` : "工作空间文件"}
          >
            <IconFolder size={16} />
            {workspaceFilesCount > 0 && (
              <span className="extension-tab-badge">
                {workspaceFilesCount > 99 ? "99+" : workspaceFilesCount}
              </span>
            )}
          </button>

          {/* 🧩 工作台 */}
          <button
            type="button"
            className={`extension-tab-btn ${panelMode === "gadgets" ? "active" : ""}`}
            onClick={showGadgets}
            title={gadgetsCount > 0 ? `工作台 (${gadgetsCount})` : "工作台"}
          >
            <IconPuzzle size={16} />
            {gadgetsCount > 0 && (
              <span className="extension-tab-badge">
                {gadgetsCount > 99 ? "99+" : gadgetsCount}
              </span>
            )}
          </button>

          {/* 💻 终端 */}
          <button
            type="button"
            className={`extension-tab-btn ${panelMode === "terminal" ? "active" : ""}`}
            onClick={showTerminal}
            title={terminalTabs.length > 0 ? `终端 (${terminalTabs.length})` : "终端"}
          >
            <IconTerminal size={16} />
            {terminalTabs.length > 0 && (
              <span className="extension-tab-badge">
                {terminalTabs.length > 99 ? "99+" : terminalTabs.length}
              </span>
            )}
          </button>

          {/* 🌐 浏览器 */}
          <button
            type="button"
            className={`extension-tab-btn ${panelMode === "browser" ? "active" : ""}`}
            onClick={showBrowser}
            title="内置浏览器"
          >
            <IconGlobe size={16} />
          </button>
        </div>

        {/* 右侧窗口控制 */}
        <div className="extension-top-actions">
          <button
            type="button"
            className={`icon-btn ${panelExpanded ? "active" : ""}`}
            title={panelExpanded ? "还原宽度" : "展开"}
            onClick={onWiden}
          >
            <IconExpand size={15} />
          </button>
          <button
            type="button"
            className={`icon-btn ${panelPinned ? "active" : ""}`}
            title={panelPinned ? "已钉住侧栏（切换任务时保持展开）" : "钉住侧栏（切换任务时不收起）"}
            onClick={togglePanelPinned}
          >
            <IconPin size={15} fill={panelPinned ? "currentColor" : "none"} />
          </button>
          <button type="button" className="icon-btn" title="关闭侧栏" onClick={closePanel}>
            <IconPanel size={15} />
          </button>
        </div>
      </div>

      {/* 第二行：文件预览模式下的标签栏（已按用户要求移除「返回产物」前置按钮，纯粹展示文件 Tab） */}
      {showFileSubBar && (
        <div className="extension-file-subbar">
          <div className="extension-top-tabs">
            {tabs.map((a) => (
              <div
                key={a.id}
                role="button"
                tabIndex={0}
                className={`extension-top-tab ${a.id === activeId ? "active" : ""}${canNativeDrag(a.path) ? " is-draggable" : ""}`}
                title={canNativeDrag(a.path) ? `${a.path}\n可拖到桌面或其它应用` : a.name}
                draggable={canNativeDrag(a.path)}
                onDragStart={(e) => {
                  if (!startNativeFileDrag(e, a.path)) e.preventDefault();
                }}
                onClick={() => onOpenTab(a.id)}
                onKeyDown={(e) => e.key === "Enter" && onOpenTab(a.id)}
              >
                {a.kind === "html" ? (
                  <IconGlobe size={13} className="extension-tab-globe" />
                ) : (
                  <FileBadge name={a.name} size={13} />
                )}
                <span className="extension-top-tab-name">{a.name}</span>
                <button
                  type="button"
                  className="extension-top-tab-close"
                  title="关闭标签"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(a.id);
                  }}
                >
                  <IconX size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* 第二行：终端多标签横向 Tag 栏（点击加号才打开终端，支持多终端切换与管理） */}
      {panelMode === "terminal" && <TerminalTabsBar />}
    </div>
  );
}
