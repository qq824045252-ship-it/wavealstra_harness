import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { isBashExecutableName } from "./platform/paths";

/** Pi's shellPath configures its Bash tool. Interactive terminal preferences live separately. */
export function isBashShellPath(path: string): boolean {
  return isBashExecutableName(path.trim().split(/[\\/]/).at(-1) ?? "");
}

export function normalizeTerminalShellPath(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Preserve the old terminal choice, while removing non-Bash overrides from Pi. */
export function migrateLegacyShellPreferences(raw: Record<string, unknown>): { settings: Record<string, unknown>; changed: boolean } {
  const settings = { ...raw };
  const legacy = normalizeTerminalShellPath(raw.shellPath);
  let changed = false;
  if (legacy && !isBashShellPath(legacy)) {
    if (raw.terminalShellPath === undefined) {
      settings.terminalShellPath = legacy;
      changed = true;
    }
    delete settings.shellPath;
    changed = true;
  }
  return { settings, changed };
}

/** Validate at the SDK getter so reloads and project overrides receive the same check. */
export function createAgentSettingsManager(cwd: string, agentDir: string): SettingsManager {
  const settings = SettingsManager.create(cwd, agentDir);
  const getShellPath = settings.getShellPath.bind(settings);
  settings.getShellPath = () => {
    const path = getShellPath();
    if (path && !isBashShellPath(path)) {
      // Also support callers constructed before startup migration (capability checks/tests).
      // A legacy global non-Bash setting is only a terminal preference.
      if (!settings.getProjectSettings().shellPath) return undefined;
      throw new Error(`代理 shellPath 必须指向 Bash（bash.exe 或 sh），当前为 ${path}。内置终端请使用 terminalShellPath；PowerShell 命令请使用 powershell 工具。`);
    }
    return path;
  };
  return settings;
}

export function getAgentBashShellPath(cwd: string, agentDir: string): string | undefined {
  return createAgentSettingsManager(cwd, agentDir).getShellPath();
}
