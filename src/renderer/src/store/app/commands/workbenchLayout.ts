import { HOME_BROWSER_KEY } from "../../../lib/browserLinks";
import {
  PANEL_RAIL_WIDTH,
  clampCanvasPanelWidth,
  clampPanelWidth,
} from "../../../lib/panelWidth";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

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
          panelWidth: clampPanelWidth(s.panelWidth, sidebarCollapsed),
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
      set((s) => {
        const key = s.activeTaskId ?? HOME_BROWSER_KEY;
        const canvasOpen =
          s.panelMode === "browser" && Boolean(s.browserUrlByTask[key]);
        return {
          panelWidth: canvasOpen
            ? clampCanvasPanelWidth(w, s.sidebarCollapsed)
            : clampPanelWidth(w, s.sidebarCollapsed),
        };
      }),

    togglePanelExpanded: () =>
      set((s) => {
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
