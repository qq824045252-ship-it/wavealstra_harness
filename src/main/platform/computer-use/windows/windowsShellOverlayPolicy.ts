import { win32 } from "node:path";

/** Keep this allowlist narrow: a CoreWindow class alone also matches ordinary apps. */
export const WINDOWS_SHELL_OVERLAYS = [{
  className: "Windows.UI.Core.CoreWindow",
  processName: "ShellExperienceHost",
  relativeExecutable: "SystemApps\\ShellExperienceHost_cw5n1h2txyewy\\ShellExperienceHost.exe",
}] as const;

export interface WindowsShellOverlay {
  handle: string;
  processId: number;
  processName: string;
  className: string;
  processPath: string;
  windowsDirectory: string;
  visible: boolean;
  foreground: boolean;
}

export function isKnownWindowsShellOverlay(value: unknown): value is WindowsShellOverlay {
  if (!value || typeof value !== "object") return false;
  const window = value as Partial<WindowsShellOverlay>;
  if (typeof window.handle !== "string" || !/^[1-9]\d*$/.test(window.handle)
    || !Number.isSafeInteger(window.processId) || Number(window.processId) <= 0
    || window.visible !== true || window.foreground !== true
    || typeof window.processName !== "string" || typeof window.className !== "string"
    || typeof window.processPath !== "string" || typeof window.windowsDirectory !== "string"
    || !/^[a-z]:\\/i.test(window.windowsDirectory)) return false;
  return WINDOWS_SHELL_OVERLAYS.some((identity) => window.className === identity.className
    && window.processName!.toLowerCase() === identity.processName.toLowerCase()
    && win32.normalize(window.processPath!).toLowerCase()
      === win32.join(window.windowsDirectory!, identity.relativeExecutable).toLowerCase());
}

/** The native injection guard and the TS admission policy share the same allowlist. */
export const WINDOWS_SHELL_OVERLAY_NATIVE_MATCH = WINDOWS_SHELL_OVERLAYS.map((identity) =>
  `(className == ${JSON.stringify(identity.className)} && String.Equals(imagePath, System.IO.Path.Combine(WindowsDirectory(), ${JSON.stringify(identity.relativeExecutable)}), StringComparison.OrdinalIgnoreCase))`,
).join(" || ");
