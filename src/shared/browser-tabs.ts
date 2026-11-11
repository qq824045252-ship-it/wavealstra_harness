/** Stable document identity is separate from its current navigated URL. */
export interface BrowserOpenOptions {
  key?: string;
  taskId?: string;
  gadgetId?: string;
  activate?: boolean;
  reload?: boolean;
}
export interface BrowserTabInfo {
  openerTabId?: string;
  id: string;
  key: string;
  taskId?: string;
  gadgetId?: string;
  url: string;
  title: string;
  loading: boolean;
}
export interface BrowserTabsState { activeTabId: string | null; tabs: BrowserTabInfo[]; }

export function browserTabKey(url: string, gadgetId?: string): string {
  return gadgetId ? `gadget:${gadgetId}` : `url:${url}`;
}
