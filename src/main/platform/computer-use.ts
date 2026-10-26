import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { currentPlatformId, type PlatformId } from "./index";

export type { PlatformId } from "./index";

/**
 * Computer Use 的平台能力边界。
 *
 * 业务服务（ComputerAutomationService / ComputerUseOverlayService）只依赖这里的探测结果，
 * 不再散落 `process.platform === "win32"`。当前产品只有 Windows UIA 后端；Linux/macOS
 * 返回 `supported: false` 以及可诊断的缺失依赖/安装提示，供后续接 Linux 后端。
 */
export type ComputerUseBackend = "windows-uia" | "linux-wayland" | "unsupported";

export interface ComputerUseSupport {
  platform: PlatformId;
  backend: ComputerUseBackend;
  supported: boolean;
  /** 后端仍需安装的命令名（PATH 探测结果；已安装的不列出）。 */
  missingDependencies: string[];
  /** 面向用户的安装提示（pacman 命令；无缺失依赖时省略）。 */
  installHint?: string;
  /** 为什么不支持 / 当前后端状态（可诊断文案）。 */
  reason?: string;
}

/** Linux Wayland 后端需要的可执行文件（只做 PATH 扫描，不 spawn 进程）。 */
export const LINUX_COMPUTER_USE_TOOLS = [
  "hyprctl",
  "grim",
  "slurp",
  "tesseract",
  "wtype",
  "ydotool",
] as const;
export type LinuxComputerUseTool = (typeof LINUX_COMPUTER_USE_TOOLS)[number];

/** 工具 → Arch 包名映射（pacman 安装提示用）。 */
const LINUX_TOOL_PACKAGES: Record<LinuxComputerUseTool, string> = {
  hyprctl: "hyprland",
  grim: "grim",
  slurp: "slurp",
  tesseract: "tesseract",
  wtype: "wtype",
  ydotool: "ydotool",
};

/** 在给定 PATH 里找可执行文件；纯文件系统检查，不启动进程。 */
export function executableInPath(command: string, pathValue: string = process.env.PATH ?? ""): string | undefined {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory.trim()) continue;
    const candidate = join(directory.trim(), command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** PATH 探测 Linux Computer Use 依赖，返回已安装/缺失两组（测试可注入 pathValue）。 */
export function probeLinuxComputerUseTools(pathValue: string = process.env.PATH ?? ""): {
  installed: LinuxComputerUseTool[];
  missing: LinuxComputerUseTool[];
} {
  const installed: LinuxComputerUseTool[] = [];
  const missing: LinuxComputerUseTool[] = [];
  for (const tool of LINUX_COMPUTER_USE_TOOLS) {
    if (executableInPath(tool, pathValue)) installed.push(tool);
    else missing.push(tool);
  }
  return { installed, missing };
}

function linuxInstallHint(missing: readonly LinuxComputerUseTool[]): string | undefined {
  if (missing.length === 0) return undefined;
  const packages = [...new Set(missing.map((tool) => LINUX_TOOL_PACKAGES[tool]))];
  return `sudo pacman -S --needed ${packages.join(" ")}`;
}

const supportCache = new Map<PlatformId, ComputerUseSupport>();

/**
 * 探测目标平台的 Computer Use 能力（结果按平台缓存；测试可传 pathValue/refresh 绕过缓存）。
 *
 * - windows → `windows-uia`，supported=true；
 * - linux → `linux-wayland`，supported=false + 缺失依赖/安装提示（后端尚未实现）；
 * - macos → unsupported。
 */
export function detectComputerUseSupport(
  platform: PlatformId = currentPlatformId,
  options: { pathValue?: string; refresh?: boolean } = {},
): ComputerUseSupport {
  if (!options.refresh && options.pathValue === undefined) {
    const cached = supportCache.get(platform);
    if (cached) return cached;
  }

  const support = detectComputerUseSupportUncached(platform, options.pathValue);
  if (options.pathValue === undefined) supportCache.set(platform, support);
  return support;
}

function detectComputerUseSupportUncached(platform: PlatformId, pathValue?: string): ComputerUseSupport {
  if (platform === "windows") {
    return { platform, backend: "windows-uia", supported: true, missingDependencies: [] };
  }
  if (platform === "linux") {
    const { missing } = probeLinuxComputerUseTools(pathValue);
    return {
      platform,
      backend: "linux-wayland",
      supported: false,
      missingDependencies: missing,
      installHint: linuxInstallHint(missing),
      reason:
        "Linux Computer Use 后端尚未实现（当前产品只有 Windows UIA 后端）；" +
        "以上为后续 Wayland 后端所需依赖的探测结果，缺依赖时先按提示安装。",
    };
  }
  return {
    platform,
    backend: "unsupported",
    supported: false,
    missingDependencies: [],
    reason: "macOS 没有 Computer Use 后端实现（产品只提供 Windows UIA 后端）。",
  };
}

/** Computer Use 屏幕叠加层是 Windows 专属实现（WindowsGraphicsCapture + 透明分层窗口）。 */
export function supportsComputerUseOverlay(platform: PlatformId = currentPlatformId): boolean {
  return platform === "windows";
}

/** 把不支持的原因拼成给模型/用户看的可诊断文案（含安装提示）。 */
export function computerUseUnsupportedMessage(support: ComputerUseSupport): string {
  const parts: string[] = [`computer_exec 在 ${support.platform} 上不可用（backend=${support.backend}）`];
  if (support.reason) parts.push(support.reason);
  if (support.missingDependencies.length > 0) parts.push(`缺少依赖：${support.missingDependencies.join(", ")}`);
  if (support.installHint) parts.push(`安装：${support.installHint}`);
  return parts.join("；");
}
