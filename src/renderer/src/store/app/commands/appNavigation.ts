import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export function createAppNavigationActions(
  storeContext: AppContext,
): Pick<AppActions, "setPage" | "openHubMcp" | "requestLibraryNav"> {
  const { get, set } = storeContext;
  return {
    setPage: (page) =>
      set((s) => ({
        page: (page as string) === "bot" ? "chat" : page,
        historicalTeamWork: null,
        botNavigationEpoch: s.botNavigationEpoch + 1,
        // Legacy navigation must preserve ordinary task drafts without reviving removed Bot mode.
        draft: page === "chat" || (page as string) === "bot" ? s.draft : null,
        hubMcpFocusName: page === "mcp" ? s.hubMcpFocusName : null,
        ...(page !== "workspace" ? { activeWorkspaceId: null } : {}),
      })),

    openHubMcp: (serverName) =>
      set({
        page: "mcp",
        hubMcpFocusName: serverName ?? null,
        draft: null,
        activeWorkspaceId: null,
      }),

    requestLibraryNav: (dest) => set({ page: "library", libraryNav: dest }),
  };
}
