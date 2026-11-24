import { EventEmitter, once } from "node:events";
import type { BrowserTabInfo } from "../../shared/browser-tabs";

type Control = {
  tabId: string;
  mode: "manual" | "login" | "handoff";
  pending: boolean;
  confirmed?: boolean;
  retry?: boolean;
  challenge?: BrowserTabInfo["loginChallenge"];
};

/** The task owns browser access. A takeover drains admitted operations before
 * the page is presented, and later operations wait outside their action deadline. */
export class BrowserSpaceControls {
  private readonly controls = new Map<string, Control>();
  private readonly active = new Map<string, number>();
  private readonly events = new EventEmitter().setMaxListeners(0);

  constructor(private readonly changed: (tabId: string) => void) {}

  get(taskId: string): Readonly<Control> | undefined {
    return this.controls.get(taskId);
  }

  async enter(taskId: string, signal?: AbortSignal): Promise<() => void> {
    while (this.controls.has(taskId)) await once(this.events, taskId, { signal });
    signal?.throwIfAborted();
    this.active.set(taskId, (this.active.get(taskId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.active.get(taskId) ?? 1) - 1;
      if (remaining) { this.active.set(taskId, remaining); return; }
      this.active.delete(taskId);
      const request = this.controls.get(taskId);
      if (request?.pending) {
        request.pending = false;
        this.changed(request.tabId);
        this.events.emit(taskId);
      }
    };
  }

  take(taskId: string, tabId: string): void {
    if (this.controls.has(taskId)) return;
    this.controls.set(taskId, { tabId, mode: "manual", pending: this.active.has(taskId) });
    this.changed(tabId);
  }

  offer(taskId: string, tabId: string, mode: "login" | "handoff", challenge?: Control["challenge"]): () => void {
    if (this.controls.has(taskId)) throw new Error("任务浏览器正在由人工控制");
    const control: Control = { tabId, mode, challenge, pending: this.active.has(taskId) };
    this.controls.set(taskId, control);
    this.changed(tabId);
    return () => {
      if (this.controls.get(taskId) === control) this.clear(taskId);
    };
  }

  transfer(taskId: string, tabId: string): void {
    const control = this.controls.get(taskId);
    if (!control) return;
    control.tabId = tabId;
    this.changed(tabId);
  }

  answer(taskId: string, tabId: string): void {
    const control = this.controls.get(taskId);
    if (!control || control.tabId !== tabId) return;
    if (control.mode === "manual") this.clear(taskId);
    else if (control.mode === "login" && !control.pending) {
      control.confirmed = true;
      this.events.emit(taskId);
    }
  }

  async waitForLogin(taskId: string, signal?: AbortSignal): Promise<void> {
    const control = this.controls.get(taskId);
    while (control?.mode === "login" && this.controls.get(taskId) === control) {
      signal?.throwIfAborted();
      if (control.confirmed) { control.confirmed = false; return; }
      await once(this.events, taskId, { signal });
    }
    throw new Error("登录标签已关闭");
  }

  requestLoginRetry(taskId: string): void {
    const control = this.controls.get(taskId);
    if (control?.mode !== "login") return;
    control.retry = true;
    this.changed(control.tabId);
  }

  clear(taskId: string): void {
    const control = this.controls.get(taskId);
    if (!control) return;
    this.controls.delete(taskId);
    this.changed(control.tabId);
    this.events.emit(taskId);
  }
}
