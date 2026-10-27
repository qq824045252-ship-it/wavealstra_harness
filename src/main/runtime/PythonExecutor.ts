import { spawn } from "node:child_process";
import { spawnDetachedForTreeKill } from "../platform/runtime";
import { killProcessTree as killPlatformProcessTree } from "../platform/processes";
import { dirname, delimiter } from "node:path";
import { applyShellIsolationSpawnContext } from "../security/TaskExecutionIsolation";

/** Native execution, independent of Git Bash. Resolves only after streams close. */
export async function executePython(options: {
  pythonPath: string; scriptPath: string; args?: string[]; cwd: string;
  signal?: AbortSignal; timeoutSeconds?: number; onOutput?: (text: string) => void;
  isolationLevel?: unknown;
}): Promise<{ text: string; exitCode: number | null; cancelled: boolean; timedOut: boolean }> {
  if (options.signal?.aborted) return { text: "Python execution cancelled", exitCode: null, cancelled: true, timedOut: false };
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(PYTHON|VIRTUAL_ENV$|CONDA_PREFIX$|PATH$)/i.test(key)) delete env[key];
  }
  env.PATH = dirname(options.pythonPath) + delimiter + (process.env.PATH ?? process.env.Path ?? "");
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONPATH = options.cwd;
  env.MYBUDDY_TASK_ROOT = options.cwd;
  const isolated = applyShellIsolationSpawnContext(options.isolationLevel, options.cwd, { command: "", cwd: options.cwd, env });
  const child = spawn(options.pythonPath, ["-u", options.scriptPath, ...(options.args ?? [])], {
    cwd: isolated.cwd, env: isolated.env, shell: false, windowsHide: true, detached: spawnDetachedForTreeKill(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "", cancelled = false, timedOut = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const append = (chunk: string) => {
    text = (text + chunk).slice(-200_000);
    options.onOutput?.(text);
  };
  const stop = () => {
    if (!child.pid || child.exitCode !== null) return;
    killer = killPlatformProcessTree(child, {
      windowsTaskkillCommand: "taskkill.exe",
      onWindowsError: () => child.kill(),
      posixSignal: "SIGTERM",
      escalateSignal: "SIGKILL",
      escalateAfterMs: 1000,
      onPosixError: () => child.kill(),
    });
  };
  const abort = () => { cancelled = true; stop(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, options.timeoutSeconds ?? 120) * 1000);
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", append); child.stderr.on("data", append);
  try {
    const exitCode = await new Promise<number | null>(resolve => {
      child.on("error", error => append(error.message));
      child.once("close", resolve);
    });
    if (cancelled) text += "\n[Python execution cancelled]";
    if (timedOut) text += "\n[Python execution timed out]";
    return { text, exitCode, cancelled, timedOut };
  } finally {
    clearTimeout(timer); if (killer) clearTimeout(killer);
    options.signal?.removeEventListener("abort", abort);
  }
}
