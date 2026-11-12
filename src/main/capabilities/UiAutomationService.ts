import { randomUUID } from "node:crypto";
import type { BrowserWindow, WebContents } from "electron";
import { selectAllModifier } from "../platform/input";
import type { BrowserHost } from "../browser/BrowserHost";
import { pageInspectionService, PageCaptureError, PageCaptureScope } from "../artifact/PageInspectionService";
import { AutomationScope, AutomationTimeoutError } from "./AutomationScope";

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
  /** Host observation, never supplied by the tool schema. */
  expected?: Pick<UiElementInfo, "tag" | "name">;
  observedSelectors?: readonly string[];
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
  input?: UiNativeInput;
}

export interface UiNativeInput {
  send(event: Parameters<WebContents["sendInputEvent"]>[0]): Promise<void>;
  insertText(text: string): Promise<void>;
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

export function findScript(input: ReturnType<typeof locator> & { visibleOnly?: boolean }, limit: number, inspect: boolean, offset: number | "elementOffset" = 0, query?: "snapshot.query"): string {
  return `(() => {
    const q=${query ?? JSON.stringify(input)}; const limit=${Math.max(1, Math.min(200, limit))}; const inspect=${inspect};
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
    const nameOf=(el)=>norm(el.getAttribute('aria-label')||(el.getAttribute('aria-labelledby')?el.getAttribute('aria-labelledby').split(/\\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' '):'')||(el.labels?[...el.labels].map(l=>{const c=l.cloneNode(true);c.querySelectorAll('input,textarea,select,[contenteditable]').forEach(n=>n.remove());return c.textContent||''}).join(' '):'')||el.getAttribute('title')||(el instanceof HTMLInputElement?el.placeholder:'')||(!(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||el.isContentEditable)?el.textContent:'')||el.getAttribute('name'));
    const refs=window.__mybuddyUiRefs||(window.__mybuddyUiRefs=new WeakMap());
    const path=(el)=>{ let ref=refs.get(el); if(!ref){ref=${JSON.stringify(randomUUID())}+'-'+(++window.__mybuddyUiRefCounter|| (window.__mybuddyUiRefCounter=1));refs.set(el,ref);el.setAttribute('data-mybuddy-ui-ref',ref);} return '[data-mybuddy-ui-ref="'+CSS.escape(ref)+'"]'; };
    let all; try{all=q.selector?Array.from(document.querySelectorAll(q.selector)):Array.from(document.querySelectorAll('body *'));}catch(e){return {ok:false,error:'invalid selector: '+String(e)}}
    const filtered=all.filter(el=>{ if(!(el instanceof Element))return false; if(q.visibleOnly){const r=el.getBoundingClientRect(),s=getComputedStyle(el);if(!r.width||!r.height||s.visibility==='hidden'||s.display==='none'||Number(s.opacity||'1')===0)return false;} if(q.selector?.includes('data-mybuddy-ui-ref')&&refs.get(el)!==el.getAttribute('data-mybuddy-ui-ref'))return false; const n=nameOf(el),r=roleOf(el); if(q.role&&r!==q.role.toLowerCase())return false; if(q.name&&!n.toLowerCase().includes(q.name.toLowerCase()))return false; if(q.text&&!norm(el.textContent).toLowerCase().includes(q.text.toLowerCase()))return false; return true; });
    const matches=filtered.slice(${offset},${offset}+limit).map(el=>{ const r=el.getBoundingClientRect(); const s=getComputedStyle(el); const editable=el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||el.isContentEditable; const item={selector:path(el),tag:el.tagName.toLowerCase(),id:el.id||undefined,role:roleOf(el)||undefined,name:nameOf(el).slice(0,160)||undefined,text:!editable?norm(el.textContent).slice(0,160)||undefined:undefined,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||'1')>0,disabled:Boolean(el.disabled||el.getAttribute('aria-disabled')==='true'),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}; if(inspect){item.outerHTML=el.outerHTML.slice(0,8000); item.styles={display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,zIndex:s.zIndex,pointerEvents:s.pointerEvents,overflowX:s.overflowX,overflowY:s.overflowY};} return item; });
    return {ok:true,matches,total:filtered.length};
  })()`;
}

export class UiAutomationService {
  private browserHost: BrowserHost | null = null;
  constructor(private readonly targets: UiAutomationTargets) {}

