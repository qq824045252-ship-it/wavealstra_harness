import type { ResourceRecoveryAttempt } from "../../../../shared/resource-recovery";
import { isComputerExecReadonly } from "../../../../shared/pi-event-mapper";
import { withManagedResource } from "../../managed-resources";
import { randomUUID } from "node:crypto";
import { computerUseRunCoordinator } from "../../../capabilities/ComputerUseRunCoordinator";
import { withComputerUseDeliveryEvidence, validateComputerAction } from "../../../capabilities/ComputerUsePolicy";
import type { ComputerUseBackend, ComputerUseStatus, ComputerUseCapabilityName, ComputerUseCapabilityStatus } from "../backend";
import {
  COMPUTER_BATCH_ACTIONS, ComputerUseError,
  type AppSessionInfo, type ComputerBatchStep, type ComputerBatchStepResult,
  type ComputerExecAction, type ComputerExecInput, type ComputerExecOutput,
  type ComputerSemanticOutcome, type ControlInfo, type Point, type WindowInfo,
} from "../protocol";
import { detectComputerUseSupport } from "../support";
import { AtSpiClient } from "./atspiClient";
import type { AtSpiControlInfo, AtSpiDriverApi, AtSpiInspection } from "./atspiTypes";
import { createHyprlandDesktop, createHyprlandWindowControl, hyprlandAddressFromHandle, windowGeometryIdentity, type HyprlandDesktop, type HyprlandSnapshot, type HyprlandWindowControl, type LinuxWindowInfo } from "./hyprlandWindows";
import { containsPoint, monitorForPoint } from "./hyprlandMonitors";
import { createGrimScreenshotProvider, type LinuxScreenshotProvider } from "./screenshotProvider";
import { YdotoolInput, keyChordToKeycodes, type YdotoolRunner } from "./ydotool";
import { writeWaylandClipboard } from "./clipboard";
import { abortableDelay, boundedNumber, clientDipToLogical, errorText, filterWindows, finiteNumber, hasControlSelector, hasWindowSelector, matchesSelector, sameWindowIdentity, throwIfCancelled } from "./nativeHelpers";

type MouseButton = "left" | "right" | "middle";
interface Observation { window: LinuxWindowInfo; at: number; owner: string }
interface AppSession { info: AppSessionInfo; owner: string }
interface ActionContext { snapshot: HyprlandSnapshot; target?: LinuxWindowInfo; control?: ControlInfo; submitted: boolean; owner: string; clipboardChanged?: boolean }
const OBSERVATION_TTL = 30_000;
const SESSION_TTL = 10 * 60_000;
const DIAGNOSTIC_TTL = 60_000;
const ATSPI_EDITABLE_TEXT = "org.a11y.atspi.EditableText";
const ATSPI_VALUE = "org.a11y.atspi.Value";
const INPUT_ACTIONS = new Set<ComputerExecAction>(["focus_window", "move_client", "click_client", "drag_client", "scroll_client", "mouse_down_client", "mouse_up_client", "key_down", "key_up", "paste_text", "drag_screen", "mouse_move", "mouse_click", "mouse_drag", "scroll", "key_press", "type_text", "move_window", "resize_window", "invoke_control", "set_control_value"]);
const SCREEN_ACTIONS = new Set<ComputerExecAction>(["mouse_move", "mouse_click", "mouse_drag", "drag_screen", "scroll"]);
const COORDINATE_ACTIONS = new Set<ComputerExecAction>(["move_client", "click_client", "drag_client", "scroll_client", "mouse_down_client", "drag_screen", "mouse_move", "mouse_click", "mouse_drag", "scroll"]);
const NO_TARGET_ACTIONS = new Set<ComputerExecAction>(["status", "list_windows", "active_window", "screenshot", "wait_for_window", "key_up"]);

export interface LinuxComputerUseBackendOptions {
  atspi?: AtSpiDriverApi;
  compositor?: HyprlandDesktop;
  input?: YdotoolInput;
  ydotoolRunner?: YdotoolRunner;
  windowControl?: HyprlandWindowControl;
  screenshotProvider?: LinuxScreenshotProvider;
  /** Convenient injection for acceptance tests; never called unless screenshot/captureAfter is explicit. */
  screenshot?: LinuxScreenshotProvider["capture"];
  pasteViaClipboard?: (text: string, signal?: AbortSignal) => void | Promise<void>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Linux native runtime: persistent AT-SPI worker + compositor IPC + evdev edges. No image discovery. */
export class LinuxComputerUseBackend implements ComputerUseBackend {
  readonly platform = "linux" as const;
  readonly backend = "linux-atspi" as const;
  private readonly atspi: AtSpiDriverApi;
  private readonly compositor: HyprlandDesktop;
  private readonly input: YdotoolInput;
  private readonly windowControl: HyprlandWindowControl;
  private readonly screenshots: LinuxScreenshotProvider;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly observations = new Map<string, Observation>();
  private readonly sessions = new Map<string, AppSession>();
  private readonly controlReferences = new Map<string, { observationId: string; owner: string; window: LinuxWindowInfo }>();
  private readonly heldKeys = new Map<number, string>();
  private readonly heldButtons = new Map<MouseButton, string>();
  private readonly heldTargets = new Map<string, WindowInfo>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private activeController?: AbortController;
  private recoveryPending = false;
  private recoveryReason?: string;
  private readonly lifetime = new AbortController();
  private diagnostics?: { checkedAt: number; capabilities: Partial<Record<ComputerUseCapabilityName, ComputerUseCapabilityStatus>> };
  private diagnosticsRefresh?: Promise<void>;

  constructor(private readonly options: LinuxComputerUseBackendOptions = {}) {
    this.atspi = options.atspi ?? new AtSpiClient({ onUnexpectedExit: error => this.onTransportLoss(error) });
    this.compositor = options.compositor ?? createHyprlandDesktop(undefined, { onDisconnect: error => this.onTransportLoss(error) });
    this.input = options.input ?? new YdotoolInput({ runner: options.ydotoolRunner, onUnexpectedExit: error => this.onTransportLoss(error) });
    this.windowControl = options.windowControl ?? createHyprlandWindowControl();
    const screenshots = options.screenshotProvider ?? createGrimScreenshotProvider();
    this.screenshots = options.screenshot ? { probe: screenshots.probe, capture: options.screenshot } : screenshots;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableDelay;
  }

  get available(): boolean { return Boolean(this.options.compositor || detectComputerUseSupport("linux").supported); }
  status(): ComputerUseStatus {
    const support = detectComputerUseSupport("linux");
    const stale = !this.diagnostics || this.now() - this.diagnostics.checkedAt > DIAGNOSTIC_TTL;
    const capabilities = this.diagnostics?.capabilities;
    return {
      platform: this.platform, backend: this.backend, supported: this.available,
      missingDependencies: this.options.compositor ? [] : support.missingDependencies,
      installHint: support.installHint,
      reason: !this.available ? support.reason : stale ? "能力诊断尚未刷新或已过期；动作会独立验证实际依赖" : undefined,
      detail: !this.available ? `Linux 原生后端不可用：${support.reason ?? "需要 Hyprland/Wayland"}` : `Linux AT-SPI / Hyprland${stale ? "（诊断待刷新）" : "（按能力报告就绪状态）"}`,
      hostPid: this.atspi instanceof AtSpiClient ? this.atspi.pid : undefined,
      checkedAt: this.diagnostics?.checkedAt, expiresAt: this.diagnostics ? this.diagnostics.checkedAt + DIAGNOSTIC_TTL : undefined, capabilities,
    };
  }

