/**
 * PageInspectionService — 唯一 CDP/DOM/页面检查底层（WebAccess/Browser 收敛 A）。
 *
 * 统一 BrowserHost 与 ArtifactPreviewHost/CaptureModeController 对页面检查的能力：
 * - CDP attach/enable（DOM/CSS/Overlay）、元素拾取（Overlay.setInspectMode）、
 *   DOM 解析（describeNode/getBoxModel/getOuterHTML）、截图（Page.captureScreenshot）；
 * - 页面正文/标题/文档读取（executeJavaScript 兜底 + CDP）。
 *
 * 所有权与生命周期：
 * - 每个 webContents 同时最多一个 session（acquire 幂等：重复 acquire 返回同一 session）；
 * - session 由 acquire 方持有，release 才 detach；detach 幂等；
 * - webContents destroyed / 外部 DevTools 抢占 → debugger detach 事件 → onDetached 通知；
 * - 业务层（NativeSurfaceCoordinator generation / CaptureModeController token）负责
 *   stale 过滤；本层保证「同一 wc 不双 attach、不 detach 别人的 session」。
 *
 * DebuggerLike 可注入：生产传 webContents.debugger；node 测试传 mock（无 Electron 依赖）。
 */
import { SELECTION_TEXT_MAX } from "../../shared/capture-mode";

/** 与 Electron Debugger 对齐的最小接口（node 测试可注入 mock；生产直接传 webContents.debugger） */
export interface DebuggerLike {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, commandParams?: unknown): Promise<unknown>;
  on(
    event: "message",
    listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void,
  ): unknown;
  on(event: "detach", listener: (event: unknown, reason: string) => void): unknown;
  off?(event: "message" | "detach", listener: (...args: unknown[]) => void): unknown;
  removeAllListeners?(event?: string): unknown;
}

export interface InspectNodeRequest {
  backendNodeId: number;
  nodeId?: number;
  objectId?: string;
}

export interface SelectionEventPayload {
  backendNodeId?: number;
  nodeId?: number;
  tagName: string;
  id?: string;
  classNames: string[];
  selector?: string;
  text?: string;
  /** CSS 像素边界（§37） */
  bounds: { x: number; y: number; width: number; height: number };
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** 正文纯文本（script/style 剥离，空白压缩） */
  text: string;
  fetchedAt: number;
}

const PROTOCOL_VERSION = "1.3";
export const PAGE_TEXT_MAX_CHARS = 40_000;
export const PAGE_HTML_MAX_CHARS = 128 * 1024;

export class PageCaptureError extends Error {
  constructor(readonly code: "CAPTURE_TIMEOUT" | "CANCELLED" | "SURFACE_CHANGED" | "SCREENSHOT_EMPTY", message: string) {
    super(message);
    this.name = code === "CANCELLED" ? "AbortError" : "PageCaptureError";
  }
}

/** One deadline covers queue admission and every native command. Native commands
 * are drained separately so cancelling a caller cannot overlap the next capture. */
export class PageCaptureScope {
  private readonly deadline: number;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly signal?: AbortSignal, timeoutMs = 10_000, private readonly validate?: () => void) {
    this.deadline = Date.now() + Math.max(1, Math.min(30_000, timeoutMs));
  }

  check(): void {
    if (this.signal?.aborted) throw new PageCaptureError("CANCELLED", "页面截图已取消");
    if (Date.now() >= this.deadline) throw new PageCaptureError("CAPTURE_TIMEOUT", "页面截图超时");
    this.validate?.();
  }

  async wait<T>(promise: Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PageCaptureError("CAPTURE_TIMEOUT", "页面截图超时")), Math.max(1, this.deadline - Date.now()));
      abort = () => reject(new PageCaptureError("CANCELLED", "页面截图已取消"));
      this.signal?.addEventListener("abort", abort, { once: true });
      if (this.signal?.aborted) abort();
    });
    try {
      const result = await Promise.race([promise, interruption]);
      this.check();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) this.signal?.removeEventListener("abort", abort);
    }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    const native = Promise.resolve().then(() => { this.check(); return operation(); });
    this.pending.add(native);
    void native.then(() => this.pending.delete(native), () => this.pending.delete(native));
    return this.wait(native);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}

