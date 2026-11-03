import { validateComputerAction } from "../../../capabilities/ComputerUsePolicy";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
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
import { resolveCulBinary, runCulDoctorAsync, type CulDoctorReport } from "./culBinary";
import { CulMcpClient } from "./culClient";
import {
  CUL_TOOLS,
  clientDipToScreenPhysical,
  compactWindowInfo,
  controlBoundsAreZeroOrigin,
  controlFingerprint,
  culFailure,
  filterWindows,
  findControl,
  hasDialogRole,
  imageScaleFromMeta,
  looksLikeChromiumWindow,
  matchesSelector,
  parseTesseractTsv,
  stripUnreliableControlBounds,
  toControlInfo,
  toCulKey,
  toWindowInfo,
  type CulAccessibilityNode,
  type CulWindow,
} from "./culProtocol";
import { readHyprlandMonitors } from "./hyprlandMonitors";
import {
  ACCESSIBILITY_MAX_NODES,
  ACCESSIBILITY_MAX_PAGES,
  collectAccessibilityTree,
  toAccessibilityPage,
} from "./accessibilityTree";
import { keyChordToKeycodes, YdotoolInput, type YdotoolRunner } from "./ydotool";
import { createHyprlandWindowControl, type HyprlandWindowControl, type HyprlandWindowRect } from "./hyprlandWindows";

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
/**
 * GTK 的 AT-SPI bounds 原点实测恒为 (0,0)（宽高是真的），照坐标点会稳定点到客户区左上角。
 * 这个提示会随 `inspect_controls` / `find_control` 的 detail 一起回给模型。
 */
const ZERO_ORIGIN_BOUNDS_HINT =
  "该窗口的 AT-SPI bounds 原点全部为 0（GTK 已知问题：GTK3 HiDPI extents / GTK4 zero-origin bounds），控件坐标已省略、不能用于 click_client：有语义动作时用 invoke_control / set_control_value，需要坐标时用 ocr_window 拿文字行坐标再点";

/**
 * 需要串行执行的动作：任何可能改变焦点或输入状态的调用。
 *
 * 借鉴 LCU 的 Linux 输入队列：它把所有「可能移动焦点/输东西」的调用排进一个队列，
 * 并在真正下发前再确认一次焦点，避免两个并发调用互相穿插（后一个把焦点抢走，前一个
 * 的按键落到别的窗口）。这里在 backend 层用一条 Promise 链做同样的串行化。
 */
const SERIALIZED_ACTIONS: ReadonlySet<string> = new Set([
  "attach_app", "focus_window",
  "invoke_control", "set_control_value",
  "screenshot_window",
  "move_window", "resize_window",
  "move_client", "click_client", "drag_client", "scroll_client",
  "mouse_down_client", "mouse_up_client", "drag_screen",
  "key_press", "key_down", "key_up", "type_text", "paste_text",
  "mouse_move", "mouse_click", "mouse_drag", "scroll",
]);

type MouseButton = "left" | "right" | "middle";

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

/** 窗口集合（handle + 标题）是否发生变化：语义动作的便宜生效判据（`list_windows` ~100ms）。 */
function windowsChanged(before: WindowInfo[], after: WindowInfo[]): boolean {
  const key = (windows: WindowInfo[]) => windows.map((window) => `${window.handle}:${window.title}`).sort().join("|");
  return key(before) !== key(after);
}

function requireFinite(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", `${name} 必须是有限数字`, { value });
  return number;
}

/** Computer Use 协议的修饰键 → 键名（交给 ydotool 按 evdev keycode 按住）。 */
function modifierKeyName(modifier: string): string {
  switch (modifier.toLowerCase()) {
    case "ctrl": return "Ctrl";
    case "shift": return "Shift";
    case "alt": return "Alt";
    case "win": return "Super";
    default:
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", `不认识的修饰键：${modifier}`, { modifier });
  }
}

/** 拖拽插值/长按用的等待（可被取消时不强制打断：这些停顿都在 5 秒以内）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
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
 *   4. 用 ydotool 补 CUL 没有的按下/松开分离（见 `ydotool.ts`）；
 *   5. 把 AT-SPI 树翻页收全（见 `accessibilityTree.ts`）；
 *   6. 保持与 `ComputerUseBackend` 一致的状态/错误契约。
 *
 * 能力边界（Wayland 的真实限制，写在这里免得以后重新踩。**每条都经真机验证**，
 * 2026-10-27 Omarchy / Hyprland 0.56.2 / eDP-1 2160×1440 @1.6）：
 * - 没有后台截图：portal 只能截前台；`background=true` 会被显式拒绝。
 * - press/release **可以**分离：走 ydotool（`key 42:1` / `key 42:0` / `click 0x40|0x80`），
 *   状态跨进程持久；不能用 wtype（虚拟键盘协议在进程退出时释放）也不能用
 *   Hyprland 的 `hl.dsp.send_key_state`（实测不产生持久状态）。
 * - AT-SPI 对 Electron/Qt/Tauri **不是**只暴露 application/frame：树是完整的，但
 *   `get_app_state` 只内联前 ~20 个节点，且 `max_nodes` 对内联数量无效，必须用
 *   `get_tree_page` 翻页；不翻页时确实只能看到匿名 Section（所以要 ocr 兜底）。
 */
export class LinuxComputerUseBackend implements ComputerUseBackend {
  readonly platform = "linux" as const;
  readonly backend = "linux-cul" as const;

  private client?: CulMcpClient;
  private doctor?: DoctorCache;
  private monitorsCache?: { at: number; monitors: Awaited<ReturnType<typeof readHyprlandMonitors>> };
  private readonly observations = new Map<string, CachedObservation>();
  private readonly appSessions = new Map<string, AppSessionInfo>();
  private readonly input: YdotoolInput;
  private readonly windowControl: HyprlandWindowControl;
  private diagnosticsRefresh?: Promise<void>;
  /** 后端按下、尚未释放的 keycode / 鼠标按钮（任务结束或动作失败时兜底释放）。 */
  private readonly heldKeys = new Set<number>();
  private readonly heldButtons = new Set<MouseButton>();
  /** 输入/焦点动作的串行队列（同 LCU 的 input queue）。 */
  private inputLock: Promise<unknown> = Promise.resolve();