  private async send(wc: WebContents, event: Parameters<WebContents["sendInputEvent"]>[0]): Promise<void> {
    if (this.targets.input) return this.targets.input.send(event);
    wc.sendInputEvent(event);
  }

  private async sendPair(wc: WebContents, down: Parameters<WebContents["sendInputEvent"]>[0], up: Parameters<WebContents["sendInputEvent"]>[0], scope: AutomationScope): Promise<void> {
    let sent = false, failed = false, cause: unknown;
    try { await scope.run(() => { sent = true; return this.send(wc, down); }); }
    catch (error) { failed = true; cause = error; }
    if (sent) {
      const released = this.send(wc, up);
      if (failed) void released.catch(() => {});
      else try { await scope.run(() => released); } catch (error) { failed = true; cause = error; }
    }
    if (failed) throw cause;
  }

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

  private async find(wc: WebContents, input: UiExecInput, scope: AutomationScope, limit = 20, inspect = false, visibleOnly = false): Promise<UiElementInfo[]> {
    const result = await scope.run(() => wc.executeJavaScript(findScript({ ...locator(input), visibleOnly }, limit, inspect), true)) as { ok?: boolean; error?: string; matches?: UiElementInfo[] };
    if (!result?.ok) {
      const message = result?.error || "UI 元素查找失败";
      throw new UiAutomationError(/^invalid selector:/i.test(message) ? "INVALID_SELECTOR" : "EXECUTION_FAILED", message);
    }
    return result.matches ?? [];
  }

  private async one(wc: WebContents, input: UiExecInput, scope: AutomationScope): Promise<UiElementInfo> {
    const visible = await this.find(wc, input, scope, 2, false, true);
    if (visible.length === 1) return visible[0];
    if (visible.length > 1) throw new UiAutomationError("ELEMENT_AMBIGUOUS", "UI 定位不唯一：存在多个可见目标");
    const rows = await this.find(wc, input, scope, 2, false);
    if (!rows.length) throw new UiAutomationError("ELEMENT_NOT_FOUND", "未找到目标 UI 元素");
    if (rows.length > 1) {
      throw new UiAutomationError("ELEMENT_AMBIGUOUS", `UI 定位不唯一：匹配 ${rows.length} 个元素`, { count: rows.length });
    }
    return rows[0];
  }

