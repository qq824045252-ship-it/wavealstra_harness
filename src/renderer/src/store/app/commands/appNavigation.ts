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
        draft: page === "chat" ? s.draft : null,
        hubMcpFocusName: page === "mcp" ? s.hubMcpFocusName : null,
        ...(page === "library" ? { libraryNav: null } : {}),
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
