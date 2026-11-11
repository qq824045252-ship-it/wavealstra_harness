import {
  HOME_BROWSER_KEY,
  normalizeBrowserUrl,
} from "../../../lib/browserLinks";
import { canvasPanelWidth } from "../../../lib/panelWidth";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export function createBrowserNavigationActions(
  storeContext: AppContext,
): Pick<AppActions, "showBrowser" | "setBrowserUrl" | "navigateBrowser"> {
  const { get, set } = storeContext;
  return {
    showBrowser: () => {
      const s = get();
      const key = s.activeTaskId ?? HOME_BROWSER_KEY;
      const browserUrl = s.browserUrlByTask[key] ?? "";
      const currentMode = s.panelMode;
      const previousMode =
        currentMode !== "browser" ? currentMode : s.browserPreviousPanelMode;
      set({
        panelOpen: true,
        panelMode: "browser",
        extensionView: "browser",
        extensionFlyoutOpen: false,
        browserUrlInput: browserUrl,
        browserPreviousPanelMode: previousMode ?? "overview",
        panelWidth: browserUrl
          ? canvasPanelWidth(s.sidebarCollapsed)
          : canvasPanelWidth(s.sidebarCollapsed),
      });
    },

    setBrowserUrl: (url, gadgetId) => {
      const key = get().activeTaskId ?? HOME_BROWSER_KEY;
      const tabs = { ...get().browserTabByTask };
      delete tabs[key];
      const bindings = { ...get().browserGadgetByTask };
      delete bindings[key];
      if (url && gadgetId) bindings[key] = { gadgetId, url };
      const identity = { browserTabByTask: tabs, browserGadgetByTask: bindings, browserNavigationVersion: get().browserNavigationVersion + 1 };
      if (!url) {
        set((s) => {
          const urls = { ...s.browserUrlByTask };
          delete urls[key];
          return { ...identity, browserUrlByTask: urls, browserUrlInput: "" };
        });
        return;
      }
      const currentMode = get().panelMode;
      const previousMode =
        currentMode !== "browser"
          ? currentMode
          : get().browserPreviousPanelMode;
      set((s) => ({
        ...identity,
        browserUrlByTask: { ...s.browserUrlByTask, [key]: url },
        browserUrlInput: url,
        browserPreviousPanelMode: previousMode ?? "gadgets",
        panelMode: "browser",
        extensionView: "browser",
        extensionFlyoutOpen: false,
        panelOpen: true,
        panelWidth: canvasPanelWidth(s.sidebarCollapsed),
      }));
    },

    navigateBrowser: () => {
      const url = normalizeBrowserUrl(get().browserUrlInput);
      if (url) get().setBrowserUrl(url);
    },
  };
}
