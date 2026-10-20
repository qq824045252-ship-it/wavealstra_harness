import { randomUUID } from "node:crypto";
import { windowsAutomationHost, type WindowsAutomationHost } from "./windows/WindowsAutomationHost";
import { windowCaptureService, type WindowCaptureService } from "./windows/WindowCaptureService";
import { computerUseRunCoordinator } from "./ComputerUseRunCoordinator";
import { planComputerUseRecovery, withRecoveryDetails, type ComputerUseRecoveryPlan } from "./ComputerUseRecoveryPolicy";
import { evaluateComputerOutcome, type ComputerOutcomeExpectation, type ComputerSemanticOutcome } from "./ComputerUseOutcome";
import {
  WindowsAutomationError,
  normalizeWindowInfo,
  type ActionObservation,
  type ControlInfo,
  type ControlSelector,
  type TargetIdentity,
  type WindowInfo,
  type HostAction,
  type HostRequestMap,
} from "./windows/windowsAutomationProtocol";

export type ComputerExecAction =
  | "status" | "active_window" | "list_windows" | "inspect_window" | "focus_window" | "wait_for_window"
  | "screenshot" | "screenshot_window" | "inspect_controls" | "find_control" | "invoke_control" | "set_control_value"
  | "move_client" | "click_client" | "drag_client" | "scroll_client"
  | "mouse_move" | "mouse_click" | "mouse_drag" | "scroll" | "key_press" | "type_text";

export const COMPUTER_BATCH_ACTIONS = [
  "move_client", "click_client", "drag_client", "scroll_client", "key_press", "type_text",
] as const;
export type ComputerBatchAction = (typeof COMPUTER_BATCH_ACTIONS)[number];

/** One window-scoped input step inside a batch; coordinates are client DIP. */
export interface ComputerBatchStep {
  action: ComputerBatchAction;
  x?: number; y?: number; x2?: number; y2?: number;
  button?: "left" | "right" | "middle";
  deltaX?: number; deltaY?: number; key?: string; text?: string;
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
  windowTitle?: string; windowHandle?: string; processId?: number; processName?: string; className?: string; screenId?: string;
  controlName?: string; automationId?: string; controlType?: string; controlRuntimeId?: string; controlClassName?: string; exactName?: boolean;
  clientOnly?: boolean; ensureForeground?: boolean; observationId?: string;
  maxDepth?: number; maxNodes?: number; timeoutMs?: number; waitState?: "visible" | "foreground" | "closed";
  observeAfter?: boolean; captureAfter?: boolean;
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
  [key: string]: unknown;
}

interface CachedObservation { id: string; window: WindowInfo; capturedAt: number }
const OBSERVATION_TTL_MS = 30_000;
const MAX_OBSERVATIONS = 64;
/** Pi re-encodes tool images above 2000px; stay below it and report the scale. */
const MAX_SCREENSHOT_EDGE = 2000;
const SCREENSHOT_JPEG_QUALITY = 70;
const BATCH_SETTLE_DEFAULT_MS = 120;
const BATCH_MAX_STEPS = 8;

function assertNotCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof WindowsAutomationError && signal.reason.code === "REQUEST_CANCELLED") throw signal.reason;
  throw new WindowsAutomationError("REQUEST_CANCELLED", "Computer Use 操作已取消");
}

async function checked<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  assertNotCancelled(signal);
  if (!signal) return operation();
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try { assertNotCancelled(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => { assertNotCancelled(signal); return operation(); }),
      interrupted,
    ]);
    assertNotCancelled(signal);
    return result;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function requireFinite(value: number | undefined, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} 必须是有限数字`);
  return Number(value);
}

function requireShort(value: string | undefined, label: string, max = 4_000): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${label} 不能为空`);
  if (normalized.length > max) throw new Error(`${label} 过长`);
  return normalized;
}

function normalizeKeyToken(token: string): string {
  const normalized = token.trim().toUpperCase();
  const aliases: Record<string, string> = {
    CTRL: "ControlKey", CONTROL: "ControlKey", SHIFT: "ShiftKey", ALT: "Menu",
    ENTER: "Enter", RETURN: "Enter", ESC: "Escape", ESCAPE: "Escape", TAB: "Tab",
    BACKSPACE: "Back", DELETE: "Delete", DEL: "Delete", SPACE: "Space", HOME: "Home", END: "End",
    PAGEUP: "PageUp", PAGEDOWN: "PageDown", UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right",
  };
  if (aliases[normalized]) return aliases[normalized];
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(normalized)) return normalized;
  if (/^[A-Z0-9]$/.test(normalized)) return normalized;
  throw new Error(`不支持的按键：${token}`);
}

