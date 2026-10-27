/**
 * computer-use-linux（CUL）协议适配层：把 CUL MCP 返回的 JSON 映射成 MyBuddy 的
 * Computer Use DTO（`WindowInfo` / `ControlInfo` / `OcrLine`），并做输入键名与坐标换算。
 *
 * 这里全部是纯函数（不 spawn 进程、不读环境），便于 headless 测试；真正调用 MCP 的
 * 是 `CulMcpClient`，动作分发在 `LinuxComputerUseBackend`。
 */
import {
  ComputerUseError,
  type ClientRect,
  type ControlInfo,
  type ControlSelector,
  type OcrLine,
  type Point,
  type Rect,
  type WindowInfo,
} from "../protocol";

/* ------------------------------------------------------------------ */
/* CUL 原始 JSON                                                       */
/* ------------------------------------------------------------------ */

/** `list_windows` / `focused_window` 返回的窗口（Hyprland backend）。 */
export interface CulWindow {
  window_id?: number | string;
  title?: string | null;
  app_id?: string | null;
  wm_class?: string | null;
  pid?: number | null;
  bounds?: { x?: number; y?: number; width?: number; height?: number } | null;
  focused?: boolean | null;
  hidden?: boolean | null;
  client_type?: string | null;
  workspace?: number | null;
}

/** CUL 的 AT-SPI 节点（`get_app_state` / `include_tree`）。 */
export interface CulAccessibilityNode {
  index?: number;
  role?: string | null;
  name?: string | null;
  description?: string | null;
  text?: string | null;
  value?: string | null;
  states?: string[] | null;
  actions?: Array<{ name?: string | null; description?: string | null; keybinding?: string | null }> | null;
  bounds?: { x?: number; y?: number; width?: number; height?: number } | null;
  object_ref?: string | null;
  depth?: number | null;
  child_count?: number | null;
  supports_editable_text?: boolean | null;
}