  refreshDiagnostics(): Promise<void> {
    if (this.diagnosticsRefresh) return this.diagnosticsRefresh;
    this.diagnosticsRefresh = this.probeCapabilities().finally(() => { this.diagnosticsRefresh = undefined; });
    return this.diagnosticsRefresh;
  }
  private async probeCapabilities(): Promise<void> {
    const checkedAt = this.now();
    const results = await Promise.allSettled([this.atspi.probe(this.lifetime.signal), this.compositor.snapshot(this.lifetime.signal), this.compositor.cursor(this.lifetime.signal), this.input.probe(), this.screenshots.probe()]);
    const [accessibility, windows, pointer, keyboard, screenshot] = results;
    const unavailable = (result: PromiseRejectedResult): ComputerUseCapabilityStatus => ({ available: false, verified: false, checkedAt, reason: errorText(result.reason) });
    const a: ComputerUseCapabilityStatus = accessibility.status === "fulfilled" ? { available: accessibility.value.available, verified: accessibility.value.available, checkedAt, reason: accessibility.value.reason } : unavailable(accessibility);
    this.diagnostics = { checkedAt, capabilities: {
      accessibility: a,
      semantic: { available: a.available, verified: false, checkedAt, reason: "每个目标仍须提供 Action / EditableText / Value 并经实际应用读回验证" },
      bounds: { available: false, verified: false, checkedAt, reason: "仅目标 AT-SPI 根节点与新鲜合成器几何一致时发布控件坐标" },
      window: windows.status === "fulfilled" ? { available: true, verified: true, checkedAt } : unavailable(windows),
      pointer: pointer.status === "fulfilled" && windows.status === "fulfilled" ? { available: true, verified: false, checkedAt, reason: "已读到实际光标；移动会逐次读回验证" } : unavailable((pointer.status === "rejected" ? pointer : windows) as PromiseRejectedResult),
      keyboard: keyboard.status === "fulfilled" ? keyboard.value : unavailable(keyboard),
      screenshot: screenshot.status === "fulfilled" ? screenshot.value : unavailable(screenshot),
    } };
  }
  private markCapability(name: ComputerUseCapabilityName, available: boolean, verified: boolean, reason?: string): void {
    this.diagnostics ??= { checkedAt: this.now(), capabilities: {} };
    this.diagnostics.capabilities[name] = { available, verified, reason, checkedAt: this.now() };
  }

  execute(input: ComputerExecInput, externalSignal?: AbortSignal): Promise<ComputerExecOutput> {
    return withManagedResource({ kind: "desktop", taskId: input.taskId, action: input.action ?? "batch", inputKey: input.action?.startsWith("key_") ? input.key : input.button ?? "left", readonly: isComputerExecReadonly(input) }, () => this.executeManaged(input, externalSignal));
  }

  private executeManaged(input: ComputerExecInput, externalSignal?: AbortSignal): Promise<ComputerExecOutput> {
    validateComputerAction(input);
    this.validateInput(input);
    if (input.taskId) externalSignal = computerUseRunCoordinator.scope(input.taskId, externalSignal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted || this.lifetime.signal.aborted) controller.abort();
    const timeoutMs = boundedNumber(input.timeoutMs, 30_000, 1, 120_000, "timeoutMs");
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const owner = input.taskId?.trim() || "__direct__";
    const operation = this.queue.then(async () => {
      let result: ComputerExecOutput | undefined;
      let prepared = input;
      try {
        this.activeController = controller;
        if (this.recoveryPending) await this.recoverInputs();
        throwIfCancelled(controller.signal);
        if (this.closing) throw new ComputerUseError("HOST_UNAVAILABLE", "Linux 桌面后端正在关闭");
        prepared = input.taskId ? computerUseRunCoordinator.prepare(input) : input;
        result = prepared.actions ? await this.batch(prepared, owner, controller.signal) : await this.perform(prepared, owner, controller.signal);
        throwIfCancelled(controller.signal);
        return computerUseRunCoordinator.complete(prepared, result);
      } catch (error) {
        // Recovery stays inside this transaction: the next queued action cannot race release edges.
        computerUseRunCoordinator.fail(prepared, externalSignal);
        const cleanup = await this.releaseOwned(owner);
        error = withComputerUseDeliveryEvidence(error, result);
        if (timedOut) throw new ComputerUseError("REQUEST_TIMEOUT", "桌面请求已超时；已发送操作可能生效，不可盲目重试", { ...(error instanceof ComputerUseError ? this.errorDetails(error) : {}), cause: errorText(error), executed: this.errorExecution(error), cleanup });
        if (error instanceof ComputerUseError) throw new ComputerUseError(error.code, error.message, { ...(this.errorDetails(error)), cleanup });
        throw new ComputerUseError("HOST_PROTOCOL_ERROR", errorText(error), { cleanup });
      } finally { if (this.activeController === controller) this.activeController = undefined; }
    });
    this.queue = operation.catch(() => undefined);
    return operation.finally(() => { clearTimeout(timer); externalSignal?.removeEventListener("abort", abort); this.lifetime.signal.removeEventListener("abort", abort); });
  }

