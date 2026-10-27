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
