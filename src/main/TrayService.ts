import { app, BrowserWindow, Menu, nativeImage, Notification, Tray, type NativeImage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMyBuddyDir } from "./paths";
import { shouldRemainResidentAfterClose } from "./platform/tray/residency";
import { resolveTrayPlatformBehavior, trayIconAsset, type PlatformTrayBehavior } from "./platform/tray";

// 托盘测试（scripts/tray-service-test.cjs）从这里取图标路径与平台行为矩阵；实现已移到 platform/tray。
export { resolveTrayPlatformBehavior, trayIconAsset };

const HINT_FILE = "close-to-tray-hint.json";

/** 系统托盘首次隐藏到托盘时提示策略对应的处理器。 */
type HideHintHandler = () => void;

/**
 * 系统托盘：点击关闭窗口时最小化到后台（默认开启）。
 * - 托盘左键/双击 → 恢复主窗口
 * - 托盘右键 → 菜单（显示 MyBuddy / 刷新 / 退出）
 * - 首次隐藏到托盘时按平台策略提示一次（Windows 气泡 / Linux 通知 / macOS 不提示）
 * - Linux 托盘创建失败时仍驻留进程，避免关窗误停提醒 / cron / Gateway
 *
 * 平台差异全部来自 `platform/tray` 的 behavior，本文件不做平台判断。
 */
export class TrayService {
  private tray: Tray | null = null;
  private win: BrowserWindow | null = null;
  private quitting = false;
  private closeToTray = true;
  private hintShown = false;
  private degradedHintShown = false;
  private trayUnavailable = false;
  private readonly liveNotifications = new Set<Notification>();
  /** 平台行为（图标格式/缩放/标签/提示策略/降级驻留） */
  private readonly behavior: PlatformTrayBehavior = resolveTrayPlatformBehavior();
  private readonly hideHintHandlers: Record<PlatformTrayBehavior["hideHint"], HideHintHandler> = {
    balloon: () => this.maybeShowBalloonHint(),
    notification: () => this.maybeShowNotificationHint(),
    none: () => { /* macOS 不提示 */ },
  };
  /** 刷新前收起原生叠加层（WebContentsView），避免盖住刚重载的页面 */
  private onBeforeReload: (() => void) | null = null;
  private onShow: (() => void) | undefined;
  private refreshMenuHandle: (() => void) | undefined;

