import { spawn, type ChildProcess } from "node:child_process";
import { get } from "node:http";
import { randomBytes } from "node:crypto";
import { currentNodePlatform } from "../platform/runtime";
import { createGadgetCommandRunner, terminateGadgetCommands } from "../platform/gadget-commands";
import { runGadgetHost, type GadgetHostOptions } from "./GadgetHost";
import { createGadgetState } from "./GadgetState";
import { installGadgetClient } from "./GadgetClient";
import type { GadgetJson } from "../../shared/gadget-backend";
import type { GadgetDescriptor, GadgetRuntimeDiagnostics, GadgetRuntimeState } from "../../shared/gadget-types";
import type { GadgetStorage } from "./GadgetStorage";
import type { GadgetRegistry } from "./GadgetRegistry";

interface RuntimeInstance {
  child: ChildProcess;
  state: GadgetRuntimeState;
  stderr: string;
  termination?: GadgetRuntimeDiagnostics;
  token: string;
  backend: boolean;
  commandPids: Set<number>;
}

function hostScript(options: GadgetHostOptions): string {
  return `(${runGadgetHost.toString()})(${JSON.stringify(options)}, ${createGadgetState.toString()}, ${createGadgetCommandRunner.toString()})` +
    '.catch(error => { console.error(error); process.exit(1); });';
}

export class GadgetRuntime {
  private readonly instances = new Map<string, RuntimeInstance>();
  // All public operations share one queue. Internal operations never re-enter it.
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly commandCleanup = new Map<string, { pids: Set<number>; flight?: Promise<void> }>();

