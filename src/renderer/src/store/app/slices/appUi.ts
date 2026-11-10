import { applyTheme, getInitialTheme } from "../../../lib/theme";
import type { Theme } from "../../../lib/theme";
import type { Page } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import type { SettingsTab } from "../types";

export interface AppUiState {
  page: Page;
  theme: Theme;
  sidebarCollapsed: boolean;
  libraryNav:
    | { view: "space"; spaceId: string; folderId: string | null }
    | { view: "item"; itemId: string }
    | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  searchOpen: boolean;
  activeWorkspaceId: string | null;
  subagentDrawer?: { instanceId: string };
  /** 子代理对话页：进入某个子会话（与主聊天共用同一个外壳，可导航回父任务） */
  subagentView?: { taskId: string; subagentId: string };
  usageStatsOpen: boolean;
  apiAggregationOpen: boolean;
  extensionSoftwareOpen: boolean;
  hubMcpFocusName: string | null;
}

export function createAppUiState(): AppUiState {
  return {
    page: "chat",
    theme: getInitialTheme(),
    sidebarCollapsed: false,
    libraryNav: null,
    settingsOpen: false,
    settingsTab: "system",
    searchOpen: false,
    activeWorkspaceId: null,
    subagentDrawer: undefined as { instanceId: string } | undefined,
    subagentView: undefined as { taskId: string; subagentId: string } | undefined,
    usageStatsOpen: false,
    apiAggregationOpen: false,
    extensionSoftwareOpen: false,
    hubMcpFocusName: null,
  };
}

export function createAppUiActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "openWorkspaceDetail"
  | "closeWorkspaceDetail"
  | "openSubagentDrawer"
  | "closeSubagentDrawer"
  | "openSubagentView"
  | "closeSubagentView"
  | "openUsageStats"
  | "closeUsageStats"
  | "openApiAggregation"
  | "closeApiAggregation"
  | "openExtensionSoftware"
  | "closeExtensionSoftware"
  | "toggleTheme"
  | "setTheme"
  | "setSettingsOpen"
  | "setSearchOpen"
> {
  const { get, set } = storeContext;
  return {
    openWorkspaceDetail: (spaceId) =>
      set({ activeWorkspaceId: spaceId, page: "workspace" }),

    closeWorkspaceDetail: () => set({ activeWorkspaceId: null }),

    openSubagentDrawer: (instanceId) => set({ subagentDrawer: { instanceId } }),

    closeSubagentDrawer: () => set({ subagentDrawer: undefined }),

    openSubagentView: (taskId, subagentId) =>
      set({ subagentView: { taskId, subagentId }, subagentDrawer: undefined }),

    closeSubagentView: () => set({ subagentView: undefined }),

    openUsageStats: () => set({ usageStatsOpen: true }),

    closeUsageStats: () => set({ usageStatsOpen: false }),

    openApiAggregation: () => set({ apiAggregationOpen: true }),

    closeApiAggregation: () => set({ apiAggregationOpen: false }),

    openExtensionSoftware: () => set({ extensionSoftwareOpen: true }),

    closeExtensionSoftware: () => set({ extensionSoftwareOpen: false }),

    toggleTheme: () => {
      const next: Theme = get().theme === "light" ? "dark" : "light";
      get().setTheme(next);
    },

    setTheme: (theme) => {
      applyTheme(theme);
      set({ theme });
    },

    setSettingsOpen: (open, tab) =>
      set((s) => ({ settingsOpen: open, settingsTab: tab ?? s.settingsTab })),

    setSearchOpen: (open) => set({ searchOpen: open }),
  };
}
