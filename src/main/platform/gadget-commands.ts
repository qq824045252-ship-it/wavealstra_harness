export type GadgetCommandOptions = {
  args?: string[];
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
};

export type GadgetCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
};

export type GadgetCommandRunner = {
  run(command: string, options?: GadgetCommandOptions): Promise<GadgetCommandResult>;
  dispose(): Promise<void>;
};

/** Reap only command roots recorded by the host's parent before an unexpected host exit. */
export async function terminateGadgetCommands(
  pids: Iterable<number>,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const { execFile } = require("node:child_process") as typeof import("node:child_process");
  const path = require("node:path") as typeof import("node:path");
  const roots = [...new Set(pids)];
  for (const pid of roots) {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid owned Gadget command PID");
  }
  const exists = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  };
  const results = await Promise.allSettled(roots.map(async (pid) => {
    if (!exists(pid)) return;
    if (platform === "win32") {
      const executable = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, "System32", "taskkill.exe")
        : "taskkill.exe";
      await new Promise<void>((resolve, reject) => {
        execFile(executable, ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true, timeout: 2_000,
        }, (error) => {
          if (!error) { resolve(); return; }
          try { if (!exists(pid)) { resolve(); return; } }
          catch (probeError) { reject(probeError); return; }
          reject(error);
        });
      });
    } else {
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    const deadline = Date.now() + 2_000;
    while (exists(pid)) {
      if (Date.now() >= deadline) throw new Error(`Gadget command ${pid} did not exit after termination`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }));
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Unable to clean up owned Gadget commands");
}

