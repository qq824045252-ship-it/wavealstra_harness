/**
 * 桌面平台的中文叫法（主进程的 capability 文案与设置页共用，避免一边写「Windows 桌面」
 * 而另一边其实跑在 Linux/Wayland 上）。
 *
 * 只做字符串，不 import 任何主进程模块 —— renderer 也能用。
 */
export type DesktopPlatformId = "windows" | "linux" | "macos";

/** 归一化 `process.platform` / `window.api.platform` 到桌面平台 id。 */
export function desktopPlatformId(platform: string | undefined): DesktopPlatformId {
  if (platform === "win32" || platform === "windows") return "windows";
  if (platform === "darwin" || platform === "macos") return "macos";
  return "linux";
}

/** 「Windows 桌面」/「Linux 桌面」/「macOS 桌面」。 */
export function desktopPlatformLabel(platform: string | undefined): string {
  const id = desktopPlatformId(platform);
  return id === "windows" ? "Windows 桌面" : id === "macos" ? "macOS 桌面" : "Linux 桌面";
}

/** 「浏览器 · 应用界面 · Linux 桌面」这类组合标签。 */
export function desktopRuntimeSummary(platform: string | undefined): string {
  return `浏览器 · 应用界面 · ${desktopPlatformLabel(platform)}`;
}