  /**
   * @param options.pasteViaClipboard 注入剪贴板写入（默认走 Electron `clipboard`）；
   *   注入后 `paste_text` 会写剪贴板并打 Ctrl+V，而不是逐字 wtype。
   * @param options.ydotoolRunner 注入 ydotool 执行器（单测不碰真机）。
   */
  constructor(private readonly options: {
    ydotoolRunner?: YdotoolRunner;
    pasteViaClipboard?: (text: string) => void | Promise<void>;
    /**
     * Hyprland 窗口几何控制（move_window/resize_window）。CUL 自己的 move_window/
     * resize_window 在 Hyprland 上直接失败（它只有 GNOME Shell 扩展和 X11/EWMH 两条路），
     * 所以这里走 hyprctl 的 Lua API。
     */
    windowControl?: HyprlandWindowControl;
  } = {}) {
    this.input = new YdotoolInput({ runner: options.ydotoolRunner });
    this.windowControl = options.windowControl ?? createHyprlandWindowControl();
  }


  /** 工具注册时的可用性判定：CUL 二进制在不在（不 spawn、不阻塞）。 */
  get available(): boolean {
    return resolveCulBinary() !== undefined;
  }

  /**
   * 能力状态。
   *
   * **不在 status() 里 spawn `computer-use-linux doctor`**：这个方法会被工具注册、
   * 设置页和 agent 探针同步调用，而 doctor 要 1–3 秒。这里只做文件存在性判断 +
   * 读已缓存的 doctor；缓存没有时由 `ensureDiagnostics()` 在后台补一次（不阻塞本次调用）。
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
    // 首次 status() 时后台补 doctor（不 await、不阻塞）；结果下次调用可见。
    void this.ensureDiagnostics();
    const doctor = this.doctor?.report;
    const readiness = doctor?.readiness as {
      can_capture_screenshots?: boolean;
      screenshot_capture_status?: string;
      blockers?: string[];
      warnings?: string[];
    } | undefined;
    const missingDependencies = readiness?.blockers ?? [];
    const warnings = readiness?.warnings ?? [];
    return {
      platform: this.platform,
      backend: this.backend,
      supported: true,
      missingDependencies,
      reason: warnings.length > 0 ? warnings.join("；") : undefined,
      detail: [
        `ready (${this.backend}: computer-use-linux MCP)`,
        `binary=${binary}`,
        readiness?.screenshot_capture_status ? `screenshot=${readiness.screenshot_capture_status}` : undefined,
        readiness?.can_capture_screenshots === false ? "can_capture_screenshots=false" : undefined,
        doctor?.capabilities?.preferred?.input ? `input=${doctor.capabilities.preferred.input}` : undefined,
        doctor?.capabilities?.window_control?.length ? `window_control=${doctor.capabilities.window_control.join(",")}` : undefined,
        this.input.available ? "press_release=ydotool" : "press_release=unavailable",
        this.client?.pid ? `pid=${this.client.pid}` : undefined,
      ].filter(Boolean).join(" "),
      hostPid: this.client?.pid,
    };
  }

  /**
   * 显式跑一次 `computer-use-linux doctor` 并缓存结果（诊断/设置页用，不阻塞常规动作）。
   */
  refreshDiagnostics(): Promise<void> {
    return this.ensureDiagnostics({ force: true });
  }

  /** 后台刷一次 doctor（同一时刻只跑一个；失败静默，后续 status() 会重试）。 */
  private ensureDiagnostics(options: { force?: boolean } = {}): Promise<void> {
    if (this.diagnosticsRefresh) return this.diagnosticsRefresh;
    if (!options.force && this.doctor) return Promise.resolve();
    const binary = resolveCulBinary({ envBin: process.env.MYBUDDY_CUL_BIN });
    if (!binary) return Promise.resolve();
    this.diagnosticsRefresh = (async () => {
      try {
        const report = await runCulDoctorAsync(binary);
        if (report) this.doctor = { at: Date.now(), report };
      } catch {
        // doctor 是诊断增强，失败不影响动作；下次 status() 再试。
      } finally {
        this.diagnosticsRefresh = undefined;
      }
    })();
    return this.diagnosticsRefresh;
  }

  async shutdown(): Promise<void> {
    // 先释放按住状态，再关 MCP：否则一个漏掉的 key_down 会把用户桌面留在按着修饰键的状态。
    await this.releaseHeldInput().catch(() => undefined);
    await this.client?.close();
    this.client = undefined;
    this.doctor = undefined;
    this.monitorsCache = undefined;
    this.observations.clear();
    this.appSessions.clear();
  }

  async execute(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    validateComputerAction(input);
    const action = input.actions?.length ? "batch" : input.action;
    if (!action) throw new Error("computer_exec 需要 action 或 actions");
    if (action === "status") return { action, ...this.status() } as ComputerExecOutput;
    // 批量里全是输入步骤；读类动作（list/inspect/ocr）不进队列，避免拖慢观察。
    if (action === "batch" || SERIALIZED_ACTIONS.has(action)) {
      return this.withInputLock(() => this.executeUnlocked(input, signal));
    }
    return this.executeUnlocked(input, signal);
  }

  private async executeUnlocked(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    if (input.actions?.length) return this.executeBatch(input, signal);
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

  /**
   * 串行执行 + 失败清理（借鉴 LCU 的 input queue / input state）。
   *
   * 1. **串行**：焦点和输入是全局状态，两个并发 computer_exec 穿插会把按键打到错误窗口。
   * 2. **失败清理**：动作抛错或被取消时，只释放「这次动作自己按下、现在还按着」的键/按钮；
   *    之前动作已经按住的（跨动作按住是受支持的能力）保持不动，避免把用户/模型的组合键拆掉。
   */
  private async withInputLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.inputLock;
    let release!: () => void;
    // 占住队尾（而不是等 task 结束再改 inputLock）：失败清理也在锁内，不会和下一个动作的
    // ydotool 写入交错。
    this.inputLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const keysBefore = new Set(this.heldKeys);
    const buttonsBefore = new Set(this.heldButtons);
    try {
      return await task();
    } catch (error) {
      await this.releaseHeldSince(keysBefore, buttonsBefore).catch(() => undefined);
      throw error;
    } finally {
      release();
    }
  }

