/**
 * 主进程应用级平台初始化。
 *
 * Windows 需要 AppUserModelID（通知/任务栏身份）；其它平台是 no-op。
 * 崩溃上报的 platform 事实字段也从这里取 Node 原名，保持 "win32"/"darwin"/"linux" 不变。
 */
import { currentPlatformId, type PlatformId } from "./index";

/** 写入崩溃上报/诊断事实字段的 Node 平台名（迁移前是直接透传 process.platform）。 */
export function nodePlatformName(platform: PlatformId = currentPlatformId): NodeJS.Platform {
  switch (platform) {
    case "windows":
      return "win32";
    case "macos":
      return "darwin";
    default:
      return "linux";
  }
}

export interface SetAppUserModelIdLike {
  isPackaged: boolean;
  setAppUserModelId(id: string): void;
}

/**
 * Windows 专属：设置 AppUserModelID，否则打包后的通知/任务栏身份会解析到开发态 Electron。
 * 必须在 app ready 后调用（与迁移前一致）；其它平台 no-op。
 */
export function applyPlatformAppIdentity(
  app: SetAppUserModelIdLike,
  platform: PlatformId = currentPlatformId,
): void {
  if (platform !== "windows") return;
  app.setAppUserModelId(app.isPackaged ? "com.mybuddy.app" : "com.mybuddy.app.dev");
}

export interface CommandLineSwitchApp {
  commandLine: { appendSwitch(name: string, value?: string): void };
}

/**
 * 应用进程的命令行开关（必须在 app ready 之前调用）。
 *
 * Linux 专属：Chromium 默认只在检测到屏幕阅读器时才构建 AT-SPI 树，所以 computer_exec
 * 看不到应用自身 Electron 渲染进程里的任何控件（真机实测：Chrome/Electron 窗口
 * `inspect_controls` = 0 个节点）。加 `--force-renderer-accessibility` 才能让
 * `--enable-accessibility` 的 renderer 暴露界面；Windows 走 UIA、macOS 无后端，都不需要。
 */
export function applyPlatformCommandLineSwitches(
  app: CommandLineSwitchApp,
  platform: PlatformId = currentPlatformId,
): void {
  if (platform !== "linux") return;
  app.commandLine.appendSwitch("force-renderer-accessibility");
  // Chromium 的平台 AT-SPI 桥还有第二道闸：`AtkUtilAuraLinux::InitializeAsync()` 只认
  // GNOME_ACCESSIBILITY / ACCESSIBILITY_ENABLED / QT_ACCESSIBILITY = "1"，或 session bus 上
  // `org.a11y.Bus` 的 `org.a11y.Status.IsEnabled=true`。Hyprland 下没有 GNOME 会话去置位，
  // 这个属性实测恒为 false（at-spi2-core 仅在有 AT-SPI 监听器时才置 true），于是
  // `--force-renderer-accessibility` 只开 renderer 树、平台桥从不初始化，a11y bus 上
  // 根本看不到该进程（真机实测：Chromium/Electron 窗口 inspect_controls = 0 节点）。
  // 显式给 env 是最小配方；Chromium 在第一个窗口前读它，所以必须在 ready 前设置。
  if (process.env.GNOME_ACCESSIBILITY === undefined) process.env.GNOME_ACCESSIBILITY = "1";
}
