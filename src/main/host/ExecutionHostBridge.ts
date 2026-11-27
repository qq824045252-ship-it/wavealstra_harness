import { randomUUID } from "node:crypto";
import type { AgentPromptRequest, AgentPromptResult, AgentSubmissionReceipt } from "../../shared/agent-ipc";
import { CoreBusinessClient, type CoreDomainEvent, type CoreExecutionDispatch } from "../platform/core-business-client";

export interface ExecutionBridgeRunner {
  start(
    dispatch: CoreExecutionDispatch,
    helpers: {
      reportProgress(progress: unknown, opts?: { ephemeral?: boolean }): Promise<void>;
    },
  ): Promise<{ status: "completed" | "failed" | "cancelled" | "paused" | "unknown"; result?: unknown; errorMessage?: string }>;
  cancel?(executionId: string, taskId: string): Promise<void>;
  pause?(executionId: string, taskId: string): Promise<void>;
}

type ExecutionSettlement = Awaited<ReturnType<ExecutionBridgeRunner["start"]>>;

interface ActiveExecution {
  client: CoreBusinessClient;
  attempt: number;
  settle(result: ExecutionSettlement): Promise<void>;
  control?: Promise<void>;
}

const MAX_PENDING_DURABLE_PROGRESS = 192;
const MAX_IN_FLIGHT_DELTAS = 192;
const DURABLE_RETRY_DELAYS_MS = [0, 50, 150];

export class DurableProgressDeliveryError extends Error {
  constructor(message: string, readonly causeError?: unknown) {
    super(message);
    this.name = "DurableProgressDeliveryError";
  }
}

/** The host supplies source sequence numbers. Core orders live deltas and fences completion.
 * Durable events remain barriers so tools and lifecycle changes cannot overtake earlier text. */
class ExecutionProgressStream {
  private readonly inFlight = new Set<Promise<void>>();
  private durableTail?: Promise<void>;
  private durableQueued = 0;
  private failure?: Error;
  private sealed = false;
  private closed = false;
  private sequence = 0;

  constructor(private readonly send: (progress: unknown, progressId?: string, streamSeq?: number) => Promise<void>) {}

  get lastStreamSeq(): number { return this.sequence; }

  report(progress: unknown, ephemeral = false): Promise<void> {
    if (this.closed || this.sealed) return Promise.reject(new DurableProgressDeliveryError("Execution progress stream is closed"));
    if (this.failure) return Promise.reject(this.failure);
    if (ephemeral) {
      if (this.inFlight.size >= MAX_IN_FLIGHT_DELTAS) return this.overloaded("Live");
      const seq = ++this.sequence;
      const dispatch = () => this.send(progress, undefined, seq);
      const sent = this.durableTail ? this.durableTail.then(dispatch) : dispatch();
      this.inFlight.add(sent);
      void sent.then(() => this.inFlight.delete(sent), error => {
        this.inFlight.delete(sent);
        this.failure ??= error;
      });
      // Admission of the next delta does not depend on this transport reply.
      return Promise.resolve();
    }

    if (this.durableQueued >= MAX_PENDING_DURABLE_PROGRESS) return this.overloaded("Durable");
    this.durableQueued++;
    const id = randomUUID();
    const barrier = Promise.all([...this.inFlight, this.durableTail]);
    const task = barrier.then(() => this.sendDurableWithRetry(progress, id));
    this.durableTail = task;
    void task.then(() => {
      this.durableQueued--;
      if (this.durableTail === task) this.durableTail = undefined;
    }, error => {
      this.durableQueued--;
      this.failure ??= error;
    });
    return task;
  }

  private overloaded(kind: string): Promise<never> {
    this.failure = new DurableProgressDeliveryError(kind + " progress overloaded");
    return Promise.reject(this.failure);
  }

