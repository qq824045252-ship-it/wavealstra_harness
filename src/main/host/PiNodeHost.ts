import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AgentDeleteUserMessageRequest,
  AgentPromptRequest,
  AgentRegenerateRequest,
  AgentSubmissionReceipt,
  AgentUiPatch,
} from "../../shared/agent-ipc";
import { DOTS_TASK_ID } from "../../shared/dots";
import { AgentService, type AgentTaskLifecycleEvent } from "../agent/AgentService";
import { AppDatabase } from "../db/AppDatabase";
import { getMyBuddyDir } from "../paths";
import type { CoreBusinessClient, CoreExecutionDispatch } from "../platform/core-business-client";
import type { TaskExecutionWorkspace } from "../task/TaskExecutionWorkspace";
import {
  ExecutionHostBridge,
  createDurableBotExecutionRunner,
  type ExecutionBridgeRunner,
} from "./ExecutionHostBridge";
import { assertExpectedPiVersion } from "./pi-version";

export interface PiNodeHostOptions {
  hostId?: string;
  hostGeneration?: string;
  dataDirectory?: string;
  dbPath: string;
  storageRoot?: string;
  runtimeAuditExecutable: string;
  repoRoot?: string;
  heartbeatIntervalMs?: number;
  taskWorkspace?: TaskExecutionWorkspace;
  models?: ModelRuntime;
}

interface ActiveProgressReporter {
  reportProgress(progress: unknown): Promise<void>;
}

/**
 * Isolated standalone Pi Node Host process controller (`RC-20`..`RC-22`).
 *
 * Owns `ModelRuntime`, `DurableBotService`, `SummaryBudget` compaction, MCP, and Subagent
 * execution outside Electron Main while opening `app.db` strictly read-only.
 */
export class PiNodeHost {
  readonly hostId: string;
  readonly hostGeneration: string;
  readonly dataDirectory: string;
  readonly storageRoot: string;
  private db?: AppDatabase;
  private agentService?: AgentService;
  private bridge?: ExecutionHostBridge;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private offPatch?: () => void;
  private closed = false;
  private readonly reportersByTask = new Map<string, Set<ActiveProgressReporter>>();

