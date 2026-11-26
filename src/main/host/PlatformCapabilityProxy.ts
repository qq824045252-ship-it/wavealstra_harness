import type {
  CoreBusinessClient,
  CorePlatformCancelEvent,
  CorePlatformInvokeEvent,
} from "../platform/core-business-client";

export interface PlatformCapabilityAvailability {
  uiOnline: boolean;
  browserAvailable: boolean;
  desktopAvailable: boolean;
}

export type PlatformActionOutcome<T = unknown> =
  | { status: "completed"; result: T }
  | { status: "waiting_platform"; reason: string; capability: "browser" | "desktop" | "ui"; code?: string }
  | { status: "cancelled"; reason: string; capability: "browser" | "desktop" | "ui" }
  | { status: "uncertain_platform_disconnect"; reason: string; capability: "browser" | "desktop" | "ui"; code?: string }
  | { status: "failed"; error: string };

export type PlatformDomainHandler = (
  action: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<unknown> | unknown;

/**
 * Coordinates platform-dependent capabilities in Electron Main (`RC-24` & `P0-03`).
 * When no Electron UI/browser/desktop surface is available (e.g. headless UI exit),
 * dependent tasks wait honestly rather than spinning up a second business host.
 * When attached to a `CoreBusinessClient`, publishes live availability to Core and
 * serves `corePlatformInvoke` / `corePlatformCancel` requests routed from `PiNodeHost`.
 */
export class PlatformCapabilityProxy {
  private availability: PlatformCapabilityAvailability = {
    uiOnline: false,
    browserAvailable: false,
    desktopAvailable: process.platform === "win32" || process.platform === "linux" || process.platform === "darwin",
  };
  private readonly handlers = new Map<string, PlatformDomainHandler>();
  private readonly inFlight = new Map<string, AbortController>();
  private coreClient?: CoreBusinessClient;
  private unhookCore?: () => void;
  private platformGeneration = `main-${process.pid}`;

  setUiOnline(online: boolean): void {
    this.availability.uiOnline = online;
    void this.syncAvailability();
  }

  setBrowserAvailable(available: boolean): void {
    this.availability.browserAvailable = available;
    void this.syncAvailability();
  }

  setDesktopAvailable(available: boolean): void {
    this.availability.desktopAvailable = available;
    void this.syncAvailability();
  }

  getAvailability(): PlatformCapabilityAvailability {
    return { ...this.availability };
  }

  registerDomainHandler(domain: string, handler: PlatformDomainHandler): () => void {
    this.handlers.set(domain, handler);
    return () => {
      if (this.handlers.get(domain) === handler) {
        this.handlers.delete(domain);
      }
    };
  }

  attachCoreClient(
    client: CoreBusinessClient | undefined,
    options?: { platformGeneration?: string },
  ): void {
    this.unhookCore?.();
    this.unhookCore = undefined;
    this.coreClient = client;
    if (options?.platformGeneration) {
      this.platformGeneration = options.platformGeneration;
    }
    if (!client || client.isClosed) return;

    const offInvoke = client.onPlatformInvoke(ev => {
      void this.handleRemoteInvoke(client, ev);
    });
    const offCancel = client.onPlatformCancel(ev => {
      this.handleRemoteCancel(ev);
    });
    const offClose = client.onClose(() => {
      for (const ac of this.inFlight.values()) ac.abort();
      this.inFlight.clear();
      if (this.coreClient === client) {
        this.coreClient = undefined;
      }
    });
    this.unhookCore = () => {
      offInvoke();
      offCancel();
      offClose();
    };
    void this.syncAvailability();
  }

  async syncAvailability(): Promise<void> {
    const client = this.coreClient;
    if (!client || client.isClosed) return;
    await client.registerPlatform({
      available: true,
      uiOnline: this.availability.uiOnline,
      browserAvailable: this.availability.browserAvailable,
      computerAvailable: this.availability.desktopAvailable,
      capabilities: Array.from(this.handlers.keys()),
      platformGeneration: this.platformGeneration,
    }).catch(() => undefined);
  }

  private handleRemoteCancel(ev: CorePlatformCancelEvent): void {
    const ac = this.inFlight.get(ev.invocationId);
    if (ac) {
      ac.abort(new Error(ev.reason ?? "Platform invocation cancelled by caller"));
    }
  }

  private async handleRemoteInvoke(client: CoreBusinessClient, ev: CorePlatformInvokeEvent): Promise<void> {
    const capability = ev.domain === "ui" ? "ui" : (ev.domain === "browser" ? "browser" : "desktop");
    const ac = new AbortController();
    this.inFlight.set(ev.invocationId, ac);
    let outcome: PlatformActionOutcome;
    try {
      const handler = this.handlers.get(ev.domain)
        ?? (ev.domain === "computer" ? this.handlers.get("desktop") : undefined)
        ?? (ev.domain === "desktop" ? this.handlers.get("computer") : undefined);
      if (!handler) {
        outcome = {
          status: "waiting_platform",
          capability,
          code: "HANDLER_UNREGISTERED",
          reason: `No platform handler registered in Electron Main for domain '${ev.domain}'`,
        };
      } else {
        outcome = await this.invoke(capability, () => handler(ev.action, ev.payload, ac.signal));
        if (ac.signal.aborted && outcome.status === "failed") {
          outcome = { status: "cancelled", capability, reason: outcome.error };
        }
      }
    } finally {
      this.inFlight.delete(ev.invocationId);
    }
    if (!client.isClosed) {
      await client.sendPlatformReply(ev.invocationId, outcome).catch(() => undefined);
    }
  }

  async invoke<T>(
    capability: "browser" | "desktop" | "ui",
    execute: () => Promise<T> | T,
  ): Promise<PlatformActionOutcome<T>> {
    if (
      (capability === "browser" && !this.availability.browserAvailable)
      || (capability === "ui" && !this.availability.uiOnline)
      || (capability === "desktop" && !this.availability.desktopAvailable)
    ) {
      return {
        status: "waiting_platform",
        capability,
        reason: capability === "browser"
          ? "Browser surface unavailable while UI is offline; waiting for UI reopen"
          : (capability === "ui"
            ? "Electron UI window offline; waiting for UI proxy reconnect"
            : "Desktop automation capability offline"),
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
