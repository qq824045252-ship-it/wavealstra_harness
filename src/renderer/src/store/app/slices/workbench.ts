import { PANEL_RAIL_WIDTH, canvasPanelWidth } from "../../../lib/panelWidth";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { loadPanelPinned, savePanelPinned } from "../persistence/uiPreferences";
import { findActiveTaskArtifact } from "../selectors";
import type { PanelMode } from "../types";
import { defaultFlyoutViewForArtifact } from "../workbench/panelPolicy";

export interface WorkbenchState {
  workspaceFilesCount: number;
  gadgetsCount: number;
  panelOpen: boolean;
  panelPinned: boolean;
  panelMode: PanelMode;
  browserPreviousPanelMode?: PanelMode | null;
  extensionView: PanelMode;
  extensionFlyoutOpen: boolean;
  extensionFlyoutPinned: boolean;
  extensionMenuOpen: boolean;
  artifactTabs: string[];
  activeArtifactId: string | null;
  panelWidth: number;
  panelExpanded: boolean;
  sidebarBeforePanelExpand: boolean | null;
  browserUrlByTask: Record<string, string>;
  browserUrlInput: string;
  browserFrameKey: number;
}

export function createWorkbenchState(): WorkbenchState {
  return {
    workspaceFilesCount: 0,
    gadgetsCount: 0,
    panelOpen: false,
    panelPinned: loadPanelPinned(),
    panelMode: "file",
    browserPreviousPanelMode: null,
    extensionView: "overview",
    extensionFlyoutOpen: false,
    extensionFlyoutPinned: false,
    extensionMenuOpen: false,
    artifactTabs: [],
    activeArtifactId: null,
    panelWidth: PANEL_RAIL_WIDTH,
    panelExpanded: false,
    sidebarBeforePanelExpand: null,
    browserUrlByTask: {},
    browserUrlInput: "",
    browserFrameKey: 0,
  };
}

export function createWorkbenchActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "setWorkspaceFilesCount"
  | "setGadgetsCount"
  | "togglePanelPinned"
  | "showOverview"
  | "showArtifacts"
  | "showAllArtifacts"
  | "showWorkspace"
  | "showGadgets"
  | "showTerminal"
  | "refreshBrowser"
  | "showChanges"
  | "showAllChanges"
  | "openExtensionFlyout"
  | "toggleExtensionFlyout"
  | "closeExtensionFlyout"
  | "toggleExtensionFlyoutPinned"
  | "setExtensionMenuOpen"
  | "setPanelMode"
> {
  const { get, set } = storeContext;
  return {
    setWorkspaceFilesCount: (count: number) =>
      set({ workspaceFilesCount: count }),

    setGadgetsCount: (count: number) => set({ gadgetsCount: count }),

    togglePanelPinned: () => {
      const next = !get().panelPinned;
      savePanelPinned(next);
      set({ panelPinned: next });
    },

    showOverview: () => {
      set({
        panelOpen: true,
        panelMode: "overview",
        extensionView: "overview",
        extensionFlyoutOpen: false,
        panelWidth: PANEL_RAIL_WIDTH,
      });
    },

    showArtifacts: () => {
      set({
        panelOpen: true,
        panelMode: "artifacts",
        extensionView: "artifacts",
        extensionFlyoutOpen: false,
        extensionFlyoutPinned: false,
        panelWidth: PANEL_RAIL_WIDTH,
      });
    },

    showAllArtifacts: () => {
      set({
        panelOpen: true,
        panelMode: "artifacts",
        extensionView: "artifacts",
        extensionFlyoutOpen: false,
        extensionFlyoutPinned: false,
        panelWidth: PANEL_RAIL_WIDTH,
      });
    },

    showWorkspace: () => {
      set({
        panelOpen: true,
        panelMode: "workspace",
        extensionView: "workspace",
        extensionFlyoutOpen: false,
        panelWidth: PANEL_RAIL_WIDTH,
      });
    },

    showGadgets: () => {
      set({
        panelOpen: true,
        panelMode: "gadgets",
        extensionView: "gadgets",
        extensionFlyoutOpen: false,
        extensionFlyoutPinned: false,
        panelWidth: PANEL_RAIL_WIDTH,
      });
    },

    showTerminal: () => {
      const s = get();
      set({
        panelOpen: true,
        panelMode: "terminal",
        extensionView: "terminal",
        extensionFlyoutOpen: false,
        panelWidth: canvasPanelWidth(s.sidebarCollapsed),
      });
    },

    refreshBrowser: () =>
      set((s) => ({ browserFrameKey: s.browserFrameKey + 1 })),

    showChanges: () => {
      set({
        panelOpen: true,
        panelMode: "changes",
        extensionView: "changes",
        extensionFlyoutOpen: false,
        extensionFlyoutPinned: false,
        panelWidth: PANEL_RAIL_WIDTH,
      });
    },

    showAllChanges: () => {
      set({
        panelOpen: true,
        panelMode: "changes",
        extensionView: "changes",
        extensionFlyoutOpen: false,
        extensionFlyoutPinned: false,
        panelWidth: PANEL_RAIL_WIDTH,
      });
    },

    openExtensionFlyout: (mode) => {
      const s = get();
      if (s.artifactTabs.length === 0) return;
      const artifact = findActiveTaskArtifact(s, s.activeArtifactId);
      const view =
        mode && mode !== "file" ? mode : defaultFlyoutViewForArtifact(artifact);
      if (view === "overview") get().showOverview();
      else if (view === "artifacts") get().showArtifacts();
      else if (view === "workspace") get().showWorkspace();
      else if (view === "terminal") get().showTerminal();
      else if (view === "browser") get().showBrowser();
      else if (view === "changes") get().showChanges();
    },

    toggleExtensionFlyout: () => {
      const s = get();
      if (s.artifactTabs.length === 0) return;
      if (s.extensionFlyoutOpen) {
        set({ extensionFlyoutOpen: false, extensionFlyoutPinned: false });
      } else {
        get().openExtensionFlyout();
      }
    },

    closeExtensionFlyout: () => {
      if (get().extensionFlyoutPinned) return;
      set({ extensionFlyoutOpen: false });
    },

    toggleExtensionFlyoutPinned: () =>
      set((s) => ({ extensionFlyoutPinned: !s.extensionFlyoutPinned })),

    setExtensionMenuOpen: (open) => set({ extensionMenuOpen: open }),

    setPanelMode: (mode) =>
      set((s) => ({
        panelMode: mode,
        extensionView: mode === "file" ? s.extensionView : mode,
      })),
  };
}
