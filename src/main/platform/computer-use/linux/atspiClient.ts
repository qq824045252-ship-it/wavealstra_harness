import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ComputerUseError, type AutomationErrorCode, type WindowInfo } from "../protocol";
import {
  ATSPI_WORKER_PROTOCOL,
  type AtSpiControlInfo,
  type AtSpiDriverApi,
  type AtSpiHandshake,
  type AtSpiInspection,
  type AtSpiInspectOptions,
  type AtSpiProbeResult,
  type AtSpiSemanticResult,
  type AtSpiWorkerReply,
  type AtSpiWorkerRequest,
} from "./atspiTypes";

type RpcMethod = Exclude<AtSpiWorkerRequest["method"], "cancel">;
type RequestBody = AtSpiWorkerRequest extends infer R ? R extends { id: number } ? Omit<R, "id"> : never : never;

interface PendingRequest {
  child: ChildProcess;
  method: RpcMethod;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  clear: () => void;
}

export interface AtSpiClientOptions {
  workerPath?: string;
  /** Injected only by transport lifecycle tests. */
  spawnWorker?: (workerPath: string) => ChildProcess;
  startupTimeoutMs?: number;
  onUnexpectedExit?: (error: ComputerUseError) => void;
}

/** Resolve the emitted worker, including Electron's asar unpacked location. */
export function resolveAtSpiWorkerPath(explicit?: string): string | undefined {
  if (explicit !== undefined) return existsSync(explicit) ? explicit : undefined;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, "app.asar.unpacked", "out", "main", "atspi-worker.cjs")] : []),
    join(__dirname, "atspi-worker.cjs"),
    resolve(__dirname, "..", "main", "atspi-worker.cjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function isMutation(method: RpcMethod): boolean { return method === "invoke" || method === "setValue"; }

export function validateAtSpiHandshake(value: unknown): AtSpiHandshake {
  const handshake = value as Partial<AtSpiHandshake> | null;
  const nodeVersion = typeof handshake?.nodeVersion === "string" ? /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(handshake.nodeVersion) : null;
  if (!handshake || handshake.protocol !== ATSPI_WORKER_PROTOCOL || handshake.backend !== "linux-atspi" ||
    handshake.ready !== true || !nodeVersion || !Number.isSafeInteger(Number(nodeVersion[1])) || Number(nodeVersion[1]) < 24 ||
    handshake.dbusNativeVersion !== "0.16.3" || !Number.isSafeInteger(handshake.pid) || Number(handshake.pid) <= 0) {
    throw new ComputerUseError("HOST_PROTOCOL_ERROR", "AT-SPI worker 握手不符合协议、Node >=24 或锁定 dbus-native 版本要求", { handshake });
  }
  return handshake as AtSpiHandshake;
}

/**
 * Persistent, isolated AT-SPI worker. A lost response never retries a mutation.
 * Abort messages bypass the worker queue; queued requests cannot touch D-Bus
 * after cancellation. Mutation cancellation allows a bounded readback reply.
 */
export class AtSpiClient implements AtSpiDriverApi {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private handshakeValue?: AtSpiHandshake;
  private stopped = false;
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private quarantineFence?: Promise<void>;
  private readonly quarantined = new WeakMap<ChildProcess, Promise<void>>();
  private readonly exited = new WeakSet<ChildProcess>();
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderr = "";

  constructor(private readonly options: AtSpiClientOptions = {}) {}

  get handshake(): AtSpiHandshake | undefined { return this.handshakeValue; }
  get pid(): number | undefined { return this.handshakeValue?.pid; }

  /** A signal request is not proof of exit. Never reuse or replace a worker
   * until its process has exited; a failed fence keeps the client closed. */
  private async stopWorker(child: ChildProcess): Promise<void> {
    if (this.exited.has(child) || typeof child.exitCode === "number" || typeof child.signalCode === "string") return;
    await new Promise<void>((resolveStop, reject) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const clear = (): void => {
        clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        child.removeListener("exit", done);
        child.removeListener("close", done);
      };
      const done = (): void => { this.exited.add(child); clear(); resolveStop(); };
      child.once("exit", done);
      child.once("close", done);
      const termTimer = setTimeout(() => {
        // Schedule the confirmation deadline before kill(): injected workers
        // may emit exit synchronously, and must be able to clear both timers.
        killTimer = setTimeout(() => {
          clear();
          reject(new ComputerUseError("HOST_UNAVAILABLE", "无法确认旧 AT-SPI worker 已停止，拒绝启动新请求", {
            diagnosticCode: "WORKER_STOP_UNCONFIRMED", workerPid: child.pid, referencesInvalidated: true,
          }));
        }, 2_000);
        try { child.kill("SIGKILL"); } catch { /* Exit/close remains the authority. */ }
      }, 500);
      try { child.kill("SIGTERM"); } catch { /* Escalate and require actual exit. */ }
    });
  }

  private quarantineWorker(child: ChildProcess, error: ComputerUseError, originatingRequestId?: number): Promise<void> {
    const existing = this.quarantined.get(child);
    if (existing) return existing;
    // Remove the usable handle and install the fence synchronously, before
    // rejecting callers or invoking recovery callbacks that can make new RPCs.
    if (this.child === child) { this.child = undefined; this.handshakeValue = undefined; }
    let resolveFence!: () => void;
    let rejectFence!: (error: unknown) => void;
    const fence = new Promise<void>((resolveStop, reject) => { resolveFence = resolveStop; rejectFence = reject; });
    this.quarantined.set(child, fence);
    this.quarantineFence = fence;
    void fence.catch(() => {});
    for (const [id, request] of this.pending) {
      if (request.child !== child) continue;
      this.pending.delete(id); request.clear();
      request.reject(new ComputerUseError(id === originatingRequestId ? error.code : "HOST_UNAVAILABLE", error.message, {
        ...error.details as Record<string, unknown>, requestId: id,
        executed: isMutation(request.method) ? "unknown" : false, retrySafe: !isMutation(request.method), referencesInvalidated: true,
      }));
    }
    void this.stopWorker(child).then(resolveFence, rejectFence);
    if (!this.stopping && !this.stopped) this.options.onUnexpectedExit?.(error);
    return fence;
  }

  private async ensureWorker(): Promise<void> {
    if (this.stopped || this.stopping) throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI worker 已关闭");
    if (this.quarantineFence) await this.quarantineFence;
    if (this.stopped || this.stopping) throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI worker 已关闭");
    if (this.child?.connected && this.handshakeValue) return;
    if (this.starting) return await this.starting;
    const workerPath = resolveAtSpiWorkerPath(this.options.workerPath);
    if (!workerPath) throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI worker 未构建或未包含在安装包中", { diagnosticCode: "WORKER_MISSING" });
    this.stderr = "";
    const spawnWorker = this.options.spawnWorker ?? ((path: string) => fork(path, [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
      windowsHide: true,
    }));
    const child = spawnWorker(workerPath);
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer | string) => { if (this.child === child) this.stderr = (this.stderr + String(chunk)).slice(-8_192); });
    const starting = new Promise<void>((resolveStart, rejectStart) => {
      let settled = false;
      const finishStart = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectStart(error);
        else resolveStart();
      };
      const timer = setTimeout(() => {
        const error = new ComputerUseError("REQUEST_TIMEOUT", "AT-SPI worker 握手超时");
        finishStart(error);
        void this.quarantineWorker(child, error);
      }, Math.max(250, this.options.startupTimeoutMs ?? 5_000));
      child.on("message", (raw: unknown) => {
        if (this.child !== child || this.quarantined.has(child)) return;
        const message = raw as AtSpiWorkerReply | null;
        if (!message || typeof message !== "object") return;
        if (message.type === "ready") {
          try {
            this.handshakeValue = validateAtSpiHandshake(message.handshake);
            finishStart();
          } catch (error) {
            finishStart(error as Error);
            void this.quarantineWorker(child, error instanceof ComputerUseError ? error : new ComputerUseError("HOST_PROTOCOL_ERROR", String(error)));
          }
          return;
        }
        if (message.type !== "result" && message.type !== "error") return;
        const pending = this.pending.get(message.id);
        if (!pending || pending.child !== child) return;
        this.pending.delete(message.id);
        pending.clear();
        if (message.type === "result") pending.resolve(message.result);
        else {
          const code = typeof message.error?.code === "string" ? message.error.code as AutomationErrorCode : "HOST_PROTOCOL_ERROR";
          pending.reject(new ComputerUseError(code, message.error?.message ?? "AT-SPI worker 返回错误", message.error?.details));
        }
      });
      const failed = (cause: string): void => {
        const error = new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI worker 已退出：" + cause, {
          diagnosticCode: "WORKER_EXITED", stderr: this.stderr || undefined,
          referencesInvalidated: true,
        });
        finishStart(error);
        void this.quarantineWorker(child, error);
      };
      child.once("error", (error) => failed(error.message));
      child.once("exit", (code, signal) => { this.exited.add(child); failed("code=" + String(code) + ", signal=" + String(signal)); });
      child.once("close", () => { this.exited.add(child); failed("process closed"); });
      child.once("disconnect", () => failed("IPC disconnected"));
    });
    this.starting = starting;
    try { await starting; }
    finally { if (this.starting === starting) this.starting = undefined; }
  }

  private async rpc<T>(request: RequestBody, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
    if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 请求在排队前已取消", { executed: false });
    await this.ensureWorker();
    if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 请求在发送前已取消", { executed: false });
    const child = this.child;
    if (this.stopping || this.stopped || !child?.connected || request.method === "cancel") throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI worker 不可用", { executed: false });
    if (this.pending.size >= 128) throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI 请求队列已满，未发送请求");
    const method = request.method;
    const id = this.nextId++;
    return await new Promise<T>((resolveResult, reject) => {
      let cancelled = false;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const clear = (): void => {
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      const cancel = (code: "REQUEST_CANCELLED" | "REQUEST_TIMEOUT"): void => {
        if (cancelled || !this.pending.has(id)) return;
        cancelled = true;
        clearTimeout(timer);
        if (child.connected) child.send({ id: this.nextId++, method: "cancel", requestId: id }, () => {});
        const fail = (): void => {
          if (!this.pending.has(id)) return;
          const error = new ComputerUseError(code, code === "REQUEST_TIMEOUT" ? "AT-SPI 请求超时；已请求停止且不会自动重放" : "AT-SPI 请求已取消；已发送的远端动作不能撤回", {
            requestId: id, executed: isMutation(method) ? "unknown" : false, retrySafe: !isMutation(method),
          });
          if (isMutation(method)) {
            void this.quarantineWorker(child, error, id);
            return;
          }
          this.pending.delete(id);
          clear();
          reject(error);
        };
        if (isMutation(method)) graceTimer = setTimeout(fail, 4_000);
        else fail();
      };
      const onAbort = (): void => cancel("REQUEST_CANCELLED");
      const timer = setTimeout(() => cancel("REQUEST_TIMEOUT"), Math.max(250, timeoutMs));
      this.pending.set(id, { child, method, resolve: (value) => resolveResult(value as T), reject, clear });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        this.pending.delete(id); clear();
        reject(new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 请求在 IPC 发送前已取消", { executed: false }));
        return;
      }
      child.send({ ...request, id }, (error) => {
        if (!error || !this.pending.has(id)) return;
        void this.quarantineWorker(child, new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI IPC 发送失败：" + error.message, {
          requestId: id, executed: isMutation(method) ? "unknown" : false, retrySafe: !isMutation(method),
        }), id);
      });
    });
  }

  async probe(signal?: AbortSignal): Promise<AtSpiProbeResult> {
    return await this.rpc({ method: "probe" }, signal);
  }

  async inspectWindow(window: WindowInfo, options?: AtSpiInspectOptions, signal?: AbortSignal): Promise<AtSpiInspection> {
    return await this.rpc({ method: "inspectWindow", window, options }, signal, Math.max(15_000, (options?.timeoutMs ?? 8_000) + 8_000));
  }

  async readControl(window: WindowInfo, runtimeId: string, signal?: AbortSignal): Promise<AtSpiControlInfo> {
    return await this.rpc({ method: "readControl", window, runtimeId }, signal);
  }

  async invoke(window: WindowInfo, runtimeId: string, actionName?: string, signal?: AbortSignal): Promise<AtSpiSemanticResult> {
    return await this.rpc({ method: "invoke", window, runtimeId, actionName }, signal);
  }

  async setValue(window: WindowInfo, runtimeId: string, text: string, signal?: AbortSignal): Promise<AtSpiSemanticResult> {
    return await this.rpc({ method: "setValue", window, runtimeId, text }, signal);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return await this.shutdownPromise;
    if (this.stopped) return;
    this.stopping = true;
    const child = this.child;
    this.shutdownPromise = (async () => {
      try {
        if (child?.connected) child.send({ id: this.nextId++, method: "shutdown" }, () => {});
        if (child) await this.quarantineWorker(child, new ComputerUseError("REQUEST_CANCELLED", "AT-SPI worker 正在关闭"));
        else if (this.quarantineFence) await this.quarantineFence;
      } finally {
        this.stopped = true; this.stopping = false;
        this.child = undefined; this.handshakeValue = undefined;
      }
    })();
    return await this.shutdownPromise;
  }
}
