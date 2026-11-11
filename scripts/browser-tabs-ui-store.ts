import { create } from "zustand";
// The production BrowserView runs unchanged; only the surrounding app store is a
// fixture. Browser IPC below is backed by the real native BrowserHost.
export const useAppStore = create<any>((set, get) => ({
  activeTaskId: "one", activeModelId: "fixture", browserUrlByTask: {}, browserTabByTask: {},
  browserGadgetByTask: {}, browserFrameKey: 0, browserNavigationVersion: 0,
  selection: { status: "empty" }, browserPreviousPanelMode: "gadgets", panelOpen: true, panelMode: "browser",
  setBrowserUrl: (url: string | null, gadgetId?: string) => {
    const s = get(), key = s.activeTaskId ?? "__home__";
    const tabs = { ...s.browserTabByTask }, gadgets = { ...s.browserGadgetByTask };
    delete tabs[key]; delete gadgets[key];
    if (url && gadgetId) gadgets[key] = { gadgetId, url };
    set({ browserUrlByTask: { ...s.browserUrlByTask, [key]: url ?? "" }, browserGadgetByTask: gadgets,
      browserTabByTask: tabs, browserNavigationVersion: s.browserNavigationVersion + 1 });
  },
  refreshBrowser: () => set({ browserFrameKey: get().browserFrameKey + 1 }),
  showGadgets: () => set({ panelMode: "gadgets" }), appendComposer: () => {},
}));
