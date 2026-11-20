import {
  PANEL_RAIL_WIDTH,
  clampCanvasPanelWidth,
  clampPanelWidth,
} from "../../../lib/panelWidth";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { selectCanvasPanelOpen } from "../selectors";

export function createWorkbenchLayoutActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  "toggleSidebar" | "closePanel" | "setPanelWidth" | "togglePanelExpanded"
> {
  const { get, set } = storeContext;
  return {
    toggleSidebar: () =>
      set((s) => {
        const sidebarCollapsed = !s.sidebarCollapsed;
        return {
          sidebarCollapsed,
          // 侧栏显隐会改变主区宽度，需重新夹紧右栏，避免聊天区被压穿最小宽度
          panelWidth: selectCanvasPanelOpen(s)
            ? clampCanvasPanelWidth(s.panelWidth, sidebarCollapsed)
            : clampPanelWidth(s.panelWidth, sidebarCollapsed),
        };
      }),

    closePanel: () =>
      set((s) => ({
        panelOpen: false,
        extensionFlyoutOpen: false,
        extensionFlyoutPinned: false,
        extensionMenuOpen: false,
        panelExpanded: false,
        panelWidth: PANEL_RAIL_WIDTH,
        sidebarCollapsed:
          s.sidebarBeforePanelExpand !== null
            ? s.sidebarBeforePanelExpand
            : s.sidebarCollapsed,
        sidebarBeforePanelExpand: null,
      })),

    setPanelWidth: (w) =>
      set((s) => ({
          panelWidth: selectCanvasPanelOpen(s)
            ? clampCanvasPanelWidth(w, s.sidebarCollapsed)
            : clampPanelWidth(w, s.sidebarCollapsed),
      })),

    togglePanelExpanded: (keepModuleList = false) =>
      set((s) => {
        if (keepModuleList) return { panelExpanded: !s.panelExpanded, sidebarBeforePanelExpand: null };
        if (s.panelExpanded) {
          return {
            panelExpanded: false,
            sidebarCollapsed:
              s.sidebarBeforePanelExpand !== null
                ? s.sidebarBeforePanelExpand
                : s.sidebarCollapsed,
            sidebarBeforePanelExpand: null,
          };
        }
        return {
          panelExpanded: true,
          sidebarBeforePanelExpand: s.sidebarCollapsed,
          sidebarCollapsed: true,
        };
      }),
  };
}
