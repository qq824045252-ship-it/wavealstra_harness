/**
 * Platform-declared background lifecycle & autostart adapter for Rust Core (`RC-08`).
 * All platform differences live here (`src/main/platform/`), never in domain services.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { prepareCoreBinary } from "./core-client";
import { currentPlatformId, type PlatformId } from "./index";

const execFileAsync = promisify(execFile);

const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE = "MyBuddyCoreWatchdog";

export interface AutostartRegistrationSpec {
  platform: PlatformId;
  kind: "windows-registry-run" | "linux-systemd-xdg" | "macos-launchagent";
  executable: string;
  args: string[];
  commandLine: string;
  linuxDesktopPath?: string;
  linuxSystemdPath?: string;
}

export interface CoreLifecycleFileState {
  mode: "active" | "stopped_explicitly";
  residentEnabled: boolean;
  autostartEnabled: boolean;
  reason: string;
  updatedAt: number;
}

export async function readCoreLifecycleFile(dataDirectory: string): Promise<CoreLifecycleFileState> {
  try {
    const raw = await readFile(join(dataDirectory, "core-lifecycle.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<CoreLifecycleFileState>;
    return {
      mode: parsed.mode === "stopped_explicitly" ? "stopped_explicitly" : "active",
      residentEnabled: parsed.residentEnabled === true,
      autostartEnabled: parsed.autostartEnabled === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "default",
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return {
      mode: "active",
      residentEnabled: false,
      autostartEnabled: false,
      reason: "default",
      updatedAt: 0,
    };
  }
}

export function buildCoreAutostartSpec(
  immutableBinaryPath: string,
  dataDirectory: string,
  dbPath: string,
  platform: PlatformId = currentPlatformId,
  homeDirectory = homedir(),
): AutostartRegistrationSpec {
  const args = ["--watchdog", dataDirectory, dbPath];
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  const commandLine = `${quote(immutableBinaryPath)} ${args.map(quote).join(" ")}`;
  if (platform === "windows") {
    return {
      platform,
      kind: "windows-registry-run",
      executable: immutableBinaryPath,
      args,
      commandLine,
    };
  }
  if (platform === "linux") {
    return {
      platform,
      kind: "linux-systemd-xdg",
      executable: immutableBinaryPath,
      args,
      commandLine,
      linuxDesktopPath: join(homeDirectory, ".config", "autostart", "mybuddy-core.desktop"),
      linuxSystemdPath: join(homeDirectory, ".config", "systemd", "user", "mybuddy-core.service"),
    };
  }
  return {
    platform,
    kind: "macos-launchagent",
    executable: immutableBinaryPath,
    args,
    commandLine,
  };
}

export type AutostartCommandRunner = (command: string, args: string[]) => Promise<void>;

const defaultRunner: AutostartCommandRunner = async (command, args) => {
  await execFileAsync(command, args, { windowsHide: true, timeout: 10_000 });
};

/** Synchronizes OS login/watchdog registration with user settings AND the explicit stop fence. */
export async function syncCoreAutostart(input: {
  executable: string;
  dataDirectory: string;
  dbPath: string;
  autostartEnabled: boolean;
  stoppedExplicitly?: boolean;
  platform?: PlatformId;
  homeDirectory?: string;
  runner?: AutostartCommandRunner;
}): Promise<{ applied: boolean; enabled: boolean; spec: AutostartRegistrationSpec }> {
  const platform = input.platform ?? currentPlatformId;
  const prepared = await prepareCoreBinary(input.executable, input.dataDirectory);
  const spec = buildCoreAutostartSpec(prepared.executable, input.dataDirectory, input.dbPath, platform, input.homeDirectory);
  const lifecycle = await readCoreLifecycleFile(input.dataDirectory);
  const shouldEnable = input.autostartEnabled && !input.stoppedExplicitly && lifecycle.mode !== "stopped_explicitly";
  const run = input.runner ?? defaultRunner;

  if (platform === "windows") {
    if (shouldEnable) {
      await run("reg.exe", ["add", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/t", "REG_SZ", "/d", spec.commandLine, "/f"]);
    } else {
      await run("reg.exe", ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"]).catch(() => undefined);
    }
    return { applied: true, enabled: shouldEnable, spec };
  }

  if (platform === "linux" && spec.linuxDesktopPath && spec.linuxSystemdPath) {
    if (shouldEnable) {
      await mkdir(join(input.homeDirectory ?? homedir(), ".config", "autostart"), { recursive: true });
      await mkdir(join(input.homeDirectory ?? homedir(), ".config", "systemd", "user"), { recursive: true });
      await writeFile(spec.linuxDesktopPath, [
        "[Desktop Entry]",
        "Type=Application",
        "Name=MyBuddy Core",
        `Exec=${spec.commandLine}`,
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n"), "utf8");
      await writeFile(spec.linuxSystemdPath, [
        "[Unit]",
        "Description=MyBuddy Core Watchdog",
        "",
        "[Service]",
        `ExecStart=${spec.commandLine}`,
        "Restart=on-failure",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"), "utf8");
    } else {
      await rm(spec.linuxDesktopPath, { force: true });
      await rm(spec.linuxSystemdPath, { force: true });
    }
    return { applied: true, enabled: shouldEnable, spec };
  }

  return { applied: false, enabled: shouldEnable, spec };
}

/** Spawns the Rust Core watchdog in detached mode after preparing an immutable Medium-IL executable. */
export async function launchCoreWatchdog(
  executable: string,
  dataDirectory: string,
  dbPath: string,
  options?: { recover?: boolean; env?: Record<string, string | undefined> },
): Promise<{ pid?: number; executable: string }> {
  const prepared = await prepareCoreBinary(executable, dataDirectory);
  const args = ["--watchdog", dataDirectory, dbPath, ...(options?.recover ? ["--recover"] : [])];
  const child = spawn(prepared.executable, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
      ...(process.env.TZ && { TZ: process.env.TZ }),
      ...options?.env,
    },
  });
  child.unref();
  return { pid: child.pid, executable: prepared.executable };
}
