import type { WebContents } from "electron";
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
    const q=${JSON.stringify(input)}; const limit=${Math.max(1, Math.min(50, limit))}; const inspect=${inspect};
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
    const path=(el)=>{ if(el.id)return '#'+CSS.escape(el.id); const tid=el.getAttribute('data-testid'); if(tid)return '[data-testid="'+CSS.escape(tid)+'"]'; const parts=[]; let n=el; while(n&&n!==document.documentElement){ let p=n.localName; if(!p)break; const parent=n.parentElement; if(parent){const peers=Array.from(parent.children).filter(x=>x.localName===n.localName); if(peers.length>1)p+=':nth-of-type('+(peers.indexOf(n)+1)+')';} parts.unshift(p); n=parent;} return parts.join(' > '); };
    let all; try{all=q.selector?Array.from(document.querySelectorAll(q.selector)):Array.from(document.querySelectorAll('body *'));}catch(e){return {ok:false,error:'invalid selector: '+String(e)}}
    const matches=all.filter(el=>{ if(!(el instanceof Element))return false; const n=nameOf(el),r=roleOf(el); if(q.role&&r!==q.role.toLowerCase())return false; if(q.name&&!n.toLowerCase().includes(q.name.toLowerCase()))return false; if(q.text&&!norm(el.textContent).toLowerCase().includes(q.text.toLowerCase()))return false; return true; }).slice(0,limit).map(el=>{ const r=el.getBoundingClientRect(); const s=getComputedStyle(el); const item={selector:path(el),tag:el.tagName.toLowerCase(),id:el.id||undefined,role:roleOf(el)||undefined,name:nameOf(el).slice(0,500)||undefined,text:norm(el.textContent).slice(0,1000)||undefined,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||'1')>0,disabled:Boolean(el.disabled||el.getAttribute('aria-disabled')==='true'),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}; if(inspect){item.outerHTML=el.outerHTML.slice(0,8000); item.styles={display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,zIndex:s.zIndex,pointerEvents:s.pointerEvents,overflowX:s.overflowX,overflowY:s.overflowY};} return item; });
    return {ok:true,matches};
  })()`;
}

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

  private async find(wc: WebContents, input: UiExecInput, limit = 20, inspect = false): Promise<UiElementInfo[]> {
    const result = await wc.executeJavaScript(findScript(locator(input), limit, inspect), true) as { ok?: boolean; error?: string; matches?: UiElementInfo[] };
    if (!result?.ok) {
      const message = result?.error || "UI 元素查找失败";
      throw new UiAutomationError(/^invalid selector:/i.test(message) ? "INVALID_SELECTOR" : "EXECUTION_FAILED", message);
    }
    return result.matches ?? [];
  }

  private async one(wc: WebContents, input: UiExecInput): Promise<UiElementInfo> {
    const rows = await this.find(wc, input, 10, false);
    if (!rows.length) throw new UiAutomationError("ELEMENT_NOT_FOUND", "未找到目标 UI 元素");
    if (rows.length > 1 && !input.selector) {
      const visible = rows.filter((row) => row.visible);
      if (visible.length === 1) return visible[0];
      throw new UiAutomationError("ELEMENT_AMBIGUOUS", `UI 定位不唯一：匹配 ${rows.length} 个元素`, { count: rows.length });
    }
    return rows[0];
  }

  private async click(wc: WebContents, element: UiElementInfo): Promise<{ x: number; y: number }> {
    await wc.executeJavaScript(`document.querySelector(${JSON.stringify(element.selector)})?.scrollIntoView({block:'center',inline:'center'})`, true);
    const current = (await this.find(wc, { action: "find", selector: element.selector }, 1))[0];
    if (!current) throw new UiAutomationError("ELEMENT_DISAPPEARED", "目标元素在点击前消失");
    if (!current.visible) throw new UiAutomationError("ELEMENT_NOT_VISIBLE", "目标元素不可见");
    if (current.disabled) throw new UiAutomationError("ELEMENT_DISABLED", "目标元素已禁用");
    const x = Math.round(current.bounds.x + current.bounds.width / 2);
    const y = Math.round(current.bounds.y + current.bounds.height / 2);
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
    const base = { action: input.action, target, url: wc.getURL(), title: wc.getTitle() } as const;

    if (input.action === "snapshot") {
      const page = await pageInspectionService.getPageSnapshot(wc);
      const rows = await wc.executeJavaScript(`(() => Array.from(document.querySelectorAll('button,a,input,textarea,select,[role],[aria-label],[data-testid]')).slice(0,200).map((el,i)=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),n=String(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'').replace(/\\s+/g,' ').trim();return {selector:'snapshot:'+i,tag:el.tagName.toLowerCase(),id:el.id||undefined,role:el.getAttribute('role')||undefined,name:n.slice(0,300)||undefined,text:String(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,500)||undefined,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden',disabled:Boolean(el.disabled||el.getAttribute('aria-disabled')==='true'),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}}))()`, true) as UiElementInfo[];
      const max = Math.max(1_000, Math.min(100_000, Math.round(input.maxChars ?? 30_000)));
      return { ...base, text: page?.text.slice(0, max) ?? "", elements: rows, detail: `snapshot: ${rows.length} interactive elements` };
    }

    if (input.action === "find" || input.action === "inspect") {
      const rows = await this.find(wc, input, input.action === "inspect" ? 10 : 20, input.action === "inspect");
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
        const rows = await this.find(wc, input, 20, false);
        const attached = rows.length > 0;
        const visible = rows.some((row) => row.visible);
        const done = state === "attached" ? attached : state === "detached" ? !attached : state === "visible" ? visible : !visible;
        if (done) return { ...base, elements: rows, detail: `${state} after ${Date.now() - started}ms` };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new UiAutomationError("WAIT_TIMEOUT", `wait_for 超时：${state} (${timeout}ms)`, { state, timeoutMs: timeout });
    }

    const element = await this.one(wc, input);
    if (input.action === "click") {
      const point = await this.click(wc, element);
      return { ...base, elements: [element], detail: `clicked ${element.selector} @ ${point.x},${point.y}` };
    }
    if (input.action === "fill") {
      const value = input.value ?? "";
      if (value.length > 100_000) throw new UiAutomationError("INVALID_INPUT", "value 过长");
      await this.click(wc, element);
      const editable = await wc.executeJavaScript(`(() => {const el=document.querySelector(${JSON.stringify(element.selector)}); if(!(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||(el instanceof HTMLElement&&el.isContentEditable)))return false; el.focus(); return true;})()`, true);
      if (!editable) throw new UiAutomationError("ELEMENT_NOT_EDITABLE", "目标元素不可编辑", { selector: element.selector });
      const selectModifier = process.platform === "darwin" ? "meta" : "control";
      wc.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: [selectModifier] });
      wc.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: [selectModifier] });
      wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
      wc.insertText(value);
      return { ...base, elements: [element], detail: `filled ${element.selector}` };
    }
    if (input.action === "press") {
      const key = clean(input.key, 80);
      if (!key) throw new UiAutomationError("INVALID_INPUT", "key 不能为空");
      await this.click(wc, element);
      wc.sendInputEvent({ type: "keyDown", keyCode: key });
      wc.sendInputEvent({ type: "keyUp", keyCode: key });
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

function mainRenderer(): WebContents | null {
  try {
    const { BrowserWindow } = electronRuntime();
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    return win && !win.webContents.isDestroyed() ? win.webContents : null;
  } catch {
    return null;
  }
}

function secondarySurface(target: "browser" | "artifact"): WebContents | null {
  try {
    const { BrowserWindow, WebContentsView } = electronRuntime();
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) return null;
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
