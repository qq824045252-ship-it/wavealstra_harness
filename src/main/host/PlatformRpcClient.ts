import { randomUUID } from "node:crypto";
import type {
  CoreBusinessClient,
  CorePlatformAvailabilityEvent,
} from "../platform/core-business-client";
import type { PlatformActionOutcome } from "./PlatformCapabilityProxy";

export interface PlatformRpcInvokeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Host-side RPC proxy for Electron Main platform capabilities (`P0-03`).
 * Routes `browser` / `ui` / `desktop` / `computer` calls from `PiNodeHost`
 * over Core (`Relay`) to Electron Main without ever importing Electron into
 * the worker or blocking SQLite / Core event delivery.
 */
export class PlatformRpcClient {
  private availability: CorePlatformAvailabilityEvent = {
    available: false,
    uiOnline: false,
    browserAvailable: false,
    computerAvailable: false,
    capabilities: [],
  };
  private unhookClient?: () => void;
  private readonly availabilityListeners = new Set<(state: CorePlatformAvailabilityEvent) => void>();

  constructor(private readonly getClient: () => CoreBusinessClient | undefined) {}

  attach(client: CoreBusinessClient | undefined): void {
    this.unhookClient?.();
    this.unhookClient = undefined;
    if (!client || client.isClosed) {
      this.updateAvailability({
        available: false,
        uiOnline: false,
        browserAvailable: false,
        computerAvailable: false,
        capabilities: [],
        reason: "disconnected",
      });
      return;
    }
    const offAvail = client.onPlatformAvailability(ev => this.updateAvailability(ev));
    const offClose = client.onClose(() => {
      this.updateAvailability({
        available: false,
        uiOnline: false,
        browserAvailable: false,
        computerAvailable: false,
        capabilities: [],
        reason: "core_disconnected",
      });
    });
    this.unhookClient = () => {
      offAvail();
      offClose();
    };
  }

  onAvailabilityChanged(listener: (state: CorePlatformAvailabilityEvent) => void): () => void {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  getAvailability(): CorePlatformAvailabilityEvent {
    return { ...this.availability, capabilities: [...(this.availability.capabilities ?? [])] };
  }

  isDomainAvailable(domain: "ui" | "browser" | "desktop" | "computer" | string): boolean {
    if (!this.availability.available) return false;
    if (domain === "ui") return this.availability.uiOnline;
    if (domain === "browser") return this.availability.browserAvailable;
    if (domain === "desktop" || domain === "computer") return Boolean(this.availability.computerAvailable);
    return true;
  }

  async invoke<T = unknown>(
    domain: "browser" | "desktop" | "computer" | "ui" | string,
    action: string,
    payload: unknown = {},
    options?: PlatformRpcInvokeOptions,
  ): Promise<PlatformActionOutcome<T>> {
    const capability = domain === "computer" ? "desktop" : (domain === "browser" || domain === "ui" ? domain : "desktop");
    if (options?.signal?.aborted) {
      return { status: "cancelled", capability, reason: "Aborted before dispatch" };
    }
    const client = this.getClient();
    if (!client || client.isClosed) {
      return {
        status: "waiting_platform",
        capability,
        code: "CORE_UNAVAILABLE",
        reason: "Core client disconnected; cannot invoke Electron Main platform capability",
      };
    }

    const invocationId = randomUUID();
    const onAbort = () => {
      if (!client.isClosed) {
        void client.sendPlatformCancel(invocationId).catch(() => undefined);
      }
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const reply = await client.sendPlatformRequest<{
        ok?: boolean;
        outcome?: PlatformActionOutcome<T>;
        status?: string;
        result?: T;
        error?: string;
        code?: string;
        reason?: string;
      }>({
        invocationId,
        domain,
        action,
        payload,
        timeoutMs: options?.timeoutMs,
      });

      if (reply && typeof reply === "object" && "outcome" in reply && reply.outcome) {
        const out = reply.outcome;
        if ((out.status as string) === "unavailable") {
          const raw = out as unknown as { code?: string; message?: string; reason?: string };
          return {
            status: "waiting_platform",
            capability,
            code: raw.code,
            reason: raw.message ?? raw.reason ?? "Platform capability unavailable",
          };
        }
        return out;
      }

      const rawStatus = reply?.status;
      if (rawStatus === "completed") {
        return { status: "completed", result: reply.result as T };
      }
      if (rawStatus === "waiting_platform" || rawStatus === "unavailable") {
        return {
          status: "waiting_platform",
          capability,
          code: reply.code,
          reason: reply.reason ?? "Platform capability offline",
        };
      }
      if (rawStatus === "uncertain_platform_disconnect") {
        return {
          status: "uncertain_platform_disconnect",
          capability,
          code: reply.code ?? "PLATFORM_DISCONNECTED",
          reason: reply.reason ?? "Electron Main disconnected while action was in flight",
        };
      }
      if (rawStatus === "cancelled") {
        return {
          status: "cancelled",
          capability,
          reason: reply.reason ?? "Platform action cancelled",
        };
      }
      return {
        status: "failed",
        error: reply?.error ?? "Unknown platform RPC outcome",
      };
    } catch (error) {
      if (options?.signal?.aborted) {
        return { status: "cancelled", capability, reason: "Aborted in flight" };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("connection closed") || client.isClosed) {
        return {
          status: "uncertain_platform_disconnect",
          capability,
          code: "CORE_CONNECTION_CLOSED",
          reason: message,
        };
      }
      return { status: "failed", error: message };
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  dispose(): void {
    this.unhookClient?.();
    this.unhookClient = undefined;
    this.availabilityListeners.clear();
  }

  private updateAvailability(next: CorePlatformAvailabilityEvent): void {
    this.availability = {
      available: Boolean(next.available),
      uiOnline: Boolean(next.uiOnline),
      browserAvailable: Boolean(next.browserAvailable),
      computerAvailable: Boolean(next.computerAvailable),
      capabilities: Array.isArray(next.capabilities) ? [...next.capabilities] : [],
      platformGeneration: next.platformGeneration,
      ownerEpoch: next.ownerEpoch,
      reason: next.reason,
    };
    for (const listener of this.availabilityListeners) {
      try { listener(this.getAvailability()); } catch { /* ignore */ }
    }
  }
}
