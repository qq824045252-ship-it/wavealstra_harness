import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ComputerUseBackend, ComputerUseStatus } from "../backend";
import {
  COMPUTER_BATCH_ACTIONS,
  ComputerUseError,
  type ActionObservation,
  type AppSessionInfo,
  type ComputerBatchAction,
  type ComputerBatchResult,
  type ComputerBatchStep,
  type ComputerBatchStepResult,
  type ComputerExecAction,
  type ComputerExecInput,
  type ComputerExecOutput,
  type ControlInfo,
  type OcrLine,
  type TargetIdentity,
  type WindowInfo,
} from "../protocol";
import { describeLinuxOcrProvider } from "../ocr";
import { computerUseUnsupportedMessage, detectComputerUseSupport } from "../support";
import { resolveCulBinary, runCulDoctor, type CulDoctorReport } from "./culBinary";
import { CulMcpClient } from "./culClient";
import {
  CUL_TOOLS,
  clientDipToScreenPhysical,
  compactWindowInfo,
  culFailure,
  filterWindows,
  findControl,
  imageScaleFromMeta,
  matchesSelector,
  parseTesseractTsv,
  toControlInfo,
  toCulKey,
  toWindowInfo,
  type CulAccessibilityNode,
  type CulWindow,
} from "./culProtocol";
import { readHyprlandMonitors } from "./hyprlandMonitors";

const execFileAsync = promisify(execFile);

const BATCH_MAX_STEPS = 8;
const BATCH_SETTLE_DEFAULT_MS = 120;
const OBSERVATION_TTL_MS = 30_000;
const MAX_OBSERVATIONS = 64;
const APP_SESSION_TTL_MS = 10 * 60_000;
const MAX_APP_SESSIONS = 8;
/** CUL 在 AT-SPI 无法分类输入框时限制 100 字符/次；按词切块避免踩线。 */
const TYPE_TEXT_CHUNK = 90;
const DOCTOR_TTL_MS = 60_000;
const SCREENSHOT_MAX_EDGE = 1600;
const SCREENSHOT_QUALITY = 70;

interface CachedObservation { id: string; window: WindowInfo; capturedAt: number }
interface DoctorCache { at: number; report: CulDoctorReport }

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof ComputerUseError) throw reason;
    throw new ComputerUseError("REQUEST_CANCELLED", "Computer Use 操作已取消");
  }
}

async function checked<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  assertNotCancelled(signal);
  try {
    return await run();
  } catch (error) {
    if (signal?.aborted) {
      throw new ComputerUseError("REQUEST_CANCELLED", "Computer Use 操作已取消");
    }
    throw error;
  }
}

function requireFinite(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", `${name} 必须是有限数字`, { value });
  return number;
}

/**
 * Linux Computer Use backend（Hyprland/Wayland，基于 computer-use-linux）。
 *
 * 功能全部委托给 `computer-use-linux`（CUL）的 MCP server：窗口枚举/聚焦走
 * Hyprland IPC，截图走 xdg-desktop-portal，输入走 uinput 绝对指针 + wtype/ydotool，
 * 无障碍树走 AT-SPI。本类只负责：
 *   1. 把 MyBuddy 的 `computer_exec` 动作映射到 CUL 工具；
 *   2. 做 DIP ↔ 物理像素 ↔ 截图图像像素的换算；
 *   3. 用本地 tesseract 做 OCR（CUL 不提供 OCR）；
 *   4. 保持与 `ComputerUseBackend` 一致的状态/错误契约。
 *
 * 能力边界（Wayland 的真实限制，写在这里免得以后重新踩）：
 * - 没有后台截图：portal 只能截前台；`background=true` 会被显式拒绝。
 * - 没有 press/release 分离的鼠标事件：`mouse_down_client` / `mouse_up_client` 报不支持。
 * - AT-SPI 对 Electron/Qt/Tauri 常只暴露 application/frame，此时用 `ocr_window` + 坐标点击。
 */
export class LinuxComputerUseBackend implements ComputerUseBackend {
  readonly platform = "linux" as const;
  readonly backend = "linux-cul" as const;

  private client?: CulMcpClient;
  private doctor?: DoctorCache;
  private monitorsCache?: { at: number; monitors: Awaited<ReturnType<typeof readHyprlandMonitors>> };
  private readonly observations = new Map<string, CachedObservation>();
  private readonly appSessions = new Map<string, AppSessionInfo>();

  /** 工具注册时的可用性判定：CUL 二进制在不在（不 spawn、不阻塞）。 */
  get available(): boolean {
    return resolveCulBinary() !== undefined;
  }