  private async dispatch(wc: WebContents, selector: string, event: "click" | "keydown", scope: AutomationScope, send: () => Promise<void>): Promise<void> {
    const token = randomUUID();
    const prepared = await scope.run(() => wc.executeJavaScript(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;
      const receipts=window.__mybuddyInputReceipts||(window.__mybuddyInputReceipts=new Map());
      for(const [key,old]of receipts){if(receipts.size<16)break;old.cleanup();receipts.delete(key);}
      const entry={};entry.promise=new Promise(resolve=>{
        const finish=value=>{document.removeEventListener(${JSON.stringify(event)},listener,true);clearTimeout(entry.timer);resolve(value)};
        const listener=e=>{if(e.isTrusted)finish(e.target===el||el.contains(e.target))};
        entry.cleanup=()=>finish(false);entry.timer=setTimeout(entry.cleanup,Math.max(1,${scope.deadline}-Date.now()));
        document.addEventListener(${JSON.stringify(event)},listener,true);
      });
      receipts.set(${JSON.stringify(token)},entry);return true;
    })()`, true));
    if (!prepared) throw new UiAutomationError("ELEMENT_DISAPPEARED", "输入派发前目标已消失");
    try {
      scope.dispatch(); await send();
      const accepted = await scope.run(() => wc.executeJavaScript(`window.__mybuddyInputReceipts.get(${JSON.stringify(token)})?.promise`, true));
      if (!accepted) throw new UiAutomationError("EXECUTION_FAILED", "原生输入已派发，但目标没有确认收到事件；请只读观察，不要重放提交");
    } finally {
      // Cleanup is read-only and may outlive caller cancellation. The renderer
      // also expires the listener at the invocation's absolute deadline.
      if (!wc.isDestroyed()) void wc.executeJavaScript(`(() => {const receipts=window.__mybuddyInputReceipts,entry=receipts?.get(${JSON.stringify(token)});entry?.cleanup();receipts?.delete(${JSON.stringify(token)});})()`).catch(() => {});
    }
  }

  private async click(wc: WebContents, element: UiElementInfo, scope: AutomationScope): Promise<{ x: number; y: number }> {
    await scope.run(() => wc.executeJavaScript(`document.querySelector(${JSON.stringify(element.selector)})?.scrollIntoView({block:'center',inline:'center'})`, true));
    const current = await this.one(wc, { action: "find", selector: element.selector }, scope);
    if (!current) throw new UiAutomationError("ELEMENT_DISAPPEARED", "目标元素在点击前消失");
    if (!current.visible) throw new UiAutomationError("ELEMENT_NOT_VISIBLE", "目标元素不可见");
    if (current.disabled) throw new UiAutomationError("ELEMENT_DISABLED", "目标元素已禁用");
    if (current.tag !== element.tag || current.role !== element.role || current.name !== element.name) throw new UiAutomationError("SURFACE_CHANGED", "目标语义在操作前变化，请重新定位");
    const hit = await scope.run(() => wc.executeJavaScript(`(() => {const el=document.querySelector(${JSON.stringify(element.selector)});if(!el)return null;const r=el.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);const hit=document.elementFromPoint(x,y);return hit===el||el.contains(hit)?{x,y}:null})()`, true)) as { x: number; y: number } | null;
    if (!hit) throw new UiAutomationError("ELEMENT_NOT_VISIBLE", "目标被其它元素遮挡，请重新观察界面");
    const { x, y } = hit;
    await this.dispatch(wc, element.selector, "click", scope, async () => {
      await scope.run(() => this.send(wc, { type: "mouseMove", x, y }));
      await this.sendPair(wc, { type: "mouseDown", x, y, button: "left", clickCount: 1 }, { type: "mouseUp", x, y, button: "left", clickCount: 1 }, scope);
    });
    return { x, y };
  }

  async execute(input: UiExecInput, signal?: AbortSignal, sharedScope?: AutomationScope): Promise<UiExecOutput> {
    const scope = sharedScope ?? new AutomationScope(signal, input.timeoutMs);
    const target = input.target ?? "app", wc = this.targetContents(target);
    const release = wc ? scope.guard(() => {
      if (wc.isDestroyed() || this.targetContents(target) !== wc) throw new UiAutomationError("SURFACE_CHANGED", "UI target 已变化，请重新观察");
    }) : () => {};
    try { return await this.executeScoped(input, scope); }
    catch (error) {
      if (error instanceof AutomationTimeoutError) throw new UiAutomationError("WAIT_TIMEOUT", error.message, { outcome: { dispatch: scope.dispatched ? "dispatched" : "not_started", effect: scope.confirmed ? "confirmed" : scope.dispatched ? "unknown" : "none" } });
      throw error;
    } finally { release(); if (!sharedScope) scope.close(); }
  }

  private async executeScoped(input: UiExecInput, scope: AutomationScope): Promise<UiExecOutput> {
    const signal = scope.signal;
    if (signal?.aborted) throw new DOMException("界面操作已取消", "AbortError");
    const target = input.target ?? "app";
    if (input.action === "status") {
      if (!this.available(target)) return { action: input.action, target, detail: "unavailable" };
      const wc = this.wc(target);
      return { action: input.action, target, url: wc.getURL(), title: wc.getTitle(), detail: "ready" };
    }

    const wc = this.wc(target);
    const check = () => {
      scope.check();
      if (signal?.aborted) throw new DOMException("界面操作已取消", "AbortError");
      if (wc.isDestroyed() || this.targetContents(target) !== wc) throw new UiAutomationError("SURFACE_CHANGED", "UI target 已变化，请重新观察");
    };
    const js = <T = unknown>(script: string): Promise<T> => scope.run(async () => {
      check();
      const result: T = await wc.executeJavaScript(script, true);
      check();
      return result;
    });
    const base = { action: input.action, target, url: wc.getURL(), title: wc.getTitle() } as const;

    if (input.action === "snapshot") {
      const page = await scope.run(() => pageInspectionService.getPageSnapshot(wc));
      // A reference belongs to this exact DOM node and document. Reordering keeps it
      // valid; replacement/navigation/new snapshots cannot silently retarget it.
      const rows = await this.find(wc, { action: "find", selector: 'button,a,input,textarea,select,[role],[aria-label],[data-testid]' }, scope, 200);
      const max = Math.max(1_000, Math.min(100_000, Math.round(input.maxChars ?? 30_000)));
      return { ...base, text: page?.text.slice(0, max) ?? "", elements: rows, detail: `snapshot: ${rows.length} interactive elements` };
    }

    if (input.action === "find" || input.action === "inspect") {
      const rows = await this.find(wc, input, scope, input.action === "inspect" ? 10 : 20, input.action === "inspect");
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
        const rows = await this.find(wc, input, scope, 20, false);
        const attached = rows.length > 0;
        const visible = rows.some((row) => row.visible);
        const done = state === "attached" ? attached : state === "detached" ? !attached : state === "visible" ? visible : !visible;
        if (done) return { ...base, elements: rows, detail: `${state} after ${Date.now() - started}ms` };
        await scope.run(() => new Promise((resolve) => setTimeout(resolve, Math.min(100, scope.remaining))));
      }
      throw new UiAutomationError("WAIT_TIMEOUT", `wait_for 超时：${state} (${timeout}ms)`, { state, timeoutMs: timeout });
    }

    const element = await this.one(wc, input, scope);
    if (input.observedSelectors && !input.observedSelectors.includes(element.selector)) throw new UiAutomationError("SURFACE_CHANGED", "定位结果不是已观察的真实节点，请重新 find");
    if (input.expected && (element.tag !== input.expected.tag || element.name !== input.expected.name)) throw new UiAutomationError("SURFACE_CHANGED", "目标语义与上次观察不一致");
    check();
    if (input.action === "click") {
      const point = await this.click(wc, element, scope);
      scope.confirmed = true;
      return { ...base, elements: [element], detail: `clicked ${element.selector} @ ${point.x},${point.y}` };
    }
    if (input.action === "fill") {
      const value = input.value ?? "";
      if (value.length > 100_000) throw new UiAutomationError("INVALID_INPUT", "value 过长");
      const editable = await js(`(() => {const el=document.querySelector(${JSON.stringify(element.selector)}); return Boolean(el && !el.disabled && !el.readOnly && (el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||(el instanceof HTMLElement&&el.isContentEditable)));})()`);
      if (!editable) throw new UiAutomationError("ELEMENT_NOT_EDITABLE", "目标元素不可编辑", { selector: element.selector });
      await this.click(wc, element, scope);
      const focused = await js(`document.activeElement===document.querySelector(${JSON.stringify(element.selector)})`);
      if (!focused) throw new UiAutomationError("ELEMENT_NOT_EDITABLE", "目标未收到输入焦点");
      check();
      const selectModifier = selectAllModifier();
      await this.dispatch(wc, element.selector, "keydown", scope, () => this.sendPair(wc, { type: "keyDown", keyCode: "A", modifiers: [selectModifier] }, { type: "keyUp", keyCode: "A", modifiers: [selectModifier] }, scope));
      check();
      if (value) await scope.run(() => this.targets.input ? this.targets.input.insertText(value) : wc.insertText(value));
      else await this.dispatch(wc, element.selector, "keydown", scope, () => this.sendPair(wc, { type: "keyDown", keyCode: "Backspace" }, { type: "keyUp", keyCode: "Backspace" }, scope));
      const accepted = await js(`(async () => {await new Promise(resolve=>setTimeout(resolve,0));const el=document.querySelector(${JSON.stringify(element.selector)});return !!el && (el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement?el.value===${JSON.stringify(value)}:el.innerText===${JSON.stringify(value)}||el.textContent===${JSON.stringify(value)});})()`);
      if (!accepted) throw new UiAutomationError("EXECUTION_FAILED", "输入已派发，但控件未接受目标值；请只读确认，不要重放提交");
      scope.confirmed = true;
      return { ...base, elements: [element], detail: `filled ${element.selector}` };
    }
    if (input.action === "press") {
      const key = clean(input.key, 80);
      if (!key) throw new UiAutomationError("INVALID_INPUT", "key 不能为空");
      const tokens = key.split("+");
      const keyCode = tokens.pop()!;
      const aliases: Record<string, "control" | "alt" | "shift" | "meta"> = { ctrl: "control", control: "control", alt: "alt", shift: "shift", meta: "meta", cmd: "meta", command: "meta" };
      const modifiers = tokens.map(token => aliases[token.toLowerCase()]);
      if (modifiers.some(token => !token)) throw new UiAutomationError("INVALID_INPUT", "不支持的快捷键修饰符");
      await this.click(wc, element, scope);
      await this.dispatch(wc, element.selector, "keydown", scope, () => this.sendPair(wc, { type: "keyDown", keyCode, modifiers }, { type: "keyUp", keyCode, modifiers }, scope));
      scope.confirmed = true;
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
