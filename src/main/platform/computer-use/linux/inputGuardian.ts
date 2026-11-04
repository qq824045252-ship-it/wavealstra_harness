import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ComputerUseError, type AutomationErrorCode } from "../protocol";

export const INPUT_GUARDIAN_PROTOCOL = 1 as const;
export interface InputGuardianHandshake {
  protocol: typeof INPUT_GUARDIAN_PROTOCOL;
  backend: "linux-atspi-input-guardian";
  nodeVersion: string;
  pid: number;
  ready: true;
}
export interface InputGuardianResult {
  executed: boolean | "unknown";
  completedKeys: number[];
  completedButtons: number[];
  unknownKeys: number[];
  unknownButtons: number[];
  heldKeys: number[];
  heldButtons: number[];
}
export interface InputGuardianApi {
  setHeld(keys: readonly number[], buttons: readonly number[], pressed: boolean, signal?: AbortSignal): Promise<InputGuardianResult>;
  scroll(horizontalNotches: number, verticalNotches: number, signal?: AbortSignal): Promise<InputGuardianResult>;
  probe(signal?: AbortSignal): Promise<void>;
  shutdown(): Promise<void>;
}
export type InputGuardianCommand =
  | { type: "held"; keys: readonly number[]; buttons: readonly number[]; pressed: boolean }
  | { type: "scroll"; horizontalNotches: number; verticalNotches: number }
  | { type: "probe" }
  | { type: "flush" };
export type InputGuardianRequest =
  | (InputGuardianCommand & { id: number })
  | { type: "cancel"; id: number; requestId: number };
export type InputGuardianReply =
  | { type: "ready"; handshake: InputGuardianHandshake }
  | { type: "result"; id: number; result: InputGuardianResult }
  | { type: "error"; id: number; error: { code: string; message: string; details?: unknown } };

export type GuardianRunner = (args: readonly string[], signal?: AbortSignal) => Promise<void>;

function details(error: unknown): Record<string, unknown> {
  return error instanceof ComputerUseError && error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "输入命令在发送前已取消", { executed: false });
}
function emptyResult(): InputGuardianResult {
  return { executed: false, completedKeys: [], completedButtons: [], unknownKeys: [], unknownButtons: [], heldKeys: [], heldButtons: [] };
}
function validCodes(values: unknown, maximum: number, limit: number): values is number[] {
  return Array.isArray(values) && values.length <= limit && values.every(value => Number.isSafeInteger(value) && value >= 0 && value <= maximum);
}
function validateCommand(command: InputGuardianCommand): void {
  if (command.type === "held") {
    if (!validCodes(command.keys, 767, 64) || !validCodes(command.buttons, 2, 3) || typeof command.pressed !== "boolean") {
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", "输入守护进程收到无效 key/button 状态", { executed: false });
    }
  } else if (command.type === "scroll") {
    if (![command.horizontalNotches, command.verticalNotches].every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1_000)) {
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", "滚轮增量必须是 -1000 到 1000 的整数", { executed: false });
    }
  } else if (command.type !== "probe" && command.type !== "flush") {
    throw new ComputerUseError("HOST_PROTOCOL_ERROR", "未知输入守护命令", { executed: false });
  }
}

/**
 * The promise settles only after the owned ydotool process CLOSE event.
 * execFile's abort callback alone is insufficient: it can reject before a
 * terminating emitter has stopped, allowing a cleanup UP to precede late DOWN.
 */
