import { useAppStore } from "@/store/appStore";
import { reconcileGadgetBrowser } from "./gadgetBrowserBinding";

let navigationEpoch = 0;

/** Capture intent before asynchronous work so newer navigation always wins. */
export function gadgetBrowserTarget(): () => boolean {
  const initial = useAppStore.getState();
  const epoch = navigationEpoch;
  return () => {
    const current = useAppStore.getState();
    return epoch === navigationEpoch && current.page === initial.page && current.activeTaskId === initial.activeTaskId
      && current.browserNavigationVersion === initial.browserNavigationVersion;
  };
}

/** The existing side browser owns navigation and native WebContents lifetime. */
export function openGadgetBrowser(gadgetId: string, url: string): void {
  useAppStore.getState().setBrowserUrl(url, gadgetId);
  // BrowserView selects the stable Gadget tab; reopening must preserve unsaved DOM state.
}

export function subscribeGadgetBrowser(): (() => void) | undefined {
  const api = window.api?.gadget;
  if (!api) return;
  const offNavigation = useAppStore.subscribe((current, previous) => {
    if (current.page !== previous.page || current.activeTaskId !== previous.activeTaskId
      || current.browserNavigationVersion !== previous.browserNavigationVersion
      || (previous.panelOpen && !current.panelOpen)) navigationEpoch++;
  });
  let disposed = false;
  let openRequest = 0;
  const requests = new Map<string, number>();
  const off = api.onChanged((event) => {
    const state = useAppStore.getState();
    if (event.type === "open-requested") {
      if (state.page !== "chat" || state.activeTaskId !== event.taskId) return;
      const isCurrent = gadgetBrowserTarget();
      const request = ++openRequest;
      void api.get(event.gadgetId).then((item) => {
        if (!disposed && request === openRequest && isCurrent() && item?.runtime.status === 'running' && item.runtime.url) {
          openGadgetBrowser(item.id, item.runtime.url);
        }
      }).catch(console.error);
    } else if (event.type === "runtime" || event.type === "updated" || event.type === "deleted") {
      const request = (requests.get(event.gadgetId) ?? 0) + 1;
      requests.set(event.gadgetId, request);
      if (event.type === 'deleted') return;
      if (!Object.values(state.browserGadgetByTask).some(binding => binding.gadgetId === event.gadgetId)) return;
      // Read current runtime only. Runtime notifications must never start a service.
      void api.get(event.gadgetId).then((item) => {
        if (disposed || requests.get(event.gadgetId) !== request || !item) return;
        useAppStore.setState(current => reconcileGadgetBrowser(current, item.runtime, event.type === 'updated' && event.sourceChanged === true));
      }).catch(console.error);
    }
  });
  return () => { disposed = true; off(); offNavigation(); };
}
