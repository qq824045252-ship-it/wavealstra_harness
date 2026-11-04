import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { currentPlatformId, type PlatformId } from "../index";

export type { PlatformId } from "../index";

/**
 * Computer Use 的平台能力边界。
 *
 * 业务服务（ComputerAutomationService / ComputerUseOverlayService）只依赖这里的探测结果，
 * 不再散落 `process.platform === "win32"`。
 *
 * - windows → `windows-uia`（进程内 UIA/SendInput/WGC 后端）
 * - linux   → `linux-atspi`（TypeScript AT-SPI worker + Hyprland；真实能力由异步探测确认）
 * - macos   → unsupported
 */
export type ComputerUseBackendName = "windows-uia" | "linux-atspi" | "unsupported";

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
  "ydotool",
  "grim",
  "wl-copy",
] as const;
export type LinuxComputerUseTool = (typeof LINUX_COMPUTER_USE_TOOLS)[number];

/** 工具 → Arch 包名映射（pacman 安装提示用）。 */
const LINUX_TOOL_PACKAGES: Record<LinuxComputerUseTool, string> = {
  hyprctl: "hyprland",
  grim: "grim",
  ydotool: "ydotool",
  "wl-copy": "wl-clipboard",
};

/** 在给定 PATH 里找可执行文件；纯文件系统检查，不启动进程。 */
export function executableInPath(command: string, pathValue: string = process.env.PATH ?? ""): string | undefined {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory.trim()) continue;
    const candidate = join(directory.trim(), command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* An absent or non-executable PATH entry is not a capability. */ }
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
 * - linux → `linux-atspi`，这里只识别支持的会话及静态依赖，不宣称输入/总线已就绪；
 * - macos → unsupported。
 */
export function detectComputerUseSupport(
  platform: PlatformId = currentPlatformId,
  options: { pathValue?: string; refresh?: boolean; env?: NodeJS.ProcessEnv } = {},
): ComputerUseSupport {
  if (!options.refresh && options.pathValue === undefined && options.env === undefined) {
    const cached = supportCache.get(platform);
    if (cached) return cached;
  }

  const support = detectComputerUseSupportUncached(platform, options.pathValue, options.env ?? process.env);
  if (options.pathValue === undefined && options.env === undefined) supportCache.set(platform, support);
  return support;
}

function detectComputerUseSupportUncached(platform: PlatformId, pathValue: string | undefined, env: NodeJS.ProcessEnv): ComputerUseSupport {
  if (platform === "windows") {
    return { platform, backend: "windows-uia", supported: true, missingDependencies: [] };
  }
  if (platform === "linux") {
    const { missing } = probeLinuxComputerUseTools(pathValue ?? env.PATH ?? "");
    const supportedSession = Boolean(env.WAYLAND_DISPLAY && env.HYPRLAND_INSTANCE_SIGNATURE);
    return {
      platform,
      backend: "linux-atspi",
      supported: supportedSession && !missing.includes("hyprctl"),
      missingDependencies: missing,
      installHint: linuxInstallHint(missing),
      reason: !supportedSession
        ? "当前不是已支持的 Hyprland/Wayland 图形会话；需要继承 WAYLAND_DISPLAY、HYPRLAND_INSTANCE_SIGNATURE 和用户会话 D-Bus。其他 compositor 未实现，不回退到 X11。"
        : missing.includes("hyprctl")
          ? "缺少 Hyprland IPC 客户端 hyprctl，无法确认窗口身份和布局。"
          : "已识别 Hyprland/Wayland；需 refreshDiagnostics 验证会话、AT-SPI 和输入守护进程。grim 只用于显式截图，wl-copy 只用于剪贴板输入；可选能力缺失不阻断语义操作。",
    };
  }
  return {
    platform,
    backend: "unsupported",
    supported: false,
    missingDependencies: [],
    reason: "macOS 没有 Computer Use 后端实现（已实现 Windows UIA 与 Linux AT-SPI/Hyprland）。",
  };
}

/**
 * Windows 提供透明窗口叠加层与停止按钮。Linux 使用 Hyprland 阶段通知，
 * 不承诺未验证的窗口级高亮；任务取消仍由原有会话/运行协调器负责。
 */
export function supportsComputerUseOverlay(platform: PlatformId = currentPlatformId): boolean {
  return platform === "windows";
}

