import { randomUUID } from "node:crypto";
import type { BrowserWindow, WebContents } from "electron";
import { selectAllModifier } from "../platform/input";
import type { BrowserHost } from "../browser/BrowserHost";
import { pageInspectionService, PageCaptureError, PageCaptureScope } from "../artifact/PageInspectionService";

export type UiTarget = "app" | "browser" | "artifact";
export type UiExecAction = "status" | "snapshot" | "find" | "inspect" | "click" | "fill" | "press" | "scroll" | "screenshot" | "wait_for";
export type UiWaitState = "attached" | "detached" | "visible" | "hidden";
export const UI_AUTOMATION_ERROR_CODES = [
  "TARGET_UNAVAILABLE", "INVALID_INPUT", "INVALID_LOCATOR", "INVALID_SELECTOR", "ELEMENT_NOT_FOUND",
  "ELEMENT_AMBIGUOUS", "ELEMENT_DISAPPEARED", "ELEMENT_NOT_VISIBLE", "ELEMENT_DISABLED", "ELEMENT_NOT_EDITABLE",
  "SCREENSHOT_EMPTY", "WAIT_TIMEOUT", "EXECUTION_FAILED", "UNSUPPORTED_ACTION", "CAPTURE_TIMEOUT", "SURFACE_CHANGED",
] as const;
export type UiAutomationErrorCode = (typeof UI_AUTOMATION_ERROR_CODES)[number];
export class UiAutomationError extends Error {
  constructor(public readonly code: UiAutomationErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "UiAutomationError";
  }
}

export interface UiExecInput {
  action: UiExecAction;
  target?: UiTarget;
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
  value?: string;
  key?: string;
  deltaX?: number;
  deltaY?: number;
  maxChars?: number;
  timeoutMs?: number;
  state?: UiWaitState;
}

export interface UiElementInfo {
  selector: string;
  tag: string;
  id?: string;
  role?: string;
  name?: string;
  text?: string;
  visible: boolean;
  disabled: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  outerHTML?: string;
  styles?: Record<string, string>;
}

export interface UiExecOutput {
  action: UiExecAction;
  target: UiTarget;
  url?: string;
  title?: string;
  detail?: string;
  text?: string;
  elements?: UiElementInfo[];
  screenshot?: Uint8Array;
}

export interface UiAutomationTargets {
  app: () => WebContents | null;
  browser: () => WebContents | null;
  artifact: () => WebContents | null;
  browserScreenshot?: (options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<Uint8Array>;
}

function clean(value: string | undefined, max: number): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (v.length > max) throw new UiAutomationError("INVALID_INPUT", "UI 定位参数过长");
  return v;
}

function locator(input: UiExecInput): { selector?: string; text?: string; role?: string; name?: string } {
  const result = {
    selector: clean(input.selector, 2_000),
    text: clean(input.text, 4_000),
    role: clean(input.role, 200),
    name: clean(input.name, 1_000),
  };
  if (!result.selector && !result.text && !result.role && !result.name) throw new UiAutomationError("INVALID_LOCATOR", "需要 selector / text / role / name 之一定位元素");
  return result;
}

