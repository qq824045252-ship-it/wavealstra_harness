import { applyTheme, getInitialTheme } from "../../../lib/theme";
import type { Theme } from "../../../lib/theme";
import type { Page } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import type { SettingsTab } from "../types";

export interface NotificationMessageFocus {
  messageId: string;
  toolCallId?: string;
  interactionId?: string;
}

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
  answerRuleTurnTarget?: { taskId: string; inputId: string };
  notificationMessageTarget?: NotificationMessageFocus & { taskId: string };
  answerRuleSeed?: { question?: string; answer?: string; projectId?: string;
    title?: string; instruction?: string; evidencePaths?: string[]; turn?: { taskId: string; inputId: string } };
  activeWorkspaceId: string | null;
  subagentDrawer?: { instanceId: string };
  /** 子代理对话页：进入某个子会话（与主聊天共用同一个外壳，可导航回父任务） */
  subagentView?: { taskId: string; subagentId: string };
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
    answerRuleSeed: undefined,
    answerRuleTurnTarget: undefined,
    notificationMessageTarget: undefined,
    activeWorkspaceId: null,
    subagentDrawer: undefined as { instanceId: string } | undefined,
    subagentView: undefined as { taskId: string; subagentId: string } | undefined,
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
  | "openExtensionSoftware"
  | "closeExtensionSoftware"
  | "toggleTheme"
  | "setTheme"
  | "setSettingsOpen"
> {
  const { get, set } = storeContext;
  return {
    openWorkspaceDetail: (spaceId) =>
      set({ activeWorkspaceId: spaceId, page: "workspace", notificationMessageTarget: undefined }),

    closeWorkspaceDetail: () => set({ activeWorkspaceId: null }),

    openSubagentDrawer: (instanceId) => set({ subagentDrawer: { instanceId } }),

    closeSubagentDrawer: () => set({ subagentDrawer: undefined }),

    openSubagentView: (taskId, subagentId) =>
      set({ subagentView: { taskId, subagentId }, subagentDrawer: undefined }),

    closeSubagentView: () => set({ subagentView: undefined }),





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
      set((s) => ({ settingsOpen: open, settingsTab: tab ?? s.settingsTab, answerRuleSeed: undefined })),

  };
}
