import { randomUUID } from "node:crypto";
import { connectCoreWorker, type CoreClientRole, type RuntimeCoreClient } from "./core-client";

export interface CoreDomainEvent {
  seq: number;
  eventId: string;
  coreGeneration: string;
  ownerGeneration: string;
  domain: string;
  kind: string;
  entityId: string;
  revision: number;
  commandId?: string | null;
  payload: Record<string, unknown>;
  createdAtMs: number;
}

export interface CoreExecutionRecord {
  executionId: string;
  idempotencyKey: string;
  ownerGeneration: string;
  sourceRole: string;
  sourceClientId: string;
  sourceEpoch: number;
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  status:
    | "queued"
    | "waiting_executor"
    | "dispatching"
    | "running"
    | "pause_requested"
    | "paused"
    | "cancel_requested"
    | "cancelled"
    | "completed"
    | "failed"
    | "unknown";
  revision: number;
  executorClientId?: string | null;
  executorEpoch?: number | null;
  attempt: number;
  result?: unknown;
  errorMessage?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CoreExecutionDispatch {
  targetRole: "execution-host";
  targetEpoch: number;
  coreGeneration: string;
  action: "start" | "pause" | "cancel";
  execution: CoreExecutionRecord;
}

export interface CoreEventsSnapshot {
  coreGeneration: string;
  headSeq: number;
  minAvailableSeq: number;
  retentionLimit?: number;
  notes: Array<{
    entityId: string;
    ownerGeneration: string;
    revision: number;
    title: string;
    body: unknown;
    deleted: boolean;
    updatedAtMs: number;
  }>;
  executions: CoreExecutionRecord[];
  lifecycle: CoreLifecycleStateDto;
}

export interface CoreEventsReplay {
  gap: boolean;
  reason?: "generation_mismatch" | "cursor_expired" | "cursor_ahead";
  coreGeneration: string;
  headSeq: number;
  minAvailableSeq: number;
  hasMore?: boolean;
  events: CoreDomainEvent[];
}

export interface CoreLifecycleStateDto {
  mode: "active" | "stopped_explicitly";
  residentEnabled: boolean;
  autostartEnabled: boolean;
  reason: string;
  updatedAt: number;
}

export interface CoreStatusDto {
  pid: number;
  workerPid: number;
  generation: string;
  state: string;
  workerRestartCount: number;
  consecutiveFailures: number;
  circuitOpen: boolean;
  circuitReason?: string | null;
  lastWorkerExit?: string | null;
  updatedAt: number;
}

export interface CoreBusinessClientOptions {
  dataDirectory: string;
  role: CoreClientRole;
  clientId?: string;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Role-scoped multiplexed business protocol client for Step 3 (`RC-06`–`RC-08`). */
export class CoreBusinessClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: CoreDomainEvent) => void>();
  private readonly dispatchListeners = new Set<(dispatch: CoreExecutionDispatch) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly seenEvents = new Set<string>();
  private buffered = "";
  private closed = false;

  private constructor(readonly transport: RuntimeCoreClient) {
    transport.stdout.on("data", chunk => this.onData(chunk as Buffer));
    transport.once("close", () => this.handleClose());
    transport.on("error", () => this.handleClose());
  }

  static async connect(executable: string, dbPath: string, options: CoreBusinessClientOptions): Promise<CoreBusinessClient> {
    const client = await connectCoreWorker(executable, dbPath, options);
    return new CoreBusinessClient(client);
  }

  get generation(): string {
    return this.transport.generation;
  }

  get role(): CoreClientRole | undefined {
    return this.transport.role;
  }

  get clientId(): string | undefined {
    return this.transport.clientId;
  }

  get connectionEpoch(): number | undefined {
    return this.transport.connectionEpoch;
  }

  get workerPid(): number {
    return this.transport.pid;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onCoreEvent(listener: (event: CoreDomainEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  onExecutionDispatch(listener: (dispatch: CoreExecutionDispatch) => void): () => void {
    this.dispatchListeners.add(listener);
    return () => { this.dispatchListeners.delete(listener); };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  async request<T = unknown>(payload: Record<string, unknown>, timeoutMs = 5_000): Promise<T> {
    if (this.closed) throw new Error("CoreBusinessClient is closed");
    if (this.pending.size >= 256) throw new Error("CoreBusinessClient pending request limit reached");
    const requestId = randomUUID();
    const frame = JSON.stringify({ ...payload, requestId, deadlineAt: Date.now() + timeoutMs }) + "\n";
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Core business request timed out: ${String(payload.operation ?? "unknown")}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: data => resolve(data as T),
        reject,
        timer,
      });
      this.transport.stdin.write(frame, err => {
        if (!err) return;
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        reject(err);
      });
    });
  }

  async upsertNote(input: {
    commandId: string;
    entityId: string;
    title: string;
    body?: Record<string, unknown>;
    expectedRevision?: number;
    ownerGeneration?: string;
  }): Promise<Record<string, unknown>> {
    return await this.request({
      operation: "coreCommand",
      command: "upsertNote",
      commandId: input.commandId,
      entityId: input.entityId,
      title: input.title,
      body: input.body,
      expectedRevision: input.expectedRevision,
      ownerGeneration: input.ownerGeneration,
    });
  }