  constructor(
    private readonly storage: GadgetStorage,
    private readonly registry: GadgetRegistry,
    private readonly onState?: (state: GadgetRuntimeState) => void,
  ) {}

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(id, current);
    const cleanup = (): void => {
      if (this.operations.get(id) === current) this.operations.delete(id);
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  start(descriptor: GadgetDescriptor): Promise<GadgetRuntimeState> {
    return this.enqueue(descriptor.id, () => this.startOne(descriptor));
  }

  private isAlive(instance: RuntimeInstance): boolean {
    return !!instance.child.pid && instance.child.exitCode === null &&
      instance.child.signalCode === null && !instance.child.killed;
  }

  private async startOne(descriptor: GadgetDescriptor): Promise<GadgetRuntimeState> {
    await this.cleanupCommands(descriptor.id);
    const existing = this.instances.get(descriptor.id);
    if (existing) {
      const checked = await this.healthOne(descriptor.id);
      if (checked.status === "running") return checked;
      await this.stopOne(descriptor.id, "restart");
    }
    const starting: GadgetRuntimeState = {
      gadgetId: descriptor.id, status: "starting",
      diagnostics: this.registry.runtime(descriptor.id).diagnostics,
    };
    this.setState(starting);
    let instance: RuntimeInstance | undefined;
    try {
      this.storage.materializeLegacyLocalHtmlRedirect(descriptor.id);
      const manifest = this.storage.readManifest(descriptor.id);
      const token = randomBytes(32).toString("hex");
      const options: GadgetHostOptions = {
        gadgetId: descriptor.id, manifest, dataPath: this.storage.paths(descriptor.id).dataPath, token,
        sdkSource: `(${installGadgetClient.toString()})(${JSON.stringify(token)});`, platform: currentNodePlatform,
      };
      // Deliver source over stdin: no token in argv, no extra packaged worker asset,
      // and no Windows command-line length limit for the embedded host.
      const environmentNames = new Set([
        "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
        "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
        ...(manifest.backend?.environment ?? []).map(name => name.toUpperCase()),
      ]);
      const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && environmentNames.has(name.toUpperCase())));
      const child = spawn(process.execPath, ["-"], {
        cwd: this.storage.paths(descriptor.id).sourcePath,
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,
      });
      const owned: RuntimeInstance = { child, state: starting, stderr: "", token, backend: Boolean(manifest.backend), commandPids: new Set() };
      instance = owned;
      this.instances.set(descriptor.id, owned);
      child.on("message", (message: unknown) => {
        if (!message || typeof message !== "object" || !("pid" in message) || typeof message.pid !== "number"
          || !Number.isSafeInteger(message.pid) || message.pid <= 1 || message.pid === process.pid || message.pid === child.pid || !("type" in message)) return;
        if (message.type === "command-started") owned.commandPids.add(message.pid);
        if (message.type === "command-exited") owned.commandPids.delete(message.pid);
      });
      child.stdin?.on("error", () => undefined);
      child.stderr?.on("data", (chunk) => { owned.stderr = `${owned.stderr}${String(chunk)}`.slice(-4000); });
      // close follows exit and drains stderr. Retain diagnostics even for code 0
      // when exit was not requested (a successful exit is not a healthy server).
      child.once("close", (code, signal) => {
        if (this.instances.get(descriptor.id) !== owned) return;
        this.instances.delete(descriptor.id);
        if (owned.commandPids.size) {
          this.commandCleanup.set(descriptor.id, { pids: new Set(owned.commandPids) });
          void this.cleanupCommands(descriptor.id).catch(error => console.warn("[GadgetRuntime] command cleanup failed", error));
        }
        const diagnostics: GadgetRuntimeDiagnostics = {
          ...owned.termination,
          reason: owned.termination?.reason ?? (owned.state.status === "starting" ? "startup_failure" : "unexpected_exit"),
          occurredAt: owned.termination?.occurredAt ?? Date.now(), exitedAt: Date.now(),
          exitCode: code, signal, stderr: owned.stderr, pid: child.pid,
          url: owned.state.url ?? owned.termination?.url,
        };
        const expected = diagnostics.reason === "explicit_stop" || diagnostics.reason === "restart";
        const state: GadgetRuntimeState = {
          gadgetId: descriptor.id, status: expected ? "stopped" : "error", diagnostics,
          ...(expected ? {} : { error: diagnostics.error ?? `Gadget 进程退出（code=${code}, signal=${signal ?? "none"}）` }),
        };
        owned.state = state;
        this.setState(state);
      });
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(() => finish(new Error("Gadget 启动超时")), 8_000);
        const finish = (error?: Error): void => {
          clearTimeout(timer);
          child.stdout?.off("data", onData);
          child.off("exit", onExit);
          error ? reject(error) : resolve();
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
          finish(new Error(owned.stderr.trim() || `Gadget 进程提前退出（code=${code}, signal=${signal ?? "none"}）`));
        const onData = (chunk: Buffer): void => {
          stdout = `${stdout}${String(chunk)}`.slice(-4000);
          const match = /MYBUDDY_GADGET_PORT:(\d+)\n/.exec(stdout);
          if (!match) return;
          const port = Number(match[1]);
          if (!this.isAlive(owned) || port < 1 || port > 65535) return finish(new Error("Gadget 启动状态无效"));
          owned.state = {
            gadgetId: descriptor.id, status: "running", url: `http://127.0.0.1:${port}/`,
            port, pid: child.pid, startedAt: Date.now(), diagnostics: starting.diagnostics,
          };
          finish();
        };
        child.stdout?.on("data", onData);
        child.once("exit", onExit);
        // Keep an error listener after startup too (kill/spawn errors must not
        // become uncaught main-process exceptions).
        child.on("error", (error) => {
          if (owned.state.status === "starting") finish(error);
          else if (this.instances.get(descriptor.id) === owned && !owned.termination) {
            this.fail(owned, "health_failure", error.message);
          }
        });
        child.stdin?.end(hostScript(options));
      });
      return await this.healthOne(descriptor.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (instance && this.instances.get(descriptor.id) === instance) {
        this.fail(instance, "startup_failure", message);
        await this.stopOne(descriptor.id, "restart");
        return this.registry.runtime(descriptor.id);
      }
      // A pre-spawn failure has no process exit evidence. Only the instance
      // created by this attempt can supply close diagnostics, never a previous
      // runtime's registry history inherited by the starting state.
      const closedDiagnostics = instance?.state.status === "error" &&
        instance.state.diagnostics?.reason === "startup_failure"
        ? instance.state.diagnostics : undefined;
      const state: GadgetRuntimeState = {
        gadgetId: descriptor.id, status: "error", error: message,
        diagnostics: { ...closedDiagnostics,
          reason: "startup_failure", occurredAt: closedDiagnostics?.occurredAt ?? Date.now(), error: message },
      };
      this.setState(state);
      return state;
    }
  }

  private fail(instance: RuntimeInstance, reason: "health_failure" | "startup_failure", error: string): GadgetRuntimeState {
    instance.termination = {
      reason, occurredAt: Date.now(), error, pid: instance.child.pid,
      url: instance.state.url, stderr: instance.stderr,
    };
    const state: GadgetRuntimeState = {
      gadgetId: instance.state.gadgetId, status: "error", error, diagnostics: instance.termination,
    };
    instance.state = state;
    this.setState(state);
    return state;
  }

  health(id: string): Promise<GadgetRuntimeState> {
    return this.enqueue(id, () => this.healthOne(id));
  }

  private async healthOne(id: string): Promise<GadgetRuntimeState> {
    const instance = this.instances.get(id);
    if (!instance) {
      const current = this.registry.runtime(id);
      if (current.status !== "running" && current.status !== "starting") return current;
      const error = "Gadget 没有关联的运行进程";
      const failed: GadgetRuntimeState = {
        gadgetId: id, status: "error", error,
        diagnostics: { reason: "health_failure", occurredAt: Date.now(),
          pid: current.pid, url: current.url, error },
      };
      this.setState(failed);
      return failed;
    }
    if (instance.state.status !== "running") return { ...instance.state };
    const url = instance.state.url;
    if (!this.isAlive(instance) || !url) return this.fail(instance, "health_failure", "Gadget 进程已停止");
    const ok = await new Promise<boolean>((resolve) => {
      // Absolute deadline also covers a peer that trickles data indefinitely.
      const timer = setTimeout(() => { request.destroy(); resolve(false); }, 1_500);
      const finish = (ok: boolean): void => { clearTimeout(timer); resolve(ok); };
      const request = get(`${url}__mybuddy_health`, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
          if (body.length > 1024) { request.destroy(); finish(false); }
        });
        response.once("error", () => finish(false));
        response.once("end", () => {
          try { finish(response.statusCode === 200 && JSON.parse(body).ok === true); }
          catch { finish(false); }
        });
      });
      request.once("error", () => finish(false));
    });
    // Exit events may have run while HTTP was pending. Never revive that child.
    if (this.instances.get(id) !== instance) return this.registry.runtime(id);
    if (ok && this.isAlive(instance) && instance.state.status === "running") {
      this.setState(instance.state);
      return { ...instance.state };
    }
    return this.fail(instance, "health_failure", "Gadget health check 失败");
  }

  stop(id: string): Promise<GadgetRuntimeState> {
    return this.enqueue(id, () => this.stopOne(id, "explicit_stop"));
  }

  private async stopOne(id: string, reason: "explicit_stop" | "restart"): Promise<GadgetRuntimeState> {
    const instance = this.instances.get(id);
    if (!instance) {
      await this.cleanupCommands(id);
      const stopped: GadgetRuntimeState = { gadgetId: id, status: "stopped", diagnostics: this.registry.runtime(id).diagnostics };
      this.setState(stopped);
      return stopped;
    }
    // Preserve an already recorded failure while reaping its child.
    instance.termination ??= {
      reason, occurredAt: Date.now(), pid: instance.child.pid, url: instance.state.url,
    };
    await new Promise<void>((resolve, reject) => {
      const child = instance.child;
      const finish = (): void => { clearTimeout(force); clearTimeout(deadline); resolve(); };
      child.once("close", finish);
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      const deadline = setTimeout(() => {
        child.off("close", finish);
        reject(new Error("Gadget 进程停止超时；未启动替代进程"));
      }, 4_000);
      if (child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send({ type: "shutdown" }, (error) => { if (error) child.kill("SIGTERM"); });
        else child.kill("SIGTERM");
      }
    });
    await this.cleanupCommands(id);
    return this.registry.runtime(id);
  }

  restart(descriptor: GadgetDescriptor): Promise<GadgetRuntimeState> {
    return this.enqueue(descriptor.id, async () => {
      await this.stopOne(descriptor.id, "restart");
      return this.startOne(descriptor);
    });
  }

  sourceChanged(descriptor: GadgetDescriptor): void {
    const current = this.instances.get(descriptor.id);
    if (!current || (!current.backend && !this.storage.readManifest(descriptor.id).backend)) return;
    // Static edits retain their URL. Executable edits get a fresh process/module
    // cache and revoke outstanding calls, while the independent data/ stays put.
    this.configurationChanged(descriptor);
  }

  configurationChanged(descriptor: GadgetDescriptor): void {
    const current = this.instances.get(descriptor.id);
    if (!current) return;
    void this.enqueue(descriptor.id, async () => {
      // A preceding explicit stop wins over this automatic source activation.
      if (this.instances.get(descriptor.id) !== current) return;
      await this.stopOne(descriptor.id, "restart");
      await this.startOne(descriptor);
    }).catch(error => {
      console.warn("[GadgetRuntime] configuration activation failed", error);
    });
  }

  async request(descriptor: GadgetDescriptor, route: string, input?: unknown, options: {
    signal?: AbortSignal;
    start?: boolean;
    authorize?: () => void;
  } = {}): Promise<GadgetJson> {
    const { signal } = options;
    options.authorize?.();
    signal?.throwIfAborted();
    const state = options.start === false ? this.registry.runtime(descriptor.id) : await this.start(descriptor);
    options.authorize?.();
    signal?.throwIfAborted();
    const instance = this.instances.get(descriptor.id);
    if (state.status !== "running" || !state.url || !instance) throw new Error(state.error || "Gadget 后台不可用");
    const response = await fetch(new URL(`__mybuddy/${route}`, state.url), {
      method: input === undefined ? "GET" : "POST",
      headers: { "x-mybuddy-gadget-token": instance.token, ...(input === undefined ? {} : { "content-type": "application/json" }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(125_000)]) : AbortSignal.timeout(125_000),
    });
    const result: unknown = await response.json();
    options.authorize?.();
    if (this.instances.get(descriptor.id) !== instance || !this.isAlive(instance)) throw new Error("Gadget 已重启或停止；本次操作不会自动重放");
    if (!result || typeof result !== "object") throw new Error("Gadget 返回无效结果");
    if (!response.ok) {
      const error = "error" in result ? result.error : null;
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
        throw Object.assign(new Error(error.message), { code: "code" in error ? error.code : "REQUEST_FAILED" });
      }
      throw new Error(`Gadget 请求失败 (${response.status})`);
    }
    if (!("value" in result)) throw new Error("Gadget 返回缺少结果");
    // Only JSON from the owned host reaches this boundary.
    return result.value as GadgetJson;
  }

  async dispose(id: string): Promise<void> { await this.stop(id); }

  async disposeAll(): Promise<void> {
    const ids = new Set([...this.instances.keys(), ...this.operations.keys(), ...this.commandCleanup.keys()]);
    await Promise.all([...ids].map((id) => this.stop(id)));
  }

  private async cleanupCommands(id: string): Promise<void> {
    const pending = this.commandCleanup.get(id);
    if (!pending) return;
    if (!pending.flight) {
      pending.flight = terminateGadgetCommands(pending.pids).then(() => {
        if (this.commandCleanup.get(id) === pending) this.commandCleanup.delete(id);
      }).finally(() => { pending.flight = undefined; });
    }
    await pending.flight;
  }

  private setState(state: GadgetRuntimeState): void {
    this.registry.setRuntime(state);
    if (state.diagnostics && state.status !== "starting" && state.status !== "running") {
      console.info("[GadgetRuntime]", JSON.stringify({ gadgetId: state.gadgetId, status: state.status, ...state.diagnostics }));
    }
    try { this.onState?.({ ...state }); } catch { /* state remains observable through registry */ }
  }
}
