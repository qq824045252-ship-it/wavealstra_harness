import { GadgetPreviewUnavailableError, type GadgetBrowserPreview } from "../gadget/GadgetService";
import { browserTabKey, type BrowserTabInfo } from "../../shared/browser-tabs";
import type { BrowserHost, BrowserPageHost } from "../browser/BrowserHost";
import { UiAutomationService, UiAutomationError, type UiElementInfo, type UiExecInput } from "./UiAutomationService";
import { AutomationScope, AutomationTimeoutError } from "./AutomationScope";
import { browserDocumentScript, browserPageReadScript, type BrowserReadOptions } from "./BrowserPageRead";
import { PageCaptureError, pageInspectionService } from "../artifact/PageInspectionService";
import { browserNativeInput } from "./BrowserNativeInput";
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
  | "screenshot"
  | "find" | "inspect" | "wait_for";

export const BROWSER_AUTOMATION_ERROR_CODES = [
  "HOST_UNAVAILABLE", "INVALID_INPUT", "INVALID_URL", "INVALID_SELECTOR", "NAVIGATION_FAILED",
  "PAGE_UNAVAILABLE", "SCREENSHOT_EMPTY", "SELECTOR_NOT_FOUND", "ELEMENT_NOT_CLICKABLE", "ELEMENT_NOT_EDITABLE",
  "FOCUS_FAILED", "EXECUTION_FAILED", "CAPTURE_TIMEOUT", "SURFACE_CHANGED",
  "WAIT_TIMEOUT", "CANCELLED", "ELEMENT_AMBIGUOUS", "ELEMENT_DISABLED", "ELEMENT_NOT_VISIBLE", "CURSOR_STALE", "UNSUPPORTED_SCOPE", "READ_LIMIT",
] as const;
export type BrowserAutomationErrorCode = (typeof BROWSER_AUTOMATION_ERROR_CODES)[number];
export class BrowserAutomationError extends Error {
  constructor(public readonly code: BrowserAutomationErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "BrowserAutomationError";
  }
}

export interface BrowserExecInput extends BrowserReadOptions {
  action: BrowserExecAction;
  gadgetId?: string;
  tabId?: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  maxChars?: number;
  reload?: boolean;
  role?: string;
  name?: string;
  timeoutMs?: number;
  state?: UiExecInput["state"];
  after?: { selector?: string; role?: string; name?: string; state?: UiExecInput["state"]; mode?: "text" | "interactive"; maxChars?: number };
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
  elements?: Array<{ selector: string; tag: string; label: string; type?: string; id?: string }>;
  textTotal?: number;
  textOffset?: number;
  textTruncated?: boolean;
  nextOffset?: number;
  nextCursor?: string;
  documentId?: string;
  contentState?: "empty" | "loading" | "ready";
  elementsTotal?: number;
  scope?: string;
  contentRevision?: number;
  coverage?: { iframe: "excluded"; shadowDOM: "excluded" };
  outcome?: { dispatch: "not_started" | "dispatched"; effect: "none" | "unknown" | "confirmed" };
  observation?: { status: "completed"; result: BrowserExecOutput } | { status: "failed"; code: string; message: string };
  elementsTruncated?: boolean;
}

interface ObservedPage {
  version: number; webContentsId: number; url: string; documentId: string;
  targets: Map<string, { selector: string; tag: string; label: string }>;
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

export class BrowserAutomationService {
  private readonly observationSlot = `__mybuddy_${randomUUID().replaceAll("-", "")}`;
  private readonly observations = new Map<string, ObservedPage>();

