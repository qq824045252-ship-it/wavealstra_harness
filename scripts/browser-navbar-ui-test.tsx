import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import BrowserNavBar from "../src/renderer/src/components/artifact/BrowserNavBar";

export function run(): string[] {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const results: string[] = [];
  let refreshes = 0;
  let navigated = "";
  const url = "http://localhost:8123/index.html";
  for (const editable of [true, false]) {
    flushSync(() => root.render(<BrowserNavBar url={url} editable={editable}
      onHardRefresh={() => refreshes++} onNavigate={(next) => { navigated = next; }} />));
    const buttons = container.querySelectorAll<HTMLButtonElement>(".extension-url-refresh");
    if (buttons.length !== 1) throw new Error(`Expected one refresh button, got ${buttons.length}`);
    buttons[0].click();
    if (buttons[0].getAttribute("aria-label") !== "硬刷新（忽略缓存）") throw new Error("Wrong refresh action");
    if (editable) {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      if (navigated !== url) throw new Error("Unchanged URL submit was swallowed");
      results.push("same URL Enter dispatches navigation");
    }
    results.push(`${editable ? "browser" : "artifact"}: one hard refresh button`);
  }
  if (refreshes !== 2) throw new Error("Hard refresh handler did not run");
  flushSync(() => root.unmount());
  container.remove();
  return results;
}