function findScript(input: ReturnType<typeof locator>, limit: number, inspect: boolean): string {
  return `(() => {
    const q=${JSON.stringify(input)}; const limit=${Math.max(1, Math.min(200, limit))}; const inspect=${inspect};
    const norm=(v)=>String(v??'').replace(/\\s+/g,' ').trim();
    const roleOf=(el)=>{
      const explicit=norm(el.getAttribute('role')).toLowerCase(); if(explicit)return explicit;
      const tag=el.tagName.toLowerCase();
      if(tag==='button')return 'button';
      if(tag==='a'&&el.hasAttribute('href'))return 'link';
      if(tag==='textarea')return 'textbox';
      if(tag==='select')return el.multiple?'listbox':'combobox';
      if(tag==='option')return 'option';
      if(tag==='progress')return 'progressbar';
      if(tag==='input'){
        const type=String(el.getAttribute('type')||'text').toLowerCase();
        if(['button','submit','reset','image'].includes(type))return 'button';
        if(type==='checkbox')return 'checkbox';
        if(type==='radio')return 'radio';
        if(type==='range')return 'slider';
        if(type==='number')return 'spinbutton';
        if(type==='hidden')return '';
        return 'textbox';
      }
      return '';
    };
    const nameOf=(el)=>norm(el.getAttribute('aria-label')||(el.getAttribute('aria-labelledby')?document.getElementById(el.getAttribute('aria-labelledby'))?.textContent:'')||el.getAttribute('title')||(el instanceof HTMLInputElement?el.placeholder:'')||el.textContent);
    const path=(el)=>{ let ref=el.getAttribute('data-mybuddy-ui-ref'); if(!ref){ref=${JSON.stringify(randomUUID())}+'-'+(++window.__mybuddyUiRefCounter|| (window.__mybuddyUiRefCounter=1));el.setAttribute('data-mybuddy-ui-ref',ref);} return '[data-mybuddy-ui-ref="'+CSS.escape(ref)+'"]'; };
    let all; try{all=q.selector?Array.from(document.querySelectorAll(q.selector)):Array.from(document.querySelectorAll('body *'));}catch(e){return {ok:false,error:'invalid selector: '+String(e)}}
    const matches=all.filter(el=>{ if(!(el instanceof Element))return false; const n=nameOf(el),r=roleOf(el); if(q.role&&r!==q.role.toLowerCase())return false; if(q.name&&!n.toLowerCase().includes(q.name.toLowerCase()))return false; if(q.text&&!norm(el.textContent).toLowerCase().includes(q.text.toLowerCase()))return false; return true; }).slice(0,limit).map(el=>{ const r=el.getBoundingClientRect(); const s=getComputedStyle(el); const item={selector:path(el),tag:el.tagName.toLowerCase(),id:el.id||undefined,role:roleOf(el)||undefined,name:nameOf(el).slice(0,500)||undefined,text:norm(el.textContent).slice(0,1000)||undefined,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||'1')>0,disabled:Boolean(el.disabled||el.getAttribute('aria-disabled')==='true'),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}; if(inspect){item.outerHTML=el.outerHTML.slice(0,8000); item.styles={display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,zIndex:s.zIndex,pointerEvents:s.pointerEvents,overflowX:s.overflowX,overflowY:s.overflowY};} return item; });
    return {ok:true,matches};
  })()`;
}

type UiAwait = <T>(operation: () => Promise<T>) => Promise<T>;
const directUiAwait: UiAwait = operation => operation();

export class UiAutomationService {
  private browserHost: BrowserHost | null = null;
  constructor(private readonly targets: UiAutomationTargets) {}

  setBrowserHost(host: BrowserHost | null): void { this.browserHost = host; }

  private targetContents(target: UiTarget): WebContents | null {
    return target === "browser" && this.browserHost ? this.browserHost.inspectionWebContents : this.targets[target]();
  }

  available(target: UiTarget = "app"): boolean {
    try {
      const wc = this.targetContents(target);
      return Boolean(wc && !wc.isDestroyed());
    } catch {
      return false;
    }
  }

  anyAvailable(): boolean {
    return this.available("app") || this.available("browser") || this.available("artifact");
  }

  private wc(target: UiTarget): WebContents {
    const wc = this.targetContents(target);
    if (!wc || wc.isDestroyed()) throw new UiAutomationError("TARGET_UNAVAILABLE", `UI target 尚未就绪：${target}`, { target });
    return wc;
  }