export function createGuardianRunner(options: {
  spawnCommand?: (args: readonly string[]) => ChildProcess;
  timeoutMs?: number;
  killGraceMs?: number;
} = {}): GuardianRunner {
  return async (args, signal) => {
    checkAbort(signal);
    let child: ChildProcess;
    try {
      child = options.spawnCommand ? options.spawnCommand(args) : spawn("ydotool", [...args], {
        stdio: ["ignore", "ignore", "pipe"], shell: false, windowsHide: true,
      });
    } catch (error) {
      throw new ComputerUseError("HOST_UNAVAILABLE", "无法启动 ydotool：" + message(error), { executed: false, args });
    }
    await new Promise<void>((resolveCommand, reject) => {
      let spawned = false;
      let cause: unknown;
      let timedOut = false;
      let abortRequested = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let stderr = "";
      const stopEmitter = (): void => {
        if (abortRequested) return;
        abortRequested = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => { child.kill("SIGKILL"); }, Math.max(10, options.killGraceMs ?? 500));
      };
      const onAbort = (): void => { cause = new Error("取消中的输入进程"); stopEmitter(); };
      const timeout = setTimeout(() => {
        timedOut = true;
        cause = new Error("ydotool 命令超时");
        stopEmitter();
      }, Math.max(50, options.timeoutMs ?? 2_000));
      child.stderr?.on("data", (chunk: string | Buffer) => { stderr = (stderr + String(chunk)).slice(-4_096); });
      child.once("spawn", () => { spawned = true; });
      child.once("error", (error) => { cause = error; });
      child.once("close", (code, processSignal) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        if (!cause && code === 0 && !signal?.aborted) { resolveCommand(); return; }
        const errorCode = signal?.aborted ? "REQUEST_CANCELLED" : timedOut ? "REQUEST_TIMEOUT" : "HOST_UNAVAILABLE";
        reject(new ComputerUseError(errorCode, "ydotool 已终止，发送结果" + (spawned ? "可能部分发生" : "未发生") + "：" + (cause ? message(cause) : stderr || "exit=" + String(code) + ", signal=" + String(processSignal)), {
          executed: spawned ? "unknown" : false, args, emitterPid: child.pid, emitterStopped: true,
        }));
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
}

/**
 * One queue owns both the input ledger and every real ydotool invocation.
 * A successful DOWN remains held across requests. Only UP, failure/cancel
 * cleanup, explicit flush, or parent disconnect releases our recorded inputs.
 */
export class InputGuardianEngine {
  private readonly keys = new Set<number>();
  private readonly buttons = new Set<number>();
  private readonly requests = new Map<number, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<InputGuardianResult>;
  private recoveryRequired = false;

  constructor(private readonly runner: GuardianRunner = createGuardianRunner()) {}

  snapshot(): Pick<InputGuardianResult, "heldKeys" | "heldButtons"> {
    return { heldKeys: [...this.keys], heldButtons: [...this.buttons] };
  }

  cancel(requestId: number): void { this.requests.get(requestId)?.abort(); }

  execute(id: number, command: InputGuardianCommand): Promise<InputGuardianResult> {
    validateCommand(command);
    if (!Number.isSafeInteger(id) || id <= 0 || this.requests.has(id)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "输入请求 ID 无效或重复", { executed: false });
    if (this.closing || this.requests.size >= 128) return Promise.reject(new ComputerUseError("HOST_UNAVAILABLE", "输入守护队列关闭或已满", { executed: false }));
    const controller = new AbortController();
    this.requests.set(id, controller);
    const operation = this.queue.catch(() => {}).then(async () => {
      // Cancellation is checked before entering the command; queued work
      // never registers a DOWN and can never reach the desktop after STOP.
      checkAbort(controller.signal);
      if (this.closing) throw new ComputerUseError("REQUEST_CANCELLED", "父进程已断开，排队输入未发送", { executed: false });
      const progress = emptyResult();
      let inputStarted = false;
      try {
        if (command.type === "probe") {
          await this.runner(["debug"], controller.signal);
          return { ...progress, ...this.snapshot() };
        }
        if (command.type === "flush") return await this.flush();
        // A failed UP leaves real state uncertain. Recover that exact ledger
        // before admitting a new DOWN or wheel command into the same queue.
        if (this.recoveryRequired) {
          await this.flush();
          checkAbort(controller.signal);
        }
        if (command.type === "held" && command.pressed && new Set([...this.keys, ...command.keys]).size > 64) {
          throw new ComputerUseError("HOST_PROTOCOL_ERROR", "驱动持有的按键数量超过安全上限", { executed: false });
        }
        if (command.type === "scroll") {
          if (command.horizontalNotches || command.verticalNotches) {
            inputStarted = true;
            await this.runner(["mousemove", "--wheel", "-x", String(command.horizontalNotches), "-y", String(command.verticalNotches)], controller.signal);
            progress.executed = true;
          }
        } else {
          const keys = [...new Set(command.keys)];
          const buttons = [...new Set(command.buttons)];
          // Release in reverse press order; all commands are bounded and
          // awaited individually so a partial chord has explicit evidence.
          for (const code of command.pressed ? keys : keys.reverse()) {
            checkAbort(controller.signal);
            if (command.pressed && this.keys.has(code)) continue;
            // An UP requested by a recovering parent may refer to a DOWN
            // executed by the previous guardian. Preserve it until UP exits.
            this.keys.add(code);
            inputStarted = true;
            try { await this.runner(["key", String(code) + ":" + (command.pressed ? "1" : "0")], controller.signal); }
            catch (error) {
              if (details(error).executed !== false) progress.unknownKeys.push(code);
              else if (command.pressed) this.keys.delete(code);
              throw error;
            }
            if (!command.pressed) this.keys.delete(code);
            progress.completedKeys.push(code);
            progress.executed = true;
          }
          for (const button of command.pressed ? buttons : buttons.reverse()) {
            checkAbort(controller.signal);
            if (command.pressed && this.buttons.has(button)) continue;
            this.buttons.add(button);
            inputStarted = true;
            const mask = (command.pressed ? 0x40 : 0x80) | button;
            try { await this.runner(["click", "0x" + mask.toString(16)], controller.signal); }
            catch (error) {
              if (details(error).executed !== false) progress.unknownButtons.push(button);
              else if (command.pressed) this.buttons.delete(button);
              throw error;
            }
            if (!command.pressed) this.buttons.delete(button);
            progress.completedButtons.push(button);
            progress.executed = true;
          }
        }
        checkAbort(controller.signal);
        return { ...progress, ...this.snapshot() };
      } catch (error) {
        if (command.type !== "probe" && progress.executed !== true && details(error).executed !== false) progress.executed = "unknown";
        let cleanup: InputGuardianResult | undefined;
        let cleanupError: string | undefined;
        // Probes do not change held state. Failed input operations are an
        // explicit recovery boundary; the emitter is closed before UP runs.
        if (command.type !== "probe" && command.type !== "flush" && inputStarted) {
          try { cleanup = await this.flush(); } catch (failure) { cleanupError = message(failure); }
        }
        throw new ComputerUseError(error instanceof ComputerUseError ? error.code : "HOST_UNAVAILABLE", message(error), {
          ...details(error), ...progress, ...this.snapshot(), cleanup, cleanupError, retrySafe: false,
        });
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation.finally(() => { this.requests.delete(id); });
  }

  private async flush(): Promise<InputGuardianResult> {
    const result = emptyResult();
    let lastError: unknown;
    // UP-only retry is idempotent and never repeats a click, submit or text.
    for (let attempt = 0; attempt < 3 && (this.keys.size || this.buttons.size); attempt += 1) {
      if (this.keys.size) {
        const keys = [...this.keys].reverse();
        try {
          await this.runner(["key", ...keys.map(code => String(code) + ":0")]);
          keys.forEach(code => this.keys.delete(code));
          result.completedKeys.push(...keys);
          result.executed = true;
        } catch (error) { lastError = error; result.unknownKeys = [...this.keys]; }
      }
      for (const button of [...this.buttons].reverse()) {
        try {
          await this.runner(["click", "0x" + (0x80 | button).toString(16)]);
          this.buttons.delete(button);
          result.completedButtons.push(button);
          result.executed = true;
        } catch (error) { lastError = error; result.unknownButtons = [...this.buttons]; }
      }
    }
    if (this.keys.size || this.buttons.size) {
      this.recoveryRequired = true;
      throw new ComputerUseError("HOST_UNAVAILABLE", "未能释放驱动自身持有的输入：" + message(lastError), { ...result, ...this.snapshot(), cleanupFailed: true, retrySafe: true });
    }
    this.recoveryRequired = false;
    return { ...result, unknownKeys: [], unknownButtons: [], ...this.snapshot() };
  }

  close(): Promise<InputGuardianResult> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const controller of this.requests.values()) controller.abort();
    // Await the active command's actual process close and cancel every queued
    // operation before releasing the ledger. No orphan DOWN can follow UP.
    this.closePromise = this.queue.catch(() => {}).then(() => this.flush());
    return this.closePromise;
  }
}

export function resolveInputGuardianPath(explicit?: string): string | undefined {
  if (explicit !== undefined) return existsSync(explicit) ? explicit : undefined;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return [
    ...(resources ? [join(resources, "app.asar.unpacked", "out", "main", "input-guardian.cjs")] : []),
    join(__dirname, "input-guardian.cjs"), resolve(__dirname, "..", "main", "input-guardian.cjs"),
  ].find(candidate => existsSync(candidate));
}

export function validateInputGuardianHandshake(value: unknown): InputGuardianHandshake {
  const candidate = value as Partial<InputGuardianHandshake> | null;
  const version = typeof candidate?.nodeVersion === "string" ? /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(candidate.nodeVersion) : null;
  if (!candidate || candidate.protocol !== INPUT_GUARDIAN_PROTOCOL || candidate.backend !== "linux-atspi-input-guardian" || candidate.ready !== true ||
    !version || !Number.isSafeInteger(Number(version[1])) || Number(version[1]) < 24 || !Number.isSafeInteger(candidate.pid) || Number(candidate.pid) <= 0) {
    throw new ComputerUseError("HOST_PROTOCOL_ERROR", "输入守护 worker 握手、运行时 Node>=24 或 PID 无效");
  }
  return candidate as InputGuardianHandshake;
}

/** Stop only this detached guardian's own emitters and confirm they cannot run. */
export async function quarantineGuardianGroup(pid: number, timeoutMs = 3_000): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "拒绝清理非拥有的输入进程组");
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await readdir("/proc");
    let active = false;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try { stat = await readFile("/proc/" + entry + "/stat", "utf8"); }
      catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) continue;
      const fields = stat.slice(closeParen + 2).split(" ");
      // /proc stat fields: state=3, ppid=4, pgrp=5, session=6.
      if (Number(fields[2]) === pid && Number(fields[3]) === pid && fields[0] !== "Z" && fields[0] !== "X") {
        active = true;
        break;
      }
    }
    if (!active) return;
    if (Date.now() >= deadline) throw new ComputerUseError("HOST_UNAVAILABLE", "旧输入守护进程组仍有运行中的事件发送器，禁止启动恢复或新输入", { guardianPid: pid, diagnosticCode: "INPUT_EMITTER_NOT_STOPPED" });
    await new Promise(resume => setTimeout(resume, 20));
  }
}