  /** 释放「按之前快照对比新增」的按住状态（失败清理用）。 */
  private async releaseHeldSince(keysBefore: Set<number>, buttonsBefore: Set<MouseButton>): Promise<void> {
    const addedKeys = [...this.heldKeys].filter((code) => !keysBefore.has(code)).reverse();
    const addedButtons = [...this.heldButtons].filter((button) => !buttonsBefore.has(button));
    for (const code of addedKeys) {
      try {
        await this.input.setKeycodesHeld([code], false);
      } catch { /* 尽力而为：ydotool 不可用时没什么可释放 */ }
      this.heldKeys.delete(code);
    }
    for (const button of addedButtons) {
      try {
        await this.input.setButtonHeld(button, "up");
      } catch { /* 同上 */ }
      this.heldButtons.delete(button);
    }
  }

  /**
   * 释放后端记录的全部按住状态（任务结束/取消/关闭后端时调用）。
   *
   * ydotool 的按住状态跨进程持久，agent 漏掉 `key_up` 会把用户桌面留在「按着 Ctrl」的状态。
   * 返回实际释放了什么，便于日志/断言。
   */
  async releaseHeldInput(): Promise<{ keys: number[]; buttons: string[] }> {
    return this.withInputLock(async () => {
      const keys = [...this.heldKeys].reverse();
      const buttons = [...this.heldButtons] as MouseButton[];
      this.heldKeys.clear();
      this.heldButtons.clear();
      for (const code of keys) {
        try {
          await this.input.setKeycodesHeld([code], false);
        } catch { /* 尽力而为 */ }
      }
      for (const button of buttons) {
        try {
          await this.input.setButtonHeld(button, "up");
        } catch { /* 尽力而为 */ }
      }
      return { keys, buttons: buttons as string[] };
    });
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
      case "mouse_down_client": return this.pointerSplit(action, input, "down", signal);
      case "mouse_up_client": return this.pointerSplit(action, input, "up", signal);
      case "key_press": return this.keyPress(action, input, signal);
      case "type_text": return this.typeText(action, input, signal);
      case "paste_text": return this.pasteText(action, input, signal);
      case "key_down": return this.keySplit(action, input, true, signal);
      case "key_up": return this.keySplit(action, input, false, signal);
      case "drag_screen": return this.dragScreen(action, input, signal);
      case "move_window": return this.windowGeometryAction(action, input, signal);
      case "resize_window": return this.windowGeometryAction(action, input, signal);
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

  /** 读已缓存的 doctor（TTL 内不重复 spawn）；设置页/探针要看真话时用 `refreshDiagnostics()`。 */
  cachedDoctor(): CulDoctorReport | undefined {
    const binary = resolveCulBinary({ envBin: process.env.MYBUDDY_CUL_BIN });
    if (!binary) return undefined;
    if (this.doctor && Date.now() - this.doctor.at < DOCTOR_TTL_MS) return this.doctor.report;
    return undefined;
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

  /**
   * 确保目标在前台（借鉴 LCU 的 Linux 输入翻译）。
   *
   * Wayland 上 uinput 的点击落在「指针下面的窗口」，不认 window_id：目标在后台时点击会
   * 打到遮挡它的窗口或另一个 workspace。LCU 的做法是「激活 → 复核焦点，失败就拒绝发送」；
   * 这里照做——宁可明确报 FOCUS_FAILED，也不要把点击悄悄打偏。
   */
  private async ensureForeground(window: WindowInfo, signal?: AbortSignal): Promise<WindowInfo> {
    if (window.foreground) return window;
    await this.activateWindow(window, signal);
    const fresh = await this.inspectHandle(window.handle, signal).catch(() => undefined);
    if (!fresh) throw new ComputerUseError("WINDOW_NOT_FOUND", "激活后目标窗口消失了", { handle: window.handle });
    if (!fresh.foreground) {
      throw new ComputerUseError(
        "FOCUS_FAILED",
        "目标窗口不在前台：点击会落到别的窗口上。先确认窗口可见（没有被全屏/浮动窗口盖住），或手动切到它所在的 workspace 再重试",
        { handle: window.handle, title: fresh.title },
      );
    }
    return fresh;
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
    let target = await this.resolveTarget(input, signal);
    // raise 一个平铺窗口会重排 Hyprland 布局（切 workspace / 重新平铺），客户区尺寸随之变化。
    // 这时截出来的是「旧几何的图 + 新几何的窗口」，模型换算会全错；但重截一次就对齐了，
    // 所以先按新几何重试一次，仍然在变才报错（不要一遇到重排就把动作判死）。
    let result: Awaited<ReturnType<LinuxComputerUseBackend["captureWindowImage"]>> | undefined;
    let after: WindowInfo | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      result = await this.captureWindowImage(target, input.ensureForeground !== false, signal);
      after = await this.inspectHandle(target.handle, signal).catch(() => undefined);
      if (!after || (after.clientRect.width === target.clientRect.width && after.clientRect.height === target.clientRect.height)) break;
      if (attempt === 0) target = after;
    }
    if (after && (after.clientRect.width !== target.clientRect.width || after.clientRect.height !== target.clientRect.height)) {
      throw new ComputerUseError("CAPTURE_FAILED", "截图期间窗口几何发生变化（已按新几何重试一次仍不一致）", { before: target, after });
    }
    return {
      action,
      window: after ?? target,
      screenshot: result!.bytes,
      screenshotMimeType: "image/jpeg",
      imageScale: result!.imageScale,
      imageSize: result!.imageSize,
      artifactFileName: `window-${target.handle}.jpg`,
      capture: result!.details,
      observationId: this.remember(after ?? target),
      backend: this.backend,
      detail: `window crop via ${String(result!.source ?? "portal")}`,
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
    if (!shot.image) throw new ComputerUseError("CAPTURE_FAILED", "OCR 前截图失败：需可用桌面会话与可截图的目标窗口；此错误尚未执行文字识别", { window: target });
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
      throw new ComputerUseError("OCR_UNAVAILABLE", `tesseract 执行失败：${error instanceof Error ? error.message : String(error)}；请核对语言包 ${descriptor.defaultLanguages.join("+")}，安装提示：${descriptor.installHint}；不代表用户桌面损坏`);
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 无障碍树                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * 读完整 AT-SPI 树。
   *
   * `get_app_state` 只内联前 ~20 个节点（`accessibility_tree_truncated=true`），而
   * `max_nodes` 对内联数量无效（实测 1000/5000/10000 都只回 12–13 个）。剩下的
   * 节点必须用 `get_tree_page` 按服务端给的 `next_offset` 逐页取回来 —— 不翻页时
   * Electron 应用只能看到匿名 Section，所有可交互控件都在后几页（实测 63 节点树里
   * 10 个 Button / 1 个 Entry / 1 个 ComboBox 全在第 2、3 页）。
   */
  private async readAccessibilityNodes(window: WindowInfo, input: ComputerExecInput, signal?: AbortSignal): Promise<{ nodes: ControlInfo[]; truncated: boolean; pages: number }> {
    const first = await checked(() => this.cul().require(CUL_TOOLS.getAppState, {
      window_id: Number(window.handle),
      include_screenshot: false,
      max_nodes: input.maxNodes ?? 400,
      ...(input.maxDepth ? { max_depth: input.maxDepth } : {}),
    }, signal), signal);
    const firstNodes = Array.isArray(first.data.accessibility_tree)
      ? first.data.accessibility_tree as CulAccessibilityNode[]
      : [];
    // CUL 把树 compact 到内联上限（实测 ~37），**即使还有节点没内联也只写
    // `accessibility_tree_truncated: false`**，真正「一共多少节点」只在 spill 里。
    // 不看 spill 就会漏掉整页的可交互控件（实测 Nautilus 的 10 个 grid cell 全在第 2 页）。
    const spill = first.data.accessibility_tree_spill as { node_count?: number; inline_node_count?: number } | undefined;
    const spillTotal = Number(spill?.node_count);
    const collected = await collectAccessibilityTree(firstNodes, first.data.accessibility_tree_truncated === true, {
      maxPages: ACCESSIBILITY_MAX_PAGES,
      maxNodes: Math.max(1, Math.min(ACCESSIBILITY_MAX_NODES, input.maxNodes ?? ACCESSIBILITY_MAX_NODES)),
      totalNodes: Number.isFinite(spillTotal) && spillTotal > 0 ? spillTotal : undefined,
      fetchPage: async (offset) => {
        const page = await checked(() => this.cul().require(CUL_TOOLS.getTreePage, { offset }, signal), signal);
        return toAccessibilityPage(page.data);
      },
    });
    return {
      nodes: collected.nodes.map((node) => toControlInfo(node, window)),
      truncated: collected.truncated,
      pages: collected.pages,
    };
  }

  private async inspectControls(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const target = await this.resolveTarget(input, signal);
    const { nodes: rawNodes, truncated, pages } = await this.readAccessibilityNodes(target, input, signal);
    const boundsReliable = !controlBoundsAreZeroOrigin(rawNodes);
    const nodes = boundsReliable ? rawNodes : stripUnreliableControlBounds(rawNodes);
    // 只有「翻完所有页仍然几乎没有节点」才是真的没有语义树；页数 >1 说明树是完整的。
    const detail = [
      rawNodes.length <= 3
        ? looksLikeChromiumWindow(target)
          ? "Chromium/Electron 窗口没有暴露 AT-SPI 树：这类应用要平台无障碍桥初始化才注册（启动时 GNOME_ACCESSIBILITY=1 或 AT-SPI 的 IsEnabled=true）并且带 --force-renderer-accessibility；已运行的浏览器改不了，重启时加 GNOME_ACCESSIBILITY=1 才有语义树。现在可改用 browser_exec / ui_exec，或 ocr_window + click_client；MyBuddy 自己已默认设置"
          : "AT-SPI 没有返回可用控件（应用未启用无障碍或树确实为空）：改用 ocr_window + click_client 坐标点击"
        : truncated
          ? `语义树仍有 ${rawNodes.length} 个节点未收全（页数上限）；如果要找的控件不在结果里，可提高 max_nodes 或改用 ocr_window`
          : "",
      boundsReliable ? "" : ZERO_ORIGIN_BOUNDS_HINT,
    ].filter(Boolean).join("；");
    return {
      action,
      window: target,
      controls: nodes,
      uiaAvailable: nodes.length > 1,
      truncated,
      accessibilityPages: pages,
      boundsReliable,
      observationId: this.remember(target),
      backend: this.backend,
      detail: detail || undefined,
    } as ComputerExecOutput;
  }

  private async findControlAction(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const target = await this.resolveTarget(input, signal);
    const { nodes } = await this.readAccessibilityNodes(target, input, signal);
    const boundsReliable = !controlBoundsAreZeroOrigin(nodes);
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
    return {
      action,
      window: target,
      control: boundsReliable ? found : stripUnreliableControlBounds([found])[0],
      boundsReliable,
      backend: this.backend,
      detail: boundsReliable ? undefined : ZERO_ORIGIN_BOUNDS_HINT,
    } as ComputerExecOutput;
  }

  /**
   * 语义动���（`invoke_control` / `set_control_value`）+ 执行后复核。
   *
   * 真机问题（2026-10-27）：`perform_action` 返回 ok 但界面没有反应——GTK 的输入
   * 抓取/弹窗会把这次激活吞掉（zenity 的 OK 在 set_value 之后偶发不生效）。
   * CUL 自己对元素点击不做结果校验，所以后端补一层：
   *
   * 1. **精确 element_index**：用 AT-SPI 快照里的 `index`，不再用数组位置反查
   *    （分页收集时两者可能错位，见 `ControlInfo.elementIndex`）。
   * 2. **先复核便宜的观测**（窗口集合/标题/目标是否还在）：能判定生效就不再多读树。
   * 3. **看不出变化时**再读一次树比较指纹；如果目标是**模态对话框**，按钮重复激活是
   *    安全的（对话框按钮 = 确认/关闭），所以允许一次有界重试；其它控件不重试
   *    （LCU 的结论一致：不要盲目重复点击，像 toggle/复选框会被点反）。
   * 4. `set_control_value` 走幂等路径：回读文本不一致就重试一次并再回读，结论写进
   *    `verified`；读不到文本时给 `undefined`（不假装成功）。
   */
  private async invokeControl(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal, setValue = false): Promise<ComputerExecOutput> {
    const target = await this.ensureForeground(await this.resolveTarget(input, signal), signal);
    const selector = {
      controlRuntimeId: input.controlRuntimeId,
      controlName: input.controlName,
      automationId: input.automationId,
      controlType: input.controlType,
      controlClassName: input.controlClassName,
      exactName: input.exactName,
    };
    const act = async (): Promise<{ nodes: ControlInfo[]; found: ControlInfo }> => {
      const { nodes } = await this.readAccessibilityNodes(target, input, signal);
      const found = findControl(nodes, selector, { maxDepth: input.maxDepth });
      if (!found) {
        throw new ComputerUseError("CONTROL_NOT_FOUND", "AT-SPI 树里没有匹配的控件（可用 ocr_window + click_client 走坐标点击）", { selector });
      }
      const index = found.elementIndex ?? this.indexForObjectRef(nodes, found);
      if (setValue) {
        await checked(() => this.cul().require(CUL_TOOLS.setValue, { element_index: index, value: input.text ?? "" }, signal), signal);
      } else {
        const args: Record<string, unknown> = { element_index: index };
        if (input.controlName) args.name = input.controlName;
        await checked(() => this.cul().require(CUL_TOOLS.performAction, args, signal), signal);
      }
      return { nodes, found };
    };

    const windowsBefore = await this.readWindows(signal).catch(() => [] as WindowInfo[]);
    let result = await act();
    let after = await this.inspectHandle(target.handle, signal).catch(() => undefined);
    let verified: boolean | undefined;
    let verifyDetail: string | undefined;
    let retried = false;

    if (!after) {
      // 窗口关了 = 动作确实生效
      verified = true;
    } else if (setValue) {
      let text = await this.readControlText(target, result.found, input, signal);
      if (input.text !== undefined && text !== undefined && text !== input.text) {
        // set_value 幂等：允许一次有界重试
        result = await act();
        after = await this.inspectHandle(target.handle, signal).catch(() => after);
        text = await this.readControlText(target, result.found, input, signal);
        retried = true;
      }
      if (input.text === undefined || text === undefined) {
        verified = undefined;
      } else {
        verified = text === input.text;
        if (!verified) {
          verifyDetail = `回读文本 ${JSON.stringify(text)} 与请求 ${JSON.stringify(input.text)} 不一致${retried ? "（已重试一次）" : ""}`;
        }
      }
    } else {
      const windowsAfter = await this.readWindows(signal).catch(() => [] as WindowInfo[]);
      if (windowsChanged(windowsBefore, windowsAfter)) {
        verified = true;
      } else {
        // 便宜观测看不出变化：读树比较指纹（可能只是 a11y 内部状态变了）
        const recheck = await this.readAccessibilityNodes(target, input, signal).catch(() => undefined);
        if (recheck && controlFingerprint(result.nodes) !== controlFingerprint(recheck.nodes)) {
          verified = true;
        } else if (hasDialogRole(result.nodes)) {
          // 模态对话框按钮：被输入抓取吞掉一次很常见，重复激活是安全的（确认/关闭语义）
          result = await act();
          after = await this.inspectHandle(target.handle, signal).catch(() => undefined);
          retried = true;
          const afterRetry = after ? await this.readWindows(signal).catch(() => [] as WindowInfo[]) : [];
          if (!after || windowsChanged(windowsAfter, afterRetry)) {
            verified = true;
          } else {
            const final = await this.readAccessibilityNodes(target, input, signal).catch(() => undefined);
            verified = final ? controlFingerprint(result.nodes) !== controlFingerprint(final.nodes) : undefined;
            if (verified === false) verifyDetail = "模态对话框按钮激活后仍看不出变化（已重试一次）：可能被输入抓取吞掉，请重新观察或用 expected_outcomes 验证";
          }
        } else {
          verified = false;
          verifyDetail = "看不出可观测变化：可能被弹窗/输入抓取吞掉，也可能本来就是无副作用的动作。需要确认就重新观察或加 expected_outcomes，不要盲目重复点击";
        }
      }
    }

    const output: ComputerExecOutput = {
      action,
      window: after ?? target,
      // 这里只回报控件身份，不回传坐标：GTK 的 bounds 原点不可信（见 ZERO_ORIGIN_BOUNDS_HINT）。
      control: controlBoundsAreZeroOrigin(result.nodes) ? stripUnreliableControlBounds([result.found])[0] : result.found,
      observation: after ? { targetBefore: target, targetAfter: after, foregroundAfter: after.foreground ? after.title : undefined, focusPreserved: after.foreground } : undefined,
      backend: this.backend,
      verified,
      detail: [retried ? "已自动重试一次" : "", verifyDetail ?? ""].filter(Boolean).join("；") || undefined,
    };
    return output;
  }

  /** 读回控件当前文本（`set_control_value` 校验；runtimeId 变了就按名字/角色兜底匹配）。 */
  private async readControlText(target: WindowInfo, previous: ControlInfo, input: ComputerExecInput, signal?: AbortSignal): Promise<string | undefined> {
    const { nodes } = await this.readAccessibilityNodes(target, input, signal).catch(() => ({ nodes: [] as ControlInfo[], truncated: false, pages: 0 }));
    const found = nodes.find((node) => node.runtimeId === previous.runtimeId)
      ?? nodes.find((node) => node.controlType === previous.controlType && node.name === previous.name);
    return found?.text;
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
    const modifiers = input.modifiers ?? [];
    // 参数校验放在最前面：不静默忽略（modifiers/holdMs 对 move 没有意义，悄悄丢掉会让
    // 模型以为按住或长按生效了），同时保证在真正按下任何键之前就失败。
    if (kind === "move" && (modifiers.length > 0 || (input.holdMs ?? 0) > 0)) {
      throw new ComputerUseError(
        "HOST_PROTOCOL_ERROR",
        "move_client 不接受 modifiers/hold_ms：要按住修饰键点按请用 click_client 的同名参数，要长按请用 mouse_down_client + mouse_up_client",
        { action, modifiers, holdMs: input.holdMs },
      );
    }
    const target = await this.ensureForeground(await this.resolveTarget(input, signal), signal);
    const point = clientDipToScreenPhysical(target, requireFinite(input.x, "x"), requireFinite(input.y, "y"));
    const button = input.button ?? "left";
    // CUL 的 click/scroll/drag 都不接受 modifier 参数，所以修饰键只能由 ydotool 真的按住
    // （实测 `42:1`/`42:0` 跨进程持久），动作结束再释放；任何一步失败都要保证释放，
    // 否则用户桌面会残留一个按住的修饰键（比动作失败更糟）。
    const held = await this.holdModifiers(modifiers);
    try {
      switch (kind) {
        case "move":
          // CUL 没有单独的「移动指针」工具；`scroll pages=0` 只定位不滚动（实测 ok:true 且游标移动）。
          await checked(() => this.cul().require(CUL_TOOLS.scroll, { direction: "down", pages: 0, x: point.x, y: point.y }, signal), signal);
          break;
        case "click": {
          const clickCount = Math.max(1, Math.min(3, input.clickCount ?? 1));
          const holdMs = Math.max(0, Math.min(5_000, input.holdMs ?? 0));
          if (holdMs > 0) {
            // 长按：CUL 的 click 是原子的 down+up，中间没有停顿；holdMs>0 时改走
            // ydotool 的 down → 停顿 → up（实测 0x40/0x80 跨进程持久）。
            for (let index = 0; index < clickCount; index += 1) {
              assertNotCancelled(signal);
              await this.input.setButtonHeld(button, "down");
              try {
                await delay(holdMs);
              } finally {
                await this.input.setButtonHeld(button, "up");
              }
            }
          } else {
            for (let index = 0; index < clickCount; index += 1) {
              assertNotCancelled(signal);
              await checked(() => this.cul().require(CUL_TOOLS.click, { x: point.x, y: point.y, button, click_count: 1 }, signal), signal);
            }
          }
          break;
        }
        case "drag": {
          const end = clientDipToScreenPhysical(target, requireFinite(input.x2, "x2"), requireFinite(input.y2, "y2"));
          await this.dragPath(point, end, input, button, signal);
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
    } finally {
      await held.release();
    }
    const before = target;
    const after = await this.inspectHandle(target.handle, signal).catch(() => undefined);
    return {
      action,
      window: after ?? target,
      observation: after
        ? { targetBefore: before, targetAfter: after, foregroundAfter: after.foreground ? after.title : undefined, focusPreserved: after.foreground }
        : undefined,
      detail: `${kind} at screen px ${point.x},${point.y} (client dip ${input.x},${input.y}, scale ${target.scaleFactor})${
        modifiers.length > 0 ? ` with ${modifiers.join("+")}` : ""
      }`,
      backend: this.backend,
    } as ComputerExecOutput;
  }

  /**
   * 拖拽路径：`durationMs`/`steps` 有值时按插值分段移动。
   *
   * Wayland 下 CUL 的 `drag` 是一次性 from→to（中间没有 move 事件），部分应用会把它
   * 当成「瞬移点击」而不是拖拽；需要真实轨迹时用 ydotool 按住按钮 + 分段移动 + 松开。
   */
  private async dragPath(
    start: { x: number; y: number },
    end: { x: number; y: number },
    input: ComputerExecInput,
    button: "left" | "right" | "middle",
    signal?: AbortSignal,
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, input.steps ?? 1));
    const durationMs = Math.max(0, Math.min(10_000, input.durationMs ?? 0));
    if (steps <= 1 && durationMs <= 0) {
      await checked(() => this.cul().require(CUL_TOOLS.drag, { start_x: start.x, start_y: start.y, end_x: end.x, end_y: end.y }, signal), signal);
      return;
    }
    const settle = durationMs > 0 ? durationMs / steps : 0;
    // 先把指针放到起点，再按住按钮、分段移动、最后松开：中间每一步都是真 move 事件。
    await checked(() => this.cul().require(CUL_TOOLS.scroll, { direction: "down", pages: 0, x: start.x, y: start.y }, signal), signal);
    await this.input.setButtonHeld(button, "down");
    try {
      for (let index = 1; index <= steps; index += 1) {
        assertNotCancelled(signal);
        const ratio = index / steps;
        const x = Math.round(start.x + (end.x - start.x) * ratio);
        const y = Math.round(start.y + (end.y - start.y) * ratio);
        await checked(() => this.cul().require(CUL_TOOLS.scroll, { direction: "down", pages: 0, x, y }, signal), signal);
        if (settle > 0) await delay(settle);
      }
    } finally {
      await this.input.setButtonHeld(button, "up");
    }
  }

  /** 按住修饰键（ydotool），返回 release()；失败时立即回滚已按下的键。 */
  private async holdModifiers(modifiers: readonly string[]): Promise<{ release: () => Promise<void> }> {
    if (modifiers.length === 0) return { release: async () => {} };
    const heldModifiers: string[] = [];
    try {
      for (const modifier of modifiers) {
        await this.input.setKeysHeld(modifierKeyName(modifier), true);
        heldModifiers.push(modifierKeyName(modifier));
      }
    } catch (error) {
      await this.releaseModifiers(heldModifiers);
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseModifiers(heldModifiers);
      },
    };
  }

  private async releaseModifiers(modifiers: readonly string[]): Promise<void> {
    for (const modifier of [...modifiers].reverse()) {
      await this.input.setKeysHeld(modifier, false).catch(() => {
        // 释放失败不静默：上面 holdPre/post 的调用方能感知；这里只能尽力而为，
        // 因为用户桌面残留按住的键比抛错更糟，但抛错会掩盖真实动作结果。
      });
    }
  }

  /**
   * 按下/松开指针按钮（`mouse_down_client` / `mouse_up_client`）。
   *
   * 实测可行：`ydotool click 0x40` = 左键 down、`0x80` = 左键 up，跨进程持久
   * （与 CUL 的 `get_app_state`/`click` 混用没问题，因为两边都写 uinput）。
   * 指针位置用 CUL 的 `scroll pages=0` 先定位（ydotool `-a` 的坐标系是 DIP×2，不等价）。
   */
  private async pointerSplit(
    action: ComputerExecAction,
    input: ComputerExecInput,
    phase: "down" | "up",
    signal?: AbortSignal,
  ): Promise<ComputerExecOutput> {
    const resolved = await this.maybeTarget(input, signal);
    const target = resolved ? await this.ensureForeground(resolved, signal) : undefined;
    if (Number.isFinite(Number(input.x)) && Number.isFinite(Number(input.y)) && target) {
      const point = clientDipToScreenPhysical(target, Number(input.x), Number(input.y));
      await checked(() => this.cul().require(CUL_TOOLS.scroll, { direction: "down", pages: 0, x: point.x, y: point.y }, signal), signal);
    }
    const button = input.button ?? "left";
    // 先登记再下发：如果 setButtonHeld 抛错，动作失败清理会把它当成「可能已按下」释放掉。
    if (phase === "down") this.heldButtons.add(button as MouseButton);
    await this.input.setButtonHeld(button, phase);
    if (phase === "up") this.heldButtons.delete(button as MouseButton);
    return {
      action,
      window: target,
      detail: `ydotool ${button} ${phase}${target ? ` (window ${target.handle})` : ""}`,
      backend: this.backend,
    } as ComputerExecOutput;
  }

  /**
   * 按下/松开一组键（`key_down` / `key_up`）。
   *
   * `key` 支持组合写法（`Ctrl+Shift`），按下按正序、松开按逆序；`hold_ms` 在
   * `key_down` 时不生效（按住时长由后续动作/`key_up` 决定），只在 `key_press`
   * 里用一次完整 down+up+停顿表达。
   */
  private async keySplit(
    action: ComputerExecAction,
    input: ComputerExecInput,
    pressed: boolean,
    signal?: AbortSignal,
  ): Promise<ComputerExecOutput> {
    assertNotCancelled(signal);
    const key = input.key?.trim();
    if (!key) throw new ComputerUseError("HOST_PROTOCOL_ERROR", `${action} 需要 key`);
    const target = await this.maybeTarget(input, signal);
    // ydotool 没有 window_id 定向：按住/松开只会打到当前前台窗口，所以先聚焦目标。
    if (target && !target.foreground) await this.focusWindow(target.handle, signal);
    const codes = keyChordToKeycodes(key);
    // 先登记再下发：组合键中途失败时动作失败清理会释放它可能已经按下的键。
    if (pressed) for (const code of codes) this.heldKeys.add(code);
    await this.input.setKeycodesHeld(codes, pressed);
    if (!pressed) for (const code of codes) this.heldKeys.delete(code);
    return {
      action,
      window: target,
      detail: `ydotool key ${codes.join(",")}:${pressed ? 1 : 0}`,
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

  private async dragScreen(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const start = { x: requireFinite(input.x, "x"), y: requireFinite(input.y, "y") };
    const end = { x: requireFinite(input.x2, "x2"), y: requireFinite(input.y2, "y2") };
    await checked(() => this.cul().require(CUL_TOOLS.drag, {
      start_x: start.x, start_y: start.y, end_x: end.x, end_y: end.y,
    }, signal), signal);
    return { action, detail: `screen drag ${start.x},${start.y} -> ${end.x},${end.y}`, backend: this.backend } as ComputerExecOutput;
  }

  /* ---------------------------------------------------------------- */
  /* 窗口几何（Hyprland）                                               */
  /* ---------------------------------------------------------------- */

  /**
   * `move_window` / `resize_window`。
   *
   * **不走 CUL**：CUL 的这两条在 Hyprland 上恒定失败（它只有 GNOME Shell 扩展和 X11/EMWM 两条路），
   * 原文错误见 `hyprlandWindows.ts` 头注释。这里走 `hyprctl repl` 的 Lua API，并且回读
   * 合成器实际采纳的几何作为证据——平铺窗口会被先转成浮窗，所以「请求 200,150」和
   * 「实际 200,151」这种差异必须暴露给模型，不能假装成功。
   */
  private async windowGeometryAction(
    action: ComputerExecAction,
    input: ComputerExecInput,
    signal?: AbortSignal,
  ): Promise<ComputerExecOutput> {
    // 先校验参数再解析目标窗口：坏参数不该先触发一次 CUL 连接/焦点变更。
    const moving = action === "move_window";
    if (moving) {
      if (!Number.isFinite(Number(input.windowX)) || !Number.isFinite(Number(input.windowY))) {
        throw new ComputerUseError(
          "HOST_PROTOCOL_ERROR",
          "move_window 需要 window_x 与 window_y（逻辑/布局像素，与 hyprctl clients 的 at 同域）",
          { action },
        );
      }
    } else if (!Number.isFinite(Number(input.windowWidth)) || !Number.isFinite(Number(input.windowHeight))) {
      throw new ComputerUseError(
        "HOST_PROTOCOL_ERROR",
        "resize_window 需要 window_width 与 window_height（逻辑/布局像素，与 hyprctl clients 的 size 同域）",
        { action },
      );
    }

    const target = (await this.maybeTarget(input, signal))
      ?? (await this.readWindows(signal)).find((window) => window.foreground);
    if (!target) {
      throw new ComputerUseError("WINDOW_NOT_FOUND", `${action} 需要目标窗口：请传 window_handle，或先让窗口到前台`);
    }

    const before = await this.windowControl.geometry(target.handle, signal).catch(() => undefined);
    if (moving) {
      const after = await this.windowControl.move(target.handle, Number(input.windowX), Number(input.windowY), signal);
      return this.geometryOutput(action, target, before, after, `move -> ${input.windowX},${input.windowY}`);
    }
    const after = await this.windowControl.resize(target.handle, Number(input.windowWidth), Number(input.windowHeight), signal);
    return this.geometryOutput(action, target, before, after, `resize -> ${input.windowWidth}x${input.windowHeight}`);
  }

  private geometryOutput(
    action: ComputerExecAction,
    target: WindowInfo,
    before: HyprlandWindowRect | undefined,
    after: HyprlandWindowRect | undefined,
    request: string,
  ): ComputerExecOutput {
    if (!after) {
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", `${action} 已下发但读不回几何：hyprctl 没有返回该窗口的 at/size`, {
        action,
        windowHandle: target.handle,
      });
    }
    const describe = (rect: HyprlandWindowRect): string =>
      `at=${rect.x},${rect.y} size=${rect.width}x${rect.height}${rect.floating ? " floating" : ""}`;
    const detail = `${request}；合成器实际：${describe(after)}${before ? `（原 ${describe(before)}）` : ""}`;
    return {
      action,
      window: target,
      detail,
      windowGeometry: after,
      windowGeometryBefore: before,
      backend: this.backend,
    } as ComputerExecOutput;
  }

  /* ---------------------------------------------------------------- */
  /* 键盘输入                                                           */
  /* ---------------------------------------------------------------- */

  private async keyPress(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const key = input.key?.trim();
    if (!key) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "key_press 需要 key");
    const target = await this.maybeTarget(input, signal);
    const normalized = toCulKey(key);
    // hold_ms > 0 表示「长按」：CUL 的 press_key 是原子的 down+up，中间没有停顿，
    // 所以长按必须走 ydotool 的 down → 停顿 → up 三步（实测 42:1/42:0 持久）。
    const holdMs = Math.max(0, Math.min(5_000, input.holdMs ?? 0));
    if (holdMs > 0) {
      // 长按走 ydotool，没有 window_id 定向：必须先把目标窗口拿到前台，否则按键会打到别人窗口。
      if (target && !target.foreground) await this.focusWindow(target.handle, signal);
      await this.input.setKeysHeld(normalized, true).catch((error: unknown) => {
        throw error instanceof ComputerUseError
          ? error
          : new ComputerUseError("HOST_UNAVAILABLE", `长按需要 ydotool：${String(error)}`, { action, key: normalized });
      });
      try {
        await delay(holdMs);
      } finally {
        await this.input.setKeysHeld(normalized, false).catch(() => {});
      }
      const after = target ? await this.inspectHandle(target.handle, signal).catch(() => undefined) : undefined;
      return {
        action,
        window: after ?? target,
        detail: `ydotool hold ${normalized} ${holdMs}ms${target ? ` (window ${target.handle})` : ""}`,
        backend: this.backend,
      } as ComputerExecOutput;
    }
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

  /**
   * `paste_text`：走系统剪贴板 + Ctrl+V，而不是逐字 wtype。
   *
   * 逐字输入在两个场景会坏：长文本要几十次 MCP 调用且中途被截断；输入法/富文本
   * 编辑器里逐字键入会触发补全和自动格式化。Wayland 上写剪贴板用 `wl-copy`
   * （wl-clipboard 包，Omarchy 自带；`wl-copy` 会 fork 一个常驻进程持有选区）。
   * 剪贴板写不进去时**显式回落**到逐字输入并在 detail 里说明，不静默。
   */
  private async pasteText(action: ComputerExecAction, input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const text = input.text ?? "";
    if (!text) throw new ComputerUseError("HOST_PROTOCOL_ERROR", `${action} 需要 text`);
    const target = await this.maybeTarget(input, signal);
    let clipboardError: string | undefined;
    try {
      await this.writeClipboard(text);
    } catch (error) {
      clipboardError = error instanceof Error ? error.message : String(error);
    }
    if (clipboardError !== undefined) {
      const typed = await this.typeText(action, input, signal);
      return { ...typed, detail: `${typed.detail ?? ""}（剪贴板不可用，已回落逐字输入：${clipboardError}）` };
    }
    if (target && !target.foreground) await this.focusWindow(target.handle, signal);
    const args: Record<string, unknown> = { key: "Ctrl+V" };
    if (target) args.window_id = Number(target.handle);
    await checked(() => this.cul().require(CUL_TOOLS.pressKey, args, signal), signal);
    return {
      action,
      window: target,
      completed: true,
      typedLength: text.length,
      totalLength: text.length,
      pasted: true,
      detail: `粘贴 ${text.length} 字符（wl-copy + Ctrl+V${target ? `，窗口 ${target.handle}` : ""}）`,
      backend: this.backend,
    } as ComputerExecOutput;
  }

  /** 写 Wayland 剪贴板（可注入，测试不碰真机）。 */
  private async writeClipboard(text: string): Promise<void> {
    if (this.options.pasteViaClipboard) {
      await this.options.pasteViaClipboard(text);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "pipe"], detached: true });
      let stderr = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const fail = (error: ComputerUseError) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", (error) => fail(new ComputerUseError("HOST_UNAVAILABLE", `wl-copy 启动失败：${error.message}（安装 wl-clipboard）`)));
      // 注意：**不要等 `close`**。wl-copy 会 fork 一个常驻进程持有选区，并继承这里的 stderr
      // 管道；父进程退出后子进程仍持有 fd，`close` 要等所有 stdio 关闭 —— 实测 100ms 就 exit、
      // 3 秒内 close 永不到来，用 close 会让 paste_text 一直挂到选区被替换。按 `exit` 判定。
      child.on("exit", (code) => {
        if (code === 0) succeed();
        else fail(new ComputerUseError("HOST_UNAVAILABLE", `wl-copy 退出码 ${code}：${stderr.trim().slice(0, 300)}`));
      });
      // 兜底：连 exit 都不来（wl-copy 被塞住/无 Wayland 剪贴板）时不要无限期挂着。
      timer = setTimeout(() => fail(new ComputerUseError("HOST_UNAVAILABLE", "wl-copy 3 秒内没有退出（剪贴板可能被占用）")), 3_000);
      timer.unref?.();
      child.stdin?.on("error", () => { /* 子进程可能先退出；由 exit 决定成败 */ });
      child.stdin?.end(text);
      child.unref();
    });
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
