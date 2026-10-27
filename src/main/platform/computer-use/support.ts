import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { currentPlatformId, type PlatformId } from "../index";
import { resolveCulBinary } from "./linux/culBinary";

export type { PlatformId } from "../index";

/**
 * Computer Use 的平台能力边界。
 *
 * 业务服务（ComputerAutomationService / ComputerUseOverlayService）只依赖这里的探测结果，
 * 不再散落 `process.platform === "win32"`。
 *
 * - windows → `windows-uia`（进程内 UIA/SendInput/WGC 后端）
 * - linux   → `linux-cul`（computer-use-linux MCP 子进程后端；缺二进制时 supported=false
 *             并给出 `pnpm install` / 安装提示）
 * - macos   → unsupported
 */
export type ComputerUseBackendName = "windows-uia" | "linux-cul" | "unsupported";

export interface ComputerUseSupport {
  platform: PlatformId;
  backend: ComputerUseBackendName;
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
 * - linux → `linux-cul`，supported 取决于 computer-use-linux 二进制是否存在；
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
    const culBinary = resolveCulBinary({ envBin: process.env.MYBUDDY_CUL_BIN });
    if (!culBinary) {
      return {
        platform,
        backend: "linux-cul",
        supported: false,
        missingDependencies: ["computer-use-linux", ...missing],
        installHint: "pnpm install（@agent-sh/computer-use-linux 的 postinstall 会解包原生二进制）",
        reason: "没有找到 computer-use-linux 原生二进制（Linux Computer Use 后端由它提供）。",
      };
    }
    return {
      platform,
      backend: "linux-cul",
      supported: true,
      missingDependencies: missing,
      installHint: linuxInstallHint(missing),
      reason: missing.length > 0
        ? `computer-use-linux 已就位，但仍缺 ${missing.join(", ")}（缺输入/OCR 依赖时对应动作会失败，其余动作可用）。`
        : undefined,
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

/* ------------------------------------------------------------------ */
/* 工具面向模型的文案（各平台差异化，业务层不再写死 Windows）             */
/* ------------------------------------------------------------------ */

export interface ComputerUseToolCopy {
  /** 工具 label（设置页/工具列表显示）。 */
  label: string;
  /** 能力分组里的平台名（探针、设置页用）。 */
  desktopLabel: string;
  /** 面向模型的 description。 */
  description: string;
  /** 截图落盘后的结果摘要。 */
  screenshotSummary: string;
  /** 截图交给视觉模型时的提示语。 */
  visionPrompt: string;
}

const WINDOWS_BACKGROUND_NOTE = "background=true 用 PrintWindow（Chromium/Qt/Tauri 自动 WGC 窗口源）后台截图或 PostMessage 后台点击（不抢焦点，部分应用不接受）；";

const LINUX_DESCRIPTION = [
  "Linux/Wayland 桌面 Computer Use（后端 computer-use-linux：Hyprland IPC + xdg-desktop-portal 截图 + uinput/wtype 输入 + AT-SPI 无障碍树）。",
  "优先按窗口操作：list_windows 拿 window_handle → inspect_window 确认几何 → inspect_controls/find_control 找控件 → invoke_control/set_control_value；",
  "bounds 与 clientBoundsDip 是客户区 DIP，可直接用于 click_client/move_client。",
  "AT-SPI 只暴露应用根节点时（Electron/Qt/Tauri 常见）：用 screenshot_window 或 ocr_window 拿到文本行（client DIP 的 x/y/width/height）再 click_client 坐标点击；ocr_window 走本地 tesseract，无需联网。",
  "截图是 JPEG，可能等比缩放到 1600px 以内，image_scale = 物理像素/图像像素；窗口截图坐标 = 图像像素 × image_scale。",
  "Wayland 的限制（会明确报错，不要盲目重试）：没有后台截图（background=true 被拒绝，portal 只能截前台窗口）；没有 press/release 分离的鼠标/键盘事件（用 click_client/key_press 的组合键写法）；GNOME 专用的 setup_window_targeting 不可用。",
  "actions 可一次执行 1–8 个窗口输入步骤（同一窗口、顺序执行、出错即停）。type_text 对无法分类的输入框按 90 字符分块，返回 completed=false 时先观察 typedLength 再决定是否续写。",
  "焦点切换、坐标与 DPI 都由后端换算；点击前会校验目标窗口仍存在。attach_app 锁定会话后传 app_session_id 可持续操作同一窗口。",
].join("");

/**
 * 各平台 `computer_exec` 的文案。
 *
 * 抽到这里的原因：文件原先写死「Windows 原生 Computer Use」，Linux 有 backend 之后
 * 模型会照着 Windows 的 UIA/PrintWindow/WGC 术语去调用，踩空。
 */
export function computerUseToolCopy(platform: PlatformId, options: { nativeExecution?: boolean } = {}): ComputerUseToolCopy {
  if (platform === "linux") {
    return {
      label: "Computer Use（Linux）",
      desktopLabel: "Linux 桌面",
      description: LINUX_DESCRIPTION,
      screenshotSummary: "Linux 画面已保存",
      visionPrompt: "请分析这张 Linux 桌面截图，准确描述可见窗口、主要控件、文本、状态、错误提示和与当前任务相关的可交互目标及其相对位置。不要猜测不可见内容。",
    };
  }
  if (platform === "macos") {
    return {
      label: "Computer Use（macOS）",
      desktopLabel: "macOS 桌面",
      description: "macOS 没有 Computer Use 后端实现：调用会返回 unsupported。请在 macOS 上用浏览器/应用界面能力完成任务。",
      screenshotSummary: "桌面画面已保存",
      visionPrompt: "请分析这张桌面截图，准确描述可见窗口与可交互目标。不要猜测不可见内容。",
    };
  }
  const base = options.nativeExecution
    ? "Windows 原生 Computer Use。inspect_window/find/inspect 读取窗口和 UIA 控件；invoke/set/click_client/type_text 操作目标窗口。bounds/clientBoundsDip 使用客户区 DIP，screenshot_window 的 client_only 默认 true。截图返回 JPEG，可能等比缩放到 2000px 以内：image_scale 是物理像素/图像像素比例（通常为 1），窗口截图坐标 = 图像像素 × image_scale，desktop 截图仅用于观察。窗口输入会验证 HWND/PID 和焦点。type_text 返回 completed=false 时先观察 typedLength 和当前内容。capture_after 默认关闭，需要视觉确认时显式传 true。actions 可一次执行 1–8 个窗口输入步骤（同一窗口、顺序执行、出错即停），返回 steps 与最终 observation；list_windows 支持 window_title/process_id/process_name/class_name 过滤。截图按主模型能力自动选择原生多模态直读或内部 Vision 委托，不需要再手动调用 describe_image。attach_app 锁定应用后传 app_session_id 即可持续操作同一窗口（叠加框按窗口绘制）；"
    : "Windows 原生 Computer Use。优先按窗口操作：inspect_window → inspect/find UIA control → invoke/set；inspect/find 返回的 bounds/clientBoundsDip 是 click_client 可直接使用的客户区 DIP 坐标。UIA 不可用时 screenshot_window（client_only 默认 true）→ click_client。截图统一为 JPEG 并可能等比缩放到 2000px 以内：image_scale 是物理像素/图像像素比例，窗口截图的客户区坐标 = 图像像素 × image_scale（通常为 1），desktop 截图仅用于观察、legacy 桌面坐标需乘 image_scale。窗口级输入会验证 HWND/PID/前台焦点，目标变化会拒绝执行；目标化 type_text 中断会返回 completed=false 与 typedLength，禁止盲目重试。capture_after 默认关闭，只有需要视觉确认时才显式传 true（否则只做窗口集合观测）。actions 可一次执行 1–8 个窗口输入步骤（move/click/drag/scroll/key/type，同一窗口目标、顺序执行、出错即停），返回 steps、最终 observation 与可选 capture，用它替代逐个动作的多轮往返。list_windows 支持 window_title/process_id/process_name/class_name 过滤并返回精简字段；需要完整几何时用 inspect_window。任何返回截图的动作都会按主模型能力自动选择原生多模态直读或内部 Vision 委托，不需要再手动调用 describe_image。attach_app 锁定应用后传 app_session_id 即可持续操作同一窗口（叠加框按窗口绘制）；";
  return {
    label: "Windows Computer Use",
    desktopLabel: "Windows 桌面",
    description: `${base}${WINDOWS_BACKGROUND_NOTE}click_count/modifiers/hold_ms 支持双击/组合键/长按，drag 支持 steps/duration_ms，scroll_client 用 notches，paste_text 走剪贴板；批量 actions 也支持这些步骤。UIA 为空的 Electron/Qt/Tauri 应用用 ocr_window：后台截图（原生 PrintWindow / Chromium WGC）+ 本地 OCR（优先 OCR_NPU_CLI，缺省回退 Windows OCR），返回 client DIP 的文本行（x/y/width/height）供 click_client 使用。前台动作可加 restore_foreground=true，结束后把原来的前台窗口切回去。`,
    screenshotSummary: "Windows 画面已保存",
    visionPrompt: "请分析这张 Windows 界面截图，准确描述可见窗口、主要控件、文本、状态、错误提示和与当前任务相关的可交互目标及其相对位置。不要猜测不可见内容。",
  };
}