interface Pending {
  child: ChildProcess;
  command: InputGuardianCommand;
  resolve(result: InputGuardianResult): void;
  reject(error: unknown): void;
  clear(): void;
}

export class InputGuardian implements InputGuardianApi {
  private child?: ChildProcess;
  private handshakeValue?: InputGuardianHandshake;
  private starting?: Promise<void>;
  private quarantine?: Promise<void>;
  private recovering?: Promise<void>;
  private nextId = 1;
  private stopped = false;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private readonly intentionalDisconnect = new WeakSet<ChildProcess>();
  private readonly failures = new WeakMap<ChildProcess, (reason: string) => void>();
  private readonly pending = new Map<number, Pending>();
  private readonly heldKeys = new Set<number>();
  private readonly heldButtons = new Set<number>();
  private readonly lostKeys = new Set<number>();
  private readonly lostButtons = new Set<number>();

  constructor(private readonly options: {
    workerPath?: string;
    spawnWorker?: (path: string) => ChildProcess;
    quarantineWorker?: (pid: number) => Promise<void>;
    startupTimeoutMs?: number;
    requestTimeoutMs?: number;
    onUnexpectedExit?: (error: ComputerUseError) => void;
  } = {}) {}

  get pid(): number | undefined { return this.handshakeValue?.pid; }
  get handshake(): InputGuardianHandshake | undefined { return this.handshakeValue; }

