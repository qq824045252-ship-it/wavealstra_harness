import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { WINDOWS_AUTOMATION_HOST_SCRIPT } from "./windowsAutomationHostScript";
import {
  WINDOWS_AUTOMATION_ERROR_CODES,
  WindowsAutomationError,
  type HostAction,
  type HostRequestMap,
  type WindowsAutomationResponse,
} from "./windowsAutomationProtocol";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const POWERSHELL_BOOTSTRAP = String.raw`$ErrorActionPreference='Stop';$b=[Convert]::FromBase64String($env:MYBUDDY_AUTOMATION_HOST_GZIP);$env:MYBUDDY_AUTOMATION_HOST_GZIP=$null;$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GZipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8);$s=$r.ReadToEnd();$r.Dispose();Invoke-Expression $s`;

export class WindowsAutomationHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private serial: Promise<unknown> = Promise.resolve();
  private disposing = false;
  private generation = 0;

  get pid(): number | undefined {
    return this.child?.exitCode == null ? this.child?.pid : undefined;
  }

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode == null && !this.child.killed);
  }

  async request<TAction extends HostAction, TResult = unknown>(
    action: TAction,
    params: HostRequestMap[TAction],
    timeoutMs = action === "wait_for_window" ? 35_000 : 15_000,
    signal?: AbortSignal,
  ): Promise<TResult> {
    if (this.disposing && action !== "shutdown") {
      throw new WindowsAutomationError("HOST_UNAVAILABLE", "Windows automation host is shutting down");
    }
    const run = () => this.requestNow<TAction, TResult>(action, params, timeoutMs, signal);
    const result = this.serial.then(run, run);
    this.serial = result.catch(() => undefined);
    return result;
  }

  private ensureHost(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode == null && !this.child.killed) return this.child;
    if (process.platform !== "win32") {
      throw new WindowsAutomationError("HOST_UNAVAILABLE", "Windows automation is only available on Windows");
    }
    const compressed = gzipSync(Buffer.from(WINDOWS_AUTOMATION_HOST_SCRIPT, "utf8")).toString("base64");
    const generation = ++this.generation;
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_BOOTSTRAP],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MYBUDDY_AUTOMATION_HOST_GZIP: compressed },
      },
    );
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) console.error(`[WindowsAutomationHost] ${message.slice(0, 2_000)}`);
    });
    child.once("error", (error) => this.handleExit(generation, error));
    child.once("exit", (code, signal) => {
      this.handleExit(generation, new WindowsAutomationError(
        "HOST_UNAVAILABLE",
        `Windows automation host exited (code=${String(code)}, signal=${String(signal)})`,
      ));
    });
    console.info(`[WindowsAutomationHost] started pid=${String(child.pid)}`);
    return child;
  }

  private requestNow<TAction extends HostAction, TResult>(
    action: TAction,
    params: HostRequestMap[TAction],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TResult> {
    if (signal?.aborted) {
      return Promise.reject(new WindowsAutomationError("REQUEST_CANCELLED", "Windows automation request was cancelled"));
    }
    const child = this.ensureHost();
    const id = randomUUID();
    return new Promise<TResult>((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new WindowsAutomationError("REQUEST_CANCELLED", "Windows automation request was cancelled"));
        this.terminateHost();
      };
      const cleanupAbort = () => signal?.removeEventListener("abort", abort);
      const timer = setTimeout(() => {
        cleanupAbort();
        this.pending.delete(id);
        reject(new WindowsAutomationError("REQUEST_TIMEOUT", `Windows automation request timed out: ${action}`, { timeoutMs }));
        this.terminateHost();
      }, Math.max(100, timeoutMs));
      const wrappedResolve = (value: unknown) => { cleanupAbort(); (resolve as (value: unknown) => void)(value); };
      const wrappedReject = (error: Error) => { cleanupAbort(); reject(error); };
      this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, timer });
      signal?.addEventListener("abort", abort, { once: true });
      const body = JSON.stringify({ id, action, params });
      child.stdin.write(`${body}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new WindowsAutomationError("HOST_UNAVAILABLE", "Failed to write to Windows automation host", { cause: error.message }));
        this.terminateHost();
      });
    });
  }

  private handleLine(line: string): void {
    let response: WindowsAutomationResponse;
    try {
      response = JSON.parse(line) as WindowsAutomationResponse;
    } catch {
      const error = new WindowsAutomationError("HOST_PROTOCOL_ERROR", "Windows automation host emitted invalid JSON", { line: line.slice(0, 500) });
      this.rejectAll(error);
      this.terminateHost();
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }
    const code = response.error?.code;
    const normalizedCode = WINDOWS_AUTOMATION_ERROR_CODES.includes(code as never) ? code! : "HOST_PROTOCOL_ERROR";
    pending.reject(new WindowsAutomationError(normalizedCode, response.error?.message ?? "Windows automation request failed", response.error?.details));
  }

  private handleExit(generation: number, error: Error): void {
    if (generation !== this.generation) return;
    this.lines?.close();
    this.lines = null;
    this.child = null;
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private terminateHost(): void {
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    if (child && child.exitCode == null && !child.killed) child.kill();
  }

  async shutdown(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const child = this.child;
    if (!child || child.exitCode != null || child.killed) {
      this.terminateHost();
      return;
    }
    try {
      await this.requestNow("shutdown", {}, 1_000);
    } catch {
      // Best effort; process termination below guarantees no orphan.
    } finally {
      this.terminateHost();
    }
  }

  /** Test-only crash hook used by the controlled smoke harness. */
  simulateCrashForTest(): void {
    this.terminateHost();
  }
}

export const windowsAutomationHost = new WindowsAutomationHost();
