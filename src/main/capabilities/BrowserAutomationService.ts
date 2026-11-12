import { GadgetPreviewUnavailableError, type GadgetBrowserPreview } from "../gadget/GadgetService";
import { browserTabKey, type BrowserTabInfo } from "../../shared/browser-tabs";
import type { BrowserHost, BrowserPageHost } from "../browser/BrowserHost";
import { BrowserContentService } from "../browser/BrowserContentService";
import { PageCaptureError } from "../artifact/PageInspectionService";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordHostToolNotStarted } from "../agent/durable/DurableToolOutcome";
import { currentDurableInvocation } from "../agent/durable/DurableExecutionContext";

export type BrowserExecAction =
  | "status"
  | "navigate"
  | "read"
  | "click"
  | "fill"
  | "press"
  | "screenshot";

export const BROWSER_AUTOMATION_ERROR_CODES = [
  "HOST_UNAVAILABLE", "INVALID_INPUT", "INVALID_URL", "INVALID_SELECTOR", "NAVIGATION_FAILED",
  "PAGE_UNAVAILABLE", "SCREENSHOT_EMPTY", "SELECTOR_NOT_FOUND", "ELEMENT_NOT_CLICKABLE", "ELEMENT_NOT_EDITABLE",
  "FOCUS_FAILED", "EXECUTION_FAILED", "CAPTURE_TIMEOUT", "SURFACE_CHANGED",
] as const;
export type BrowserAutomationErrorCode = (typeof BROWSER_AUTOMATION_ERROR_CODES)[number];
export class BrowserAutomationError extends Error {
  constructor(public readonly code: BrowserAutomationErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "BrowserAutomationError";
  }
}

export interface BrowserExecInput {
  action: BrowserExecAction;
  gadgetId?: string;
  tabId?: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  maxChars?: number;
  reload?: boolean;
}
export interface BrowserExecOutput {
  action: BrowserExecAction;
  gadgetId?: string;
  tabId?: string;
  url?: string;
  title?: string;
  text?: string;
  detail?: string;
  screenshot?: Uint8Array;
  recoveredFromUrl?: string;
  openedTabId?: string;
  tabs?: BrowserTabInfo[];
  /** Observed targets, never guessed selectors or editable values. */
  elements?: Array<{ selector: string; tag: string; label: string; type?: string }>;
  elementsTruncated?: boolean;
}

function assertBrowserUrl(raw: string): string {
  try {
    const value = /^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
    const parsed = new URL(value);
    if (parsed.protocol === "file:") {
      // Same sandboxed BrowserHost used by manual artifact opening. Do not turn
      // local preview into a network-share request (UNC on Windows).
      if (parsed.hostname && parsed.hostname !== "localhost") {
        throw new BrowserAutomationError("INVALID_URL", "本地预览不支持网络共享文件；请使用本机 file:// URL");
      }
      if (!statSync(fileURLToPath(parsed)).isFile()) {
        throw new BrowserAutomationError("INVALID_URL", "本地预览需要一个已存在的普通文件，而不是目录");
      }
    } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BrowserAutomationError("INVALID_URL", "browser_exec 支持 http(s) 网页或本机 file:// 文件 URL");
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof BrowserAutomationError) throw error;
    throw new BrowserAutomationError("INVALID_URL", `无效浏览器 URL：${raw}`, { cause: error instanceof Error ? error.message : String(error) });
  }
}

function requireShort(value: string | undefined, label: string, max: number): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new BrowserAutomationError("INVALID_INPUT", `${label} 不能为空`, { label });
  if (normalized.length > max) throw new BrowserAutomationError("INVALID_INPUT", `${label} 过长`, { label, max });
  return normalized;
}

function jsFailure(error: unknown, action: BrowserExecAction, url?: string): BrowserAutomationError {
  if (error instanceof BrowserAutomationError) return error;
  return new BrowserAutomationError("EXECUTION_FAILED", `浏览器 ${action} 执行失败：${error instanceof Error ? error.message : String(error)}`, { action, url });
}