function safeArtifactName(window: WindowInfo, extension = "png"): string {
  const base = window.title.trim() || window.processName || String(window.processId);
  const safe = base.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `window-${safe || window.processId}.${extension}`;
}

function compactWindowInfo(window: WindowInfo): WindowInfo {
  // The full per-window geometry is only needed by inspect_window; list_windows
  // is an enumeration and its full JSON dominated tool-result context.
  return {
    handle: window.handle,
    processId: window.processId,
    processName: window.processName,
    title: window.title,
    className: window.className,
    visible: window.visible,
    minimized: window.minimized,
    foreground: window.foreground,
    clientRect: window.clientRect,
    dpi: window.dpi,
    scaleFactor: window.scaleFactor,
  } as WindowInfo;
}

function filterWindows(windows: WindowInfo[], input: ComputerExecInput): WindowInfo[] {
  const title = input.windowTitle?.trim().toLocaleLowerCase();
  const className = input.className?.trim();
  const processName = input.processName?.trim().toLocaleLowerCase();
  const processId = Number.isInteger(input.processId) ? input.processId : undefined;
  if (!title && !className && !processName && processId === undefined) return windows;
  return windows.filter((window) =>
    (!title || window.title.toLocaleLowerCase().includes(title))
    && (!className || window.className === className)
    && (!processName || (window.processName ?? "").toLocaleLowerCase().includes(processName))
    && (processId === undefined || window.processId === processId),
  );
}

function sameCaptureGeometry(left: WindowInfo, right: WindowInfo): boolean {
  return left.handle === right.handle
    && left.processId === right.processId
    && left.dpi === right.dpi
    && left.windowRect.left === right.windowRect.left
    && left.windowRect.top === right.windowRect.top
    && left.windowRect.width === right.windowRect.width
    && left.windowRect.height === right.windowRect.height
    && left.clientOrigin.x === right.clientOrigin.x
    && left.clientOrigin.y === right.clientOrigin.y
    && left.clientRect.width === right.clientRect.width
    && left.clientRect.height === right.clientRect.height;
}

export class ComputerAutomationService {
  private readonly observations = new Map<string, CachedObservation>();

  constructor(
    private readonly host: WindowsAutomationHost = windowsAutomationHost,
    private readonly capture: WindowCaptureService = windowCaptureService,
  ) {}

  get available(): boolean { return process.platform === "win32"; }
  async shutdown(): Promise<void> { await this.host.shutdown(); }

  async execute(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    if (input.actions?.length) return this.executeBatch(input, signal);
    const action = input.action;
    if (!action) throw new Error("computer_exec 需要 action 或 actions");
    const normalized = { ...input, action } as ComputerExecInput & { action: ComputerExecAction };
    // Keep the low-level service deterministic for tests/direct callers. The
    // Agent-facing extension supplies taskId and opts into run policy/recovery/overlay.
    if (!input.taskId) return this.executeOnce(normalized, signal);
    signal = computerUseRunCoordinator.scope(input.taskId, signal);
    assertNotCancelled(signal);
    const prepared = computerUseRunCoordinator.prepare(normalized) as ComputerExecInput & { action: ComputerExecAction };
    let current = prepared;
    let attempt = 0;
    let recoveredBy: ComputerUseRecoveryPlan | undefined;
    while (true) {
      try {
        assertNotCancelled(signal);
        const output = await this.executeOnce(current, signal);
        assertNotCancelled(signal);
        output.semanticOutcome = await checked(() => this.evaluateSemanticOutcome(current, output, signal), signal);
        assertNotCancelled(signal);
        return computerUseRunCoordinator.complete(current, output, recoveredBy);
      } catch (error) {
        if (signal.aborted) {
          computerUseRunCoordinator.fail(current, signal);
          assertNotCancelled(signal);
        }
        const plan = planComputerUseRecovery(error, current, attempt);
        if (plan?.retry && plan.input) {
          recoveredBy = plan;
          computerUseRunCoordinator.recovering(current, plan);
          if (plan.delayMs) await checked(() => new Promise((resolve) => setTimeout(resolve, plan.delayMs)), signal);
          assertNotCancelled(signal);
          current = plan.input as ComputerExecInput & { action: ComputerExecAction };
          attempt += 1;
          continue;
        }
        computerUseRunCoordinator.fail(current, signal);
        throw withRecoveryDetails(error, plan, attempt);
      }
    }
  }

