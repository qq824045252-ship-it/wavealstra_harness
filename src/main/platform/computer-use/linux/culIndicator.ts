/**
 * CUL 自带的屏幕指示器（`computer-use-linux-indicator`）客户端。
 *
 * 为什么用它：Linux/Wayland 上画不出 Windows 那种窗口外框（Electron 透明窗口会被 portal
 * 截进 agent 自己的截图，且分数缩放下只铺 1957×1304 / 2160×1440），但 CUL 的 indicator
 * 是 **layer-shell 原生覆盖层**，实测（2026-10-27，Hyprland 0.56.2 / 1.6x）：
 * - 四条 26 逻辑像素的边缘光晕 + 一个 560×56 的 pill，`hyprctl layers` 可见；
 * - pill 文案 = `<agent> is using your computer · <tool>`，`tool` 原样显示 → 可以当 phase 文案，
 *   但**只支持 ASCII**（中文渲染成方块）；
 * - 显示约 8 秒，每 2 秒重发一次即可连续保持；
 * - **CUL 自己截图时会持有 `computer-use-linux-indicator.capture` 的 flock，indicator 不画任何
 *   像素**（实测返回图里指示器像素为 0）→ 不会污染 agent 的截图，这正是我们需要的。
 *
 * 它是一个无参常驻 daemon，靠 `$XDG_RUNTIME_DIR/computer-use-linux-indicator.sock`
 * 收 `SOCK_DGRAM` JSON；没有 CLI、Hyprland 上也没有 D-Bus 接口（那是 GNOME Shell 扩展路径）。
 * 协议未公开、随 CUL 版本可能变化，所以整层是 **尽力而为 + 失败静默降级** 到 hyprctl 通知。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ComputerUsePhase } from "../../../capabilities/ComputerUsePolicy";
import { executableInPath } from "../support";
import { culHelperPaths, resolveCulBinary } from "./culBinary";

/** pill 里的 tool 字段（ASCII；indicator 渲染不了中文）。 */
export const INDICATOR_PHASE_WORDS: Record<ComputerUsePhase, string> = {
  observing: "observing",
  acting: "acting",
  verifying: "verifying",
  waiting: "waiting",
  recovering: "recovering",
  completed: "done",
  failed: "failed",
};

/** 与 `CulMcpClient` 的 clientInfo 同名，pill 文案才是 “mybuddy-computer-use is using your computer”。 */
export const INDICATOR_AGENT_NAME = "mybuddy-computer-use";

export function indicatorSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (!runtime) return undefined;
  return join(runtime, "computer-use-linux-indicator.sock");
}

export function indicatorPayload(phase: ComputerUsePhase, agent = INDICATOR_AGENT_NAME): string {
  return JSON.stringify({ agent, tool: INDICATOR_PHASE_WORDS[phase] });
}

/**
 * Node 的 `node:dgram` 只支持 udp4/udp6，**不能发 unix dgram**，所以发送走外部工具。
 * `socat -u - UNIX-SENDTO:<path>` 实测可用（indicator 收到后立刻显示光晕）；缺 socat 时
 * 用 python3 兜底；两个都没有就整体不可用（回落 hyprctl 通知）。
 */
export type IndicatorTransport = "socat" | "python3";

export function pickIndicatorTransport(executable: (name: string) => string | undefined = executableInPath): IndicatorTransport | undefined {
  if (executable("socat")) return "socat";
  if (executable("python3")) return "python3";
  return undefined;
}

const PYTHON_SEND = [
  "import socket,sys",
  "s=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)",
  "s.sendto(sys.argv[1].encode(),sys.argv[2])",
].join("\n");

export interface CulIndicatorOptions {
  /** 注入发送器（单测/降级）；调用成功返回 true。 */
  send?: (payload: string) => boolean;
  /** 注入 “确保 indicator 进程存在”；返回是否可用。 */
  ensureServer?: () => Promise<boolean>;
  /** 注入可执行文件探测（单测）。 */
  executable?: (name: string) => string | undefined;
  heartbeatMs?: number;
}

