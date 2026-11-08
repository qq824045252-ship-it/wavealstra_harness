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

type CommandLineLike = { appendSwitch(key: string, value: string): void };

/**
 * 惰性取 Electron 主进程的 commandLine。
 *
 * 不能在默认参数里写 `app.commandLine`：Electron 以纯 Node 运行时（`ELECTRON_RUN_AS_NODE=1`，
 * 或直接用 node 载入本模块）`electron.app` 是 undefined，求值默认参数会抛
 * `Cannot read properties of undefined (reading 'commandLine')`，把真正的环境问题藏成 TypeError。
 */
function appCommandLine(): CommandLineLike | undefined {
  return (app as unknown as { commandLine?: CommandLineLike } | undefined)?.commandLine;
}

/** 拿不到 Chromium commandLine 时的可诊断文案（含 ELECTRON_RUN_AS_NODE 的具体修法）。 */
export function credentialCommandLineError(env: NodeJS.ProcessEnv = process.env): string {
  const runAsNode = Boolean(env.ELECTRON_RUN_AS_NODE);
  const head = `[safeStorage] 无法安装 Linux 凭据后端：当前进程拿不到 electron.app.commandLine（backend=${LINUX_PASSWORD_STORE_BACKEND}）。`;
  if (runAsNode) {
    return `${head}检测到 ELECTRON_RUN_AS_NODE=${env.ELECTRON_RUN_AS_NODE} —— Electron 被当作纯 Node 运行，主进程没有 Chromium 开关。请 unset 该变量后重启（env -u ELECTRON_RUN_AS_NODE pnpm dev）。`;
  }
  return `${head}请从 Electron 主进程启动（pnpm dev 或打包后的应用），不要用 node 直接载入主进程入口。`;
}

/**
 * 在 app ready 前安装平台凭据后端开关。
 * Linux：注入 gnome-libsecret；其它平台：no-op（不需要 commandLine）。
 * 返回是否真的注入了开关；Linux 上拿不到 commandLine 时抛出可诊断错误，而不是 TypeError。
 */
export function installPlatformCredentialBackend(
  commandLine?: CommandLineLike,
  platform: PlatformId = currentPlatformId,
): boolean {
  const node = nodePlatform(platform);
  if (node !== "linux") return false;
  const resolved = commandLine ?? appCommandLine();
  if (!resolved) throw new Error(credentialCommandLineError());
  return installLinuxPasswordStore(resolved, node);
}

/** app ready 后打印一次实际后端；非 Linux no-op。 */
export function reportPlatformCredentialBackend(
  storage?: SecretStorageLike,
  platform: PlatformId = currentPlatformId,
): void {
  try {
    const resolved = storage ?? (safeStorage as SecretStorageLike | undefined);
    if (!resolved) {
      console.warn("[safeStorage] 拿不到 electron.safeStorage（不是 Electron 主进程），跳过后端报告");
      return;
    }
    const status = describeLinuxSecretStore(resolved, nodePlatform(platform));
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
