import {
  CoreBusinessClient,
  type CoreBusinessClientOptions,
  type CoreDomainEvent,
  type CoreEventsSnapshot,
} from "../platform/core-business-client";

export interface UiReconnectState {
  connected: boolean;
  openCount: number;
  closeCount: number;
  resyncCount: number;
  coreGeneration?: string;
  lastSeq: number;
  dedupedCount: number;
  activeListeners: number;
}

export interface UiReconnectHooks {
  onSnapshot?: (snapshot: CoreEventsSnapshot) => void;
  onEvent?: (event: CoreDomainEvent) => void;
  onResync?: (snapshot: CoreEventsSnapshot, reason: string) => void;
  onHydrate?: (snapshot: CoreEventsSnapshot, reason: string) => Promise<void> | void;
  onConnectionState?: (state: { connected: boolean; recovering: boolean }) => void;
}

/**
 * Window-scoped UI reconnect controller (`RC-23`, `P0-05`, `P1-06`).
 *
 * Opening or closing UI windows only opens/closes this `role: "ui"` subscription.
 * Reopen fetches the authoritative Core snapshot first and replays cursor deltas,
 * deduplicating by `(coreGeneration, seq)` and `(entity, revision)` while forcing
 * cache-discarding resync + hydration on sequence gaps or Core generation transitions.
 * Unexpected Core disconnects trigger bounded exponential-backoff auto-reconnect.
 */