  private acceptState(result: Pick<InputGuardianResult, "heldKeys" | "heldButtons">): void {
    this.heldKeys.clear(); this.heldButtons.clear();
    result.heldKeys.forEach(key => this.heldKeys.add(key));
    result.heldButtons.forEach(button => this.heldButtons.add(button));
  }

  private async ensure(): Promise<ChildProcess> {
    if (this.stopped) throw new ComputerUseError("HOST_UNAVAILABLE", "输入守护进程已关闭");
    if (this.quarantine) await this.quarantine;
    if (this.starting) await this.starting;
    if (!this.child?.connected || !this.handshakeValue) await this.start();
    const child = this.child!;
    if (this.lostKeys.size || this.lostButtons.size) {
      if (!this.recovering) {
        const recovery = this.rawRequest(child, { type: "held", keys: [...this.lostKeys], buttons: [...this.lostButtons], pressed: false }).then(() => {
          this.lostKeys.clear(); this.lostButtons.clear();
        });
        this.recovering = recovery;
        void recovery.finally(() => { if (this.recovering === recovery) this.recovering = undefined; }).catch(() => {});
      }
      await this.recovering;
    }
    if (this.child !== child || !child.connected) throw new ComputerUseError("HOST_UNAVAILABLE", "输入恢复期间 worker 退出，命令未发送", { executed: false });
    return child;
  }