  /** 绑定主窗口：创建托盘并接管关闭行为 */
  initialize(win: BrowserWindow | null, options?: {
    onBeforeReload?: () => void;
    onShow?: () => void;
    onExitInterface?: () => void;
    onStopAssistant?: () => void;
    residentEnabled?: () => boolean;
    /** 测试注入。生产路径走 Electron Tray。抛错视为托盘不可用。 */
    createTray?: (image: NativeImage) => Tray;
  }): void {
    this.win = win;
    this.onBeforeReload = options?.onBeforeReload ?? null;
    this.onShow = options?.onShow;
    const createTray = options?.createTray ?? ((image: NativeImage) => new Tray(image.isEmpty() ? nativeImage.createEmpty() : image));

    try {
      const iconPath = this.behavior.iconAsset;
      let icon = nativeImage.createFromPath(iconPath);
      if (this.behavior.iconFormat === "png" && icon.isEmpty()) {
        throw new Error(`Linux 托盘需要可读的 PNG 图标，当前文件无法解码: ${iconPath}`);
      }
      const scaleToPx = this.behavior.scaleToPx;
      if (scaleToPx && !icon.isEmpty()) {
        const size = icon.getSize();
        if (size.width > 32 || size.height > 32) {
          icon = icon.resize({ width: scaleToPx, height: scaleToPx });
        }
      }
      const tray = createTray(icon);
      tray.setToolTip(this.behavior.initialLabel);

      const makeMenu = () => Menu.buildFromTemplate([
        { label: "显示 MyBuddy", click: () => this.showMainWindow() },
        { label: "刷新", click: () => this.reloadMainWindow() },
        { type: "separator" },
        ...(options?.onExitInterface ? [{ label: "退出界面，助理保持在线", enabled: options.residentEnabled?.() ?? false,
          click: () => options.onExitInterface?.() }] : []),
        {
          label: options?.onStopAssistant ? "停止助理并退出" : "退出",
          click: () => {
            this.quitting = true;
            if (options?.onStopAssistant) options.onStopAssistant();
            else app.quit();
          },
        },
      ]);
      let contextMenu = makeMenu();
      this.refreshMenuHandle = () => {
        contextMenu = makeMenu();
        if (this.behavior.menuBinding === "setContextMenu") tray.setContextMenu(contextMenu);
      };

      // 菜单绑定方式按平台走 behavior：
      // - Windows/macOS：左键恢复窗口，右键在事件里 popUpContextMenu；
      // - Linux：StatusNotifierItem 的右键由宿主（Quickshell）自己渲染，必须用
      //   setContextMenu 把菜单注册到 /com/canonical/dbusmenu；popUpContextMenu 在
      //   Linux 上被 Electron 标为 darwin/win32，调用是空操作（曾导致「托盘在但
      //   右键没菜单」）。
      tray.on("click", () => this.showMainWindow());
      tray.on("double-click", () => this.showMainWindow());
      if (this.behavior.menuBinding === "setContextMenu") {
        tray.setContextMenu(contextMenu);
      } else {
        tray.on("right-click", () => { this.refreshMenu(); tray.popUpContextMenu(contextMenu); });
      }
      this.tray = tray;
      this.trayUnavailable = false;
      console.log(`[Tray] 系统托盘已初始化 (${this.behavior.iconFormat})`);
    } catch (err) {
      this.tray = null;
      this.trayUnavailable = true;
      console.error("[Tray] 创建系统托盘失败", err);
      if (this.behavior.degradedResidency) {
        console.error("[Tray] Linux 托盘不可用。关闭窗口后进程仍驻留，提醒、cron 与 Gateway 不会随关窗退出。再次启动 MyBuddy 可恢复窗口。");
      }
    }

    // 关闭窗口 → 最小化到托盘；正在退出或未开启该行为时走正常关闭。
    // Linux 上托盘失败仍拦截关闭，避免 window-all-closed 把后台任务一起杀掉。
    win?.on("close", (event) => {
      if (options?.onExitInterface && options.residentEnabled?.() && !this.quitting) {
        event.preventDefault();
        options.onExitInterface();
        return;
      }
      if (!this.shouldRemainResident()) return;
      event.preventDefault();
      win.hide();
      this.maybeShowHint();
    });
  }

  /** 实时切换「关闭到托盘」；关闭时若窗口处于隐藏状态则恢复显示，避免窗口“消失” */
  setCloseToTray(enabled: boolean): void {
    this.closeToTray = enabled;
    if (!enabled && this.win && !this.win.isVisible()) {
      this.showMainWindow();
    }
  }

  refreshMenu(): void { this.refreshMenuHandle?.(); }

  /** window-all-closed 时是否抑制退出 */
  shouldSuppressQuit(): boolean {
    return this.shouldRemainResident();
  }

  /** 托盘对象是否创建成功。Linux 降级驻留时为 false，但 shouldSuppressQuit() 仍可为 true。 */
  hasTray(): boolean {
    return this.tray !== null;
  }

  /** 从托盘/系统恢复主窗口 */
  showMainWindow(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) { this.onShow?.(); return; }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** 托盘「刷新」：先露出窗口，再重载渲染进程（白屏/卡死时可自救） */
  reloadMainWindow(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    this.showMainWindow();
    try {
      this.onBeforeReload?.();
    } catch (err) {
      console.error("[Tray] 刷新前清理叠加层失败", err);
    }
    if (win.webContents.isDestroyed()) return;
    win.webContents.reload();
  }

