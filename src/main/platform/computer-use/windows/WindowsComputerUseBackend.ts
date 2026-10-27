import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { NativeImage } from "electron";
import { windowsAutomationHost, type WindowsAutomationHost } from "./WindowsAutomationHost";
import { windowCaptureService, type WindowCaptureService } from "./WindowCaptureService";
import { computerUseRunCoordinator } from "../../../capabilities/ComputerUseRunCoordinator";
import { planComputerUseRecovery, withRecoveryDetails, type ComputerUseRecoveryPlan } from "../../../capabilities/ComputerUseRecoveryPolicy";
import { evaluateComputerOutcome, type ComputerOutcomeExpectation, type ComputerSemanticOutcome } from "../../../capabilities/ComputerUseOutcome";
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
} from "./windowsAutomationProtocol";
import type { ComputerUseBackend, ComputerUseStatus } from "../backend";
import {
  COMPUTER_BATCH_ACTIONS,
  type AppSessionInfo,
  type CapturedImage,
  type ComputerBatchAction,
  type ComputerBatchResult,
  type ComputerBatchStep,
  type ComputerBatchStepResult,
  type ComputerExecAction,
  type ComputerExecInput,
  type ComputerExecOutput,
  type ComputerModifier,
  type OcrLine,
  type OcrResultInfo,
} from "../protocol";
import { ocrSearchCandidates, resolveOcrProvider } from "../ocr";

interface CachedObservation { id: string; window: WindowInfo; capturedAt: number }
const OBSERVATION_TTL_MS = 30_000;
const MAX_OBSERVATIONS = 64;
/** Pi re-encodes tool images above 2000px; stay below it and report the scale. */
const MAX_SCREENSHOT_EDGE = 2000;
const SCREENSHOT_JPEG_QUALITY = 70;
const BATCH_SETTLE_DEFAULT_MS = 120;
const BATCH_MAX_STEPS = 8;
const APP_SESSION_TTL_MS = 10 * 60_000;
const MAX_APP_SESSIONS = 8;
const MODIFIER_VK: Record<ComputerModifier, number> = { ctrl: 0x11, shift: 0x10, alt: 0x12, win: 0x5b };
const OCR_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

function parseWindowsOcrOutput(stdout: string): OcrRawText[] {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("[") && !line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const entries = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ text?: unknown; score?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown }>;
      return entries
        .filter((item) => typeof item.text === "string" && item.text.trim())
        .map((item) => {
          const x = Number(item.x) || 0, y = Number(item.y) || 0;
          const width = Number(item.width) || 0, height = Number(item.height) || 0;
          return {
            text: String(item.text),
            score: Number.isFinite(Number(item.score)) ? Number(item.score) : 1,
            box: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]] as Array<[number, number]>,
          };
        });
    } catch { /* keep scanning */ }
  }
  throw new WindowsAutomationError("OCR_UNAVAILABLE", "Windows OCR 输出无法解析");
}

interface OcrRawText { text: string; score: number; box: Array<[number, number]> }

function flattenOcrJson(payload: unknown): OcrRawText[] {
  const pages = (payload as { pages?: unknown })?.pages;
  if (!Array.isArray(pages)) return [];
  const lines: OcrRawText[] = [];
  for (const page of pages) {
    const texts = (page as { texts?: unknown })?.texts;
    if (!Array.isArray(texts)) continue;
    for (const entry of texts) {
      const item = entry as { text?: unknown; score?: unknown; box?: unknown };
      if (typeof item.text !== "string" || !item.text.trim()) continue;
      const box = Array.isArray(item.box)
        ? (item.box as unknown[]).filter((point): point is [number, number] => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))).map((point) => [Number(point[0]), Number(point[1])] as [number, number])
        : [];
      lines.push({ text: item.text, score: Number.isFinite(Number(item.score)) ? Number(item.score) : 1, box });
    }
  }
  return lines;
}

