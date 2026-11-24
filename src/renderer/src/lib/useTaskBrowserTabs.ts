import { useEffect, useState } from "react";
import type { BrowserTabsState } from "@shared/browser-tabs";

export function useTaskBrowserTabs(taskId: string) {
  const [state, setState] = useState<BrowserTabsState>();

  useEffect(() => {
    const browser = window.api?.browser;
    if (!browser?.getTabs || !browser.onTabsChanged) return;
    let disposed = false;
    let receivedEvent = false;
    const off = browser.onTabsChanged(tabs => {
      receivedEvent = true;
      if (!disposed) setState(tabs);
    });
    void browser.getTabs().then(tabs => {
      if (!disposed && !receivedEvent) setState(tabs);
    }).catch(console.error);
    return () => { disposed = true; off(); };
  }, []);

  return state?.tabs.filter(tab => tab.space === "task" && tab.taskId === taskId) ?? [];
}
