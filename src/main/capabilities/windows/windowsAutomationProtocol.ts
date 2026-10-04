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

export interface HostRequestMap {
  active_window: Record<string, never>;
  list_windows: Record<string, never>;
  inspect_window: { target: TargetIdentity };
  focus_window: { target: TargetIdentity };
  wait_for_window: {
    target: TargetIdentity;
    state?: "visible" | "foreground" | "closed";
    timeoutMs?: number;
  };
  inspect_controls: { target: TargetIdentity; maxDepth?: number; maxNodes?: number };
  find_control: { target: TargetIdentity; selector: ControlSelector; maxDepth?: number; maxNodes?: number };
  invoke_control: { target: TargetIdentity; selector: ControlSelector };
  set_control_value: { target: TargetIdentity; selector: ControlSelector; value: string };
  move_client: { target: TargetIdentity; x: number; y: number };
  click_client: { target: TargetIdentity; x: number; y: number; button?: "left" | "right" | "middle" };
  drag_client: { target: TargetIdentity; x: number; y: number; x2: number; y2: number; button?: "left" | "right" | "middle" };
  scroll_client: { target: TargetIdentity; x?: number; y?: number; deltaX?: number; deltaY?: number };
  mouse_move: { x: number; y: number };
  mouse_click: { x?: number; y?: number; button?: "left" | "right" | "middle" };
  mouse_drag: { x: number; y: number; x2: number; y2: number; button?: "left" | "right" | "middle" };
  scroll: { deltaX?: number; deltaY?: number };
  key_press: { key: string; target?: TargetIdentity };
  type_text: { text: string; target?: TargetIdentity };
  shutdown: Record<string, never>;
}

export type HostAction = keyof HostRequestMap;

export interface WindowsAutomationRequest<T extends HostAction = HostAction> {
  id: string;
  action: T;
  params: HostRequestMap[T];
}

export interface AutomationErrorPayload {
  code: AutomationErrorCode;
  message: string;
  details?: unknown;
}

export interface WindowsAutomationResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: AutomationErrorPayload;
}

export class WindowsAutomationError extends Error {
  constructor(
    public readonly code: AutomationErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WindowsAutomationError";
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
    throw new WindowsAutomationError("POINT_OUTSIDE_CLIENT", "Client coordinates must be finite");
  }
  const xPhysical = Math.round(xDip * window.scaleFactor);
  const yPhysical = Math.round(yDip * window.scaleFactor);
  if (xPhysical < 0 || yPhysical < 0 || xPhysical >= window.clientRect.width || yPhysical >= window.clientRect.height) {
    throw new WindowsAutomationError("POINT_OUTSIDE_CLIENT", "Client point is outside the target window", {
      xDip, yDip, xPhysical, yPhysical, clientRect: window.clientRect, scaleFactor: window.scaleFactor,
    });
  }
  return { xPhysical, yPhysical };
}
