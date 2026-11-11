/**
 * 扩展栏浏览器宿主：WebContentsView 叠加在右侧面板 .browser-wcv-host 上。
 * 允许 http(s) 站内导航（Penpot SPA 需要）；与产物预览 ArtifactPreviewHost 分离，
 * 避免 mybuddy-artifact 协议宿主拦截外链。
 */
import { BrowserWindow, dialog, WebContentsView, type Rectangle } from "electron";
import { randomUUID } from "node:crypto";
import type { BrowserOpenOptions, BrowserTabInfo, BrowserTabsState } from "../../shared/browser-tabs";
import type { CaptureModeState, SelectionDescriptor } from "../../shared/capture-mode";
import {
  pageInspectionService,
  PageCaptureError,
  PageCaptureScope,
  type PageInspectionSession,
  type SelectionEventPayload,
} from "../artifact/PageInspectionService";
import { runtimeProbeService } from "../capabilities/RuntimeProbeService";

export const BROWSER_CAPTURE_ARTIFACT_ID = "extension-browser";
const DEFAULT_BROWSER_VIEWPORT = { x: 0, y: 0, width: 1280, height: 720 };

function sameBounds(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

export interface BrowserSurfaceChange {
  generation: number;
  reason: "navigate" | "reload" | "close" | "destroy" | "select";
}

class BrowserTabSurface {
  private win: BrowserWindow | null = null;
  private view: WebContentsView | null = null;

  /** 当前 WCV 的 webContents（PageInspectionService / BrowserContentService 装配用；null = 未挂载） */
  get inspectionWebContents(): Electron.WebContents | null {
    return this.view?.webContents ?? null;
  }

  get captureSurface(): { window: BrowserWindow; view: WebContentsView } | null {
    return this.win && this.view ? { window: this.win, view: this.view } : null;
  }

  async resumeCapture(): Promise<void> {
    if (this.captureState === "active") await this.inspector?.setInspectMode();
  }

  async pauseCapture(): Promise<void> {
    if (this.captureState === "active") await this.inspector?.clearInspectMode();
  }
  private currentUrl = "";
  private lastBounds: Rectangle | null = null;
  /** renderer 的显示意图（有有效 bounds 且未 close）；最终可见还要过 blockers */
  private desiredVisible = false;
  /** 全屏 DOM 弹层等来源登记后，setBounds 不得把 WCV 重新盖到弹层上 */
  private blockers = new Set<string>();
  private isVisible = false;
  private generation = 0;
  private captureState: CaptureModeState = "idle";
  private captureGeneration: number | null = null;
  private inspector: PageInspectionSession | null = null;
  private screenshotWindow: BrowserWindow | null = null;
  private parkedScreenshotWindow: BrowserWindow | null = null;
  private detachParkedScreenshotWindow: (() => void) | null = null;
  private releaseScreenshotSurface: (() => void) | null = null;
  private preserveScreenshotSurface: (() => void) | null = null;
  private layoutVersion = 0;
  private screenshotQueue: Promise<void> = Promise.resolve();

  onUrlChanged: ((url: string) => void) | null = null;
  onCaptureStateChanged: ((state: CaptureModeState, error?: string) => void) | null = null;
  onSelection: ((selection: SelectionDescriptor) => void) | null = null;
  onSurfaceChanged: ((change: BrowserSurfaceChange) => void) | null = null;

  constructor(private readonly confirmUnload: (win: BrowserWindow) => boolean = (win) =>
    dialog.showMessageBoxSync(win, {
      type: "question",
      message: "网页请求确认离开",
      detail: "重新加载或离开可能丢失尚未保存的输入。是否继续？",
      buttons: ["继续", "留在页面"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }) === 0) {}

  onCreatePopup: ((options: Electron.BrowserWindowConstructorOptions) => Electron.WebContents) | null = null;

  attach(win: BrowserWindow, preferences?: Electron.WebPreferences, webContents?: Electron.WebContents): void {
    if (this.view) return;
    this.view = new WebContentsView({
      ...(webContents ? { webContents } : {}),
      webPreferences: {
        ...preferences,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        javascript: true,
        backgroundThrottling: false,
        partition: "persist:extension-browser",
      },
    });
    this.win = win;
    this.setViewVisible(false);
    win.contentView.addChildView(this.view);
    this.ensureViewport();

    const wc = this.view.webContents;
    // WebContentsView 没有浏览器标签页自带的离开确认 UI。默认拒绝会让
    // loadURL/reload 以 ERR_FAILED 结束，页面看起来仍是旧内容。
    wc.on("will-prevent-unload", (event) => {
      if (this.confirmUnload(win)) event.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      // Preserve Chromium opener/post-body semantics without creating an external
      // BrowserWindow or replacing the source document.
      if (!this.onCreatePopup || !(/^https?:/i.test(url) || url === "about:blank")) return { action: "deny" };
      return { action: "allow", outlivesOpener: true, createWindow: (options) => this.onCreatePopup!(options) };
    });
    wc.on("did-navigate", (_e, url) => {
      this.currentUrl = url;
      this.advanceSurface("navigate");
      this.onUrlChanged?.(url);
    });
    wc.on("did-start-navigation", (_e, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) this.advanceSurface("navigate");
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.currentUrl = url;
      this.advanceSurface("navigate");
      this.onUrlChanged?.(url);
    });
    wc.on("destroyed", () => {
      runtimeProbeService.detach("browser", wc);
      this.releaseScreenshotSurface?.();
      this.exitCapture();
      pageInspectionService.release(wc, "browser-host");
      if (this.view && this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
      this.view = null;
      this.advanceSurface("destroy");
    });
  }

  get visible(): boolean {
    return this.isVisible;
  }

  get url(): string {
    return this.currentUrl;
  }

  private setViewVisible(visible: boolean): void {
    if (!this.view) return;
    this.isVisible = visible;
    if (!visible) this.preserveScreenshotSurface?.();
    if (!this.screenshotWindow) this.view.setVisible(visible);
  }

  /**
   * 合成可见性：desiredVisible × blockers × 有效 bounds。
   * setBounds 只更新位置/意图，有 blocker 时不得把 WCV 重新显示到 DOM 弹层之上。
   */
  private applyVisibility(): void {
    if (!this.view) return;
    const bounds = this.lastBounds;
    const boundsOk = Boolean(bounds && bounds.width >= 8 && bounds.height >= 8);
    const visible = this.desiredVisible && this.blockers.size === 0 && boundsOk;
    if (boundsOk && bounds && !this.screenshotWindow) this.view.setBounds(bounds);
    this.setViewVisible(visible);
  }

  addBlocker(token: string): void {
    const key = token.trim();
    if (!key) return;
    this.blockers.add(key);
    this.applyVisibility();
  }

  removeBlocker(token: string): void {
    this.blockers.delete(token.trim());
    this.applyVisibility();
  }

  setBounds(rect: Rectangle): void {
    if (!this.view) return;
    if (!this.lastBounds || !sameBounds(this.lastBounds, rect)) this.layoutVersion += 1;
    this.lastBounds = rect;
    this.desiredVisible = rect.width >= 8 && rect.height >= 8;
    this.applyVisibility();
  }

  open(url: string, options?: { reload?: boolean; preserveDocument?: boolean }): void {
    if (!this.view) return;
    if (!url) {
      this.close();
      return;
    }
    // 先收起显示意图，等 renderer setBounds 再合成；避免沿用旧 bounds 盖住其它 UI
    this.desiredVisible = false;
    this.applyVisibility();
    const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
    this.ensureViewport();
    // close() 隐藏但保留文档。先恢复实际加载地址；新导航被
    // beforeunload 取消时，刷新/抓取仍应指向留下来的页面。
    this.currentUrl = this.view.webContents.getURL();
    if (target !== this.currentUrl) {
      void this.view.webContents.loadURL(target).catch((err: unknown) => {
        // 快速连续打开/关闭时，先前的导航被取代会以 ERR_ABORTED 拒绝，属预期中止，不误报
        if (err && typeof err === "object" && (err as { code?: string }).code === "ERR_ABORTED") return;
        console.error("[BrowserHost] loadURL failed", target, err);
      });
    } else {
      // 同一路径的本地文件可能已被编辑，重开也必须更新其 JS/CSS。
      if (options?.reload || (!options?.preserveDocument && /^file:/i.test(target))) this.reload();
      this.desiredVisible = Boolean(this.lastBounds);
      this.applyVisibility();
    }
  }

  close(): void {
    this.exitCapture();
    this.desiredVisible = false;
    this.currentUrl = "";
    this.lastBounds = null;
    this.applyVisibility();
    this.advanceSurface("close");
  }

  hide(): void {
    this.desiredVisible = false;
    this.applyVisibility();
  }

  show(): void {
    this.desiredVisible = true;
    this.applyVisibility();
  }

  navigate(url: string): void {
    this.open(url);
  }

  /** Agent navigation shares the exact WCV without changing renderer visibility. */
  async navigateForAutomation(url: string, signal?: AbortSignal, options?: { reload?: boolean }): Promise<void> {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) throw new Error("MyBuddy 浏览器尚未挂载");
    this.ensureViewport();
    if (!options?.reload && wc.getURL() === url && !wc.isLoadingMainFrame()) return;
    const scope = new PageCaptureScope(signal, 30_000);
    await scope.run(() => wc.loadURL(url));
  }

  private ensureViewport(): void {
    if (!this.view) return;
    const bounds = this.view.getBounds();
    if (bounds.width < 8 || bounds.height < 8) this.view.setBounds(DEFAULT_BROWSER_VIEWPORT);
  }

  /** Chromium cannot present fresh frames for a hidden native view. Temporarily
   * reparent the exact view (same document, session and debugger) to an invisible,
   * noninteractive window that still presents frames. Renderer intent stays owned
   * by applyVisibility, and is applied again when the capture releases its view. */
  private leaseScreenshotSurface(view: WebContentsView, bounds: Rectangle): () => void {
    const mainWindow = this.win;
    if (!mainWindow || mainWindow.isDestroyed()) throw new PageCaptureError("SURFACE_CHANGED", "浏览器宿主已关闭");
    if (this.isVisible && mainWindow.isVisible() && !mainWindow.isMinimized()) return () => {};
    const parkedWindow = this.parkedScreenshotWindow;
    this.detachParkedScreenshotWindow?.();
    const captureWindow = parkedWindow && !parkedWindow.isDestroyed() ? parkedWindow : new BrowserWindow({
      show: false, width: bounds.width, height: bounds.height, useContentSize: true,
      frame: false, transparent: true, opacity: 0, hasShadow: false,
      focusable: false, skipTaskbar: true, resizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    captureWindow.setIgnoreMouseEvents(true);
    captureWindow.setContentSize(bounds.width, bounds.height);
    this.screenshotWindow = captureWindow;
    const refreshVisibility: ReturnType<typeof setTimeout>[] = [];
    const release = () => {
      for (const timer of refreshVisibility) clearTimeout(timer);
      if (this.screenshotWindow !== captureWindow) return;
      this.screenshotWindow = null;
      this.releaseScreenshotSurface = null;
      if (!view.webContents.isDestroyed()) view.setVisible(false);
      if (!captureWindow.isDestroyed()) captureWindow.contentView.removeChildView(view);
      if (this.view === view && !view.webContents.isDestroyed() && !mainWindow.isDestroyed()) {
        mainWindow.contentView.addChildView(view);
        view.setBounds(this.lastBounds && this.lastBounds.width >= 8 && this.lastBounds.height >= 8 ? this.lastBounds : bounds);
        this.applyVisibility();
      }
      if (!captureWindow.isDestroyed()) {
        if (!mainWindow.isDestroyed() && mainWindow.isMinimized()) {
          // Closing even an empty inactive native window can restore another
          // minimized window on Wayland. Keep one empty, non-interactive
          // presenter until the user restores/closes the parent, and reuse it.
          this.parkedScreenshotWindow = captureWindow;
          const detach = () => {
            mainWindow.off("restore", destroy);
            mainWindow.off("closed", destroy);
            if (this.parkedScreenshotWindow === captureWindow) {
              this.parkedScreenshotWindow = null;
              this.detachParkedScreenshotWindow = null;
            }
          };
          const destroy = () => { detach(); if (!captureWindow.isDestroyed()) captureWindow.destroy(); };
          this.detachParkedScreenshotWindow = detach;
          mainWindow.once("restore", destroy);
          mainWindow.once("closed", destroy);
        } else captureWindow.destroy();
      }
    };
    this.releaseScreenshotSurface = release;
    try {
      mainWindow.contentView.removeChildView(view);
      captureWindow.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
      view.setVisible(true);
      captureWindow.showInactive();
      // A transferred WCV can retain the minimized parent's native hidden state
      // even while document.visibilityState says "visible". The temporary
      // window's show/ready-to-show events can precede native surface mapping.
      // Refresh only the still-leased surface after mapping has had a chance to
      // settle; never restore/focus the main window or change the DOM viewport.
      // Fast captures cancel all recovery attempts when they release the lease.
      // A single fixed delay is insufficient when native mapping is delayed.
      for (const delay of [300, 700, 1500, 3000]) {
        const timer = setTimeout(() => {
          if (this.screenshotWindow !== captureWindow || captureWindow.isDestroyed()
            || view.webContents.isDestroyed()) return;
          view.setVisible(false);
          view.setVisible(true);
        }, delay);
        timer.unref();
        refreshVisibility.push(timer);
      }
      return release;
    } catch (error) { release(); throw error; }
  }

  /** One owner handles screenshots even when the renderer panel is hidden. Never
   * show/focus the host, override blockers, or restore an obsolete renderer size. */
  captureScreenshot(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Uint8Array> {
    this.ensureViewport();
    const view = this.view;
    const wc = view?.webContents;
    if (!view || !wc || wc.isDestroyed() || !this.currentUrl) return Promise.reject(new Error("浏览器没有可截图的页面"));
    const generation = this.generation;
    const layout = this.layoutVersion;
    const bounds = view.getBounds();
    const scope = new PageCaptureScope(options.signal, options.timeoutMs, () => {
      if (this.view !== view || wc.isDestroyed() || generation !== this.generation
        || layout !== this.layoutVersion || bounds.width !== view.getBounds().width || bounds.height !== view.getBounds().height) {
        throw new PageCaptureError("SURFACE_CHANGED", "截图期间浏览器页面或视口发生变化");
      }
    });
    const previous = this.screenshotQueue;
    const job = previous.then(async () => {
      scope.check();
      if (wc.isLoadingMainFrame()) {
        let cleanup = () => {};
        const loaded = new Promise<void>((resolve, reject) => {
          const done = () => { cleanup(); resolve(); };
          const destroyed = () => { cleanup(); reject(new PageCaptureError("SURFACE_CHANGED", "截图页面已销毁")); };
          cleanup = () => { wc.off("did-stop-loading", done); wc.off("destroyed", destroyed); };
          wc.once("did-stop-loading", done);
          wc.once("destroyed", destroyed);
          if (!wc.isLoadingMainFrame()) done();
        });
        try { await scope.wait(loaded); }
        finally { cleanup(); }
      }
      const session = pageInspectionService.acquire(wc, "browser-host");
      const mainWindow = this.win;
      let releaseSurface = () => {};
      const preserveSurface = () => {
        if (this.view === view && !wc.isDestroyed() && !this.screenshotWindow) {
          releaseSurface = this.leaseScreenshotSurface(view, bounds);
        }
      };
      try {
        this.preserveScreenshotSurface = preserveSurface;
        mainWindow?.on("hide", preserveSurface);
        mainWindow?.on("minimize", preserveSurface);
        releaseSurface = this.leaseScreenshotSurface(view, bounds);
        await scope.run(() => session.attach(wc.debugger));
        const bytes = await session.captureScreenshot(scope);
        scope.check();
        return bytes;
      } finally {
        // Keep a presenting surface until the native snapshot finishes, including
        // when the caller cancels or hides the panel/window during that snapshot.
        // Caller cancellation is prompt, but it cannot destroy the frame producer.
        await scope.drain();
        if (this.preserveScreenshotSurface === preserveSurface) this.preserveScreenshotSurface = null;
        mainWindow?.off("hide", preserveSurface);
        mainWindow?.off("minimize", preserveSurface);
        releaseSurface();
        if (pageInspectionService.sessionFor(wc, "browser-host") === session && this.inspector !== session) {
          pageInspectionService.release(wc, "browser-host");
        }
      }
    });
    this.screenshotQueue = job.then(() => undefined, () => undefined);
    // Caller cancellation is prompt; the queue still owns/drains the native work.
    return scope.wait(job);
  }

  /**
   * 显式刷新不设 isVisible 门禁：view 被隐藏/尺寸异常时仍执行，
   * 此前隐藏态点击刷新会静默 no-op（用户侧“点了没反应”）。
   * 显式刷新必须同时更新 HTML 和子资源；普通 reload 会复用仍新鲜的
   * JS/CSS 缓存，导致本地开发页更新 HTML 后仍运行旧代码。
   */
  reload(): void {
    this.reloadCurrent();
  }

  /** 硬刷新：忽略缓存强制重载（Ctrl+F5 等价，用于调试 HMR/静态资源不更新） */
  hardReload(): void {
    this.reloadCurrent();
  }

  private reloadCurrent(): void {
    if (!this.view || !this.currentUrl) return;
    this.advanceSurface("reload");
    this.view.webContents.reloadIgnoringCache();
  }

  back(): void {
    if (this.view && this.isVisible && this.view.webContents.navigationHistory.canGoBack()) {
      this.view.webContents.navigationHistory.goBack();
    }
  }

  forward(): void {
    if (this.view && this.isVisible && this.view.webContents.navigationHistory.canGoForward()) {
      this.view.webContents.navigationHistory.goForward();
    }
  }

  async enterCapture(): Promise<void> {
    if (this.captureState === "entering" || this.captureState === "active") return;
    const wc = this.view?.webContents;
    if (!wc || !this.currentUrl) {
      this.setCaptureState("error", "无可用浏览器页面");
      return;
    }
    this.exitCapture();
    this.captureGeneration = this.generation;
    this.setCaptureState("entering");
    const inspector = pageInspectionService.acquire(wc, "browser-host");
    inspector.onSelection = (payload) => { void this.handleSelection(payload); };
    inspector.onInspectModeCanceled = () => this.setCaptureState("active");
    inspector.onDetached = () => {
      if (this.captureState === "active" || this.captureState === "entering") {
        this.captureGeneration = null;
        this.setCaptureState("exited");
      }
    };
    this.inspector = inspector;
    try {
      await inspector.attach(wc.debugger);
      await inspector.setInspectMode();
      if (this.captureGeneration !== this.generation) {
        pageInspectionService.release(wc, "browser-host");
        this.inspector = null;
        this.captureGeneration = null;
        this.setCaptureState("exited");
        return;
      }
      this.setCaptureState("active");
    } catch (error) {
      pageInspectionService.release(wc, "browser-host");
      this.inspector = null;
      this.captureGeneration = null;
      this.setCaptureState(
        "error",
        error instanceof Error ? error.message : "CDP attach 失败（DevTools 可能已打开）",
      );
    }
  }

  exitCapture(): void {
    if (this.captureState !== "entering" && this.captureState !== "active") return;
    const wc = this.view?.webContents;
    if (this.inspector) {
      this.inspector.detach();
      if (wc) pageInspectionService.release(wc, "browser-host");
      this.inspector = null;
    }
    this.captureGeneration = null;
    this.setCaptureState("exited");
  }

  get captureVersion(): number {
    return this.generation;
  }

  async readDocumentHtml(): Promise<string | null> {
    if (!this.view || !this.currentUrl) return null;
    return pageInspectionService.getDocumentHtml(this.view.webContents);
  }

  private setCaptureState(state: CaptureModeState, error?: string): void {
    this.captureState = state;
    this.onCaptureStateChanged?.(state, error);
  }

  private async handleSelection(payload: SelectionEventPayload): Promise<void> {
    if (this.captureState !== "active" || this.captureGeneration !== this.generation) return;
    const inspector = this.inspector;
    const generation = this.generation;
    await inspector?.clearInspectMode();
    if (this.captureState !== "active" || generation !== this.generation || inspector !== this.inspector) return;
    if (payload.backendNodeId != null) await inspector?.highlightNode(payload.backendNodeId).catch(() => undefined);
    if (this.captureState !== "active" || generation !== this.generation || inspector !== this.inspector) return;
    this.onSelection?.({
      artifactId: BROWSER_CAPTURE_ARTIFACT_ID,
      artifactVersion: this.generation,
      surfaceGeneration: this.generation,
      ...payload,
    });
  }

  private advanceSurface(reason: BrowserSurfaceChange["reason"]): void {
    this.exitCapture();
    this.generation += 1;
    this.onSurfaceChanged?.({ generation: this.generation, reason });
  }

  dispose(): void {
    if (this.view) {
      this.preserveScreenshotSurface = null;
      this.releaseScreenshotSurface?.();
      this.exitCapture();
      pageInspectionService.release(this.view.webContents, "browser-host");
      runtimeProbeService.detach("browser", this.view.webContents);
      const view = this.view;
      view.webContents.removeAllListeners();
      if (this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(view);
      this.view = null;
      if (!view.webContents.isDestroyed()) view.webContents.close();
      this.win = null;
    }
    const parkedWindow = this.parkedScreenshotWindow;
    this.detachParkedScreenshotWindow?.();
    if (parkedWindow && !parkedWindow.isDestroyed()) parkedWindow.destroy();
    this.currentUrl = "";
    this.lastBounds = null;
    this.desiredVisible = false;
    this.blockers.clear();
    this.isVisible = false;
    this.advanceSurface("destroy");
  }
}




/** A fixed document owner for a whole automation invocation. Unlike BrowserHost,
 * this handle never follows the user's selected tab. */
export type BrowserPageHost = Pick<BrowserTabSurface,
  "inspectionWebContents" | "url" | "captureVersion" | "navigateForAutomation" | "captureScreenshot" | "readDocumentHtml">;

interface ManagedBrowserTab {
  id: string;
  key: string;
  taskId?: string;
  gadgetId?: string;
  openerTabId?: string;
  dirty?: boolean;
  surface: BrowserTabSurface;
}

/** Native tab registry. UI selection and automation document ownership are
 * deliberately independent. Hiding the panel never closes a document. */
export class BrowserHost {
  private win: BrowserWindow | null = null;
  private readonly tabs = new Map<string, ManagedBrowserTab>();
  private activeId: string | null = null;
  private lastBounds: Rectangle | null = null;
  private desiredVisible = false;
  private readonly blockers = new Set<string>();
  private selectionVersion = 0;
  onUrlChanged: ((url: string) => void) | null = null;
  onTabsChanged: ((state: BrowserTabsState) => void) | null = null;
  onCaptureStateChanged: BrowserTabSurface["onCaptureStateChanged"] = null;
  onSelection: BrowserTabSurface["onSelection"] = null;
  onSurfaceChanged: BrowserTabSurface["onSurfaceChanged"] = null;

  constructor(private readonly confirmUnload?: (win: BrowserWindow) => boolean) {}

  private get active(): BrowserTabSurface | null { return this.tabs.get(this.activeId ?? "")?.surface ?? null; }
  get attached(): boolean { return Boolean(this.win && !this.win.isDestroyed()); }
  get activeTabId(): string | null { return this.activeId; }
  get inspectionWebContents(): Electron.WebContents | null { return this.active?.inspectionWebContents ?? null; }
  get captureSurface(): BrowserTabSurface["captureSurface"] { return this.active?.captureSurface ?? null; }
  get visible(): boolean { return this.active?.visible ?? false; }
  get url(): string { return this.active?.url ?? ""; }
  get captureVersion(): number { return this.selectionVersion; }

  attach(win: BrowserWindow): void {
    if (this.win) return;
    this.win = win;
    this.ensureTab({ key: "legacy", activate: true });
  }

  private info(tab: ManagedBrowserTab): BrowserTabInfo {
    const wc = tab.surface.inspectionWebContents;
    return { id: tab.id, key: tab.key, taskId: tab.taskId, gadgetId: tab.gadgetId, openerTabId: tab.openerTabId,
      url: wc && !wc.isDestroyed() ? wc.getURL() : tab.surface.url,
      title: wc && !wc.isDestroyed() ? wc.getTitle() : "",
      loading: Boolean(wc && !wc.isDestroyed() && wc.isLoadingMainFrame()) };
  }
  listTabs(): BrowserTabInfo[] { return [...this.tabs.values()].map((tab) => this.info(tab)); }
  getTabsState(): BrowserTabsState { return { activeTabId: this.activeId, tabs: this.listTabs() }; }
  getTabHost(id: string): BrowserPageHost | null { return this.tabs.get(id)?.surface ?? null; }
  private emitTabs(): void { this.onTabsChanged?.(this.getTabsState()); }

  ensureTab(options: BrowserOpenOptions = {}): BrowserTabInfo {
    if (!this.win || this.win.isDestroyed()) throw new Error("MyBuddy 浏览器尚未挂载");
    const key = options.key || "legacy";
    const existing = [...this.tabs.values()].find((tab) => tab.key === key && tab.taskId === options.taskId);
    if (existing) {
      if (options.activate !== false) this.selectTab(existing.id);
      return this.info(existing);
    }
    return this.createTab({ ...options, key });
  }

  private createTab(options: BrowserOpenOptions, preferences?: Electron.WebPreferences, openerTabId?: string, webContents?: Electron.WebContents): BrowserTabInfo {
    const surface = new BrowserTabSurface(this.confirmUnload);
    const tab: ManagedBrowserTab = { id: randomUUID(), key: options.key || randomUUID(),
      taskId: options.taskId, gadgetId: options.gadgetId, openerTabId, surface };
    surface.attach(this.win!, preferences, webContents);
    for (const token of this.blockers) surface.addBlocker(token);
    this.tabs.set(tab.id, tab);
    surface.onUrlChanged = (url) => {
      this.emitTabs();
      if (this.activeId === tab.id) this.onUrlChanged?.(url);
    };
    surface.onSurfaceChanged = (change) => {
      if (this.activeId !== tab.id) return;
      this.selectionVersion++;
      this.onSurfaceChanged?.({ ...change, generation: this.selectionVersion });
    };
    surface.onCaptureStateChanged = (state, error) => {
      if (this.activeId === tab.id) this.onCaptureStateChanged?.(state, error);
    };
    surface.onSelection = (selection) => {
      if (this.activeId === tab.id) this.onSelection?.({ ...selection,
        artifactVersion: this.selectionVersion, surfaceGeneration: this.selectionVersion });
    };
    surface.onCreatePopup = (popupOptions) => {
      const popup = this.createTab({ key: `popup:${randomUUID()}`, taskId: tab.taskId,
        gadgetId: tab.gadgetId, activate: this.activeId === tab.id }, popupOptions.webPreferences, tab.id,
        (popupOptions as Electron.BrowserWindowConstructorOptions & { webContents?: Electron.WebContents }).webContents);
      return this.tabs.get(popup.id)!.surface.inspectionWebContents!;
    };
    const wc = surface.inspectionWebContents!;
    wc.on("page-title-updated", () => this.emitTabs());
    wc.on("did-start-loading", () => this.emitTabs());
    wc.on("did-stop-loading", () => this.emitTabs());
    wc.once("destroyed", () => this.removeTab(tab.id));
    if (openerTabId) {
      // Finish Chromium's native-child adoption handshake before publishing or
      // selecting the new tab. Never replace options.webContents with a second
      // newly allocated child: the opener is waiting for that exact native page.
      setImmediate(() => {
        if (!this.tabs.has(tab.id)) return;
        if (options.activate !== false && this.activeId === openerTabId) this.selectTab(tab.id);
        this.emitTabs();
      });
      return { id: tab.id, key: tab.key, taskId: tab.taskId, gadgetId: tab.gadgetId,
        openerTabId, url: "", title: "", loading: true };
    }
    if (options.activate !== false) this.selectTab(tab.id);
    this.emitTabs();
    return this.info(tab);
  }

  markGadgetUpdated(gadgetId: string): void {
    for (const tab of this.tabs.values()) if (tab.gadgetId === gadgetId) tab.dirty = true;
  }

  selectTab(id: string, refreshDirty = true): boolean {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    if (this.activeId !== id) {
      this.active?.exitCapture();
      this.active?.hide();
      const oldWc = this.inspectionWebContents;
      if (oldWc) runtimeProbeService.detach("browser", oldWc);
      this.activeId = id;
      const wc = this.inspectionWebContents;
      if (wc) runtimeProbeService.attach("browser", wc);
      this.selectionVersion++;
      this.onSurfaceChanged?.({ generation: this.selectionVersion, reason: "select" });
    }
    if (this.lastBounds) tab.surface.setBounds(this.lastBounds);
    if (!this.desiredVisible) tab.surface.hide();
    if (refreshDirty && tab.dirty) { tab.dirty = false; tab.surface.hardReload(); }
    this.emitTabs();
    return true;
  }

  /** Explicit tab close honors beforeunload; a denied close keeps its tab. */
  closeTab(id: string): void {
    const wc = this.tabs.get(id)?.surface.inspectionWebContents;
    if (wc && !wc.isDestroyed()) wc.close({ waitForBeforeUnload: true });
  }

  private removeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    tab.surface.dispose();
    if (this.activeId === id) {
      this.activeId = null;
      const remaining = [...this.tabs.values()];
      const next = remaining.filter((candidate) => candidate.taskId === tab.taskId).at(-1);
      if (next) this.selectTab(next.id);
      else { this.selectionVersion++; this.onSurfaceChanged?.({ generation: this.selectionVersion, reason: "close" }); }
    }
    this.emitTabs();
  }

  open(url: string, options?: BrowserOpenOptions): void {
    if (!this.win) return;
    if (!url) { this.close(); return; }
    let tab: ManagedBrowserTab | undefined;
    if (options?.key || options?.taskId) {
      const info = this.ensureTab({ ...options, activate: false });
      tab = this.tabs.get(info.id);
    } else {
      if (!this.active) this.ensureTab({ key: "legacy" });
      tab = this.tabs.get(this.activeId ?? "");
    }
    if (!tab) return;
    if (options?.activate !== false) this.selectTab(tab.id, false);
    const reload = options?.reload || tab.dirty;
    tab.dirty = false;
    tab.surface.open(url, { reload, preserveDocument: Boolean(options?.key) });
    if (tab.id !== this.activeId) tab.surface.hide();
    this.emitTabs();
  }

  /** Compatibility: old browser.close() means dismiss panel, never destroy tabs. */
  close(): void { this.hide(); this.active?.exitCapture(); }
  hide(): void { this.desiredVisible = false; this.active?.hide(); }
  show(): void { this.desiredVisible = true; this.active?.show(); }
  setBounds(rect: Rectangle): void {
    this.lastBounds = rect;
    this.desiredVisible = rect.width >= 8 && rect.height >= 8;
    this.active?.setBounds(rect);
  }
  addBlocker(token: string): void { this.blockers.add(token); for (const tab of this.tabs.values()) tab.surface.addBlocker(token); }
  removeBlocker(token: string): void { this.blockers.delete(token); for (const tab of this.tabs.values()) tab.surface.removeBlocker(token); }
  navigate(url: string): void { this.active?.navigate(url); }
  navigateForAutomation(url: string, signal?: AbortSignal, options?: { reload?: boolean }): Promise<void> {
    const surface = this.active;
    if (!surface) return Promise.reject(new Error("MyBuddy 浏览器尚未挂载"));
    return surface.navigateForAutomation(url, signal, options);
  }
  captureScreenshot(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Uint8Array> {
    const surface = this.active;
    if (!surface) return Promise.reject(new Error("浏览器没有可截图的页面"));
    return surface.captureScreenshot(options);
  }
  reload(): void { this.hardReload(); }
  hardReload(): void {
    const tab = this.tabs.get(this.activeId ?? "");
    if (tab) { tab.dirty = false; tab.surface.hardReload(); }
  }
  back(): void { this.active?.back(); }
  forward(): void { this.active?.forward(); }
  async enterCapture(): Promise<void> { await this.active?.enterCapture(); }
  exitCapture(): void { this.active?.exitCapture(); }
  async resumeCapture(): Promise<void> { await this.active?.resumeCapture(); }
  async pauseCapture(): Promise<void> { await this.active?.pauseCapture(); }
  async readDocumentHtml(): Promise<string | null> { return await this.active?.readDocumentHtml() ?? null; }
  dispose(): void {
    const tabs = [...this.tabs.values()];
    this.tabs.clear(); this.activeId = null;
    for (const tab of tabs) tab.surface.dispose();
    this.win = null; this.lastBounds = null; this.desiredVisible = false; this.blockers.clear();
    this.selectionVersion++;
    this.onSurfaceChanged?.({ generation: this.selectionVersion, reason: "destroy" });
    this.emitTabs();
  }
}

export const browserHost = new BrowserHost();
