import { PANEL_RAIL_WIDTH } from "../../../lib/panelWidth";
import type { AppState } from "../types";

/**
 * Task 级 UI 收口纯函数（仅计算，不执行 IPC）。
 *
 * 用于删除/切换/新建 Task 时把右侧扩展栏相关状态原子复位，避免散落字段清单漂移
 * （方案 Problem One 3.3）。返回值是可并入 Zustand set() 的 Partial<AppState>。
 *
 * 关键语义：
 * - 删除当前 Task 时恢复「展开面板前的 sidebarCollapsed」，而不是只把
 *   sidebarBeforePanelExpand 置 null 丢掉原值（对齐 closePanel）。
 * - 只移除被删 Task 自己的 browserUrlByTask key，其它任务与首页 __home__ 保留。
 */
export function resetTaskScopedUiState(
  state: Pick<
    AppState,
    | "activeTaskId"
    | "sidebarCollapsed"
    | "sidebarBeforePanelExpand"
    | "browserUrlByTask"
    | "browserUrlInput"
    | "panelMode"
    | "extensionView"
    | "extensionFlyoutOpen"
    | "extensionFlyoutPinned"
    | "extensionMenuOpen"
    | "artifactTabs"
    | "activeArtifactId"
    | "selectMode"
    | "selectedMessageIds"
    | "chatSelections"
    | "pendingExternalAgentContinuation"
    | "tasks"
    | "browserFrameKey"
  >,
  options: {
    nextTaskId: string | null;
    deletedTaskId?: string;
    clearBrowserUrl: boolean;
  },
): Partial<AppState> {
  const browserUrlByTask = state.browserUrlByTask ?? {};
  const filtered = options.deletedTaskId
    ? Object.fromEntries(
        Object.entries(browserUrlByTask).filter(
          ([k]) => k !== options.deletedTaskId,
        ),
      )
    : browserUrlByTask;
  return {
    activeTaskId: options.nextTaskId,
    panelOpen: false,
    panelMode: "file",
    panelExpanded: false,
    panelWidth: PANEL_RAIL_WIDTH,
    extensionView: "overview",
    extensionFlyoutOpen: false,
    extensionFlyoutPinned: false,
    extensionMenuOpen: false,
    artifactTabs: [],
    activeArtifactId: null,
    browserUrlInput: options.clearBrowserUrl
      ? ""
      : (state.browserUrlInput ?? ""),
    browserUrlByTask: filtered,
    sidebarCollapsed:
      state.sidebarBeforePanelExpand !== null
        ? state.sidebarBeforePanelExpand
        : state.sidebarCollapsed,
    sidebarBeforePanelExpand: null,
    selectMode: false,
    selectedMessageIds: [],
    chatSelections: [],
    pendingExternalAgentContinuation: null,
  };
}
