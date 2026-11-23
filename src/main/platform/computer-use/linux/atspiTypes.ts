import type { ControlInfo, WindowInfo } from "../protocol";

export const ATSPI_WORKER_PROTOCOL = 1 as const;

/**
 * 控件引用 / 窗口观察在内存里的最长复用寿命。
 *
 * 这不是输入安全阀：每次动作前都会重新读取合成器快照（layoutId、窗口几何、生命期标记）、
 * 控件 enabled/可靠边界、总线代次与焦点，任何变化都以 STALE_OBSERVATION 拒绝；对象重建还会
 * 由事件置 invalidReason 立即失效。它只决定「观察结果能保留多久」。
 *
 * 真实 agent 的一轮 = 模型思考 + 工具往返 + 界面流式输出，几十秒是常态，30 秒短于一次往返，
 * 于是 inspect_window → inspect_controls / invoke_control 这条官方流程在真实会话里必然报
 * 「观察已过期」（GUI/单测在毫秒内连续调用，永远测不出来）。5 分钟覆盖一次完整往返，同时仍
 * 限制了陈旧观察的生命期。
 */
export const ATSPI_REFERENCE_TTL_MS = 5 * 60_000;

export interface AtSpiObjectReference {
  busName: string;
  objectPath: string;
}

export interface AtSpiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A compositor observation, never an inferred monitor-scale conversion. */
export interface AtSpiGeometry {
  coordinateSpace: "hyprland-logical";
  clientLogical: AtSpiRect;
  /** Layout/window geometry fingerprint supplied by the compositor driver. */
  identity: string;
}

export interface AtSpiInspectOptions {
  maxDepth?: number;
  maxNodes?: number;
  timeoutMs?: number;
  observationId?: string;
  geometry?: AtSpiGeometry;
  /** Fresh compositor census, used to establish a unique one-to-one binding. */
  peerWindows?: WindowInfo[];
}

export interface AtSpiControlInfo extends ControlInfo {
  interfaces: string[];
  states: string[];
  value?: number;
  textTruncated?: boolean;
  atspi: AtSpiObjectReference & {
    generation: string;
    observationId: string;
    windowHandle: string;
    role: number;
    parent?: AtSpiObjectReference;
    screenBounds?: AtSpiRect;
    windowBounds?: AtSpiRect;
    boundsSource?: "atspi-screen" | "atspi-window";
    boundsReliable: boolean;
    boundsReason?: string;
    /** Raw document units per compositor logical pixel, verified from its viewport. */
    coordinateScale?: number;
    coordinateRoot?: AtSpiObjectReference;
  };
}

export interface AtSpiInspection {
  controls: AtSpiControlInfo[];
  readableText: string;
  truncated: boolean;
  diagnostics: string[];
  generation: string;
  windowRef: string;
  observationId: string;
  boundsReliable: boolean;
  /** Distinguishes an exported but empty frame from a missing bridge. */
  treeStatus: "available" | "empty" | "truncated";
}

export interface AtSpiProbeResult {
  available: boolean;
  generation: string;
  checkedAt: number;
  applicationCount?: number;
  reason?: string;
  code?: string;
  diagnostics?: string[];
}

export interface AtSpiSemanticResult {
  /** "unknown" means the request may have reached the application. Never replay it. */
  executed: boolean | "unknown";
  verified: boolean;
  before: AtSpiControlInfo;
  after?: AtSpiControlInfo;
  evidence: string;
  readbackError?: string;
}

export interface AtSpiDriverApi {
  probe(signal?: AbortSignal): Promise<AtSpiProbeResult>;
  inspectWindow(window: WindowInfo, options?: AtSpiInspectOptions, signal?: AbortSignal): Promise<AtSpiInspection>;
  readControl(window: WindowInfo, runtimeId: string, signal?: AbortSignal): Promise<AtSpiControlInfo>;
  /** Request AT-SPI Component.GrabFocus and verify the resulting focused state. */
  focus(window: WindowInfo, runtimeId: string, signal?: AbortSignal): Promise<AtSpiSemanticResult>;
  invoke(window: WindowInfo, runtimeId: string, actionName?: string, signal?: AbortSignal): Promise<AtSpiSemanticResult>;
  setValue(window: WindowInfo, runtimeId: string, text: string, signal?: AbortSignal): Promise<AtSpiSemanticResult>;
  shutdown(): Promise<void>;
}

export interface AtSpiHandshake {
  protocol: typeof ATSPI_WORKER_PROTOCOL;
  backend: "linux-atspi";
  nodeVersion: string;
  dbusNativeVersion: string;
  pid: number;
  ready: true;
}

export type AtSpiWorkerRequest =
  | { id: number; method: "probe" }
  | { id: number; method: "inspectWindow"; window: WindowInfo; options?: AtSpiInspectOptions }
  | { id: number; method: "readControl"; window: WindowInfo; runtimeId: string }
  | { id: number; method: "focus"; window: WindowInfo; runtimeId: string }
  | { id: number; method: "invoke"; window: WindowInfo; runtimeId: string; actionName?: string }
  | { id: number; method: "setValue"; window: WindowInfo; runtimeId: string; text: string }
  | { id: number; method: "shutdown" }
  | { id: number; method: "cancel"; requestId: number };

export type AtSpiWorkerReply =
  | { type: "ready"; handshake: AtSpiHandshake }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; error: { code: string; message: string; details?: unknown } };