  constructor(private readonly options: PiNodeHostOptions) {
    this.hostId = options.hostId?.trim() || `pi-host-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.hostGeneration = options.hostGeneration?.trim() || `pi-gen-${Date.now()}-${process.pid}`;
    this.dataDirectory = options.dataDirectory?.trim() || getMyBuddyDir();
    this.storageRoot = options.storageRoot?.trim() || join(this.dataDirectory, "durable-bots");
  }

  getAgentService(): AgentService | undefined {
    return this.agentService;
  }

  getClient(): CoreBusinessClient | undefined {
    return this.bridge?.connection;
  }

  private trackTaskReporter(taskId: string, reporter: ActiveProgressReporter): () => void {
    let set = this.reportersByTask.get(taskId);
    if (!set) {
      set = new Set();
      this.reportersByTask.set(taskId, set);
    }
    set.add(reporter);
    return () => {
      set?.delete(reporter);
      if (set?.size === 0) this.reportersByTask.delete(taskId);
    };
  }

  private pushProgressToTask(taskId: string, progress: unknown): void {
    const reporters = this.reportersByTask.get(taskId);
    if (!reporters?.size) return;
    for (const reporter of reporters) {
      void reporter.reportProgress(progress).catch(() => undefined);
    }
  }

  async start(): Promise<{ hostId: string; hostGeneration: string; piVersion: string; pid: number }> {
    if (this.closed) throw new Error("PiNodeHost has been closed");
    const { expected, actual } = assertExpectedPiVersion(this.options.repoRoot);

    this.db = await AppDatabase.open(this.options.dbPath, {
      runtimeAuditExecutable: this.options.runtimeAuditExecutable,
      runtimeAuditSupervised: true,
      readonly: true,
    });

    const agent = new AgentService(this.db, this.options.taskWorkspace, {
      models: this.options.models,
      executionMode: "host",
    });
    this.agentService = agent;
    await agent.init();
    await agent.resumePersistedTasks();

    this.offPatch = agent.onPatch((patch: AgentUiPatch) => {
      if ("taskId" in patch && typeof patch.taskId === "string") {
        this.pushProgressToTask(patch.taskId, { kind: "ui_patch", patch });
      }
    });
    agent.setTaskLifecycleListener((event: AgentTaskLifecycleEvent) => {
      this.pushProgressToTask(event.taskId, { kind: "task_lifecycle", event });
    });

    const baseRunner = createDurableBotExecutionRunner({
      submit: req => agent.prompt(req, { durableAdmissionOnly: true }),
      submitCron: req => agent.prompt(req),
      waitForSubmission: receipt => agent.waitForSubmission(receipt),
      abort: id => agent.abort(id),
      stopObservedRun: id => agent.stopDotsTarget(id),
      findSubmission: (id, op) => agent.findSubmission(id, op),
      isTaskBusy: id => agent.isTaskBusy(id),
      resolveAvailableModelId: id => agent.resolveAvailableModelId(id),
      dotsSubmission: (id, op) => agent.dotsSubmission(id, op),
    });

    const runner: ExecutionBridgeRunner = {
      start: async (dispatch: CoreExecutionDispatch, helpers) => {
        const taskId = dispatch.execution.taskId;
        const untrack = this.trackTaskReporter(taskId, helpers);
        try {
          if (dispatch.execution.kind === "pi_turn") {
            return await this.runPiTurnDispatch(agent, dispatch, helpers);
          }
          if (dispatch.execution.kind === "pi_compact") {
            const outcome = await agent.compactTask(taskId);
            return { status: outcome.ok ? "completed" : "failed", result: outcome };
          }
          if (dispatch.execution.kind === "pi_control") {
            return await this.runPiControlDispatch(agent, dispatch);
          }
          return await baseRunner.start(dispatch, helpers);
        } finally {
          untrack();
        }
      },
      cancel: async (executionId, taskId) => {
        if (taskId === DOTS_TASK_ID || executionId.startsWith("dots-")) {
          await agent.abort(taskId);
          return;
        }
        await baseRunner.cancel?.(executionId, taskId);
      },
      pause: async (executionId, taskId) => {
        await baseRunner.pause?.(executionId, taskId);
      },
    };

    const bridge = new ExecutionHostBridge(
      this.options.runtimeAuditExecutable,
      this.options.dbPath,
      this.dataDirectory,
      runner,
      this.hostId,
      this.hostGeneration,
    );
    this.bridge = bridge;

    const client = await bridge.connect();
    const registration = await client.piHost<{
      accepted?: boolean;
      fenced?: boolean;
      reason?: string;
    }>({
      action: "register",
      hostId: this.hostId,
      pid: process.pid,
      hostGeneration: this.hostGeneration,
      storageRoot: this.storageRoot,
      dbPath: this.options.dbPath,
      piVersion: actual,
      expectedPiVersion: expected,
    });
    if (!registration?.accepted || registration.fenced) {
      await this.close().catch(() => undefined);
      throw new Error(`PiNodeHost registration rejected: ${registration?.reason ?? "fenced"}`);
    }

    const heartbeatMs = Math.max(500, this.options.heartbeatIntervalMs ?? 5_000);
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || client.isClosed) return;
      void client.piHost<{ accepted?: boolean; fenced?: boolean }>({
        action: "heartbeat",
        hostId: this.hostId,
        pid: process.pid,
        hostGeneration: this.hostGeneration,
      }).then(reply => {
        if (reply && (!reply.accepted || reply.fenced)) {
          console.warn("[PiNodeHost] Generation fenced or lost ownership; shutting down host", this.hostGeneration);
          void this.close().catch(() => undefined);
        }
      }).catch(() => undefined);
    }, heartbeatMs);
    this.heartbeatTimer.unref?.();

    return {
      hostId: this.hostId,
      hostGeneration: this.hostGeneration,
      piVersion: actual,
      pid: process.pid,
    };
  }

  private async runPiTurnDispatch(
    agent: AgentService,
    dispatch: CoreExecutionDispatch,
    helpers: ActiveProgressReporter,
  ): Promise<{ status: "completed" | "failed" | "cancelled" | "paused" | "unknown"; result?: unknown; errorMessage?: string }> {
    const payload = dispatch.execution.payload as Partial<AgentPromptRequest> & {
      prompt?: string;
      durableAdmissionOnly?: boolean;
      waitForSettled?: boolean;
    };
    const req: AgentPromptRequest = {
      taskId: dispatch.execution.taskId,
      userMessageId: payload.userMessageId ?? dispatch.execution.idempotencyKey,
      assistantMessageId: payload.assistantMessageId ?? `asst-${dispatch.execution.idempotencyKey}`,
      text: typeof payload.text === "string"
        ? payload.text
        : (typeof payload.prompt === "string" ? payload.prompt : ""),
      ...payload,
    } as AgentPromptRequest;

    const existing = await agent.findSubmission(req.taskId, req.userMessageId).catch(() => undefined);
    if (existing?.receipt) {
      await helpers.reportProgress({ kind: "submission_receipt", result: existing }).catch(() => undefined);
      if (existing.receipt.status === "done") return { status: "completed", result: existing };
      if (existing.receipt.status === "unanswered") return { status: "unknown", result: existing };
      if (payload.waitForSettled === false) return { status: "completed", result: existing };
      const settled = await agent.waitForSubmission(existing.receipt);
      return this.settledResult(settled);
    }

    const accepted = await agent.prompt(req, { durableAdmissionOnly: payload.durableAdmissionOnly ?? true });
    await helpers.reportProgress({ kind: "submission_receipt", result: accepted }).catch(() => undefined);
    if (accepted.cancelled) return { status: "cancelled", result: accepted };
    if (accepted.error) return { status: "failed", result: accepted, errorMessage: accepted.error.message };
    if (!accepted.receipt) return { status: "completed", result: accepted };
    if (payload.waitForSettled === false) return { status: "completed", result: accepted };
    const settled = await agent.waitForSubmission(accepted.receipt);
    return this.settledResult(settled);
  }

  private settledResult(settled: Awaited<ReturnType<AgentService["waitForSubmission"]>>) {
    if (settled.cancelled) return { status: "cancelled" as const, result: settled };
    if (settled.error) return { status: "failed" as const, result: settled, errorMessage: settled.error.message };
    if (settled.receipt?.status === "unanswered") return { status: "unknown" as const, result: settled };
    return { status: "completed" as const, result: settled };
  }

  private async runPiControlDispatch(
    agent: AgentService,
    dispatch: CoreExecutionDispatch,
  ): Promise<{ status: "completed" | "failed"; result?: unknown; errorMessage?: string }> {
    const payload = dispatch.execution.payload as Record<string, unknown>;
    const control = String(payload.controlAction ?? "");
    switch (control) {
      case "abort": {
        const res = await agent.abort(String(payload.taskId ?? dispatch.execution.taskId));
        return { status: "completed", result: res ?? null };
      }
      case "regenerate": {
        const res = await agent.regenerate(payload.request as AgentRegenerateRequest);
        return { status: "completed", result: res };
      }
      case "deleteUserMessage": {
        await agent.deleteUserMessage(payload.request as AgentDeleteUserMessageRequest);
        return { status: "completed", result: { ok: true } };
      }
      case "findSubmission": {
        const res = await agent.findSubmission(String(payload.taskId), String(payload.operationId));
        return { status: "completed", result: res ?? null };
      }
      case "submissionStatus": {
        const receipt = payload.receipt as AgentSubmissionReceipt;
        const res = payload.wait
          ? await agent.waitForSubmission(receipt)
          : await agent.submissionStatus(receipt);
        return { status: "completed", result: res };
      }
      case "newDotsConversation": {
        await agent.newDotsConversation();
        return { status: "completed", result: { ok: true } };
      }
      case "openDots": {
        const res = await agent.openDots();
        return { status: "completed", result: res };
      }
      case "generateTaskTitle": {
        const res = await agent.generateTaskTitle(String(payload.taskId ?? dispatch.execution.taskId), payload.maxTokens as number | undefined);
        return { status: "completed", result: res };
      }
      case "listModels": {
        const res = await agent.listModels();
        return { status: "completed", result: res };
      }
      default:
        return { status: "failed", errorMessage: `Unsupported Pi control action: ${control}` };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.offPatch?.();
    this.offPatch = undefined;
    this.reportersByTask.clear();
    await this.bridge?.close().catch(() => undefined);
    this.bridge = undefined;
    try {
      this.agentService?.dispose();
    } catch { /* ignore */ }
    await this.agentService?.closeAuditWrites().catch(() => undefined);
    this.agentService = undefined;
    await this.db?.runtimeAuditReader?.close().catch(() => undefined);
    this.db?.close();
    this.db = undefined;
  }
}
