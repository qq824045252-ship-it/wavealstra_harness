/**
 * 主进程窗口生命周期里的平台差异：关掉所有窗口是否退出、文件选择对话框的平台属性。
 *
 * 业务入口（src/main/index.ts）只调用这里，不再自己判断 `process.platform`。
 */
import { currentPlatformId, type PlatformId } from "./index";

export interface AllWindowsClosedInput {
  /** 默认当前平台。 */
  platform?: PlatformId;
  /** 托盘是否要求驻留（TrayService.shouldSuppressQuit()）。 */
  suppressQuit: boolean;
}

/**
 * window-all-closed 是否退出应用。
 * macOS：始终驻留（Dock 激活可重开窗口）；Windows/Linux：托盘不兜底时退出。
 */
export function shouldQuitOnAllWindowsClosed(input: AllWindowsClosedInput): boolean {
  const platform = input.platform ?? currentPlatformId;
  if (platform === "macos") return false;
  return !input.suppressQuit;
}

export type FolderDialogProperty = "openDirectory" | "createDirectory";

/** 打开文件夹对话框的平台属性：macOS 额外允许「新建文件夹」。 */
export function windowOpenProperties(platform: PlatformId = currentPlatformId): FolderDialogProperty[] {
  const properties: FolderDialogProperty[] = ["openDirectory"];
  if (platform === "macos") properties.push("createDirectory");
  return properties;
}