  private async start(): Promise<void> {
    if (this.starting) return await this.starting;
    const workerPath = resolveInputGuardianPath(this.options.workerPath);
    if (!workerPath) throw new ComputerUseError("HOST_UNAVAILABLE", "输入守护 worker 未构建或未打包，拒绝注入输入", { diagnosticCode: "INPUT_GUARDIAN_MISSING" });
    const spawnWorker = this.options.spawnWorker ?? ((path: string) => fork(path, [], {
      execPath: process.execPath, execArgv: [], detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    }));
    const child = spawnWorker(workerPath);
    this.child = child;
    const starting = new Promise<void>((resolveStart, rejectStart) => {
      let started = false;
      let failed = false;
      const finish = (error?: Error): void => {
        if (started) return;
        started = true; clearTimeout(timer);
        if (error) rejectStart(error); else resolveStart();
      };
      const fail = (reason: string): void => {
        if (failed) return;
        failed = true;
        if (this.child === child) { this.child = undefined; this.handshakeValue = undefined; }
        const error = new ComputerUseError("HOST_UNAVAILABLE", "输入守护 worker 已退出：" + reason, { diagnosticCode: "INPUT_GUARDIAN_EXITED" });
        finish(error);
        if (!this.intentionalDisconnect.has(child)) {
          for (const key of this.heldKeys) this.lostKeys.add(key);
          for (const button of this.heldButtons) this.lostButtons.add(button);
          for (const request of this.pending.values()) if (request.child === child && request.command.type === "held" && request.command.pressed) {
            request.command.keys.forEach(key => this.lostKeys.add(key));
            request.command.buttons.forEach(button => this.lostButtons.add(button));
          }
          // Set the fence synchronously, before rejecting requests or notifying
          // the backend. Every recovery/new command must await this promise.
          const fence = (async () => { if (child.pid) await (this.options.quarantineWorker ?? quarantineGuardianGroup)(child.pid); })();
          this.quarantine = fence;
          void fence.catch(() => {});
        }
        for (const [id, request] of this.pending) {
          if (request.child !== child) continue;
          this.pending.delete(id); request.clear();
          request.reject(new ComputerUseError("HOST_UNAVAILABLE", error.message, { ...details(error), executed: request.command.type === "probe" ? false : "unknown", retrySafe: false }));
        }
        if (!this.intentionalDisconnect.has(child) && !this.stopped) this.options.onUnexpectedExit?.(error);
      };
      this.failures.set(child, fail);
      const timer = setTimeout(() => { finish(new ComputerUseError("REQUEST_TIMEOUT", "输入守护 worker 握手超时")); fail("handshake timeout"); }, this.options.startupTimeoutMs ?? 5_000);
      child.on("message", (raw: unknown) => {
        if (failed || this.child !== child) return;
        const reply = raw as InputGuardianReply | null;
        if (!reply || typeof reply !== "object") return;
        if (reply.type === "ready") {
          try { this.handshakeValue = validateInputGuardianHandshake(reply.handshake); finish(); }
          catch (error) { finish(error as Error); fail(message(error)); }
          return;
        }
        if (reply.type !== "result" && reply.type !== "error") return;
        const request = this.pending.get(reply.id);
        if (!request || request.child !== child) return;
        if (reply.type === "result") {
          if (!validCodes(reply.result?.heldKeys, 767, 64) || !validCodes(reply.result?.heldButtons, 2, 3)) {
            fail("invalid held state");
            return;
          }
          this.pending.delete(reply.id); request.clear();
          this.acceptState(reply.result);
          request.resolve(reply.result);
        } else {
          this.pending.delete(reply.id); request.clear();
          const state = reply.error.details as Partial<InputGuardianResult> | undefined;
          if (validCodes(state?.heldKeys, 767, 64) && validCodes(state?.heldButtons, 2, 3)) this.acceptState(state as InputGuardianResult);
          request.reject(new ComputerUseError(reply.error.code as AutomationErrorCode, reply.error.message, reply.error.details));
        }
      });
      child.once("error", error => fail(error.message));
      child.once("exit", (code, signal) => fail("code=" + String(code) + ", signal=" + String(signal)));
      child.once("disconnect", () => fail("IPC disconnected"));
      child.unref();
    });
    this.starting = starting;
    try { await starting; }
    finally { if (this.starting === starting) this.starting = undefined; }
  }