export class BrowserAutomationService {
  private readonly observationSlot = `__mybuddy_${randomUUID().replaceAll("-", "")}`;
  private readonly observations = new Map<string, { version: number; webContentsId: number; url: string; documentRevision: string }>();

  private readonly ownedTabs = new Map<string, string>();
  private readonly navigationRequests = new Map<string, number>();
  private readonly sourceRevisions = new Map<string, string>();
  private resolveGadgetPreview?: (url: string, taskId: string, gadgetId?: string) => Promise<GadgetBrowserPreview | null>;

  setGadgetPreviewResolver(resolve: (url: string, taskId: string, gadgetId?: string) => Promise<GadgetBrowserPreview | null>): void {
    this.resolveGadgetPreview = resolve;
  }

  constructor(private readonly host: () => BrowserHost | null) {}

  get available(): boolean {
    return Boolean(this.host()?.attached);
  }

  async execute(input: BrowserExecInput, signal?: AbortSignal, context?: { taskId: string }): Promise<BrowserExecOutput> {
    // Validate the complete request before touching the browser surface. A durable
    // checkpoint written here proves this exact invocation never began its action.
    try {
      if (!["status", "navigate", "read", "click", "fill", "press", "screenshot"].includes(input.action)) {
        throw new BrowserAutomationError("INVALID_INPUT", `不支持的 browser_exec action：${String(input.action)}`);
      }
      if (input.gadgetId !== undefined) {
        requireShort(input.gadgetId, "gadgetId", 200);
        if (input.action !== "navigate") throw new BrowserAutomationError("INVALID_INPUT", "gadgetId 仅用于 navigate；其它操作使用 tabId");
      }
      if (input.reload !== undefined && (typeof input.reload !== "boolean" || input.action !== "navigate")) {
        throw new BrowserAutomationError("INVALID_INPUT", "reload 仅用于 navigate，且必须是布尔值");
      }
      if (input.tabId !== undefined) requireShort(input.tabId, "tabId", 200);
      if (input.action === "navigate") assertBrowserUrl(requireShort(input.url, "url", 2_000));
      if (["click", "fill", "press"].includes(input.action)) requireShort(input.selector, "selector", 1_000);
      if (input.action === "press") requireShort(input.key, "key", 60);
      if (input.action === "fill" && (input.text?.length ?? 0) > 100_000) {
        throw new BrowserAutomationError("INVALID_INPUT", "text 过长", { max: 100_000 });
      }
    } catch (error) {
      await recordHostToolNotStarted("browser_exec");
      throw error;
    }
    return this.executeManaged(input, signal, context);
  }