export class UiReconnectController {
  private client?: CoreBusinessClient;
  private subscription?: Awaited<ReturnType<CoreBusinessClient["openEventSubscription"]>>;
  private readonly listeners = new Set<UiReconnectHooks>();
  private readonly seenKeys = new Set<string>();
  private readonly entityRevisions = new Map<string, number>();
  private openCount = 0;
  private closeCount = 0;
  private resyncCount = 0;
  private dedupedCount = 0;
  private coreGeneration?: string;
  private lastSeq = 0;
  private persistedCursor?: { coreGeneration: string; lastSeq: number };
  private intentionalClose = false;
  private reconnecting = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly executable: string,
    private readonly dbPath: string,
    private readonly clientOptions: Omit<CoreBusinessClientOptions, "role">,
  ) {}

  addHooks(hooks: UiReconnectHooks): () => void {
    this.listeners.add(hooks);
    return () => { this.listeners.delete(hooks); };
  }

  getClient(): CoreBusinessClient | undefined {
    return this.client;
  }

  getCursor(): { coreGeneration?: string; lastSeq: number } {
    return { coreGeneration: this.coreGeneration, lastSeq: this.lastSeq };
  }

  setLastSeenCursor(coreGeneration: string, lastSeq: number): void {
    this.persistedCursor = { coreGeneration, lastSeq };
  }

  getState(): UiReconnectState {
    return {
      connected: Boolean(this.client && !this.client.isClosed),
      openCount: this.openCount,
      closeCount: this.closeCount,
      resyncCount: this.resyncCount,
      coreGeneration: this.coreGeneration,
      lastSeq: this.lastSeq,
      dedupedCount: this.dedupedCount,
      activeListeners: this.listeners.size,
    };
  }

  /** Connect UI client, pull authoritative snapshot, replay any missed cursor deltas, and subscribe live. */
  async openUiSession(): Promise<CoreEventsSnapshot> {
    if (this.client && !this.client.isClosed && this.subscription) {
      return await this.client.eventsSnapshot();
    }
    this.intentionalClose = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.openCount += 1;
    const client = await CoreBusinessClient.connect(this.executable, this.dbPath, {
      ...this.clientOptions,
      role: "ui",
      clientId: `${this.clientOptions.clientId ?? "ui"}-${this.openCount}`,
    });
    this.client = client;
    client.onClose(() => {
      if (this.client === client) {
        this.subscription = undefined;
        this.client = undefined;
      }
      if (!this.intentionalClose) {
        this.emitConnectionState({ connected: false, recovering: true });
        this.scheduleReconnect();
      }
    });

    let initialSnapshot!: CoreEventsSnapshot;
    const previousCursor = this.persistedCursor;
    const sub = await client.openEventSubscription({
      onSnapshot: snapshot => {
        initialSnapshot = snapshot;
        this.coreGeneration = snapshot.coreGeneration;
        this.lastSeq = snapshot.headSeq;
        this.persistedCursor = { coreGeneration: snapshot.coreGeneration, lastSeq: snapshot.headSeq };
        for (const h of this.listeners) h.onSnapshot?.(snapshot);
      },
      onEvent: ev => this.handleIncomingEvent(ev),
      onResync: (snapshot, reason) => {
        this.triggerResync(snapshot, reason);
      },
    });
    this.subscription = sub;
    this.emitConnectionState({ connected: true, recovering: false });

    if (previousCursor) {
      if (previousCursor.coreGeneration !== initialSnapshot.coreGeneration) {
        this.triggerResync(initialSnapshot, "core_generation_changed");
      } else if (previousCursor.lastSeq < initialSnapshot.headSeq) {
        await sub.replayFrom(previousCursor.lastSeq, previousCursor.coreGeneration);
      }
    }

    return initialSnapshot;
  }

  private triggerResync(snapshot: CoreEventsSnapshot, reason: string): void {
    this.resyncCount += 1;
    this.entityRevisions.clear();
    this.seenKeys.clear();
    this.coreGeneration = snapshot.coreGeneration;
    this.lastSeq = snapshot.headSeq;
    this.persistedCursor = { coreGeneration: snapshot.coreGeneration, lastSeq: snapshot.headSeq };
    for (const h of this.listeners) {
      try { h.onResync?.(snapshot, reason); } catch { /* ignore listener failure */ }
      try { void Promise.resolve(h.onHydrate?.(snapshot, reason)).catch(() => undefined); } catch { /* ignore */ }
    }
  }

  private emitConnectionState(state: { connected: boolean; recovering: boolean }): void {
    for (const h of this.listeners) {
      try { h.onConnectionState?.(state); } catch { /* ignore listener failure */ }
    }
  }

  private scheduleReconnect(attempt = 0): void {
    if (this.intentionalClose || this.reconnecting) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const delayMs = attempt === 0 ? 200 : Math.min(3_000, 200 * Math.pow(2, attempt - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionalClose) return;
      this.reconnecting = true;
      void this.openUiSession()
        .then(() => {
          this.reconnecting = false;
        })
        .catch(() => {
          this.reconnecting = false;
          if (!this.intentionalClose) {
            this.scheduleReconnect(Math.min(attempt + 1, 6));
          }
        });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  /** Replay from explicit cursor to test/recover from gaps cleanly. */
  async replayFrom(afterSeq: number, coreGeneration?: string): Promise<{ resynced: boolean; events: CoreDomainEvent[] }> {
    if (!this.subscription) throw new Error("UI session is not open");
    return await this.subscription.replayFrom(afterSeq, coreGeneration);
  }

  private handleIncomingEvent(ev: CoreDomainEvent): void {
    if ((ev as { ephemeral?: boolean }).ephemeral === true) {
      for (const h of this.listeners) {
        try { h.onEvent?.(ev); } catch { /* ignore listener failure */ }
      }
      return;
    }
    const seqKey = `${ev.coreGeneration}:${ev.seq}`;
    if (this.seenKeys.has(seqKey)) {
      this.dedupedCount += 1;
      return;
    }
    this.seenKeys.add(seqKey);
    if (this.seenKeys.size > 4_096) {
      const oldest = this.seenKeys.values().next().value;
      if (oldest) this.seenKeys.delete(oldest);
    }

    // Track monotonic entity revision for stateful domains without discarding fine-grained progress events.
    const entityKey = `${ev.domain}:${ev.entityId}:${ev.kind}`;
    const prevRev = this.entityRevisions.get(entityKey) ?? -1;
    if (ev.kind !== "execution.progress" && ev.revision <= prevRev) {
      this.dedupedCount += 1;
      return;
    }
    if (ev.revision > prevRev) {
      this.entityRevisions.set(entityKey, ev.revision);
    }

    this.coreGeneration = ev.coreGeneration;
    this.lastSeq = Math.max(this.lastSeq, ev.seq);
    this.persistedCursor = { coreGeneration: ev.coreGeneration, lastSeq: this.lastSeq };

    for (const h of this.listeners) {
      try { h.onEvent?.(ev); } catch { /* ignore listener failure */ }
    }
  }

  /** Close only the UI client subscription; leaves Core, Pi Host, Schedulers, and Gadgets untouched. */
  async closeUiSession(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (!this.client && !this.subscription) return;
    this.closeCount += 1;
    await this.subscription?.close().catch(() => undefined);
    this.subscription = undefined;
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.emitConnectionState({ connected: false, recovering: false });
  }
}
