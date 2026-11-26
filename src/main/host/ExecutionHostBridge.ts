import type { AgentPromptRequest, AgentPromptResult, AgentSubmissionReceipt } from "../../shared/agent-ipc";
import { CoreBusinessClient, type CoreDomainEvent, type CoreExecutionDispatch } from "../platform/core-business-client";

export interface ExecutionBridgeRunner {
  start(
    dispatch: CoreExecutionDispatch,
    helpers: {
      reportProgress(progress: unknown): Promise<void>;
    },
  ): Promise<{ status: "completed" | "failed" | "cancelled" | "paused" | "unknown"; result?: unknown; errorMessage?: string }>;
  cancel?(executionId: string, taskId: string): Promise<void>;
  pause?(executionId: string, taskId: string): Promise<void>;
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
        if (gwPayload.gatewayControlCycle && gwPayload.channelId && target.runGatewayControlCycle) {
          await target.runGatewayControlCycle(gwPayload.gatewayControlCycle, gwPayload.channelId, gwPayload.extra);
        }
        return { status: "completed", result: { cycle: gwPayload.gatewayControlCycle, channelId: gwPayload.channelId } };
      }
      if (dispatch.execution.executionId.startsWith("dots-ctrl-") || "dotsControlCycle" in dispatch.execution.payload) {
        const cycleKey = String((dispatch.execution.payload as { dotsControlCycle?: string }).dotsControlCycle ?? "");
        if (cycleKey && target.runDotsControlCycle) {
          await target.runDotsControlCycle(cycleKey);
        }
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
      const payload = dispatch.execution.payload as Partial<AgentPromptRequest> & { prompt?: string };
      const existing = await target.findSubmission(dispatch.execution.taskId, dispatch.execution.idempotencyKey).catch(() => undefined);
      if (existing?.receipt && (existing.receipt.status === "done" || existing.receipt.status === "unanswered")) {
        return {
          status: existing.receipt.status === "done" ? "completed" : "unknown",
          result: existing.receipt,
        };
      }
      const submitted = await target.submit({
        taskId: dispatch.execution.taskId,
        userMessageId: dispatch.execution.idempotencyKey,
        prompt: typeof payload.prompt === "string" ? payload.prompt : "",
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
  private readonly active = new Set<string>();
  private readonly eventListeners = new Set<(event: CoreDomainEvent) => void>();

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
    await client.openEventSubscription({
      onEvent: ev => {
        for (const listener of this.eventListeners) listener(ev);
      },
    }).catch(() => undefined);
    return client;
  }

  private async handleDispatch(client: CoreBusinessClient, dispatch: CoreExecutionDispatch): Promise<void> {
    const exec = dispatch.execution;
    if (dispatch.action === "cancel") {
      await this.runner.cancel?.(exec.executionId, exec.taskId).catch(() => undefined);
      if (!client.isClosed && this.active.has(exec.executionId)) {
        await client.executorSettled({
          executionId: exec.executionId,
          attempt: exec.attempt,
          status: "cancelled",
          ownerGeneration: exec.ownerGeneration,
          hostGeneration: this.hostGeneration,
        }).catch(() => undefined);
        this.active.delete(exec.executionId);
      }
      return;
    }
    if (dispatch.action === "pause") {
      await this.runner.pause?.(exec.executionId, exec.taskId).catch(() => undefined);
      if (!client.isClosed && this.active.has(exec.executionId)) {
        await client.executorSettled({
          executionId: exec.executionId,
          attempt: exec.attempt,
          status: "paused",
          ownerGeneration: exec.ownerGeneration,
          hostGeneration: this.hostGeneration,
        }).catch(() => undefined);
        this.active.delete(exec.executionId);
      }
      return;
    }
    if (this.active.has(exec.executionId)) return;
    this.active.add(exec.executionId);
    try {
      const ack = await client.executorAck(exec.executionId, exec.attempt, exec.ownerGeneration, this.hostGeneration);
      if (ack.status === "rejected") return;
      const settled = await this.runner.start(dispatch, {
        reportProgress: async progress => {
          if (client.isClosed) return;
          await client.executorProgress(exec.executionId, exec.attempt, progress, exec.ownerGeneration, this.hostGeneration);
        },
      });
      if (!client.isClosed) {
        await client.executorSettled({
          executionId: exec.executionId,
          attempt: exec.attempt,
          status: settled.status,
          result: settled.result,
          errorMessage: settled.errorMessage,
          ownerGeneration: exec.ownerGeneration,
          hostGeneration: this.hostGeneration,
        });
      }
    } catch (error) {
      console.error("[ExecutionHostBridge] dispatch failed:", error instanceof Error ? error.stack || error.message : String(error));
      if (!client.isClosed) {
        await client.executorSettled({
          executionId: exec.executionId,
          attempt: exec.attempt,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
          ownerGeneration: exec.ownerGeneration,
          hostGeneration: this.hostGeneration,
        }).catch(() => undefined);
      }
    } finally {
      this.active.delete(exec.executionId);
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    await this.client?.close();
    this.client = undefined;
  }
}
