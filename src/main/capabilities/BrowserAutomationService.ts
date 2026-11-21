import { GadgetPreviewUnavailableError, type GadgetBrowserPreview } from "../gadget/GadgetService";
import { browserTabKey, type BrowserTabInfo } from "../../shared/browser-tabs";
import type { BrowserHost, BrowserPageHost } from "../browser/BrowserHost";
import { UiAutomationService, UiAutomationError, type UiElementInfo, type UiExecInput, type UiNativeInput } from "./UiAutomationService";
import { AutomationScope, AutomationTimeoutError } from "./AutomationScope";
import { browserDocumentScript, browserPageReadScript, type BrowserReadOptions } from "./BrowserPageRead";
import { PageCaptureError, pageInspectionService } from "../artifact/PageInspectionService";
import { htmlDragFromSource, BrowserHtmlDragError } from "./browser/BrowserHtmlDrag";
import { browserNativeInput } from "./BrowserNativeInput";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordHostToolNotStarted } from "../agent/durable/DurableToolOutcome";
import { currentDurableInvocation } from "../agent/durable/DurableExecutionContext";
import { BROWSER_EXEC_ACTIONS, browserFetchRequestSchema } from "./BrowserToolContract";
import { browserConditionSchema, browserConditionsScript, parseBrowserConditionEvidence, type BrowserCondition, type BrowserConditionEvidence } from "./browser/BrowserConditions";
import { exportBrowserCollection, BrowserCollectionExportError, type BrowserCollectionExport } from "./browser/BrowserCollectionExport";
import { BrowserPromptError } from "./browser/BrowserPrompt";
import { BrowserCollection, type CollectionResult } from "./browser/BrowserCollection";
import { browserCollectionSchema, type BrowserCollectionOptions } from "./browser/BrowserCollectionSchema";
import { createBrowserCollectionDomSource, type CollectionDomCoverage } from "./browser/BrowserCollectionDom";
import { BrowserVisualInput, BrowserVisualInputError, type BrowserVisualViewport } from "./browser/BrowserVisualInput";
import { uploadBrowserFiles, validateBrowserUploadFiles, type BrowserUploadResult } from "./browser/BrowserUploads";
import { BrowserHandoff, type BrowserHandoffRequest, type BrowserHandoffIdentity } from "./browser/BrowserHandoff";
import { runBrowserLogin } from "./browser/BrowserLogin";
import { BrowserExpressionError, evaluatePageSnapshot, pageFetchScript, pageSnapshotScript, type BrowserFetchRequest, type PageSnapshot } from "./browser/BrowserPageScript";
import { browserEditorScript } from "./browser/BrowserEditor";
import { browserEventReceiptScript, browserEventTypes, subscribeToBrowserEvent, type BrowserEventType, type BrowserEventReceipt } from "./browser/BrowserEventSubscription";
import { strokeOnElement, type GesturePoint } from "./browser/BrowserGestures";
import type { BrowserRenewalStatus } from "../browser/BrowserSessionRenewal";
import { Value } from "typebox/value";
import { BrowserPageRuntimes } from "./browser/BrowserPageRuntime";
import { BrowserAccessibilityError, type BrowserAXSnapshot } from "./browser/BrowserAccessibility";
import type { DialogRule, DialogAnswer, ResponseCriteria, ResponseWatch, DownloadWatch, DownloadCriteria, DownloadResult, PageDialog, PageTrace } from "./browser/BrowserPageEvents";
import { withBrowserDom } from "./browser/BrowserDom";
import { bindBrowserDocument, listBrowserFrames, BrowserDocumentContextError, type BrowserFrameInfo } from "./browser/BrowserDocumentContext";

export type BrowserExecAction = typeof BROWSER_EXEC_ACTIONS[number];
export const BROWSER_INPUT_ACTIONS: ReadonlySet<BrowserExecAction> = new Set(["click", "fill", "focus", "insert_text", "paste", "drag", "press", "scroll", "hover", "select", "check", "upload"]);

export const BROWSER_AUTOMATION_ERROR_CODES = [
  "HOST_UNAVAILABLE", "INVALID_INPUT", "INVALID_URL", "INVALID_SELECTOR", "NAVIGATION_FAILED",
  "PAGE_UNAVAILABLE", "SCREENSHOT_EMPTY", "SELECTOR_NOT_FOUND", "ELEMENT_NOT_CLICKABLE", "ELEMENT_NOT_EDITABLE",
  "FOCUS_FAILED", "SCREENSHOT_STALE", "EXECUTION_FAILED", "SCRIPT_ERROR", "CAPTURE_TIMEOUT", "SURFACE_CHANGED",
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
  expression?: string;
  editSelector?: string;
  eventType?: BrowserEventType;
  listenerId?: string;
  request?: BrowserFetchRequest;
  html?: string;
  gadgetId?: string;
  tabId?: string;
  verifyTabId?: string;
  challenge?: "qr" | "code";
  tabTitle?: string;
  tabUrl?: string;
  frameId?: string;
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
  deltaX?: number;
  deltaY?: number;
  values?: string[];
  checked?: boolean;
  button?: UiExecInput["button"];
  clickCount?: UiExecInput["clickCount"];
  modifiers?: UiExecInput["modifiers"];
  inputMode?: UiExecInput["inputMode"];
  delayMs?: number;
  dateType?: UiExecInput["dateType"];
  dragTo?: string;
  dragMode?: UiExecInput["dragMode"];
  points?: GesturePoint[];
  /** Ordered menu ancestors, observed and hovered on this same leased page. */
  hover?: Array<Pick<UiExecInput, "selector" | "role" | "name" | "text">>;
  files?: string[];
  collection?: BrowserCollectionOptions;
  maxSteps?: number;
  maxRows?: number;
  captureId?: string;
  x?: number;
  y?: number;
  reason?: "login" | "2fa";
  token?: string;
  expect?: BrowserCondition[];
  axNodeId?: string;
  documentId?: string;
  traceCursor?: number;
  dialog?: DialogAnswer & { id: string };
  dialogRules?: DialogRule[];
  response?: ResponseCriteria;
  download?: DownloadCriteria;
  after?: { selector?: string; role?: string; name?: string; state?: UiExecInput["state"]; mode?: "text" | "interactive"; maxChars?: number };
}
export interface BrowserExecOutput {
  action: BrowserExecAction;
  listenerId?: string;
  value?: unknown;
  fetched?: { status: number; ok: boolean; contentType: string; body: string; truncated: boolean };
  artifactId?: string;
  downloadArtifact?: { status: "registered" | "failed"; reason?: string };
  gadgetId?: string;
  tabId?: string;
  activeTabId?: string;
  sourceTabId?: string;
  url?: string;
  title?: string;
  sourceUrl?: string;
  text?: string;
  detail?: string;
  screenshot?: Uint8Array;
  recoveredFromUrl?: string;
  openedTabId?: string;
  tabs?: BrowserTabInfo[];
  captureId?: string;
  viewport?: BrowserVisualViewport;
  point?: { x: number; y: number };
  upload?: BrowserUploadResult;
  collectionFile?: BrowserCollectionExport;
  collectionArtifact?: { status: "registered" | "failed"; artifactId?: string; reason?: string };
  collection?: CollectionResult & { horizontalCoverage: CollectionDomCoverage; outputTruncated?: boolean };
  handoff?: { token?: string; initialDocumentId?: string; status?: "confirmed" | "pending" };
  login?: { status: "confirmed" | "inspect" };
  renewal?: BrowserRenewalStatus;
  accessibility?: BrowserAXSnapshot;
  businessResult?: { status: "passed" | "failed"; evidence: BrowserConditionEvidence[]; reason?: string };
  diagnostics?: { events: PageTrace[]; cursor: number; truncated: boolean };
  dialog?: PageDialog;
  response?: Extract<PageTrace, { kind: "response" }>;
  download?: DownloadResult;
  frames?: BrowserFrameInfo[];
  frameId?: string;
  /** Observed targets, never guessed selectors or editable values. */
  elements?: Array<Pick<UiElementInfo, "selector" | "tag"> & Partial<Pick<UiElementInfo, "type" | "id" | "role" | "visible" | "disabled" | "bounds" | "checked" | "options" | "optionsTruncated" | "outerHTML" | "styles" | "expanded" | "hiddenBy">> & { label: string }>;
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
  coverage?: { iframe: "selected-document"; shadowDOM: "open"; closedShadowDOM: "excluded" };
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
  private readonly collections = new BrowserCollection();
  private readonly visual = new BrowserVisualInput();
  private readonly handoffs = new BrowserHandoff();
  private readonly loginTabs = new Set<string>();
  // Routing hint only. Website state is checked again on each login request.
  private readonly loginOrigins = new WeakMap<BrowserPageHost, string>();
  private readonly runtimes = new BrowserPageRuntimes(this.observationSlot);
  private readonly axSnapshots = new Map<string, BrowserAXSnapshot>();
  private readonly observations = new Map<string, ObservedPage>();