  private readonly ownedTabs = new Map<string, string>();
  private readonly navigationRequests = new Map<string, object>();
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
      if (!["status", "navigate", "read", "click", "fill", "press", "screenshot", "find", "inspect", "wait_for"].includes(input.action)) {
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
      if (["click", "fill", "press", "find", "inspect", "wait_for"].includes(input.action) && !input.selector && !input.role && !input.name && !(input.action !== "fill" && input.text)) throw new BrowserAutomationError("INVALID_INPUT", "需要 selector / role / name / text 定位");
      if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 30_000)) throw new BrowserAutomationError("INVALID_INPUT", "timeout_ms 必须为 100..30000");
      for (const [label, value, max] of [["selector", input.selector, 1000], ["role", input.role, 200], ["name", input.name, 1000], ["cursor", input.cursor, 300]] as const) if (value !== undefined) requireShort(value, label, max);
      if (input.maxChars !== undefined && (!Number.isSafeInteger(input.maxChars) || input.maxChars < 1000 || input.maxChars > 100000)) throw new BrowserAutomationError("INVALID_INPUT", "max_chars 必须为 1000..100000");
      if (input.mode !== undefined && !["text", "interactive"].includes(input.mode)) throw new BrowserAutomationError("INVALID_INPUT", "未知读取模式");
      if (input.after && !["navigate", "click", "fill", "press", "wait_for"].includes(input.action)) throw new BrowserAutomationError("INVALID_INPUT", "after 仅用于导航、动作或条件等待");
      for (const value of [input.offset, input.elementOffset]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new BrowserAutomationError("INVALID_INPUT", "读取偏移必须是非负整数");
      if (input.action === "press") requireShort(input.key, "key", 60);
      if (input.action === "fill" && (input.text?.length ?? 0) > 100_000) {
        throw new BrowserAutomationError("INVALID_INPUT", "text 过长", { max: 100_000 });
      }
    } catch (error) {
      await recordHostToolNotStarted("browser_exec");
      throw error;
    }
    const scope = new AutomationScope(signal, input.timeoutMs);
    try {
      const result = await this.executeManaged(input, scope, context);
      return { ...result, outcome: { dispatch: scope.dispatched ? "dispatched" : "not_started", effect: scope.confirmed ? "confirmed" : scope.dispatched ? "unknown" : "none" } };
    } catch (error) {
      const outcome = { dispatch: scope.dispatched ? "dispatched" : "not_started", effect: scope.confirmed ? "confirmed" : scope.dispatched ? "unknown" : "none" };
      const evidence = { outcome, currentUrl: scope.pageUrl };
      if (!scope.dispatched && ["navigate", "click", "fill", "press"].includes(input.action)) await recordHostToolNotStarted("browser_exec");
      if (error instanceof Error && error.name === "AbortError") {
        Object.assign(error, { details: evidence }); throw error;
      }
      if (error instanceof AutomationTimeoutError) throw new BrowserAutomationError("WAIT_TIMEOUT", error.message, evidence);
      if (error instanceof PageCaptureError && error.code !== "CANCELLED") throw new BrowserAutomationError(error.code, error.message, evidence);
      if (error instanceof BrowserAutomationError) throw new BrowserAutomationError(error.code, error.message, { ...evidence, ...(error.details && typeof error.details === "object" ? error.details : {}), outcome });
      if (error instanceof UiAutomationError) {
        const mapping: Partial<Record<UiAutomationError["code"], BrowserAutomationErrorCode>> = { ELEMENT_NOT_FOUND: "SELECTOR_NOT_FOUND", ELEMENT_DISAPPEARED: "SURFACE_CHANGED", TARGET_UNAVAILABLE: "PAGE_UNAVAILABLE", INVALID_LOCATOR: "INVALID_INPUT", UNSUPPORTED_ACTION: "INVALID_INPUT" };
        const code = mapping[error.code] ?? BROWSER_AUTOMATION_ERROR_CODES.find(code => code === error.code) ?? "EXECUTION_FAILED";
        throw new BrowserAutomationError(code, error.message, evidence);
      }
      throw new BrowserAutomationError("EXECUTION_FAILED", String(error), evidence);
    } finally { scope.close(); }
  }

  private async executeManaged(input: BrowserExecInput, scope: AutomationScope, context?: { taskId: string }): Promise<BrowserExecOutput> {
    const signal = scope.signal;
    scope.check();
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

      const requested = assertBrowserUrl(requireShort(input.url, "url", 2_000));
      let target = requested;
      let preview: GadgetBrowserPreview | null = null;
      let page: BrowserPageHost | null = tab ? browser.getTabHost(tab.id) : taskId ? null : browser.activeTabId ? browser.getTabHost(browser.activeTabId) : null;
      const previousVersion = page?.captureVersion;
      const versions = new Map(tabs.map(value => [value.id, browser.getTabHost(value.id)?.captureVersion]));
      const navigationOwner = `${taskId ?? owner}:${input.tabId ?? (input.gadgetId ? `gadget:${input.gadgetId}` : browserTabKey(requested))}`;
      const request = {};
      this.navigationRequests.set(navigationOwner, request);
      let pageNavigationKey: string | undefined;
      let pageRequest: object | undefined;
      try {
        if (taskId && this.resolveGadgetPreview) preview = await scope.run(() => this.resolveGadgetPreview!(requested, taskId, input.gadgetId));
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
        const navigationPage = page;
        const navigationTabId = tab?.id;
        const wcBefore = page.inspectionWebContents;
        pageNavigationKey = `page:${wcBefore.id}`;
        pageRequest = {};
        this.navigationRequests.set(pageNavigationKey, pageRequest);
        this.observations.delete(`${owner}:${navigationTabId ?? wcBefore.id}`);
        scope.dispatch();
        await scope.run(() => navigationPage.navigateForAutomation(target, signal, { reload }));
        if (navigationTabId && browser.getTabHost(navigationTabId) !== navigationPage) throw new BrowserAutomationError("SURFACE_CHANGED", "导航目标标签已关闭");
        if (this.navigationRequests.get(navigationOwner) !== request || this.navigationRequests.get(pageNavigationKey) !== pageRequest) throw new BrowserAutomationError("SURFACE_CHANGED", "导航已被较新的浏览器请求替代，请重新读取");
        if (taskId && tab) this.ownedTabs.set(owner, tab.id);
        if (revision && tab) this.sourceRevisions.set(tab.id, revision);
        const current = page.inspectionWebContents;
        if (!current || current.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "标签页已关闭");
        scope.confirmed = true;
        const result: BrowserExecOutput = { action: input.action, tabId: tab?.id, url: current.getURL(), title: current.getTitle(),
          ...(preview ? { gadgetId: preview.gadgetId, recoveredFromUrl: preview.previousUrl } : {}) };
        return this.afterObservation(input, result, scope, page, `${owner}:${tab?.id ?? current.id}`);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof BrowserAutomationError || error instanceof AutomationTimeoutError) throw error;
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
      } finally {
        if (this.navigationRequests.get(navigationOwner) === request) this.navigationRequests.delete(navigationOwner);
        if (pageNavigationKey && this.navigationRequests.get(pageNavigationKey) === pageRequest) this.navigationRequests.delete(pageNavigationKey);
      }
    }
    if (input.action === "status" && taskId) return { action: input.action, tabId: tab?.id, url: tab?.url || undefined, tabs, detail: tab?.url ? "ready" : "idle" };
    const page = taskId ? tab && browser.getTabHost(tab.id) : browser.activeTabId ? browser.getTabHost(browser.activeTabId) : null;
    if (!page) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "当前任务没有可用标签页，请 navigate 打开页面；不会自动接管其它任务的页面");
    const before = new Set(browser.listTabs().map(value => value.id));
    const perform = () => this.executeOnPage(input, scope, page, `${owner}:${tab?.id ?? page.inspectionWebContents?.id}`, () => !taskId || Boolean(tab && browser.getTabHost(tab.id) === page));
    const base = await (input.action !== "status" && input.action !== "screenshot" ? this.withSurface(scope, page, perform) : perform());
    // A popup opened by this exact document is a new retained page. Follow it
    // only for this task's next observation; never redirect another task or UI.
    const popup = ["click", "press"].includes(input.action) && taskId && tab && browser.listTabs().find(value => !before.has(value.id)
      && value.taskId === taskId && value.openerTabId === tab!.id);
    if (taskId && tab) this.ownedTabs.set(owner, popup ? popup.id : tab.id);
    const afterPage = popup ? browser.getTabHost(popup.id) : page;
    const result = afterPage ? await this.afterObservation(input, base, scope, afterPage, `${owner}:${popup ? popup.id : tab?.id ?? page.inspectionWebContents?.id}`) : base;
    return { ...result, tabId: tab?.id, ...(popup ? { openedTabId: popup.id, detail: `${result.detail ?? ""}；已打开新标签 ${popup.id}，后续读取使用新标签` } : {}) };
  }

  private async afterObservation(input: BrowserExecInput, result: BrowserExecOutput, scope: AutomationScope, host: BrowserPageHost, owner: string): Promise<BrowserExecOutput> {
    if (!input.after) return result;
    try {
      const after = input.after;
      const observation = await this.withSurface(scope, host, async () => {
        if (after.selector || after.role || after.name) await this.executeOnPage({ action: "wait_for", ...after }, scope, host, owner);
        return this.executeOnPage({ action: "read", ...after }, scope, host, owner);
      });
      return { ...result, observation: { status: "completed", result: observation } };
    } catch (error) {
      return { ...result, observation: { status: "failed", code: error instanceof BrowserAutomationError || error instanceof UiAutomationError ? error.code : error instanceof Error ? error.name : "EXECUTION_FAILED", message: String(error) } };
    }
  }

  private withSurface<T>(scope: AutomationScope, host: BrowserPageHost, operation: () => Promise<T>): Promise<T> {
    return scope.run(() => host.withAutomationSurface(async () => {
      scope.check();
      const wc = host.inspectionWebContents;
      if (!wc || wc.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "页面已关闭");
      const ready: boolean = await scope.run(() => wc.executeJavaScript(`new Promise(resolve=>{const check=()=>innerWidth>0&&innerHeight>0?resolve(true):Date.now()>=${scope.deadline}?resolve(false):setTimeout(check,20);check();})`));
      if (!ready) throw new AutomationTimeoutError();
      return operation();
    }));
  }

  private remember(owner: string, identity: Omit<ObservedPage, "targets">, elements: NonNullable<BrowserExecOutput["elements"]>): void {
    const prior = this.observations.get(owner);
    const targets = new Map(prior?.documentId === identity.documentId ? prior.targets : []);
    for (const el of elements) {
      targets.delete(el.selector); targets.set(el.selector, el);
      if (el.id) { targets.delete(`#${el.id}`); targets.set(`#${el.id}`, el); }
    }
    while (targets.size > 512) targets.delete(targets.keys().next().value!);
    this.observations.delete(owner);
    this.observations.set(owner, { ...identity, targets });
    while (this.observations.size > 128) this.observations.delete(this.observations.keys().next().value!);
  }

  private async executeOnPage(input: BrowserExecInput, scope: AutomationScope, host: BrowserPageHost, owner: string, retained = () => true): Promise<BrowserExecOutput> {
    const wc = host.inspectionWebContents;
    if (!wc || wc.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "标签页已关闭");
    const version = host.captureVersion, url = wc.getURL();
    scope.pageUrl = url;
    const assertSurface = () => {
      if (!retained() || wc.isDestroyed() || host.inspectionWebContents !== wc || host.captureVersion !== version || wc.getURL() !== url) throw new BrowserAutomationError("SURFACE_CHANGED", "固定标签或文档已变化，请重新读取");
    };
    const release = scope.guard(assertSurface);
    let releaseInput = () => {};
    const check = () => scope.check();
    try {
    const js = async <T>(script: string): Promise<T> => {
      check();
      const result: T = await scope.run(() => wc.executeJavaScript(script, true));
      check(); return result;
    };
    if (input.action === "status") return { action: input.action, url, detail: url ? "ready" : "idle" };
    if (input.action === "read") {
      const result = await js<BrowserExecOutput & { error?: BrowserAutomationErrorCode }>(browserPageReadScript(this.observationSlot, input));
      if (result.error) throw new BrowserAutomationError(result.error, `页面读取失败：${result.error}`, { currentUrl: url, detail: result.detail });
      if (!result.documentId) throw new BrowserAutomationError("SURFACE_CHANGED", "读取未返回文档身份");
      this.remember(owner, { version, webContentsId: wc.id, url, documentId: result.documentId }, result.elements ?? []);
      return { ...result, action: input.action };
    }
    if (input.action === "screenshot") {
      const screenshot = await scope.run(() => host.captureScreenshot({ signal: scope.signal, timeoutMs: scope.remaining }));
      check(); return { action: input.action, url, title: wc.getTitle(), screenshot };
    }
    let selector = input.selector;
    let expected: UiExecInput["expected"];
    let observedSelectors: UiExecInput["observedSelectors"];
    if (["click", "fill", "press"].includes(input.action)) {
      const observed = this.observations.get(owner);
      if (!observed || observed.version !== version || observed.webContentsId !== wc.id || observed.url !== url) throw new BrowserAutomationError("SURFACE_CHANGED", "需要先 read/find 当前任务标签，再操作已观察目标");
      observedSelectors = [...new Set([...observed.targets.values()].map(target => target.selector))];
      const documentId = await js<string | undefined>(`window[${JSON.stringify(this.observationSlot)}]?.documentId`);
      if (documentId !== observed.documentId) throw new BrowserAutomationError("SURFACE_CHANGED", "观察所属文档已替换");
      if (selector) {
        const target = observed.targets.get(selector);
        if (!target) throw new BrowserAutomationError("SURFACE_CHANGED", "selector 不属于当前文档观察，请先 find");
        selector = target.selector;
        expected = { tag: target.tag, name: target.label || undefined };
        const current = await js<{ name?: string; tag?: string }>(`(() => {const el=document.querySelector(${JSON.stringify(selector)});return el?{tag:el.localName,name:el.getAttribute('aria-label')||undefined}:{};})()`);
        if (current.tag !== target.tag || current.name && current.name !== target.label) throw new BrowserAutomationError("SURFACE_CHANGED", "目标节点或语义已变化");
      }
    }
    let inputTransport;
    if (["click", "fill", "press"].includes(input.action)) {
      const existing = pageInspectionService.sessionFor(wc, "browser-host");
      const session = existing ?? pageInspectionService.acquire(wc, "browser-host");
      releaseInput = () => { if (!existing) pageInspectionService.release(wc, "browser-host"); };
      await scope.run(() => session.attach(wc.debugger));
      await scope.run(() => session.suspendInputOverlay(() => scope.check()));
      inputTransport = browserNativeInput(session);
    }
    const executor = new UiAutomationService({ app: () => null, artifact: () => null, browser: () => wc, input: inputTransport });
    if (input.action === "navigate") throw new BrowserAutomationError("INVALID_INPUT", "navigate 必须由标签管理器执行");
    const uiInput: UiExecInput = { action: input.action, target: "browser", selector, role: input.role, name: input.name, text: input.action !== "fill" ? input.text : undefined, value: input.text, key: input.key, state: input.state, timeoutMs: scope.remaining, expected, observedSelectors };
    const result = await executor.execute(uiInput, scope.signal, scope);
    const elements = result.elements?.map((el: UiElementInfo) => ({ selector: el.selector, id: el.id, tag: el.tag, label: el.name ?? "" }));
    if (input.action === "find" || input.action === "inspect") {
      const documentId = await js<string>(browserDocumentScript(this.observationSlot));
      this.remember(owner, { version, webContentsId: wc.id, url, documentId }, elements ?? []);
      return { action: input.action, url, documentId, elements, detail: result.detail };
    }
    release();
    scope.check();
    const output: BrowserExecOutput = { action: input.action, url: wc.getURL(), elements, detail: result.detail };
    return output;
    } finally { releaseInput(); release(); }
  }
}