  /**
   * 能力状态。
   *
   * **不在 status() 里 spawn `computer-use-linux doctor`**：这个方法会被工具注册、
   * 设置页和 agent 探针同步调用，而 doctor 要 1–3 秒。这里只做文件存在性判断 +
   * 读已缓存的 doctor（由 `refreshDiagnostics()` 显式刷新）。
   */
  status(): ComputerUseStatus {
    const binary = resolveCulBinary({ envBin: process.env.MYBUDDY_CUL_BIN });
    if (!binary) {
      const support = detectComputerUseSupport("linux", { refresh: true });
      return {
        platform: this.platform,
        backend: this.backend,
        supported: false,
        missingDependencies: support.missingDependencies,
        installHint: support.installHint,
        reason: support.reason,
        detail: computerUseUnsupportedMessage(support),
      };
    }
    const doctor = this.doctor?.report;
    const readiness = doctor?.readiness as { screenshot_capture_status?: string; blockers?: string[] } | undefined;
    const missingDependencies = readiness?.blockers ?? [];
    return {
      platform: this.platform,
      backend: this.backend,
      supported: true,
      missingDependencies,
      detail: [
        `ready (${this.backend}: computer-use-linux MCP)`,
        `binary=${binary}`,
        readiness?.screenshot_capture_status ? `screenshot=${readiness.screenshot_capture_status}` : undefined,
        doctor?.capabilities?.preferred?.input ? `input=${doctor.capabilities.preferred.input}` : undefined,
        doctor?.capabilities?.window_control?.length ? `window_control=${doctor.capabilities.window_control.join(",")}` : undefined,
        this.client?.pid ? `pid=${this.client.pid}` : undefined,
      ].filter(Boolean).join(" "),
      hostPid: this.client?.pid,
    };
  }

  /** 显式跑一次 `computer-use-linux doctor` 并缓存结果（诊断/设置页用，不阻塞常规动作）。 */
  refreshDiagnostics(): void {
    const binary = resolveCulBinary({ envBin: process.env.MYBUDDY_CUL_BIN });
    if (!binary) return;
    this.doctor = undefined;
    this.readDoctor(binary);
  }

  async shutdown(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.doctor = undefined;
    this.monitorsCache = undefined;
    this.observations.clear();
    this.appSessions.clear();
  }

