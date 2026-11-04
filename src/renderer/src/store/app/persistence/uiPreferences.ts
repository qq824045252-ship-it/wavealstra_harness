/**
 * Sidebar Tree V2：空间展开状态持久（稳定 id，renderer/store 层 localStorage）。
 *
 * 默认值 = **全部收起**（产品决策：空间树的默认形态是折叠，展开是用户当次的选择）。
 * 存储语义是「用户显式展开过哪些空间」（展开集合），不再存「收起集合」：
 * 旧键存的是收起集合，无法区分「用户主动收起」与「默认未展开」，所以新键首次读取时
 * 忽略旧值并从空集合开始 —— 历史键保留不动，不回写、不删除，避免误清用户数据。
 */
export const SIDEBAR_EXPANDED_KEY = "mybuddy:sidebar-expanded";

export function loadSidebarExpanded(): string[] {
  try {
    if (typeof window === "undefined" || !window.localStorage) return [];
    const raw = window.localStorage.getItem(SIDEBAR_EXPANDED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x) => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveSidebarExpanded(ids: string[]): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(SIDEBAR_EXPANDED_KEY, JSON.stringify(ids));
  } catch {
    /* ignore storage errors */
  }
}

export const PANEL_PINNED_KEY = "mybuddy:panel-pinned";

export function loadPanelPinned(): boolean {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    return window.localStorage.getItem(PANEL_PINNED_KEY) === "true";
  } catch {
    return false;
  }
}

export function savePanelPinned(pinned: boolean): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(PANEL_PINNED_KEY, pinned ? "true" : "false");
  } catch {
    /* ignore storage errors */
  }
}