/** Self-contained: serialized into the Gadget host, with no runtime closure dependencies. */
export function createGadgetCommandRunner(config: {
  platform: NodeJS.Platform;
  cwd: string;
  allowedCommands: string[];
  environment: Record<string, string>;
  nodeExecutable: string;
  onSpawn?(pid: number): void;
  onExit?(pid: number): void;
}): GadgetCommandRunner {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const windows = config.platform === "win32";
  const allowed = new Set(config.allowedCommands);
  const environment = { ...config.environment };
  const active = new Set<{ cancel: () => void; done: Promise<void>; cleanup: () => Promise<void> }>();
  let closed = false;
  let disposal: Promise<void> | undefined;
  const failure = (code: string, message: string): Error & { code: string } =>
    Object.assign(new Error(message), { code });
  type ResolvedCommand = { executable: string; prefixArgs: string[]; node: boolean };
  const resolveNpmShim = (shim: string): ResolvedCommand => {
    const unsupported = (): never => {
      throw failure("UNSUPPORTED_COMMAND_SHIM", "Only standard npm Node shims are supported; use a real executable or node with the CLI JavaScript entry.");
    };
    if (fs.statSync(shim).size > 16 * 1024) return unsupported();
    const text = fs.readFileSync(shim, "utf8").replace(/^\uFEFF/, "").trim();
    // Match the whole npm cmd-shim template, rather than searching arbitrary shell
    // code for a Node-looking final command. No part of the shim is executed.
    const template = /^@ECHO off\s+GOTO start\s+:find_dp0\s+SET dp0=%~dp0\s+EXIT \/b\s+:start\s+SETLOCAL\s+CALL :find_dp0\s+IF EXIST "%dp0%\\node\.exe"\s*\(\s*SET "_prog=%dp0%\\node\.exe"\s*\) ELSE \(\s*SET "_prog=node"\s*\)\s+endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & set PATHEXT=%PATHEXT:;\.JS;=;% & "%_prog%"\s+"%dp0%\\(node_modules\\[^"\r\n]+\.(?:js|cjs|mjs))" %\*$/i;
    const relativeEntry = template.exec(text)?.[1];
    if (!relativeEntry || /[%\x00-\x1f]/.test(relativeEntry)) return unsupported();
    try {
      const shimDirectory = fs.realpathSync(path.dirname(shim));
      const modules = fs.realpathSync(path.join(shimDirectory, "node_modules"));
      const entry = fs.realpathSync(path.resolve(shimDirectory, relativeEntry));
      const relativeToModules = path.relative(modules, entry);
      const relativeToShim = path.relative(shimDirectory, entry);
      if (!relativeToModules || path.isAbsolute(relativeToModules) || relativeToModules === ".." || relativeToModules.startsWith(".." + path.sep)
        || path.isAbsolute(relativeToShim) || relativeToShim === ".." || relativeToShim.startsWith(".." + path.sep)
        || !/\.(js|cjs|mjs)$/i.test(entry) || !fs.statSync(entry).isFile()) return unsupported();
      return { executable: config.nodeExecutable, prefixArgs: [entry], node: true };
    } catch { return unsupported(); }
  };
  const resolveCommand = (command: string): ResolvedCommand => {
    if (!allowed.has(command)) throw failure("COMMAND_DENIED", `Gadget command is not declared: ${command}`);
    if (command === "node") return { executable: config.nodeExecutable, prefixArgs: [], node: true };
    if (!command || command.includes("\0")) throw failure("INVALID_COMMAND", "Invalid command");
    const hasPath = /[\\/]/.test(command) || path.isAbsolute(command);
    const pathValue = Object.entries(environment).find(([key]) => windows ? key.toLowerCase() === "path" : key === "PATH")?.[1] ?? "";
    const bases = hasPath ? [path.resolve(config.cwd, command)] : pathValue.split(windows ? ";" : ":").filter(Boolean).map((dir) => path.resolve(config.cwd, dir, command));
    const candidates = bases.flatMap((base) => windows && !path.extname(base) ? [base + ".exe", base + ".com", base + ".cmd", base + ".bat"] : [base]);
    for (const candidate of candidates) {
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (windows && /\.(cmd|bat)$/i.test(candidate)) {
          return resolveNpmShim(candidate);
        }
        fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return { executable: candidate, prefixArgs: [], node: false };
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "UNSUPPORTED_COMMAND_SHIM") throw error;
      }
    }
    throw failure("COMMAND_NOT_FOUND", `Gadget command was not found: ${command}`);
  };

  return {
    async run(command, options = {}) {
      if (closed) throw failure("RUNNER_CLOSED", "Gadget command runner is closed");
      if (active.size >= 4) throw failure("COMMAND_LIMIT", "At most four Gadget commands may run concurrently");
      if (options.signal?.aborted) throw failure("COMMAND_ABORTED", "Gadget command was cancelled");
      const timeoutMs = options.timeoutMs ?? 30_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw failure("INVALID_TIMEOUT", "Command timeout must be between 1 and 300000 milliseconds");
      const resolved = resolveCommand(command);
      const env = { ...environment, ...options.env };
      if (resolved.node) env.ELECTRON_RUN_AS_NODE = "1";
      const child = spawn(resolved.executable, [...resolved.prefixArgs, ...(options.args ?? [])], {
        cwd: config.cwd, env, shell: false, windowsHide: true,
        detached: !windows, stdio: ["pipe", "pipe", "pipe"],
      });
      if (child.pid) {
        try { config.onSpawn?.(child.pid); } catch { /* Observers cannot abandon an owned child. */ }
      }
      child.once("exit", () => {
        if (child.pid) {
          try { config.onExit?.(child.pid); } catch { /* Cleanup remains owned by this runner. */ }
        }
      });
      let resolveDone: () => void = () => undefined;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      let pendingError: Error | undefined;
      let termination: Promise<void> | undefined;
      let cleanupFailed = false;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const terminate = (): Promise<void> => {
        if (termination) return termination;
        termination = new Promise<void>((resolve, reject) => {
          if (!child.pid) { resolve(); return; }
          if (!windows) {
            try { process.kill(-child.pid, "SIGKILL"); resolve(); }
            catch (error) {
              if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") resolve();
              else reject(failure("COMMAND_CLEANUP_FAILED", "Unable to terminate Gadget process group"));
            }
            return;
          }
          if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
          const systemRoot = Object.entries(environment).find(([key]) => key.toLowerCase() === "systemroot")?.[1];
          const taskkill = systemRoot ? path.join(systemRoot, "System32", "taskkill.exe") : "taskkill.exe";
          const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], { env: environment, shell: false, windowsHide: true, stdio: "ignore" });
          killer.once("error", () => reject(failure("COMMAND_CLEANUP_FAILED", "Unable to launch taskkill for Gadget command")));
          killer.once("close", (code) => {
            if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
            else reject(failure("COMMAND_CLEANUP_FAILED", `taskkill failed with exit code ${code}`));
          });
        });
        termination = termination.catch((error: unknown) => {
          cleanupFailed = true;
          termination = undefined;
          throw error;
        });
        return termination;
      };
      const stop = (error: Error): void => {
        pendingError ??= error;
        void terminate().catch((cleanupError: unknown) => {
          pendingError = cleanupError instanceof Error ? cleanupError : failure("COMMAND_CLEANUP_FAILED", "Command cleanup failed");
          child.kill("SIGKILL");
        });
      };
      const owned = { cancel: () => stop(failure("COMMAND_ABORTED", "Gadget command runner was disposed")), done, cleanup: terminate };
      active.add(owned);
      const abort = (): void => stop(failure("COMMAND_ABORTED", "Gadget command was cancelled"));
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => stop(failure("COMMAND_TIMEOUT", "Gadget command exceeded its deadline")), timeoutMs);
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > 1024 * 1024) { stop(failure("COMMAND_OUTPUT_LIMIT", "Gadget command output exceeds 1 MiB")); return; }
        chunks.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") stop(failure("COMMAND_STDIN_FAILED", error.message));
      });
      if (options.signal?.aborted) abort();
      child.stdin.end(options.stdin);
      try {
        return await new Promise<GadgetCommandResult>((resolve, reject) => {
          child.once("error", (error) => { pendingError ??= failure("COMMAND_SPAWN_FAILED", error.message); });
          child.once("close", (exitCode, signal) => {
            void (async () => {
              // POSIX groups can outlive their leader. Reap descendants even after normal completion.
              if (!windows || termination) await terminate();
              if (pendingError) throw pendingError;
              return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode, signal };
            })().then(resolve, reject);
          });
        });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (!cleanupFailed) active.delete(owned);
        resolveDone();
      }
    },
    dispose() {
      if (disposal) return disposal;
      closed = true;
      const commands = [...active];
      for (const command of commands) command.cancel();
      disposal = Promise.all(commands.map(async (command) => {
        await command.done;
        await command.cleanup();
        active.delete(command);
      })).then(() => undefined).catch((error: unknown) => {
        disposal = undefined;
        throw error;
      });
      return disposal;
    },
  };
}