/**
 * 是否支持「不画外框、但能让用户看到正在操作什么」的轻量反馈。
 *
 * Windows 的完整 overlay 已涵盖它（返回 false，避免重复提示）；macOS 两者都没有。
 */
export function supportsComputerUseActivityNotice(platform: PlatformId = currentPlatformId): boolean {
  return platform === "linux";
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
  "Linux Computer Use（TypeScript + AT-SPI 无障碍总线 + Hyprland IPC；仅支持 Omarchy/Hyprland/Wayland）。",
  "先 inspect_window → inspect_controls/find_control；优先 invoke_control/set_control_value。控件引用绑定总线代次、应用对象和窗口观测，过期后重新查询。不能按标题或 PID 猜另一个窗口。",
  "只有 boundsReliable=true 的结构化边界可用于 click_client；clientBoundsDip 是客户区 DIP，Hyprland 桌面坐标是全局逻辑坐标。不得拿截图/OCR/视觉模型的位置进行自动定位，不得把全局坐标统一乘某块屏幕的缩放。边界无法验证、树未导出或目标为无接口的 Canvas 时明确报告该能力不支持。",
  "坐标输入携带 inspect_window/inspect_controls 返回的 observation_id；布局、窗口或控件变化后必须重新观察。移动光标会回读 compositor 的实际位置；输入前重新验证窗口身份和前台焦点。",
  "mouse_down_client/key_down 的按住状态跨调用保留，显式 mouse_up_client/key_up 或任务结束/取消才释放。click_count/modifiers/hold_ms、scroll_client 的 notches 和带 steps/duration_ms 的 drag 均有实际输入语义。",
  "文本优先 set_control_value；type_text/paste_text 保留明确键盘/剪贴板行为并支持中文与 Unicode。completed=false 或结果未知时先回读 typedLength/当前内容，不得重放整段文本。",
  "actions 可执行 1–8 个同目标顺序步骤，出错即停并返回已完成步骤；禁止重复整个部分完成的批次。attach_app 返回 app_session_id，供后续操作锁定同一窗口。",
  "executed 仅证明指令发出；verified 需要相关文本/状态回读或 expected_outcomes 的明确成功条件。超时/取消不能证明远端动作已撤销。",
  "screenshot/screenshot_window 是独立、显式观察，capture_after 默认关闭；截图失败不影响输入/语义就绪，也不撤销已执行动作。显式截图只能用于观察，不能接入目标定位。无 Linux OCR 自动回退。",
  "status 是轻量缓存；异步检查分别报告 accessibility、semantic、bounds、window、pointer、keyboard、screenshot 的能力与时间。操作时用 Hyprland 通知反馈阶段，通过现有任务停止入口取消。",
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
      visionPrompt: "请仅描述这张 Linux 桌面截图中的可见窗口、文本、状态和错误提示，不猜测不可见内容。截图是独立观察，禁止据此生成输入坐标或选择操作目标；操作目标必须来自 AT-SPI 或其他结构化应用接口。",
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
    description: `${base}控件树是结构化 JSON（非 XML）；优先 inspect_controls/find_control → invoke_control/set_control_value，UIA 不可用再 OCR/视觉坐标。坐标动作应携带本次截图的 observation_id；过期必须重新观察。action 与 actions 严格互斥。phase=executed 只证明动作执行，目标达成需要 expected_outcomes 或重新读取界面；窗口仍在前台不等于保存/提交成功。${WINDOWS_BACKGROUND_NOTE}click_count/modifiers/hold_ms 支持双击/组合键/长按，drag 支持 steps/duration_ms，scroll_client 用 notches，paste_text 走剪贴板；批量 actions 也支持这些步骤。UIA 为空的 Electron/Qt/Tauri 应用用 ocr_window：后台截图（原生 PrintWindow / Chromium WGC）+ 本地 OCR（优先 OCR_NPU_CLI，缺省回退 Windows OCR），返回 client DIP 的文本行（x/y/width/height）供 click_client 使用。前台动作可加 restore_foreground=true，结束后把原来的前台窗口切回去。`,
    screenshotSummary: "Windows 画面已保存",
    visionPrompt: "请分析这张 Windows 界面截图，准确描述可见窗口、主要控件、文本、状态、错误提示和与当前任务相关的可交互目标及其相对位置。不要猜测不可见内容。",
  };
}
