/**
 * HTML 产物预览宿主：用 Electron 原生 WebContentsView（完整 Chromium 渲染）
 * 承载产物 HTML，替换受限的 <iframe srcDoc> 沙箱预览。
 *
 * Wave 3 收口（P4）+ Wave 4B（§102/§17）后的职责边界：
 * - 本类 = 纯 Full Web Surface host：WCV 创建、load URL、bounds/visible、
 *   reload/close/dispose、导航拦截（navigation lifecycle）。
 * - 不再承担任何 Artifact truth / cache / 协议 / 资源解析职责：
 *   · 协议与资源解析在 ArtifactProtocol / WebArtifactRuntime（4B 拆分）；
 *   · URL 由 ArtifactProtocol.urlFor 构造，本类只负责 loadURL；
 *   · 不持有 resolver、不拼磁盘路径、不查 Domain。
 * - 显示决策由 NativeSurfaceCoordinator 独占（4A）：本类的 show/hide/setBounds
 *   只有 Coordinator 一条链调用。
 * - 页面与 renderer 完全隔离（sandbox，无 preload、无 Node 能力）
 * - 导航策略：产物协议内相对导航放行；其余 http(s)（含 localhost）→ 系统浏览器
 */
import { BrowserWindow, shell, WebContentsView, type Rectangle } from "electron";
import { ArtifactProtocol } from "./ArtifactProtocol";
import { runtimeProbeService } from "../capabilities/RuntimeProbeService";

/** loadURL 在导航被后一次 loadURL/关闭宿主打断时会以 ERR_ABORTED 拒绝。
 * 错误对象存在两种形态：code === "ERR_ABORTED"（多数情况），或
 * errno === -3 且 code 为空字符串（启动恢复/快速切换时 Electron 偶发形态）——
 * 两者都是预期内的导航中止，不得误报。 */
function isExpectedNavigationAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; errno?: unknown };
  return e.code === "ERR_ABORTED" || e.errno === -3;
}

export class ArtifactPreviewHost {
  get captureSurface(): { window: BrowserWindow; view: WebContentsView } | null {
    return this.win && this.view ? { window: this.win, view: this.view } : null;
  }
  private win: BrowserWindow | null = null;
  private view: WebContentsView | null = null;
  /** 用于忽略被后续预览/关闭操作取代的旧导航结果。 */
  private navigationGeneration = 0;
  private lastBounds: Rectangle | null = null;
  private isVisible = false;

  private routeHttpUrl(url: string): void {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  }

  /** 挂载到主窗口：创建独立 webContents（sandbox 隔离，不可信产物页面） */
  attach(win: BrowserWindow): void {
    if (this.view) return;
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
      },
    });
    this.win = win;
    this.view = view;
    view.setVisible(false);
    win.contentView.addChildView(view);

    const wc = view.webContents;
    runtimeProbeService.attach("artifact", wc);
    // 新窗口一律拒绝，http(s) 送系统浏览器
    wc.setWindowOpenHandler(({ url }) => {
      this.routeHttpUrl(url);
      return { action: "deny" };
    });
    // 产物页面内导航：协议内相对导航放行；其它 http(s) → 系统浏览器
    wc.on("will-navigate", (event, url) => {
      if (url.startsWith(`${ArtifactProtocol.SCHEME}://`)) return;
      event.preventDefault();
      this.routeHttpUrl(url);
    });
  }

  /**
   * 加载产物 URL（URL 由 ArtifactProtocol 构造；内容/资源解析在 Runtime，不经本类）。
   * 返回 Promise：did-finish-load 时 resolve；被后续 load/close 取代的导航
   * （ERR_ABORTED）或旧 generation 正常返回，不抛错。
   */
  async load(url: string): Promise<void> {
    if (!this.view) return;
    const generation = ++this.navigationGeneration;
    try {
      await this.view.webContents.loadURL(url);
    } catch (err: unknown) {
      // React StrictMode、快速切换产物和关闭面板都会合法地中断上一轮导航。
      if (generation !== this.navigationGeneration || isExpectedNavigationAbort(err)) return;
      console.error("[ArtifactPreview] loadURL failed", url, err);
    }
  }

  /**
   * 宿主区域同步（DIP）：只更新位置，不做显示决策（显示由 Coordinator 经 show/hide 控制，
   * 4A 收敛；此处保留过小防御隐藏）。
   */
  setBounds(rect: Rectangle): void {
    if (!this.view) return;
    this.lastBounds = rect;
    if (rect.width < 8 || rect.height < 8) {
      this.setVisible(false);
      return;
    }
    this.view.setBounds(rect);
  }

  get visible(): boolean {
    return this.isVisible;
  }

  /** 当前 WCV 的 webContents（PageInspectionService 装配用；null = 未挂载） */
  get webContentsView(): WebContentsView | null {
    return this.view;
  }

  /** WCV 的 debugger（兼容旧装配；新代码统一走 PageInspectionService） */
  get debugger(): Electron.Debugger | null {
    return this.view?.webContents.debugger ?? null;
  }

  private setVisible(visible: boolean): void {
    if (!this.view) return;
    this.isVisible = visible;
    this.view.setVisible(visible);
  }

  /** 隐藏视图但保留位置与内容（浮层需盖在页面之上时调用；仅 Coordinator 调用） */
  hide(): void {
    this.setVisible(false);
  }

  /** 按最近一次 bounds 恢复显示（仅 Coordinator 调用） */
  show(): void {
    if (this.view && !this.isVisible && this.lastBounds) {
      this.view.setBounds(this.lastBounds);
      this.setVisible(true);
    }
  }

  /**
   * 显式刷新不设 isVisible 门禁：coordinator 合成可见性为 false
   *（blocker 未清/bounds 异常）时点击刷新仍执行，此前会静默 no-op。
   */
  reload(): void {
    if (this.view) this.view.webContents.reload();
  }

  /** 硬刷新：忽略缓存强制重载（与扩展浏览器 hardReload 对齐；同样不设可见门禁） */
  hardReload(): void {
    if (this.view) this.view.webContents.reloadIgnoringCache();
  }

  /** 关闭并隐藏（切换产物 / 卸载时调用，下次 load 重新加载） */
  close(): void {
    this.navigationGeneration++;
    this.setVisible(false);
  }

  /** 销毁（应用退出） */
  dispose(): void {
    this.navigationGeneration++;
    if (this.view) {
      runtimeProbeService.detach("artifact", this.view.webContents);
      this.view.webContents.removeAllListeners();
      this.win?.contentView.removeChildView(this.view);
      this.view.webContents.close();
      this.view = null;
      this.win = null;
      this.lastBounds = null;
    }
  }
}

export const artifactPreviewHost = new ArtifactPreviewHost();
