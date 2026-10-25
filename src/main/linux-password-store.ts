import { app, safeStorage } from "electron";

/** Chromium 开关用连字符；safeStorage.getSelectedStorageBackend() 用下划线。 */
export const LINUX_PASSWORD_STORE_SWITCH = "gnome-libsecret";
export const LINUX_PASSWORD_STORE_BACKEND = "gnome_libsecret";

/**
 * Hyprland / 其它非 GNOME Wayland 会话不会被 Chromium 认成 GNOME，
 * safeStorage 会落到 basic_text 或直接不可用，Slack / API / MCP 凭据保存失败。
 * 必须在 app ready 之前、以及任何 safeStorage 调用之前执行。
 * 主进程入口要把本模块作为第一条 import。
 */
export function installLinuxPasswordStore(
  commandLine: { appendSwitch(key: string, value: string): void },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "linux") return false;
  commandLine.appendSwitch("password-store", LINUX_PASSWORD_STORE_SWITCH);
  return true;
}

/** ready 之后读一次后端，方便在 Omarchy 上确认密钥环是否真的接上。 */
export function describeLinuxSecretStore(
  storage: {
    isEncryptionAvailable(): boolean;
    getSelectedStorageBackend?: () => string;
  },
  platform: NodeJS.Platform = process.platform,
): { platform: NodeJS.Platform; backend: string; available: boolean; ready: boolean } | null {
  if (platform !== "linux") return null;
  const backend = storage.getSelectedStorageBackend?.() ?? "unknown";
  const available = storage.isEncryptionAvailable();
  return {
    platform,
    backend,
    available,
    ready: available && backend === LINUX_PASSWORD_STORE_BACKEND,
  };
}

if (installLinuxPasswordStore(app.commandLine)) {
  app.whenReady().then(() => {
    try {
      const status = describeLinuxSecretStore(safeStorage);
      if (!status) return;
      console.log(`[safeStorage] linux backend=${status.backend} available=${status.available}`);
      if (!status.ready) {
        console.warn(
          "[safeStorage] gnome-libsecret 未就绪。请安装并解锁 gnome-keyring（libsecret），否则 Slack、API 与 MCP 凭据无法保存。见 docs/omarchy-linux.md",
        );
      }
    } catch (error) {
      console.warn("[safeStorage] 无法读取 Linux 加密后端", error);
    }
  });
}
