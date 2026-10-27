/**
 * 窗口壳层的平台差异：图标格式、标题栏叠加（Windows titleBarOverlay）、
 * 任务栏/Shell 身份（Windows setAppDetails）。
 *
 * 业务入口（src/main/index.ts）只调这里，不再自己写 `process.platform` 分支。
 */
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { currentPlatformId, type PlatformId } from "./index";

export interface PlatformWindowShellOptions {
  platform?: PlatformId;
  /** Windows 用 .ico，Linux/Wayland 需要 PNG。 */
  windowsIconPath: string;
  linuxIconPath: string;
  titleBar: { color: string; symbolColor: string; height: number };
  isPackaged: boolean;
  execPath: string;
  appPath: string;
}

function resolvePlatformId(platform?: PlatformId): PlatformId {
  return platform ?? currentPlatformId;
}

function resolvedPlatform(options: PlatformWindowShellOptions): PlatformId {
  return resolvePlatformId(options.platform);
}

/** 窗口图标：Linux 用 PNG，其它平台保持 .ico。 */
export function platformWindowIconPath(options: PlatformWindowShellOptions): string {
  return resolvedPlatform(options) === "linux" ? options.linuxIconPath : options.windowsIconPath;
}

/** BrowserWindow 的平台专属构造项。目前只有 Windows 的 titleBarOverlay。 */
export function platformWindowOptions(
  options: PlatformWindowShellOptions,
): Partial<BrowserWindowConstructorOptions> {
  if (resolvedPlatform(options) !== "windows") return {};
  return {
    titleBarOverlay: {
      color: options.titleBar.color,
      symbolColor: options.titleBar.symbolColor,
      height: options.titleBar.height,
    },
  };
}

export interface PlatformTitleBarOptions {
  platform?: PlatformId;
  titleBar: { color: string; symbolColor: string; height: number };
}

/**
 * 已存在窗口的 titleBarOverlay 实时更新（主题切换）。
 * 仅 Windows；旧版 Windows 不支持时忽略。非 Windows 是 no-op。
 */
export function applyPlatformTitleBarOverlay(
  win: Pick<BrowserWindow, "setTitleBarOverlay">,
  options: PlatformTitleBarOptions,
): void {
  if (resolvePlatformId(options.platform) !== "windows") return;
  try {
    win.setTitleBarOverlay(options.titleBar);
  } catch {
    /* 旧版 Windows 不支持 titleBarOverlay */
  }
}

/**
 * Shell 任务栏身份（仅 Windows）：否则打包后的任务栏/固定项可能解析到开发态 Electron。
 * 非 Windows 是 no-op。
 */
export function applyPlatformWindowIdentity(
  win: Pick<BrowserWindow, "setAppDetails">,
  options: PlatformWindowShellOptions,
): void {
  if (resolvedPlatform(options) !== "windows") return;
  win.setAppDetails({
    appId: options.isPackaged ? "com.mybuddy.app" : "com.mybuddy.app.dev",
    appIconPath: options.isPackaged ? options.execPath : options.windowsIconPath,
    appIconIndex: 0,
    relaunchCommand: options.isPackaged
      ? `"${options.execPath}"`
      : `"${options.execPath}" "${options.appPath}"`,
    relaunchDisplayName: "MyBuddy",
  });
}