  private request<TAction extends HostAction, TResult = unknown>(action: TAction, params: HostRequestMap[TAction], signal?: AbortSignal, timeoutMs?: number): Promise<TResult> {
    return checked(() => this.host.request<TAction, TResult>(action, params, timeoutMs, signal), signal);
  }

  private async evaluateSemanticOutcome(input: ComputerExecInput, output: ComputerExecOutput, signal?: AbortSignal): Promise<ComputerSemanticOutcome> {
    return evaluateComputerOutcome(input.expectedOutcomes, {
      observation: output.observation,
      outputWindow: output.window,
      findControl: async (target, selector) => {
        try {
          const found = await this.request<"find_control", { window: unknown; control: ControlInfo }>(
            "find_control", { target, selector, maxDepth: input.maxDepth, maxNodes: input.maxNodes }, signal,
          );
          return found.control;
        } catch (error) {
          if (error instanceof WindowsAutomationError && error.code === "CONTROL_NOT_FOUND") return undefined;
          throw error;
        }
      },
    });
  }

  private async executeOnce(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    assertNotCancelled(signal);
    if (input.action === "status") {
      return { action: input.action, detail: this.available ? "ready (persistent Windows Automation Host + UIA + guarded SendInput)" : "unsupported platform", hostPid: this.host.pid };
    }
    if (!this.available) throw new Error("computer_exec 当前仅支持 Windows");
    if (input.action === "screenshot") return this.captureDesktop(input, signal);
    if (input.action === "active_window") {
      const window = normalizeWindowInfo(await this.request("active_window", {}, signal));
      computerUseRunCoordinator.presentTarget(input, window, "observing");
      return { action: input.action, window, observationId: this.remember(window), hostPid: this.host.pid };
    }
    if (input.action === "list_windows") {
      const raw = await this.request<"list_windows", unknown[]>("list_windows", {}, signal);
      const all = raw.map(normalizeWindowInfo);
      const filtered = filterWindows(all, input);
      // Keep the response compact: the full geometry of every window is never
      // needed for window-scoped actions and dominated the tool-result context.
      return {
        action: input.action,
        windows: filtered.map(compactWindowInfo),
        hostPid: this.host.pid,
        totalWindows: all.length,
        filtered: filtered.length !== all.length ? filtered.length : undefined,
      };
    }
    if (input.action === "inspect_window") {
      const window = await this.inspect(this.targetFromInput(input), signal);
      computerUseRunCoordinator.presentTarget(input, window, "observing");
      return { action: input.action, window, observationId: this.remember(window), hostPid: this.host.pid };
    }
    if (input.action === "focus_window") {
      const target = await this.guardedTarget(input, signal);
      computerUseRunCoordinator.presentTarget(input, await this.inspect(target, signal), "acting");
      // Focus correctness is never optional: even when callers disable normal
      // post-action observation, verify the foreground state before returning.
      const observed = await this.withObservation(target, { ...input, observeAfter: true }, () => this.request<"focus_window", Record<string, unknown>>("focus_window", { target }, signal), signal);
      const result = observed.result;
      if (observed.observation?.focusPreserved !== true) {
        throw new WindowsAutomationError("FOCUS_FAILED", "Target lost foreground focus before focus_window completed", observed.observation ?? result);
      }
      return { action: input.action, ...result, window: result.window ? normalizeWindowInfo(result.window) : undefined, observation: observed.observation, detail: "foreground verified" };
    }
    if (input.action === "wait_for_window") {
      const result = await this.request<"wait_for_window", { matched: boolean; state: string; window?: unknown }>(
        "wait_for_window",
        { target: this.targetFromInput(input), state: input.waitState, timeoutMs: input.timeoutMs },
        signal,
        Math.min(35_000, Math.max(1_000, (input.timeoutMs ?? 5_000) + 2_000)),
      );
      return { action: input.action, ...result, window: result.window ? normalizeWindowInfo(result.window) : undefined };
    }
    if (input.action === "screenshot_window") return this.captureWindow(input, signal);
    if (input.action === "inspect_controls") {
      const target = await this.guardedTarget(input, signal);
      const result = await this.request<"inspect_controls", { window: unknown; controls: ControlInfo[]; uiaAvailable: boolean; truncated: boolean; detail?: string }>(
        "inspect_controls", { target, maxDepth: input.maxDepth, maxNodes: input.maxNodes }, signal,
      );
      const window = normalizeWindowInfo(result.window);
      return { action: input.action, ...result, window, observationId: this.remember(window) };
    }
    if (input.action === "find_control") {
      const target = await this.guardedTarget(input, signal);
      const result = await this.request<"find_control", { window: unknown; control: ControlInfo }>(
        "find_control", { target, selector: this.selectorFromInput(input), maxDepth: input.maxDepth, maxNodes: input.maxNodes }, signal,
      );
      return { action: input.action, ...result, window: normalizeWindowInfo(result.window) };
    }
    if (input.action === "invoke_control" || input.action === "set_control_value") {
      const target = await this.guardedTarget(input, signal);
      const selector = this.selectorFromInput(input);
      const preview = await this.request<"find_control", { window: unknown; control: ControlInfo }>(
        "find_control", { target, selector, maxDepth: input.maxDepth, maxNodes: input.maxNodes }, signal,
      );
      const previewWindow = normalizeWindowInfo(preview.window);
      const bounds = preview.control.clientBoundsDip;
      const cursor = bounds
        ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, clicking: input.action === "invoke_control" }
        : undefined;
      computerUseRunCoordinator.presentTarget(input, previewWindow, "acting", cursor);
      const observed = await this.withObservation(target, input, () => input.action === "invoke_control"
        ? this.request("invoke_control", { target, selector }, signal)
        : this.request("set_control_value", { target, selector, value: input.text ?? "" }, signal), signal);
      return { action: input.action, ...(observed.result as object), observation: observed.observation };
    }
    if (input.action === "move_client" || input.action === "click_client" || input.action === "drag_client" || input.action === "scroll_client") {
      return this.executeClientInput(input, signal);
    }
    if (input.action === "mouse_move" || input.action === "mouse_click" || input.action === "mouse_drag" || input.action === "scroll") {
      return this.executeLegacyInput(input, signal);
    }
    if (input.action === "key_press" || input.action === "type_text") return this.executeKeyboard(input, signal);
    throw new Error(`不支持的 computer_exec action：${input.action}`);
  }

  private targetFromInput(input: ComputerExecInput, required = true): TargetIdentity {
    const target: TargetIdentity = {
      windowHandle: input.windowHandle?.trim() || undefined,
      windowTitle: input.windowTitle?.trim() || undefined,
      processId: Number.isInteger(input.processId) ? input.processId : undefined,
      className: input.className?.trim() || undefined,
    };
    if (required && !target.windowHandle && !target.windowTitle && !target.processId && !target.className) {
      throw new Error(`${input.action ?? "batch"} 需要 window_handle、window_title、process_id 或 class_name`);
    }
    return target;
  }

  private selectorFromInput(input: ComputerExecInput): ControlSelector {
    const selector: ControlSelector = {
      controlRuntimeId: input.controlRuntimeId?.trim() || undefined,
      controlName: input.controlName?.trim() || undefined,
      automationId: input.automationId?.trim() || undefined,
      controlType: input.controlType?.trim() || undefined,
      controlClassName: input.controlClassName?.trim() || undefined,
      exactName: input.exactName,
    };
    if (!selector.controlRuntimeId && !selector.controlName && !selector.automationId && !selector.controlType && !selector.controlClassName) {
      throw new Error(`${input.action} 需要 control_runtime_id、control_name、automation_id、control_type 或 control_class_name`);
    }
    return selector;
  }

  private async inspect(target: TargetIdentity, signal?: AbortSignal): Promise<WindowInfo> {
    return normalizeWindowInfo(await this.request("inspect_window", { target }, signal));
  }

  private remember(window: WindowInfo): string {
    this.pruneObservations();
    const id = randomUUID();
    this.observations.set(id, { id, window, capturedAt: Date.now() });
    while (this.observations.size > MAX_OBSERVATIONS) {
      const oldest = this.observations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.observations.delete(oldest);
    }
    return id;
  }

  private pruneObservations(): void {
    const cutoff = Date.now() - OBSERVATION_TTL_MS;
    for (const [id, observation] of this.observations) if (observation.capturedAt < cutoff) this.observations.delete(id);
  }

  private async guardedTarget(input: ComputerExecInput, signal?: AbortSignal): Promise<TargetIdentity> {
    assertNotCancelled(signal);
    this.pruneObservations();
    const requested = this.targetFromInput(input, !input.observationId);
    if (!input.observationId) {
      const current = await this.inspect(requested, signal);
      computerUseRunCoordinator.presentTarget(input, current, "observing");
      return { windowHandle: current.handle, expectedProcessId: current.processId };
    }
    const observation = this.observations.get(input.observationId);
    if (!observation) throw new WindowsAutomationError("STALE_OBSERVATION", "Observation is missing or expired", { observationId: input.observationId });
    let current: WindowInfo;
    try {
      current = await this.inspect({ windowHandle: observation.window.handle, expectedProcessId: observation.window.processId }, signal);
    } catch (error) {
      assertNotCancelled(signal);
      throw new WindowsAutomationError("STALE_OBSERVATION", "Observed window no longer has the same identity", { observation: observation.window, cause: error instanceof Error ? error.message : String(error) });
    }
    const geometryChanged = Math.abs(current.clientRect.width - observation.window.clientRect.width) > 1
      || Math.abs(current.clientRect.height - observation.window.clientRect.height) > 1;
    // A window title is mutable application state, not stable identity.
    // Keep observations valid across normal title changes (document name, progress, dirty marker).
    const identityChanged = current.handle !== observation.window.handle
      || current.processId !== observation.window.processId
      || current.className !== observation.window.className
      || current.dpi !== observation.window.dpi;
    if (identityChanged || geometryChanged) {
      throw new WindowsAutomationError("STALE_OBSERVATION", "Window identity or client size changed since observation", { observation: observation.window, current });
    }
    const selectorMismatch = (requested.windowHandle && requested.windowHandle !== current.handle)
      || (requested.processId && requested.processId !== current.processId)
      || (requested.className && requested.className !== current.className)
      || (requested.windowTitle && !current.title.toLocaleLowerCase().includes(requested.windowTitle.toLocaleLowerCase()));
    if (selectorMismatch) {
      throw new WindowsAutomationError("STALE_OBSERVATION", "Explicit window selector does not match observation", { requested, current });
    }
    computerUseRunCoordinator.presentTarget(input, current, "observing");
    return { windowHandle: current.handle, expectedProcessId: current.processId };
  }

  private async captureDesktop(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    assertNotCancelled(signal);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { desktopCapturer, screen } = require("electron") as typeof import("electron");
    const requested = input.screenId?.trim();
    const display = requested ? screen.getAllDisplays().find((item) => String(item.id) === requested) : screen.getPrimaryDisplay();
    if (!display) throw new WindowsAutomationError("CAPTURE_FAILED", "Requested display was not found", { screenId: requested });
    const width = Math.max(1, Math.round(display.size.width * display.scaleFactor));
    const height = Math.max(1, Math.round(display.size.height * display.scaleFactor));
    const sources = await checked(() => desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height }, fetchWindowIcons: false }), signal);
    const source = sources.find((item) => item.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new WindowsAutomationError("CAPTURE_FAILED", "无法捕获指定桌面截图", { displayId: display.id });
    // Keep the capture at most 2000px so Pi does not resize/re-encode it, and
    // report the exact physical-pixel scale for legacy desktop coordinates.
    const physical = source.thumbnail.getSize();
    let image = source.thumbnail;
    let imageScale = 1;
    if (physical.width > MAX_SCREENSHOT_EDGE || physical.height > MAX_SCREENSHOT_EDGE) {
      const factor = Math.min(MAX_SCREENSHOT_EDGE / physical.width, MAX_SCREENSHOT_EDGE / physical.height);
      const imageWidth = Math.max(1, Math.round(physical.width * factor));
      const imageHeight = Math.max(1, Math.round(physical.height * factor));
      image = image.resize({ width: imageWidth, height: imageHeight, quality: "best" });
      imageScale = physical.width / imageWidth;
    }
    const imageSize = image.getSize();
    return {
      action: input.action,
      screenshot: image.toJPEG(SCREENSHOT_JPEG_QUALITY),
      screenshotMimeType: "image/jpeg",
      imageScale: Math.round(imageScale * 10_000) / 10_000,
      imageSize,
      artifactFileName: "desktop-screenshot.jpg",
      detail: `screen ${display.id}: ${width}x${height} -> ${imageSize.width}x${imageSize.height} JPEG (image_scale ${Math.round(imageScale * 1000) / 1000})`,
    };
  }

  private async captureWindow(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const target = await this.guardedTarget(input, signal);
    let window: WindowInfo;
    if (input.ensureForeground !== false) {
      const focused = await this.request<"focus_window", { window: unknown }>("focus_window", { target }, signal);
      window = normalizeWindowInfo(focused.window);
    } else {
      window = await this.inspect(target, signal);
      if (!window.foreground) throw new WindowsAutomationError("FOCUS_FAILED", "screenshot_window without ensure_foreground requires the target to already be foreground", { window });
    }
    const capture = await checked(() => this.capture.capture(window, input.clientOnly ?? true), signal);
    let verifiedAfter: WindowInfo;
    try {
      verifiedAfter = await this.inspect({ windowHandle: window.handle, expectedProcessId: window.processId }, signal);
    } catch (error) {
      assertNotCancelled(signal);
      throw new WindowsAutomationError("CAPTURE_FAILED", "Target changed while capturing window", {
        window,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!verifiedAfter.foreground || !sameCaptureGeometry(window, verifiedAfter)) {
      throw new WindowsAutomationError("CAPTURE_FAILED", "Target focus or geometry changed while capturing window", {
        before: window,
        after: verifiedAfter,
      });
    }
    return {
      action: input.action, window: verifiedAfter, screenshot: capture.screenshot,
      screenshotMimeType: capture.details.mimeType, imageScale: capture.details.imageScale, imageSize: capture.details.imageSize,
      artifactFileName: safeArtifactName(verifiedAfter, "jpg"),
      capture: capture.details, observationId: this.remember(verifiedAfter), detail: "foreground identity and geometry verified before and after display crop",
    };
  }

  private async executeClientInput(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const target = await this.guardedTarget(input, signal);
    const targetWindow = await this.inspect(target, signal);
    const cursor = Number.isFinite(input.x) && Number.isFinite(input.y)
      ? { x: Number(input.x), y: Number(input.y), clicking: input.action === "click_client" || input.action === "drag_client" }
      : undefined;
    computerUseRunCoordinator.presentTarget(input, targetWindow, "acting", cursor);
    const observed = await this.withObservation(target, input, async () => {
      if (input.action === "move_client") return this.request("move_client", { target, x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y") }, signal);
      if (input.action === "click_client") return this.request("click_client", { target, x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y"), button: input.button }, signal);
      if (input.action === "drag_client") return this.request("drag_client", { target, x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y"), x2: requireFinite(input.x2, "x2"), y2: requireFinite(input.y2, "y2"), button: input.button }, signal);
      return this.request("scroll_client", { target, x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY }, signal);
    }, signal);
    return { action: input.action, ...(observed.result as object), observation: observed.observation, detail: "window-scoped guarded input" };
  }

  private async executeLegacyInput(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const cursor = input.action === "scroll"
      ? undefined
      : {
          x: Number.isFinite(input.x) ? Number(input.x) : undefined,
          y: Number.isFinite(input.y) ? Number(input.y) : undefined,
          clicking: input.action === "mouse_click" || input.action === "mouse_drag",
        };
    computerUseRunCoordinator.presentDesktop(input, "acting", cursor);
    const observed = await this.withObservation(undefined, input, async () => {
      if (input.action === "mouse_move") return this.request("mouse_move", { x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y") }, signal);
      if (input.action === "mouse_click") {
        const hasX = Number.isFinite(input.x);
        const hasY = Number.isFinite(input.y);
        if (hasX !== hasY) throw new Error("mouse_click 的 x/y 必须同时提供或同时省略");
        return this.request("mouse_click", { x: hasX ? Number(input.x) : undefined, y: hasY ? Number(input.y) : undefined, button: input.button }, signal);
      }
      if (input.action === "mouse_drag") return this.request("mouse_drag", { x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y"), x2: requireFinite(input.x2, "x2"), y2: requireFinite(input.y2, "y2"), button: input.button }, signal);
      const deltaX = Math.round(input.deltaX ?? 0); const deltaY = Math.round(input.deltaY ?? 0);
      if (!deltaX && !deltaY) throw new Error("scroll 需要非零 delta_x 或 delta_y");
      return this.request("scroll", { deltaX, deltaY }, signal);
    }, signal);
    return { action: input.action, ...(observed.result as object), observation: observed.observation, detail: "legacy desktop-coordinate fallback" };
  }

  private async executeKeyboard(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const target = input.windowHandle || input.windowTitle || input.processId || input.className || input.observationId ? await this.guardedTarget(input, signal) : undefined;
    if (target) computerUseRunCoordinator.presentTarget(input, await this.inspect(target, signal), "acting");
    const observed = await this.withObservation(target, input, async () => {
      if (input.action === "key_press") {
        const key = requireShort(input.key, "key", 120).split("+").map(normalizeKeyToken).join("+");
        return this.request("key_press", { key, target }, signal);
      }
      const text = input.text ?? "";
      if (!text) throw new Error("text 不能为空");
      if (text.length > 20_000) throw new Error("text 过长");
      return this.request("type_text", { text, target }, signal);
    }, signal);
    return { action: input.action, ...(observed.result as object), observation: observed.observation, detail: target ? "window-scoped guarded input" : "legacy foreground-targeted input" };
  }

  private async listWindows(signal?: AbortSignal): Promise<WindowInfo[]> {
    return (await this.request<"list_windows", unknown[]>("list_windows", {}, signal)).map(normalizeWindowInfo);
  }

  private buildObservation(before: WindowInfo[], targetBefore: WindowInfo | undefined, after: WindowInfo[]): ActionObservation {
    const beforeHandles = new Set(before.map((item) => item.handle));
    const afterHandles = new Set(after.map((item) => item.handle));
    const targetAfter = targetBefore ? after.find((item) => item.handle === targetBefore.handle && item.processId === targetBefore.processId) : undefined;
    return {
      targetBefore, targetAfter,
      foregroundBefore: before.find((item) => item.foreground)?.handle,
      foregroundAfter: after.find((item) => item.foreground)?.handle,
      focusPreserved: targetBefore ? Boolean(targetAfter?.foreground) : undefined,
      newWindows: after.filter((item) => !beforeHandles.has(item.handle)),
      closedWindows: before.filter((item) => !afterHandles.has(item.handle)),
    };
  }

  /** Attach an optional post-action window capture to an already-built result. */
  private async applyCapture(targetBefore: WindowInfo, after: WindowInfo[], resultRecord: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const targetAfter = after.find((item) => item.handle === targetBefore.handle && item.processId === targetBefore.processId);
    const captureFailed = (message: string, details?: unknown): void => {
      Object.assign(resultRecord, {
        captureStatus: "failed",
        captureError: { code: "CAPTURE_FAILED", message, details },
      });
    };
    if (!targetAfter) {
      captureFailed("Target closed before post-action capture", { targetBefore });
      return;
    }
    if (!targetAfter.foreground) {
      captureFailed("Target lost foreground before post-action capture", { targetAfter });
      return;
    }
    try {
      const captured = await checked(() => this.capture.capture(targetAfter, true), signal);
      const verifiedAfterCapture = await this.inspect({ windowHandle: targetAfter.handle, expectedProcessId: targetAfter.processId }, signal);
      if (!verifiedAfterCapture.foreground || !sameCaptureGeometry(targetAfter, verifiedAfterCapture)) {
        captureFailed("Target focus or geometry changed during post-action capture", {
          beforeCapture: targetAfter,
          afterCapture: verifiedAfterCapture,
        });
        return;
      }
      Object.assign(resultRecord, {
        captureStatus: "captured",
        screenshot: captured.screenshot,
        screenshotMimeType: captured.details.mimeType,
        imageScale: captured.details.imageScale,
        imageSize: captured.details.imageSize,
        artifactFileName: safeArtifactName(verifiedAfterCapture, "jpg"),
        capture: captured.details,
      });
    } catch (error) {
      assertNotCancelled(signal);
      captureFailed("Target changed or capture failed during post-action capture", {
        targetAfter,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private validateBatch(input: ComputerExecInput): ComputerBatchStep[] {
    const steps = input.actions ?? [];
    if (steps.length < 1 || steps.length > BATCH_MAX_STEPS) throw new Error(`actions 需要 1–${BATCH_MAX_STEPS} 个步骤`);
    for (const [index, step] of steps.entries()) {
      if (!COMPUTER_BATCH_ACTIONS.includes(step.action)) throw new Error(`actions[${index}] 不支持动作：${String(step.action)}`);
    }
    this.targetFromInput(input);
    return steps;
  }

  private batchStepError(error: unknown, completed: ComputerBatchStepResult[], failedIndex: number): unknown {
    const message = error instanceof Error ? error.message : String(error);
    const detail = {
      ...(error instanceof WindowsAutomationError && error.details && typeof error.details === "object"
        ? error.details as Record<string, unknown>
        : {}),
      batch: { completedSteps: completed.length, failedIndex, steps: completed },
    };
    const suffix = `（批量第 ${failedIndex + 1} 步失败，前 ${completed.length} 步已执行）`;
    if (error instanceof WindowsAutomationError) {
      return new WindowsAutomationError(error.code, `${message}${suffix}`, detail);
    }
    const wrapped = new Error(`${message}${suffix}`) as Error & { details?: unknown };
    wrapped.details = detail;
    return wrapped;
  }

  private async runBatch(input: ComputerExecInput, steps: ComputerBatchStep[], signal?: AbortSignal): Promise<ComputerExecOutput> {
    const target = this.targetFromInput(input);
    const before = await this.listWindows(signal);
    const beforeTarget = await this.inspect(target, signal);
    computerUseRunCoordinator.presentTarget(input, beforeTarget, "acting");
    const settleMs = Math.min(2_000, Math.max(0, Math.round(input.settleMs ?? BATCH_SETTLE_DEFAULT_MS)));
    const completed: ComputerBatchStepResult[] = [];
    for (const [index, step] of steps.entries()) {
      assertNotCancelled(signal);
      if (index > 0 && settleMs > 0) await checked(() => new Promise((resolve) => setTimeout(resolve, settleMs)), signal);
      const stepInput: ComputerExecInput & { action: ComputerExecAction } = {
        action: step.action,
        x: step.x, y: step.y, x2: step.x2, y2: step.y2,
        button: step.button, deltaX: step.deltaX, deltaY: step.deltaY, key: step.key, text: step.text,
        windowHandle: beforeTarget.handle,
        processId: beforeTarget.processId,
        clientOnly: true,
        observeAfter: false,
        captureAfter: false,
        taskId: input.taskId,
      };
      try {
        const result = await checked(() => this.executeOnce(stepInput, signal), signal);
        completed.push({ index, action: step.action, ok: true, detail: typeof result.detail === "string" ? result.detail : undefined });
      } catch (error) {
        completed.push({ index, action: step.action, ok: false });
        throw this.batchStepError(error, completed.filter((item) => item.ok), index);
      }
    }
    await checked(() => new Promise((resolve) => setTimeout(resolve, 150)), signal);
    const after = await this.listWindows(signal);
    const observation = this.buildObservation(before, beforeTarget, after);
    const output: ComputerExecOutput = {
      action: "batch",
      batch: { steps: completed, settleMs, completed: true },
      observation,
    };
    if (input.captureAfter) await this.applyCapture(beforeTarget, after, output as unknown as Record<string, unknown>, signal);
    return output;
  }

  private async executeBatch(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const steps = this.validateBatch(input);
    const batchInput: ComputerExecInput = { ...input, actions: steps };
    const taskId = input.taskId?.trim();
    if (!taskId) return this.runBatch(batchInput, steps, signal);
    const scoped = computerUseRunCoordinator.scope(taskId, signal);
    assertNotCancelled(scoped);
    const first = steps[0];
    const prepared = computerUseRunCoordinator.prepare({
      ...batchInput,
      action: first.action,
      observeAfter: true,
      captureAfter: input.captureAfter,
    });
    try {
      const output = await this.runBatch({ ...prepared, actions: steps }, steps, scoped);
      output.semanticOutcome = await checked(() => this.evaluateSemanticOutcome({ ...prepared, action: first.action }, output, scoped), scoped);
      return computerUseRunCoordinator.complete({ ...prepared, action: first.action }, output);
    } catch (error) {
      computerUseRunCoordinator.fail(prepared, scoped);
      throw error;
    }
  }

  private async withObservation<T>(target: TargetIdentity | undefined, input: ComputerExecInput, action: () => Promise<T>, signal?: AbortSignal): Promise<{ result: T; observation?: ActionObservation }> {
    assertNotCancelled(signal);
    if (input.captureAfter && !target) {
      throw new WindowsAutomationError("CAPTURE_FAILED", "capture_after requires a window-scoped target");
    }
    if (input.observeAfter === false && !input.captureAfter) return { result: await checked(action, signal) };
    const before = await this.listWindows(signal);
    const targetBefore = target ? await this.inspect(target, signal) : undefined;
    const result = await checked(action, signal);
    let after: WindowInfo[];
    try {
      await checked(() => new Promise((resolve) => setTimeout(resolve, 150)), signal);
      after = await this.listWindows(signal);
    } catch (error) {
      assertNotCancelled(signal);
      if (result && typeof result === "object") {
        const resultRecord = result as Record<string, unknown>;
        Object.assign(resultRecord, {
          observationStatus: "failed",
          observationError: {
            code: "POST_ACTION_OBSERVATION_FAILED",
            message: "Action completed, but post-action window observation failed",
            cause: error instanceof Error ? error.message : String(error),
          },
        });
        if (input.captureAfter) {
          Object.assign(resultRecord, {
            captureStatus: "failed",
            captureError: {
              code: "CAPTURE_FAILED",
              message: "Action completed, but capture could not be safely attempted without post-action observation",
            },
          });
        }
      }
      return { result };
    }
    const observation = this.buildObservation(before, targetBefore, after);
    if (input.captureAfter && targetBefore && result && typeof result === "object") {
      await this.applyCapture(targetBefore, after, result as Record<string, unknown>, signal);
    }
    return { result, observation };
  }
}

export const computerAutomationService = new ComputerAutomationService();