  async deleteNote(input: {
    commandId: string;
    entityId: string;
    expectedRevision?: number;
    ownerGeneration?: string;
  }): Promise<Record<string, unknown>> {
    return await this.request({
      operation: "coreCommand",
      command: "deleteNote",
      commandId: input.commandId,
      entityId: input.entityId,
      expectedRevision: input.expectedRevision,
      ownerGeneration: input.ownerGeneration,
    });
  }

  async setEventRetention(limit: number): Promise<{ retentionLimit: number; minAvailableSeq: number }> {
    return await this.request({ operation: "coreEventsRetention", limit });
  }

  async setExecutionSlotsLimit(limit: number): Promise<{ slotsLimit: number }> {
    return await this.request({ operation: "coreCommand", command: "setExecutionSlotsLimit", limit });
  }

  async workScheduler<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T> {
    return await this.request({ operation: "coreWorkScheduler", ...command });
  }

  async cronScheduler<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T> {
    return await this.request({ operation: "coreCronScheduler", ...command });
  }

  async dotsScheduler<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T> {
    return await this.request({ operation: "coreDotsScheduler", ...command });
  }

  async gatewayScheduler<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T> {
    return await this.request({ operation: "coreGatewayScheduler", ...command });
  }

  async remoteControl<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T> {
    return await this.request({ operation: "coreRemoteControl", ...command });
  }

  async gadgetHost<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T> {
    return await this.request({ operation: "coreGadgetHost", ...command });
  }

  async piHost<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T> {
    return await this.request({ operation: "corePiHost", ...command });
  }

  async eventsSnapshot(domain?: string): Promise<CoreEventsSnapshot> {
    return await this.request({ operation: "coreEventsSnapshot", ...(domain ? { domain } : {}) });
  }

