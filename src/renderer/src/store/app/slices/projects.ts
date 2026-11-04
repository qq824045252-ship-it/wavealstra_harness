import type { ProjectDto } from "../../../../../shared/project-domain";
import { normalizeProjectWorkspaceTab } from "../../../lib/projectWorkspace";
import type {
  ProjectNavDestination,
  ProjectWorkspaceTab,
} from "../../../lib/projectWorkspace";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export interface ProjectsState {
  projects: ProjectDto[];
  activeProjectId: string | null;
  activeProjectTab: ProjectWorkspaceTab;
  projectNavRequest: ProjectNavDestination | null;
}

export function createProjectsState(): ProjectsState {
  return {
    projects: [],
    activeProjectId: null,
    activeProjectTab: "activity",
    projectNavRequest: null,
  };
}

export function createProjectsActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "closeProjectDetails"
  | "setActiveProjectTab"
  | "clearProjectNavRequest"
  | "refreshProjects"
> {
  const { get, set } = storeContext;
  return {
    closeProjectDetails: () =>
      set({
        activeProjectId: null,
        activeProjectTab: "activity",
        projectNavRequest: null,
      }),

    setActiveProjectTab: (tab) =>
      set({ activeProjectTab: normalizeProjectWorkspaceTab(tab) }),

    clearProjectNavRequest: () => set({ projectNavRequest: null }),

    refreshProjects: async (includeArchived = false) => {
      const projects =
        (await storeContext.getApi()?.db?.listProjects?.(includeArchived)) ??
        [];
      set({ projects });
    },
  };
}