function parseOcrOutput(stdout: string, outputDir: string, imagePath: string): OcrRawText[] {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    try {
      const parsed = JSON.parse(lines[index]);
      const flat = flattenOcrJson(parsed);
      if (flat.length) return flat;
    } catch { /* keep scanning */ }
  }
  const stem = basename(imagePath).replace(/\.[^.]+$/, "");
  const file = join(outputDir, `${stem}_ocr.json`);
  if (existsSync(file)) {
    try { return flattenOcrJson(JSON.parse(readFileSync(file, "utf8"))); } catch { /* fall through */ }
  }
  throw new WindowsAutomationError("OCR_UNAVAILABLE", "OCR 输出无法解析");
}

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
    WIN: "LWin", LWIN: "LWin", RWIN: "RWin", INSERT: "Insert", INS: "Insert",
    PRINTSCREEN: "PrintScreen", PRTSC: "PrintScreen", SNAPSHOT: "Snapshot", PAUSE: "Pause",
    CAPSLOCK: "CapsLock", NUMLOCK: "NumLock", SCROLLLOCK: "Scroll", APPS: "Apps", CONTEXTMENU: "Apps",
    MEDIAPLAYPAUSE: "MediaPlayPause", MEDIASTOP: "MediaStop", MEDIANEXT: "MediaNextTrack", MEDIAPREV: "MediaPreviousTrack",
    VOLUMEUP: "VolumeUp", VOLUMEDOWN: "VolumeDown", VOLUMEMUTE: "VolumeMute",
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

function isBlankBitmap(bitmap: Buffer): boolean {
  if (bitmap.length < 4) return true;
  const offsets = [0, Math.floor(bitmap.length / 8 / 4) * 4, Math.floor(bitmap.length / 2 / 4) * 4, Math.floor((bitmap.length * 3) / 4 / 4) * 4, bitmap.length - 4];
  return offsets.every((offset) => bitmap[offset] === 0 && bitmap[offset + 1] === 0 && bitmap[offset + 2] === 0);
}

/**
 * Some apps (notably Chromium/Electron web content) return only their native
 * frame from PrintWindow, with a uniform surface below it. Reject such frames
 * so callers fall back to the foreground display crop instead of trusting a
 * contentless screenshot.
 */