  /** NotificationService 的 native delivery：点击桌面通知恢复 MyBuddy。 */
  showNotification(input: { title: string; body?: string }): void {
    const title = input.title.trim() || "MyBuddy";
    const body = input.body?.trim() || "";
    try {
      if (Notification.isSupported()) {
        const notice = new Notification({ title, body, icon: this.behavior.iconAsset });
        this.liveNotifications.add(notice);
        notice.on("click", () => this.showMainWindow());
        notice.on("close", () => this.liveNotifications.delete(notice));
        notice.show();
        return;
      }
    } catch (error) {
      console.warn("[Tray] 原生通知失败，回退气泡", error);
    }
    if (!this.behavior.supportsBalloon) return;
    try {
      this.tray?.displayBalloon({ title, content: body || title, iconType: "info" });
    } catch {
      /* desktop notification failure must never affect task execution */
    }
  }

  /** 退出前销毁托盘，避免图标残留 */
  dispose(): void {
    this.refreshMenuHandle = undefined;
    this.quitting = true;
    for (const notice of this.liveNotifications) {
      try { notice.close(); } catch { /* ignore */ }
    }
    this.liveNotifications.clear();
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  private shouldRemainResident(): boolean {
    return shouldRemainResidentAfterClose({
      degradedResidency: this.behavior.degradedResidency,
      closeToTray: this.closeToTray,
      trayAlive: this.tray !== null,
      trayUnavailable: this.trayUnavailable,
      quitting: this.quitting,
    });
  }

  /** 首次隐藏到托盘时按平台策略提示一次（跨会话持久化到 ~/.mybuddy） */
  private maybeShowHint(): void {
    this.hideHintHandlers[this.behavior.hideHint]();
  }

  /** Windows：系统气泡提示一次 */
  private maybeShowBalloonHint(): void {
    if (this.hintShown || !this.tray) return;
    if (this.readHint().shown) return;
    this.hintShown = true;
    try {
      this.tray.displayBalloon({
        title: "MyBuddy",
        content: "已最小化到系统托盘，点击托盘图标可恢复窗口。",
        iconType: "info",
      });
      this.writeHint({ shown: true });
    } catch {
      /* 提示失败不影响主流程 */
    }
  }

  /** Linux：桌面通知提示一次；托盘不可用时提示降级语义 */
  private maybeShowNotificationHint(): void {
    const degraded = this.tray === null;
    if (degraded ? this.degradedHintShown : this.hintShown) return;
    const saved = this.readHint();
    if (degraded ? saved.linuxDegradedShown : saved.shown) return;
    if (degraded) this.degradedHintShown = true;
    else this.hintShown = true;
    const content = degraded
      ? "托盘图标不可用。窗口已隐藏，提醒与 Gateway 仍在运行。再次启动 MyBuddy 可恢复窗口。"
      : "已最小化到状态栏。点击托盘图标，或再次启动 MyBuddy，可恢复窗口。";
    console.warn(`[Tray] ${content}`);
    try {
      if (Notification.isSupported()) {
        const notice = new Notification({ title: "MyBuddy", body: content, icon: this.behavior.iconAsset });
        this.liveNotifications.add(notice);
        notice.on("click", () => this.showMainWindow());
        notice.on("close", () => this.liveNotifications.delete(notice));
        notice.show();
      }
    } catch {
      /* 提示失败不影响主流程 */
    }
    this.writeHint(degraded ? { linuxDegradedShown: true } : { shown: true });
  }

  private readHint(): { shown?: boolean; linuxDegradedShown?: boolean } {
    const file = join(getMyBuddyDir(), HINT_FILE);
    try {
      if (!existsSync(file)) return {};
      return JSON.parse(readFileSync(file, "utf-8")) as { shown?: boolean; linuxDegradedShown?: boolean };
    } catch {
      return {};
    }
  }

  private writeHint(patch: { shown?: boolean; linuxDegradedShown?: boolean }): void {
    const file = join(getMyBuddyDir(), HINT_FILE);
    try {
      const next = { ...this.readHint(), ...patch };
      writeFileSync(file, JSON.stringify(next), "utf-8");
    } catch {
      /* 提示失败不影响主流程 */
    }
  }
}
