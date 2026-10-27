/**
 * Computer Use 跨平台协议层。
 *
 * 这里只放「业务/入口可依赖」的 DTO 与动作枚举：窗口/控件/观察、动作集合、
 * 执行输入输出、OCR 结果。Windows 专属的 host 请求/响应协议留在
 * `windows/windowsAutomationProtocol.ts`（本文件通过 re-export 提供共享 DTO）。
 */
import type { PlatformId } from "../index";

export const WINDOWS_AUTOMATION_ERROR_CODES = [
  "WINDOW_NOT_FOUND",
  "WINDOW_AMBIGUOUS",
  "TARGET_CHANGED",
  "WINDOW_NOT_VISIBLE",
  "FOCUS_FAILED",
  "STALE_OBSERVATION",
  "CONTROL_NOT_FOUND",
  "CONTROL_AMBIGUOUS",
  "CONTROL_NOT_ACTIONABLE",
  "CAPTURE_FAILED",
  "CAPTURE_SPANS_MULTIPLE_DISPLAYS",
  "POINT_OUTSIDE_CLIENT",
  "OCR_UNAVAILABLE",
  "WAIT_TIMEOUT",
  "HOST_UNAVAILABLE",
  "HOST_PROTOCOL_ERROR",
  "REQUEST_TIMEOUT",
  "REQUEST_CANCELLED",
] as const;

export type AutomationErrorCode = (typeof WINDOWS_AUTOMATION_ERROR_CODES)[number];

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ClientRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  handle: string;
  processId: number;
  processName?: string;
  title: string;
  className?: string;
  visible: boolean;
  minimized: boolean;
  foreground: boolean;
  /** Physical screen pixels. Negative origins are valid on multi-monitor desktops. */
  windowRect: Rect;
  /** Physical client pixels; client input is converted from DIP using scaleFactor. */
  clientRect: ClientRect;
  /** Physical screen pixel origin of client (0,0). */
  clientOrigin: Point;
  dpi: number;
  scaleFactor: number;
  monitorHandle?: string;
  monitorRect?: Rect;
}

export interface ControlInfo {
  runtimeId: string;
  automationId?: string;
  name?: string;
  controlType: string;
  className?: string;
  frameworkId?: string;
  enabled: boolean;
  offscreen: boolean;
  keyboardFocusable: boolean;
  hasKeyboardFocus: boolean;
  /** Raw UIA bounding rectangle in physical screen pixels. */
  screenBoundsPhysical?: { left: number; top: number; width: number; height: number };
  /** Same control rectangle normalized to the target window client-area DIP coordinate space. */
  clientBoundsDip?: { x: number; y: number; width: number; height: number };
  /** Backward-compatible alias for clientBoundsDip. */
  bounds?: { left: number; top: number; width: number; height: number };
  patterns: string[];
  depth?: number;
}

export interface TargetIdentity {
  windowHandle?: string;
  windowTitle?: string;
  processId?: number;
  className?: string;
  expectedProcessId?: number;
}

export interface ControlSelector {
  controlRuntimeId?: string;
  controlName?: string;
  automationId?: string;
  controlType?: string;
  controlClassName?: string;
  exactName?: boolean;
}

export interface ActionObservation {
  targetBefore?: WindowInfo;
  targetAfter?: WindowInfo;
  foregroundBefore?: string;
  foregroundAfter?: string;
  focusPreserved?: boolean;
  newWindows?: WindowInfo[];
  closedWindows?: WindowInfo[];
}

export class ComputerUseError extends Error {
  constructor(
    public readonly code: AutomationErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ComputerUseError";
  }
}

export function normalizeWindowInfo(input: unknown): WindowInfo {
  const value = (input ?? {}) as Partial<WindowInfo>;
  const rect = (value.windowRect ?? {}) as Partial<Rect>;
  const client = (value.clientRect ?? {}) as Partial<ClientRect>;
  const origin = (value.clientOrigin ?? {}) as Partial<Point>;
  const monitor = value.monitorRect as Partial<Rect> | undefined;
  const number = (candidate: unknown, fallback = 0): number => Number.isFinite(Number(candidate)) ? Number(candidate) : fallback;
  const normalizedRect = (candidate: Partial<Rect>): Rect => {
    const left = number(candidate.left);
    const top = number(candidate.top);
    const right = number(candidate.right, left + number(candidate.width));
    const bottom = number(candidate.bottom, top + number(candidate.height));
    return { left, top, right, bottom, width: number(candidate.width, right - left), height: number(candidate.height, bottom - top) };
  };
  return {
    handle: String(value.handle ?? "0"),
    processId: number(value.processId),
    processName: value.processName ? String(value.processName) : undefined,
    title: String(value.title ?? ""),
    className: value.className ? String(value.className) : undefined,
    visible: Boolean(value.visible),
    minimized: Boolean(value.minimized),
    foreground: Boolean(value.foreground),
    windowRect: normalizedRect(rect),
    clientRect: { x: number(client.x), y: number(client.y), width: number(client.width), height: number(client.height) },
    clientOrigin: { x: number(origin.x), y: number(origin.y) },
    dpi: number(value.dpi, 96),
    scaleFactor: number(value.scaleFactor, 1),
    monitorHandle: value.monitorHandle ? String(value.monitorHandle) : undefined,
    monitorRect: monitor ? normalizedRect(monitor) : undefined,
  };
}