  private async sendDurableWithRetry(progress: unknown, progressId: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < DURABLE_RETRY_DELAYS_MS.length; attempt++) {
      const delayMs = DURABLE_RETRY_DELAYS_MS[attempt]!;
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      if (this.closed) {
        throw new DurableProgressDeliveryError("Execution progress stream closed before durable progress confirmation", lastError);
      }
      try {
        await this.send(progress, progressId);
        return;
      } catch (err) {
        if (err instanceof DurableProgressDeliveryError) throw err;
        lastError = err;
      }
    }
    throw new DurableProgressDeliveryError(
      `Durable progress delivery failed after ${DURABLE_RETRY_DELAYS_MS.length} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      lastError,
    );
  }

  async seal(): Promise<void> {
    this.sealed = true;
    await this.durableTail;
    if (this.failure) throw this.failure;
  }

  async confirmPending(): Promise<void> {
    await Promise.all(this.inFlight);
    if (this.failure) throw this.failure;
  }

  close(): void { this.closed = true; }
}

export interface DurableExecutionTarget {
  submit(request: AgentPromptRequest): Promise<AgentPromptResult>;
  submitCron?(request: AgentPromptRequest): Promise<AgentPromptResult>;
  waitForSubmission?(receipt: AgentSubmissionReceipt): Promise<AgentPromptResult>;
  abort(taskId: string): Promise<unknown> | unknown;
  stopObservedRun?(taskId: string): Promise<unknown> | unknown;
  findSubmission(taskId: string, operationId: string): Promise<AgentPromptResult | undefined>;
  isTaskBusy?(taskId: string): boolean;
  resolveAvailableModelId?(id: string): Promise<{ modelId: string } | undefined>;
  dotsSubmission?(taskId: string, operation: string): Promise<{ text: string } | undefined>;
  runDotsControlCycle?(cycleKey: string): Promise<void>;
  runGatewayControlCycle?(cycle: string, channelId: string, extra?: Record<string, unknown>): Promise<void>;
}

/** Transitional adapter routing Core execution slots to Main's existing DurableBotService. */
export function createDurableBotExecutionRunner(target: DurableExecutionTarget): ExecutionBridgeRunner {
  return {
    async start(dispatch) {
      if (dispatch.execution.executionId.startsWith("gw-ctrl-") || "gatewayControlCycle" in dispatch.execution.payload) {
        const gwPayload = dispatch.execution.payload as {
          gatewayControlCycle?: string;
          channelId?: string;
          extra?: Record<string, unknown>;
        };
        if (!gwPayload.gatewayControlCycle || !gwPayload.channelId) {
          return { status: "failed", errorMessage: "INVALID_GATEWAY_CONTROL_PAYLOAD" };
        }
        if (!target.runGatewayControlCycle) {
          return {
            status: "failed",
            errorMessage: "CAPABILITY_UNAVAILABLE: runGatewayControlCycle is not registered on this host",
          };
        }
        await target.runGatewayControlCycle(gwPayload.gatewayControlCycle, gwPayload.channelId, gwPayload.extra);
        return { status: "completed", result: { cycle: gwPayload.gatewayControlCycle, channelId: gwPayload.channelId } };
      }
      if (dispatch.execution.executionId.startsWith("dots-ctrl-") || "dotsControlCycle" in dispatch.execution.payload) {
        const cycleKey = String((dispatch.execution.payload as { dotsControlCycle?: string }).dotsControlCycle ?? "").trim();
        if (!cycleKey) {
          return { status: "failed", errorMessage: "INVALID_DOTS_CONTROL_PAYLOAD" };
        }
        if (!target.runDotsControlCycle) {
          return {
            status: "failed",
            errorMessage: "CAPABILITY_UNAVAILABLE: runDotsControlCycle is not registered on this host",
          };
        }
        await target.runDotsControlCycle(cycleKey);
        return { status: "completed", result: { cycleKey } };
      }
      if (dispatch.execution.executionId.startsWith("cron-exec-") || "cronRunId" in dispatch.execution.payload) {
        const cronPayload = dispatch.execution.payload as {
          request?: AgentPromptRequest;
          targetTaskId?: string | null;
          queueInDots?: boolean;
          isDots?: boolean;
          requestedModelId?: string | null;
        };
        const req = cronPayload.request;
        if (!req) return { status: "failed", errorMessage: "Cron execution missing request payload" };
        if (cronPayload.targetTaskId && !cronPayload.queueInDots && target.isTaskBusy?.(cronPayload.targetTaskId)) {
          return { status: "completed", result: { skippedBusy: true } };
        }
        let nextReq = req;
        if (cronPayload.requestedModelId && !cronPayload.targetTaskId && target.resolveAvailableModelId) {
          const resolved = await target.resolveAvailableModelId(cronPayload.requestedModelId).catch(() => undefined);
          if (resolved?.modelId) nextReq = { ...req, modelId: resolved.modelId };
        }
        const submitFn = target.submitCron ?? target.submit;
        const accepted = await submitFn(nextReq);
        if (accepted.cancelled) return { status: "cancelled" };
        if (accepted.error) return { status: "failed", errorMessage: accepted.error.message };
        if (!accepted.receipt) return { status: "failed", errorMessage: "执行服务未返回持久回执" };
        const settled = target.waitForSubmission ? await target.waitForSubmission(accepted.receipt) : accepted;
        if (settled.cancelled) return { status: "cancelled" };
        if (settled.error) return { status: "failed", errorMessage: settled.error.message };
        if (settled.receipt?.status === "unanswered") {
          return { status: "unknown", result: settled.receipt };
        }
        if (settled.queued || settled.receipt?.status !== "done") {
          return { status: "failed", errorMessage: "该次输入尚未完成" };
        }
        const dotsMessage = cronPayload.isDots && nextReq.userMessageId
          ? (await target.dotsSubmission?.(nextReq.taskId, nextReq.userMessageId).catch(() => undefined))?.text
          : undefined;
        return {
          status: "completed",
          result: { receipt: settled.receipt, ...(dotsMessage ? { dotsMessage } : {}) },
        };
      }
      const payload = dispatch.execution.payload as Partial<AgentPromptRequest> & { prompt?: string; text?: string };
      const existing = await target.findSubmission(dispatch.execution.taskId, dispatch.execution.idempotencyKey).catch(() => undefined);
      if (existing?.receipt && (existing.receipt.status === "done" || existing.receipt.status === "unanswered")) {
        return {
          status: existing.receipt.status === "done" ? "completed" : "unknown",
          result: existing.receipt,
        };
      }
      const promptText = typeof payload.text === "string"
        ? payload.text
        : (typeof payload.prompt === "string" ? payload.prompt : "");
      const submitted = await target.submit({
        taskId: dispatch.execution.taskId,
        userMessageId: dispatch.execution.idempotencyKey,
        text: promptText,
        prompt: promptText,
        ...payload,
      } as AgentPromptRequest);
      if (submitted.cancelled) return { status: "cancelled" };
      if (submitted.error) return { status: "failed", errorMessage: submitted.error.message };
      const settled = submitted.receipt && target.waitForSubmission
        ? await target.waitForSubmission(submitted.receipt)
        : submitted;
      if (settled.cancelled) return { status: "cancelled" };
      if (settled.error) return { status: "failed", errorMessage: settled.error.message };
      if (settled.receipt?.status === "unanswered") {
        return { status: "unknown", result: settled.receipt };
      }
      return { status: "completed", result: settled.receipt };
    },
    async cancel(_executionId, taskId) {
      await target.abort(taskId);
    },
    async pause(_executionId, taskId) {
      if (target.stopObservedRun) await target.stopObservedRun(taskId);
      else await target.abort(taskId);
    },
  };
}

/** Holds the `execution-host` role connection to Rust Core and drives active dispatches. */
export class ExecutionHostBridge {
  private client?: CoreBusinessClient;
  private disposed = false;
  private reconnecting = false;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly eventListeners = new Set<(event: CoreDomainEvent) => void>();
  private readonly reconnectListeners = new Set<(client: CoreBusinessClient) => Promise<void> | void>();

  constructor(
    private readonly executable: string,
    private readonly dbPath: string,
    private readonly dataDirectory: string,
    private readonly runner: ExecutionBridgeRunner,
    private readonly clientId = `exec-host-${process.pid}`,
    private readonly hostGeneration = process.env.MYBUDDY_PI_HOST_GENERATION || undefined,
  ) {}

  get connection(): CoreBusinessClient | undefined {
    return this.client;
  }

  getClient(): CoreBusinessClient | undefined {
    return this.client;
  }

  onReconnected(listener: (client: CoreBusinessClient) => Promise<void> | void): () => void {
    this.reconnectListeners.add(listener);
    return () => { this.reconnectListeners.delete(listener); };
  }

  onCoreEvent(listener: (event: CoreDomainEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  async connect(): Promise<CoreBusinessClient> {
    if (this.disposed) throw new Error("ExecutionHostBridge disposed");
    const client = await CoreBusinessClient.connect(this.executable, this.dbPath, {
      dataDirectory: this.dataDirectory,
      role: "execution-host",
      clientId: this.clientId,
    });
    this.client = client;
    client.onExecutionDispatch(dispatch => { void this.handleDispatch(client, dispatch); });
    client.onClose(() => {
      if (this.client === client) {
        this.client = undefined;
      }
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    });
    await client.openEventSubscription({
      onEvent: ev => {
        for (const listener of this.eventListeners) listener(ev);
      },
    }).catch(() => undefined);
    return client;
  }

  private scheduleReconnect(attempt = 0): void {
    if (this.disposed || this.reconnecting) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const delayMs = attempt === 0 ? 200 : Math.min(3_000, 200 * Math.pow(2, attempt - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      this.reconnecting = true;
      void this.connect()
        .then(async reconnectedClient => {
          this.reconnecting = false;
          for (const listener of this.reconnectListeners) {
            await listener(reconnectedClient);
          }
        })
        .catch(() => {
          this.reconnecting = false;
          if (!this.disposed) {
            this.scheduleReconnect(Math.min(attempt + 1, 6));
          }
        });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async handleDispatch(client: CoreBusinessClient, dispatch: CoreExecutionDispatch): Promise<void> {
    const exec = dispatch.execution;
    const current = this.active.get(exec.executionId);
    if (dispatch.action !== "start") {
      if (!current || current.client !== client || current.attempt !== exec.attempt) return;
      const action = dispatch.action;
      const control = Promise.resolve().then(async () => {
        let result: ExecutionSettlement = { status: action === "cancel" ? "cancelled" : "paused" };
        try {
          await this.runner[action]?.(exec.executionId, exec.taskId);
        } catch (error) {
          result = { status: "unknown", errorMessage: error instanceof Error ? error.message : String(error) };
        }
        if (current.control !== control) return;
        await current.settle(result);
      });
      current.control = control;
      await control;
      return;
    }
    if (current) return;
    const progressStream = new ExecutionProgressStream(async (progress, progressId, streamSeq) => {
      if (client.isClosed) throw new DurableProgressDeliveryError("Core disconnected before progress confirmation");
      const reply = await client.executorProgress(
        exec.executionId, exec.attempt, progress, exec.ownerGeneration, this.hostGeneration,
        progressId ? { progressId } : { ephemeral: true, streamSeq },
      );
      if (reply.status !== "ok") {
        throw new DurableProgressDeliveryError(`Core rejected execution progress: ${String(reply.code ?? reply.status)}`);
      }
    });
    const active: ActiveExecution = {
      client,
      attempt: exec.attempt,
      settle: async result => {
        const control = active.control;
        try {
          await progressStream.seal();
          if (result.status !== "completed") await progressStream.confirmPending();
        } catch (error) {
          result = { status: "unknown", errorMessage: error instanceof Error ? error.message : String(error) };
        }
        if (client.isClosed || active.control !== control || this.active.get(exec.executionId) !== active) return;
        try {
          const settle = (outcome: ExecutionSettlement) => client.executorSettled({
            executionId: exec.executionId,
            attempt: exec.attempt,
            ...outcome,
            lastStreamSeq: progressStream.lastStreamSeq,
            ownerGeneration: exec.ownerGeneration,
            hostGeneration: this.hostGeneration,
          });
          let reply = await settle(result);
          if (reply.code === "STREAM_SEQUENCE_GAP") {
            // A settlement can reach Core before the last frame. Only a Core-confirmed
            // gap requires waiting for outstanding sends and retrying the boundary.
            try {
              await progressStream.confirmPending();
              if (active.control !== control || client.isClosed) return;
              reply = await settle(result);
            } catch (error) {
              result = { status: "unknown", errorMessage: String(error) };
            }
            if (reply.code === "STREAM_SEQUENCE_GAP" && active.control === control && !client.isClosed) {
              reply = await settle({ status: "unknown", errorMessage: result.errorMessage ?? "Core could not confirm the complete execution stream" });
            }
          }
          if (reply.status !== "ok") {
            console.warn("[ExecutionHostBridge] Core rejected settlement:", reply.code ?? reply.status);
            return;
          }
          this.active.delete(exec.executionId);
        } catch (error) {
          console.error("[ExecutionHostBridge] settlement reply failed:", error instanceof Error ? error.message : String(error));
        }
      },
    };
    this.active.set(exec.executionId, active);
    try {
      const ack = await client.executorAck(exec.executionId, exec.attempt, exec.ownerGeneration, this.hostGeneration);
      if (ack.status !== "ok" || this.active.get(exec.executionId) !== active) return;
      if (!active.control) {
        let result: ExecutionSettlement;
        try {
          result = await this.runner.start(dispatch, {
            reportProgress: (progress, opts) => progressStream.report(progress, opts?.ephemeral === true),
          });
        } catch (error) {
          result = { status: "failed", errorMessage: error instanceof Error ? error.message : String(error) };
        }
        if (!active.control) await active.settle(result);
      }
      let control: Promise<void> | undefined;
      do {
        control = active.control;
        await control;
      } while (control !== active.control);
    } catch (error) {
      console.error("[ExecutionHostBridge] dispatch failed:", error instanceof Error ? error.stack || error.message : String(error));
    } finally {
      progressStream.close();
      if (this.active.get(exec.executionId) === active) this.active.delete(exec.executionId);
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.client?.close();
    this.client = undefined;
  }
}
