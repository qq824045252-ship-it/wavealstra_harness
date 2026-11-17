import { randomUUID } from "node:crypto";
import type { BrowserWindow, WebContents } from "electron";
import { selectAllModifier } from "../platform/input";
import type { BrowserHost } from "../browser/BrowserHost";
import { pageInspectionService, PageCaptureError, PageCaptureScope } from "../artifact/PageInspectionService";
import { AutomationScope, AutomationTimeoutError } from "./AutomationScope";
import { withBrowserDom } from "./browser/BrowserDom";
import { insertTextSequential, pointerDrag, setDateInput, type DateInputType } from "./browser/BrowserGestures";

export type UiTarget = "app" | "browser" | "artifact";
export type UiExecAction = "status" | "snapshot" | "find" | "inspect" | "click" | "fill" | "drag" | "press" | "scroll" | "hover" | "select" | "check" | "screenshot" | "wait_for";
export type UiWaitState = "attached" | "detached" | "visible" | "hidden";
export const UI_AUTOMATION_ERROR_CODES = [
  "TARGET_UNAVAILABLE", "INVALID_INPUT", "INVALID_LOCATOR", "INVALID_SELECTOR", "ELEMENT_NOT_FOUND",
  "ELEMENT_AMBIGUOUS", "ELEMENT_DISAPPEARED", "ELEMENT_NOT_VISIBLE", "ELEMENT_DISABLED", "ELEMENT_NOT_EDITABLE",
  "SCREENSHOT_EMPTY", "WAIT_TIMEOUT", "EXECUTION_FAILED", "UNSUPPORTED_ACTION", "CAPTURE_TIMEOUT", "SURFACE_CHANGED",
] as const;
export type UiAutomationErrorCode = (typeof UI_AUTOMATION_ERROR_CODES)[number];
export class UiAutomationError extends Error {
  constructor(public readonly code: UiAutomationErrorCode, message: string, public readonly details?: unknown, public readonly candidates?: UiElementInfo[]) {
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
  within?: string;
  exact?: boolean;
  label?: string;
  placeholder?: string;
  testId?: string;
  value?: string;
  button?: "left" | "right";
  clickCount?: 1 | 2;
  modifiers?: Array<"control" | "alt" | "shift" | "meta">;
  inputMode?: "replace" | "sequential";
  delayMs?: number;
  dateType?: DateInputType;
  dragTo?: string;
  dragMode?: "pointer" | "html";
  dragToExpected?: Pick<UiElementInfo, "tag" | "name">;
  key?: string;
  deltaX?: number;
  deltaY?: number;
  values?: string[];
  checked?: boolean;
  maxChars?: number;
  timeoutMs?: number;
  state?: UiWaitState;
  /** Host observation, never supplied by the tool schema. */
  expected?: Pick<UiElementInfo, "tag" | "name">;
  observedSelectors?: readonly string[];
  onActionAccepted?: () => void;
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
  checked?: boolean | "mixed";
  type?: string;
  options?: Array<{ value: string; label: string; selected: boolean; disabled: boolean }>;
  optionsTruncated?: boolean;
  expanded?: boolean;
  hiddenBy?: { kind: "details"; selector: string; tag: "summary"; label: string };
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
  htmlDrag?: (points: readonly { x: number; y: number }[], scope: AutomationScope) => Promise<void>;
  document?: { evaluate: (script: string) => Promise<unknown>; validate: () => void };
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

function locator(input: UiExecInput): Pick<UiExecInput, "selector" | "text" | "role" | "name" | "within" | "exact" | "label" | "placeholder" | "testId"> {
  const result = {
    selector: clean(input.selector, 2_000),
    text: clean(input.text, 4_000),
    role: clean(input.role, 200),
    name: clean(input.name, 1_000),
    within: clean(input.within, 1_000), exact: input.exact,
    label: clean(input.label, 1_000), placeholder: clean(input.placeholder, 1_000), testId: clean(input.testId, 1_000),
  };
  if (!result.selector && !result.text && !result.role && !result.name && !result.label && !result.placeholder && !result.testId) throw new UiAutomationError("INVALID_LOCATOR", "需要 selector / text / role / name / label / placeholder / testId 定位元素");
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
      if(tag==='summary'&&el.parentElement instanceof HTMLDetailsElement&&el.parentElement.querySelector(':scope > summary')===el)return 'button';
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
    const contentName=el=>roleOf(el)?__mbDom.composedText(el):Array.from(el.childNodes).map(node=>node.nodeType===Node.TEXT_NODE?node.textContent||'':node instanceof HTMLSlotElement?__mbDom.composedText(node):'').join('');
    const nameOf=(el)=>norm(el.getAttribute('aria-label')||(el.getAttribute('aria-labelledby')?el.getAttribute('aria-labelledby').split(/\\s+/).map(id=>el.getRootNode().getElementById(id)?.textContent||'').join(' '):'')||(el.labels?[...el.labels].map(l=>{const c=l.cloneNode(true);c.querySelectorAll('input,textarea,select,[contenteditable]').forEach(n=>n.remove());return c.textContent||''}).join(' '):'')||el.getAttribute('title')||(el instanceof HTMLInputElement?el.placeholder:'')||(el instanceof HTMLInputElement&&['button','submit','reset','image'].includes(el.type)?el.value||el.alt:'')||(!(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||el.isContentEditable)?contentName(el):'')||el.getAttribute('name'));
    const refs=window.__mybuddyUiRefs||(window.__mybuddyUiRefs=new WeakMap());
    const path=(el)=>{ let ref=refs.get(el); if(!ref){ref=${JSON.stringify(randomUUID())}+'-'+(++window.__mybuddyUiRefCounter|| (window.__mybuddyUiRefCounter=1));refs.set(el,ref);el.setAttribute('data-mybuddy-ui-ref',ref);} return '[data-mybuddy-ui-ref="'+CSS.escape(ref)+'"]'; };
    const closedDisclosure=el=>{let blocked;for(let parent=__mbDom.parent(el);parent;parent=__mbDom.parent(parent)){if(parent instanceof HTMLDetailsElement&&!parent.open){const summary=parent.querySelector(':scope > summary');if(summary&&!summary.contains(el))blocked=summary;}}return blocked;};
    let all; try{const scopes=q.within?__mbDom.all(q.within):[document];if(scopes.length!==1)return {ok:false,error:'ambiguous scope: '+scopes.length};const root=scopes[0];all=q.selector?__mbDom.all(q.selector,root):__mbDom.all('*',root);}catch(e){return {ok:false,error:'invalid selector: '+String(e)}}
    const visible=el=>{const r=el.getBoundingClientRect();return !closedDisclosure(el)&&r.width>0&&r.height>0&&el.checkVisibility({opacityProperty:true,visibilityProperty:true,contentVisibilityAuto:true})};
    const filtered=all.filter(el=>{ if(!(el instanceof Element))return false; if(q.visibleOnly&&!visible(el))return false; if(q.selector?.includes('data-mybuddy-ui-ref')&&refs.get(el)!==el.getAttribute('data-mybuddy-ui-ref'))return false; const n=nameOf(el),r=roleOf(el); if(q.role&&r!==q.role.toLowerCase())return false; const matches=(actual,wanted)=>q.exact?actual===wanted:actual.toLowerCase().includes(wanted.toLowerCase());if(q.name&&!matches(n,q.name))return false;if(q.label&&!matches(n,q.label))return false;if(q.placeholder&&!matches(el.getAttribute('placeholder')||'',q.placeholder))return false;if(q.testId&&el.getAttribute('data-testid')!==q.testId)return false; if(q.text&&!matches(norm(__mbDom.text(el)),q.text))return false; return true; });
    const matches=filtered.slice(${offset},${offset}+limit).map(el=>{ const r=el.getBoundingClientRect(); const s=getComputedStyle(el); const editable=el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||el.isContentEditable; const item={selector:path(el),tag:el.tagName.toLowerCase(),id:el.id||undefined,role:roleOf(el)||undefined,name:nameOf(el).slice(0,160)||undefined,text:!editable?norm(__mbDom.text(el)).slice(0,160)||undefined:undefined,visible:visible(el),disabled:Boolean(el.matches(':disabled')||el.closest('[inert],[aria-disabled="true"]')),bounds:{x:r.x,y:r.y,width:r.width,height:r.height},type:el instanceof HTMLInputElement?el.type:undefined,checked:el instanceof HTMLInputElement&&['checkbox','radio'].includes(el.type)?(el.indeterminate?'mixed':el.checked):el.hasAttribute('aria-checked')?(el.getAttribute('aria-checked')==='mixed'?'mixed':el.getAttribute('aria-checked')==='true'):undefined}; if(el instanceof HTMLSelectElement){item.options=Array.from(el.options).slice(0,80).map(o=>({value:o.value,label:o.label,selected:o.selected,disabled:o.disabled||Boolean(o.closest('optgroup:disabled'))}));item.optionsTruncated=el.options.length>80;} const disclosure=closedDisclosure(el);if(disclosure)item.hiddenBy={kind:'details',selector:path(disclosure),tag:'summary',label:nameOf(disclosure).slice(0,160)};if(el.localName==='summary'&&el.parentElement instanceof HTMLDetailsElement&&el.parentElement.querySelector(':scope > summary')===el)item.expanded=el.parentElement.open;else if(el.hasAttribute('aria-expanded'))item.expanded=el.getAttribute('aria-expanded')==='true';if(inspect){item.outerHTML=el.outerHTML.slice(0,8000); item.styles={display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,zIndex:s.zIndex,pointerEvents:s.pointerEvents,overflowX:s.overflowX,overflowY:s.overflowY};} return item; });
    return {ok:true,matches,total:filtered.length};
  })()`;
}

export class UiAutomationService {
  private browserHost: BrowserHost | null = null;
  constructor(private readonly targets: UiAutomationTargets) {}

  private evaluate(wc: WebContents, script: string): Promise<unknown> {
    const prepared = withBrowserDom(script);
    return this.targets.document ? this.targets.document.evaluate(prepared) : wc.executeJavaScript(prepared, true);
  }

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
    const result = await scope.run(() => this.evaluate(wc, findScript({ ...locator(input), visibleOnly }, limit, inspect))) as { ok?: boolean; error?: string; matches?: UiElementInfo[] };
    if (!result?.ok) {
      const message = result?.error || "UI 元素查找失败";
      throw new UiAutomationError(/^invalid selector:/i.test(message) ? "INVALID_SELECTOR" : "EXECUTION_FAILED", message);
    }
    return result.matches ?? [];
  }

  private async one(wc: WebContents, input: UiExecInput, scope: AutomationScope): Promise<UiElementInfo> {
    const visible = await this.find(wc, input, scope, 20, false, true);
    if (visible.length === 1) return visible[0];
    if (visible.length > 1) throw new UiAutomationError("ELEMENT_AMBIGUOUS", "UI 定位不唯一：存在多个可见目标；请从 candidates 选择唯一引用", { countAtLeast: visible.length }, visible);
    const rows = await this.find(wc, input, scope, 2, false);
    if (!rows.length) throw new UiAutomationError("ELEMENT_NOT_FOUND", "未找到目标 UI 元素");
    if (rows.length > 1) {
      throw new UiAutomationError("ELEMENT_AMBIGUOUS", `UI 定位不唯一：匹配 ${rows.length} 个元素`, { count: rows.length }, rows);
    }
    return rows[0];
  }

  private async dispatch(wc: WebContents, selector: string, event: "click" | "dblclick" | "contextmenu" | "mouseup" | "drop" | "keydown" | "mousemove", scope: AutomationScope, send: () => Promise<void>, onAccepted?: () => void): Promise<void> {
    const token = randomUUID();
    const prepared = await scope.run(() => this.evaluate(wc, `(() => {
      const el=__mbDom.one(${JSON.stringify(selector)});if(!el)return false;
      const receipts=window.__mybuddyInputReceipts||(window.__mybuddyInputReceipts=new Map());
      for(const [key,old]of receipts){if(receipts.size<16)break;old.cleanup();receipts.delete(key);}
      const entry={};entry.promise=new Promise(resolve=>{
        const finish=value=>{document.removeEventListener(${JSON.stringify(event)},listener,true);clearTimeout(entry.timer);resolve(value)};
        const listener=e=>{if(e.isTrusted&&e.composedPath().includes(el))finish(true)};
        entry.cleanup=()=>finish(false);entry.timer=setTimeout(entry.cleanup,Math.max(1,${scope.deadline}-Date.now()));
        document.addEventListener(${JSON.stringify(event)},listener,true);
      });
      receipts.set(${JSON.stringify(token)},entry);return true;
    })()`));
    if (!prepared) throw new UiAutomationError("ELEMENT_DISAPPEARED", "输入派发前目标已消失");
    // Start awaiting in the original document before input. A link can replace
    // that document immediately after the trusted event reaches its target.
    const receipt = scope.run(async () => {
      const accepted = await this.evaluate(wc, `window.__mybuddyInputReceipts.get(${JSON.stringify(token)})?.promise`);
      if (accepted && scope.active && scope.dispatched) onAccepted?.();
      return accepted;
    });
    void receipt.catch(() => {});
    try {
      scope.dispatch(); await send();
      const accepted = await receipt;
      if (!accepted) throw new UiAutomationError("EXECUTION_FAILED", "原生输入已派发，但目标没有确认收到事件；请只读观察，不要重放提交");
    } finally {
      // Cleanup is read-only and may outlive caller cancellation. The renderer
      // also expires the listener at the invocation's absolute deadline.
      if (!wc.isDestroyed()) void this.evaluate(wc, `(() => {const receipts=window.__mybuddyInputReceipts,entry=receipts?.get(${JSON.stringify(token)});entry?.cleanup();receipts?.delete(${JSON.stringify(token)});})()`).catch(() => {});
    }
  }

  private async point(wc: WebContents, element: UiElementInfo, scope: AutomationScope, scrollIntoView = true): Promise<{ x: number; y: number }> {
    const deadline = Math.min(scope.deadline, Date.now() + 1500);
    let previous: string | undefined;
    let failure = new UiAutomationError("ELEMENT_NOT_VISIBLE", "目标尚未可见", { selector: element.selector });
    do {
      if (scrollIntoView) await scope.run(() => this.evaluate(wc, `__mbDom.one(${JSON.stringify(element.selector)})?.scrollIntoView({block:'center',inline:'center',behavior:'instant'})`));
      const current = await this.one(wc, { action: "find", selector: element.selector }, scope);
      if (!current) throw new UiAutomationError("ELEMENT_DISAPPEARED", "目标元素在点击前消失");
      if (current.disabled) throw new UiAutomationError("ELEMENT_DISABLED", "目标元素已禁用");
      if (current.tag !== element.tag || current.role !== element.role || current.name !== element.name) throw new UiAutomationError("SURFACE_CHANGED", "目标语义在操作前变化，请重新定位");
      const hit = current.visible ? await scope.run(() => this.evaluate(wc, `(() => {
        const el=__mbDom.one(${JSON.stringify(element.selector)});if(!el)return null;
        let blocker;for(const r of el.getClientRects()){
          const left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
          if(right-left<1||bottom-top<1)continue;
          for(const [fx,fy] of [[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]]){
            const x=Math.floor(left+(right-left)*fx),y=Math.floor(top+(bottom-top)*fy);const hit=__mbDom.hit(x,y);
            if(hit===el||__mbDom.contains(el,hit))return {x,y};
            if(!blocker&&hit)blocker={tag:hit.localName,id:hit.id||undefined,role:hit.getAttribute('role')||undefined};
          }
        }return {blocker};
      })()`)) as { x?: number; y?: number; blocker?: { tag: string; id?: string; role?: string } } | null : null;
      const geometry = JSON.stringify(current.bounds);
      if (hit?.x !== undefined && hit.y !== undefined && previous === geometry) return { x: hit.x, y: hit.y };
      previous = hit?.x !== undefined ? geometry : undefined;
      failure = new UiAutomationError("ELEMENT_NOT_VISIBLE", current.visible ? "目标被遮挡或布局尚未稳定，请检查 blocker 或先关闭浮层" : "目标元素不可见，请展开所属菜单、标签或面板后重新观察", { selector: element.selector, visible: current.visible, bounds: current.bounds, blocker: hit?.blocker, hiddenBy: current.hiddenBy });
      if (Date.now() + 50 >= deadline) throw failure;
      await scope.run(() => new Promise(resolve => setTimeout(resolve, 40)));
    } while (Date.now() < deadline);
    throw failure;
  }

  private async click(wc: WebContents, element: UiElementInfo, scope: AutomationScope, onAccepted?: () => void, options: Pick<UiExecInput, "button" | "clickCount" | "modifiers"> = {}): Promise<{ x: number; y: number }> {
    const hit = await this.point(wc, element, scope);
    const { x, y } = hit;
    const button = options.button ?? "left", count = options.clickCount ?? 1, modifiers = options.modifiers ?? [];
    if ((button !== "left" && button !== "right") || (count !== 1 && count !== 2) || (button === "right" && count !== 1) || !Array.isArray(modifiers) || modifiers.some(value => !["control", "alt", "shift", "meta"].includes(value))) throw new UiAutomationError("INVALID_INPUT", "无效的点击按钮、次数或修饰键");
    const receiptEvent = button === "right" ? "contextmenu" : count === 2 ? "dblclick" : "click";
    await this.dispatch(wc, element.selector, receiptEvent, scope, async () => {
      await scope.run(() => this.send(wc, { type: "mouseMove", x, y, modifiers }));
      const stillHit = await scope.run(() => this.evaluate(wc, `(() => {const el=__mbDom.one(${JSON.stringify(element.selector)}),hit=__mbDom.hit(${x},${y});return !!el&&(el===hit||__mbDom.contains(el,hit));})()`));
      if (!stillHit) throw new UiAutomationError("ELEMENT_NOT_VISIBLE", "鼠标移入后目标被遮挡或已移位，未发送点击", { selector: element.selector });
      for (let clickCount = 1; clickCount <= count; clickCount++) await this.sendPair(wc, { type: "mouseDown", x, y, button, clickCount, modifiers }, { type: "mouseUp", x, y, button, clickCount, modifiers }, scope);
    }, onAccepted);
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
      this.targets.document?.validate();
      if (signal?.aborted) throw new DOMException("界面操作已取消", "AbortError");
      if (wc.isDestroyed() || this.targetContents(target) !== wc) throw new UiAutomationError("SURFACE_CHANGED", "UI target 已变化，请重新观察");
    };
    const js = <T = unknown>(script: string): Promise<T> => scope.run(async () => {
      check();
      const result = await this.evaluate(wc, script) as T;
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
      const point = await this.click(wc, element, scope, input.onActionAccepted, input);
      scope.confirmed = true;
      return { ...base, elements: [element], detail: `clicked ${element.selector} @ ${point.x},${point.y}` };
    }
    if (input.action === "drag") {
      if (!input.dragTo) throw new UiAutomationError("INVALID_INPUT", "drag 需要已观察的目标 selector");
      if (input.dragMode !== undefined && input.dragMode !== "pointer" && input.dragMode !== "html") throw new UiAutomationError("INVALID_INPUT", "无效的拖动模式");
      if (input.dragMode === "html" && !this.targets.htmlDrag) throw new UiAutomationError("UNSUPPORTED_ACTION", "当前页面不支持 HTML 拖放");
      const destination = await this.one(wc, { action: "find", selector: input.dragTo }, scope);
      if (input.observedSelectors && !input.observedSelectors.includes(destination.selector)) throw new UiAutomationError("SURFACE_CHANGED", "拖放目标不是已观察节点，请重新 find");
      if (input.dragToExpected && (destination.tag !== input.dragToExpected.tag || destination.name !== input.dragToExpected.name)) throw new UiAutomationError("SURFACE_CHANGED", "拖放目标语义与上次观察不一致");
      await this.point(wc, element, scope);
      const end = await this.point(wc, destination, scope);
      const start = await this.point(wc, element, scope, false);
      let firstMove = true;
      const inputTransport: UiNativeInput = {
        send: async event => {
          if (event.type === "mouseMove" && firstMove) {
            firstMove = false;
            await this.send(wc, event);
            const safe = await this.evaluate(wc, `(() => {
              const source=__mbDom.one(${JSON.stringify(element.selector)}),target=__mbDom.one(${JSON.stringify(destination.selector)});
              const valid=el=>!!el&&window.__mybuddyUiRefs?.get(el)===el.getAttribute('data-mybuddy-ui-ref')&&!el.matches(':disabled');
              const at=(el,x,y)=>{const hit=__mbDom.hit(x,y);return el===hit||__mbDom.contains(el,hit)};
              return valid(source)&&valid(target)&&at(source,${start.x},${start.y})&&at(target,${end.x},${end.y});
            })()`);
            check();
            if (!safe) throw new UiAutomationError("SURFACE_CHANGED", "拖放目标在输入前发生变化，请重新观察");
            return;
          }
          return this.send(wc, event);
        },
        insertText: text => this.targets.input ? this.targets.input.insertText(text) : wc.insertText(text),
      };
      const points = Array.from({ length: 9 }, (_, index) => ({ x: start.x + (end.x - start.x) * index / 8, y: start.y + (end.y - start.y) * index / 8 }));
      if (input.dragMode === "html") {
        await scope.run(() => inputTransport.send({ type: "mouseMove", ...start }));
        const htmlDrag = this.targets.htmlDrag!;
        await this.dispatch(wc, destination.selector, "drop", scope, () => htmlDrag(points, scope), input.onActionAccepted);
      } else {
        await this.dispatch(wc, destination.selector, "mouseup", scope, () => pointerDrag(inputTransport, scope, points), input.onActionAccepted);
      }
      scope.confirmed = true;
      return { ...base, elements: [element, destination], detail: `dragged ${element.selector} to ${destination.selector} (${input.dragMode ?? "pointer"})` };
    }
    if (input.action === "hover") {
      const { x, y } = await this.point(wc, element, scope);
      await this.dispatch(wc, element.selector, "mousemove", scope, () => scope.run(() => this.send(wc, { type: "mouseMove", x, y })));
      scope.confirmed = true;
      return { ...base, elements: [element], detail: `hovered ${element.selector}` };
    }
    if (input.action === "check") {
      if (typeof input.checked !== "boolean") throw new UiAutomationError("INVALID_INPUT", "check 需要 checked 布尔值");
      if (element.checked === undefined) throw new UiAutomationError("ELEMENT_NOT_EDITABLE", "目标不是 checkbox、radio 或带 aria-checked 的控件");
      if (element.checked !== input.checked) {
        if (element.type === "radio" && !input.checked) throw new UiAutomationError("INVALID_INPUT", "radio 不能取消勾选，请选择同组另一个选项");
        await this.click(wc, element, scope);
        await js("new Promise(resolve=>setTimeout(resolve,0))");
        const current = await this.one(wc, { action: "find", selector: element.selector }, scope);
        if (current.checked !== input.checked) throw new UiAutomationError("EXECUTION_FAILED", "已点击，但控件未接受勾选状态；请只读确认");
      }
      scope.confirmed = true;
      return { ...base, elements: await this.find(wc, { action: "find", selector: element.selector }, scope), detail: `checked=${input.checked} ${element.selector}` };
    }
    if (input.action === "select") {
      if (!Array.isArray(input.values) || input.values.length > 80 || input.values.some(value => typeof value !== "string")) throw new UiAutomationError("INVALID_INPUT", "select 需要 values 数组，最多 80 项");
      await this.point(wc, element, scope);
      const prepare = `const el=__mbDom.one(${JSON.stringify(element.selector)}),values=${JSON.stringify(input.values)};
        if(!(el instanceof HTMLSelectElement))return {error:'目标不是原生 select，请用 hover/click 操作自定义下拉'};
        if(!el.multiple&&values.length!==1)return {error:'单选 select 需要恰好一个 value'};
        const options=values.map(value=>Array.from(el.options).filter(o=>o.value===value));
        if(options.some(rows=>rows.length!==1||rows[0].disabled||rows[0].closest('optgroup:disabled')))return {error:'选项不存在、重复或已禁用，请 inspect 查看 options'};`;
      const preflight = await js<{ error?: string }>(`(() => {${prepare}return {};})()`);
      if (preflight.error) throw new UiAutomationError("ELEMENT_NOT_EDITABLE", preflight.error);
      // Revalidate in the same renderer task as the mutation. Never leave a
      // scheduled mutation behind when the caller's absolute deadline expires.
      scope.dispatch();
      const selected = await js<{ error?: string }>(`(() => {if(Date.now()>=${scope.deadline})return {error:'选择已超时'};${prepare}
        for(const option of el.options)option.selected=values.includes(option.value);
        el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {};})()`);
      if (selected.error) throw new UiAutomationError("EXECUTION_FAILED", selected.error);
      await js("new Promise(resolve=>setTimeout(resolve,0))");
      const accepted = await js<boolean>(`(() => {const el=__mbDom.one(${JSON.stringify(element.selector)});return el instanceof HTMLSelectElement&&JSON.stringify(Array.from(el.selectedOptions,o=>o.value).sort())===JSON.stringify(${JSON.stringify([...new Set(input.values)].sort())});})()`);
      if (!accepted) throw new UiAutomationError("EXECUTION_FAILED", "控件未接受下拉选择，请只读确认，不要重放提交");
      scope.confirmed = true;
      return { ...base, elements: await this.find(wc, { action: "find", selector: element.selector }, scope), detail: `selected ${JSON.stringify(input.values)} on ${element.selector}` };
    }
    if (input.action === "fill") {
      const value = input.value ?? "";
      if (value.length > 100_000) throw new UiAutomationError("INVALID_INPUT", "value 过长");
      const editable = await js(`(() => {const el=__mbDom.one(${JSON.stringify(element.selector)}); return Boolean(el && !el.disabled && !el.readOnly && (el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||(el instanceof HTMLElement&&el.isContentEditable)));})()`);
      if (!editable) throw new UiAutomationError("ELEMENT_NOT_EDITABLE", "目标元素不可编辑", { selector: element.selector });
      const nativeDateTypes: DateInputType[] = ["date", "time", "datetime-local", "month", "week"];
      const dateType = element.type && nativeDateTypes.find(type => type === element.type);
      if (input.dateType && input.dateType !== dateType) throw new UiAutomationError("ELEMENT_NOT_EDITABLE", "目标日期类型不匹配");
      if (dateType) {
        await this.point(wc, element, scope);
        try {
          await setDateInput(scope, async fn => {
            check();
            const result = await this.evaluate(wc, `(() => {const el=__mbDom.one(${JSON.stringify(element.selector)});if(Date.now()>=${scope.deadline} || !el || window.__mybuddyUiRefs?.get(el)!==el.getAttribute('data-mybuddy-ui-ref'))return null;return (${fn})(el);})()`);
            check();
            return result;
          }, dateType, value);
        } catch (error) { if (!scope.active) throw error; throw new UiAutomationError("EXECUTION_FAILED", "日期输入被拒绝或目标已变化，请只读确认", { strategy: "synthetic-setter" }); }
        scope.confirmed = true;
        return { ...base, elements: [element], detail: `filled ${element.selector} using synthetic-setter` };
      }
      if (input.inputMode !== undefined && input.inputMode !== "replace" && input.inputMode !== "sequential") throw new UiAutomationError("INVALID_INPUT", "无效的输入模式");
      if (input.delayMs !== undefined && (!Number.isInteger(input.delayMs) || input.delayMs < 0 || input.delayMs > 1000)) throw new UiAutomationError("INVALID_INPUT", "逐字符输入延迟无效");
      await this.click(wc, element, scope);
      const focused = await js(`__mbDom.active()===__mbDom.one(${JSON.stringify(element.selector)})`);
      if (!focused) throw new UiAutomationError("ELEMENT_NOT_EDITABLE", "目标未收到输入焦点");
      check();
      const selectModifier = selectAllModifier();
      await this.dispatch(wc, element.selector, "keydown", scope, () => this.sendPair(wc, { type: "keyDown", keyCode: "A", modifiers: [selectModifier] }, { type: "keyUp", keyCode: "A", modifiers: [selectModifier] }, scope));
      check();
      if (value && input.inputMode === "sequential") await insertTextSequential(this.targets.input ?? { send: event => this.send(wc, event), insertText: text => wc.insertText(text) }, scope, value, input.delayMs);
      else if (value) await scope.run(() => this.targets.input ? this.targets.input.insertText(value) : wc.insertText(value));
      else await this.dispatch(wc, element.selector, "keydown", scope, () => this.sendPair(wc, { type: "keyDown", keyCode: "Backspace" }, { type: "keyUp", keyCode: "Backspace" }, scope));
      const accepted = await js(`(async () => {await new Promise(resolve=>setTimeout(resolve,0));const el=__mbDom.one(${JSON.stringify(element.selector)});return !!el && (el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement?el.value===${JSON.stringify(value)}:el.innerText===${JSON.stringify(value)}||el.textContent===${JSON.stringify(value)});})()`);
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
      await this.point(wc, element, scope);
      const focused = await js(`(() => {const el=__mbDom.one(${JSON.stringify(element.selector)});el?.focus({preventScroll:true});return __mbDom.active()===el;})()`);
      if (!focused) throw new UiAutomationError("ELEMENT_NOT_EDITABLE", "目标未收到键盘焦点");
      await this.dispatch(wc, element.selector, "keydown", scope, () => this.sendPair(wc, { type: "keyDown", keyCode, modifiers }, { type: "keyUp", keyCode, modifiers }, scope), input.onActionAccepted);
      scope.confirmed = true;
      return { ...base, elements: [element], detail: `pressed ${key} on ${element.selector}` };
    }
    if (input.action === "scroll") {
      const dx = Number.isFinite(input.deltaX) ? Number(input.deltaX) : 0;
      const dy = Number.isFinite(input.deltaY) ? Number(input.deltaY) : 0;
      if (!dx && !dy) throw new UiAutomationError("INVALID_INPUT", "scroll 需要非零 delta_x 或 delta_y");
      const { x, y } = await this.point(wc, element, scope, false);
      scope.dispatch();
      await scope.run(() => this.send(wc, { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, canScroll: true }));
      await js("new Promise(resolve=>setTimeout(resolve,80))");
      scope.confirmed = true;
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