  private readonly pageFlights = new Map<number, Promise<void>>();
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

  async beginHandoff(input: BrowserExecInput, signal: AbortSignal | undefined, context: { taskId: string; requestKey: string; ask: BrowserHandoffRequest["ask"] }): Promise<BrowserExecOutput> {
    if (input.action !== "handoff" || !input.tabId || !input.reason) throw new BrowserAutomationError("INVALID_INPUT", "handoff 需要 tabId 与 reason:login/2fa");
    const browser = this.host();
    const invocation = currentDurableInvocation();
    const ownerId = invocation ? `${invocation.execution.taskId}:${invocation.native.conversationId}` : context.taskId;
    const inspectTab = async (): Promise<BrowserHandoffIdentity> => {
      signal?.throwIfAborted();
      const tab = browser?.listTabs().find(t => t.id === input.tabId && t.taskId === context.taskId);
      const wc = tab && browser?.getTabHost(tab.id)?.inspectionWebContents;
      if (!wc || wc.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "人工交接标签已关闭或不属于当前任务");
      const readScope = new AutomationScope(signal, 3000);
      try { return { taskId: context.taskId, ownerId, tabId: tab.id, webContentsId: wc.id, documentId: await readScope.run(() => wc.executeJavaScript(browserDocumentScript(this.observationSlot))) }; }
      finally { readScope.close(); }
    };
    const identity = await inspectTab();
    if (!browser?.presentTabForUser(identity.tabId)) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "无法呈现人工交接标签");
    const handoff = await this.handoffs.begin({ identity, requestKey: context.requestKey, reason: input.reason, signal, ask: context.ask, inspectTab });
    this.observations.delete(`${ownerId}:${identity.tabId}`);
    this.axSnapshots.delete(`${ownerId}:${identity.tabId}`);
    return { action: input.action, tabId: identity.tabId, handoff, outcome: { dispatch: "not_started", effect: "none" } };
  }

  async execute(input: BrowserExecInput, signal?: AbortSignal, context?: { taskId: string; taskRoot?: string; resolveGadgetId?: (url: string) => Promise<string | undefined>; onLoginRequired?: () => void }): Promise<BrowserExecOutput> {
    // Validate the complete request before touching the browser surface. A durable
    // checkpoint written here proves this exact invocation never began its action.
    try {
      if (!BROWSER_EXEC_ACTIONS.includes(input.action)) {
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
      if (input.verifyTabId !== undefined && input.action !== "login") throw new BrowserAutomationError("INVALID_INPUT", "verifyTabId 仅用于 login");
      if (input.challenge !== undefined && (input.action !== "login" || !["qr", "code"].includes(input.challenge) ||
          !/^\[data-mybuddy-ui-ref="mb-[\w-]+"\]$/.test(input.selector ?? ""))) {
        throw new BrowserAutomationError("INVALID_INPUT", "自定义验证需要 login、challenge 和 find 返回的当前节点引用");
      }
      if (input.tabTitle !== undefined || input.tabUrl !== undefined) {
        if (input.action !== "select_tab" || input.tabId) throw new BrowserAutomationError("INVALID_INPUT", "tabTitle/tabUrl 仅用于 select_tab，不能与 tabId 同时使用");
        if (input.tabTitle !== undefined) requireShort(input.tabTitle, "tabTitle", 1000);
        if (input.tabUrl !== undefined) requireShort(input.tabUrl, "tabUrl", 2000);
      }
      if (input.action === "select_tab" && !input.tabId && !input.tabTitle && !input.tabUrl) throw new BrowserAutomationError("INVALID_INPUT", "select_tab 需要 tabId 或精确的 tabTitle/tabUrl；先 tabs 获取候选标签");
      if (input.frameId !== undefined) {
        requireShort(input.frameId, "frameId", 200);
        if (input.action === "navigate" || input.action === "screenshot") throw new BrowserAutomationError("INVALID_INPUT", "navigate 和 screenshot 使用标签页，frameId 用于文档内观察与操作");
      }
      if (input.action === "navigate" || input.action === "open") assertBrowserUrl(requireShort(input.url, "url", 2_000));
      if (input.action === "evaluate") requireShort(input.expression, "expression", 16_000);
      if (input.action === "listen" && (!input.selector || !input.eventType || !browserEventTypes.includes(input.eventType))) throw new BrowserAutomationError("INVALID_INPUT", "listen 需要已观察控件及事件类型");
      if (input.listenerId !== undefined && (input.action !== "evaluate" || !/^[\da-f-]{36}$/.test(input.listenerId))) throw new BrowserAutomationError("INVALID_INPUT", "evaluate 需要有效的事件订阅");
      if (input.editSelector !== undefined && (input.action !== "evaluate" || !input.editSelector || input.editSelector.length > 1000)) throw new BrowserAutomationError("INVALID_INPUT", "editSelector 需要已观察的普通文本框");
      if (input.points !== undefined && (input.action !== "drag" || !input.selector || input.dragTo || input.dragMode === "html"
        || !Array.isArray(input.points) || input.points.length < 2 || input.points.length > 64
        || !input.points.every(p => p && [p.x, p.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)))) throw new BrowserAutomationError("INVALID_INPUT", "画线需要已观察控件及 2..64 个控件内的比例坐标");
      if (input.action === "fetch") requireShort(input.url, "url", 2_000);
      if (input.request && (input.action !== "fetch" || !Value.Check(browserFetchRequestSchema, input.request)
        || ["GET", "HEAD"].includes(input.request.method) && input.request.body !== undefined
        || input.download && input.request.method !== "GET")) throw new BrowserAutomationError("INVALID_INPUT", "无效的网页请求方法、正文或下载选项");
      if (["focus", "insert_text", "paste"].includes(input.action) && !input.selector) throw new BrowserAutomationError("INVALID_INPUT", "编辑操作需要已观察目标 selector");
      if (["insert_text", "paste"].includes(input.action) && (typeof input.text !== "string" || input.text.length > 100000)) throw new BrowserAutomationError("INVALID_INPUT", "需要 100000 字符以内的 text");
      if (input.html !== undefined && (input.action !== "paste" || typeof input.html !== "string" || input.html.length > 100000)) throw new BrowserAutomationError("INVALID_INPUT", "paste 的 html 最多 100000 字符");
      if (["click", "fill", "press", "hover", "select", "check", "find", "inspect", "wait_for"].includes(input.action) && !input.axNodeId && !input.selector && !input.role && !input.name && !input.label && !input.placeholder && !input.testId && !(input.action !== "fill" && input.text)) throw new BrowserAutomationError("INVALID_INPUT", "需要 selector / role / name / text / label / placeholder / testId 定位");
      if (input.action === "collect" && !Value.Check(browserCollectionSchema, input.collection)) throw new BrowserAutomationError("INVALID_INPUT", "collect 需要有效的 collection 配置与明确的结束条件");
      if ((input.action === "upload" || input.files !== undefined) && (!["click", "upload"].includes(input.action) || !Array.isArray(input.files) || !input.files.length || input.files.length > 20 || input.files.some(p => typeof p !== "string" || !p || p.length > 4000))) throw new BrowserAutomationError("INVALID_INPUT", "click 或 upload 可指定 1..20 个当前任务目录内文件");
      if (input.action === "click_at" || input.action === "scroll_at") {
        if (!input.captureId || !Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new BrowserAutomationError("INVALID_INPUT", "坐标操作需要 captureId 与截图像素坐标 x/y");
        if (input.frameId) throw new BrowserAutomationError("INVALID_INPUT", "截图坐标属于整个标签页，不能传 frameId");
      }
      if (input.action === "resume" && (!input.token || !input.expect)) throw new BrowserAutomationError("INVALID_INPUT", "resume 需要人工完成后签发的 token 和登录状态 expect 条件");
      if (input.expect !== undefined && (!Array.isArray(input.expect) || !input.expect.length || input.expect.length > 16 || !input.expect.every(c => Value.Check(browserConditionSchema, c)))) throw new BrowserAutomationError("INVALID_INPUT", "expect 需要 1..16 个有效条件");
      if (input.action === "assert" && !input.expect) throw new BrowserAutomationError("INVALID_INPUT", "assert 需要 expect 条件");
      if (input.axNodeId && (input.action !== "find" || !input.documentId)) throw new BrowserAutomationError("INVALID_INPUT", "AX 引用转换需要 find + axNodeId + documentId");
      if (input.dialog && input.action !== "dialog") throw new BrowserAutomationError("INVALID_INPUT", "dialog 应答仅用于 dialog action");
      if (input.action === "dialog" && !input.dialog) throw new BrowserAutomationError("INVALID_INPUT", "dialog 需要 id 和 action");
      if ((input.response || input.download && input.action !== "fetch" || input.dialogRules && !["navigate", "reload", "back", "forward", "close"].includes(input.action)) && !BROWSER_INPUT_ACTIONS.has(input.action)) throw new BrowserAutomationError("INVALID_INPUT", "response/download/dialogRules 必须与支持的动作一起提交");
      if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 30_000)) throw new BrowserAutomationError("INVALID_INPUT", "timeout_ms 必须为 100..30000");
      for (const [label, value, max] of [["selector", input.selector, 1000], ["role", input.role, 200], ["name", input.name, 1000], ["cursor", input.cursor, 300]] as const) if (value !== undefined) requireShort(value, label, max);
      if (input.maxChars !== undefined && (!Number.isSafeInteger(input.maxChars) || input.maxChars < 1000 || input.maxChars > 100000)) throw new BrowserAutomationError("INVALID_INPUT", "max_chars 必须为 1000..100000");
      if (input.mode !== undefined && !["text", "interactive"].includes(input.mode)) throw new BrowserAutomationError("INVALID_INPUT", "未知读取模式");
      if (input.after && input.action !== "navigate" && input.action !== "select_tab" && input.action !== "wait_for" && input.action !== "click_at" && input.action !== "scroll_at" && !BROWSER_INPUT_ACTIONS.has(input.action)) throw new BrowserAutomationError("INVALID_INPUT", "after 仅用于导航、切换标签、动作或条件等待");
      if (input.action === "check" && typeof input.checked !== "boolean") throw new BrowserAutomationError("INVALID_INPUT", "check 需要 checked 布尔值");
      if (input.action === "select" && (!Array.isArray(input.values) || input.values.length > 80 || input.values.some(value => typeof value !== "string" || value.length > 1000))) throw new BrowserAutomationError("INVALID_INPUT", "select 需要 values 字符串数组，最多 80 项，每项最多 1000 字符");
      if (input.action === "scroll" && (![input.deltaX ?? 0, input.deltaY ?? 0].every(value => Number.isFinite(value) && Math.abs(value) <= 100000) || !(input.deltaX || input.deltaY))) throw new BrowserAutomationError("INVALID_INPUT", "scroll 需要非零 delta_x/delta_y，范围 -100000..100000");
      if (input.hover !== undefined) {
        if (!BROWSER_INPUT_ACTIONS.has(input.action) || !Array.isArray(input.hover) || !input.hover.length || input.hover.length > 8) throw new BrowserAutomationError("INVALID_INPUT", "hover 路径仅用于输入动作，包含 1..8 个菜单定位");
        for (const target of input.hover) {
          if (!target || ![target.selector, target.role, target.name, target.text].some(value => typeof value === "string" && value.trim())) throw new BrowserAutomationError("INVALID_INPUT", "hover 路径每层需要 selector/role/name/text 定位");
          for (const [label, value, max] of [["selector", target.selector, 1000], ["role", target.role, 200], ["name", target.name, 1000], ["text", target.text, 4000]] as const) if (value !== undefined) requireShort(value, label, max);
        }
      }
      for (const value of [input.offset, input.elementOffset]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new BrowserAutomationError("INVALID_INPUT", "读取偏移必须是非负整数");
      if (input.action === "press") requireShort(input.key, "key", 60);
      if (input.action === "fill" && (input.text?.length ?? 0) > 100_000) {
        throw new BrowserAutomationError("INVALID_INPUT", "text 过长", { max: 100_000 });
      }
    } catch (error) {
      await recordHostToolNotStarted("browser_exec");
      throw error;
    }
    if (input.action === "login") {
      const host = this.host();
      const taskId = context?.taskId ?? currentDurableInvocation()?.execution.taskId;
      if (!host?.attached || !taskId) throw new BrowserAutomationError("HOST_UNAVAILABLE", "登录需要当前任务的内置浏览器");
      const tab = host.listTabs().find(tab => tab.id === input.tabId && tab.taskId === taskId);
      if (!tab) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "login 需要本任务已打开的 tabId");
      const key = tab.openerTabId ?? tab.id;
      if (this.loginTabs.has(key)) throw new BrowserAutomationError("INVALID_INPUT", "当前页面已有登录操作，请等待其结果");
      this.loginTabs.add(key);
      try {
        const result = await runBrowserLogin({ input, host, tab, taskId, signal, observationSlot: this.observationSlot,
          withSurface: (scope, page, operation) => this.withSurface(scope, page, operation),
          execute: command => this.execute(command, signal, context), onLoginRequired: context?.onLoginRequired });
        const verifiedPage = result.login?.status === "confirmed" && result.tabId && host.getTabHost(result.tabId);
        if (verifiedPage) {
          const origin = new URL(input.url!).origin;
          const verifiedUrl = verifiedPage.inspectionWebContents?.getURL();
          if (verifiedUrl && new URL(verifiedUrl).origin === origin) {
            this.loginOrigins.set(verifiedPage, origin);
            result.renewal = await host.trackVerifiedLogin(verifiedUrl);
          }
        }
        return result;
      } finally { this.loginTabs.delete(key); }
    }
    const scope = new AutomationScope(signal, input.timeoutMs);
    try {
      const result = await this.executeManaged(input, scope, context);
      return { ...result, action: input.action, outcome: { dispatch: scope.dispatched ? "dispatched" : "not_started", effect: scope.confirmed ? "confirmed" : scope.dispatched ? "unknown" : "none" } };
    } catch (error) {
      const outcome = { dispatch: scope.dispatched ? "dispatched" : "not_started", effect: scope.confirmed ? "confirmed" : scope.dispatched ? "unknown" : "none" };
      const evidence = { outcome, currentUrl: scope.pageUrl };
      if (!scope.dispatched && (input.action === "navigate" || BROWSER_INPUT_ACTIONS.has(input.action))) await recordHostToolNotStarted("browser_exec");
      if (error instanceof Error && error.name === "AbortError") {
        Object.assign(error, { details: evidence }); throw error;
      }
      if (error instanceof AutomationTimeoutError) throw new BrowserAutomationError("WAIT_TIMEOUT", error.message, evidence);
      if (error instanceof PageCaptureError && error.code !== "CANCELLED") throw new BrowserAutomationError(error.code, error.message, evidence);
      if (error instanceof BrowserAutomationError) throw new BrowserAutomationError(error.code, error.message, { ...evidence, ...(error.details && typeof error.details === "object" ? error.details : {}), outcome });
      if (error instanceof BrowserExpressionError) {
        const guidance = /Cannot read properties of (?:null|undefined)/i.test(error.message)
          ? "用 find 或 inspect 核对元素，处理查询为空的情况后重新计算。" : "请修正表达式后重新计算。";
        throw new BrowserAutomationError("SCRIPT_ERROR", `evaluate 表达式出错：${error.message}。${guidance}`, evidence);
      }
      if (error instanceof BrowserHtmlDragError) throw new BrowserAutomationError(error.code, error.message, evidence);
      if (error instanceof BrowserPromptError) throw new BrowserAutomationError(error.code, error.message, evidence);
      if (error instanceof BrowserCollectionExportError) throw new BrowserAutomationError("EXECUTION_FAILED", error.message, { ...evidence, ...error.details });
      if (error instanceof BrowserVisualInputError) throw new BrowserAutomationError(error.code, error.message, evidence);
      if (error instanceof BrowserAccessibilityError) throw new BrowserAutomationError(error.code, error.message, evidence);
      if (error instanceof BrowserDocumentContextError) throw new BrowserAutomationError(error.code, error.message, { ...evidence, frameId: input.frameId });
      if (error instanceof UiAutomationError) {
        const mapping: Partial<Record<UiAutomationError["code"], BrowserAutomationErrorCode>> = { ELEMENT_NOT_FOUND: "SELECTOR_NOT_FOUND", ELEMENT_DISAPPEARED: "SURFACE_CHANGED", TARGET_UNAVAILABLE: "PAGE_UNAVAILABLE", INVALID_LOCATOR: "INVALID_INPUT", UNSUPPORTED_ACTION: "INVALID_INPUT" };
        const code = mapping[error.code] ?? BROWSER_AUTOMATION_ERROR_CODES.find(code => code === error.code) ?? "EXECUTION_FAILED";
        throw new BrowserAutomationError(code, error.message, { ...evidence, ...(error.details && typeof error.details === "object" ? error.details : {}), outcome });
      }
      throw new BrowserAutomationError("EXECUTION_FAILED", String(error), evidence);
    } finally { scope.close(); }
  }

  private async executeManaged(input: BrowserExecInput, scope: AutomationScope, context?: { taskId: string; taskRoot?: string; resolveGadgetId?: (url: string) => Promise<string | undefined> }): Promise<BrowserExecOutput> {
    const signal = scope.signal;
    scope.check();
    const browser = this.host();
    if (!browser || !browser.attached) throw new BrowserAutomationError("HOST_UNAVAILABLE", "MyBuddy 浏览器尚未挂载");
    const invocation = currentDurableInvocation();
    const taskId = context?.taskId ?? invocation?.execution.taskId;
    if (input.gadgetId && (!taskId || !this.resolveGadgetPreview)) throw new BrowserAutomationError("INVALID_INPUT", "Gadget 导航需要当前任务及 Gadget 服务");
    const owner = invocation ? `${invocation.execution.taskId}:${invocation.native.conversationId}` : taskId ?? "direct-host-entry";
    const tabs = taskId ? browser.listTabs().filter(tab => tab.taskId === taskId) : [];
    let tab = input.tabId ? tabs.find(tab => tab.id === input.tabId) : taskId ? browser.getTaskTab(taskId) : undefined;
    if (input.tabId && !tab) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "标签页已关闭或不属于当前任务，请重新导航", { tabId: input.tabId });
    if (input.action === "select_tab" && !input.tabId) {
      const candidates = tabs.filter(value => (input.tabTitle === undefined || value.title === input.tabTitle) && (input.tabUrl === undefined || value.url === input.tabUrl));
      if (candidates.length !== 1) throw new BrowserAutomationError(candidates.length ? "ELEMENT_AMBIGUOUS" : "SELECTOR_NOT_FOUND", "标签定位不唯一或未找到，请从 tabs 返回的候选中使用 tabId", { tabs: candidates.length ? candidates : tabs });
      tab = candidates[0];
    }
    if ((input.action === "status" || input.action === "tabs") && taskId) return { action: input.action, tabId: tab?.id, activeTabId: tabs.some(value => value.id === browser.activeTabId) ? browser.activeTabId ?? undefined : undefined, url: tab?.url || undefined, title: tab?.title, tabs, detail: tab?.url ? "ready" : "idle", ...(input.action === "status" && tab?.url ? { renewal: browser.loginRenewalStatus(tab.url) } : {}) };
    if (input.action === "tabs") throw new BrowserAutomationError("INVALID_INPUT", "tabs 需要当前任务");
    if (tab?.loginChallenge && input.action !== "open" && input.action !== "navigate") throw new BrowserAutomationError("PAGE_UNAVAILABLE", "用户正在此页完成登录，任务将在验证完成后继续");
    if (input.action === "open") {
      if (!taskId) throw new BrowserAutomationError("INVALID_INPUT", "open 需要当前任务");
      scope.dispatch();
      tab = browser.ensureTab({ key: `browser-open:${randomUUID()}`, taskId, activate: false });
      input = { ...input, action: "navigate", tabId: tab.id };
      scope.pageUrl = `created-tab:${tab.id}`;
    }
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
        if (taskId && this.resolveGadgetPreview) {
          const gadgetId = input.gadgetId ?? await scope.run(async () => context?.resolveGadgetId?.(requested));
          preview = await scope.run(() => this.resolveGadgetPreview!(requested, taskId, gadgetId));
        }
        if (signal?.aborted) throw new DOMException("浏览器操作已取消", "AbortError");
        if (this.navigationRequests.get(navigationOwner) !== request || page && page.captureVersion !== previousVersion) {
          throw new BrowserAutomationError("SURFACE_CHANGED", "恢复预览期间页面已变化，请重新读取后再导航");
        }
        target = preview?.url ?? requested;
        if (taskId && !input.tabId) {
          const key = browserTabKey(target, preview?.gadgetId);
          const owned = browser.listTabs().filter(value => value.taskId === taskId);
          const site = !preview && /^https?:/.test(target) ? new URL(target).origin : undefined;
          const atTarget = site ? owned.filter(value => !value.gadgetId && value.url === target) : [];
          const loggedIn = site ? owned.filter(value => {
            const host = browser.getTabHost(value.id);
            return host && !value.gadgetId && value.url.startsWith(site + "/") && this.loginOrigins.get(host) === site;
          }) : [];
          const existing = atTarget.find(value => value.id === tab?.id)
            ?? (atTarget.length === 1 ? atTarget[0] : undefined) ?? owned.find(value => value.key === key)
            ?? loggedIn.find(value => value.id === tab?.id) ?? (loggedIn.length === 1 ? loggedIn[0] : undefined);
          if (existing && (!versions.has(existing.id) || browser.getTabHost(existing.id)?.captureVersion !== versions.get(existing.id))) {
            throw new BrowserAutomationError("SURFACE_CHANGED", "目标标签在恢复预览期间变化，请重新读取后再导航");
          }
          tab = existing ?? browser.ensureTab({ key, taskId, gadgetId: preview?.gadgetId, activate: false });
        }
        if (tab && browser.listTabs().some(t => t.id === tab!.id && t.loginChallenge)) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "此标签等待用户验证，请保留当前页面");
        if (tab) page = browser.getTabHost(tab.id);
        if (taskId && tab) browser.setTaskTab(taskId, tab.id);
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
        if ((context?.taskRoot || input.dialogRules) && !wcBefore.getURL()) {
          scope.dispatch();
          await scope.run(() => wcBefore.loadURL("about:blank"));
        }
        const runtime = context?.taskRoot || input.dialogRules ? await this.runtimes.get(wcBefore, scope, context?.taskRoot) : undefined;
        const releaseDialogs = runtime?.events.armDialogRules(input.dialogRules ?? []);
        try {
          scope.dispatch();
          await scope.run(() => navigationPage.navigateForAutomation(target, signal, { reload }));
        } catch (error) { await runtime?.events.settleNavigationDialog(scope); throw error; }
        finally { releaseDialogs?.(); }
        if (navigationTabId && browser.getTabHost(navigationTabId) !== navigationPage) throw new BrowserAutomationError("SURFACE_CHANGED", "导航目标标签已关闭");
        if (this.navigationRequests.get(navigationOwner) !== request || this.navigationRequests.get(pageNavigationKey) !== pageRequest) throw new BrowserAutomationError("SURFACE_CHANGED", "导航已被较新的浏览器请求替代，请重新读取");
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
    const page = taskId ? tab && browser.getTabHost(tab.id) : browser.activeTabId ? browser.getTabHost(browser.activeTabId) : null;
    if (!page) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "当前任务没有可用标签页，请 navigate 打开页面；不会自动接管其它任务的页面");
    const managedWc = page.inspectionWebContents;
    if (!managedWc || managedWc.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "保留的标签页已关闭");
    if (taskId && tab && input.tabId && input.action !== "close") browser.setTaskTab(taskId, tab.id);
    if (input.action === "select_tab") {
      if (!taskId || !tab) throw new BrowserAutomationError("INVALID_INPUT", "标签切换需要当前任务的目标标签");
      scope.dispatch();
      if (!browser.selectTab(tab.id, false)) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "切换目标标签已关闭");
      scope.confirmed = true;
      return this.afterObservation(input, { action: input.action, tabId: tab.id, activeTabId: tab.id, url: managedWc.getURL(), title: managedWc.getTitle(), tabs: browser.listTabs().filter(value => value.taskId === taskId) }, scope, page, `${owner}:${tab.id}`);
    }
    if (input.action === "close") {
      if (!taskId || !tab) throw new BrowserAutomationError("INVALID_INPUT", "标签管理需要本任务的 tabId");
      const runtime = context?.taskRoot || input.dialogRules ? await this.runtimes.get(managedWc, scope, context?.taskRoot) : undefined;
      const releaseDialogs = runtime?.events.armDialogRules(input.dialogRules ?? []);
      try {
        scope.dispatch();
        const wc = page.inspectionWebContents;
        let denied = false;
        const onPrevent = (event: {defaultPrevented: boolean}) => { denied = !event.defaultPrevented; };
        wc?.on("will-prevent-unload", onPrevent);
        try {
          browser.closeTab(tab.id);
          while (browser.getTabHost(tab.id) || wc && !wc.isDestroyed()) {
            if (denied) { await runtime?.events.settleNavigationDialog(scope); throw new BrowserAutomationError("NAVIGATION_FAILED", "页面拒绝关闭；如需离开，请显式提供 beforeunload 接受规则", { tabId: tab.id }); }
            await scope.run(() => new Promise<void>(resolve => setTimeout(resolve, 20)));
          }
        } finally { wc?.off("will-prevent-unload", onPrevent); }
        scope.confirmed = true;
        return { action: input.action, tabId: tab.id, tabs: browser.listTabs().filter(t => t.taskId === taskId) };
      } finally { releaseDialogs?.(); }
    }
    if (["back", "forward", "reload"].includes(input.action)) {
      const wc = page.inspectionWebContents;
      if (!wc || wc.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "标签页已关闭");
      const history = wc.navigationHistory;
      if (input.action === "back" && !history.canGoBack() || input.action === "forward" && !history.canGoForward()) throw new BrowserAutomationError("INVALID_INPUT", "没有可用的历史页面");
      const runtime = context?.taskRoot || input.dialogRules ? await this.runtimes.get(wc, scope, context?.taskRoot) : undefined;
      const releaseDialogs = runtime?.events.armDialogRules(input.dialogRules ?? []);
      try {
      scope.dispatch();
      await scope.run(() => new Promise<void>((resolve, reject) => {
        const cleanup = () => { wc.off("did-finish-load", done); wc.off("did-navigate-in-page", inPage); wc.off("did-fail-load", failed); wc.off("will-prevent-unload", prevented); scope.signal?.removeEventListener("abort", aborted); clearTimeout(timer); };
        const done = () => { cleanup(); resolve(); };
        const inPage = (_event: unknown, _url: string, main: boolean) => { if (main) done(); };
        const prevented = (event: {defaultPrevented: boolean}) => { if (!event.defaultPrevented) { cleanup(); reject(new BrowserAutomationError("NAVIGATION_FAILED", "页面拒绝离开；请显式提供 beforeunload 规则")); } };
        const failed = (_event: unknown, code: number, message: string, _url: string, main: boolean) => { if (main && code !== -3) { cleanup(); reject(new BrowserAutomationError("NAVIGATION_FAILED", message)); } };
        const aborted = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
        const timer = setTimeout(() => { cleanup(); reject(new AutomationTimeoutError()); }, scope.remaining);
        wc.on("did-finish-load", done); wc.on("did-navigate-in-page", inPage); wc.on("did-fail-load", failed); wc.on("will-prevent-unload", prevented); scope.signal?.addEventListener("abort", aborted, { once: true });
        try { if (input.action === "back") history.goBack(); else if (input.action === "forward") history.goForward(); else wc.reloadIgnoringCache(); } catch (error) { cleanup(); reject(error); }
      }));
      scope.confirmed = true;
      return this.afterObservation(input, { action: input.action, tabId: tab?.id, url: wc.getURL() }, scope, page, `${owner}:${tab?.id ?? wc.id}`);
      } catch (error) { await runtime?.events.settleNavigationDialog(scope); throw error; }
      finally { releaseDialogs?.(); }
    }
    if (input.action === "frames") {
      const wc = page.inspectionWebContents;
      if (!wc || wc.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "标签页已关闭");
      return { action: input.action, tabId: tab?.id, url: wc.getURL(), frames: listBrowserFrames(wc) };
    }
    if (input.action === "screenshot" || input.action === "click_at" || input.action === "scroll_at") {
      const target = { owner, tabId: tab?.id ?? String(page.inspectionWebContents?.id), host: page };
      if (input.action === "screenshot") return { action: input.action, tabId: tab?.id, ...await this.visual.capture(target, scope) };
      const point = { captureId: input.captureId!, x: input.x!, y: input.y! };
      const accepted = input.action === "click_at" ? await this.visual.click(target, { ...point, button: input.button }, scope) : await this.visual.scroll(target, { ...point, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 }, scope);
      return this.afterObservation(input, { action: input.action, tabId: tab?.id, captureId: accepted.captureId, point: accepted.point }, scope, page, `${owner}:${target.tabId}`);
    }
    if (input.action === "resume") {
      if (!taskId || !tab) throw new BrowserAutomationError("INVALID_INPUT", "resume 需要本任务标签");
      const inspectTab = async () => {
        const wc = browser.getTabHost(tab!.id)?.inspectionWebContents;
        if (!wc || wc.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "人工接管标签已关闭");
        return { taskId, ownerId: owner, tabId: tab!.id, webContentsId: wc.id, documentId: await scope.run(() => wc.executeJavaScript(browserDocumentScript(this.observationSlot))) };
      };
      const identity = await inspectTab();
      const resumed = await this.handoffs.resume({ token: input.token!, identity, signal: scope.signal, inspectTab, verify: async () => {
        const checked = await this.withSurface(scope, page, () => this.executeOnPage({ action: "assert", frameId: input.frameId, expect: input.expect }, scope, page, `${owner}:${tab!.id}`));
        return { passed: checked.businessResult?.status === "passed", documentId: identity.documentId, evidence: checked.businessResult! };
      } });
      const verifiedUrl = managedWc.getURL();
      const renewal = resumed.status === "confirmed" && /^https?:\/\//i.test(verifiedUrl) ? await browser.trackVerifiedLogin(verifiedUrl) : undefined;
      if (renewal) this.loginOrigins.set(page, new URL(verifiedUrl).origin);
      return { action: input.action, tabId: tab.id, handoff: { status: resumed.status }, businessResult: resumed.evidence, renewal };
    }
    const runtime = input.action === "diagnostics" || input.action === "dialog" || input.action === "accessibility" || input.axNodeId || input.response || input.download || input.dialogRules
      ? await this.runtimes.get(managedWc, scope, context?.taskRoot) : undefined;
    if (input.action === "diagnostics") return { action: input.action, tabId: tab?.id, diagnostics: runtime!.events.snapshot(input.traceCursor), dialog: runtime!.events.currentDialog() };
    if (input.action === "dialog") {
      scope.dispatch(); await scope.run(() => runtime!.events.answerDialog(input.dialog!.id, input.dialog!)); scope.confirmed = true;
      return { action: input.action, tabId: tab?.id };
    }
    return this.withPageOperation(managedWc.id, scope, async () => {
    if (tab && browser.listTabs().some(t => t.id === tab!.id && t.loginChallenge)) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "此标签等待用户验证");
    let response: ResponseWatch | undefined, download: DownloadWatch | undefined, releaseDialogs: (() => void) | undefined;
    try {
    response = input.response ? runtime?.events.armResponse(input.response) : undefined;
    download = input.download ? runtime?.events.armDownload(input.download) : undefined;
    releaseDialogs = runtime?.events.armDialogRules(input.dialogRules ?? []);
    if (runtime) await scope.run(() => runtime.events.preparePrompts());
    const traceStart = runtime?.events.snapshot().cursor;
    const before = new Set(browser.listTabs().map(value => value.id));
    const perform = () => this.executeOnPage(input, scope, page, `${owner}:${tab?.id ?? page.inspectionWebContents?.id}`, () => !taskId || Boolean(tab && browser.getTabHost(tab.id) === page), context?.taskRoot);
    let base = await (input.action !== "status" ? this.withSurface(scope, page, perform) : perform());
    if (response) base = { ...base, response: await response.wait(scope) };
    if (download) {
      base = { ...base, download: await download.wait(scope) };
      if (input.action === "fetch" && base.download?.state === "completed") scope.confirmed = true;
    }
    if (runtime) base = { ...base, diagnostics: runtime.events.snapshot(traceStart), dialog: runtime.events.currentDialog() };
    // A popup opened by this exact document is a new retained page. Follow it
    // only for this task's next observation; never redirect another task or UI.
    const popup = ["click", "press"].includes(input.action) && taskId && tab && browser.listTabs().find(value => !before.has(value.id)
      && value.taskId === taskId && value.openerTabId === tab!.id);
    const afterPage = popup ? browser.getTabHost(popup.id) : page;
    const result = afterPage ? await this.afterObservation(popup ? { ...input, frameId: undefined } : input, base, scope, afterPage, `${owner}:${popup ? popup.id : tab?.id ?? page.inspectionWebContents?.id}`) : base;
    const opened = popup ? browser.listTabs().find(value => value.id === popup.id) : undefined;
    return { ...result, tabId: popup ? popup.id : tab?.id, ...(popup ? { sourceTabId: tab?.id, openedTabId: popup.id, url: opened?.url ?? popup.url, title: opened?.title ?? popup.title, elements: undefined, documentId: undefined, detail: `${result.detail ?? ""}；已打开新标签 ${popup.id}，后续读取使用新标签` } : {}) };
    } finally { response?.cancel(); download?.cancel(); releaseDialogs?.(); }
    });
  }

  private withPageOperation<T>(id: number, scope: AutomationScope, operation: () => Promise<T>): Promise<T> {
    const previous = this.pageFlights.get(id) ?? Promise.resolve();
    const job = (async () => { await scope.run(() => previous); return operation(); })();
    const drained = job.then(() => {}, () => {});
    this.pageFlights.set(id, drained);
    void drained.finally(() => { if (this.pageFlights.get(id) === drained) this.pageFlights.delete(id); });
    return job;
  }

  private async afterObservation(input: BrowserExecInput, result: BrowserExecOutput, scope: AutomationScope, host: BrowserPageHost, owner: string): Promise<BrowserExecOutput> {
    if (input.expect && input.action !== "assert") {
      try {
        const asserted = await this.withSurface(scope, host, () => this.executeOnPage({ action: "assert", frameId: input.frameId, expect: input.expect }, scope, host, owner));
        result = { ...result, businessResult: asserted.businessResult };
      } catch (error) { result = { ...result, businessResult: { status: "failed", evidence: [], reason: String(error) } }; }
    }
    if (!input.after || result.businessResult?.status === "failed") return result;
    try {
      const after = input.after;
      const wc = host.inspectionWebContents;
      for (;;) {
        scope.check();
        const version = host.captureVersion, url = wc?.getURL();
        try {
          const observation = await this.withSurface(scope, host, async () => {
            if (after.selector || after.role || after.name) await this.executeOnPage({ action: "wait_for", frameId: input.frameId, ...after }, scope, host, owner);
            return this.executeOnPage({ action: "read", frameId: input.frameId, ...after }, scope, host, owner);
          });
          return { ...result, observation: { status: "completed", result: observation } };
        } catch (error) {
          // Input is already complete. Only restart the read-only observation
          // when this exact retained tab commits another document or redirect.
          const navigated = wc && !wc.isDestroyed() && host.inspectionWebContents === wc
            && (host.captureVersion !== version || wc.getURL() !== url);
          if (navigated && (error instanceof BrowserAutomationError || error instanceof UiAutomationError) && error.code === "SURFACE_CHANGED") continue;
          throw error;
        }
      }
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
    const add = (el: { selector: string; tag: string; label: string; id?: string }) => {
      targets.delete(el.selector); targets.set(el.selector, el);
      if (el.id) { targets.delete(`#${el.id}`); targets.set(`#${el.id}`, el); }
    };
    for (const el of elements) {
      add(el);
      if (el.hiddenBy) add(el.hiddenBy);
    }
    while (targets.size > 512) targets.delete(targets.keys().next().value!);
    this.observations.delete(owner);
    this.observations.set(owner, { ...identity, targets });
    while (this.observations.size > 128) this.observations.delete(this.observations.keys().next().value!);
  }

  private async executeOnPage(input: BrowserExecInput, scope: AutomationScope, host: BrowserPageHost, owner: string, retained = () => true, taskRoot?: string): Promise<BrowserExecOutput> {
    const wc = host.inspectionWebContents;
    if (!wc || wc.isDestroyed()) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "标签页已关闭");
    const document = input.frameId ? await bindBrowserDocument(wc, input.frameId, this.observationSlot, scope) : undefined;
    const rootOwner = owner;
    if (input.frameId) owner += `:frame:${input.frameId}`;
    const version = host.captureVersion, url = wc.getURL();
    scope.pageUrl = url;
    const assertSurface = () => {
      document?.validate();
      if (!retained() || wc.isDestroyed() || host.inspectionWebContents !== wc || host.captureVersion !== version || wc.getURL() !== url) throw new BrowserAutomationError("SURFACE_CHANGED", "固定标签或文档已变化，请重新读取");
    };
    const release = scope.guard(assertSurface);
    let releaseInput = () => {};
    const check = () => scope.check();
    try {
    const js = async <T>(script: string): Promise<T> => {
      check();
      const prepared = withBrowserDom(script);
      const result = await scope.run(() => document ? document.evaluate(prepared) : wc.executeJavaScript(prepared, true)) as T;
      check(); return result;
    };
    if (input.action === "status") return { action: input.action, url, detail: url ? "ready" : "idle" };
    if (input.action === "listen" || input.action === "evaluate") {
      let field: string | undefined;
      const observedSelector = input.action === "listen" ? input.selector : input.editSelector;
      if (observedSelector) {
        const observed = this.observations.get(owner);
        if (!observed || observed.webContentsId !== wc.id || observed.version !== version || observed.url !== url
          || observed.documentId !== await js<string>(browserDocumentScript(this.observationSlot))) throw new BrowserAutomationError("SURFACE_CHANGED", "请先查找需要编辑的文本框");
        field = observed.targets.get(observedSelector)?.selector;
        if (!field) throw new BrowserAutomationError("SURFACE_CHANGED", "需要当前页已观察的控件引用");
      }
      if (input.action === "listen") {
        const listenerId = randomUUID();
        await js(subscribeToBrowserEvent(this.observationSlot, listenerId, field!, input.eventType!));
        return { action: input.action, listenerId };
      }
      const snapshot = await js<PageSnapshot>(pageSnapshotScript(field));
      if (input.listenerId) snapshot.event = await js<BrowserEventReceipt | null>(browserEventReceiptScript(this.observationSlot, input.listenerId));
      const { value, edited } = await evaluatePageSnapshot(snapshot, input.expression!, scope);
      check();
      if (field && snapshot.editor && edited !== snapshot.editor.before) {
        if (typeof edited !== "string" || edited.length > 100000) throw new BrowserAutomationError("INVALID_INPUT", "文本框结果太长");
        const unchanged = await js<boolean>(`__mbDom.one(${JSON.stringify(field)})?.value===${JSON.stringify(snapshot.editor.before)}`);
        if (!unchanged) throw new BrowserAutomationError("SURFACE_CHANGED", "脚本计算期间文本框已改变");
        await this.executeOnPage({ action: "fill", selector: field, text: edited, frameId: input.frameId }, scope, host, rootOwner, retained, taskRoot);
      }
      return { action: input.action, value };
    }
    if (input.action === "fetch") {
      const base = new URL(await js<string>("location.href"));
      const target = new URL(input.url!, base);
      if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(target.protocol) || target.username || target.password) throw new BrowserAutomationError("INVALID_URL", "需要有效的 HTTP(S) 资源及页面地址");
      const request = input.request ?? { method: "GET" };
      const writes = request.method !== "GET" && request.method !== "HEAD";
      if (target.origin !== base.origin && (writes || input.download)) throw new BrowserAutomationError("INVALID_URL", "跨域资源支持公开 GET/HEAD 和标准浏览器 CORS 检查");
      if (input.download) {
        if (document || !taskRoot) throw new BrowserAutomationError("INVALID_INPUT", "下载需要当前任务的主文档和工作目录");
        scope.dispatch();
        wc.downloadURL(target.href);
        return { action: input.action };
      }
      if (writes) scope.dispatch();
      const fetched = await js<NonNullable<BrowserExecOutput["fetched"]>>(pageFetchScript(target.href, input.maxChars ?? 30000, scope.remaining, request));
      if (writes) scope.confirmed = true;
      return { action: input.action, fetched };
    }
    if (input.action === "frames") return { action: input.action, url, frames: listBrowserFrames(wc) };
    if (input.action === "assert") {
      let evidence: BrowserConditionEvidence[] = [];
      try {
        for (;;) {
          evidence = parseBrowserConditionEvidence(await js<unknown>(browserConditionsScript(input.expect!)));
          if (evidence.length !== input.expect!.length) throw new BrowserAutomationError("EXECUTION_FAILED", "条件证据数量不匹配");
          if (evidence.every(e => e.matched)) return { action: input.action, url, businessResult: { status: "passed", evidence } };
          if (scope.remaining <= 80) return { action: input.action, url, businessResult: { status: "failed", evidence, reason: "condition deadline exceeded" } };
          await scope.run(() => new Promise<void>(resolve => setTimeout(resolve, Math.min(50, scope.remaining - 70))));
        }
      } catch (error) {
        if (!(error instanceof AutomationTimeoutError)) throw error;
        return { action: input.action, url, businessResult: { status: "failed", evidence, reason: "condition deadline exceeded" } };
      }
    }
    if (input.action === "accessibility" || input.axNodeId) {
      const runtime = await this.runtimes.get(wc, scope, taskRoot);
      const context = document ?? await bindBrowserDocument(wc, undefined, this.observationSlot, scope);
      try {
        if (input.action === "accessibility") {
          const accessibility = await runtime.accessibility.snapshot(context, scope, { maxNodes: 200, maxChars: input.maxChars ?? 30000 });
          this.axSnapshots.set(owner, accessibility);
          while (this.axSnapshots.size > 128) this.axSnapshots.delete(this.axSnapshots.keys().next().value!);
          return { action: input.action, url, accessibility };
        }
        const snapshot = this.axSnapshots.get(owner);
        const node = snapshot?.nodes.find(n => n.nodeId === input.axNodeId && n.documentId === input.documentId);
        if (!node || snapshot?.documentId !== context.identity.documentId) throw new BrowserAutomationError("SURFACE_CHANGED", "AX 节点不属于最近的当前文档观察");
        const target = await runtime.accessibility.resolveNodeRef(context, node, scope);
        input = { ...input, selector: target.selector, axNodeId: undefined, role: undefined, name: undefined, text: undefined };
      } finally { if (!document) context.dispose(); }
    }
    if (input.action === "read") {
      const result = await js<BrowserExecOutput & { error?: BrowserAutomationErrorCode }>(browserPageReadScript(this.observationSlot, input));
      if (result.error) throw new BrowserAutomationError(result.error, `页面读取失败：${result.error}`, { currentUrl: url, detail: result.detail });
      if (!result.documentId) throw new BrowserAutomationError("SURFACE_CHANGED", "读取未返回文档身份");
      this.remember(owner, { version, webContentsId: wc.id, url, documentId: result.documentId }, result.elements ?? []);
      return { ...result, action: input.action, ...(document ? { frameId: document.identity.frameId } : {}) };
    }
    if (input.action === "screenshot") {
      const screenshot = await scope.run(() => host.captureScreenshot({ signal: scope.signal, timeoutMs: scope.remaining }));
      check(); return { action: input.action, url, title: wc.getTitle(), screenshot };
    }
    if (input.action === "collect") {
      const context = document ?? await bindBrowserDocument(wc, undefined, this.observationSlot, scope);
      const act = async (target: {selector:string;scopeSelector?:string}, action: "click" | "scroll", deltaX?: number, deltaY?: number) => {
        const found = await this.executeOnPage({ action: "find", frameId: input.frameId, selector: target.selector, within: target.scopeSelector }, scope, host, rootOwner, retained, taskRoot);
        if (found.elements?.length !== 1 || !found.elements[0]) throw new BrowserAutomationError("ELEMENT_AMBIGUOUS", "集合推进目标必须唯一");
        await this.executeOnPage({ action, frameId: input.frameId, selector: found.elements[0].selector, deltaX, deltaY }, scope, host, rootOwner, retained, taskRoot);
        await scope.run(() => new Promise<void>(resolve => setTimeout(resolve, 40)));
      };
      try {
        const source = createBrowserCollectionDomSource({ context, options: input.collection!, input: {
          click: target => act(target, "click"),
          scroll: async (target, axis, direction) => {
            const raw = await context.evaluate(withBrowserDom(`(() => {const scope=${JSON.stringify(target.scopeSelector)},roots=scope?__mbDom.all(scope):[document];if(roots.length!==1)throw Error('Ambiguous collection scope');const nodes=__mbDom.all(${JSON.stringify(target.selector)},roots[0]);if(nodes.length!==1)throw Error('Ambiguous collection viewport');const el=nodes[0];return {width:el.clientWidth,height:el.clientHeight,left:el.scrollLeft,top:el.scrollTop};})()`));
            if (!raw || typeof raw !== "object" || !("width" in raw) || !("height" in raw) || !("left" in raw) || !("top" in raw) || typeof raw.width !== "number" || typeof raw.height !== "number" || typeof raw.left !== "number" || typeof raw.top !== "number") throw new BrowserAutomationError("EXECUTION_FAILED", "无效集合视口");
            const amount = direction === "start" ? -(axis === "horizontal" ? raw.left : raw.top) : Math.max(1, (axis === "horizontal" ? raw.width : raw.height) * 0.8);
            if (amount) await act(target, "scroll", axis === "horizontal" ? amount : 0, axis === "vertical" ? amount : 0);
          },
        } });
        const collection = await this.collections.collect({ identity: { owner, tab: String(wc.id), document: context.identity.documentId, query: JSON.stringify(input.collection) }, source, scope, cursor: input.cursor, budget: { maxSteps: input.maxSteps ?? 20, maxRows: input.maxRows ?? 200 } });
        let remaining = input.maxChars ?? 30000, outputTruncated = false;
        const rows = collection.rows.flatMap(row => { const size = row.key.length + row.cells.reduce((n,cell)=>n+cell.length,0); if (size > remaining) { outputTruncated = true; return []; } remaining -= size; return [row]; });
        if (outputTruncated && !taskRoot) throw new BrowserAutomationError("READ_LIMIT", "集合超出行内预算，当前调用缺少任务目录来保存完整数据");
        const collectionFile = outputTruncated && taskRoot ? await exportBrowserCollection({ taskRoot, collection, scope }) : undefined;
        return { action: input.action, url, documentId: context.identity.documentId, collection: { ...collection, rows, horizontalCoverage: source.coverage, ...(outputTruncated ? { outputTruncated: true } : {}) }, collectionFile };
      } finally { if (!document) context.dispose(); }
    }
    if (input.hover) {
      const observe = async (locator: Pick<UiExecInput, "selector" | "role" | "name" | "text">) => {
        // Existing references retain their node identity. Only discover targets
        // that were not yet observable before the menu was expanded.
        if (!locator.selector || !this.observations.get(owner)?.targets.has(locator.selector)) {
          await this.executeOnPage({ action: "find", frameId: input.frameId, ...locator }, scope, host, rootOwner, retained, taskRoot);
        }
      };
      for (const target of input.hover) {
        await observe(target);
        await this.executeOnPage({ action: "hover", frameId: input.frameId, ...target }, scope, host, rootOwner, retained, taskRoot);
      }
      scope.confirmed = false;
      if (input.selector || input.role || input.name || input.action !== "fill" && input.text) {
        await observe({ selector: input.selector, role: input.role, name: input.name, text: input.action === "fill" ? undefined : input.text });
      }
      release();
      return this.executeOnPage({ ...input, hover: undefined }, scope, host, rootOwner, retained, taskRoot);
    }
    let selector = input.selector;
    let expected: UiExecInput["expected"];
    let observedSelectors: UiExecInput["observedSelectors"];
    const pageScroll = input.action === "scroll" && !input.selector && !input.role && !input.name && !input.text;
    if (BROWSER_INPUT_ACTIONS.has(input.action) && !pageScroll) {
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
        const current = await js<{ tag?: string }>(`(() => {const el=__mbDom.one(${JSON.stringify(selector)});return el?{tag:el.localName}:{};})()`);
        if (current.tag !== target.tag) throw new BrowserAutomationError("SURFACE_CHANGED", "目标节点或语义已变化");
      }
    }
    if (input.action === "focus" || input.action === "insert_text" || input.action === "paste") {
      scope.dispatch();
      await js(browserEditorScript(selector!, input.action, input.text, input.html));
      scope.confirmed = true;
      return { action: input.action, url };
    }
    if (input.action === "upload") {
      if (!taskRoot || !selector) throw new BrowserAutomationError("INVALID_INPUT", "上传需要任务工作目录和已观察文件输入 selector");
      const runtime = await this.runtimes.get(wc, scope, taskRoot);
      const context = document ?? await bindBrowserDocument(wc, undefined, this.observationSlot, scope);
      try { return { action: input.action, url, upload: await uploadBrowserFiles({ accessibility: runtime.accessibility, context, selector, taskRoot, paths: input.files!, scope }) }; }
      finally { if (!document) context.dispose(); }
    }
    if (input.action === "click" && input.files) {
      if (!taskRoot || !selector) throw new BrowserAutomationError("INVALID_INPUT", "请选择任务内文件和已观察的文件选择按钮");
      const runtime = await this.runtimes.get(wc, scope, taskRoot);
      const context = document ?? await bindBrowserDocument(wc, undefined, this.observationSlot, scope);
      try {
        const files = await validateBrowserUploadFiles({ taskRoot, paths: input.files, context, scope });
        const receipt = await runtime.accessibility.chooseFiles(context, files, scope,
          () => this.executeOnPage({ ...input, files: undefined }, scope, host, rootOwner, retained, taskRoot));
        return { ...receipt.click, upload: receipt.upload };
      } finally { if (!document) context.dispose(); }
    }
    let inputTransport: UiNativeInput | undefined;
    let htmlDragTransport: ((points: readonly { x: number; y: number }[], scope: AutomationScope) => Promise<void>) | undefined;
    if (BROWSER_INPUT_ACTIONS.has(input.action) && input.action !== "select") {
      const existing = pageInspectionService.sessionFor(wc, "browser-host");
      const session = existing ?? pageInspectionService.acquire(wc, "browser-host");
      releaseInput = () => { if (!existing && !session.hasProtocolSubscribers) pageInspectionService.release(wc, "browser-host"); };
      await scope.run(() => session.attach(wc.debugger));
      await scope.run(() => session.suspendInputOverlay(() => scope.check()));
      inputTransport = browserNativeInput(session);
      const rootInput = inputTransport;
      htmlDragTransport = async (points, dragScope) => {
        const mapped: Array<{ x: number; y: number }> = [];
        for (const point of points) mapped.push(document ? await document.mapPoint(point) : point);
        await htmlDragFromSource({ protocol: session, input: rootInput, points: mapped, scope: dragScope });
      };
      if (document) {
        await document.prepare();
        const native = inputTransport;
        let heldPoint: { x: number; y: number } | undefined;
        inputTransport = {
          insertText: text => native.insertText(text),
          send: async event => {
            if (!("x" in event)) return native.send(event);
            let point: { x: number; y: number };
            try { point = await document.mapPoint({ x: event.x, y: event.y }); }
            catch (error) { if (event.type !== "mouseUp" || !heldPoint) throw error; point = heldPoint; }
            if (event.type === "mouseDown") heldPoint = point;
            try { await native.send({ ...event, ...point }); }
            finally { if (event.type === "mouseUp") heldPoint = undefined; }
          },
        };
      }
    }
    const executor = new UiAutomationService({ app: () => null, artifact: () => null, browser: () => wc, input: inputTransport, document, htmlDrag: htmlDragTransport });
    if (input.action === "drag" && input.points && inputTransport) {
      await strokeOnElement(inputTransport, scope, selector!, input.points, input.modifiers ?? [], js);
      scope.confirmed = true;
      return { action: input.action, url };
    }
    if (input.action === "navigate") throw new BrowserAutomationError("INVALID_INPUT", "navigate 必须由标签管理器执行");
    const onActionAccepted = input.action === "click" || input.action === "press" || input.action === "drag" ? () => {
      if (!retained() || wc.isDestroyed() || host.inspectionWebContents !== wc) throw new BrowserAutomationError("SURFACE_CHANGED", "操作回执不属于保留的标签页");
      release();
      scope.confirmed = true;
    } : undefined;
    const action = input.action;
    if (action !== "status" && action !== "find" && action !== "inspect" && action !== "click" && action !== "fill" && action !== "drag" && action !== "press" && action !== "scroll" && action !== "hover" && action !== "select" && action !== "check" && action !== "wait_for") throw new BrowserAutomationError("INVALID_INPUT", "此操作不属于文档交互");
    const destination = input.dragTo ? this.observations.get(owner)?.targets.get(input.dragTo) : undefined;
    if (action === "drag" && !destination) throw new BrowserAutomationError("SURFACE_CHANGED", "拖动目的地需要先 find 同一文档中的目标");
    const uiInput: UiExecInput = { action, target: "browser", selector: pageScroll ? "body" : selector, role: input.role, name: input.name, within: input.within, exact: input.exact, label: input.label, placeholder: input.placeholder, testId: input.testId, text: input.action !== "fill" ? input.text : undefined, value: input.text, key: input.key, state: input.state, timeoutMs: scope.remaining, deltaX: input.deltaX, deltaY: input.deltaY, values: input.values, checked: input.checked, button: input.button, clickCount: input.clickCount, modifiers: input.modifiers, inputMode: input.inputMode, delayMs: input.delayMs, dateType: input.dateType, dragTo: destination?.selector, dragMode: input.dragMode, dragToExpected: destination ? { tag: destination.tag, name: destination.label || undefined } : undefined, expected, observedSelectors, onActionAccepted };
    let result;
    try { result = await executor.execute(uiInput, scope.signal, scope); }
    catch (error) {
      if (error instanceof UiAutomationError && error.code === "ELEMENT_AMBIGUOUS" && error.candidates?.length) {
        const candidates = error.candidates.map(({ name, text: _text, ...el }) => ({ ...el, label: name ?? "" }));
        const documentId = await js<string>(browserDocumentScript(this.observationSlot));
        this.remember(owner, { version, webContentsId: wc.id, url, documentId }, candidates);
        throw new UiAutomationError(error.code, error.message, { candidates, documentId });
      }
      throw error;
    }
    const elements = result.elements?.map(({ name, text: _text, ...el }) => ({ ...el, label: name ?? "" }));
    if (input.action === "find" || input.action === "inspect") {
      const documentId = await js<string>(browserDocumentScript(this.observationSlot));
      this.remember(owner, { version, webContentsId: wc.id, url, documentId }, elements ?? []);
      return { action: input.action, url, documentId, elements, detail: result.detail };
    }
    release();
    scope.check();
    const output: BrowserExecOutput = { action: input.action, url: wc.getURL(), sourceUrl: url, elements, detail: result.detail };
    return output;
    } finally { releaseInput(); release(); document?.dispose(); }
  }
}
