export interface PlatformCapabilityAvailability {
  uiOnline: boolean;
  browserAvailable: boolean;
  desktopAvailable: boolean;
}

export type PlatformActionOutcome<T = unknown> =
  | { status: "completed"; result: T }
  | { status: "waiting_platform"; reason: string; capability: "browser" | "desktop" | "ui" }
  | { status: "failed"; error: string };

/**
 * Coordinates platform-dependent capabilities in Electron Main (`RC-24`).
 * When no Electron UI/browser/desktop surface is available (e.g. headless UI exit),
 * dependent tasks wait honestly rather than spinning up a second business host.
 */
export class PlatformCapabilityProxy {
  private availability: PlatformCapabilityAvailability = {
    uiOnline: false,
    browserAvailable: false,
    desktopAvailable: process.platform === "win32" || process.platform === "linux" || process.platform === "darwin",
  };

  setUiOnline(online: boolean): void {
    this.availability.uiOnline = online;
  }

  setBrowserAvailable(available: boolean): void {
    this.availability.browserAvailable = available;
  }

  getAvailability(): PlatformCapabilityAvailability {
    return { ...this.availability };
  }

  async invoke<T>(
    capability: "browser" | "desktop" | "ui",
    execute: () => Promise<T> | T,
  ): Promise<PlatformActionOutcome<T>> {
    if ((capability === "browser" && !this.availability.browserAvailable) || (capability === "ui" && !this.availability.uiOnline)) {
      return {
        status: "waiting_platform",
        capability,
        reason: capability === "browser"
          ? "Browser surface unavailable while UI is offline; waiting for UI reopen"
          : "Electron UI window offline; waiting for UI proxy reconnect",
      };
    }
    try {
      const result = await execute();
      return { status: "completed", result };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