/** 最小 WebContents 面（可注入 mock 测试） */
export interface PageWebContentsLike {
  debugger: DebuggerLike;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  getURL?(): string;
  getTitle?(): string;
  isDestroyed?(): boolean;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export class PageInspectionSession {
  private debuggerLike: DebuggerLike | null = null;
  private attached = false;
  private inspectEnabled = false;
  private disposeListeners: Array<() => void> = [];
  private disposed = false;
  private attaching: Promise<void> | null = null;

  /** 选中事件（controller 订阅；payload 含 backendNodeId 等 DOM 信息） */
  onSelection: ((payload: SelectionEventPayload) => void) | null = null;
  /** inspect 模式被取消（Esc / 用户点击空白） */
  onInspectModeCanceled: (() => void) | null = null;
  /** debugger 被分离（target destroyed / DevTools 打开），reason 透传 */
  onDetached: ((reason: string) => void) | null = null;

  constructor(readonly owner: string) {}

  get isAttached(): boolean {
    return this.attached;
  }

  get inspectMode(): boolean {
    return this.inspectEnabled;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** attach + enable DOM/CSS/Overlay。幂等：已 attach 直接返回；重复 attach 前先 detach。 */
  async attach(dbg: DebuggerLike): Promise<void> {
    if (this.attaching) return this.attaching;
    const attaching = this.attachOnce(dbg);
    this.attaching = attaching;
    try { await attaching; }
    finally { if (this.attaching === attaching) this.attaching = null; }
  }

  private async attachOnce(dbg: DebuggerLike): Promise<void> {
    if (this.disposed) throw new Error("PageInspectionSession 已释放");
    if (this.attached) return;
    this.debuggerLike = dbg;
    if (dbg.isAttached()) {
      throw new Error("Another debugger is already attached to this webContents");
    }
    dbg.attach(PROTOCOL_VERSION);
    this.attached = true;

    const onMessage = (event: unknown, method: string, params: unknown): void => {
      void event;
      this.handleMessage(method, params as Record<string, unknown>);
    };
    const onDetach = (event: unknown, reason: string): void => {
      void event;
      this.attached = false;
      this.inspectEnabled = false;
      this.onDetached?.(reason);
    };
    dbg.on("message", onMessage);
    dbg.on("detach", onDetach);
    this.disposeListeners.push(() => {
      dbg.off?.("message", onMessage as (...args: unknown[]) => void);
      dbg.off?.("detach", onDetach as (...args: unknown[]) => void);
    });

    try {
      await this.send("DOM.enable");
      await this.send("CSS.enable");
      await this.send("Overlay.enable");
    } catch (error) {
      this.detach();
      throw error;
    }
  }

  /** 开启 Overlay inspect 模式（hover highlight + click-to-inspect） */
  async setInspectMode(): Promise<void> {
    if (!this.attached) return;
    this.inspectEnabled = true;
    await this.send("Overlay.setInspectMode", {
      mode: "searchForNode",
      highlightConfig: {
        showInfo: false,
        showStyles: false,
        contentColor: { r: 66, g: 133, b: 244, a: 0.25 },
        paddingColor: { r: 66, g: 133, b: 244, a: 0.12 },
        marginColor: { r: 66, g: 133, b: 244, a: 0.08 },
        borderColor: { r: 66, g: 133, b: 244, a: 0.6 },
      },
    });
  }

  /** 关闭 inspect 模式（保持 attach） */
  async clearInspectMode(): Promise<void> {
    this.inspectEnabled = false;
    if (!this.attached) return;
    try {
      await this.send("Overlay.setInspectMode", { mode: "none" });
      await this.send("Overlay.hideHighlight");
    } catch {
      /* target 可能已销毁 */
    }
  }

  /** 手动高亮指定节点 */
  async highlightNode(backendNodeId: number): Promise<void> {
    if (!this.attached) return;
    await this.send("Overlay.highlightNode", {
      backendNodeId,
      highlightConfig: {
        showInfo: false,
        contentColor: { r: 16, g: 185, b: 129, a: 0.3 },
        borderColor: { r: 16, g: 185, b: 129, a: 0.8 },
      },
    });
  }

  /** The host supplies a presenting native surface. Capture the current viewport
   * without emulation, which can restore an obsolete size after cancellation. */
  async captureScreenshot(scope: PageCaptureScope): Promise<Uint8Array> {
    const result = await scope.run(() => this.send("Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: false,
    })) as { data?: string };
    const bytes = Buffer.from(result.data ?? "", "base64");
    if (!bytes.length) throw new PageCaptureError("SCREENSHOT_EMPTY", "页面截图为空");
    scope.check();
    return bytes;
  }

  /** detach（幂等）：关 inspect、清监听、detach debugger */
  detach(): void {
    this.inspectEnabled = false;
    if (this.debuggerLike && this.attached) {
      try {
        this.debuggerLike.detach();
      } catch {
        /* target 可能已销毁 */
      }
    }
    for (const dispose of this.disposeListeners) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposeListeners = [];
    this.debuggerLike = null;
    this.attached = false;
  }

  /** 永久释放（幂等）：detach + 标记 disposed（不可再 attach） */
  dispose(): void {
    this.detach();
    this.disposed = true;
  }

  // ---------- 内部 ----------

  private async send(method: string, params?: unknown): Promise<unknown> {
    if (!this.debuggerLike || !this.attached) {
      throw new Error(`CDP sendCommand 失败（未 attach）: ${method}`);
    }
    return this.debuggerLike.sendCommand(method, params);
  }

  private handleMessage(method: string, params: Record<string, unknown>): void {
    if (!this.attached) return;
    if (method === "Overlay.inspectNodeRequested") {
      this.handleInspectRequested(params);
      return;
    }
    if (method === "Overlay.inspectModeCanceled") {
      this.inspectEnabled = false;
      this.onInspectModeCanceled?.();
      return;
    }
  }

  private handleInspectRequested(params: Record<string, unknown>): void {
    if (!this.inspectEnabled) return;
    const backendNodeId = Number(params.backendNodeId);
    const nodeId = params.nodeId !== undefined ? Number(params.nodeId) : undefined;
    void this.resolveSelection({ backendNodeId, nodeId }).then((payload) => {
      if (this.attached) this.onSelection?.(payload);
    });
  }

  /** 由节点解析 SelectionEventPayload（describeNode / getBoxModel / getOuterHTML） */
  private async resolveSelection(req: InspectNodeRequest): Promise<SelectionEventPayload> {
    const backendNodeId = req.backendNodeId;
    let nodeId = req.nodeId;

    let tagName = "";
    let id: string | undefined;
    let classNames: string[] = [];
    try {
      const desc = (await this.send("DOM.describeNode", { backendNodeId })) as {
        node?: { nodeId?: number; localName?: string; attributes?: string[] };
      };
      const node = desc?.node;
      if (node) {
        if (node.nodeId !== undefined) nodeId = node.nodeId;
        tagName = node.localName ?? "";
        const attrs = node.attributes ?? [];
        for (let i = 0; i + 1 < attrs.length; i += 2) {
          const name = attrs[i];
          const value = attrs[i + 1];
          if (name === "id") id = value;
          else if (name === "class") classNames = value.split(/\s+/).filter(Boolean);
        }
      }
    } catch {
      /* describeNode 失败 → 尽力而为 */
    }

    let bounds = { x: 0, y: 0, width: 0, height: 0 };
    try {
      const box = (await this.send("DOM.getBoxModel", { backendNodeId })) as {
        model?: { content?: number[] };
      };
      const quad = box?.model?.content;
      if (quad && quad.length >= 8) {
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);
        bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      }
    } catch {
      /* box model 失败 → 零边界 */
    }

    let text: string | undefined;
    try {
      const html = (await this.send("DOM.getOuterHTML", { backendNodeId })) as { outerHTML?: string };
      if (html?.outerHTML) {
        text = stripHtml(html.outerHTML).slice(0, SELECTION_TEXT_MAX);
        if (text.length === 0) text = undefined;
      }
    } catch {
      /* outerHTML 失败 → 无文本 */
    }

    return {
      backendNodeId,
      nodeId,
      tagName,
      id,
      classNames,
      selector: buildSelector(tagName, id, classNames),
      text,
      bounds,
    };
  }
}

