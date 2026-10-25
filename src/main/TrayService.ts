import { app, BrowserWindow, Menu, nativeImage, Notification, Tray, type NativeImage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMyBuddyDir } from "./paths";
import { shouldRemainResidentAfterClose } from "./tray-residency";
// electron-vite 会把该资源 emit 到 out/main/assets 下并返回正确路径（打包后在 asar 内也可读）
import trayIcoPath from "./assets/tray.ico?asset";
import trayPngPath from "./assets/tray.png?asset";

const HINT_FILE = "close-to-tray-hint.json";

/** Linux / Wayland StatusNotifier 需要 PNG。Windows 继续用 ico。 */
export function trayIconAsset(platform: NodeJS.Platform = process.platform): string {
  return platform === "linux" ? trayPngPath : trayIcoPath;
}

/**
 * 系统托盘：点击关闭窗口时最小化到后台（默认开启）。
 * - 托盘左键/双击 → 恢复主窗口
 * - 托盘右键 → 菜单（显示 MyBuddy / 刷新 / 退出）
 * - 首次隐藏到托盘时弹一次系统通知提示
 * - Linux 托盘创建失败时仍驻留进程，避免关窗误停提醒 / cron / Gateway
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
  /** 刷新前收起原生叠加层（WebContentsView），避免盖住刚重载的页面 */
  private onBeforeReload: (() => void) | null = null;

  /** 绑定主窗口：创建托盘并接管关闭行为 */
  initialize(win: BrowserWindow, options?: {
    onBeforeReload?: () => void;
    /** 测试注入。生产路径走 Electron Tray。抛错视为托盘不可用。 */
    createTray?: (image: NativeImage) => Tray;
  }): void {
    this.win = win;
    this.onBeforeReload = options?.onBeforeReload ?? null;
    const createTray = options?.createTray ?? ((image: NativeImage) => new Tray(image.isEmpty() ? nativeImage.createEmpty() : image));

    try {
      const iconPath = trayIconAsset();
      let icon = nativeImage.createFromPath(iconPath);
      if (process.platform === "linux" && icon.isEmpty()) {
        throw new Error(`Linux 托盘需要可读的 PNG 图标，当前文件无法解码: ${iconPath}`);
      }
      if (process.platform === "linux" && !icon.isEmpty()) {
        const size = icon.getSize();
        if (size.width > 32 || size.height > 32) icon = icon.resize({ width: 22, height: 22 });
      }
      const tray = createTray(icon);
      tray.setToolTip("MyBuddy");

      const contextMenu = Menu.buildFromTemplate([
        { label: "显示 MyBuddy", click: () => this.showMainWindow() },
        { label: "刷新", click: () => this.reloadMainWindow() },
        { type: "separator" },
        {
          label: "退出",
          click: () => {
            this.quitting = true;
            app.quit();
          },
        },
      ]);

      // Windows/macOS：左键恢复窗口，右键弹出菜单。
      // Linux StatusNotifier 上 click 同样恢复；右键菜单走 right-click。
      tray.on("click", () => this.showMainWindow());
      tray.on("double-click", () => this.showMainWindow());
      tray.on("right-click", () => tray.popUpContextMenu(contextMenu));
      this.tray = tray;
      this.trayUnavailable = false;
      console.log(`[Tray] 系统托盘已初始化 (${process.platform === "linux" ? "png" : "ico"})`);
    } catch (err) {
      this.tray = null;
      this.trayUnavailable = true;
      console.error("[Tray] 创建系统托盘失败", err);
      if (process.platform === "linux") {
        console.error("[Tray] Linux 托盘不可用。关闭窗口后进程仍驻留，提醒、cron 与 Gateway 不会随关窗退出。再次启动 MyBuddy 可恢复窗口。");
      }
    }

    // 关闭窗口 → 最小化到托盘；正在退出或未开启该行为时走正常关闭。
    // Linux 上托盘失败仍拦截关闭，避免 window-all-closed 把后台任务一起杀掉。
    win.on("close", (event) => {
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
    if (!win || win.isDestroyed()) return;
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
        const notice = new Notification({ title, body, icon: trayIconAsset() });
        this.liveNotifications.add(notice);
        notice.on("click", () => this.showMainWindow());
        notice.on("close", () => this.liveNotifications.delete(notice));
        notice.show();
        return;
      }
    } catch (error) {
      console.warn("[Tray] 原生通知失败，回退气泡", error);
    }
    try {
      this.tray?.displayBalloon({ title, content: body || title, iconType: "info" });
    } catch {
      /* desktop notification failure must never affect task execution */
    }
  }

  /** 退出前销毁托盘，避免图标残留 */
  dispose(): void {
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
      platform: process.platform,
      closeToTray: this.closeToTray,
      trayAlive: this.tray !== null,
      trayUnavailable: this.trayUnavailable,
      quitting: this.quitting,
    });
  }

  /** 首次隐藏到托盘时提示一次（跨会话持久化到 ~/.mybuddy） */
  private maybeShowHint(): void {
    if (process.platform === "win32") {
      this.maybeShowWindowsBalloon();
      return;
    }
    if (process.platform === "linux") this.maybeShowLinuxNotice();
  }

  private maybeShowWindowsBalloon(): void {
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

  private maybeShowLinuxNotice(): void {
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
        const notice = new Notification({ title: "MyBuddy", body: content, icon: trayIconAsset() });
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