function assertCaptureHasContent(bitmap: Buffer, size: { width: number; height: number }, topSkip = 0): void {
  if (size.width < 16 || size.height < topSkip + 16) return;
  const stride = size.width * 4;
  let min = 255;
  let max = 0;
  // Scan the whole frame sparsely: thin text lines are missed by a 64-point grid.
  for (let index = topSkip * stride; index + 3 < bitmap.length; index += 97 * 4) {
    const value = Math.max(bitmap[index], bitmap[index + 1], bitmap[index + 2]);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (max - min < 12) {
    throw new WindowsAutomationError("CAPTURE_FAILED", "Background capture returned a contentless frame (this app draws through a surface PrintWindow cannot read); use foreground capture instead", { size, channelRange: max - min });
  }
}

function modifierVks(modifiers?: ComputerModifier[]): number[] {
  return (modifiers ?? []).map((modifier) => MODIFIER_VK[modifier]).filter((value) => Number.isFinite(value));
}

async function withCaptureTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WindowsAutomationError("CAPTURE_FAILED", message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

export class WindowsComputerUseBackend implements ComputerUseBackend {
  readonly platform = "windows" as const;
  readonly backend = "windows-uia" as const;

  private readonly observations = new Map<string, CachedObservation>();
  private readonly appSessions = new Map<string, AppSessionInfo>();

  constructor(
    private readonly host: WindowsAutomationHost = windowsAutomationHost,
    private readonly capture: WindowCaptureService = windowCaptureService,
  ) {}

  /** Windows backend 的平台能力恒定可用；host 是否真能启动由 execute 的错误报出。 */
  get available(): boolean { return true; }

  status(): ComputerUseStatus {
    return {
      platform: this.platform,
      backend: this.backend,
      supported: true,
      missingDependencies: [],
      detail: "ready (windows-uia: persistent Windows Automation Host + UIA + guarded SendInput)",
      hostPid: this.host.pid,
    };
  }

  async shutdown(): Promise<void> { await this.host.shutdown(); }

  async execute(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    // Optional courtesy restore: actions must focus their target, but the user's
    // previous foreground window is put back afterwards so the desktop is not
    // left on the automation target.
    const restoreHandle = input.restoreForeground === true ? await this.foregroundHandle(signal) : undefined;
    let outcome: ComputerExecOutput | undefined;
    try {
      outcome = await this.executeCore(input, signal);
      return outcome;
    } finally {
      if (restoreHandle) {
        // Let the action's overlay/focus settle, then put the user's window back
        // through the normal verified focus path.
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          await this.executeOnce({ action: "focus_window", windowHandle: restoreHandle } as ComputerExecInput & { action: ComputerExecAction }, undefined);
        } catch (error) {
          if (outcome) (outcome as { restoreError?: string }).restoreError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }

  private async executeCore(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
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

  private async foregroundHandle(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const active = await this.request<"active_window", WindowInfo>("active_window", {}, signal, 5_000);
      return active?.handle;
    } catch {
      return undefined;
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
    if (input.action === "status") return { action: input.action, ...this.status() };
    if (input.action === "attach_app") return this.attachApp(input, signal);
    if (input.action === "screenshot") return this.captureDesktop(input, signal);
    if (input.action === "ocr_window") return this.ocrWindow(input, signal);
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
    if (input.action === "move_client" || input.action === "click_client" || input.action === "drag_client" || input.action === "scroll_client"
      || input.action === "mouse_down_client" || input.action === "mouse_up_client") {
      return this.executeClientInput(input, signal);
    }
    if (input.action === "drag_screen") return this.executeDragScreen(input, signal);
    if (input.action === "paste_text") return this.executePaste(input, signal);
    if (input.action === "mouse_move" || input.action === "mouse_click" || input.action === "mouse_drag" || input.action === "scroll") {
      return this.executeLegacyInput(input, signal);
    }
    if (input.action === "key_press" || input.action === "type_text" || input.action === "key_down" || input.action === "key_up") return this.executeKeyboard(input, signal);
    throw new Error(`不支持的 computer_exec action：${input.action}`);
  }

  private targetFromInput(input: ComputerExecInput, required = true): TargetIdentity {
    const sessionId = input.appSessionId?.trim();
    if (sessionId) {
      const session = this.appSessions.get(sessionId);
      if (!session) {
        throw new WindowsAutomationError("STALE_OBSERVATION", "App session is missing or expired; call attach_app again", { appSessionId: sessionId });
      }
      session.lastSeenAt = Date.now();
      return { windowHandle: session.window.handle, expectedProcessId: session.window.processId };
    }
    const target: TargetIdentity = {
      windowHandle: input.windowHandle?.trim() || undefined,
      windowTitle: input.windowTitle?.trim() || undefined,
      processId: Number.isInteger(input.processId) ? input.processId : undefined,
      className: input.className?.trim() || undefined,
    };
    if (required && !target.windowHandle && !target.windowTitle && !target.processId && !target.className) {
      throw new Error(`${input.action ?? "batch"} 需要 app_session_id、window_handle、window_title、process_id 或 class_name`);
    }
    return target;
  }

  private pruneAppSessions(): void {
    const cutoff = Date.now() - APP_SESSION_TTL_MS;
    for (const [id, session] of this.appSessions) if (session.lastSeenAt < cutoff) this.appSessions.delete(id);
    while (this.appSessions.size > MAX_APP_SESSIONS) {
      const oldest = [...this.appSessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (!oldest) break;
      this.appSessions.delete(oldest.id);
    }
  }

  private async attachApp(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    this.pruneAppSessions();
    const target = this.targetFromInput({ ...input, appSessionId: undefined });
    const window = await this.inspect(target, signal);
    const session: AppSessionInfo = { id: randomUUID(), window, attachedAt: Date.now(), lastSeenAt: Date.now() };
    this.appSessions.set(session.id, session);
    this.pruneAppSessions();
    computerUseRunCoordinator.presentTarget(input, window, "observing");
    return {
      action: input.action,
      appSessionId: session.id,
      appSession: session,
      window,
      observationId: this.remember(window),
      detail: "app session attached; pass app_session_id to keep operating this window",
    };
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
    const sources = await checked(() => withCaptureTimeout(desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height }, fetchWindowIcons: false }), 8_000, "Display capture enumeration timed out"), signal);
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
    if (input.background) {
      const window = await this.inspect(target, signal);
      if (!window.visible || window.minimized) {
        throw new WindowsAutomationError("WINDOW_NOT_VISIBLE", "Background capture requires a visible, non-minimized window", { window });
      }
      const capture = await this.captureBackground(window, input.clientOnly ?? true, signal);
      const verifiedAfter = await this.inspect({ windowHandle: window.handle, expectedProcessId: window.processId }, signal);
      if (!sameCaptureGeometry(window, verifiedAfter)) {
        throw new WindowsAutomationError("CAPTURE_FAILED", "Target geometry changed while capturing in background", { before: window, after: verifiedAfter });
      }
      return {
        action: input.action, window: verifiedAfter, screenshot: capture.screenshot,
        screenshotMimeType: capture.details.mimeType, imageScale: capture.details.imageScale, imageSize: capture.details.imageSize,
        artifactFileName: safeArtifactName(verifiedAfter, "jpg"),
        capture: capture.details, observationId: this.remember(verifiedAfter),
        detail: "background PrintWindow capture (no focus change)",
      };
    }
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

  private finalizeCapturedImage(image: NativeImage, window: WindowInfo, clientOnly: boolean, captureMode: "background-printwindow" | "window-source"): CapturedImage {
    const targetWidth = clientOnly ? window.clientRect.width : window.windowRect.width;
    const targetHeight = clientOnly ? window.clientRect.height : window.windowRect.height;
    const dipWidth = Math.max(1, Math.round(targetWidth / window.scaleFactor));
    const dipHeight = Math.max(1, Math.round(targetHeight / window.scaleFactor));
    if (image.getSize().width !== dipWidth || image.getSize().height !== dipHeight) {
      image = image.resize({ width: dipWidth, height: dipHeight, quality: "best" });
    }
    const dipSize = image.getSize();
    let imageScale = 1;
    if (dipSize.width > MAX_SCREENSHOT_EDGE || dipSize.height > MAX_SCREENSHOT_EDGE) {
      const factor = Math.min(MAX_SCREENSHOT_EDGE / dipSize.width, MAX_SCREENSHOT_EDGE / dipSize.height);
      const width = Math.max(1, Math.round(dipSize.width * factor));
      const height = Math.max(1, Math.round(dipSize.height * factor));
      image = image.resize({ width, height, quality: "best" });
      imageScale = dipSize.width / width;
    }
    const imageSize = image.getSize();
    // WGC (window-source) reads composited surfaces reliably; only PrintWindow
    // frames need the content check that triggers the WGC fallback.
    if (captureMode === "background-printwindow") assertCaptureHasContent(image.toBitmap(), imageSize);
    const captureRectPhysical = clientOnly
      ? {
          left: window.clientOrigin.x,
          top: window.clientOrigin.y,
          right: window.clientOrigin.x + window.clientRect.width,
          bottom: window.clientOrigin.y + window.clientRect.height,
          width: window.clientRect.width,
          height: window.clientRect.height,
        }
      : window.windowRect;
    return {
      screenshot: image.toJPEG(SCREENSHOT_JPEG_QUALITY),
      details: {
        displayId: window.monitorHandle ?? "0",
        scaleFactor: window.scaleFactor,
        captureRectPhysical,
        captureMode,
        coordinateSpace: clientOnly ? "client-dip-aligned-pixels" : "window-dip-aligned-pixels",
        mimeType: "image/jpeg",
        imageScale: Math.round(imageScale * 10_000) / 10_000,
        imageSize,
        windowRect: window.windowRect,
      },
    };
  }

  /**
   * Windows Graphics Capture path (via Electron's window sources). Unlike
   * PrintWindow it reads Chromium/Qt/Tauri composited surfaces, so it is the
   * fallback for those windows and for any PrintWindow frame without content.
   */
  private async captureWindowSource(window: WindowInfo, clientOnly: boolean, signal?: AbortSignal): Promise<CapturedImage> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { desktopCapturer } = require("electron") as typeof import("electron");
    const physicalWidth = Math.max(1, window.windowRect.width);
    const physicalHeight = Math.max(1, window.windowRect.height);
    const sources = await checked(() => withCaptureTimeout(desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: physicalWidth, height: physicalHeight },
      fetchWindowIcons: false,
    }), 8_000, "Window-source enumeration timed out"), signal);
    const prefix = `window:${window.handle}:`;
    const title = window.title.trim();
    const source = sources.find((item) => item.id.startsWith(prefix))
      ?? (title.length >= 2 ? sources.find((item) => item.name.trim() === title) : undefined)
      ?? (title.length >= 3 ? sources.find((item) => item.name.includes(title)) : undefined);
    if (!source || source.thumbnail.isEmpty()) {
      throw new WindowsAutomationError("CAPTURE_FAILED", "Window-source capture is unavailable for this window", {
        window, candidates: sources.map((item) => item.name).slice(0, 20),
      });
    }
    let image = source.thumbnail;
    const raw = image.getSize();
    if (raw.width !== physicalWidth || raw.height !== physicalHeight) {
      image = image.resize({ width: physicalWidth, height: physicalHeight, quality: "best" });
    }
    if (clientOnly) {
      const offsetX = Math.max(0, window.clientOrigin.x - window.windowRect.left);
      const offsetY = Math.max(0, window.clientOrigin.y - window.windowRect.top);
      image = image.crop({
        x: offsetX,
        y: offsetY,
        width: Math.min(window.clientRect.width, physicalWidth - offsetX),
        height: Math.min(window.clientRect.height, physicalHeight - offsetY),
      });
    }
    return this.finalizeCapturedImage(image, window, clientOnly, "window-source");
  }

  /**
   * Captures a visible window without changing foreground focus. Native apps
   * use PrintWindow; Chromium/Qt/Tauri surfaces (and contentless PrintWindow
   * frames) fall back to the window-source capture.
   */
  private async captureBackground(window: WindowInfo, clientOnly: boolean, signal?: AbortSignal): Promise<CapturedImage> {
    const path = join(tmpdir(), `mybuddy-cu-${randomUUID()}.png`);
    const chromiumLike = /chrome_widgetwin|tauri window|qt\d*qwindow/i.test(window.className ?? "");
    if (chromiumLike) return this.captureWindowSource(window, clientOnly, signal);
    try {
      await this.request("capture_window_background", {
        target: { windowHandle: window.handle, expectedProcessId: window.processId },
        path,
      }, signal, 15_000);
      const bytes = await readFile(path);
      if (bytes.byteLength === 0) throw new WindowsAutomationError("CAPTURE_FAILED", "Background capture produced an empty file", { window });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { nativeImage } = require("electron") as typeof import("electron");
      let image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new WindowsAutomationError("CAPTURE_FAILED", "Background capture could not be decoded", { window });
      if (isBlankBitmap(image.toBitmap())) {
        throw new WindowsAutomationError("CAPTURE_FAILED", "Background capture returned a blank frame", { window });
      }
      const raw = image.getSize();
      if (raw.width !== window.windowRect.width || raw.height !== window.windowRect.height) {
        image = image.resize({ width: window.windowRect.width, height: window.windowRect.height, quality: "best" });
      }
      if (clientOnly) {
        const offsetX = Math.max(0, window.clientOrigin.x - window.windowRect.left);
        const offsetY = Math.max(0, window.clientOrigin.y - window.windowRect.top);
        image = image.crop({
          x: offsetX,
          y: offsetY,
          width: Math.min(window.clientRect.width, window.windowRect.width - offsetX),
          height: Math.min(window.clientRect.height, window.windowRect.height - offsetY),
        });
      }
      return this.finalizeCapturedImage(image, window, clientOnly, "background-printwindow");
    } catch (error) {
      if (error instanceof WindowsAutomationError && error.code === "CAPTURE_FAILED") {
        return this.captureWindowSource(window, clientOnly, signal);
      }
      throw error;
    } finally {
      await unlink(path).catch(() => undefined);
    }
  }

  /**
   * OCR semantic fallback for apps whose UIA tree is empty (Electron/Qt/Tauri).
   * Captures the window without stealing focus, runs the local OCR CLI and
   * returns text lines in client DIP coordinates so click_client can target them.
   */
  private async ocrWindow(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const provider = resolveOcrProvider();
    if (!provider) {
      throw new WindowsAutomationError("OCR_UNAVAILABLE", "未找到可用 OCR：设置 MYBUDDY_OCR_CLI（OCR_NPU_CLI）或安装 Windows OCR 语言包", { searched: ocrSearchCandidates() });
    }
    const target = await this.guardedTarget(input, signal);
    const window = await this.inspect(target, signal);
    if (!window.visible || window.minimized) {
      throw new WindowsAutomationError("WINDOW_NOT_VISIBLE", "OCR 需要可见、未最小化的窗口", { window });
    }
    let capture: { screenshot: Uint8Array; details: { imageScale: number; imageSize: { width: number; height: number } } };
    // Foreground windows: the display crop is content-complete and fast.
    // Background windows: PrintWindow for native surfaces, WGC for Chromium/Qt/Tauri.
    if (window.foreground) {
      capture = await checked(() => this.capture.capture(window, true), signal);
    } else {
      capture = await this.captureBackground(window, true, signal);
    }
    const workDir = join(tmpdir(), `mybuddy-cu-ocr-${randomUUID()}`);
    const imagePath = join(workDir, "capture.jpg");
    const outputDir = join(workDir, "out");
    await mkdir(outputDir, { recursive: true });
    await writeFile(imagePath, Buffer.from(capture.screenshot));
    const startedAt = Date.now();
    try {
      let raw: OcrRawText[];
      let providerName: string;
      if (provider.kind === "npu") {
        const { stdout } = await execFileAsync(provider.path, ["--input_path", imagePath, "--json", "--output_dir", outputDir], {
          timeout: OCR_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        });
        raw = parseOcrOutput(String(stdout), outputDir, imagePath);
        providerName = "OCR_NPU_CLI";
      } else {
        const { stdout } = await execFileAsync("powershell.exe", [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", provider.script,
        ], {
          timeout: OCR_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, MYBUDDY_OCR_IMAGE: imagePath },
        });
        raw = parseWindowsOcrOutput(String(stdout));
        providerName = "Windows.Media.Ocr";
      }
      const scale = capture.details.imageScale || 1;
      const minScore = Math.min(1, Math.max(0, Number(input.minScore ?? 0.5)));
      const maxLines = Math.min(200, Math.max(1, Math.round(Number(input.maxLines ?? 80))));
      const lines: OcrLine[] = raw
        .filter((item) => item.score >= minScore)
        .slice(0, maxLines)
        .map((item) => {
          if (!item.box.length) return { text: item.text, score: Math.round(item.score * 1000) / 1000, x: 0, y: 0, width: 0, height: 0 };
          const xs = item.box.map((point) => point[0]);
          const ys = item.box.map((point) => point[1]);
          const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
          return {
            text: item.text,
            score: Math.round(item.score * 1000) / 1000,
            x: Math.round(left * scale),
            y: Math.round(top * scale),
            width: Math.round((right - left) * scale),
            height: Math.round((bottom - top) * scale),
          };
        });
      return {
        action: input.action,
        window,
        lines,
        lineCount: lines.length,
        imageScale: scale,
        imageSize: capture.details.imageSize,
        ocr: { provider: providerName, totalLines: raw.length, ms: Date.now() - startedAt },
        detail: "OCR semantic fallback (client-DIP boxes)",
      };
    } catch (error) {
      if (error instanceof WindowsAutomationError) throw error;
      throw new WindowsAutomationError("OCR_UNAVAILABLE", `OCR 执行失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async executeClientInput(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const target = await this.guardedTarget(input, signal);
    const targetWindow = await this.inspect(target, signal);
    const cursor = Number.isFinite(input.x) && Number.isFinite(input.y)
      ? { x: Number(input.x), y: Number(input.y), clicking: input.action === "click_client" || input.action === "drag_client" || input.action === "mouse_down_client" }
      : undefined;
    computerUseRunCoordinator.presentTarget(input, targetWindow, "acting", cursor);
    const observed = await this.withObservation(target, input, async () => {
      if (input.action === "move_client") return this.request("move_client", { target, x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y") }, signal);
      if (input.action === "click_client") return this.request("click_client", {
        target, x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y"), button: input.button,
        clickCount: input.clickCount, modifiers: modifierVks(input.modifiers), holdMs: input.holdMs, background: input.background,
      }, signal);
      if (input.action === "mouse_down_client") return this.request("mouse_down_client", { target, x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y"), button: input.button }, signal);
      if (input.action === "mouse_up_client") return this.request("mouse_up_client", { target, x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y"), button: input.button }, signal);
      if (input.action === "drag_client") return this.request("drag_client", {
        target, x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y"), x2: requireFinite(input.x2, "x2"), y2: requireFinite(input.y2, "y2"),
        button: input.button, steps: input.steps, durationMs: input.durationMs,
      }, signal);
      return this.request("scroll_client", {
        target, x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY, notches: input.notches,
      }, signal);
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

  private async executeDragScreen(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const cursor = {
      x: Number.isFinite(input.x) ? Number(input.x) : undefined,
      y: Number.isFinite(input.y) ? Number(input.y) : undefined,
      clicking: true,
    };
    computerUseRunCoordinator.presentDesktop(input, "acting", cursor);
    const observed = await this.withObservation(undefined, input, () => this.request("drag_screen", {
      x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y"),
      x2: requireFinite(input.x2, "x2"), y2: requireFinite(input.y2, "y2"),
      button: input.button, steps: input.steps, durationMs: input.durationMs,
    }, signal), signal);
    return { action: input.action, ...(observed.result as object), observation: observed.observation, detail: "cross-window desktop drag" };
  }

  private async executePaste(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const text = input.text ?? "";
    if (!text) throw new Error("paste_text 需要 text");
    if (text.length > 200_000) throw new Error("text 过长（粘贴上限 200000 字符）");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clipboard } = require("electron") as typeof import("electron");
    clipboard.writeText(text);
    const hasTarget = input.windowHandle || input.windowTitle || input.processId || input.className || input.appSessionId || input.observationId;
    const target = hasTarget ? await this.guardedTarget(input, signal) : undefined;
    if (target) computerUseRunCoordinator.presentTarget(input, await this.inspect(target, signal), "acting");
    const observed = await this.withObservation(target, input, () => this.request("key_press", { key: "ControlKey+V", target }, signal), signal);
    return { action: input.action, ...(observed.result as object), observation: observed.observation, detail: "clipboard paste via Ctrl+V" };
  }

  private async executeKeyboard(input: ComputerExecInput & { action: ComputerExecAction }, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const target = input.windowHandle || input.windowTitle || input.processId || input.className || input.appSessionId || input.observationId ? await this.guardedTarget(input, signal) : undefined;
    if (target) computerUseRunCoordinator.presentTarget(input, await this.inspect(target, signal), "acting");
    const observed = await this.withObservation(target, input, async () => {
      if (input.action === "key_press" || input.action === "key_down" || input.action === "key_up") {
        const key = requireShort(input.key, "key", 120).split("+").map(normalizeKeyToken).join("+");
        return this.request(input.action, { key, target }, signal);
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
  private async applyCapture(targetBefore: WindowInfo, after: WindowInfo[], resultRecord: Record<string, unknown>, signal?: AbortSignal, background = false): Promise<void> {
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
    if (!background && !targetAfter.foreground) {
      captureFailed("Target lost foreground before post-action capture", { targetAfter });
      return;
    }
    try {
      const captured = background && !targetAfter.foreground
        ? await this.captureBackground(targetAfter, true, signal)
        : await checked(() => this.capture.capture(targetAfter, true), signal);
      const verifiedAfterCapture = await this.inspect({ windowHandle: targetAfter.handle, expectedProcessId: targetAfter.processId }, signal);
      if ((!background && !verifiedAfterCapture.foreground) || !sameCaptureGeometry(targetAfter, verifiedAfterCapture)) {
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
        clickCount: step.clickCount, modifiers: step.modifiers, holdMs: step.holdMs,
        steps: step.steps, durationMs: step.durationMs, notches: step.notches,
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
    if (input.captureAfter) await this.applyCapture(beforeTarget, after, output as unknown as Record<string, unknown>, signal, steps.every((step) => step.background === true));
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
      await this.applyCapture(targetBefore, after, result as Record<string, unknown>, signal, input.background === true);
    }
    return { result, observation };
  }
}

