import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export function createAppNavigationActions(
  storeContext: AppContext,
): Pick<AppActions, "setPage" | "openHubMcp" | "requestLibraryNav"> {
  const { get, set } = storeContext;
  return {
    setPage: (page) =>
      set((s) => ({
        page,
        selectMode: false,
        selectedMessageIds: [],
        // 离开 chat 首页即丢弃未落库的草稿；离开 workspace 清导航态
        draft: page === "chat" ? s.draft : null,
        hubMcpFocusName: page === "mcp" ? s.hubMcpFocusName : null,
        ...(page !== "workspace" ? { activeWorkspaceId: null } : {}),
      })),

    openHubMcp: (serverName) =>
      set({
        page: "mcp",
        hubMcpFocusName: serverName ?? null,
        selectMode: false,
        selectedMessageIds: [],
        draft: null,
        activeWorkspaceId: null,
      }),

    requestLibraryNav: (dest) => set({ page: "library", libraryNav: dest }),
  };
}