  async eventsReplay(afterSeq: number, coreGeneration: string, limit?: number): Promise<CoreEventsReplay> {
    return await this.request({
      operation: "coreEventsReplay",
      afterSeq,
      coreGeneration,
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  async subscribeCursor(coreGeneration: string, afterSeq: number): Promise<{ subscribed: boolean }> {
    return await this.request({
      operation: "coreSubscribe",
      action: "subscribe",
      coreGeneration,
      afterSeq,
    });
  }

  /** Atomic snapshot + deduplicated replay + live subscription with automatic gap resync. */
  async openEventSubscription(options: {
    domain?: string;
    onSnapshot?: (snapshot: CoreEventsSnapshot) => void;
    onEvent?: (event: CoreDomainEvent) => void;
    onResync?: (snapshot: CoreEventsSnapshot, reason: string) => void;
  }): Promise<{
    initialSnapshot: CoreEventsSnapshot;
    getCursor(): { coreGeneration: string; lastSeq: number };
    replayFrom(afterSeq: number, coreGeneration?: string): Promise<{ resynced: boolean; events: CoreDomainEvent[] }>;
    close(): Promise<void>;
  }> {
    let snapshot = await this.eventsSnapshot(options.domain);
    let currentGen = snapshot.coreGeneration;
    let lastSeq = snapshot.headSeq;
    options.onSnapshot?.(snapshot);

    const deliver = (event: CoreDomainEvent) => {
      if (event.coreGeneration !== currentGen || event.seq <= lastSeq) return;
      const key = `${event.coreGeneration}:${event.seq}`;
      if (this.seenEvents.has(key)) return;
      this.seenEvents.add(key);
      if (this.seenEvents.size > 4_096) {
        const oldest = this.seenEvents.values().next().value;
        if (oldest) this.seenEvents.delete(oldest);
      }
      lastSeq = event.seq;
      options.onEvent?.(event);
    };

    const offLive = this.onCoreEvent(deliver);
    await this.subscribeCursor(currentGen, lastSeq);

    const replayFrom = async (afterSeq: number, gen = currentGen): Promise<{ resynced: boolean; events: CoreDomainEvent[] }> => {
      const collected: CoreDomainEvent[] = [];
      let cursor = afterSeq;
      for (;;) {
        const page = await this.eventsReplay(cursor, gen);
        if (page.gap) {
          snapshot = await this.eventsSnapshot(options.domain);
          currentGen = snapshot.coreGeneration;
          lastSeq = snapshot.headSeq;
          await this.subscribeCursor(currentGen, lastSeq);
          options.onResync?.(snapshot, page.reason ?? "gap");
          return { resynced: true, events: collected };
        }
        for (const ev of page.events) {
          deliver(ev);
          collected.push(ev);
          cursor = Math.max(cursor, ev.seq);
        }
        if (!page.hasMore || page.events.length === 0) {
          return { resynced: false, events: collected };
        }
      }
    };

    return {
      initialSnapshot: snapshot,
      getCursor: () => ({ coreGeneration: currentGen, lastSeq }),
      replayFrom,
      close: async () => {
        offLive();
        if (!this.closed) {
          await this.request({ operation: "coreSubscribe", action: "unsubscribe" }).catch(() => undefined);
        }
      },
    };
  }

  async submitExecution(input: {
    executionId: string;
    idempotencyKey: string;
    taskId: string;
    kind: string;
    payload?: Record<string, unknown>;
    ownerGeneration?: string;
  }): Promise<{ status: string; deduplicated?: boolean; coreGeneration?: string; execution?: CoreExecutionRecord; code?: string }> {
    return await this.request({
      operation: "coreExecution",
      action: "submit",
      ...input,
    });
  }

  async pauseExecution(executionId: string, expectedRevision?: number): Promise<{ status: string; execution?: CoreExecutionRecord; code?: string }> {
    return await this.request({ operation: "coreExecution", action: "pause", executionId, expectedRevision });
  }

  async cancelExecution(executionId: string, expectedRevision?: number): Promise<{ status: string; execution?: CoreExecutionRecord; code?: string }> {
    return await this.request({ operation: "coreExecution", action: "cancel", executionId, expectedRevision });
  }

  async resumeExecution(executionId: string, expectedRevision?: number): Promise<{ status: string; execution?: CoreExecutionRecord; code?: string }> {
    return await this.request({ operation: "coreExecution", action: "resume", executionId, expectedRevision });
  }

  async executionStatus(executionId: string): Promise<{ status: string; coreGeneration: string; execution: CoreExecutionRecord | null }> {
    return await this.request({ operation: "coreExecution", action: "status", executionId });
  }

  async reconcileExecution(input: {
    executionId: string;
    status: "completed" | "failed" | "cancelled" | "paused" | "unknown" | "waiting_executor";
    expectedRevision?: number;
    attempt?: number;
    result?: unknown;
    errorMessage?: string;
  }): Promise<{ status: string; execution?: CoreExecutionRecord; code?: string }> {
    return await this.request({ operation: "coreExecution", action: "reconcile", ...input });
  }

  async executorAck(executionId: string, attempt: number, ownerGeneration?: string, hostGeneration?: string): Promise<Record<string, unknown>> {
    return await this.request({
      operation: "coreExecution",
      action: "executorAck",
      executionId,
      attempt,
      ownerGeneration,
      ...(hostGeneration ? { hostGeneration } : {}),
    });
  }

  async executorProgress(executionId: string, attempt: number, progress: unknown, ownerGeneration?: string, hostGeneration?: string): Promise<Record<string, unknown>> {
    return await this.request({
      operation: "coreExecution",
      action: "executorProgress",
      executionId,
      attempt,
      progress,
      ownerGeneration,
      ...(hostGeneration ? { hostGeneration } : {}),
    });
  }

  async executorSettled(input: {
    executionId: string;
    attempt: number;
    status: "completed" | "failed" | "cancelled" | "paused" | "unknown";
    result?: unknown;
    errorMessage?: string;
    ownerGeneration?: string;
    hostGeneration?: string;
  }): Promise<Record<string, unknown>> {
    return await this.request({ operation: "coreExecution", action: "executorSettled", ...input });
  }

  async assistantLifecycle(
    action: "get" | "activate" | "configure" | "stop",
    options?: { residentEnabled?: boolean; autostartEnabled?: boolean; reason?: string },
  ): Promise<{ status: string; state: CoreLifecycleStateDto; coreStatus?: CoreStatusDto | null }> {
    return await this.request({
      operation: "assistantLifecycle",
      action,
      residentEnabled: options?.residentEnabled,
      autostartEnabled: options?.autostartEnabled,
      reason: options?.reason,
    });
  }

  /** Closes only this client's TCP socket without stopping Core or other connected roles. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.handleClose();
    this.transport.kill();
  }

  private onData(chunk: Buffer): void {
    this.buffered += chunk.toString("utf8");
    for (;;) {
      const nl = this.buffered.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffered.slice(0, nl).trim();
      this.buffered = this.buffered.slice(nl + 1);
      if (!line) continue;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(line) as Record<string, unknown>; }
      catch { continue; }
      if (frame.coreEvent && typeof frame.coreEvent === "object") {
        const ev = frame.coreEvent as CoreDomainEvent;
        for (const fn of this.eventListeners) fn(ev);
        continue;
      }
      if (frame.coreExecutionDispatch && typeof frame.coreExecutionDispatch === "object") {
        const dispatch = frame.coreExecutionDispatch as CoreExecutionDispatch;
        for (const fn of this.dispatchListeners) fn(dispatch);
        continue;
      }
      const replyId = typeof frame.replyId === "string" ? frame.replyId : undefined;
      if (!replyId) continue;
      const entry = this.pending.get(replyId);
      if (!entry) continue;
      this.pending.delete(replyId);
      clearTimeout(entry.timer);
      if (frame.status === "ok") entry.resolve(frame.data);
      else entry.reject(new Error(String(frame.error ?? frame.errorCode ?? frame.code ?? "Core business error")));
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CoreBusinessClient connection closed"));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
