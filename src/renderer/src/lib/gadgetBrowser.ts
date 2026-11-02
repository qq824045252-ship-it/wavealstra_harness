import { useAppStore } from "@/store/appStore";
import { HOME_BROWSER_KEY } from "./browserLinks";

/** The existing side browser owns navigation and native WebContents lifetime. */
export function openGadgetBrowser(url: string): void {
  // The side browser retains hidden documents. Explicit Open must reload a
  // retained Gadget whose source may have changed while its list was visible.
  window.api?.browser?.open(url, { reload: true });
  useAppStore.getState().setBrowserUrl(url);
}

export function subscribeGadgetBrowser(): (() => void) | undefined {
  const api = window.api?.gadget;
  if (!api) return;
  return api.onChanged((event) => {
    const state = useAppStore.getState();
    if (event.type === "open-requested") {
      if (state.page !== "chat" || state.activeTaskId !== event.taskId) return;
      void api.get(event.gadgetId).then((item) => {
        const current = useAppStore.getState();
        // The lookup can outlive a task/page switch. A background task never
        // takes over the browser the user is currently using.
        if (item?.runtime.url && current.page === "chat" && current.activeTaskId === event.taskId) openGadgetBrowser(item.runtime.url);
      }).catch(console.error);
    } else if (event.type === "updated" && state.panelOpen && state.panelMode === "browser") {
      const taskId = state.activeTaskId;
      const url = state.browserUrlByTask[taskId ?? HOME_BROWSER_KEY];
      if (!url) return;
      void api.get(event.gadgetId).then((item) => {
        const current = useAppStore.getState();
        if (item?.runtime.url === url && current.activeTaskId === taskId && current.panelOpen && current.panelMode === "browser"
          && current.browserUrlByTask[taskId ?? HOME_BROWSER_KEY] === url) current.refreshBrowser();
      }).catch(console.error);
    }
  });
}
