/**
 * 扩展栏浏览器宿主：WebContentsView 叠加在右侧面板 .browser-wcv-host 上。
 * 允许 http(s) 站内导航（Penpot SPA 需要）；与产物预览 ArtifactPreviewHost 分离，
 * 避免 mybuddy-artifact 协议宿主拦截外链。
 */
import { BrowserWindow, dialog, shell, WebContentsView, type Rectangle } from "electron";
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
  reason: "navigate" | "reload" | "close" | "destroy";
}

export class BrowserHost {
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

  attach(win: BrowserWindow): void {
    if (this.view) return;
    this.view = new WebContentsView({
      webPreferences: {
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
    runtimeProbeService.attach("browser", wc);
    // WebContentsView 没有浏览器标签页自带的离开确认 UI。默认拒绝会让
    // loadURL/reload 以 ERR_FAILED 结束，页面看起来仍是旧内容。
    wc.on("will-prevent-unload", (event) => {
      if (this.confirmUnload(win)) event.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      // 新窗口请求：全部 http(s)（含 localhost）交给系统浏览器
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("did-navigate", (_e, url) => {
      this.currentUrl = url;
      this.advanceSurface("navigate");
      if (this.isVisible) this.onUrlChanged?.(url);
    });
    wc.on("did-start-navigation", (_e, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) this.advanceSurface("navigate");
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.currentUrl = url;
      this.advanceSurface("navigate");
      if (this.isVisible) this.onUrlChanged?.(url);
    });
    wc.on("destroyed", () => {
      runtimeProbeService.detach("browser", wc);
      this.releaseScreenshotSurface?.();
      this.exitCapture();
      pageInspectionService.release(wc, "browser-host");
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

  open(url: string): void {
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
      if (/^file:/i.test(target)) this.reload();
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
  async navigateForAutomation(url: string, signal?: AbortSignal): Promise<void> {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) throw new Error("MyBuddy 浏览器尚未挂载");
    this.ensureViewport();
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
    const captureWindow = new BrowserWindow({
      show: false, width: bounds.width, height: bounds.height, useContentSize: true,
      frame: false, transparent: true, opacity: 0, hasShadow: false,
      focusable: false, skipTaskbar: true, resizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    captureWindow.setIgnoreMouseEvents(true);
    this.screenshotWindow = captureWindow;
    const release = () => {
      if (this.screenshotWindow !== captureWindow) return;
      this.screenshotWindow = null;
      this.releaseScreenshotSurface = null;
      if (!captureWindow.isDestroyed()) captureWindow.contentView.removeChildView(view);
      if (this.view === view && !view.webContents.isDestroyed() && !mainWindow.isDestroyed()) {
        mainWindow.contentView.addChildView(view);
        view.setBounds(this.lastBounds && this.lastBounds.width >= 8 && this.lastBounds.height >= 8 ? this.lastBounds : bounds);
        this.applyVisibility();
      }
      if (!captureWindow.isDestroyed()) captureWindow.destroy();
    };
    this.releaseScreenshotSurface = release;
    try {
      mainWindow.contentView.removeChildView(view);
      captureWindow.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
      view.setVisible(true);
      captureWindow.showInactive();
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
      this.view.webContents.removeAllListeners();
      this.win?.contentView.removeChildView(this.view);
      this.view = null;
      this.win = null;
    }
    this.currentUrl = "";
    this.lastBounds = null;
    this.desiredVisible = false;
    this.blockers.clear();
    this.isVisible = false;
    this.advanceSurface("destroy");
  }
}

export const browserHost = new BrowserHost();

