import type { Space } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import {
  loadSidebarExpanded,
  saveSidebarExpanded,
} from "../persistence/uiPreferences";

export interface WorkspacesState {
  spaces: Space[];
  taskSectionCollapsed: boolean;
  expandedSpaceIds: string[];
}

export function createWorkspacesState(): WorkspacesState {
  return {
    spaces: [],
    taskSectionCollapsed: false,
    expandedSpaceIds: loadSidebarExpanded(),
  };
}

export function createWorkspacesActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  "toggleTaskSection" | "toggleSpaceCollapsed" | "setAllSpacesExpanded"
> {
  const { get, set } = storeContext;
  return {
    toggleTaskSection: () =>
      set((s) => ({ taskSectionCollapsed: !s.taskSectionCollapsed })),

    toggleSpaceCollapsed: (id) => {
      set((s) => {
        // 存储即「展开集合」：收起 = 从集合移除，展开 = 加入集合。
        // 默认（空集合）= 全部收起，所以新空间、新识别到的空间都从收起开始。
        const next = s.expandedSpaceIds.includes(id)
          ? s.expandedSpaceIds.filter((x) => x !== id)
          : [...s.expandedSpaceIds, id];
        saveSidebarExpanded(next);
        return { expandedSpaceIds: next };
      });
    },

    setAllSpacesExpanded: (expanded) => {
      set((s) => {
        const next = expanded ? s.spaces.map((space) => space.id) : [];
        saveSidebarExpanded(next);
        return { expandedSpaceIds: next };
      });
    },
  };
}