  private async find(wc: WebContents, input: UiExecInput, limit = 20, inspect = false, wait: UiAwait = directUiAwait): Promise<UiElementInfo[]> {
    const result = await wait(() => wc.executeJavaScript(findScript(locator(input), limit, inspect), true)) as { ok?: boolean; error?: string; matches?: UiElementInfo[] };
    if (!result?.ok) {
      const message = result?.error || "UI 元素查找失败";
      throw new UiAutomationError(/^invalid selector:/i.test(message) ? "INVALID_SELECTOR" : "EXECUTION_FAILED", message);
    }
    return result.matches ?? [];
  }

  private async one(wc: WebContents, input: UiExecInput, wait: UiAwait = directUiAwait): Promise<UiElementInfo> {
    const rows = await this.find(wc, input, 10, false, wait);
    if (!rows.length) throw new UiAutomationError("ELEMENT_NOT_FOUND", "未找到目标 UI 元素");
    if (rows.length > 1) {
      const visible = rows.filter((row) => row.visible);
      if (visible.length === 1) return visible[0];
      throw new UiAutomationError("ELEMENT_AMBIGUOUS", `UI 定位不唯一：匹配 ${rows.length} 个元素`, { count: rows.length });
    }
    return rows[0];
  }

  private async click(wc: WebContents, element: UiElementInfo, check = () => {}, wait: UiAwait = directUiAwait): Promise<{ x: number; y: number }> {
    await wait(() => wc.executeJavaScript(`document.querySelector(${JSON.stringify(element.selector)})?.scrollIntoView({block:'center',inline:'center'})`, true));
    const current = await this.one(wc, { action: "find", selector: element.selector }, wait);
    if (!current) throw new UiAutomationError("ELEMENT_DISAPPEARED", "目标元素在点击前消失");
    if (!current.visible) throw new UiAutomationError("ELEMENT_NOT_VISIBLE", "目标元素不可见");
    if (current.disabled) throw new UiAutomationError("ELEMENT_DISABLED", "目标元素已禁用");
    check();
    const hit = await wait(() => wc.executeJavaScript(`(() => {const el=document.querySelector(${JSON.stringify(element.selector)});if(!el)return null;const r=el.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);const hit=document.elementFromPoint(x,y);return hit===el||el.contains(hit)?{x,y}:null})()`, true)) as { x: number; y: number } | null;
    check();
    if (!hit) throw new UiAutomationError("ELEMENT_NOT_VISIBLE", "目标被其它元素遮挡，请重新观察界面");
    const { x, y } = hit;
    wc.sendInputEvent({ type: "mouseMove", x, y });
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    return { x, y };
  }