  private rawRequest(child: ChildProcess, command: InputGuardianCommand, signal?: AbortSignal): Promise<InputGuardianResult> {
    checkAbort(signal);
    if (!child.connected) return Promise.reject(new ComputerUseError("HOST_UNAVAILABLE", "输入守护 IPC 已断开", { executed: false }));
    const id = this.nextId++;
    return new Promise<InputGuardianResult>((resolveRequest, reject) => {
      let cancelRequested = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const clear = (): void => {
        clearTimeout(timer); if (grace) clearTimeout(grace);
        signal?.removeEventListener("abort", abort);
      };
      const cancel = (code: "REQUEST_TIMEOUT" | "REQUEST_CANCELLED"): void => {
        if (cancelRequested || !this.pending.has(id)) return;
        cancelRequested = true;
        clearTimeout(timer);
        child.send({ id: this.nextId++, type: "cancel", requestId: id }, () => {});
        // Real emitter close and UP recovery normally finish inside this grace.
        // If the guardian is unresponsive, disconnect invokes group fencing
        // before a replacement guardian can release the shadow ledger.
        grace = setTimeout(() => {
          if (!this.pending.has(id)) return;
          const pending = this.pending.get(id)!;
          this.pending.delete(id); clear();
          if (command.type === "held" && command.pressed) {
            command.keys.forEach(key => this.lostKeys.add(key));
            command.buttons.forEach(button => this.lostButtons.add(button));
          }
          this.failures.get(child)?.("request did not stop after cancellation");
          if (child.connected) child.disconnect();
          pending.reject(new ComputerUseError(code, "输入守护请求未在取消后停止，已隔离发送进程且不会重放", { executed: command.type === "probe" ? false : "unknown", retrySafe: false }));
        }, 8_000);
      };
      const abort = (): void => cancel("REQUEST_CANCELLED");
      const count = command.type === "held" ? command.keys.length + command.buttons.length : 1;
      const timer = setTimeout(() => cancel("REQUEST_TIMEOUT"), this.options.requestTimeoutMs ?? Math.min(120_000, 8_000 + count * 2_500));
      this.pending.set(id, { child, command, resolve: resolveRequest, reject, clear });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        this.pending.delete(id); clear();
        reject(new ComputerUseError("REQUEST_CANCELLED", "输入命令在 IPC 发送前已取消", { executed: false }));
        return;
      }
      child.send({ id, ...command }, error => {
        if (!error || !this.pending.has(id)) return;
        // A failed IPC write may be partially delivered. Fencing and shadow
        // recovery are safer than assuming no DOWN was read by the worker.
        this.failures.get(child)?.("IPC send failed: " + error.message);
        if (child.connected) child.disconnect();
      });
    });
  }

  private async request(command: InputGuardianCommand, signal?: AbortSignal): Promise<InputGuardianResult> {
    validateCommand(command);
    checkAbort(signal);
    if (this.shuttingDown) throw new ComputerUseError("HOST_UNAVAILABLE", "输入守护正在关闭，命令未发送", { executed: false });
    const child = await this.ensure();
    checkAbort(signal);
    if (this.shuttingDown) throw new ComputerUseError("HOST_UNAVAILABLE", "输入守护正在关闭，命令未发送", { executed: false });
    return await this.rawRequest(child, command, signal);
  }

  async setHeld(keys: readonly number[], buttons: readonly number[], pressed: boolean, signal?: AbortSignal): Promise<InputGuardianResult> {
    return await this.request({ type: "held", keys, buttons, pressed }, signal);
  }
  async scroll(horizontalNotches: number, verticalNotches: number, signal?: AbortSignal): Promise<InputGuardianResult> {
    return await this.request({ type: "scroll", horizontalNotches, verticalNotches }, signal);
  }
  async probe(signal?: AbortSignal): Promise<void> { await this.request({ type: "probe" }, signal); }
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return await this.shutdownPromise;
    if (this.stopped) return;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      try {
        // Cancel active/queued input before adding the final cleanup command.
        // The worker serializes cancellation, emitter CLOSE and ledger UP.
        for (const [requestId, request] of this.pending) if (request.child.connected) {
          request.child.send({ id: this.nextId++, type: "cancel", requestId }, () => {});
        }
        if (this.child || this.starting || this.lostKeys.size || this.lostButtons.size || this.heldKeys.size || this.heldButtons.size) {
          await this.rawRequest(await this.ensure(), { type: "flush" });
        }
      } finally {
        this.stopped = true;
        // Parent disconnect makes the detached child drain and clean up again.
        // Never SIGKILL a healthy child before it can send its final UP edges.
        if (this.child?.connected) {
          this.intentionalDisconnect.add(this.child);
          this.child.disconnect();
        }
      }
    })();
    return await this.shutdownPromise;
  }
}