function finite(value: unknown, fallback = 0): number {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function rect(left: number, top: number, width: number, height: number): Rect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/* ------------------------------------------------------------------ */
/* 显示器与坐标                                                        */
/* ------------------------------------------------------------------ */

/** `hyprctl -j monitors` 里我们关心的字段。 */
export interface CulMonitor {
  name: string;
  /** 逻辑布局坐标（多显示器时相邻屏偏移在这里）。 */
  layoutX: number;
  layoutY: number;
  /** 物理像素尺寸（hyprctl 报的就是面板分辨率）。 */
  physicalWidth: number;
  physicalHeight: number;
  scale: number;
}

/**
 * 解析 `hyprctl -j monitors` JSON。
 *
 * Hyprland 的 monitor `width/height` 是**物理像素**，`x/y` 是**逻辑布局坐标**，
 * `scale` 是缩放。换算成物理布局矩形：`physicalX = x * scale`。
 */
export function parseMonitors(input: unknown): CulMonitor[] {
  const list = Array.isArray(input) ? input : [];
  return list.map((item) => {
    const monitor = (item ?? {}) as Record<string, unknown>;
    const scale = Number(monitor.scale);
    return {
      name: String(monitor.name ?? ""),
      layoutX: finite(monitor.x),
      layoutY: finite(monitor.y),
      physicalWidth: Math.max(0, finite(monitor.width)),
      physicalHeight: Math.max(0, finite(monitor.height)),
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    };
  }).filter((monitor) => monitor.physicalWidth > 0 && monitor.physicalHeight > 0);
}

/** 显示器在**物理**桌面像素空间里的矩形。 */
export function monitorPhysicalRect(monitor: CulMonitor): Rect {
  const left = Math.round(monitor.layoutX * monitor.scale);
  const top = Math.round(monitor.layoutY * monitor.scale);
  return rect(left, top, monitor.physicalWidth, monitor.physicalHeight);
}

/** 按窗口（**物理**像素）中心点命中显示器；命不中就回落到原点屏/第一块屏。 */
export function monitorScaleFor(
  physicalBounds: { left: number; top: number; width: number; height: number },
  monitors: readonly CulMonitor[],
): number {
  const centerX = physicalBounds.left + physicalBounds.width / 2;
  const centerY = physicalBounds.top + physicalBounds.height / 2;
  const containing = monitors.find((monitor) => {
    const area = monitorPhysicalRect(monitor);
    return centerX >= area.left && centerX < area.right && centerY >= area.top && centerY < area.bottom;
  });
  const fallback = monitors.find((monitor) => monitor.layoutX === 0 && monitor.layoutY === 0) ?? monitors[0];
  const scale = (containing ?? fallback)?.scale;
  return Number.isFinite(scale) && (scale ?? 0) > 0 ? Number(scale) : 1;
}

/** DIP（逻辑像素）→ 物理像素。 */
export function physicalFromDip(dip: number, scaleFactor: number): number {
  return Math.round(dip * (Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1));
}

/** 物理像素 → DIP（逻辑像素），保留小数（OCR 行坐标需要亚像素精度）。 */
export function dipFromPhysical(physical: number, scaleFactor: number): number {
  return physical / (Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1);
}

/**
 * CUL 窗口 → `WindowInfo`。
 *
 * CUL（Hyprland backend）返回的 `bounds` 已经是**物理**桌面像素
 * （实测：逻辑 1326×852 @1.6 → 2122×1364），因此不再乘缩放。
 * Wayland 没有 Windows 那种「窗口矩形 vs 客户区」装饰差分，client = window。
 */
export function toWindowInfo(window: CulWindow, monitors: readonly CulMonitor[] = []): WindowInfo {
  const physicalRect = rect(
    finite(window.bounds?.x),
    finite(window.bounds?.y),
    Math.max(0, finite(window.bounds?.width)),
    Math.max(0, finite(window.bounds?.height)),
  );
  const scaleFactor = monitorScaleFor(physicalRect, monitors);
  const clientRect: ClientRect = { x: 0, y: 0, width: physicalRect.width, height: physicalRect.height };
  const clientOrigin: Point = { x: physicalRect.left, y: physicalRect.top };
  return {
    handle: String(window.window_id ?? "0"),
    processId: finite(window.pid),
    processName: (window.app_id ?? window.wm_class ?? undefined) || undefined,
    title: String(window.title ?? ""),
    className: (window.wm_class ?? window.app_id ?? undefined) || undefined,
    visible: window.hidden !== true,
    minimized: false,
    foreground: window.focused === true,
    windowRect: physicalRect,
    clientRect,
    clientOrigin,
    dpi: Math.round(96 * scaleFactor),
    scaleFactor,
  };
}

/** list_windows 的精简输出（只保留选择目标需要的字段，几何仍带，便于一次调用就能算坐标）。 */
export function compactWindowInfo(window: WindowInfo): WindowInfo {
  return {
    handle: window.handle,
    processId: window.processId,
    processName: window.processName,
    title: window.title,
    className: window.className,
    visible: window.visible,
    minimized: window.minimized,
    foreground: window.foreground,
    windowRect: window.windowRect,
    clientRect: window.clientRect,
    clientOrigin: window.clientOrigin,
    dpi: window.dpi,
    scaleFactor: window.scaleFactor,
  };
}

/** 按 window_title/process_id/process_name/class_name 过滤（与 Windows backend 语义一致）。 */
export function filterWindows(
  windows: WindowInfo[],
  input: { windowTitle?: string; className?: string; processName?: string; processId?: number },
): WindowInfo[] {
  const title = input.windowTitle?.trim().toLocaleLowerCase();
  const className = input.className?.trim();
  const processName = input.processName?.trim().toLocaleLowerCase();
  const processId = Number.isInteger(input.processId) ? input.processId : undefined;
  if (!title && !className && !processName && processId === undefined) return windows;
  return windows.filter((window) =>
    (!title || window.title.toLocaleLowerCase().includes(title))
    && (!className || window.className === className)
    && (!processName || (window.processName ?? "").toLocaleLowerCase().includes(processName))
    && (processId === undefined || window.processId === processId));
}

/**
 * client DIP → 屏幕物理像素（CUL 的 click/drag/scroll `x/y` 就是这个空间）。
 *
 * 实测（Hyprland 1.6x）CUL 的坐标参数直接是物理屏幕像素：`{x:320,y:480}` 落在
 * 逻辑 `200,300`。因此这里只做 DIP×scale + 窗口物理原点，不再二次缩放。
 */
export function clientDipToScreenPhysical(window: WindowInfo, xDip: number, yDip: number): Point {
  return {
    x: window.clientOrigin.x + physicalFromDip(xDip, window.scaleFactor),
    y: window.clientOrigin.y + physicalFromDip(yDip, window.scaleFactor),
  };
}

/**
 * 图像像素 → client DIP 的换算系数。
 *
 * CUL 截图会等比缩放：`scale` = 图像像素 / 物理像素，`imageScale` = 1/scale。
 * 窗口截图裁剪到窗口，所以物理像素减去窗口原点就是客户区物理像素。
 */
export function dipPerImagePixel(imageScale: number, scaleFactor: number): number {
  const safeImageScale = Number.isFinite(imageScale) && imageScale > 0 ? imageScale : 1;
  return dipFromPhysical(safeImageScale, scaleFactor);
}

/** 从 CUL 截图 META 里取物理/图像比例（`scale` 缺省视为 1）。 */
export function imageScaleFromMeta(meta: { scale?: unknown } & Record<string, unknown>): number {
  const scale = Number(meta.scale);
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Number((1 / scale).toFixed(4));
}

/**
 * AT-SPI 的 bounds 原点是否整体不可信。
 *
 * 真机实测（Hyprland 0.56.2 / eDP-1 2160x1440 @1.6，2026-10-27）：
 * GTK3（zenity 对话框）与 GTK4（Nautilus 主窗）返回的每个节点都是
 * `bounds.x = bounds.y = 0`，只有宽高是真的 —— 于是 `clientBoundsDip` 全部堆在客户区
 * 左上角，模型照着点会稳定点到窗口边角。CUL 自己的 README 也写明
 * 「GTK3 HiDPI extents / GTK4 zero-origin bounds」不可靠，所以它对元素点击优先走
 * 原生 AT-SPI action（`perform_action` / `set_value`）。
 *
 * 判定：同一个窗口里 ≥3 个有尺寸的节点，原点**全部**是 (0,0) → 该窗口的 bounds 不能
 * 用于坐标点击。窗口根节点单独为 (0,0) 是正常的（client 原点就是 0,0），所以要求 ≥3。
 */
export function controlBoundsAreZeroOrigin(nodes: ControlInfo[]): boolean {
  const sized = nodes.filter((node) => {
    const bounds = node.clientBoundsDip;
    return bounds !== undefined && (bounds.width > 0 || bounds.height > 0);
  });
  if (sized.length < 3) return false;
  return sized.every((node) => node.clientBoundsDip!.x === 0 && node.clientBoundsDip!.y === 0);
}

/**
 * 清掉不可信的控件坐标（保留控件本身：`runtimeId` / `name` / `role` / `patterns` 仍然有效，
 * `invoke_control` / `set_control_value` 走的是 AT-SPI 元素下标，不需要坐标）。
 * 保留 width/height 只会诱导模型按「(0,0) + 尺寸」点击，所以整块 bounds 一起摘掉。
 */
export function stripUnreliableControlBounds(nodes: ControlInfo[]): ControlInfo[] {
  return nodes.map((node) => {
    if (!node.clientBoundsDip) return node;
    return {
      ...node,
      clientBoundsDip: undefined,
      screenBoundsPhysical: undefined,
      bounds: undefined,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 按键名                                                              */
/* ------------------------------------------------------------------ */

/** MyBuddy/Windows 风格按键别名 → CUL（hyprctl/ydotool/wtype）接受的键名。 */
const CUL_KEY_ALIASES: Record<string, string> = {
  CTRL: "Ctrl", CONTROL: "Ctrl", SHIFT: "Shift", ALT: "Alt", ALTGR: "AltGr",
  WIN: "Super", LWIN: "Super", RWIN: "Super", META: "Super", SUPER: "Super", CMD: "Super", COMMAND: "Super",
  ENTER: "Return", RETURN: "Return", ESC: "Escape", ESCAPE: "Escape", TAB: "Tab",
  BACKSPACE: "BackSpace", DELETE: "Delete", DEL: "Delete", SPACE: "space",
  HOME: "Home", END: "End", PAGEUP: "Page_Up", PAGEDOWN: "Page_Down",
  UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right",
  INSERT: "Insert", INS: "Insert", PRINTSCREEN: "Print", PRTSC: "Print",
  CAPSLOCK: "Caps_Lock", NUMLOCK: "Num_Lock", SCROLLLOCK: "Scroll_Lock",
  APPS: "Menu", CONTEXTMENU: "Menu", PAUSE: "Pause",
  MEDIAPLAYPAUSE: "XF86AudioPlay", MEDIASTOP: "XF86AudioStop",
  MEDIANEXT: "XF86AudioNext", MEDIAPREV: "XF86AudioPrev",
  VOLUMEUP: "XF86AudioRaiseVolume", VOLUMEDOWN: "XF86AudioLowerVolume", VOLUMEMUTE: "XF86AudioMute",
};

const ARROW_ALIASES: Record<string, string> = { UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right" };

/**
 * 把单个键（或 `Ctrl+Shift+T` 这样的组合）规范化成 CUL `press_key` 的 `key` 参数。
 *
 * CUL 的 `press_key` 接受 `Enter` / `Escape` / `Tab` / `ArrowLeft` / `Super` /
 * `Ctrl+L` / 单个 US 字母数字，这里同时兼容 Windows 侧的 `ControlKey` / `Escape`
 * 写法，避免模型换个写法就失败。
 */
export function toCulKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("key 不能为空");
  const chordParts = trimmed.split("+").map((part) => part.trim()).filter(Boolean);
  const mapped = chordParts.map((part) => toCulKeyToken(part));
  return mapped.join("+");
}

function toCulKeyToken(token: string): string {
  const upper = token.toUpperCase();
  if (CUL_KEY_ALIASES[upper]) return CUL_KEY_ALIASES[upper];
  // Windows 侧 UIA 键名（ControlKey/ShiftKey/Menu/LWin…）直接映射
  if (upper === "CONTROLKEY") return "Ctrl";
  if (upper === "SHIFTKEY") return "Shift";
  if (upper === "MENU") return "Alt";
  if (upper === "LWIN" || upper === "RWIN") return "Super";
  // CUL 的 press_key 文档写 ArrowLeft，底层（hyprctl/ydotool）用 Left
  if (/^ARROW(UP|DOWN|LEFT|RIGHT)$/.test(upper)) return ARROW_ALIASES[upper.slice(5)];
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(upper)) return upper;
  if (/^[A-Z0-9]$/.test(upper)) return upper;
  if (/^[A-Z][A-Z0-9_ -]*$/.test(upper) && token.length <= 24) return token;
  throw new Error(`不支持的按键：${token}`);
}

/** 修饰键（Computer Use 协议）→ CUL 键名。 */
export function toCulModifiers(modifiers?: readonly string[]): string[] {
  return (modifiers ?? []).map((modifier) => CUL_KEY_ALIASES[modifier.toUpperCase()] ?? modifier);
}

/* ------------------------------------------------------------------ */
/* AT-SPI 控件                                                         */
/* ------------------------------------------------------------------ */

/**
 * CUL AT-SPI 节点 → `ControlInfo`。
 *
 * `bounds` 是逻辑（client DIP）坐标；协议要求 `clientBoundsDip`，因此原样透传，
 * `screenBoundsPhysical` 用窗口物理原点 + DIP×scale 折算。
 */
export function toControlInfo(node: CulAccessibilityNode, window?: WindowInfo): ControlInfo {
  const role = String(node.role ?? "unknown");
  const name = node.name ?? undefined;
  const bounds = node.bounds;
  const dip = bounds
    ? {
      x: finite(bounds.x),
      y: finite(bounds.y),
      width: Math.max(0, finite(bounds.width)),
      height: Math.max(0, finite(bounds.height)),
    }
    : undefined;
  const scaleFactor = window?.scaleFactor ?? 1;
  const states = node.states ?? [];
  return {
    runtimeId: String(node.object_ref ?? node.index ?? role),
    automationId: node.object_ref ?? undefined,
    name,
    controlType: role,
    className: role,
    frameworkId: "at-spi2",
    enabled: !states.includes("disabled") && !states.includes("sensitive-false"),
    offscreen: states.includes("defunct") || states.includes("showing") === false,
    keyboardFocusable: states.includes("focusable") || states.includes("sensitive"),
    hasKeyboardFocus: states.includes("focused"),
    screenBoundsPhysical: dip && window
      ? {
        left: window.clientOrigin.x + physicalFromDip(dip.x, scaleFactor),
        top: window.clientOrigin.y + physicalFromDip(dip.y, scaleFactor),
        width: physicalFromDip(dip.width, scaleFactor),
        height: physicalFromDip(dip.height, scaleFactor),
      }
      : undefined,
    clientBoundsDip: dip,
    bounds: dip ? { left: dip.x, top: dip.y, width: dip.width, height: dip.height } : undefined,
    patterns: (node.actions ?? []).map((action) => String(action.name ?? "")).filter(Boolean),
    depth: node.depth ?? undefined,
  };
}

/** 按 selector 匹配控件（name/role/automation_id，支持 exactName）。 */
export function matchesSelector(control: ControlInfo, selector: ControlSelector): boolean {
  if (selector.controlRuntimeId && control.runtimeId !== selector.controlRuntimeId) return false;
  if (selector.automationId && control.automationId !== selector.automationId) return false;
  if (selector.controlType && control.controlType.toLocaleLowerCase() !== selector.controlType.toLocaleLowerCase()) return false;
  if (selector.controlClassName && (control.className ?? "").toLocaleLowerCase() !== selector.controlClassName.toLocaleLowerCase()) return false;
  if (selector.controlName) {
    const actual = control.name ?? "";
    if (selector.exactName) {
      if (actual !== selector.controlName) return false;
    } else if (!actual.toLocaleLowerCase().includes(selector.controlName.toLocaleLowerCase())) return false;
  }
  return true;
}

/** 在控件的 parentIndex 关系里找候选（`find_control` 用；返回第一个匹配）。 */
export function findControl(controls: readonly ControlInfo[], selector: ControlSelector, options: { maxDepth?: number } = {}): ControlInfo | undefined {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  return controls.find((control) => (control.depth ?? 0) <= maxDepth && matchesSelector(control, selector));
}

/* ------------------------------------------------------------------ */
/* OCR（tesseract TSV）                                                */
/* ------------------------------------------------------------------ */

/** CJK 字符（含全角标点）——tesseract 会把每个字切成一个 word，拼接时不能再加空格。 */
const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * 把同一行的 OCR word 拼回整行文本。
 *
 * 中文被 tesseract 逐字切成 word，`join(" ")` 会得到「十 新 建 任 务」这种
 * 带空格的串，模型拿它去 find_control / 匹配界面文本时永远对不上，
 * 所以中日韩字符之间不加分隔，其余仍按空格。
 */
export function joinOcrWords(words: readonly string[]): string {
  let text = "";
  for (const word of words) {
    if (!word) continue;
    if (!text) {
      text = word;
      continue;
    }
    const previous = text[text.length - 1];
    const next = word[0];
    const needsSpace = !(CJK_CHAR.test(previous) && CJK_CHAR.test(next));
    text = needsSpace ? `${text} ${word}` : `${text}${word}`;
  }
  return text;
}

/**
 * 解析 `tesseract … tsv` 输出为 `OcrLine`（client DIP）。
 *
 * TSV 列：level page_num block_num par_num line_num word_num left top width height conf text。
 * 按行（block/par/line）聚合成整行文本，`conf` 取该行词置信度均值（0-100 → 0-1）。
 * 图像像素 → DIP 的比例由调用方给出（截图可能被等比缩放）。
 */
export function parseTesseractTsv(
  tsv: string,
  options: { dipPerImagePixelX: number; dipPerImagePixelY?: number; minScore?: number; maxLines?: number },
): OcrLine[] {
  const scaleX = options.dipPerImagePixelX > 0 ? options.dipPerImagePixelX : 1;
  const scaleY = options.dipPerImagePixelY ?? scaleX;
  const minScore = options.minScore ?? 0;
  const maxLines = options.maxLines ?? 200;
  interface Bucket { key: string; words: string[]; left: number; top: number; right: number; bottom: number; confSum: number; count: number }
  const buckets = new Map<string, Bucket>();
  for (const rawLine of tsv.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const columns = rawLine.split("\t");
    if (columns.length < 12) continue;
    const level = Number(columns[0]);
    if (level !== 5) continue; // 5 = word
    const text = columns.slice(11).join("\t").trim();
    if (!text) continue;
    const conf = Number(columns[10]);
    const left = finite(columns[6]);
    const top = finite(columns[7]);
    const width = finite(columns[8]);
    const height = finite(columns[9]);
    const key = `${columns[1]}/${columns[2]}/${columns[3]}/${columns[4]}`;
    const bucket = buckets.get(key) ?? { key, words: [], left, top, right: left + width, bottom: top + height, confSum: 0, count: 0 };
    bucket.words.push(text);
    bucket.left = Math.min(bucket.left, left);
    bucket.top = Math.min(bucket.top, top);
    bucket.right = Math.max(bucket.right, left + width);
    bucket.bottom = Math.max(bucket.bottom, top + height);
    bucket.confSum += Number.isFinite(conf) ? conf : 0;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((bucket) => {
      const score = bucket.count ? bucket.confSum / bucket.count / 100 : 0;
      const x = bucket.left * scaleX;
      const y = bucket.top * scaleY;
      return {
        text: joinOcrWords(bucket.words),
        score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
        x: Number(x.toFixed(2)),
        y: Number(y.toFixed(2)),
        width: Number(((bucket.right - bucket.left) * scaleX).toFixed(2)),
        height: Number(((bucket.bottom - bucket.top) * scaleY).toFixed(2)),
      } satisfies OcrLine;
    })
    .filter((line) => line.score >= minScore)
    .slice(0, maxLines);
}

/* ------------------------------------------------------------------ */
/* 错误映射                                                            */
/* ------------------------------------------------------------------ */

/**
 * CUL `ok=false` 的 message → 协议错误码。
 *
 * CUL 没有结构化错误码，这里只按它稳定出现的措辞归类；归类不了的一律
 * `HOST_PROTOCOL_ERROR`（可诊断，不假装成功）。
 */
export function culFailureCode(tool: string, message: string): "WINDOW_NOT_FOUND" | "WINDOW_AMBIGUOUS" | "WINDOW_NOT_VISIBLE" | "CONTROL_NOT_FOUND" | "CAPTURE_FAILED" | "FOCUS_FAILED" | "OCR_UNAVAILABLE" | "POINT_OUTSIDE_CLIENT" | "HOST_PROTOCOL_ERROR" {
  const text = message.toLocaleLowerCase();
  if (/ambiguous/.test(text)) return "WINDOW_AMBIGUOUS";
  if (/no window|window not found|not found.*window|no matching window/.test(text)) return "WINDOW_NOT_FOUND";
  if (/hidden|not visible|minimi[sz]ed/.test(text)) return "WINDOW_NOT_VISIBLE";
  if (/unsupported action|no cached accessibility node|element_index/.test(text)) return "CONTROL_NOT_FOUND";
  if (/focus/.test(text)) return "FOCUS_FAILED";
  if (/screenshot|capture|portal/.test(text)) return "CAPTURE_FAILED";
  if (/ocr/.test(text)) return "OCR_UNAVAILABLE";
  if (/outside|out of bounds/.test(text)) return "POINT_OUTSIDE_CLIENT";
  if (tool === "screenshot" || tool === "get_app_state") return "CAPTURE_FAILED";
  return "HOST_PROTOCOL_ERROR";
}

export function culFailure(tool: string, message: string): ComputerUseError {
  return new ComputerUseError(culFailureCode(tool, message), `computer-use-linux ${tool} 失败：${message}`);
}

/* ------------------------------------------------------------------ */
/* 工具名                                                              */
/* ------------------------------------------------------------------ */

/** 本 backend 用到的 CUL MCP 工具名（拼错会直接报错，所以集中常量）。 */
export const CUL_TOOLS = {
  listWindows: "list_windows",
  focusedWindow: "focused_window",
  listApps: "list_apps",
  screenshot: "screenshot",
  getAppState: "get_app_state",
  activateWindow: "activate_window",
  click: "click",
  drag: "drag",
  scroll: "scroll",
  pressKey: "press_key",
  typeText: "type_text",
  performAction: "perform_action",
  setValue: "set_value",
  moveWindow: "move_window",
  resizeWindow: "resize_window",
  doctor: "doctor",
  getTreePage: "get_tree_page",
} as const;