  async execute(input: UiExecInput, signal?: AbortSignal): Promise<UiExecOutput> {
    if (signal?.aborted) throw new DOMException("界面操作已取消", "AbortError");
    const target = input.target ?? "app";
    if (input.action === "status") {
      if (!this.available(target)) return { action: input.action, target, detail: "unavailable" };
      const wc = this.wc(target);
      return { action: input.action, target, url: wc.getURL(), title: wc.getTitle(), detail: "ready" };
    }

    const wc = this.wc(target);
    const check = () => {
      if (signal?.aborted) throw new DOMException("界面操作已取消", "AbortError");
      if (wc.isDestroyed() || this.targetContents(target) !== wc) throw new UiAutomationError("SURFACE_CHANGED", "UI target 已变化，请重新观察");
    };
    // Renderer lookups can remain pending during navigation or a stalled renderer.
    // Bound the caller, and recheck before any later input dispatch. A late lookup
    // may settle, but must never resume a cancelled action on a different surface.
    const timeout = Math.max(100, Math.min(30_000, Math.round(input.timeoutMs ?? 5_000)));
    const deadline = Date.now() + timeout;
    const wait: UiAwait = async operation => {
      check();
      if (Date.now() >= deadline) throw new UiAutomationError("WAIT_TIMEOUT", `界面操作超时：${input.action} (${timeout}ms)`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new UiAutomationError("WAIT_TIMEOUT", `界面操作超时：${input.action} (${timeout}ms)`)), Math.max(1, deadline - Date.now()));
        onAbort = () => reject(new DOMException("界面操作已取消", "AbortError"));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      try {
        const result = await Promise.race([Promise.resolve().then(() => { check(); return operation(); }), interrupted]);
        check();
        if (Date.now() >= deadline) throw new UiAutomationError("WAIT_TIMEOUT", `界面操作超时：${input.action} (${timeout}ms)`);
        return result;
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    };
    const base = { action: input.action, target, url: wc.getURL(), title: wc.getTitle() } as const;

    if (input.action === "snapshot") {
      const page = await wait(() => pageInspectionService.getPageSnapshot(wc));
      // A reference belongs to this exact DOM node and document. Reordering keeps it
      // valid; replacement/navigation/new snapshots cannot silently retarget it.
      await wait(() => wc.executeJavaScript(`document.querySelectorAll('[data-mybuddy-ui-ref]').forEach(el=>el.removeAttribute('data-mybuddy-ui-ref'))`, true));
      const rows = await this.find(wc, { action: "find", selector: 'button,a,input,textarea,select,[role],[aria-label],[data-testid]' }, 200, false, wait);
      const max = Math.max(1_000, Math.min(100_000, Math.round(input.maxChars ?? 30_000)));
      return { ...base, text: page?.text.slice(0, max) ?? "", elements: rows, detail: `snapshot: ${rows.length} interactive elements` };
    }

    if (input.action === "find" || input.action === "inspect") {
      const rows = await this.find(wc, input, input.action === "inspect" ? 10 : 20, input.action === "inspect", wait);
      return { ...base, elements: rows, detail: `matched ${rows.length}` };
    }

    if (input.action === "screenshot") {
      if (target === "browser") {
        if (!this.browserHost && !this.targets.browserScreenshot) throw new UiAutomationError("TARGET_UNAVAILABLE", "浏览器截图宿主尚未就绪");
        try {
          const options = { signal, timeoutMs: input.timeoutMs };
          const screenshot = await (this.browserHost ? this.browserHost.captureScreenshot(options) : this.targets.browserScreenshot!(options));
          return { ...base, screenshot, detail: "captured" };
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          if (error instanceof PageCaptureError && error.code !== "CANCELLED") throw new UiAutomationError(error.code, error.message, { target });
          throw error;
        }
      }
      const scope = new PageCaptureScope(signal, input.timeoutMs, () => {
        if (this.targetContents(target) !== wc || wc.isDestroyed()) throw new PageCaptureError("SURFACE_CHANGED", "截图期间界面发生变化");
      });
      const image = await scope.run(() => wc.capturePage());
      // 空图拦截（与 BrowserAutomationService 同因：隐藏/0 尺寸 view 返回空图）
      if (image.isEmpty()) {
        throw new UiAutomationError("SCREENSHOT_EMPTY", `界面截图为空（target=${target} 可能被隐藏或尚未就绪）`, { target });
      }
      return { ...base, screenshot: image.toPNG(), detail: "captured" };
    }

    if (input.action === "wait_for") {
      const state = input.state ?? "visible";
      const timeout = Math.max(100, Math.min(30_000, Math.round(input.timeoutMs ?? 5_000)));
      const started = Date.now();
      while (Date.now() - started <= timeout) {
        check();
        const rows = await this.find(wc, input, 20, false, wait);
        const attached = rows.length > 0;
        const visible = rows.some((row) => row.visible);
        const done = state === "attached" ? attached : state === "detached" ? !attached : state === "visible" ? visible : !visible;
        if (done) return { ...base, elements: rows, detail: `${state} after ${Date.now() - started}ms` };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new UiAutomationError("WAIT_TIMEOUT", `wait_for 超时：${state} (${timeout}ms)`, { state, timeoutMs: timeout });
    }

    const element = await this.one(wc, input, wait);
    check();
    if (input.action === "click") {
      const point = await this.click(wc, element, check, wait);
      return { ...base, elements: [element], detail: `clicked ${element.selector} @ ${point.x},${point.y}` };
    }
    if (input.action === "fill") {
      const value = input.value ?? "";
      if (value.length > 100_000) throw new UiAutomationError("INVALID_INPUT", "value 过长");
      await this.click(wc, element, check, wait);
      const editable = await wait(() => wc.executeJavaScript(`(() => {const el=document.querySelector(${JSON.stringify(element.selector)}); if(!(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||(el instanceof HTMLElement&&el.isContentEditable)))return false; el.focus(); return true;})()`, true));
      if (!editable) throw new UiAutomationError("ELEMENT_NOT_EDITABLE", "目标元素不可编辑", { selector: element.selector });
      check();
      const selectModifier = selectAllModifier();
      wc.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: [selectModifier] });
      wc.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: [selectModifier] });
      wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
      await wait(() => wc.insertText(value));
      return { ...base, elements: [element], detail: `filled ${element.selector}` };
    }
    if (input.action === "press") {
      const key = clean(input.key, 80);
      if (!key) throw new UiAutomationError("INVALID_INPUT", "key 不能为空");
      await this.click(wc, element, check, wait);
      const tokens = key.split("+");
      const keyCode = tokens.pop()!;
      const aliases: Record<string, "control" | "alt" | "shift" | "meta"> = { ctrl: "control", control: "control", alt: "alt", shift: "shift", meta: "meta", cmd: "meta", command: "meta" };
      const modifiers = tokens.map(token => aliases[token.toLowerCase()]);
      if (modifiers.some(token => !token)) throw new UiAutomationError("INVALID_INPUT", "不支持的快捷键修饰符");
      wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      return { ...base, elements: [element], detail: `pressed ${key} on ${element.selector}` };
    }
    if (input.action === "scroll") {
      const dx = Number.isFinite(input.deltaX) ? Number(input.deltaX) : 0;
      const dy = Number.isFinite(input.deltaY) ? Number(input.deltaY) : 0;
      if (!dx && !dy) throw new UiAutomationError("INVALID_INPUT", "scroll 需要非零 delta_x 或 delta_y");
      const x = Math.round(element.bounds.x + element.bounds.width / 2);
      const y = Math.round(element.bounds.y + element.bounds.height / 2);
      wc.sendInputEvent({ type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, canScroll: true });
      return { ...base, elements: [element], detail: `scrolled ${dx},${dy} at ${x},${y}` };
    }
    throw new UiAutomationError("UNSUPPORTED_ACTION", `不支持的 ui_exec action：${input.action}`);
  }
}