/**
 * 页面检查服务：唯一底层。管理每个 webContents 的 session（acquire 幂等、防双 attach）。
 */
export class PageInspectionService {
  private readonly sessions = new Map<PageWebContentsLike, { session: PageInspectionSession; owner: string }>();

  /**
   * 获取某 webContents 的检查 session。同一 wc 同时只有一个 session：
   * - 同 owner 重复 acquire → 返回既有 session（幂等）；
   * - 不同 owner 且既有 session 活跃 → 拒绝（抛错，明确冲突，防双 owner 踩踏）；
   * - 既有 session 已 disposed（release 过）→ 创建新 session。
   */
  acquire(wc: PageWebContentsLike, owner: string): PageInspectionSession {
    const existing = this.sessions.get(wc);
    if (existing && !existing.session.isDisposed) {
      if (existing.owner !== owner) {
        throw new Error(
          `webContents 已被另一 owner（${existing.owner}）检查中，拒绝 ${owner} 重复 acquire（防双 attach/踩踏）`,
        );
      }
      return existing.session;
    }
    const session = new PageInspectionSession(owner);
    this.sessions.set(wc, { session, owner });
    return session;
  }

  /**
   * 释放 session（幂等）：仅当 owner 匹配时释放——防止 A release 掉 B 的 session。
   * owner 不匹配 → warn 且不删除（调用方 bug 可见，不静默破坏他人会话）。
   */
  release(wc: PageWebContentsLike, owner: string): void {
    const entry = this.sessions.get(wc);
    if (!entry) return;
    if (entry.owner !== owner) {
      console.warn(
        `[PageInspectionService] release owner 不匹配：wc 属于 ${entry.owner}，拒绝 ${owner} 释放`,
      );
      return;
    }
    entry.session.dispose();
    this.sessions.delete(wc);
  }

