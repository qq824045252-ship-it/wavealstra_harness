import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMyBuddyDir } from "./paths";
// electron-vite 会把该资源 emit 到 out/main/assets 下并返回正确路径（打包后在 asar 内也可读）
import trayIconPath from "./assets/tray.ico?asset";

const HINT_FILE = "close-to-tray-hint.json";

/**
 * 系统托盘：点击关闭窗口时最小化到后台（默认开启）。
 * - 托盘左键/双击 → 恢复主窗口
 * - 托盘右键 → 菜单（显示 MyBuddy / 刷新 / 退出）
 * - 首次隐藏到托盘时弹一次系统通知提示
 */
export class TrayService {
  private tray: Tray | null = null;
  private win: BrowserWindow | null = null;
  private quitting = false;
  private closeToTray = true;
  private hintShown = false;
  private readonly liveNotifications = new Set<Notification>();
  /** 刷新前收起原生叠加层（WebContentsView），避免盖住刚重载的页面 */
  private onBeforeReload: (() => void) | null = null;

  /** 绑定主窗口：创建托盘并接管关闭行为 */
  initialize(win: BrowserWindow, options?: { onBeforeReload?: () => void }): void {
    this.win = win;
    this.onBeforeReload = options?.onBeforeReload ?? null;

    try {
      const icon = nativeImage.createFromPath(trayIconPath);
      const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
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

      // Windows/macOS：左键恢复窗口，右键弹出菜单
      tray.on("click", () => this.showMainWindow());
      tray.on("double-click", () => this.showMainWindow());
      tray.on("right-click", () => tray.popUpContextMenu(contextMenu));
      this.tray = tray;
      console.log("[Tray] 系统托盘已初始化");
    } catch (err) {
      console.error("[Tray] 创建系统托盘失败", err);
    }

    // 关闭窗口 → 最小化到托盘；正在退出或未开启该行为时走正常关闭
    win.on("close", (event) => {
      if (this.quitting || !this.closeToTray || !this.tray) return;
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

  /** window-all-closed 时是否抑制退出：仅当「关闭到托盘」开启且托盘存活时驻留后台 */
  shouldSuppressQuit(): boolean {
    return this.closeToTray && this.tray !== null;
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
        const notice = new Notification({ title, body, icon: trayIconPath });
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

  /** 首次隐藏到托盘时提示一次（跨会话持久化到 ~/.mybuddy） */
  private maybeShowHint(): void {
    if (process.platform !== "win32" || this.hintShown || !this.tray) return;
    const file = join(getMyBuddyDir(), HINT_FILE);
    try {
      if (existsSync(file)) {
        const state = JSON.parse(readFileSync(file, "utf-8")) as { shown?: boolean };
        if (state.shown) return;
      }
    } catch {
      /* 状态文件损坏则忽略，视为未提示 */
    }
    this.hintShown = true;
    try {
      this.tray.displayBalloon({
        title: "MyBuddy",
        content: "已最小化到系统托盘，点击托盘图标可恢复窗口。",
        iconType: "info",
      });
      writeFileSync(file, JSON.stringify({ shown: true }), "utf-8");
    } catch {
      /* 提示失败不影响主流程 */
    }
  }
}