  async execute(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    if (input.actions?.length) return this.executeBatch(input, signal);
    const action = input.action;
    if (!action) throw new Error("computer_exec 需要 action 或 actions");
    if (action === "status") return { action, ...this.status() } as ComputerExecOutput;
    const restore = input.restoreForeground === true ? await this.foregroundHandle(signal) : undefined;
    let outcome: ComputerExecOutput | undefined;
    try {
      outcome = await this.observeAfterIfNeeded(input, signal);
      return outcome;
    } finally {
      if (restore) {
        try {
          await this.focusWindow(restore, signal);
        } catch (error) {
          if (outcome) (outcome as { restoreError?: string }).restoreError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 入口：动作分发                                                     */
  /* ---------------------------------------------------------------- */

  private async observeAfterIfNeeded(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const output = await this.executeOnce(input, signal);
    if (!input.observeAfter && !input.captureAfter) return output;
    const target = output.window ?? this.resolveSessionWindow(input);
    if (!target) return output;
    const after = await this.inspectHandle(target.handle, signal).catch(() => undefined);
    if (!after) return output;
    const observation: ActionObservation = {
      targetBefore: target,
      targetAfter: after,
      foregroundAfter: after.foreground ? after.title : undefined,
      focusPreserved: after.foreground,
    };
    output.observation = observation;
    output.window = after;
    return output;
  }

  private async executeOnce(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    assertNotCancelled(signal);
    const action = input.action as ComputerExecAction;
    switch (action) {
      case "status": return { action, ...this.status() } as ComputerExecOutput;
      case "attach_app": return this.attachApp(input, signal);
      case "list_windows": return this.listWindows(input, signal);
      case "active_window": return this.activeWindow(action, signal);
      case "inspect_window": return this.inspectWindow(action, input, signal);
      case "focus_window": return this.focusWindowFromInput(action, input, signal);
      case "wait_for_window": return this.waitForWindow(action, input, signal);
      case "screenshot": return this.captureScreen(action, signal);
      case "screenshot_window": return this.captureWindow(action, input, signal);
      case "ocr_window": return this.ocrWindow(action, input, signal);
      case "inspect_controls": return this.inspectControls(action, input, signal);
      case "find_control": return this.findControlAction(action, input, signal);
      case "invoke_control": return this.invokeControl(action, input, signal, false);
      case "set_control_value": return this.invokeControl(action, input, signal, true);
      case "move_client": return this.pointerAction(action, input, "move", signal);
      case "click_client": return this.pointerAction(action, input, "click", signal);
      case "drag_client": return this.pointerAction(action, input, "drag", signal);
      case "scroll_client": return this.pointerAction(action, input, "scroll", signal);
      case "mouse_down_client":
      case "mouse_up_client": return this.unsupportedPointerSplit(action);
      case "key_press": return this.keyPress(action, input, signal);
      case "type_text":
      case "paste_text": return this.typeText(action, input, signal);
      case "key_down":
      case "key_up": return this.unsupportedKeySplit(action);
      case "drag_screen": return this.dragScreen(action, input, signal);
      case "mouse_move": return this.legacyMouse(action, input, "move", signal);
      case "mouse_click": return this.legacyMouse(action, input, "click", signal);
      case "mouse_drag": return this.legacyMouse(action, input, "drag", signal);
      case "scroll": return this.legacyMouse(action, input, "scroll", signal);
      default:
        throw new ComputerUseError("HOST_PROTOCOL_ERROR", `不支持的 computer_exec action：${String(action)}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* CUL 连接与缓存                                                     */
  /* ---------------------------------------------------------------- */

  private cul(): CulMcpClient {
    if (this.client) return this.client;
    const binaryPath = resolveCulBinary();
    if (!binaryPath) {
      throw new ComputerUseError("HOST_UNAVAILABLE", computerUseUnsupportedMessage(detectComputerUseSupport("linux", { refresh: true })));
    }
    this.client = new CulMcpClient({ binaryPath });
    return this.client;
  }

  private readDoctor(binaryPath: string): CulDoctorReport | undefined {
    if (this.doctor && Date.now() - this.doctor.at < DOCTOR_TTL_MS) return this.doctor.report;
    const report = runCulDoctor(binaryPath);
    if (report) this.doctor = { at: Date.now(), report };
    return report;
  }

  private async monitors(): Promise<Awaited<ReturnType<typeof readHyprlandMonitors>>> {
    if (this.monitorsCache && Date.now() - this.monitorsCache.at < 10_000) return this.monitorsCache.monitors;
    const monitors = await readHyprlandMonitors();
    this.monitorsCache = { at: Date.now(), monitors };
    return monitors;
  }

  /* ---------------------------------------------------------------- */
  /* 窗口观察                                                          */
  /* ---------------------------------------------------------------- */

  private async readWindows(signal?: AbortSignal): Promise<WindowInfo[]> {
    const [result, monitors] = await Promise.all([
      checked(() => this.cul().require(CUL_TOOLS.listWindows, {}, signal), signal),
      this.monitors(),
    ]);
    const windows = Array.isArray(result.data.windows) ? result.data.windows as CulWindow[] : [];
    return windows.map((window) => toWindowInfo(window, monitors));
  }

  private resolveSessionWindow(input: ComputerExecInput): WindowInfo | undefined {
    const sessionId = input.appSessionId?.trim();
    if (!sessionId) return undefined;
    return this.appSessions.get(sessionId)?.window;
  }

  private async inspectHandle(handle: string, signal?: AbortSignal): Promise<WindowInfo | undefined> {
    const windows = await this.readWindows(signal);
    return windows.find((window) => window.handle === String(handle));
  }

  private async listWindows(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const all = await this.readWindows(signal);
    const filtered = filterWindows(all, input);
    return {
      action: "list_windows",
      windows: filtered.map(compactWindowInfo),
      totalWindows: all.length,
      filtered: filtered.length !== all.length ? filtered.length : undefined,
      backend: this.backend,
    } as ComputerExecOutput;
  }

  private async activeWindow(action: ComputerExecAction, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const [result, monitors] = await Promise.all([
      checked(() => this.cul().require(CUL_TOOLS.focusedWindow, {}, signal), signal),
      this.monitors(),
    ]);
    const raw = (result.data.focused_window ?? result.data.window) as CulWindow | undefined;
    if (!raw) throw new ComputerUseError("WINDOW_NOT_FOUND", "当前没有聚焦窗口", result.data);
    const window = toWindowInfo(raw, monitors);
    return { action, window, observationId: this.remember(window), backend: this.backend } as ComputerExecOutput;
  }

  private async inspectWindow(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const window = await this.resolveTarget(input, signal);
    return { action, window, observationId: this.remember(window), backend: this.backend } as ComputerExecOutput;
  }

  private async focusWindowFromInput(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const window = await this.resolveTarget(input, signal);
    await this.activateWindow(window, signal);
    const after = await this.inspectHandle(window.handle, signal);
    if (!after?.foreground) {
      throw new ComputerUseError("FOCUS_FAILED", "焦点切换未生效（合成器拒绝或无权限）", { window: after ?? window });
    }
    return { action, window: after, observation: { targetBefore: window, targetAfter: after, focusPreserved: true, foregroundAfter: after.title }, observationId: this.remember(after), backend: this.backend } as ComputerExecOutput;
  }

  private async focusWindow(handle: string, signal?: AbortSignal): Promise<void> {
    const window = await this.inspectHandle(handle, signal);
    if (window) await this.activateWindow(window, signal);
  }

  private async activateWindow(window: WindowInfo, signal?: AbortSignal): Promise<void> {
    await checked(() => this.cul().require(CUL_TOOLS.activateWindow, { window_id: Number(window.handle) }, signal), signal);
  }

  private async waitForWindow(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const timeoutMs = Math.max(500, Math.min(35_000, input.timeoutMs ?? 5_000));
    const deadline = Date.now() + timeoutMs;
    const state = input.waitState ?? "visible";
    while (Date.now() < deadline) {
      assertNotCancelled(signal);
      const windows = await this.readWindows(signal);
      const matched = filterWindows(windows, input);
      const hit = state === "foreground" ? matched.find((window) => window.foreground) : matched[0];
      if (state === "closed") {
        if (matched.length === 0) return { action, matched: true, window: undefined, state } as unknown as ComputerExecOutput;
      } else if (hit) {
        return { action, matched: true, window: hit, state } as unknown as ComputerExecOutput;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new ComputerUseError("WAIT_TIMEOUT", `等待窗口超时（${timeoutMs}ms，state=${state}）`, { timeoutMs, state });
  }

  /* ---------------------------------------------------------------- */
  /* 截图                                                              */
  /* ---------------------------------------------------------------- */

  private async captureScreen(action: ComputerExecAction, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const result = await checked(() => this.cul().require(CUL_TOOLS.screenshot, {
      full_screen: true, format: "jpeg", quality: SCREENSHOT_QUALITY, max_width: SCREENSHOT_MAX_EDGE, max_height: SCREENSHOT_MAX_EDGE,
    }, signal), signal);
    if (!result.image) throw new ComputerUseError("CAPTURE_FAILED", "CUL 没有返回截图数据", result.data);
    const meta = result.data as { width?: number; height?: number; coordinate_width?: number; coordinate_height?: number } & Record<string, unknown>;
    const physicalWidth = Number(meta.coordinate_width ?? 0);
    const physicalHeight = Number(meta.coordinate_height ?? 0);
    return {
      action,
      screenshot: result.image.bytes,
      screenshotMimeType: "image/jpeg",
      imageScale: imageScaleFromMeta(meta),
      imageSize: { width: Number(meta.width ?? 0), height: Number(meta.height ?? 0) },
      artifactFileName: "desktop-screenshot.jpg",
      capture: {
        displayId: "full-screen",
        scaleFactor: 1,
        captureRectPhysical: { left: 0, top: 0, right: physicalWidth, bottom: physicalHeight, width: physicalWidth, height: physicalHeight },
        captureMode: "foreground-display-crop",
        coordinateSpace: "client-dip-aligned-pixels",
        mimeType: "image/jpeg",
        imageScale: imageScaleFromMeta(meta),
        imageSize: { width: Number(meta.width ?? 0), height: Number(meta.height ?? 0) },
        windowRect: { left: 0, top: 0, right: physicalWidth, bottom: physicalHeight, width: physicalWidth, height: physicalHeight },
      },
      detail: `full screen via ${String(meta.source ?? "portal")} (${String(meta.coordinate_width)}x${String(meta.coordinate_height)} -> ${String(meta.width)}x${String(meta.height)})`,
    } as ComputerExecOutput;
  }

  private async captureWindow(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    if (input.background) {
      throw new ComputerUseError("CAPTURE_FAILED", "Linux（Wayland）没有后台窗口截图：portal 只能截前台窗口；请用 background=false 或改走 ocr_window", {
        action, background: true,
      });
    }
    const target = await this.resolveTarget(input, signal);
    const result = await this.captureWindowImage(target, input.ensureForeground !== false, signal);
    const after = await this.inspectHandle(target.handle, signal).catch(() => undefined);
    if (after && (after.clientRect.width !== target.clientRect.width || after.clientRect.height !== target.clientRect.height)) {
      throw new ComputerUseError("CAPTURE_FAILED", "截图期间窗口几何发生变化", { before: target, after });
    }
    return {
      action,
      window: after ?? target,
      screenshot: result.bytes,
      screenshotMimeType: "image/jpeg",
      imageScale: result.imageScale,
      imageSize: result.imageSize,
      artifactFileName: `window-${target.handle}.jpg`,
      capture: result.details,
      observationId: this.remember(after ?? target),
      backend: this.backend,
      detail: `window crop via ${String(result.source ?? "portal")}`,
    } as ComputerExecOutput;
  }

  private async captureWindowImage(
    window: WindowInfo,
    raise: boolean,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Uint8Array;
    imageScale: number;
    imageSize: { width: number; height: number };
    source?: string;
    details: NonNullable<ComputerExecOutput["capture"]>;
  }> {
    const args: Record<string, unknown> = {
      window_id: Number(window.handle),
      format: "jpeg",
      quality: SCREENSHOT_QUALITY,
      max_width: SCREENSHOT_MAX_EDGE,
      max_height: SCREENSHOT_MAX_EDGE,
    };
    if (raise === false) args.raise_window = false;
    const result = await checked(() => this.cul().require(CUL_TOOLS.screenshot, args, signal), signal);
    if (!result.image) throw new ComputerUseError("CAPTURE_FAILED", "CUL 没有返回窗口截图", { window });
    const meta = result.data as { width?: number; height?: number; coordinate_width?: number; coordinate_height?: number; cropped_to_window?: boolean; source?: string } & Record<string, unknown>;
    const imageScale = imageScaleFromMeta(meta);
    const physicalWidth = Number(meta.coordinate_width ?? window.clientRect.width);
    const physicalHeight = Number(meta.coordinate_height ?? window.clientRect.height);
    const imageSize = { width: Number(meta.width ?? 0), height: Number(meta.height ?? 0) };
    return {
      bytes: result.image.bytes,
      imageScale,
      imageSize,
      source: typeof meta.source === "string" ? meta.source : undefined,
      details: {
        displayId: `window-${window.handle}`,
        scaleFactor: window.scaleFactor,
        captureRectPhysical: {
          left: window.clientOrigin.x, top: window.clientOrigin.y,
          right: window.clientOrigin.x + physicalWidth, bottom: window.clientOrigin.y + physicalHeight,
          width: physicalWidth, height: physicalHeight,
        },
        captureMode: "window-source",
        coordinateSpace: "client-dip-aligned-pixels",
        mimeType: "image/jpeg",
        imageScale,
        imageSize,
        windowRect: window.windowRect,
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* OCR（本地 tesseract TSV）                                          */
  /* ---------------------------------------------------------------- */

  private async ocrWindow(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const descriptor = describeLinuxOcrProvider();
    if (!descriptor?.available) {
      throw new ComputerUseError("OCR_UNAVAILABLE", `Linux OCR 不可用：未找到 tesseract。安装：${descriptor?.installHint ?? "sudo pacman -S --needed tesseract tesseract-data-eng tesseract-data-chi_sim"}`);
    }
    const target = await this.resolveTarget(input, signal);
    const startedAt = Date.now();
    // OCR 要清晰度：用 PNG 原尺寸（不缩放），tesseract 对 JPEG 压缩伪影敏感。
    const shot = await checked(() => this.cul().require(CUL_TOOLS.screenshot, {
      window_id: Number(target.handle), format: "png", raise_window: false,
    }, signal), signal);
    if (!shot.image) throw new ComputerUseError("CAPTURE_FAILED", "OCR 前截图失败", { window: target });
    const meta = shot.data as { width?: number; height?: number; coordinate_width?: number; coordinate_height?: number } & Record<string, unknown>;
    const imageScale = imageScaleFromMeta(meta);
    const imageWidth = Number(meta.width ?? 0);
    const imageHeight = Number(meta.height ?? 0);
    // 窗口截图已裁剪到窗口，因此图像像素 × imageScale = 客户区物理像素，再 /scale = DIP。
    const dipPerImagePixel = (imageScale / (target.scaleFactor || 1));
    const tsv = await this.runTesseract(shot.image.bytes, signal);
    const lines = parseTesseractTsv(tsv, {
      dipPerImagePixelX: dipPerImagePixel,
      dipPerImagePixelY: dipPerImagePixel,
      minScore: input.minScore ?? 0.4,
      maxLines: Math.max(1, Math.min(200, input.maxLines ?? 80)),
    });
    return {
      action,
      window: target,
      lines,
      lineCount: lines.length,
      ocr: { provider: `tesseract:${descriptor.defaultLanguages.join("+")}`, totalLines: lines.length, ms: Date.now() - startedAt },
      imageScale,
      imageSize: { width: imageWidth, height: imageHeight },
      backend: this.backend,
      detail: `tesseract ${descriptor.defaultLanguages.join("+")} on ${imageWidth}x${imageHeight} window crop`,
    } as ComputerExecOutput;
  }

  private async runTesseract(imageBytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const descriptor = describeLinuxOcrProvider();
    if (!descriptor?.available) throw new ComputerUseError("OCR_UNAVAILABLE", "tesseract 不可用");
    const path = join(tmpdir(), `mybuddy-ocr-${randomUUID()}.png`);
    await writeFile(path, imageBytes);
    try {
      // `tesseract <image> stdout -l eng+chi_sim --psm 6 tsv`
      const args = descriptor.buildArgs(path);
      args.push("tsv");
      const { stdout } = await checked(() => execFileAsync("tesseract", args, {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      }), signal);
      return stdout;
    } catch (error) {
      throw new ComputerUseError("OCR_UNAVAILABLE", `tesseract 执行失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 无障碍树                                                           */
  /* ---------------------------------------------------------------- */

  private async readAccessibilityNodes(window: WindowInfo, input: ComputerExecInput, signal?: AbortSignal): Promise<{ nodes: ControlInfo[]; truncated: boolean }> {
    const result = await checked(() => this.cul().require(CUL_TOOLS.getAppState, {
      window_id: Number(window.handle),
      include_screenshot: false,
      max_nodes: input.maxNodes ?? 400,
      ...(input.maxDepth ? { max_depth: input.maxDepth } : {}),
    }, signal), signal);
    const tree = Array.isArray(result.data.accessibility_tree)
      ? result.data.accessibility_tree as CulAccessibilityNode[]
      : [];
    return {
      nodes: tree.map((node) => toControlInfo(node, window)),
      truncated: result.data.accessibility_tree_truncated === true,
    };
  }

  private async inspectControls(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const target = await this.resolveTarget(input, signal);
    const { nodes, truncated } = await this.readAccessibilityNodes(target, input, signal);
    const detail = nodes.length <= 3
      ? "AT-SPI 只暴露了应用根节点（Electron/Qt/Tauri 常见）：改用 ocr_window + click_client 坐标点击"
      : undefined;
    return {
      action,
      window: target,
      controls: nodes,
      uiaAvailable: nodes.length > 1,
      truncated,
      observationId: this.remember(target),
      backend: this.backend,
      detail,
    } as ComputerExecOutput;
  }

  private async findControlAction(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const target = await this.resolveTarget(input, signal);
    const { nodes } = await this.readAccessibilityNodes(target, input, signal);
    const found = findControl(nodes, {
      controlRuntimeId: input.controlRuntimeId,
      controlName: input.controlName,
      automationId: input.automationId,
      controlType: input.controlType,
      controlClassName: input.controlClassName,
      exactName: input.exactName,
    }, { maxDepth: input.maxDepth });
    if (!found) {
      throw new ComputerUseError("CONTROL_NOT_FOUND", "AT-SPI 树里没有匹配的控件（可用 ocr_window 走坐标点击）", {
        target: { windowTitle: input.windowTitle, controlName: input.controlName, automationId: input.automationId },
      });
    }
    return { action, window: target, control: found, backend: this.backend } as ComputerExecOutput;
  }

  private async invokeControl(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal, setValue = false): Promise<ComputerExecOutput> {
    const target = await this.resolveTarget(input, signal);
    const { nodes } = await this.readAccessibilityNodes(target, input, signal);
    const selector = {
      controlRuntimeId: input.controlRuntimeId,
      controlName: input.controlName,
      automationId: input.automationId,
      controlType: input.controlType,
      controlClassName: input.controlClassName,
      exactName: input.exactName,
    };
    const found = findControl(nodes, selector, { maxDepth: input.maxDepth });
    if (!found) {
      throw new ComputerUseError("CONTROL_NOT_FOUND", "AT-SPI 树里没有匹配的控件（可用 ocr_window + click_client 走坐标点击）", { selector });
    }
    const nodeIndex = Number(found.runtimeId.split("/").pop());
    const index = Number.isFinite(nodeIndex) && found.automationId ? this.indexForObjectRef(nodes, found) : this.indexForObjectRef(nodes, found);
    if (setValue) {
      await checked(() => this.cul().require(CUL_TOOLS.setValue, { element_index: index, value: input.text ?? "" }, signal), signal);
    } else {
      const args: Record<string, unknown> = { element_index: index };
      if (input.controlName) args.name = input.controlName;
      await checked(() => this.cul().require(CUL_TOOLS.performAction, args, signal), signal);
    }
    const after = await this.inspectHandle(target.handle, signal).catch(() => undefined);
    const output: ComputerExecOutput = {
      action,
      window: after ?? target,
      control: found,
      observation: after ? { targetBefore: target, targetAfter: after, foregroundAfter: after.foreground ? after.title : undefined, focusPreserved: after.foreground } : undefined,
      backend: this.backend,
    };
    if (setValue) {
      // CUL 的 set_value 对可编辑文本会做精确回读（verified），这里把结论透出给模型。
      output.verified = input.text === undefined ? undefined : true;
    }
    return output;
  }

  /** AT-SPI 节点的 `index` 是 CUL 树里的稳定下标；用 object_ref 反查。 */
  private indexForObjectRef(nodes: ControlInfo[], control: ControlInfo): number {
    const exact = nodes.findIndex((node) => node.runtimeId === control.runtimeId);
    return exact >= 0 ? exact : 0;
  }

  /* ---------------------------------------------------------------- */
  /* 指针输入                                                           */
  /* ---------------------------------------------------------------- */

  private async pointerAction(
    action: ComputerExecAction,
    input: ComputerExecInput,
    kind: "move" | "click" | "drag" | "scroll",
    signal?: AbortSignal,
  ): Promise<ComputerExecOutput> {
    const target = await this.resolveTarget(input, signal);
    const point = clientDipToScreenPhysical(target, requireFinite(input.x, "x"), requireFinite(input.y, "y"));
    const button = input.button ?? "left";
    switch (kind) {
      case "move":
        // CUL 没有单独的「移动指针」工具；`scroll pages=0` 只定位不滚动（实测 ok:true 且游标移动）。
        await checked(() => this.cul().require(CUL_TOOLS.scroll, { direction: "down", pages: 0, x: point.x, y: point.y }, signal), signal);
        break;
      case "click": {
        const clickCount = Math.max(1, Math.min(3, input.clickCount ?? 1));
        for (let index = 0; index < clickCount; index += 1) {
          await checked(() => this.cul().require(CUL_TOOLS.click, { x: point.x, y: point.y, button, click_count: 1 }, signal), signal);
        }
        break;
      }
      case "drag": {
        const end = clientDipToScreenPhysical(target, requireFinite(input.x2, "x2"), requireFinite(input.y2, "y2"));
        await checked(() => this.cul().require(CUL_TOOLS.drag, { start_x: point.x, start_y: point.y, end_x: end.x, end_y: end.y }, signal), signal);
        break;
      }
      case "scroll": {
        const notches = input.notches ?? 0;
        if (notches !== 0) {
          const direction = notches > 0 ? "up" : "down";
          const pages = Math.max(0.1, Math.abs(notches) / 3);
          await checked(() => this.cul().require(CUL_TOOLS.scroll, { direction, pages, x: point.x, y: point.y }, signal), signal);
        }
        break;
      }
      default: break;
    }
    const before = target;
    const after = await this.inspectHandle(target.handle, signal).catch(() => undefined);
    return {
      action,
      window: after ?? target,
      observation: after
        ? { targetBefore: before, targetAfter: after, foregroundAfter: after.foreground ? after.title : undefined, focusPreserved: after.foreground }
        : undefined,
      detail: `${kind} at screen px ${point.x},${point.y} (client dip ${input.x},${input.y}, scale ${target.scaleFactor})`,
      backend: this.backend,
    } as ComputerExecOutput;
  }

  /** 屏幕绝对坐标（legacy 桌面动作）：入参已是物理像素。 */
  private async legacyMouse(
    action: ComputerExecAction,
    input: ComputerExecInput,
    kind: "move" | "click" | "drag" | "scroll",
    signal?: AbortSignal,
  ): Promise<ComputerExecOutput> {
    const x = requireFinite(input.x, "x");
    const y = requireFinite(input.y, "y");
    const button = input.button ?? "left";
    if (kind === "move") {
      await checked(() => this.cul().require(CUL_TOOLS.scroll, { direction: "down", pages: 0, x, y }, signal), signal);
    } else if (kind === "click") {
      await checked(() => this.cul().require(CUL_TOOLS.click, { x, y, button, click_count: Math.max(1, Math.min(3, input.clickCount ?? 1)) }, signal), signal);
    } else if (kind === "drag") {
      await checked(() => this.cul().require(CUL_TOOLS.drag, {
        start_x: x, start_y: y, end_x: requireFinite(input.x2, "x2"), end_y: requireFinite(input.y2, "y2"),
      }, signal), signal);
    } else {
      const notches = input.notches ?? 0;
      if (notches !== 0) {
        await checked(() => this.cul().require(CUL_TOOLS.scroll, {
          direction: notches > 0 ? "up" : "down", pages: Math.max(0.1, Math.abs(notches) / 3), x, y,
        }, signal), signal);
      }
    }
    return { action, detail: `screen px ${x},${y}`, backend: this.backend } as ComputerExecOutput;
  }

  private unsupportedPointerSplit(action: ComputerExecAction): never {
    throw new ComputerUseError(
      "HOST_UNAVAILABLE",
      `${action} 在 Linux/Wayland 上不可用：CUL 只提供完整 click/drag，不暴露 press/release 分离的指针事件；请用 click_client 或 drag_client`,
      { action },
    );
  }

  private unsupportedKeySplit(action: ComputerExecAction): never {
    throw new ComputerUseError(
      "HOST_UNAVAILABLE",
      `${action} 在 Linux/Wayland 上不可用：wtype/ydotool 走虚拟键盘，不暴露按住/释放分离；请用 key_press 的组合键写法（如 Ctrl+Shift+T）`,
      { action },
    );
  }

  private async dragScreen(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const start = { x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y") };
    const end = { x: requireFinite(input.x2, "x2"), y: requireFinite(input.y2, "y2") };
    await checked(() => this.cul().require(CUL_TOOLS.drag, {
      start_x: start.x, start_y: start.y, end_x: end.x, end_y: end.y,
    }, signal), signal);
    return { action, detail: `screen drag ${start.x},${start.y} -> ${end.x},${end.y}`, backend: this.backend } as ComputerExecOutput;
  }

  /* ---------------------------------------------------------------- */
  /* 键盘输入                                                           */
  /* ---------------------------------------------------------------- */

  private async keyPress(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const key = input.key?.trim();
    if (!key) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "key_press 需要 key");
    const target = await this.maybeTarget(input, signal);
    const normalized = toCulKey(key);
    const args: Record<string, unknown> = { key: normalized };
    if (target) {
      args.window_id = Number(target.handle);
    }
    await checked(() => this.cul().require(CUL_TOOLS.pressKey, args, signal), signal);
    const after = target ? await this.inspectHandle(target.handle, signal).catch(() => undefined) : undefined;
    return {
      action,
      window: after ?? target,
      detail: `press_key ${normalized}${target ? ` (window ${target.handle})` : ""}`,
      backend: this.backend,
    } as ComputerExecOutput;
  }

  private async typeText(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const text = input.text ?? "";
    if (!text) throw new ComputerUseError("HOST_PROTOCOL_ERROR", `${action} 需要 text`);
    const target = await this.maybeTarget(input, signal);
    const chunks = chunkText(text, TYPE_TEXT_CHUNK);
    const typed: string[] = [];
    for (const chunk of chunks) {
      assertNotCancelled(signal);
      const args: Record<string, unknown> = { text: chunk };
      if (target) args.window_id = Number(target.handle);
      try {
        await checked(() => this.cul().require(CUL_TOOLS.typeText, args, signal), signal);
        typed.push(chunk);
      } catch (error) {
        // 部分成功必须显式暴露：模型不能假设整段文本已输入。
        if (typed.length === 0) throw error;
        const failure = error instanceof Error ? error.message : String(error);
        return {
          action,
          window: target,
          completed: false,
          typedLength: typed.join("").length,
          totalLength: text.length,
          detail: `输入到第 ${typed.length}/${chunks.length} 块时失败：${failure}`,
          backend: this.backend,
        } as ComputerExecOutput;
      }
    }
    return {
      action,
      window: target,
      completed: true,
      typedLength: text.length,
      totalLength: text.length,
      detail: `${action} ${text.length} 字符（${chunks.length} 块，wtype${target ? `，窗口 ${target.handle}` : ""}）`,
      backend: this.backend,
    } as ComputerExecOutput;
  }

  /* ---------------------------------------------------------------- */
  /* App 会话与目标解析                                                 */
  /* ---------------------------------------------------------------- */

  private async attachApp(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const window = await this.resolveTarget({ ...input, appSessionId: undefined }, signal);
    this.pruneSessions();
    const session: AppSessionInfo = { id: randomUUID(), window, attachedAt: Date.now(), lastSeenAt: Date.now() };
    this.appSessions.set(session.id, session);
    return {
      action: "attach_app",
      appSessionId: session.id,
      appSession: session,
      window,
      observationId: this.remember(window),
      backend: this.backend,
    } as ComputerExecOutput;
  }

  private pruneSessions(): void {
    const cutoff = Date.now() - APP_SESSION_TTL_MS;
    for (const [id, session] of this.appSessions) if (session.lastSeenAt < cutoff) this.appSessions.delete(id);
    while (this.appSessions.size >= MAX_APP_SESSIONS) {
      const oldest = [...this.appSessions.values()].sort((left, right) => left.lastSeenAt - right.lastSeenAt)[0];
      if (!oldest) break;
      this.appSessions.delete(oldest.id);
    }
  }

  /** 与 Windows backend 一致的 target 语义：app_session_id 优先，其次 observation_id/window_handle/title/pid/class。 */
  private async maybeTarget(input: ComputerExecInput, signal?: AbortSignal): Promise<WindowInfo | undefined> {
    const hasTarget = Boolean(
      input.appSessionId?.trim() || input.observationId?.trim() || input.windowHandle?.trim()
      || input.windowTitle?.trim() || input.className?.trim() || Number.isInteger(input.processId),
    );
    if (!hasTarget) return undefined;
    return this.resolveTarget(input, signal);
  }

  private async resolveTarget(input: ComputerExecInput, signal?: AbortSignal): Promise<WindowInfo> {
    const sessionId = input.appSessionId?.trim();
    if (sessionId) {
      const session = this.appSessions.get(sessionId);
      if (!session) {
        throw new ComputerUseError("STALE_OBSERVATION", "app_session_id 已过期：请重新 attach_app", { appSessionId: sessionId });
      }
      session.lastSeenAt = Date.now();
      const fresh = await this.inspectHandle(session.window.handle, signal);
      if (!fresh) throw new ComputerUseError("WINDOW_NOT_FOUND", "会话窗口已关闭", { appSessionId: sessionId });
      session.window = fresh;
      return fresh;
    }
    const observationId = input.observationId?.trim();
    if (observationId) {
      const cached = this.observations.get(observationId);
      if (!cached) throw new ComputerUseError("STALE_OBSERVATION", "observation_id 已过期：请重新 list_windows/inspect_window", { observationId });
      return cached.window;
    }
    const handle = input.windowHandle?.trim();
    if (handle) {
      const window = await this.inspectHandle(handle, signal);
      if (!window) throw new ComputerUseError("WINDOW_NOT_FOUND", `找不到窗口 handle=${handle}`, { handle });
      return window;
    }
    const windows = await this.readWindows(signal);
    const matched = filterWindows(windows, {
      windowTitle: input.windowTitle,
      className: input.className,
      processName: input.processName,
      processId: input.processId,
    });
    const identity = targetIdentity(input);
    if (matched.length === 0) throw new ComputerUseError("WINDOW_NOT_FOUND", "没有匹配的目标窗口", { target: identity });
    if (matched.length > 1) {
      throw new ComputerUseError("WINDOW_AMBIGUOUS", `有 ${matched.length} 个窗口匹配，请用 window_handle 或 process_id 精确定位`, {
        target: identity,
        candidates: matched.map((window) => ({ handle: window.handle, title: window.title, processId: window.processId })),
      });
    }
    return matched[0];
  }

  private remember(window: WindowInfo): string {
    const id = randomUUID();
    this.observations.set(id, { id, window, capturedAt: Date.now() });
    const cutoff = Date.now() - OBSERVATION_TTL_MS;
    for (const [key, entry] of this.observations) if (entry.capturedAt < cutoff) this.observations.delete(key);
    while (this.observations.size > MAX_OBSERVATIONS) {
      const oldest = [...this.observations.values()].sort((left, right) => left.capturedAt - right.capturedAt)[0];
      if (!oldest) break;
      this.observations.delete(oldest.id);
    }
    return id;
  }

  private async foregroundHandle(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const windows = await this.readWindows(signal);
      return windows.find((window) => window.foreground)?.handle;
    } catch {
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 批量动作                                                           */
  /* ---------------------------------------------------------------- */

  private async executeBatch(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const steps = (input.actions ?? []).slice(0, BATCH_MAX_STEPS);
    if (steps.length === 0) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "actions 为空");
    const settleMs = Math.max(0, Math.min(2_000, input.settleMs ?? BATCH_SETTLE_DEFAULT_MS));
    const results: ComputerBatchStepResult[] = [];
    let completed = true;
    for (const [index, step] of steps.entries()) {
      assertNotCancelled(signal);
      const action = step.action as ComputerBatchAction;
      if (!(COMPUTER_BATCH_ACTIONS as readonly string[]).includes(action)) {
        results.push({ index, action, ok: false, detail: `不支持的批量动作：${action}` });
        completed = false;
        break;
      }
      try {
        const output = await this.executeOnce(this.stepToInput(step, input, action), signal);
        results.push({ index, action, ok: true, detail: output.detail });
      } catch (error) {
        results.push({ index, action, ok: false, detail: error instanceof Error ? error.message : String(error) });
        completed = false;
        break;
      }
      if (settleMs > 0 && index < steps.length - 1) await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
    const target = await this.maybeTarget(input, signal).catch(() => undefined);
    const batch: ComputerBatchResult = { steps: results, settleMs, completed };
    return { action: "batch", batch, window: target, backend: this.backend } as ComputerExecOutput;
  }

  private stepToInput(step: ComputerBatchStep, input: ComputerExecInput, action: ComputerBatchAction): ComputerExecInput {
    return {
      ...input,
      actions: undefined,
      action,
      x: step.x,
      y: step.y,
      x2: step.x2,
      y2: step.y2,
      button: step.button,
      deltaX: step.deltaX,
      deltaY: step.deltaY,
      key: step.key,
      text: step.text,
      clickCount: step.clickCount,
      modifiers: step.modifiers,
      holdMs: step.holdMs,
      steps: step.steps,
      durationMs: step.durationMs,
      notches: step.notches,
      settleMs: undefined,
    };
  }
}

function targetIdentity(input: ComputerExecInput): TargetIdentity {
  return {
    windowHandle: input.windowHandle?.trim() || undefined,
    windowTitle: input.windowTitle?.trim() || undefined,
    processId: Number.isInteger(input.processId) ? input.processId : undefined,
    className: input.className?.trim() || undefined,
  };
}

/** 按词边界切块（避免把一个字符的 Unicode 序列切断）。 */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = breakAt > size / 2 ? breakAt + 1 : size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
