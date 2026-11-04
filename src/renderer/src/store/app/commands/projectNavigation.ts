import { normalizeProjectWorkspaceTab } from "../../../lib/projectWorkspace";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export function createProjectNavigationActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "openProjectDetails"
  | "requestProjectsRoot"
  | "requestProjectNav"
  | "applyProjectNavigation"
> {
  const { get, set } = storeContext;
  return {
    openProjectDetails: (projectId, tab = "activity") => {
      const current = get().activeProjectId;
      if (current) {
        set({
          page: "projects",
          projectNavRequest:
            current === projectId
              ? { type: "tab", tab }
              : { type: "project", projectId, tab },
          draft: null,
          selectMode: false,
          selectedMessageIds: [],
        });
        return;
      }
      set({
        page: "projects",
        activeProjectId: projectId,
        activeProjectTab: normalizeProjectWorkspaceTab(tab),
        projectNavRequest: null,
        draft: null,
        selectMode: false,
        selectedMessageIds: [],
      });
    },

    requestProjectsRoot: () => {
      if (!get().activeProjectId) {
        set({ page: "projects" });
        return;
      }
      set({ page: "projects", projectNavRequest: { type: "project-list" } });
    },

    requestProjectNav: (dest) =>
      set({ page: "projects", projectNavRequest: dest }),

    applyProjectNavigation: (dest) => {
      if (dest.type === "project-list") {
        set({
          activeProjectId: null,
          activeProjectTab: "activity",
          projectNavRequest: null,
        });
        return;
      }
      if (dest.type === "tab") {
        set({
          activeProjectTab: normalizeProjectWorkspaceTab(dest.tab),
          projectNavRequest: null,
        });
        return;
      }
      // rail-back / rail-collapse / page 在 ProjectWorkspace.finishGuard / requestNavigate 中处理
      if (dest.type === "rail-back" || dest.type === "rail-collapse") return;
      if (dest.type === "page") {
        set({
          page: dest.page,
          projectNavRequest: null,
          draft: null,
          selectMode: false,
          selectedMessageIds: [],
        });
        return;
      }
      set({
        page: "projects",
        activeProjectId: dest.projectId,
        activeProjectTab: normalizeProjectWorkspaceTab(dest.tab ?? "activity"),
        projectNavRequest: null,
        draft: null,
        selectMode: false,
        selectedMessageIds: [],
      });
    },
  };
}
