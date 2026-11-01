import { resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { collectRuntimeMaterialEvidence } from "./RuntimeMaterialEvidence";
import type { AgentUiPatch } from "../../shared/agent-ipc";
import { mapPiEventToPatches, type MapperContext } from "../../shared/pi-event-mapper";
import type { RecordLiveInput, UsageStatsService } from "../usage/UsageStatsService";
import { PerformanceTracker } from "../usage/PerformanceTracker";
import { GenerationSpeedTracker } from "../usage/GenerationSpeedTracker";
import { activateNextAssistantTurn, type SessionEntry, SessionRegistry } from "./SessionRegistry";
import type { PendingActionRegistry } from "./PendingActionRegistry";
import type { RuntimeContextSnapshotRepository } from "./RuntimeContextSnapshotRepository";
import type { MemorySkillEffectivenessService } from "../memory/MemorySkillEffectivenessService";
import type { AgentLoadoutObservationService } from "./AgentLoadoutObservationService";
import type { SkillsService } from "../skills/SkillsService";
import type { PromptExecutionCoordinator } from "./PromptExecutionCoordinator";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import { classifyMcpToolCall } from "../security/McpSideEffectPolicy";
import type { ExecutionAttempt, ExecutionAttemptRepository } from "./ExecutionAttemptRepository";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";
import { recordPromptFailureRecovery, resolvePromptFailureRecovery } from "./PromptFailureRecovery";

export type MainSessionLifecycleEvent =
  | { kind: "completed"; taskId: string; assistantMessageId: string; durationMs?: number }
  | { kind: "failed"; taskId: string; assistantMessageId: string; error: string; durationMs?: number };

export interface SessionEventCoordinatorDependencies {
  registry: SessionRegistry;
  userTurnCounters: Map<string, number>;
  usageStats: UsageStatsService;
  pendingActions: PendingActionRegistry;
  runtimeSnapshots: RuntimeContextSnapshotRepository;
  skillEffectiveness: MemorySkillEffectivenessService;
  loadoutObservations: AgentLoadoutObservationService;
  skillsService: SkillsService;
  promptExecution: PromptExecutionCoordinator;
  executionAttempts?: ExecutionAttemptRepository;
  executionFailures?: ExecutionFailureRepository;
  emitPatch: (patch: AgentUiPatch) => void;
  emitContextUsage: (taskId: string, session: AgentSession) => void;
  compactionStateChanged?: (state: import("../../shared/compaction").TaskCompactionStatusDto) => void;
  emitLifecycle: (event: MainSessionLifecycleEvent) => void;
  applyCompactionReserve: (session: AgentSession) => void;
  finalizePendingMemoryTurn: (taskId: string, assistantMessageId: string | undefined, session: AgentSession) => void;
  deletePendingMemoryTurn: (assistantMessageId: string) => void;
  usageMessageFromEvent: (
    message: RecordLiveInput["message"] | { provider?: string | null; model?: string | null; responseModel?: string | null },
    session: AgentSession,
    myBuddyModelId?: string | null,
  ) => RecordLiveInput["message"];
  maybeEmitArtifact: (
    session: AgentSession,
    taskId: string,
    messageId: string,
    event: {
      toolName?: string;
      args?: unknown;
      input?: unknown;
      result?: unknown;
      isError?: boolean;
      toolCallId?: string;
    },
  ) => Promise<void>;
}

/**
 * Owns projection of pi session events into MyBuddy runtime state/UI/telemetry.
 * Session creation and prompt content assembly stay in AgentService; this class only subscribes
 * after a session exists and returns the unsubscribe handle stored in SessionEntry.
 */
export class SessionEventCoordinator {
  constructor(private readonly deps: SessionEventCoordinatorDependencies) {}

  attach(taskId: string, cwd: string, session: AgentSession): () => void {
    const mapperCtx: MapperContext = {
      taskId,
      messageId: "",
      startedAt: Date.now(),
    };
    const toolArgsById = new Map<string, unknown>();
    const toolExecutionById = new Map<string, ConversationExecutionContext>();
    const mcpAttemptsById = new Map<string, ExecutionAttempt>();
    const usageTracker = new PerformanceTracker();
    const generationSpeed = new GenerationSpeedTracker();
    const userTurnKey = session.sessionFile ?? taskId;
    this.deps.userTurnCounters.set(userTurnKey, 0);

    return session.subscribe((event) => {
      if (event.type === "turn_end") this.deps.applyCompactionReserve(session);

      if (event.type === "turn_start") {
        const tsIdx = (event as { turnIndex?: number }).turnIndex ?? 0;
        const tsNow = (event as { timestamp?: number }).timestamp ?? Date.now();
        usageTracker.onTurnStart(tsIdx, tsNow);
      } else if (event.type === "message_update") {
        usageTracker.onMessageUpdate(event.assistantMessageEvent?.type ?? "", Date.now());
      } else if (event.type === "message_start" && event.message.role === "user") {
        this.deps.userTurnCounters.set(
          userTurnKey,
          (this.deps.userTurnCounters.get(userTurnKey) ?? 0) + 1,
        );
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        const sample = usageTracker.onMessageEnd(Date.now(), event.message);
        if (sample) {
          try {
            this.deps.usageStats.recordLive({
              taskId,
              sessionFile: session.sessionFile ?? null,
              sourceKind: "main",
              sample,
              message: this.deps.usageMessageFromEvent(
                event.message,
                session,
                this.deps.registry.get(taskId)?.usageModelId,
              ),
              modelId: this.deps.registry.get(taskId)?.usageModelId,
              userTurn: this.deps.userTurnCounters.get(userTurnKey) ?? null,
            });
          } catch (err) {
            console.warn(`[usage] recordLive 失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else if (event.type === "agent_settled") {
        usageTracker.onSettled();
      }

      if (event.type === "compaction_start" || event.type === "compaction_end") {
        const state: import("../../shared/compaction").TaskCompactionStatusDto = event.type === "compaction_start"
          ? { taskId, status: "running", reason: event.reason }
          : { taskId, status: event.aborted ? "cancelled" : event.errorMessage ? "failed" : event.result ? "completed" : "skipped",
              reason: event.reason, tokensBefore: event.result?.tokensBefore,
              estimatedTokensAfter: event.result?.estimatedTokensAfter, message: event.errorMessage };
        if (this.deps.compactionStateChanged) this.deps.compactionStateChanged(state);
        else this.deps.emitPatch({ type: "compaction_status", taskId, state });
        if (event.type === "compaction_end") this.deps.emitContextUsage(taskId, session);
        if (event.reason === "manual") return;
      }
      const entry = this.deps.registry.get(taskId);
      if (!entry?.assistantMessageId || entry.session !== session) return;

      this.handleQueuedTurnActivation(taskId, session, entry, event, generationSpeed);

      mapperCtx.messageId = entry.assistantMessageId;
      mapperCtx.startedAt = entry.startedAt ?? mapperCtx.startedAt;
      mapperCtx.modelName = session.model?.name ?? session.model?.id;

      const stats = generationSpeed.onEvent(event, entry.assistantMessageId);
      if (stats) {
        this.deps.emitPatch({
          type: "generation_stats",
          taskId,
          messageId: entry.assistantMessageId,
          stats,
        });
      }

      if (event.type === "tool_execution_start") {
        toolArgsById.set(event.toolCallId, event.args);
        if (entry.executionId && entry.session === session) {
          const execution = { taskId, executionId: entry.executionId, assistantMessageId: entry.assistantMessageId };
          toolExecutionById.set(event.toolCallId, execution);
          if (this.deps.executionAttempts) {
            try {
              const classification = classifyMcpToolCall(event.toolName, event.args, entry.mcpProviderIds ?? []);
              if (classification?.sideEffect) {
                const record = this.deps.executionAttempts.begin({ ...execution, toolCallId: event.toolCallId,
                  toolName: event.toolName, providerId: classification.identity.providerId,
                  shortToolName: classification.identity.shortToolName,
                  target: `mcp:${classification.identity.providerId}/${classification.identity.shortToolName}:${event.toolCallId}`,
                  verifierId: "mcp-business-verifier", verifierVersion: 0 });
                mcpAttemptsById.set(event.toolCallId, record);
              }
            } catch (error) { console.warn("[mcp-evidence] begin failed", error); }
          }
        }
      }

      if (
        event.type === "tool_execution_start" &&
        (entry.pendingApprovals.has(event.toolCallId) || entry.pendingExternalWrites.has(event.toolCallId))
      ) {
        return;
      }

      for (const patch of mapPiEventToPatches(event, mapperCtx)) {
        this.deps.emitPatch(patch);
      }

      if (
        event.type === "message_end" ||
        event.type === "turn_end" ||
        event.type === "tool_execution_end" ||
        event.type === "compaction_end" ||
        event.type === "agent_settled"
      ) {
        this.deps.emitContextUsage(taskId, session);
      }

      if (event.type === "agent_settled") {
        this.handleAgentSettled(taskId, session, entry, session.messages);
      }

      if (event.type === "tool_execution_end") {
        this.deps.pendingActions.remove(taskId, event.toolCallId);
        const args = toolArgsById.get(event.toolCallId);
        toolArgsById.delete(event.toolCallId);
        const execution = toolExecutionById.get(event.toolCallId);
        toolExecutionById.delete(event.toolCallId);
        const mcpAttempt = mcpAttemptsById.get(event.toolCallId);
        mcpAttemptsById.delete(event.toolCallId);
        if (mcpAttempt && this.deps.executionAttempts) {
          const finished: ExecutionAttempt = { ...mcpAttempt, transportStatus: event.isError ? "failed" : "succeeded",
            status: "inconclusive", phase: "finished",
            causeCode: event.isError ? "mcp-transport-error" : "business-verifier-unavailable",
            recovery: event.isError ? "recoverable" : undefined, finishedAt: Date.now() };
          try {
            this.deps.executionAttempts.update(finished);
            const failureTarget = `mcp:${mcpAttempt.providerId}/${mcpAttempt.shortToolName}`;
            if (event.isError) this.deps.executionFailures?.record({ taskId: mcpAttempt.taskId, executionId: mcpAttempt.executionId,
              assistantMessageId: mcpAttempt.assistantMessageId, causeCode: "mcp-transport-error", phase: "execute", recovery: "recoverable",
              sideEffects: "unknown", target: failureTarget, message: `MCP ${mcpAttempt.providerId}/${mcpAttempt.shortToolName} returned an execution error; partial side effects are unknown.`,
              nextAction: "Inspect the target system or reconnect the MCP provider before deciding whether to retry." });
            else this.deps.executionFailures?.resolveMatching(mcpAttempt.taskId, { target: failureTarget, causeCodes: ["mcp-transport-error", "application-restarted"] });
          } catch (error) { console.warn("[mcp-evidence] settle failed", error); }
        }
        if (execution && entry.session === session && execution.executionId === entry.executionId
          && execution.assistantMessageId === entry.assistantMessageId) {
          try {
            const materials = collectRuntimeMaterialEvidence({ ...event, args });
            if (materials.length) this.deps.runtimeSnapshots.appendMaterials(execution, materials);
          } catch (error) { console.warn("[runtime-materials] record failed", error); }
        }
        if (event.toolName === "read" && !event.isError && execution
          && entry.session === session && execution.executionId === entry.executionId
          && execution.assistantMessageId === entry.assistantMessageId) {
          const rawPath = (args as { path?: unknown } | undefined)?.path;
          if (typeof rawPath === "string" && rawPath.trim()) {
            const skillFile = entry.skillFiles?.find(skill => resolve(cwd, skill.path) === resolve(cwd, rawPath));
            if (skillFile) {
              if (entry.skillReads?.assistantMessageId !== entry.assistantMessageId) {
                entry.skillReads = { assistantMessageId: entry.assistantMessageId, ids: [] };
              }
              if (!entry.skillReads.ids.includes(skillFile.id)) entry.skillReads.ids.push(skillFile.id);
              this.deps.loadoutObservations.markSkillUsed(taskId, entry.assistantMessageId, skillFile.id);
            }
            const learned = this.deps.skillsService.resolveLearnedSkillRead(rawPath, cwd);
            const allowed = learned && entry.learnedSkills?.find((item) => item.skillId === learned.skillId);
            if (allowed) {
              this.deps.skillEffectiveness.markInvoked({
                taskId,
                assistantMessageId: entry.assistantMessageId,
                skill: allowed,
                kind: "read",
                toolCallId: event.toolCallId,
                at: Date.now(),
              });
              this.deps.loadoutObservations.markSkillUsed(taskId, entry.assistantMessageId, allowed.skillId);
            }
          }
        }
        void this.deps.maybeEmitArtifact(session, taskId, entry.assistantMessageId, {
          ...event,
          args,
          toolCallId: event.toolCallId,
        });
      }
    });
  }

  private handleQueuedTurnActivation(
    taskId: string,
    session: AgentSession,
    entry: SessionEntry,
    event: Parameters<Parameters<AgentSession["subscribe"]>[0]>[0],
    generationSpeed: GenerationSpeedTracker,
  ): void {
    if (event.type !== "message_start" || event.message.role !== "user") return;
    if (entry.pendingAssistantTurns.length > 0) {
      this.deps.finalizePendingMemoryTurn(taskId, entry.assistantMessageId, session);
    }
    const nextTurn = activateNextAssistantTurn(entry, Date.now());
    this.deps.promptExecution.forgetRetry(nextTurn?.messageId ?? entry.assistantMessageId!);
    if (!nextTurn) return;

    this.deps.skillEffectiveness.recordExposure({
      taskId,
      assistantMessageId: nextTurn.messageId,
      skills: entry.learnedSkills ?? [],
      at: Date.now(),
    });
    const explicitSkillId = entry.pendingSkillCommands?.get(nextTurn.messageId);
    if (explicitSkillId) {
      const skill = entry.learnedSkills?.find((item) => item.skillId === explicitSkillId);
      if (skill) {
        this.deps.skillEffectiveness.markInvoked({
          taskId,
          assistantMessageId: nextTurn.messageId,
          skill,
          kind: "command",
          at: Date.now(),
        });
        this.deps.loadoutObservations.markSkillUsed(taskId, nextTurn.messageId, skill.skillId);
      }
      entry.pendingSkillCommands?.delete(nextTurn.messageId);
    }

    this.deps.emitPatch({
      type: "generation_stats",
      taskId,
      messageId: nextTurn.previousMessageId,
      stats: generationSpeed.finishReply(),
    });
    this.deps.emitPatch({
      type: "assistant_end",
      taskId,
      messageId: nextTurn.previousMessageId,
      durationMs: Date.now() - nextTurn.previousStartedAt,
    });
    this.deps.emitPatch({
      type: "assistant_start",
      taskId,
      messageId: nextTurn.messageId,
      executionId: nextTurn.executionId,
      modelName: session.model?.name ?? session.model?.id,
    });
  }

  private handleAgentSettled(
    taskId: string,
    session: AgentSession,
    entry: SessionEntry,
    messages: AgentSession["messages"],
  ): void {
    const terminalMessageId = entry.assistantMessageId!;
    if (entry.lastSettledAssistantMessageId === terminalMessageId) return;
    entry.lastSettledAssistantMessageId = terminalMessageId;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    // AgentService.abortTask already settles interactions and runtime evidence as cancelled.
    // Do not overwrite that terminal cancellation with the normal completed lifecycle.
    if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted") {
      this.deps.deletePendingMemoryTurn(terminalMessageId);
      return;
    }
    if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
      const error = lastAssistant.errorMessage || "模型连接或生成失败，请重试。";
      {
        const model = session.model;
        const modelKey = model?.id ? (model.provider ? `${model.provider}/${model.id}` : model.id) : undefined;
        if (this.deps.executionFailures) recordPromptFailureRecovery({ failures: this.deps.executionFailures, taskId, executionId: entry.executionId,
          assistantMessageId: terminalMessageId, modelKey, error: new Error(error) });
      }
      this.deps.deletePendingMemoryTurn(terminalMessageId);
      this.deps.runtimeSnapshots.finishByAssistantMessage(taskId, terminalMessageId, "failed", error);
      this.deps.skillEffectiveness.markTurnOutcome(taskId, terminalMessageId, "failed");
      this.deps.loadoutObservations.markOutcome(taskId, terminalMessageId, "failed");
      this.deps.emitLifecycle({ kind: "failed", taskId, assistantMessageId: terminalMessageId, error });
      return;
    }

    if (this.deps.executionFailures) {
      const model = session.model;
      const modelKey = model?.id ? (model.provider ? `${model.provider}/${model.id}` : model.id) : undefined;
      resolvePromptFailureRecovery(this.deps.executionFailures, taskId, modelKey);
    }
    this.deps.finalizePendingMemoryTurn(taskId, terminalMessageId, session);
    this.deps.runtimeSnapshots.finishByAssistantMessage(taskId, terminalMessageId, "completed");
    this.deps.skillEffectiveness.markTurnOutcome(taskId, terminalMessageId, "completed");
    this.deps.loadoutObservations.markOutcome(taskId, terminalMessageId, "completed");
    this.deps.emitLifecycle({
      kind: "completed",
      taskId,
      assistantMessageId: terminalMessageId,
      durationMs: Math.max(0, Date.now() - (entry.startedAt ?? Date.now())),
    });
  }
}