  /** 当前注册 session 数（诊断/测试） */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 当前 wc 的 owner（诊断/测试；null = 无 session） */
  ownerOf(wc: PageWebContentsLike): string | null {
    return this.sessions.get(wc)?.owner ?? null;
  }

  sessionFor(wc: PageWebContentsLike, owner: string): PageInspectionSession | null {
    const entry = this.sessions.get(wc);
    return entry?.owner === owner && !entry.session.isDisposed ? entry.session : null;
  }

  // ---------- 只读页面快照（不 attach CDP；executeJavaScript 直读，避免与用户 DevTools 冲突） ----------

  async getPageSnapshot(wc: PageWebContentsLike): Promise<PageSnapshot | null> {
    if (wc.isDestroyed?.()) return null;
    try {
      const [text, title] = await Promise.all([
        wc.executeJavaScript(READ_BODY_TEXT_JS, true),
        wc.executeJavaScript("document.title || ''", true),
      ]);
      const url = wc.getURL?.() ?? "";
      if (!url) return null;
      return {
        url,
        title: typeof title === "string" ? title : "",
        text: typeof text === "string" ? text.slice(0, PAGE_TEXT_MAX_CHARS) : "",
        fetchedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getDocumentHtml(wc: PageWebContentsLike): Promise<string | null> {
    if (wc.isDestroyed?.()) return null;
    try {
      const html = await wc.executeJavaScript(
        "document.documentElement ? document.documentElement.outerHTML : ''",
        true,
      );
      return typeof html === "string" ? html.slice(0, PAGE_HTML_MAX_CHARS) : null;
    } catch {
      return null;
    }
  }
}

const READ_BODY_TEXT_JS = `(() => {
  const clone = document.body ? document.body.cloneNode(true) : null;
  if (!clone) return '';
  for (const el of clone.querySelectorAll('script,style,noscript,svg,canvas,iframe')) el.remove();
  const text = (clone.textContent || '').replace(/\\s+/g, ' ').trim();
  return text.slice(0, ${PAGE_TEXT_MAX_CHARS});
})()`;

/** 全局单例（业务方共用；测试可 new 独立实例） */
export const pageInspectionService = new PageInspectionService();

/** 剥 HTML 标签取文本（压缩空白） */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** 辅助 selector：tag#id.class（不保证唯一/稳定） */
function buildSelector(tagName: string, id?: string, classNames: string[] = []): string {
  let s = tagName || "div";
  if (id) s += `#${id}`;
  for (const c of classNames) s += `.${c}`;
  return s;
}