  private async executeManaged(input: BrowserExecInput, signal?: AbortSignal, context?: { taskId: string }): Promise<BrowserExecOutput> {
    if (signal?.aborted) throw new DOMException("浏览器操作已取消", "AbortError");
    const browser = this.host();
    if (!browser || !browser.attached) throw new BrowserAutomationError("HOST_UNAVAILABLE", "MyBuddy 浏览器尚未挂载");
    const invocation = currentDurableInvocation();
    const taskId = context?.taskId ?? invocation?.execution.taskId;
    if (input.gadgetId && (!taskId || !this.resolveGadgetPreview)) throw new BrowserAutomationError("INVALID_INPUT", "Gadget 导航需要当前任务及 Gadget 服务");
    const owner = invocation ? `${invocation.execution.taskId}:${invocation.native.conversationId}` : taskId ?? "direct-host-entry";
    const tabs = taskId ? browser.listTabs().filter(tab => tab.taskId === taskId) : [];
    let tab = input.tabId ? tabs.find(tab => tab.id === input.tabId) : tabs.find(tab => tab.id === this.ownedTabs.get(owner));
    if (input.tabId && !tab) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "标签页已关闭或不属于当前任务，请重新导航", { tabId: input.tabId });
    if (input.action === "navigate") {
      this.observations.delete(owner);
      const requested = assertBrowserUrl(requireShort(input.url, "url", 2_000));
      let target = requested;
      let preview: GadgetBrowserPreview | null = null;
      let page: BrowserPageHost | null = tab ? browser.getTabHost(tab.id) : taskId ? null : browser;
      const previousVersion = page?.captureVersion;
      const versions = new Map(tabs.map(value => [value.id, browser.getTabHost(value.id)?.captureVersion]));
      const navigationOwner = taskId ?? owner;
      const request = (this.navigationRequests.get(navigationOwner) ?? 0) + 1;
      this.navigationRequests.set(navigationOwner, request);
      try {
        if (taskId && this.resolveGadgetPreview) preview = await this.resolveGadgetPreview(requested, taskId, input.gadgetId);
        if (signal?.aborted) throw new DOMException("浏览器操作已取消", "AbortError");
        if (this.navigationRequests.get(navigationOwner) !== request || page && page.captureVersion !== previousVersion) {
          throw new BrowserAutomationError("SURFACE_CHANGED", "恢复预览期间页面已变化，请重新读取后再导航");
        }
        target = preview?.url ?? requested;
        if (taskId && !input.tabId) {
          const key = browserTabKey(target, preview?.gadgetId);
          const existing = browser.listTabs().find(value => value.taskId === taskId && value.key === key);
          if (existing && (!versions.has(existing.id) || browser.getTabHost(existing.id)?.captureVersion !== versions.get(existing.id))) {
            throw new BrowserAutomationError("SURFACE_CHANGED", "目标标签在恢复预览期间变化，请重新读取后再导航");
          }
          tab = browser.ensureTab({ key, taskId, gadgetId: preview?.gadgetId, activate: false });
        }
        if (tab) page = browser.getTabHost(tab.id);
        if (!page?.inspectionWebContents) throw new BrowserAutomationError("HOST_UNAVAILABLE", "MyBuddy 浏览器尚未挂载");
        const previousRevision = tab && this.sourceRevisions.get(tab.id);
        let revision = preview ? `gadget:${preview.revision}` : undefined;
        if (!preview && target.startsWith("file:")) {
          const file = statSync(fileURLToPath(new URL(target)), { bigint: true });
          revision = `file:${file.mtimeNs}:${file.ctimeNs}:${file.size}`;
        }
        const reload = input.reload === true || revision !== undefined && previousRevision !== revision;
        await page.navigateForAutomation(target, signal, { reload });
        if (this.navigationRequests.get(navigationOwner) !== request) throw new BrowserAutomationError("SURFACE_CHANGED", "导航已被较新的浏览器请求替代，请重新读取");
        if (taskId && tab) this.ownedTabs.set(owner, tab.id);
        if (revision && tab) this.sourceRevisions.set(tab.id, revision);
        const current = page.inspectionWebContents;
        if (!current || current.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "标签页已关闭");
        return { action: input.action, tabId: tab?.id, url: current.getURL(), title: current.getTitle(),
          ...(preview ? { gadgetId: preview.gadgetId, recoveredFromUrl: preview.previousUrl } : {}) };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof BrowserAutomationError) throw error;
        if (error instanceof GadgetPreviewUnavailableError) {
          throw new BrowserAutomationError("NAVIGATION_FAILED", `${error.message}。源码没有重放，浏览器操作没有执行。`, {
            targetUrl: requested, currentUrl: page?.url, reason: "gadget-preview-unavailable",
            gadgetId: error.gadgetId, runtime: error.runtime,
          });
        }
        const cause = error instanceof Error ? error.message : String(error);
        const refusedLocalServer = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(target).hostname)
          && /ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(cause);
        const guidance = refusedLocalServer
          ? "本地预览服务未监听该端口。若这是 Gadget，请用 gadget_open 重新取得当前 URL；不要反复重试旧端口或改用外部浏览器。普通本地 HTML 可直接用 file:// URL 预览。"
          : "请先确认当前页面和目标地址，再决定是否重试；无需切换外部浏览器。";
        throw new BrowserAutomationError("NAVIGATION_FAILED", `内置浏览器导航失败：${cause}。${guidance}`, {
          targetUrl: target, currentUrl: page?.url, cause,
          reason: refusedLocalServer ? "local-server-unavailable" : "navigation-failed",
        });
      }
    }
    if (input.action === "status" && taskId) return { action: input.action, tabId: tab?.id, url: tab?.url || undefined, tabs, detail: tab?.url ? "ready" : "idle" };
    const page = taskId ? tab && browser.getTabHost(tab.id) : browser;
    if (!page) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "当前任务没有可用标签页，请 navigate 打开页面；不会自动接管其它任务的页面");
    const before = new Set(browser.listTabs().map(value => value.id));
    const result = await this.executeOnPage(input, signal, page, owner);
    // A popup opened by this exact document is a new retained page. Follow it
    // only for this task's next observation; never redirect another task or UI.
    const popup = ["click", "press"].includes(input.action) && taskId && tab && browser.listTabs().find(value => !before.has(value.id)
      && value.taskId === taskId && value.openerTabId === tab!.id);
    if (taskId && tab) this.ownedTabs.set(owner, popup ? popup.id : tab.id);
    return { ...result, tabId: tab?.id, ...(popup ? { openedTabId: popup.id, detail: `${result.detail ?? ""}；已打开新标签 ${popup.id}，后续读取使用新标签` } : {}) };
  }

  private async executeOnPage(input: BrowserExecInput, signal: AbortSignal | undefined, host: BrowserPageHost, owner: string): Promise<BrowserExecOutput> {
    const wc = host.inspectionWebContents;
    if (!wc || wc.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "标签页已关闭");
    const remembered = this.observations.get(owner);
    if (["click", "fill", "press"].includes(input.action) && remembered
      && (remembered.version !== host.captureVersion || remembered.webContentsId !== wc.id || remembered.url !== wc.getURL()
        || remembered.documentRevision !== await this.documentRevision(wc))) {
      throw new BrowserAutomationError("SURFACE_CHANGED", "读取后浏览器页面、导航或焦点已经变化，请重新读取后再操作");
    }
    // The awaited document/focus checks must not allow a stopped task to dispatch input.
    if (signal?.aborted) throw new DOMException("浏览器操作已取消", "AbortError");
    if (input.action === "status") return { action: input.action, url: host.url || undefined, detail: host.url ? "ready" : "idle" };
    if (input.action === "read") {
      const documentRevision = await this.documentRevision(wc);
      let page;
      try { page = await new BrowserContentService(() => host).getCurrentPage(); }
      catch (error) { throw jsFailure(error, input.action, safeUrl(wc)); }
      if (!page) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "浏览器没有可读取的页面", { currentUrl: safeUrl(wc) });
      const max = Math.max(1_000, Math.min(100_000, Math.round(input.maxChars ?? 30_000)));
      let targets: Pick<BrowserExecOutput, "elements" | "elementsTruncated" | "text">;
      try { targets = await this.readTargets(wc, max); }
      catch (error) { throw jsFailure(error, input.action, safeUrl(wc)); }
      if (documentRevision !== await this.documentRevision(wc)) throw new BrowserAutomationError("SURFACE_CHANGED", "页面在读取期间变化，请重新读取");
      this.observations.set(owner, { version: host.captureVersion, webContentsId: wc.id, url: wc.getURL(), documentRevision });
      return { action: input.action, url: page.url, title: page.title, ...targets, text: targets.text ?? page.text.slice(0, max) };
    }
    if (input.action === "screenshot") {
      if (!host.url) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "浏览器没有可截图的页面");
      try {
        const screenshot = await host.captureScreenshot({ signal });
        return { action: input.action, url: host.url, title: wc.getTitle(), screenshot };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof PageCaptureError && error.code !== "CANCELLED") {
          throw new BrowserAutomationError(error.code, error.message, { currentUrl: host.url });
        }
        if (error instanceof BrowserAutomationError) throw error;
        throw jsFailure(error, input.action, host.url);
      }
    }

    const selector = requireShort(input.selector, "selector", 1_000);
    if (input.action === "click") {
      let result: { ok?: boolean; code?: string; error?: string; tag?: string; text?: string };
      try {
        result = await wc.executeJavaScript(`(() => {
          let el; try { el = document.querySelector(${JSON.stringify(selector)}); }
          catch (e) { return { ok: false, code: "INVALID_SELECTOR", error: "invalid selector: " + String(e) }; }
          if (!el) return { ok: false, code: "SELECTOR_NOT_FOUND", error: "selector not found" };
          el.scrollIntoView({ block: "center", inline: "center" });
          if (!(el instanceof HTMLElement)) return { ok: false, code: "ELEMENT_NOT_CLICKABLE", error: "element is not clickable" };
          el.click();
          return { ok: true, tag: el.tagName, text: (el.innerText || el.getAttribute("aria-label") || "").slice(0, 200) };
        })()`, true) as typeof result;
      } catch (error) { throw jsFailure(error, input.action, safeUrl(wc)); }
      if (!result?.ok) throw browserResultError(result, input.action, selector, safeUrl(wc));
      return { action: input.action, url: wc.getURL(), detail: `${result.tag ?? "element"}: ${result.text ?? ""}`.trim() };
    }
    if (input.action === "fill") {
      const text = input.text ?? "";
      if (text.length > 100_000) throw new BrowserAutomationError("INVALID_INPUT", "text 过长", { max: 100_000 });
      let result: { ok?: boolean; code?: string; error?: string };
      try {
        result = await wc.executeJavaScript(`(() => {
          let el; try { el = document.querySelector(${JSON.stringify(selector)}); }
          catch (e) { return { ok: false, code: "INVALID_SELECTOR", error: "invalid selector: " + String(e) }; }
          if (!el) return { ok: false, code: "SELECTOR_NOT_FOUND", error: "selector not found" };
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLElement && el.isContentEditable)) {
            return { ok: false, code: "ELEMENT_NOT_EDITABLE", error: "selector is not an editable element" };
          }
          el.focus();
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = ${JSON.stringify(text)};
          else el.textContent = ${JSON.stringify(text)};
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)} }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        })()`, true) as typeof result;
      } catch (error) { throw jsFailure(error, input.action, safeUrl(wc)); }
      if (!result?.ok) throw browserResultError(result, input.action, selector, safeUrl(wc));
      return { action: input.action, url: wc.getURL(), detail: `已填写 ${selector}` };
    }
    if (input.action === "press") {
      const key = requireShort(input.key, "key", 60);
      let focus: { ok?: boolean; code?: string; error?: string };
      try {
        focus = await wc.executeJavaScript(`(() => {
          let el; try { el = document.querySelector(${JSON.stringify(selector)}); }
          catch (e) { return { ok: false, code: "INVALID_SELECTOR", error: "invalid selector: " + String(e) }; }
          if (!(el instanceof HTMLElement)) return { ok: false, code: el ? "FOCUS_FAILED" : "SELECTOR_NOT_FOUND", error: el ? "element cannot receive focus" : "selector not found" };
          el.focus();
          if (document.activeElement !== el) return { ok: false, code: "FOCUS_FAILED", error: "element did not receive focus" };
          return { ok: true };
        })()`, true) as typeof focus;
      } catch (error) { throw jsFailure(error, input.action, safeUrl(wc)); }
      if (signal?.aborted) throw new DOMException("浏览器操作已取消", "AbortError");
      if (!focus?.ok) throw browserResultError(focus, input.action, selector, safeUrl(wc));
      // DOWN may have reached Chromium even if its call throws. Always attempt
      // this invocation's matching UP without masking the first delivery error.
      let inputError: unknown;
      try { wc.sendInputEvent({ type: "keyDown", keyCode: key }); }
      catch (error) { inputError = error; }
      try { wc.sendInputEvent({ type: "keyUp", keyCode: key }); }
      catch (error) { inputError ??= error; }
      if (inputError) throw jsFailure(inputError, input.action, safeUrl(wc));
      return { action: input.action, url: wc.getURL(), detail: `已向 ${selector} 发送按键 ${key}` };
    }
    throw new BrowserAutomationError("INVALID_INPUT", `不支持的 browser_exec action：${String(input.action)}`);
  }

  private async readTargets(wc: NonNullable<BrowserHost["inspectionWebContents"]>, maxChars: number): Promise<Pick<BrowserExecOutput, "elements" | "elementsTruncated" | "text">> {
    // Plain text is insufficient for click/fill/press: without target evidence a
    // model has to invent CSS selectors. Inspect only visible interactive nodes,
    // never form values, hidden inputs, password contents, or page scripts.
    return await wc.executeJavaScript(`(() => {
      const nodes=[...document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[contenteditable="true"]')];
      const visible=nodes.filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'});
      const selectorFor=el=>{
        if(el.id){const selector='#'+CSS.escape(el.id);if(document.querySelectorAll(selector).length===1)return selector;}
        const parts=[];
        for(let node=el;node&&node.nodeType===1;node=node.parentElement){
          let part=node.localName;
          const peers=node.parentElement?[...node.parentElement.children].filter(p=>p.localName===node.localName):[node];
          if(peers.length>1)part+=':nth-of-type('+(peers.indexOf(node)+1)+')';
          parts.unshift(part);
        }
        const selector=parts.join(' > ');
        return selector.length<=1000&&document.querySelector(selector)===el?selector:null;
      };
      const elements=visible.slice(0,80).map(el=>{
        const selector=selectorFor(el);if(!selector)return null;
        const editable=el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||el instanceof HTMLSelectElement||el.isContentEditable;
        const label=(el.getAttribute('aria-label')||(el.labels?[...el.labels].map(l=>{const c=l.cloneNode(true);c.querySelectorAll('input,textarea,select,[contenteditable]').forEach(n=>n.remove());return c.textContent||''}).join(' '):'')||el.getAttribute('placeholder')||el.getAttribute('title')||(!editable?el.innerText:'')||el.getAttribute('name')||'').trim().slice(0,160);
        return {selector,tag:el.localName,label,...(el instanceof HTMLInputElement?{type:el.type}:{})};
      }).filter(Boolean);
      // Rendered innerText retains table-cell tabs and block line breaks. Raw
      // textContent concatenates cells (17 and 3 become 173), forcing guesses.
      return {text:(document.body?.innerText??'').slice(0,${maxChars}),elements,elementsTruncated:visible.length>80};
    })()`) as Pick<BrowserExecOutput, "elements" | "elementsTruncated" | "text">;
  }

  private async documentRevision(wc: NonNullable<BrowserHost["inspectionWebContents"]>): Promise<string> {
    const result: unknown = await wc.executeJavaScript(`(() => {
      const key=${JSON.stringify(this.observationSlot)};
      if (!window[key]) {
        const state={revision:0, focus:document.activeElement};
        const observer=new MutationObserver(()=>state.revision++);
        observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
        document.addEventListener('focusin',()=>{state.revision++;state.focus=document.activeElement},true);
        Object.defineProperty(window,key,{value:state});
      }
      return String(window[key].revision);
    })()`);
    if (typeof result !== "string") throw new BrowserAutomationError("SURFACE_CHANGED", "浏览器观测版本无法确认");
    return result;
  }
}

function safeUrl(wc: BrowserHost["inspectionWebContents"]): string | undefined {
  try { return wc?.getURL() || undefined; } catch { return undefined; }
}

function browserResultError(
  result: { code?: string; error?: string } | null | undefined,
  action: BrowserExecAction,
  selector: string,
  currentUrl?: string,
): BrowserAutomationError {
  const allowed = new Set<BrowserAutomationErrorCode>(["INVALID_SELECTOR", "SELECTOR_NOT_FOUND", "ELEMENT_NOT_CLICKABLE", "ELEMENT_NOT_EDITABLE", "FOCUS_FAILED"]);
  const code = allowed.has(result?.code as BrowserAutomationErrorCode) ? result!.code as BrowserAutomationErrorCode : "EXECUTION_FAILED";
  return new BrowserAutomationError(code, result?.error || `浏览器 ${action} 执行失败`, { action, selector, currentUrl });
}