export function validateClientPoint(window: WindowInfo, xDip: number, yDip: number): { xPhysical: number; yPhysical: number } {
  if (!Number.isFinite(xDip) || !Number.isFinite(yDip)) {
    throw new ComputerUseError("POINT_OUTSIDE_CLIENT", "Client coordinates must be finite");
  }
  const xPhysical = Math.round(xDip * window.scaleFactor);
  const yPhysical = Math.round(yDip * window.scaleFactor);
  if (xPhysical < 0 || yPhysical < 0 || xPhysical >= window.clientRect.width || yPhysical >= window.clientRect.height) {
    throw new ComputerUseError("POINT_OUTSIDE_CLIENT", "Client point is outside the target window", {
      xDip, yDip, xPhysical, yPhysical, clientRect: window.clientRect, scaleFactor: window.scaleFactor,
    });
  }
  return { xPhysical, yPhysical };
}

/** 兼容旧名字（Windows backend / 历史测试仍按这个名字 import）。 */
export { ComputerUseError as WindowsAutomationError };

export type ComputerExecAction =
  | "attach_app"
  | "status" | "active_window" | "list_windows" | "inspect_window" | "focus_window" | "wait_for_window"
  | "screenshot" | "screenshot_window" | "ocr_window" | "inspect_controls" | "find_control" | "invoke_control" | "set_control_value"
  | "move_client" | "click_client" | "drag_client" | "scroll_client"
  | "mouse_down_client" | "mouse_up_client" | "key_down" | "key_up" | "paste_text" | "drag_screen"
  | "move_window" | "resize_window"
  | "mouse_move" | "mouse_click" | "mouse_drag" | "scroll" | "key_press" | "type_text";

export const COMPUTER_BATCH_ACTIONS = [
  "move_client", "click_client", "drag_client", "scroll_client",
  "mouse_down_client", "mouse_up_client", "key_down", "key_up", "key_press", "type_text", "paste_text",
] as const;
export type ComputerBatchAction = (typeof COMPUTER_BATCH_ACTIONS)[number];

export type ComputerModifier = "ctrl" | "shift" | "alt" | "win";

/** One window-scoped input step inside a batch; coordinates are client DIP. */
export interface ComputerBatchStep {
  action: ComputerBatchAction;
  x?: number; y?: number; x2?: number; y2?: number;
  button?: "left" | "right" | "middle";
  deltaX?: number; deltaY?: number; key?: string; text?: string;
  clickCount?: number; holdMs?: number; steps?: number; durationMs?: number; notches?: number;
  modifiers?: ComputerModifier[]; background?: boolean;
}

export interface AppSessionInfo {
  id: string;
  window: WindowInfo;
  attachedAt: number;
  lastSeenAt: number;
}

