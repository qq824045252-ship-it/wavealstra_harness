import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import BrowserView from "../src/renderer/src/components/artifact/BrowserView";
import { useAppStore } from "./browser-tabs-ui-store";
import type { BrowserTabsState } from "../src/shared/browser-tabs";

export async function run(base: string): Promise<string[]> {
  const { ipcRenderer: ipc } = (window as any).require("electron");
  const invoke = (method: string, ...args: unknown[]) => ipc.invoke("tabs-test", method, ...args);
  window.api = { browser: {
    open: (...args: unknown[]) => { void invoke("open", ...args); },
    getTabs: () => invoke("getTabsState"), ensureTab: (...args: unknown[]) => invoke("ensureTab", ...args),
    selectTab: (...args: unknown[]) => { void invoke("selectTab", ...args); },
    closeTab: (...args: unknown[]) => { void invoke("closeTab", ...args); },
    hide: () => { void invoke("hide"); }, close: () => { void invoke("close"); },
    setRect: (...args: unknown[]) => { void invoke("setBounds", ...args); },
    navigate: (...args: unknown[]) => { void invoke("navigate", ...args); },
    hardReload: () => { void invoke("hardReload"); }, back: () => {}, forward: () => {}, openExternal: () => {},
    onTabsChanged: (callback: (state: BrowserTabsState) => void) => {
      const handler = (_e: unknown, state: BrowserTabsState) => callback(state);
      ipc.on("tabs-state", handler); return () => ipc.removeListener("tabs-state", handler);
    },
  }} as unknown as NonNullable<Window["api"]>;
  const checks: string[] = [];
  const delay = () => new Promise(resolve => setTimeout(resolve, 30));
  const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    for (let i = 0; i < 150; i++) { if (await predicate()) return; await delay(); }
    throw new Error(`Timed out UI: ${label}; state=${JSON.stringify(await invoke("getTabsState"))}; store=${JSON.stringify(useAppStore.getState())}; dom=${container.innerHTML.slice(0,2000)}`);
  };
  const assert = (ok: unknown, label: string) => { if (!ok) throw new Error(label); };
  const state = (): Promise<BrowserTabsState> => invoke("getTabsState");
  const container = document.createElement("div"); document.body.append(container);
  let root = createRoot(container);
  useAppStore.getState().setBrowserUrl(`${base}/a`, "gadget-a");
  flushSync(() => root.render(<BrowserView />));
  await until(async () => (await state()).tabs.some(tab => tab.url === `${base}/a` && !tab.loading), "open A");
  const a = (await state()).tabs.find(tab => tab.gadgetId === "gadget-a")!;
  await invoke("eval", a.id, "document.querySelector('#draft').value='retained A'");
  useAppStore.getState().setBrowserUrl(`${base}/b`);
  await until(async () => (await state()).tabs.some(tab => tab.url === `${base}/b` && !tab.loading), "open B");
  const b = (await state()).tabs.find(tab => tab.url === `${base}/b`)!;
  await until(() => container.querySelectorAll('[role="tab"]').length === 2, "two visible tabs");
  (container.querySelectorAll('[role="tab"]')[0] as HTMLButtonElement).click();
  await until(async () => (await state()).activeTabId === a.id, "select A");
  assert(await invoke("eval", a.id, "document.querySelector('#draft').value") === "retained A", "tab click preserved input");
  checks.push("actual BrowserView renders and selects two native tabs while preserving input");

  (container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();
  await until(async () => (await state()).activeTabId === b.id, "select B before source update");
  await invoke("markGadgetUpdated", "gadget-a");
  assert((await state()).activeTabId === b.id, "source update does not select background Gadget");
  (container.querySelectorAll('[role="tab"]')[0] as HTMLButtonElement).click();
  await until(async () => (await invoke("eval", a.id, "window.renderVersion")) === 2, "updated Gadget reload on UI selection");
  const updatedDocument = await invoke("eval", a.id, "window.created");
  (container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click(); await delay();
  (container.querySelectorAll('[role="tab"]')[0] as HTMLButtonElement).click(); await delay();
  assert(await invoke("eval", a.id, "window.created") === updatedDocument, "subsequent UI selection must not refresh unchanged source");
  checks.push("background Gadget source update refreshes once through the real tab selection control");

  const address = container.querySelector(".extension-url-input") as HTMLInputElement;
  address.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(address, `${base}/do-not-navigate-on-tab-click`);
  address.dispatchEvent(new Event("input", { bubbles: true }));
  await delay();
  const bButton = container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement;
  bButton.focus(); bButton.click();
  await until(async () => (await state()).activeTabId === b.id, "select B");
  assert((await state()).tabs.find(tab => tab.id === a.id)?.url === `${base}/a`, "address blur during tab switch must not navigate A");
  // Native navigation changes its URL without changing the stable tab key.
  await invoke("navigateForAutomation", `${base}/nested`);
  await until(() => useAppStore.getState().browserUrlByTask.one === `${base}/nested`, "native URL sync");
  await invoke("eval", b.id, "document.querySelector('#draft').value='retained navigated B'");
  useAppStore.setState({ activeTaskId: "two" });
  useAppStore.getState().setBrowserUrl(`${base}/c`);
  await until(async () => (await state()).tabs.some(tab => tab.url === `${base}/c` && !tab.loading), "task two C");
  useAppStore.setState({ activeTaskId: "one" });
  await until(async () => (await state()).activeTabId === b.id, "return to retained B identity");
  assert(await invoke("eval", b.id, "document.querySelector('#draft').value") === "retained navigated B", "task switch retained navigated DOM");
  assert((await state()).tabs.filter(tab => tab.taskId === "one").length === 2, "no duplicate tab from changed URL");
  checks.push("task switch restores original tab after in-page URL navigation without duplicate or reload");

  flushSync(() => root.unmount()); await delay();
  await invoke("navigateForAutomation", `${base}/hidden-navigation`);
  await invoke("eval", b.id, "document.querySelector('#draft').value='retained hidden B'");
  root = createRoot(container); flushSync(() => root.render(<BrowserView />));
  await until(async () => (await state()).activeTabId === b.id, "remount retains tab");
  await delay(); await delay();
  assert(await invoke("eval", b.id, "document.querySelector('#draft').value") === "retained hidden B", "panel remount retained live hidden-navigation DOM");
  assert((await state()).tabs.filter(tab => tab.taskId === "one").length === 2, "remount doesn't create URL-derived duplicate");
  assert(useAppStore.getState().browserUrlByTask.one === `${base}/hidden-navigation`, "remount reads live URL rather than replaying stale store URL");
  checks.push("dismiss, background navigation and remount preserve the live page, input and selected identity");

  const newButton = container.querySelector('[aria-label="新建标签页"]') as HTMLButtonElement;
  newButton.click();
  await until(() => container.querySelectorAll('[role="tab"]').length === 3, "new blank tab");
  const blank = (await state()).activeTabId!;
  assert(useAppStore.getState().browserUrlByTask.one === "", "blank tab clears address");
  await invoke("closeTab", blank);
  await until(async () => (await state()).activeTabId === b.id, "close selects sibling");
  await invoke("closeTab", b.id); await invoke("closeTab", a.id);
  await until(() => container.querySelectorAll('[role="tab"]').length === 0, "close last task tab");
  assert(!useAppStore.getState().browserUrlByTask.one, "last tab clears stale address");
  assert((await state()).tabs.some(tab => tab.taskId === "two"), "other task remains alive");
  checks.push("blank/close tab controls clear stale address and preserve other tasks");
  flushSync(() => root.unmount()); container.remove();
  return checks;
}
