import { realpath, mkdir } from "node:fs/promises";
import { isPathInsideOrEqual } from "../../task/TaskExecutionWorkspace";
import { join } from "node:path";
import type { WebContents } from "electron";
import { pageInspectionService, type PageInspectionSession } from "../../artifact/PageInspectionService";
import type { AutomationScope } from "../AutomationScope";
import { BrowserAccessibility } from "./BrowserAccessibility";
import { BrowserPageEvents } from "./BrowserPageEvents";

export interface BrowserPageRuntime {
  session: PageInspectionSession;
  events: BrowserPageEvents;
  accessibility: BrowserAccessibility;
  dispose(): void;
}

/** The inspection service owns the connection; this registry owns only its consumers. */
export class BrowserPageRuntimes {
  private readonly pages = new Map<WebContents, { root?: string; ready: Promise<BrowserPageRuntime> }>();
  constructor(private readonly observationSlot: string) {}

  get(wc: WebContents, scope: AutomationScope, taskRoot?: string): Promise<BrowserPageRuntime> {
    const existing = this.pages.get(wc);
    if (existing) {
      if (existing.root !== taskRoot) throw new Error("Page task directory changed; refusing to share transfer state");
      return scope.run(() => existing.ready);
    }
    const session = pageInspectionService.sessionFor(wc, "browser-host") ?? pageInspectionService.acquire(wc, "browser-host");
    const initialize = async (): Promise<BrowserPageRuntime> => {
      await session.attach(wc.debugger);
      let downloads: string | undefined;
      if (taskRoot) {
        const root = await realpath(taskRoot);
        await mkdir(join(root, "downloads"), { recursive: true });
        downloads = await realpath(join(root, "downloads"));
        if (!isPathInsideOrEqual(root, downloads)) throw new Error("Browser downloads directory escapes the task root");
      }
      const events = new BrowserPageEvents(session, wc, downloads);
      const accessibility = new BrowserAccessibility(session, this.observationSlot);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true; events.dispose(); accessibility.dispose();
        wc.off("destroyed", dispose); unsubscribe();
        if (this.pages.get(wc) === record) this.pages.delete(wc);
      };
      const unsubscribe = session.subscribeProtocol(method => { if (method === "Inspector.detached") dispose(); });
      wc.once("destroyed", dispose);
      try { await events.start(); if (disposed) throw new Error("Page inspection ended during initialization"); }
      catch (error) { dispose(); throw error; }
      return { session, events, accessibility, dispose };
    };
    // Install before enabling domains: concurrent callers share one initialization.
    const record = { root: taskRoot, ready: Promise.resolve().then(initialize).catch(error => { if (this.pages.get(wc) === record) this.pages.delete(wc); throw error; }) };
    this.pages.set(wc, record);
    void record.ready.catch(() => {});
    return scope.run(() => record.ready);
  }
}