function electronRuntime(): typeof import("electron") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("electron") as typeof import("electron");
}

let applicationWindow: BrowserWindow | null = null;

/** App identity is owned by createWindow, never by Electron window enumeration order. */
export function setUiAutomationMainWindow(window: BrowserWindow | null): void {
  applicationWindow = window;
}

function mainRenderer(): WebContents | null {
  try {
    const win = applicationWindow;
    return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : null;
  } catch {
    return null;
  }
}

function secondarySurface(target: "browser" | "artifact"): WebContents | null {
  try {
    const { WebContentsView } = electronRuntime();
    const win = applicationWindow;
    if (!win || win.isDestroyed()) return null;
    for (const child of win.contentView.children) {
      if (!(child instanceof WebContentsView)) continue;
      const wc = child.webContents;
      if (wc.isDestroyed()) continue;
      const url = wc.getURL();
      if (target === "artifact" && url.startsWith("mybuddy-artifact://")) return wc;
      if (target === "browser" && /^https?:/i.test(url) && wc.id !== win.webContents.id) return wc;
    }
  } catch {
    return null;
  }
  return null;
}

export const uiAutomationService = new UiAutomationService({
  app: mainRenderer,
  // The main window injects its exact BrowserHost after attach. Node contract tests
  // can import this service without instantiating any Electron surface.
  browser: () => null,
  artifact: () => secondarySurface("artifact"),
});
