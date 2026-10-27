/**
 * 凭据后端（safeStorage）的平台装配入口。
 *
 * 平台差异只在这里判断：Linux 注入 `--password-store=gnome-libsecret`，其它平台 no-op。
 * 调用时机与迁移前一致 —— 主进程入口把本模块作为第一条 import，确保在 app ready 之前、
 * 任何 safeStorage 调用之前完成开关注入；ready 后再打印一次实际后端。
 */
import { app, safeStorage } from "electron";
import { currentPlatformId, type PlatformId } from "../index";
import {
  describeLinuxSecretStore,
  installLinuxPasswordStore,
  LINUX_PASSWORD_STORE_BACKEND,
  LINUX_PASSWORD_STORE_SWITCH,
} from "./linux";

export {
  describeLinuxSecretStore,
  installLinuxPasswordStore,
  LINUX_PASSWORD_STORE_BACKEND,
  LINUX_PASSWORD_STORE_SWITCH,
} from "./linux";

/** Node 平台名（事实字段，保持 "win32"/"darwin"/"linux" 不变）。 */
const NODE_PLATFORM: Record<PlatformId, NodeJS.Platform> = {
  windows: "win32",
  linux: "linux",
  macos: "darwin",
};

function nodePlatform(platform: PlatformId): NodeJS.Platform {
  return NODE_PLATFORM[platform];
}

type SecretStorageLike = Parameters<typeof describeLinuxSecretStore>[0];

/**
 * 在 app ready 前安装平台凭据后端开关。
 * Linux：注入 gnome-libsecret；其它平台：no-op。返回是否真的注入了开关。
 */
export function installPlatformCredentialBackend(
  commandLine: { appendSwitch(key: string, value: string): void } = app.commandLine,
  platform: PlatformId = currentPlatformId,
): boolean {
  return installLinuxPasswordStore(commandLine, nodePlatform(platform));
}

/** app ready 后打印一次实际后端；非 Linux no-op。 */
export function reportPlatformCredentialBackend(
  storage: SecretStorageLike = safeStorage,
  platform: PlatformId = currentPlatformId,
): void {
  try {
    const status = describeLinuxSecretStore(storage, nodePlatform(platform));
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
}

if (installPlatformCredentialBackend()) {
  app.whenReady().then(() => reportPlatformCredentialBackend());
}