export interface OcrLine {
  text: string;
  score: number;
  /** Client-area DIP rectangle (same coordinate system as click_client). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrResultInfo {
  provider: string;
  totalLines: number;
  ms: number;
}

export interface CapturedImage {
  screenshot: Uint8Array;
  details: {
    displayId: string;
    scaleFactor: number;
    captureRectPhysical: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    captureMode: "foreground-display-crop" | "background-printwindow" | "window-source";
    coordinateSpace: "client-dip-aligned-pixels" | "window-dip-aligned-pixels";
    mimeType: "image/jpeg";
    imageScale: number;
    imageSize: { width: number; height: number };
    windowRect: WindowInfo["windowRect"];
  };
}

export interface ComputerBatchStepResult {
  index: number;
  action: ComputerBatchAction;
  ok: boolean;
  detail?: string;
}

export interface ComputerBatchResult {
  steps: ComputerBatchStepResult[];
  settleMs: number;
  completed: boolean;
}

export type ComputerOutcomeKind =
  | "target_present"
  | "target_closed"
  | "target_foreground"
  | "new_window"
  | "control_present"
  | "control_absent";

export interface ComputerOutcomeExpectation {
  kind: ComputerOutcomeKind;
  windowTitleContains?: string;
  controlName?: string;
  automationId?: string;
  controlType?: string;
  controlRuntimeId?: string;
  controlClassName?: string;
  exactName?: boolean;
}

export interface ComputerOutcomeCheckResult {
  kind: ComputerOutcomeKind;
  status: "passed" | "failed" | "not_evaluable";
  evidence: string;
}

export interface ComputerSemanticOutcome {
  status: "passed" | "failed" | "not_evaluable" | "not_requested";
  checks: ComputerOutcomeCheckResult[];
}

export interface ComputerExecInput {
  action?: ComputerExecAction;
  /** Agent-facing batched window input; when present, `action` is optional. */
  actions?: ComputerBatchStep[];
  /** Delay between batch steps (default 120ms, 0-2000). */
  settleMs?: number;
  /** Internal Agent run identity; intentionally not exposed in the tool schema. */
  taskId?: string;
  x?: number; y?: number; x2?: number; y2?: number;
  button?: "left" | "right" | "middle";
  deltaX?: number; deltaY?: number; key?: string; text?: string;
  /** 1-3 clicks at the same point (double/triple click). */
  clickCount?: number;
  /** Modifier keys held down around the click (ctrl/shift/alt/win). */
  modifiers?: ComputerModifier[];
  /** Press-and-hold duration for click_client (0-5000ms). */
  holdMs?: number;
  /** Post input messages without stealing focus (works only for apps that accept posted messages). */
  background?: boolean;
  /** Drag interpolation steps (1-60). */
  steps?: number;
  /** Drag duration in milliseconds (0-10000). */
  durationMs?: number;
  /** Wheel notches for scroll_client (positive=up, negative=down). */
  notches?: number;
  /** Stable app session created by attach_app; replaces per-action window selectors. */
  appSessionId?: string;
  /** ocr_window: maximum returned text lines (1-200, default 80). */
  maxLines?: number;
  /** Put the previously focused window back after the action (courtesy restore). */
  restoreForeground?: boolean;
  /** ocr_window: minimum OCR confidence (0-1, default 0.5). */
  minScore?: number;
  windowTitle?: string; windowHandle?: string; processId?: number; processName?: string; className?: string; screenId?: string;
  controlName?: string; automationId?: string; controlType?: string; controlRuntimeId?: string; controlClassName?: string; exactName?: boolean;
  clientOnly?: boolean; ensureForeground?: boolean; observationId?: string;
  maxDepth?: number; maxNodes?: number; timeoutMs?: number; waitState?: "visible" | "foreground" | "closed";
  observeAfter?: boolean; captureAfter?: boolean;
  /** move_window: 目标窗口 frame 左上角的桌面坐标（逻辑/布局像素，与 hyprctl clients 同域）。 */
  windowX?: number;
  windowY?: number;
  /** resize_window: 目标窗口 frame 的宽高（逻辑/布局像素）。 */
  windowWidth?: number;
  windowHeight?: number;
  /** Explicit semantic postconditions for Agent-facing Observe -> Act -> Verify. */
  expectedOutcomes?: ComputerOutcomeExpectation[];
}

export interface ComputerExecOutput {
  action: ComputerExecAction | "batch";
  detail?: string;
  windows?: WindowInfo[];
  window?: WindowInfo;
  control?: ControlInfo;
  controls?: ControlInfo[];
  uiaAvailable?: boolean;
  truncated?: boolean;
  screenshot?: Uint8Array;
  screenshotMimeType?: "image/jpeg" | "image/png";
  /** Physical pixels per returned image pixel; 1 when the capture is not downscaled. */
  imageScale?: number;
  imageSize?: { width: number; height: number };
  artifactFileName?: string;
  observationId?: string;
  observation?: ActionObservation;
  hostPid?: number;
  semanticOutcome?: ComputerSemanticOutcome;
  batch?: ComputerBatchResult;
  appSessionId?: string;
  appSession?: AppSessionInfo;
  lines?: OcrLine[];
  lineCount?: number;
  ocr?: OcrResultInfo;
  /** status: 平台能力探测结果（Windows/Linux/macOS 通用）。 */
  platform?: PlatformId;
  backend?: string;
  supported?: boolean;
  missingDependencies?: string[];
  installHint?: string;
  reason?: string;
  [key: string]: unknown;
}