/**
 * indicator 客户端。
 *
 * `show()` 立即发一条并开始 2 秒心跳（indicator 约 8 秒淡出，心跳保证整轮操作期间一直亮着）；
 * `stop()` 停心跳并关闭 socket。所有错误都吞掉：没有 indicator（旧版本 CUL/没启动）
 * 时回落到 `hyprctl notify`，不能让反馈层影响 Computer Use 本身。
 */
export class CulIndicator {
  private heartbeat?: NodeJS.Timeout;
  private lastPhase?: ComputerUsePhase;
  private serverChecked?: Promise<boolean>;
  private readonly transport: IndicatorTransport | undefined = undefined;

  constructor(private readonly options: CulIndicatorOptions = {}) {
    this.transport = pickIndicatorTransport(options.executable);
  }

  get available(): boolean {
    if (this.options.send) return true;
    if (!this.transport) return false;
    const socketPath = indicatorSocketPath();
    if (socketPath && existsSync(socketPath)) return true;
    const binary = resolveCulBinary();
    return Boolean(binary && culHelperPaths(binary).indicator);
  }

  /** 发一条 phase（必要时启动 indicator 进程并建立 socket）。返回是否真的发出去了。 */
  show(phase: ComputerUsePhase): boolean {
    this.lastPhase = phase;
    const sent = this.deliver(indicatorPayload(phase));
    if (!sent) return false;
    this.startHeartbeat();
    return true;
  }

  /** 停止心跳；indicator 会在约 8 秒内自行淡出。 */
  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.lastPhase = undefined;
  }

  private startHeartbeat(): void {
    const interval = Math.max(250, this.options.heartbeatMs ?? 2_000);
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (!this.lastPhase) return;
      if (!this.deliver(indicatorPayload(this.lastPhase))) this.stop();
    }, interval);
    this.heartbeat.unref?.();
  }

  private deliver(payload: string): boolean {
    if (this.options.send) {
      try {
        return this.options.send(payload);
      } catch {
        return false;
      }
    }
    const socketPath = indicatorSocketPath();
    if (!socketPath || !this.transport) return false;
    void this.ensureServer();
    try {
      if (this.transport === "socat") {
        const child = spawn("socat", ["-u", "-", `UNIX-SENDTO:${socketPath}`], { stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", (error) => console.warn(`[CulIndicator] socat failed: ${error.message}`));
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(payload);
        child.unref();
        return true;
      }
      const child = spawn("python3", ["-c", PYTHON_SEND, payload, socketPath], { stdio: "ignore" });
      child.on("error", (error) => console.warn(`[CulIndicator] python3 failed: ${error.message}`));
      child.unref();
      return true;
    } catch (error) {
      console.warn(`[CulIndicator] ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** indicator 没在跑就拉起来（CUL server 通常已经 spawn 过，直接复用同一个 daemon）。 */
  private ensureServer(): Promise<boolean> {
    if (this.serverChecked) return this.serverChecked;
    if (this.options.ensureServer) {
      this.serverChecked = Promise.resolve(this.options.ensureServer()).catch(() => false);
      return this.serverChecked;
    }
    this.serverChecked = (async () => {
      const socketPath = indicatorSocketPath();
      if (socketPath && existsSync(socketPath)) return true;
      const binary = resolveCulBinary();
      const indicator = binary ? culHelperPaths(binary).indicator : undefined;
      if (!indicator) return false;
      try {
        const child = spawn(indicator, [], { stdio: "ignore", detached: true });
        child.on("error", () => undefined);
        child.unref();
      } catch {
        return false;
      }
      // 等 socket 出现（正常 <300ms）；超时就当不可用，让调用方降级。
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (socketPath && existsSync(socketPath)) return true;
      }
      return false;
    })();
    return this.serverChecked;
  }
}

export function createCulIndicator(options: CulIndicatorOptions = {}): CulIndicator {
  return new CulIndicator(options);
}