  private errorDetails(error: ComputerUseError): Record<string, unknown> {
    return error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
  }
  private errorExecution(error: unknown): unknown {
    if (!(error instanceof ComputerUseError)) return "unknown";
    const details = this.errorDetails(error);
    const result = details.actionResult && typeof details.actionResult === "object" ? details.actionResult as Record<string, unknown> : undefined;
    return details.executed ?? result?.executed ?? false;
  }
  private validateInput(input: ComputerExecInput): void {
    if (input.background) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "Hyprland 后端不支持后台输入或后台窗口截图");
    for (const name of ["x", "y", "x2", "y2", "deltaX", "deltaY", "windowX", "windowY", "windowWidth", "windowHeight"] as const) if (input[name] !== undefined) finiteNumber(input[name], name);
    boundedNumber(input.holdMs, 0, 0, 5_000, "holdMs"); boundedNumber(input.durationMs, 300, 0, 10_000, "durationMs");
    const count = boundedNumber(input.clickCount, 1, 1, 3, "clickCount"); if (!Number.isInteger(count)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "clickCount 必须是整数");
    const steps = boundedNumber(input.steps, 12, 1, 60, "steps"); if (!Number.isInteger(steps)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "steps 必须是整数");
    boundedNumber(input.settleMs, 120, 0, 2_000, "settleMs");
    if (input.key !== undefined) keyChordToKeycodes(input.key);
    if (input.button !== undefined && !["left", "right", "middle"].includes(input.button)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "无效鼠标按钮");
    if (input.modifiers?.some(m => !["ctrl", "shift", "alt", "win"].includes(m))) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "无效修饰键");
    if (input.windowHandle && !hyprlandAddressFromHandle(input.windowHandle)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "windowHandle 必须是当前合成器返回的字符串地址");
    if (input.waitState !== undefined && !["visible", "foreground", "closed"].includes(input.waitState)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "无效 waitState");
    for (const [key, min, max] of [["maxDepth", 1, 32], ["maxNodes", 1, 5000]] as const) if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key]! < min || input[key]! > max)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", `${key} 必须是 ${min}..${max} 的整数`);
    if (input.actions && (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > 64)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "批处理需要 1..64 个步骤");
    const action = input.action;
    if (COORDINATE_ACTIONS.has(action!) && !input.observationId) throw new ComputerUseError("STALE_OBSERVATION", "坐标输入必须携带本任务最近一次窗口观察的 observationId");
    if (["key_down", "key_up", "key_press"].includes(action ?? "") && (typeof input.key !== "string" || !input.key.trim())) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "按键动作需要 key");
    if (["type_text", "paste_text", "set_control_value"].includes(action ?? "") && typeof input.text !== "string") throw new ComputerUseError("HOST_PROTOCOL_ERROR", "文本动作需要 text 字符串");
    if (input.text !== undefined && input.text.length > 100_000) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "单次 text 超过 100000 字符限制");
    if (COORDINATE_ACTIONS.has(action!) && !["scroll", "scroll_client"].includes(action!)) { finiteNumber(input.x, "x"); finiteNumber(input.y, "y"); }
    if (["scroll", "scroll_client"].includes(action ?? "")) {
      if ((input.x === undefined) !== (input.y === undefined)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "滚轮目标需同时提供 x/y");
      if (input.deltaX === undefined && input.deltaY === undefined && input.notches === undefined) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "滚轮动作需要 deltaX、deltaY 或 notches");
      for (const name of ["deltaX", "deltaY", "notches"] as const) if (input[name] !== undefined && (!Number.isInteger(input[name]) || Math.abs(input[name]!) > 120)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", `${name} 必须是 -120..120 整数刻度`);
      if (input.notches !== undefined && input.deltaY !== undefined) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "notches 与 deltaY 只能提供一个，避免方向歧义");
    }
    if (["drag_client", "drag_screen", "mouse_drag"].includes(action ?? "")) { finiteNumber(input.x2, "x2"); finiteNumber(input.y2, "y2"); }
    if (action === "move_window") { finiteNumber(input.windowX, "windowX"); finiteNumber(input.windowY, "windowY"); }
    if (action === "resize_window") { if (finiteNumber(input.windowWidth, "windowWidth") <= 0 || finiteNumber(input.windowHeight, "windowHeight") <= 0) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "窗口宽高必须大于零"); }
    if (input.expectedOutcomes?.some(check => !["target_present", "target_closed", "target_foreground", "new_window", "control_present", "control_absent"].includes(check.kind))) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "无效后置条件");
    if (input.actions) for (const step of input.actions) {
      if (!(COMPUTER_BATCH_ACTIONS as readonly string[]).includes(step.action)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", `批处理不支持 ${step.action}`);
      this.validateInput({ ...input, ...step, action: step.action, actions: undefined });
    }
  }

  private remember(window: LinuxWindowInfo, owner: string, id = randomUUID()): string {
    this.prune(); this.observations.set(id, { window: structuredClone(window), at: this.now(), owner });
    while (this.observations.size > 64) this.observations.delete(this.observations.keys().next().value!);
    return id;
  }
  private prune(): void {
    for (const [id, o] of this.observations) if (this.now() - o.at > OBSERVATION_TTL) this.observations.delete(id);
    for (const [ref, binding] of this.controlReferences) if (!this.observations.has(binding.observationId)) this.controlReferences.delete(ref);
    for (const [id, s] of this.sessions) if (this.now() - s.info.lastSeenAt > SESSION_TTL) this.sessions.delete(id);
  }
  private resolveTarget(input: ComputerExecInput, snapshot: HyprlandSnapshot, owner: string): LinuxWindowInfo {
    this.prune();
    let prior: WindowInfo | undefined; let handle = input.windowHandle;
    if (input.appSessionId) {
      const session = this.sessions.get(input.appSessionId);
      if (!session || session.owner !== owner) throw new ComputerUseError("STALE_OBSERVATION", "应用会话已过期或属于另一个任务");
      prior = session.info.window; handle ??= prior.handle;
      if (handle !== prior.handle) throw new ComputerUseError("TARGET_CHANGED", "显式目标与应用会话不一致");
    }
    if (input.observationId) {
      const observed = this.observations.get(input.observationId);
      if (!observed || observed.owner !== owner) throw new ComputerUseError("STALE_OBSERVATION", "观察 ID 已过期或属于另一个任务；请重新观察");
      if (handle && handle !== observed.window.handle) throw new ComputerUseError("TARGET_CHANGED", "目标窗口与观察不一致");
      handle = observed.window.handle; prior = observed.window;
      if (observed.window.layoutId !== snapshot.layoutId) throw new ComputerUseError("STALE_OBSERVATION", "输出布局或缩放已经改变；请重新观察");
    }
    const hasFilters = Boolean(input.windowTitle || input.processName || input.className || input.processId !== undefined);
    let candidates = filterWindows(snapshot.windows, input);
    if (handle) candidates = candidates.filter(w => w.handle === hyprlandAddressFromHandle(handle!));
    else if (!hasFilters) candidates = candidates.filter(w => w.handle === snapshot.activeHandle);
    if (!candidates.length) throw new ComputerUseError("WINDOW_NOT_FOUND", "没有找到匹配的当前 Hyprland 窗口");
    if (candidates.length !== 1) throw new ComputerUseError("WINDOW_AMBIGUOUS", "存在多个候选窗口；请指定读取到的 windowHandle", { candidates: candidates.map(w => ({ handle: w.handle, processId: w.processId, title: w.title })) });
    const target = candidates[0];
    if (prior && !sameWindowIdentity(prior, target)) throw new ComputerUseError("TARGET_CHANGED", "窗口句柄对应的进程或类已改变");
    if (input.observationId && windowGeometryIdentity(prior!) !== windowGeometryIdentity(target)) throw new ComputerUseError("STALE_OBSERVATION", "窗口位置或尺寸已改变；请重新观察");
    if (input.appSessionId) {
      const s = this.sessions.get(input.appSessionId)!; s.info.window = target; s.info.lastSeenAt = this.now();
    }
    return target;
  }

  private async inspect(window: LinuxWindowInfo, snapshot: HyprlandSnapshot, owner: string, input: ComputerExecInput, signal?: AbortSignal): Promise<AtSpiInspection> {
    const observationId = this.remember(window, owner);
    try {
      const inspection = await this.atspi.inspectWindow(window, {
        observationId, maxNodes: input.maxNodes, maxDepth: input.maxDepth, timeoutMs: input.timeoutMs,
        peerWindows: snapshot.windows,
        geometry: window.clientGeometryVerified && window.geometryReliable ? { coordinateSpace: "hyprland-logical", clientLogical: { ...window.clientOrigin, width: window.clientRect.width, height: window.clientRect.height }, identity: windowGeometryIdentity(window) } : undefined,
      }, signal);
      for (const control of inspection.controls) this.controlReferences.set(control.runtimeId, { observationId, owner, window: structuredClone(window) });
      while (this.controlReferences.size > 32_000) this.controlReferences.delete(this.controlReferences.keys().next().value!);
      this.markCapability("accessibility", true, true);
      this.markCapability("bounds", inspection.boundsReliable, inspection.boundsReliable, inspection.boundsReliable ? undefined : inspection.diagnostics.join("；"));
      return inspection;
    } catch (error) {
      this.observations.delete(observationId);
      this.markCapability("accessibility", false, false, errorText(error));
      throw error;
    }
  }
  private async selectControl(window: LinuxWindowInfo, snapshot: HyprlandSnapshot, owner: string, input: ComputerExecInput, signal?: AbortSignal): Promise<AtSpiControlInfo> {
    if (!hasControlSelector(input)) throw new ComputerUseError("CONTROL_NOT_FOUND", "需要明确的控件选择器；请先 inspect_controls");
    if (input.controlRuntimeId) {
      this.prune();
      const reference = this.controlReferences.get(input.controlRuntimeId);
      if (!reference || reference.owner !== owner || !sameWindowIdentity(reference.window, window) || !this.observations.has(reference.observationId)) throw new ComputerUseError("STALE_OBSERVATION", "控件引用不属于本任务的新鲜窗口观察；请重新 inspect_controls");
      if (input.observationId && reference.observationId !== input.observationId) throw new ComputerUseError("STALE_OBSERVATION", "控件与 observationId 来自不同观察");
      const control = await this.atspi.readControl(window, input.controlRuntimeId, signal);
      if (!matchesSelector(control, input)) throw new ComputerUseError("CONTROL_NOT_FOUND", "runtimeId 读回控件不符合额外选择器");
      return control;
    }
    const tree = await this.inspect(window, snapshot, owner, input, signal);
    const candidates = tree.controls.filter(c => matchesSelector(c, input));
    if (!candidates.length) throw new ComputerUseError("CONTROL_NOT_FOUND", tree.truncated ? "当前树已截断，未在已读节点中找到控件；请缩小范围重新观察" : "没有匹配控件");
    if (candidates.length !== 1 || tree.truncated) throw new ComputerUseError("CONTROL_AMBIGUOUS", "选择器无法唯一确定完整树中的控件；请使用观察返回的 runtimeId", { candidates: candidates.map(c => ({ runtimeId: c.runtimeId, name: c.name, controlType: c.controlType })) });
    return candidates[0];
  }

  private onTransportLoss(error: ComputerUseError): void {
    this.observations.clear(); this.sessions.clear(); this.controlReferences.clear();
    this.recoveryPending = true; this.recoveryReason = error.message;
    this.activeController?.abort(error);
    this.markCapability("semantic", false, false, error.message);
    const recovery = this.queue.then(() => this.recoverInputs());
    this.queue = recovery.catch(() => undefined);
  }
  private async recoverInputs(): Promise<void> {
    const result = await this.releaseOwned();
    if (result.errors.length) throw new ComputerUseError("HOST_UNAVAILABLE", "输入清理尚未完成，暂停后续桌面动作", { cleanup: result, reason: this.recoveryReason });
    this.recoveryPending = false; this.recoveryReason = undefined;
  }
  private assertOwner(owner: string, target?: WindowInfo): void {
    if ([...this.heldKeys.values(), ...this.heldButtons.values()].some(value => value !== owner)) throw new ComputerUseError("HOST_UNAVAILABLE", "另一个任务仍持有按键或鼠标按钮，不能交叉注入输入");
    const heldTarget = this.heldTargets.get(owner);
    if (heldTarget && (!target || !sameWindowIdentity(heldTarget, target))) throw new ComputerUseError("TARGET_CHANGED", "按住输入期间不能切换窗口；先释放本任务持有的输入");
  }
  private rememberHeldTarget(owner: string, target?: WindowInfo): void {
    if (target) this.heldTargets.set(owner, structuredClone(target));
  }
  private clearHeldTarget(owner: string): void {
    if (![...this.heldKeys.values(), ...this.heldButtons.values()].includes(owner)) this.heldTargets.delete(owner);
  }
  private async keysDown(codes: readonly number[], owner: string, target?: WindowInfo, signal?: AbortSignal): Promise<number[]> {
    this.assertOwner(owner, target);
    const added = codes.filter(code => !this.heldKeys.has(code));
    if (!added.length) return [];
    added.forEach(code => this.heldKeys.set(code, owner)); this.rememberHeldTarget(owner, target);
    // Reserve before dispatch: a failed/cancelled process may have sent a prefix.
    await this.input.setKeycodesHeld(added, true, signal);
    return added;
  }
  private async keysUp(codes: readonly number[], owner: string, signal?: AbortSignal): Promise<number[]> {
    const owned = codes.filter(code => this.heldKeys.get(code) === owner);
    if (!owned.length) return [];
    await this.input.setKeycodesHeld(owned, false, signal);
    owned.forEach(code => this.heldKeys.delete(code)); this.clearHeldTarget(owner);
    return owned;
  }
  private async buttonDown(button: MouseButton, owner: string, target?: WindowInfo, signal?: AbortSignal): Promise<boolean> {
    this.assertOwner(owner, target);
    if (this.heldButtons.get(button) === owner) return false;
    this.heldButtons.set(button, owner); this.rememberHeldTarget(owner, target);
    await this.input.setButtonHeld(button, "down", signal); return true;
  }
  private async buttonUp(button: MouseButton, owner: string, signal?: AbortSignal): Promise<boolean> {
    if (this.heldButtons.get(button) !== owner) return false;
    await this.input.setButtonHeld(button, "up", signal);
    this.heldButtons.delete(button); this.clearHeldTarget(owner); return true;
  }
  private async releaseOwned(owner?: string, recovery?: ResourceRecoveryAttempt): Promise<{ keys: number[]; buttons: string[]; errors: string[] }> {
    recovery?.assertCurrent();
    const result = { keys: [] as number[], buttons: [] as string[], errors: [] as string[] };
    const owners = owner ? [owner] : [...new Set([...this.heldKeys.values(), ...this.heldButtons.values()])];
    for (const current of owners) {
      recovery?.assertCurrent();
      const codes = [...this.heldKeys].filter(([, value]) => value === current).map(([code]) => code);
      try { result.keys.push(...await this.keysUp(codes, current, recovery?.signal)); } catch (error) { result.errors.push(errorText(error)); }
      recovery?.assertCurrent();
      for (const [button, value] of this.heldButtons) if (value === current) {
        recovery?.assertCurrent();
        try { if (await this.buttonUp(button, current, recovery?.signal)) result.buttons.push(button); } catch (error) { result.errors.push(errorText(error)); }
        recovery?.assertCurrent();
      }
    }
    if (result.errors.length) { this.recoveryPending = true; this.recoveryReason = result.errors.join("；"); }
    return result;
  }
  releaseHeldInput(taskId?: string, recovery?: ResourceRecoveryAttempt): Promise<{ keys: number[]; buttons: string[] }> {
    recovery?.assertCurrent();
    const release = this.queue.then(async () => {
      recovery?.assertCurrent();
      const result = await this.releaseOwned(taskId?.trim() || undefined, recovery);
      recovery?.assertCurrent();
      if (result.errors.length) throw new ComputerUseError("HOST_UNAVAILABLE", "未能释放全部输入；新输入已暂停", { cleanup: result });
      return result;
    });
    this.queue = release.catch(() => undefined); return release;
  }

  private async guard(context: ActionContext, signal?: AbortSignal, needFocus = true, needGeometry = true): Promise<HyprlandSnapshot> {
    throwIfCancelled(signal);
    const fresh = await this.compositor.snapshot(signal);
    if (fresh.layoutId !== context.snapshot.layoutId) throw new ComputerUseError("STALE_OBSERVATION", "动作期间输出布局改变，停止剩余输入");
    if (context.target) {
      const target = fresh.windows.find(w => w.handle === context.target!.handle);
      if (!target || !sameWindowIdentity(context.target, target)) throw new ComputerUseError("TARGET_CHANGED", "动作期间目标窗口关闭或重建");
      if (needGeometry && windowGeometryIdentity(context.target) !== windowGeometryIdentity(target)) throw new ComputerUseError("STALE_OBSERVATION", "动作期间目标窗口移动或尺寸变化，停止剩余坐标输入");
      if (needFocus && (fresh.activeHandle !== target.handle || !target.visible || target.acceptsInput === false)) throw new ComputerUseError("FOCUS_FAILED", "动作期间焦点已改变，停止剩余输入");
    }
    if (needGeometry && context.control && context.target) {
      const control = await this.atspi.readControl(context.target, context.control.runtimeId, signal);
      if (!control.enabled || control.offscreen || control.boundsReliable !== true || JSON.stringify(control.clientBoundsDip) !== JSON.stringify(context.control.clientBoundsDip)) throw new ComputerUseError("STALE_OBSERVATION", "动作期间控件状态或可靠边界已改变，停止剩余坐标输入");
    }
    return fresh;
  }
  private async foreground(context: ActionContext, input: ComputerExecInput, signal?: AbortSignal): Promise<void> {
    if (!context.target) return;
    if (context.target.acceptsInput === false) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "合成器报告目标窗口不接受输入");
    if (!context.target.identityToken) throw new ComputerUseError("STALE_OBSERVATION", "窗口缺少生命周期标记，不能安全注入输入");
    if (context.snapshot.activeHandle !== context.target.handle || !context.target.visible) {
      if (input.ensureForeground === false) throw new ComputerUseError("FOCUS_FAILED", "目标未在前台，且 ensureForeground=false");
      await this.compositor.focus(context.target, signal);
    }
    await this.guard(context, signal);
  }
  private point(input: ComputerExecInput, context: ActionContext, second = false): Point {
    if (!context.target || context.target.clientGeometryVerified !== true || context.target.geometryReliable !== true) throw new ComputerUseError("STALE_OBSERVATION", "坐标输入需要经过验证的客户区几何");
    const x = finiteNumber(second ? input.x2 : input.x, second ? "x2" : "x");
    const y = finiteNumber(second ? input.y2 : input.y, second ? "y2" : "y");
    const point = SCREEN_ACTIONS.has(input.action!) ? { x, y } : clientDipToLogical(context.target!, x, y);
    const rounded = { x: Math.floor(point.x), y: Math.floor(point.y) };
    monitorForPoint(context.snapshot.monitors, rounded);
    if (context.target && !containsPoint({ ...context.target.clientOrigin, width: context.target.clientRect.width, height: context.target.clientRect.height }, rounded)) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", "取整后的合成器点位超出目标客户区");
    if (context.control) {
      const rect = context.control.clientBoundsDip;
      if (context.control.boundsReliable !== true || !rect) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "此控件缺少可靠边界；请使用可用的语义动作");
      if (!containsPoint({ x: context.target.clientOrigin.x + rect.x, y: context.target.clientOrigin.y + rect.y, width: rect.width, height: rect.height }, rounded)) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", "输入点超出刚刚验证的控件边界");
    }
    return rounded;
  }
  private async movePointer(point: Point, context: ActionContext, signal?: AbortSignal): Promise<Point> {
    await this.guard(context, signal);
    monitorForPoint(context.snapshot.monitors, point);
    context.submitted = true;
    const actual = await this.compositor.movePointer(point, signal);
    monitorForPoint(context.snapshot.monitors, actual);
    if (context.target && !containsPoint({ ...context.target.clientOrigin, width: context.target.clientRect.width, height: context.target.clientRect.height }, actual)) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", "读回光标超出目标客户区，后续按键未下发", { executed: true, actual });
    this.markCapability("pointer", true, true, "合成器已读回实际光标位置");
    await this.guard(context, signal);
    return actual;
  }
  private async temporaryModifiers(input: ComputerExecInput, context: ActionContext, fn: () => Promise<ComputerExecOutput>, signal?: AbortSignal): Promise<ComputerExecOutput> {
    const codes = (input.modifiers ?? []).flatMap(m => keyChordToKeycodes(m === "win" ? "Super" : m));
    const added = await this.keysDown(codes, context.owner, context.target, signal);
    return this.withInputCleanup(fn, () => this.keysUp(added, context.owner));
  }

  /** Preserve the dispatched action and its first failure when a later release also fails. */
  private async withInputCleanup<T>(operation: () => Promise<T>, cleanup: () => Promise<unknown>): Promise<T> {
    let result: T | undefined; let primary: unknown; let failed = false;
    try { result = await operation(); } catch (error) { primary = error; failed = true; }
    try { await cleanup(); }
    catch (cleanupError) {
      const error = failed ? primary : cleanupError;
      const details = error instanceof ComputerUseError ? this.errorDetails(error) : {};
      const wrapped = new ComputerUseError(error instanceof ComputerUseError ? error.code : "HOST_UNAVAILABLE", errorText(error), { ...details, executed: details.executed ?? "unknown", cleanupError: errorText(cleanupError) });
      if (!failed && result && typeof result === "object" && "action" in result) throw withComputerUseDeliveryEvidence(wrapped, result as ComputerExecOutput);
      throw wrapped;
    }
    if (failed) throw primary;
    return result as T;
  }

  private async perform(input: ComputerExecInput, owner: string, signal: AbortSignal): Promise<ComputerExecOutput> {
    const action = input.action!;
    if (action === "status") { await this.refreshDiagnostics(); return { action, ...this.status() }; }
    if (!this.available) throw new ComputerUseError("HOST_UNAVAILABLE", this.status().detail);
    if (action === "ocr_window") throw new ComputerUseError("OCR_UNAVAILABLE", "Linux 原生后端不包含 OCR 定位；请读取 AT-SPI 控件，或明确请求截图");
    if (action === "mouse_up_client") {
      const released = await this.buttonUp(input.button ?? "left", owner, signal);
      return { action, executed: released, verified: false, releasedButton: released ? input.button ?? "left" : undefined };
    }
    if (action === "key_up") {
      const codes = keyChordToKeycodes(input.key!);
      const released = await this.keysUp(codes, owner, signal);
      return { action, executed: released.length > 0, verified: false, releasedKeys: released, detail: "已释放本任务记录的按键；应用效果未单独验证" };
    }
    if (action === "wait_for_window") return this.waitForWindow(input, owner, signal);
    const snapshot = await this.compositor.snapshot(signal);
    if (action === "list_windows") return { action, windows: filterWindows(snapshot.windows, input), detail: "当前 Hyprland 窗口（桌面坐标为合成器逻辑像素）", coordinateSpace: "hyprland-logical", layoutId: snapshot.layoutId };
    if (action === "active_window") {
      const window = snapshot.windows.find(w => w.handle === snapshot.activeHandle);
      return { action, window, observationId: window ? this.remember(window, owner) : undefined };
    }
    if (COORDINATE_ACTIONS.has(action) && !input.observationId) throw new ComputerUseError("STALE_OBSERVATION", "坐标输入必须携带本任务最近一次窗口观察的 observationId");
    const target = NO_TARGET_ACTIONS.has(action) && !hasWindowSelector(input) && !input.observationId ? undefined : this.resolveTarget(input, snapshot, owner);
    const context: ActionContext = { snapshot, target, submitted: false, owner };
    if (target) computerUseRunCoordinator.presentTarget(input, target, INPUT_ACTIONS.has(action) ? "acting" : "observing");
    else computerUseRunCoordinator.presentDesktop(input, INPUT_ACTIONS.has(action) ? "acting" : "observing");
    if (action === "attach_app") {
      const id = randomUUID(); const info: AppSessionInfo = { id, window: structuredClone(target!), attachedAt: this.now(), lastSeenAt: this.now() };
      this.sessions.set(id, { info, owner }); while (this.sessions.size > 64) this.sessions.delete(this.sessions.keys().next().value!);
      return { action, window: target, appSessionId: id, appSession: info, observationId: this.remember(target!, owner) };
    }
    if (action === "inspect_window") return { action, window: target, observationId: this.remember(target!, owner), coordinateSpace: "hyprland-logical", layoutId: snapshot.layoutId, detail: "已读取新鲜合成器窗口几何；inspect_controls 单独读取 AT-SPI 控件" };
    if (["inspect_controls", "find_control"].includes(action)) {
      if (action === "find_control" && !hasControlSelector(input)) throw new ComputerUseError("CONTROL_NOT_FOUND", "find_control 需要控件选择器");
      const tree = await this.inspect(target!, snapshot, owner, input, signal);
      const controls = action === "find_control" ? tree.controls.filter(c => matchesSelector(c, input)) : tree.controls;
      if (action === "find_control" && !controls.length) throw new ComputerUseError("CONTROL_NOT_FOUND", "已读取的可访问树中没有匹配控件", { truncated: tree.truncated, observationId: tree.observationId });
      return { action, window: target, controls, control: action === "find_control" && controls.length === 1 ? controls[0] : undefined, uiaAvailable: true, readableText: tree.readableText, treeStatus: tree.treeStatus, truncated: tree.truncated, diagnostics: tree.diagnostics, boundsReliable: tree.boundsReliable, observationId: tree.observationId, generation: tree.generation };
    }
    let output: ComputerExecOutput | undefined;
    try {
      if (action === "screenshot" || action === "screenshot_window") {
        if (target && input.clientOnly === false) throw new ComputerUseError("CAPTURE_FAILED", "当前截图提供器只支持合成器客户区，不能保证包含外部装饰");
        if (target && input.ensureForeground !== false) await this.foreground(context, input, signal);
        if (target && !target.visible && input.ensureForeground === false) throw new ComputerUseError("WINDOW_NOT_VISIBLE", "后台或隐藏窗口无法通过屏幕裁剪获得可靠截图");
        const fresh = await this.guard(context, signal, Boolean(target), true);
        output = { action, window: target, ...await this.screenshots.capture({ snapshot: fresh, window: target, screenId: input.screenId, signal }), observationId: target ? this.remember(target, owner) : undefined };
        this.markCapability("screenshot", true, true);
      } else {
        if (!INPUT_ACTIONS.has(action)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", `Linux 后端不支持动作 ${action}`);
        this.assertOwner(owner, target);
        if (COORDINATE_ACTIONS.has(action) && hasControlSelector(input)) context.control = await this.selectControl(target!, snapshot, owner, input, signal);
        await this.foreground(context, input, signal);
        output = await this.act(input, context, signal);
        output = await this.afterAction(input, context, output, signal);
      }
      if (input.restoreForeground) await this.restoreForeground(context, output);
      return output;
    } catch (error) {
      error = withComputerUseDeliveryEvidence(error, output);
      let restoration: Record<string, unknown> | undefined;
      if (input.restoreForeground && !this.heldTargets.has(owner)) { restoration = {}; await this.restoreForeground(context, restoration); }
      if (error instanceof ComputerUseError) throw new ComputerUseError(error.code, error.message, { ...this.errorDetails(error), executed: output ? this.errorExecution(error) : this.errorDetails(error).executed ?? (context.submitted ? "unknown" : false), clipboardChanged: context.clipboardChanged ?? this.errorDetails(error).clipboardChanged, ...(restoration ? { restoration } : {}) });
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", errorText(error), { executed: context.submitted ? "unknown" : false, restoration });
    }
  }

  private async act(input: ComputerExecInput, context: ActionContext, signal: AbortSignal): Promise<ComputerExecOutput> {
    const action = input.action!; const { target, owner } = context;
    const result = (extra: Record<string, unknown> = {}): ComputerExecOutput => ({ action, window: target, executed: true, verified: false, detail: "输入已提交；仅应用或明确后置条件的读回能够证明任务结果", ...extra });
    if (action === "focus_window") return result({ verified: true, detail: "已从合成器读回目标窗口为活动窗口" });
    if (action === "invoke_control" || action === "set_control_value") {
      const control = await this.selectControl(target!, context.snapshot, owner, input, signal);
      if (!control.enabled) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "控件自身或其父链处于 disabled/insensitive 状态");
      await this.guard(context, signal, true, false);
      if (action === "set_control_value" && !control.interfaces.includes(ATSPI_EDITABLE_TEXT) && !control.interfaces.includes(ATSPI_VALUE)) {
        // Chromium/Electron can expose an editable, focusable Text control without
        // EditableText or Value. Use the control's own Component.GrabFocus, then
        // replace its contents through Ctrl+A/Ctrl+V and verify Text readback.
        if (!control.states.includes("editable") || !control.keyboardFocusable) {
          throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "控件没有 EditableText/Value，且未同时声明 editable 与 focusable；拒绝猜测输入目标");
        }
        if (this.heldKeys.size || this.heldButtons.size) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "控件文本替换需要先释放本任务持有的按键和按钮");
        const focus = await this.atspi.focus(target!, control.runtimeId, signal);
        if (focus.executed !== false) context.submitted = true;
        await this.guard(context, signal, true, false);
        await this.sleep(35, signal);
        const focused = await this.atspi.readControl(target!, control.runtimeId, signal);
        if (!focused.enabled || !focused.keyboardFocusable || !focused.states.includes("editable") || !focused.hasKeyboardFocus) {
          throw new ComputerUseError("FOCUS_FAILED", "AT-SPI Component.GrabFocus 后未能读回目标输入框为 focused；未发送键盘文本", { focus, control: focused });
        }
        await (this.options.pasteViaClipboard ?? writeWaylandClipboard)(input.text!, signal);
        context.clipboardChanged = true;
        await this.guard(context, signal, true, false);
        context.submitted = true;
        const chord = async (key: string): Promise<void> => {
          const pressed = await this.keysDown(keyChordToKeycodes(key), owner, target, signal);
          await this.withInputCleanup(() => this.sleep(35, signal), () => this.keysUp(pressed, owner));
        };
        await chord("Ctrl+A");
        await this.guard(context, signal, true, false);
        const selected = await this.atspi.readControl(target!, control.runtimeId, signal);
        if (!selected.enabled || !selected.hasKeyboardFocus || !selected.states.includes("editable")) {
          throw new ComputerUseError("FOCUS_FAILED", "Ctrl+A 后输入焦点或 editable 状态离开目标控件；为避免向其他窗口粘贴，已停止");
        }
        await chord("Ctrl+V");
        let after: AtSpiControlInfo | undefined;
        let readbackError: string | undefined;
        try { after = await this.atspi.readControl(target!, control.runtimeId, signal); }
        catch (error) { readbackError = errorText(error); }
        const verified = after?.text !== undefined && after.textTruncated !== true && after.text === input.text;
        const evidence = verified
          ? "目标 Component.GrabFocus + Ctrl+A/Ctrl+V 后，AT-SPI Text 完整回读与请求值一致"
          : "已通过目标焦点提交 Ctrl+A/Ctrl+V，但没有完整匹配的 AT-SPI Text 回读；执行与验证状态分别保留";
        this.markCapability("semantic", true, verified, evidence);
        return result({ executed: true, verified, control: after ?? focused, textReadback: after?.text, textLength: input.text!.length, clipboardChanged: true, pasted: true, readbackError, focus, detail: evidence });
      }
      context.submitted = true;
      const semantic = action === "invoke_control" ? await this.atspi.invoke(target!, control.runtimeId, undefined, signal) : await this.atspi.setValue(target!, control.runtimeId, input.text!, signal);
      this.markCapability("semantic", semantic.executed !== false, semantic.verified, semantic.evidence);
      return result({ ...semantic, control: semantic.after ?? semantic.before, detail: semantic.evidence });
    }
    if (action === "move_window" || action === "resize_window") {
      await this.guard(context, signal);
      context.submitted = true;
      const geometry = action === "move_window" ? await this.windowControl.move(target!.handle, input.windowX!, input.windowY!, signal) : await this.windowControl.resize(target!.handle, input.windowWidth!, input.windowHeight!, signal);
      const verified = Boolean(geometry && (action === "move_window" ? Math.abs(geometry.x - Math.round(input.windowX!)) <= 1 && Math.abs(geometry.y - Math.round(input.windowY!)) <= 1 : Math.abs(geometry.width - Math.round(input.windowWidth!)) <= 1 && Math.abs(geometry.height - Math.round(input.windowHeight!)) <= 1));
      return result({ geometry, verified, detail: verified ? "已读回请求的窗口几何" : "窗口操作已提交，但未读回所需几何；不要据此重复操作" });
    }
    if (action === "key_down") {
      await this.guard(context, signal); context.submitted = true;
      const pressed = await this.keysDown(keyChordToKeycodes(input.key!), owner, target, signal);
      return result({ executed: pressed.length > 0, pressedKeys: pressed, heldKeys: [...this.heldKeys].filter(([, value]) => value === owner).map(([code]) => code), detail: "按键由本任务持续持有，直到 key_up、任务结束或取消" });
    }
    if (action === "key_press") {
      const codes = keyChordToKeycodes(input.key!);
      if (codes.some(code => this.heldKeys.has(code) && ![29, 42, 54, 56, 97, 100, 125, 126].includes(code)) || codes.every(code => this.heldKeys.has(code))) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "key_press 不能重新按下本任务已持有的普通键；请先 key_up");
      await this.guard(context, signal); context.submitted = true;
      const pressed = await this.keysDown(codes, owner, target, signal);
      await this.withInputCleanup(() => this.sleep(input.holdMs ?? 20, signal), () => this.keysUp(pressed, owner));
      return result();
    }
    if (action === "type_text" || action === "paste_text") {
      // Clipboard preserves Unicode/layout semantics; insertion is never converted into replacement.
      // Ctrl+V cannot be safely added while unrelated held modifiers are active.
      if (this.heldKeys.size || this.heldButtons.size) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "粘贴需要先释放本任务持有的按键和按钮");
      let focused: ControlInfo | undefined;
      try {
        const tree = await this.inspect(target!, context.snapshot, owner, input, signal);
        const candidates = tree.controls.filter(c => c.hasKeyboardFocus && c.text !== undefined);
        if (candidates.length === 1) focused = candidates[0];
      } catch (error) { if (signal.aborted) throw error; /* no semantic tree is a valid input-only case */ }
      await this.guard(context, signal);
      await (this.options.pasteViaClipboard ?? writeWaylandClipboard)(input.text!, signal);
      context.clipboardChanged = true;
      await this.guard(context, signal);
      context.submitted = true;
      const pressed = await this.keysDown(keyChordToKeycodes("Ctrl+V"), owner, target, signal);
      await this.withInputCleanup(() => this.sleep(35, signal), () => this.keysUp(pressed, owner));
      let after: ControlInfo | undefined; let readbackError: string | undefined;
      if (focused) try { after = await this.atspi.readControl(target!, focused.runtimeId, signal); } catch (error) { readbackError = errorText(error); }
      // Without selection/caret readback a text delta cannot prove exact insertion, especially on repeats.
      return result({ clipboardChanged: true, pasted: true, textLength: input.text!.length, control: after, readbackError, textReadback: after?.text, detail: "已将 Unicode 文本写入剪贴板并提交 Ctrl+V；返回可用的控件文本，未推断光标或选区位置" });
    }
    if (action === "mouse_up_client") {
      await this.guard(context, signal); const released = await this.buttonUp(input.button ?? "left", owner, signal);
      return result({ executed: released, releasedButton: released ? input.button ?? "left" : undefined });
    }
    if (action === "scroll" || action === "scroll_client") {
      if (input.x !== undefined || input.y !== undefined) await this.movePointer(this.point(input, context), context, signal);
      await this.guard(context, signal); context.submitted = true;
      const horizontal = input.deltaX ?? 0;
      const vertical = input.notches ?? -(input.deltaY ?? 0);
      return this.temporaryModifiers(input, context, async () => {
        await this.guard(context, signal);
        await this.input.scroll(horizontal, vertical, signal);
        return result({ executed: Boolean(horizontal || vertical), horizontalNotches: horizontal, verticalNotches: vertical });
      }, signal);
    }
    const point = this.point(input, context);
    if (["move_client", "mouse_move"].includes(action)) return result({ actualPointer: await this.movePointer(point, context, signal), verified: true, detail: "已从合成器读回实际光标位置；没有发送鼠标按钮事件" });
    if (action === "mouse_down_client") {
      await this.movePointer(point, context, signal); await this.guard(context, signal); context.submitted = true;
      const pressed = await this.buttonDown(input.button ?? "left", owner, target, signal);
      return result({ pressedButton: pressed ? input.button ?? "left" : undefined, heldButtons: [...this.heldButtons].filter(([, value]) => value === owner).map(([button]) => button) });
    }
    if (["click_client", "mouse_click"].includes(action)) {
      const button = input.button ?? "left";
      if (this.heldButtons.has(button)) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "要点击的按钮已经按下；先 mouse_up_client");
      // Always move before DOWN, including holdMs > 0. No absolute ydotool motion.
      await this.movePointer(point, context, signal);
      return this.temporaryModifiers(input, context, async () => {
        const count = input.clickCount ?? 1; let completedClicks = 0;
        try {
          for (let index = 0; index < count; index++) {
            await this.guard(context, signal); context.submitted = true;
            await this.buttonDown(button, owner, target, signal);
            await this.withInputCleanup(() => this.sleep(input.holdMs ?? 30, signal), () => this.buttonUp(button, owner));
            completedClicks++;
            if (index + 1 < count) await this.sleep(80, signal);
          }
        } catch (error) {
          const details = error instanceof ComputerUseError ? this.errorDetails(error) : {};
          throw new ComputerUseError(error instanceof ComputerUseError ? error.code : "HOST_PROTOCOL_ERROR", errorText(error), { ...details, executed: completedClicks ? true : details.executed ?? "unknown", completedClicks, requestedClicks: count });
        }
        return result({ clickCount: count, completedClicks, actualPointer: point });
      }, signal);
    }
    if (["drag_client", "mouse_drag", "drag_screen"].includes(action)) {
      const endpoint = this.point(input, context, true); const button = input.button ?? "left";
      if (this.heldButtons.has(button)) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "拖动按钮已经按下；请使用显式移动/松开完成已有手势");
      const steps = input.steps ?? 12; const duration = input.durationMs ?? 300;
      const path = Array.from({ length: steps }, (_, index) => ({ x: Math.floor(point.x + (endpoint.x - point.x) * (index + 1) / steps), y: Math.floor(point.y + (endpoint.y - point.y) * (index + 1) / steps) }));
      path.forEach(p => monitorForPoint(context.snapshot.monitors, p));
      await this.movePointer(point, context, signal);
      return this.temporaryModifiers(input, context, async () => {
        await this.guard(context, signal); context.submitted = true;
        await this.buttonDown(button, owner, target, signal);
        const start = this.now(); let actual = point; let completedSteps = 0;
        await this.withInputCleanup(async () => {
          try {
          for (let i = 0; i < path.length; i++) {
            const due = start + duration * (i + 1) / steps;
            await this.sleep(Math.max(0, due - this.now()), signal);
            actual = await this.movePointer(path[i], context, signal); completedSteps++;
          }
        } catch (error) {
          throw new ComputerUseError(error instanceof ComputerUseError ? error.code : "HOST_PROTOCOL_ERROR", errorText(error), { ...(error instanceof ComputerUseError ? this.errorDetails(error) : {}), executed: true, completedSteps, requestedSteps: steps, actualPointer: actual, actualDurationMs: this.now() - start });
          }
        }, () => this.buttonUp(button, owner));
        return result({ actualPointer: actual, completedSteps, requestedDurationMs: duration, actualDurationMs: this.now() - start });
      }, signal);
    }
    throw new ComputerUseError("HOST_PROTOCOL_ERROR", `Linux 后端尚不支持 ${action}`);
  }

  private async afterAction(input: ComputerExecInput, context: ActionContext, output: ComputerExecOutput, signal: AbortSignal): Promise<ComputerExecOutput> {
    if (!input.observeAfter && !input.captureAfter && !input.expectedOutcomes?.length) return output;
    if (context.target) computerUseRunCoordinator.presentTarget(input, context.target, "verifying");
    let fresh: HyprlandSnapshot;
    try { fresh = await this.compositor.snapshot(signal); }
    catch (error) {
      return { ...output, observationStatus: "failed", observationError: errorText(error), semanticOutcome: input.expectedOutcomes?.length ? { status: "not_evaluable", checks: input.expectedOutcomes.map(check => ({ kind: check.kind, status: "not_evaluable", evidence: `操作后窗口读回失败：${errorText(error)}` })) } : undefined, ...(input.captureAfter ? { captureError: `未能取得新鲜截图目标：${errorText(error)}` } : {}) };
    }
    const targetAfter = context.target ? fresh.windows.find(w => sameWindowIdentity(context.target!, w)) : undefined;
    const foregroundBefore = context.snapshot.windows.find(w => w.handle === context.snapshot.activeHandle);
    const foregroundAfter = fresh.windows.find(w => w.handle === fresh.activeHandle);
    const newWindows = fresh.windows.filter(w => !context.snapshot.windows.some(before => sameWindowIdentity(before, w)));
    const closedWindows = context.snapshot.windows.filter(w => !fresh.windows.some(after => sameWindowIdentity(w, after)));
    output = { ...output, observation: { targetBefore: context.target, targetAfter, foregroundBefore: foregroundBefore?.handle, foregroundAfter: foregroundAfter?.handle, focusPreserved: Boolean(foregroundBefore && foregroundAfter && sameWindowIdentity(foregroundBefore, foregroundAfter)), newWindows, closedWindows }, observationId: targetAfter ? this.remember(targetAfter, context.owner) : undefined, observationStatus: "available" };
    try { output.semanticOutcome = await this.evaluateOutcomes(input, context, fresh, targetAfter, newWindows, signal); }
    catch (error) { output.semanticOutcome = { status: "not_evaluable", checks: (input.expectedOutcomes ?? []).map(check => ({ kind: check.kind, status: "not_evaluable", evidence: `后置条件读回失败：${errorText(error)}` })) }; output.verificationError = errorText(error); }
    // A passed explicit postcondition is evidence about its own requested facts.
    // It cannot upgrade an unknown transport result into a confirmed delivery.
    if (output.semanticOutcome.status === "passed" && output.executed === true && output.batch?.completed !== false) output.verified = true;
    if (input.captureAfter) {
      try {
        if (context.target && !targetAfter) throw new ComputerUseError("WINDOW_NOT_FOUND", "操作后目标窗口已关闭");
        if (targetAfter && (!targetAfter.visible || fresh.activeHandle !== targetAfter.handle)) throw new ComputerUseError("WINDOW_NOT_VISIBLE", "操作后目标不在可见前台，不能保证截图裁剪属于该窗口");
        const captureContext = { ...context, snapshot: fresh, target: targetAfter };
        const captureSnapshot = await this.guard(captureContext, signal, Boolean(targetAfter), true);
        const capture = await this.screenshots.capture({ snapshot: captureSnapshot, window: targetAfter, signal });
        output = { ...output, ...capture };
        this.markCapability("screenshot", true, true);
      } catch (error) {
        output.captureError = errorText(error);
        this.markCapability("screenshot", false, false, errorText(error));
      }
    }
    return output;
  }

  private async evaluateOutcomes(input: ComputerExecInput, context: ActionContext, fresh: HyprlandSnapshot, targetAfter: LinuxWindowInfo | undefined, newWindows: LinuxWindowInfo[], signal: AbortSignal): Promise<ComputerSemanticOutcome> {
    if (!input.expectedOutcomes?.length) return { status: "not_requested", checks: [] };
    let tree: AtSpiInspection | undefined; let treeError: string | undefined; let inspected = false;
    const checks: ComputerSemanticOutcome["checks"] = [];
    for (const check of input.expectedOutcomes) {
      let status: "passed" | "failed" | "not_evaluable" = "not_evaluable"; let evidence = "缺少可验证的目标";
      if (check.kind === "new_window") {
        const matches = newWindows.filter(w => !check.windowTitleContains || w.title.toLowerCase().includes(check.windowTitleContains.toLowerCase()));
        status = matches.length ? "passed" : "failed"; evidence = matches.length ? `观察到 ${matches.length} 个新窗口生命周期：${matches.map(w => w.handle).join(", ")}` : "新鲜窗口清单中没有符合条件的新窗口生命周期";
      } else if (context.target && ["target_present", "target_closed", "target_foreground"].includes(check.kind)) {
        const passed = check.kind === "target_present" ? Boolean(targetAfter) : check.kind === "target_closed" ? !targetAfter : Boolean(targetAfter && targetAfter.handle === fresh.activeHandle && targetAfter.visible);
        status = passed ? "passed" : "failed"; evidence = `${context.target.handle} 的同一窗口生命周期${targetAfter ? "仍存在" : "已消失"}；活动窗口为 ${fresh.activeHandle ?? "无"}`;
      } else if (check.kind === "control_present" || check.kind === "control_absent") {
        if (!hasControlSelector(check)) evidence = "控件后置条件缺少明确选择器";
        else if (!targetAfter) evidence = "目标窗口不可用，无法读取控件树";
        else {
          if (!inspected) {
            inspected = true;
            try { tree = await this.inspect(targetAfter, fresh, context.owner, { ...input, maxDepth: input.maxDepth ?? 12, maxNodes: input.maxNodes ?? 1200 }, signal); }
            catch (error) { treeError = errorText(error); }
          }
          if (!tree) evidence = `控件读回失败：${treeError ?? "未知错误"}`;
          else {
            // runtimeId is observation-scoped. Read that original reference instead of
            // comparing it with the fresh inspection's newly-issued IDs.
            let found = tree.controls.some(control => matchesSelector(control, check));
            if (check.controlRuntimeId) {
              try { const control = await this.selectControl(targetAfter, fresh, context.owner, check, signal); found = matchesSelector(control, check); }
              catch (error) { evidence = `原控件引用无法读回：${errorText(error)}`; checks.push({ kind: check.kind, status: "not_evaluable", evidence }); continue; }
            }
            if (!found && tree.truncated) evidence = "树已截断；未发现控件不能证明控件不存在";
            else { const passed = check.kind === "control_present" ? found : !found; status = passed ? "passed" : "failed"; evidence = found ? "在新鲜 AT-SPI 读回中找到匹配控件" : "完整 AT-SPI 读回中没有匹配控件"; }
          }
        }
      }
      checks.push({ kind: check.kind, status, evidence });
    }
    return { status: checks.some(check => check.status === "failed") ? "failed" : checks.some(check => check.status === "not_evaluable") ? "not_evaluable" : "passed", checks };
  }

  private async restoreForeground(context: ActionContext, output: Record<string, unknown>): Promise<void> {
    const previous = context.snapshot.windows.find(w => w.handle === context.snapshot.activeHandle);
    if (!previous || previous.handle === context.target?.handle) { output.foregroundRestored = false; output.restoreDetail = "没有不同的原前台窗口需要恢复"; return; }
    if (this.heldTargets.has(context.owner)) { output.foregroundRestored = false; output.restoreDeferred = true; output.restoreDetail = "本任务仍持有输入；恢复前台会把持续输入带到其他窗口，请先松开"; return; }
    try {
      const signal = AbortSignal.timeout(1800);
      const fresh = await this.compositor.snapshot(signal);
      const current = fresh.windows.find(window => sameWindowIdentity(previous, window));
      if (!current) throw new ComputerUseError("TARGET_CHANGED", "原前台窗口已经关闭或重建");
      if (fresh.activeHandle !== current.handle) await this.compositor.focus(current, signal);
      const after = await this.compositor.snapshot(signal);
      output.foregroundRestored = after.activeHandle === current.handle && after.windows.some(window => sameWindowIdentity(current, window));
      if (!output.foregroundRestored) throw new ComputerUseError("FOCUS_FAILED", "恢复后未读回原窗口为活动窗口");
    } catch (error) { output.foregroundRestored = false; output.restoreError = errorText(error); }
  }

  private async waitForWindow(input: ComputerExecInput, owner: string, signal: AbortSignal): Promise<ComputerExecOutput> {
    const state = input.waitState ?? "visible";
    const began = this.now(); const timeoutMs = input.timeoutMs ?? 5000;
    let original: LinuxWindowInfo | undefined;
    let first = true;
    for (;;) {
      throwIfCancelled(signal);
      const snapshot = await this.compositor.snapshot(signal);
      let window: LinuxWindowInfo | undefined;
      try { window = this.resolveTarget(input, snapshot, owner); }
      catch (error) {
        if (!(error instanceof ComputerUseError) || (error.code !== "WINDOW_NOT_FOUND" && !(state === "closed" && error.code === "TARGET_CHANGED"))) throw error;
      }
      if (first) { original = window; first = false; }
      const same = original ? window && sameWindowIdentity(original, window) : window;
      const done = state === "closed" ? !same : Boolean(window && window.visible && (state !== "foreground" || snapshot.activeHandle === window.handle));
      if (done) return { action: "wait_for_window", window, observationId: window ? this.remember(window, owner) : undefined, waitedMs: this.now() - began, waitState: state, verified: true, detail: `已从当前合成器状态验证 ${state}` };
      if (this.now() - began >= timeoutMs) throw new ComputerUseError("WAIT_TIMEOUT", `等待窗口 ${state} 超时`, { waitedMs: this.now() - began, window });
      await this.sleep(Math.min(100, timeoutMs - (this.now() - began)), signal);
    }
  }

  private async batch(input: ComputerExecInput, owner: string, signal: AbortSignal): Promise<ComputerExecOutput> {
    const snapshot = await this.compositor.snapshot(signal);
    const target = this.resolveTarget(input, snapshot, owner);
    this.assertOwner(owner, target);
    const context: ActionContext = { snapshot, target, submitted: false, owner };
    const steps: Array<ComputerBatchStepResult & { executed?: unknown; verified?: unknown; errorCode?: string; errorDetails?: unknown }> = [];
    const results: ComputerExecOutput[] = [];
    let observationId = input.observationId;
    let failed = false;
    for (let index = 0; index < input.actions!.length; index++) {
      const step: ComputerBatchStep = input.actions![index];
      try {
        throwIfCancelled(signal);
        if (index) await this.guard(context, signal, false, true);
        const stepInput: ComputerExecInput = { ...input, ...step, actions: undefined, action: step.action, windowHandle: target.handle, observationId, restoreForeground: false, expectedOutcomes: undefined, captureAfter: false, observeAfter: false };
        const result = await this.perform(stepInput, owner, signal);
        context.submitted ||= result.executed !== false;
        results.push(result);
        steps.push({ index, action: step.action, ok: true, detail: result.detail, executed: result.executed, verified: result.verified });
        if (index + 1 < input.actions!.length) await this.sleep(input.settleMs ?? 120, signal);
      } catch (error) {
        failed = true;
        const details = error instanceof ComputerUseError ? this.errorDetails(error) : undefined;
        steps.push({ index, action: step.action, ok: false, detail: errorText(error), executed: details?.executed ?? false, errorCode: error instanceof ComputerUseError ? error.code : "HOST_PROTOCOL_ERROR", errorDetails: details });
        break;
      }
    }
    const cleanup = failed ? await this.releaseOwned(owner) : undefined;
    let output: ComputerExecOutput = { action: "batch", window: target, batch: { steps, completed: !failed, settleMs: input.settleMs ?? 120 }, stepResults: results, executed: steps.some(step => step.executed === true) ? true : steps.some(step => step.executed === "unknown") ? "unknown" : false, executionUncertain: steps.some(step => step.executed === "unknown"), verified: false, cleanup, detail: failed ? "批处理在首个失败或取消处停止；已执行步骤不会回滚或重放" : "批处理已顺序执行；每步结果保留各自的执行与验证证据" };
    output = await this.afterAction(input, context, output, signal);
    if (input.restoreForeground) await this.restoreForeground(context, output);
    return output;
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.lifetime.abort();
    await this.queue.catch(() => undefined);
    const cleanup = await this.releaseOwned();
    const results = await Promise.allSettled([this.atspi.shutdown(), this.input.shutdown(), this.compositor.shutdown?.()]);
    this.observations.clear(); this.sessions.clear(); this.controlReferences.clear();
    const failures = results.flatMap(result => result.status === "rejected" ? [errorText(result.reason)] : []);
    if (cleanup.errors.length || failures.length) throw new ComputerUseError("HOST_UNAVAILABLE", "Linux 桌面后端关闭期间的输入清理或进程关闭失败", { cleanup, failures });
  }
}
