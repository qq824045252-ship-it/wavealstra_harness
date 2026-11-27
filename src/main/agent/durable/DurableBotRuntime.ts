import { DURABLE_ARTIFACT_ENTRY_KIND as DOTS_ARTIFACT_KIND, durableArtifactRegistrationSchema, durableRegisteredArtifact as registeredDotsArtifact } from "./DurableArtifactRegistration";
import { durableGoalAdmission, nativeGoalParentGeneration } from "./DurableGoalLineage";
import { assertDurableGoalCompaction, assertDurableGoalContinuation } from "./DurableGoalContinuationAuthority";
import { CoreGoalContinuationRevokedError, type ActiveCoreGoalContinuation } from "../work/CoreGoalContinuationDriver";
import { durableGoalToolEvidence } from "./DurableGoalToolEvidence";
import { dotsInputVersion, DotsIntentChanged } from "../../dots/DotsNativeIntent";
import { DOTS_RECOVER_COMMIT, dotsRecoveryAllowsTool, dotsRecoveryAllowsVerify, validDotsRecoveryFilename, type DotsRecoveryToolScope } from "../../dots/DotsRecovery";
import { appendDurableDotsReply } from "./DurableDotsReply";
import { appendDurableDotsProactive } from "./DurableDotsProactive";
import { DOTS_TASK_END, readDurableDotsTerminal } from "./DurableDotsWorker";
import { PROJECT_VERIFY_CHILD_KEY, PROJECT_VERIFY_TOOL, projectVerificationShellCommand } from "./DurableProjectVerification";
import { DURABLE_TURN_LIMIT_MESSAGE } from "./DurableRunLimits";
import { readDotsWorkerOutcome, recoverDotsNarrativeReply } from "../../dots/DotsWorkerOutcome";
import { DOTS_TASK_ID, isDotsAutomaticInput, type DotsAssistantReply } from "../../../shared/dots";
import { OFFICE_USE_TOOLS } from "../../../shared/office-use";
import { OFFICE_RECOVERY_CREATE_MEMO } from "../../office-use/OfficeDocumentCreation";
import { admittedFileMutationPath, FILE_MUTATION_TARGET_MEMO, resolveFileMutationTarget, withWindowsBashWorkspacePath,
  type FileMutationTarget } from "../../platform/bash-workspace-path";
import { withShellTerminalGuidance } from "./DurableShellTerminal";
import { durableToolDiagnosticMessages } from "./DurableToolDiagnostics";
import { emptyUsageEvidence, usagePresence, type ProviderUsageEvidence, type ProviderUsagePresence } from "../../../shared/provider-usage-evidence";
import { supportsUsageObservation, withUsageEvidence } from "../../usage/provider-usage-evidence";
import { createDurableArtifactRegistrationTool, registerNativeMutation, withDurableArtifactRegistration } from "./DurableArtifactRegistration";
import { NATIVE_FILE_EVIDENCE_MEMO } from "./DurableEffectRecovery";
import { withDurableToolCoordination } from "./DurableToolCoordination";
import { prioritizeInputAfterDeferredGoal } from "./DurableInputFreshness";
import { DurableNativeHooks, type DurableHookBinding } from "./DurableNativeHooks";
import { withNativeToolOrigin } from "./DurableToolLifecycle";
import { nativeExecutionSucceeded, nativeFileReadAttemptSchema, readNativeExecutionReceipt } from "../../../shared/native-execution-receipt";
import { bindDotsConversationWorkspace, canRebindDurableWorkspace, migrateDurableWorkspace, WorkspaceMigrationBusyError } from "./DurableWorkspaceMigration";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolvedPathKey } from "../../platform/paths";
import { isPathInsideOrEqual } from "../../task/TaskExecutionWorkspace";
import { BACKGROUND_CONTEXT as ctx, type Context } from "@earendil-works/chord/context";
import type { Models, Message, AssistantMessage } from "@earendil-works/pi-ai";
import {
  Harness, SessionFailed, StorageRequestError, NestedCallDoc, createRegistry, defineExtension, section, AgentDoc, LiveDoc, hook, CompactionTask, GenerationTask, ToolTask, defineDoc, InboxDoc,
  type Conversation, type ConversationWatch, type ConversationView, type EntryRecord, type EnvTarget, type JsonObject,
  type LiveState, type InboxState, type Storage, type TaskId, type ToolRegistration, type ToolTaskInput, type UserInput, type Cursor, type UsageState, type Submission, type ToolHooks, type EntryId, type HookApi,
} from "@earendil-works/pi-durable";
import { CodingTools, createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { capabilityResultFromDetails } from "../../../shared/capability-result";
import { searchReportFromDetails } from "../../../shared/web-search";
import { consultReportFromDetails } from "../../../shared/multi-model-consult";
import { DurableExecutionEnv } from "./DurableExecutionEnv";
import type { CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import type { ChatMessageDto, TaskHistoryTarget, TaskUserQuestionsDto, TaskUserQuestionsQuery } from "../../../shared/agent-ipc";
import { durableHistoryIdentity } from "./DurableHistoryIdentity";
import { summarizeToolInput } from "../../../shared/pi-event-mapper";
import type { BotToolMode, DurableBotSnapshot, DurableHistoryBlock } from "../../../shared/durable-bot";
import { createDurableCodeMode } from "./DurableCodeMode";
import { seedDurableBranch, type DurableBranchSeed } from "./DurableTaskBranch";
import type { DurableContextHook, DurableDomainTools } from "./DurableDomainTools";
import { openDurableStorage } from "./DurableStorage";
import type { DurableStorageLease } from "./DurableStorageLease";
import { durableStorageOwnerState } from "./DurableStorageLease";
import { durableCompletedTurns } from "./DurableTurnProjection";
import { activityTimeOrUndefined, latestActivityTime } from "../../../../shared/src/activity-time";
import { withDurableImageRead } from "./DurableImages";
import { NATIVE_FILE_READ_ATTEMPT, withDurableFileReadEvidence } from "./DurableFileReadEvidence";
import { withMissingFileRecovery } from "./DurableMissingFile";
import { createAgentSettingsManager, getAgentBashShellPath } from "../../agent-shell-settings";
import { getMyBuddyDir } from "../../paths";
import { createPlatformShellTools } from "../../platform/shell-tools";
import { DurableHistoryProjection, assistantRow, durableToolStatus, nestedToolRow, toolMessageReceipt, durableContentText as contentText, type NestedCallDetail, type DurableInputMetadata, type DurableResponseSpeed } from "./DurableHistoryProjection";
import { estimateTextTokens } from "../../../shared/token-format";
import { identifyModelInvocation, requestTraceBoundary, setRequestTraceBoundary, startGuardedModelStream, withModelInvocationSettings } from "../ModelInvocationAdmission";
import type { CacheTraceBoundary, CacheTraceOperation } from "../CacheRequestTracer";
import { DurableSubagentIdentity, resolveDurableExecutionCwd } from "./DurableSubagents";
import { recoverChildMeasurements } from "./DurableChildMeasurements";
import { DurableEvidenceProjection, type DurableEvidenceOptions } from "./DurableEvidenceProjection";
import { projectAnswerRule, type TurnAnswerRouting } from "./DurableAnswerRouting";
import { startAnswerRoutingTiming, withAnswerRoutingTimings } from "../AnswerRoutingTimings";
import { DurableContextManager } from "./context/DurableContextManager";
import { DurableContextStateDoc, type DurableContextPersistedState } from "./context/DurableContextState";
import { captureContextBranchAt } from "./context/DurableContextBranch";
import { contextStatusFromStorage } from "./context/DurableContextStatus";
import { createDurableContextTools } from "./context/DurableContextTools";
import { resolveDurableCompactionSettings } from "./context/CompactionPolicy";
import type { DurableCompactionOutcome, DurableContextManagementOptions } from "./context/types";
import type { ContextManagementEngine, ContextManagementStatusDto } from "../../../shared/context-management";
import { ActiveDurableConversation, forkDurableConversation, resolveActiveDurableConversation, type DurableRegenerationInput, type DurableRegenerationState } from "./DurableConversationBranch";
import { DurableConsultIdentity } from "./DurableConsultSession";
import type { DiagnosticSource, ToolDiagnosticEvent } from "../../../shared/task-diagnostics";
import { gatewayBotOriginSchema } from "../work/BotTurnOrigins";
import { durableInputAuditSchema, type DurableInputAudit } from "./DurableSkillProjection";
import { mergeContextUsage } from "../../usage/context-usage-merge";
import { GenerationTiming, generationContentTokens } from "../../usage/generation-timing";
import { deepseekCitationMarkdown } from "../../../shared/deepseek";
import type { RuntimeAuditReader } from "../../platform/runtime-audit";

type BotInputMetadata = DurableInputMetadata;

function allowsDotsReplyRecovery(input?: BotInputMetadata): boolean {
  return Boolean(input?.inputRequestId && !isDotsAutomaticInput(input.inputRequestId)
    && !input.inputRequestId.startsWith("dots-input-") && !input.goalContinuation && !input.gatewayOrigin
    && !/\b(?:json|dotsState)\b/i.test(input.displayText));
}
/** 孤立的工具结果最多回扫多少条 entry 去找调用行（默认窗口 50 条；留足余量但固定上限）。 */
const ORPHAN_CALL_SCAN_ENTRIES = 500;
const CompactionRequestSequence = defineDoc({ kind: "mybuddy.compaction-request-sequence", version: 1, scope: "session",
  initial: () => ({ next: 0 }), checkpointWhen: () => false,
});
const AuditReceipts = defineDoc({ kind: "mybuddy.audit-receipts", version: 1, scope: "conversation", history: "latest", fork: "current", checkpointWhen: () => false,
  initial: () => ({ settled: {} as Record<string, number> }),
});
const RevokedGoalRecovery = defineDoc({ kind: "mybuddy.revoked-goal-recovery", version: 1, scope: "conversation", history: "latest", fork: "initial",
  checkpointWhen: () => false, initial: () => ({ pending: null as { runTaskId: TaskId; inputId: Submission["id"] } | null }),
});

// Display telemetry lives with Durable, never in the task scheduler or renderer clock.
// `completed` keeps the completion clock (durationMs); `speed` keeps the host-measured generation speed
// (tps/ttftMs), keyed by the same `${taskId}:${message.timestamp}` identity.
const ResponseTiming = defineDoc({ kind: "mybuddy.response-timing", version: 1, scope: "conversation", history: "latest", fork: "current", checkpointWhen: () => false,
  initial: () => ({ completed: {} as Record<string, number>, speed: {} as Record<string, { tps: number | null; ttftMs: number | null }> }),
});

export interface DurableBotOptions {
  codeReview?: import("./DurableCodeReview").DurableCodeReview;
  /** Native passive viewer: never configure, recover, admit or settle work. */
  readOnly?: boolean;
  passiveReader?: RuntimeAuditReader;
  directory: string;
  cwd: string;
  /** Host-persisted migration source; only an idle native store may adopt cwd. */
  workspaceMigrationFrom?: string;
  pinInitialDotsWorkspace?: boolean;
  models: Models;
  model?: { provider: string; modelId: string };
  /** Pi's persisted limit for one run. Null clears it; omission preserves the stored value. */
  maxTurns?: number | null;
  toolMode: BotToolMode;
  instructions: () => string | Promise<string>;
  evidence?: (messages: readonly Message[]) => string;
  evidenceProjection?: DurableEvidenceOptions;
  answerRouting?: TurnAnswerRouting;
  onResponse?: (message: AssistantMessage, identity: { conversationId: string; generationTaskId: number; sourceKind: "main" | "subagent"; usageEvidence?: ProviderUsageEvidence; usagePresence?: ProviderUsagePresence }) => void;
  onGoalToolResult?: (identity: import("../../../shared/conversation-goal-activity").GoalActivityIdentity, tool: {
    name: string; callId: string; details: unknown;
  }) => void;
  onRequest?: (identity: import("../../../shared/conversation-goal-activity").GoalActivityAdmission & { sourceKind: "main" | "subagent" }) => void | Promise<void>;
  beforeProviderRequest?: () => void | Promise<void>;
  verifyGoalContinuation?: (origin: ActiveCoreGoalContinuation) => Promise<void>;
  beforeToolExecution?: (name: string, args: unknown, cwd: string) => void | Promise<void>;
  admittingUserInputs?: () => readonly string[];
  /** Authority revocation must be rechecked before every provider attempt. */
  providerAuthorityGuarded?: () => boolean;
  onProviderUsage?: (input: { taskId?: string; conversationId: string; generationTaskId: number;
    reported: boolean; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; usageEvidence?: ProviderUsageEvidence; usagePresence?: ProviderUsagePresence }) => void;
  executionIdentity?: { taskId?: string; sourceKind: DiagnosticSource; executionScope: string };
  onTool?: (event: ToolDiagnosticEvent) => void;
  onGoalToolEvidence?: (owner: import("../../../shared/conversation-goal-activity").GoalActivityIdentity,
    toolTaskId: number, receipt: NonNullable<ReturnType<typeof durableGoalToolEvidence>>) => void;
  observedUsage?: (conversationId: string) => import("../../../shared/task-diagnostics").ConversationUsageReceipt;
  initialHistory?: { messages: readonly Message[]; context: readonly Message[] } | (() => Promise<{ messages: readonly Message[]; context: readonly Message[] } | undefined>);
  initialBranch?: DurableBranchSeed;
  toolHooks?: Partial<ToolHooks>;
  nativeHooks?: DurableHookBinding;
  foregroundHooks?: DurableDomainTools["foregroundHooks"];
  toolAllowed?: (name: string) => boolean;
  readonlyShell?: () => boolean;
  waitingForInput?: () => boolean;
  isDelegatedMemoryInput?: (requestId: string) => boolean;
  isDotsWorkerInput?: (requestId: string) => boolean;
  dotsRecoveryScope?: (operationId: string) => DotsRecoveryToolScope | undefined | Promise<DotsRecoveryToolScope | undefined>;
  hasDotsDelegation?: () => boolean;
  deliveredDotsInput?: () => string | undefined;
  onTurns?: (turns: ReturnType<typeof durableCompletedTurns>) => void | Promise<void>;
  onDotsProgress?: (operationId: string, identity: string, at: number) => void;
  onEntries?: (entries: readonly EntryRecord[], identity: { conversationId: string; sourceKind: "main" | "subagent" }) => void;
  projectionAfterEntryId?: number;
  taskId?: string;
  tools?: readonly ToolRegistration[];
  /** 扩展的 context 钩子（改写每次请求的上下文）；在 beforeRequest 里与 evidence 一起执行。 */
  contextHooks?: readonly DurableContextHook[];
  /**
   * 自动上下文管理（内嵌 acp-kernel）。缺省时 Durable 使用 Pi 原生压缩策略；
   * 提供后由本运行时统一接线 Harness settings/getter、请求前投影、原生压缩协调与工具。
   */
  contextManagement?: DurableContextManagementOptions;
  /** Task-scoped compatibility registrations for stored names, without transport startup. */
  restoreTools?: (names: readonly string[]) => readonly ToolRegistration[];
  prepareCodeMode?: (code: string, context: Parameters<ToolRegistration["execute"]>[2]) => Promise<readonly ToolRegistration[]>;
  assets?: Pick<CodemodeSandboxOptions, "wasm" | "workerUrl">;
  prepareSnapshot?: (snapshot: DurableBotSnapshot) => Promise<void>;
  onSnapshot: (snapshot: DurableBotSnapshot) => void;
  onProjected?: (snapshot: DurableBotSnapshot) => void | Promise<void>;
  drainTaskProjection?: () => Promise<void>;
  /** Only for isolated tests; production always opens its own durable JSONL directory. */
  storage?: Storage;
}

/** A product adapter, with no scheduler, retry loop, continuation prompt or in-memory execution queue. */
/** Native submission has conclusively ended without a usable answer; not an unknown effect. */
export class DurableReplyError extends Error {}

/** Failed opening has not transferred a runtime, but still owns real resources. */
export class DurableOpenCleanupError extends Error {
  constructor(readonly release: () => Promise<void>, openingError: unknown, cleanupError: unknown) {
    super("Durable 打开失败且资源尚未释放，可重试原资源清理", { cause: new AggregateError([openingError, cleanupError]) });
    this.name = "DurableOpenCleanupError";
  }
}

async function failedOpen(error: unknown, release: () => Promise<void>): Promise<never> {
  try { await release(); }
  catch (cleanupError) { throw new DurableOpenCleanupError(release, error, cleanupError); }
  throw error;
}

export class DurableBotRuntime {
  private watch!: ConversationWatch;
  private revision = 0;
  private readonly epoch = randomUUID();
  private readonly historyId: string;
  private latest!: DurableBotSnapshot;
  private closeState:
    | { kind: "open" }
    | { kind: "closing"; completion: Promise<void> }
    | { kind: "retry" }
    | { kind: "closed" } = { kind: "open" };
  private failure: unknown = undefined;
  private failed = false;
  private closeBegun = false;
  private readonly failureListeners = new Set<(error: unknown) => void>();
  private projection: Promise<void> = Promise.resolve();
  private nativeTools: ToolRegistration[] = [];
  private compatibilityTools: ToolRegistration[] = [];
  private codemode!: ToolRegistration;
  private registry!: ReturnType<typeof createRegistry>;
  private storage!: Storage;
  /** Cross-process single-writer lease; only present when the runtime opened its own directory. */
  private lease?: DurableStorageLease;
  private readonly children = new Map<number, ConversationWatch>();
  private readonly history = new DurableHistoryProjection();
  private liveDotsInput?: { id: number; operationId?: string; recoverNarrative: boolean };
  private historyBefore?: EntryId;
  private readonly metadataByEntry = new Map<number, BotInputMetadata>();
  private readonly pendingAuditInputs = new Map<string, DurableInputAudit>();
  private readonly nestedHistory = new Map<number, { entries: EntryRecord[]; newest?: EntryId;
    toolsByAssistant: Map<string, Map<string, string>>; latestToolByCall: Map<string, string> }>();
  /** 找过 owner 行的孤立工具结果：同一个 callId 只扫一次，避免每帧重新扫历史。 */
  private readonly orphanScans = new Set<number>();
  private pendingTurnEntries: EntryRecord[] = [];
  private consumerCursor?: number;
  private contextTokens: number | null = null;
  /** Host-side stream clocks, one per live generation task; pi's `LiveState.generation` carries no timestamps. */
  private readonly generationTimings = new Map<number, { attempt: number; timing: GenerationTiming }>();
  /**
   * 本轮 run 的起点时间，按 run 缓存。
   * 不能只靠 history 里的用户条目：那需要条目在投影窗口（最新 50~100 条）内，
   * 长任务里用户条目早被挤出去，重开会话就退回 undefined，
   * 占位行于是拿 epoch 0 当 createdAt（侧栏显示 20774 天）。见 resolveRunStart。
   */
  private runStarted?: { taskId: TaskId; at: number };
  private evidence?: DurableEvidenceProjection;
  /** 自动上下文管理协调器；仅在 DurableBotOptions.contextManagement 提供时存在。 */
  private contextManager?: DurableContextManager;
  private passiveContextStatus?: ContextManagementStatusDto;
  /** 上下文管理工具需在 configure 重建 nativeTools 时保留。 */
  private contextTools: ToolRegistration[] = [];
  /** 当前会话模型窗口/键的同步缓存，供 Harness settings getter 每次读取。 */
  private modelWindow = 0;
  private modelOutputLimit: number | undefined;
  private modelKeyCache?: string;
  /** 子代理/会诊 conversation 的独立协调器（每个 conversation 一份压缩状态）。 */
  private readonly childManagers = new Map<string, Promise<DurableContextManager | undefined>>();
  private readonly ownedChildManagers = new Set<DurableContextManager>();
  private constructor(readonly harness: Harness, readonly conversation: Conversation, private readonly options: DurableBotOptions) {
    this.historyId = durableHistoryIdentity(options.directory, String(conversation.id), options.storage);
    this.observeSession();
  }

  /** Whether the underlying Session failed and this runtime must be reopened. */
  isSessionFailed(): boolean { return this.failed; }
  /** The first error that failed the Session, or undefined while healthy. */
  sessionFailure(): unknown { return this.failure; }
  /** Observe the first Session failure; returns an unsubscribe function. */
  onSessionFailed(listener: (error: unknown) => void): () => void {
    if (this.failed) { listener(this.failure); return () => {}; }
    this.failureListeners.add(listener);
    return () => { this.failureListeners.delete(listener); };
  }
  private observeSession(): void {
    this.harness.subscribeClose(() => {
      this.closeBegun = true;
      void this.harness.closed.then(end => { if (end.kind === "failed") this.markFailure(end.error); });
    });
  }
  private markFailure(error: unknown): void {
    if (this.failed || this.closeState.kind !== "open") return;
    this.failed = true;
    this.failure = error;
    console.warn("[Durable] Session failed; reopening recovers committed content", error);
    for (const listener of [...this.failureListeners]) {
      try { listener(error); }
      catch (listenerError) { console.warn("[Durable] Session failure listener failed", listenerError); }
    }
    this.failureListeners.clear();
  }
  private assertSessionHealthy(): void {
    if (this.failed) throw new SessionFailed(this.failure);
    if (this.closeState.kind !== "open") throw new Error("Durable runtime is closing or closed");
  }
  /** Convert a failed call into the recognizable SessionFailed, preserving the original cause. */
  private async normalizeFailure(error: unknown): Promise<never> {
    if (error instanceof StorageRequestError) throw error;
    if (error instanceof SessionFailed) { this.markFailure(error.cause); throw error; }
    if (this.failed) throw new SessionFailed(this.failure);
    // The first fatal Storage call rethrows its raw error; the Session closes at once.
    // Wait for that close so the failure is recorded and callers always see SessionFailed.
    if (this.closeBegun) {
      const end = await this.harness.closed;
      if (end.kind === "failed") this.markFailure(end.error);
    }
    if (this.failed) throw new SessionFailed(this.failure);
    throw error;
  }

  static async open(options: DurableBotOptions): Promise<DurableBotRuntime> {
    let resolveRequestHarness!: (harness: Harness | undefined) => void;
    const requestHarness = new Promise<Harness | undefined>(resolve => { resolveRequestHarness = resolve; });
    const nextCompactionRequest = async () => {
      const harness = await requestHarness;
      if (!harness) throw new Error("压缩请求的持久身份存储不可用");
      return harness.commit(async tx => {
        const sequence = await tx.doc(CompactionRequestSequence);
        if (!Number.isSafeInteger(sequence.next) || sequence.next >= Number.MAX_SAFE_INTEGER) throw new Error("压缩请求序列已耗尽");
        return ++sequence.next;
      }, ctx);
    };
    const verifyGoal = options.verifyGoalContinuation;
    const goalTaskId = options.taskId;
    const verifyCompaction = verifyGoal && goalTaskId ? async (sessionId: string | undefined, signal?: AbortSignal) => {
      const harness = await requestHarness;
      if (!harness) throw new Error("Goal 自动续跑的执行宿主未就绪");
      await assertDurableGoalCompaction(goalTaskId, storage, harness, sessionId, { ...ctx, abortSignal: signal }, verifyGoal);
    } : undefined;
    options = { ...options, models: taskScopedModels(options.models, options.cwd,
      options.executionIdentity?.taskId, options.onProviderUsage, options.beforeProviderRequest, nextCompactionRequest, options.providerAuthorityGuarded,
      verifyCompaction) };
    const initialModel = options.model ? options.models.getModel(options.model.provider, options.model.modelId) : undefined;
    const initialModelWindow = initialModel?.contextWindow ?? 0;
    const initialModelKey = options.model ? `${options.model.provider}/${options.model.modelId}` : undefined;
    // Harness settings must be a synchronous getter: Pi reads it at every resolution, so
    // settings changes and model switches take effect on the next request without reopening.
    const harnessSettings = options.contextManagement ? () => {
      try {
        return {
          documentRetentionMs: 0,
          compaction: resolveDurableCompactionSettings(
            runtime?.currentModelWindow() || initialModelWindow,
            options.contextManagement!.policy(),
            { modelKey: runtime?.currentModelKey() ?? initialModelKey,
              estimateRawContext: (options.contextManagement!.engine?.() ?? "billion-context") !== "native" },
          ),
        };
      } catch {
        // 设置 store 暂时不可读时按产品默认值继续，绝不因为读阈值失败而阻断生成。
        return { documentRetentionMs: 0, compaction: resolveDurableCompactionSettings(initialModelWindow || 128_000, { ratio: 0.8, absoluteTokens: 200_000 }, { modelKey: initialModelKey, estimateRawContext: (options.contextManagement!.engine?.() ?? "billion-context") !== "native" }) };
      }
    } : undefined;
    const handle = options.storage ? undefined : await openDurableStorage(options.directory, ctx, {
      readOnly: options.readOnly, reader: options.passiveReader,
    });
    const storage = options.storage ?? handle!.storage;
    const registry = createRegistry();
    const native = [...codingTools(options.directory, options.readonlyShell), ...(options.tools ?? [])];
    let compatibility: ToolRegistration[] = [];
    try {
      if (options.restoreTools) {
        const names = new Set<string>();
        let cursor: Cursor | undefined;
        do {
          const page = await storage.scanConversations({}, 500, cursor, ctx);
          for (const conversation of page.items) {
            const record = await storage.findDocument({ kind: AgentDoc.definition.kind, scope: { kind: "conversation", conversationId: conversation.id } }, "current", ctx);
            const state = record && await storage.document(record.id, "current", ctx);
            if (Array.isArray(state?.value.tools)) for (const name of state.value.tools) if (typeof name === "string") names.add(name);
          }
          cursor = page.next;
        } while (cursor);
        const installed = new Set(native.map(tool => tool.name));
        compatibility = [...options.restoreTools([...names])].filter(tool => !installed.has(tool.name));
        native.push(...compatibility);
      }
    } catch (error) {
      return failedOpen(error, async () => { await storage.close(ctx); handle?.lease?.release(); });
    }
    // 上下文管理工具必须在 Code Mode 的 tool declaration 冻结之前进入 native 列表：
    // 否则第一次 configure 会改变 codemode 的声明，同一轮内触发 planTools 的 remove+add，
    // 让 provider 请求末尾多出 tool-change system 消息（已验证会导致工具重放）。
    let contextManagerRef: DurableContextManager | undefined;
    let mainConversationId: Conversation["id"] | undefined;
    const contextTools = options.contextManagement && !options.readOnly
      ? createDurableContextTools({ manager: (conversationId, context) => runtime!.contextManagerFor(conversationId, context) })
      : [];
    native.push(...contextTools);
    const codemode = createDurableCodeMode(() => native.filter(tool =>
      (tool.callers?.includes("tools") ?? true) && options.toolAllowed?.(tool.name) !== false), options.assets, join(options.directory, "images"), async (code, context) => {
      const tools = await options.prepareCodeMode?.(code, context) ?? [];
      runtime?.installCompatibility(tools);
      return tools;
    });
    let runtime: DurableBotRuntime | undefined;
    // Recovered generations may enter their hook while the host is still opening.
    let finishOpening!: (projection: DurableEvidenceProjection | undefined) => void;
    const openingEvidence = new Promise<DurableEvidenceProjection | undefined>(resolve => { finishOpening = resolve; });
    registry.install(botExtension(options, storage, native, codemode, (id, message) => runtime?.recordResponse(id, message),
      (code, context, conversationId) => runtime?.prewarmCodeMode(code, context, conversationId), () => options.evidenceProjection ? openingEvidence : undefined, (call, api, context) => runtime?.recordSkillRead(call, api, context), async (id, context) => harness?.getTask(id, context), (conversationId, context) => runtime!.contextManagerFor(conversationId, context),
      async (operation, context) => {
        const opened = await requestHarness;
        if (!opened) throw new Error("前台工具无法持久化本次执行凭据。");
        return opened.commit(operation, context);
      }));
    let harness: Harness | undefined;
    try {
      harness = await Harness.open(storage, {
        readOnly: options.readOnly,
        models: options.models, registry,
        ...(harnessSettings ? { settings: harnessSettings } : {}),
        env: (target, context) => durableExecutionEnv(target, context, options.cwd),
      }, ctx);
      resolveRequestHarness(harness);
      const root = await harness.root(ctx, { agent: { cwd: options.cwd, model: options.model },
        init: async (tx, id) => {
          if (options.initialBranch) return;
          const initialHistory = typeof options.initialHistory === "function" ? await options.initialHistory() : options.initialHistory;
          for (const message of initialHistory?.messages ?? []) await tx.appendEntry(id, {
            kind: message.role === "user" ? "pi.user" : message.role === "assistant" ? "pi.assistant" : "pi.tool-result", model: [message], data: { mybuddyImported: true },
          });
          if (initialHistory?.context.length) await tx.appendEntry(id, { kind: "mybuddy.context-import", head: "self", model: [...initialHistory.context] });
        },
      });
      if (!options.readOnly && options.initialBranch) await seedDurableBranch(root, options.initialBranch);
      const conversation = await resolveActiveDurableConversation(harness, root, ctx);
      mainConversationId = conversation.id;
      runtime = new DurableBotRuntime(harness, conversation, options);
      if (options.evidenceProjection) runtime.evidence = new DurableEvidenceProjection(options.evidenceProjection, conversation, options.models);
      runtime.storage = storage;
      runtime.lease = handle?.lease;
      runtime.registry = registry;
      runtime.nativeTools = native;
      runtime.compatibilityTools = compatibility;
      runtime.codemode = codemode;
      const persistedContext = await harness.snapshot(DurableContextStateDoc, conversation.id, ctx);
      if (persistedContext) runtime.passiveContextStatus = await contextStatusFromStorage(persistedContext as DurableContextPersistedState, storage, conversation.id, Boolean(options.readOnly && durableStorageOwnerState(options.directory) === "inactive"));
      if (options.contextManagement && !options.readOnly) {
        runtime.modelWindow = initialModelWindow;
        runtime.modelOutputLimit = initialModel?.maxTokens;
        runtime.modelKeyCache = initialModelKey;
        const manager = new DurableContextManager({
          conversation, models: options.models, archiveReader: harness,
          initialState: persistedContext as DurableContextPersistedState | undefined,
          initialStatus: runtime.passiveContextStatus,
          policy: options.contextManagement.policy,
          engine: () => runtime!.currentCompactionEngine(),
          contextWindow: () => runtime!.currentModelWindow(),
          modelKey: () => runtime!.currentModelKey(),
          outputReserveTokens: () => runtime!.modelOutputLimit,
          toolEstimateTokens: options.contextManagement.toolEstimateTokens ?? (() => runtime!.estimateNativeToolTokens()),
          ...(options.contextManagement.onStatus ? { onStatus: options.contextManagement.onStatus } : {}),
          log: (message, error) => console.warn(message, error ?? ""),
        });
        contextManagerRef = manager;
        runtime.contextManager = manager;
        // 工具在 Harness.open 前创建（保证 codemode 声明不含中途变化），这里只登记以便 configure 重建时保留。
        runtime.contextTools = contextTools;
      }
      if (options.workspaceMigrationFrom) {
        if (options.readOnly) throw new Error("Read-only history cannot migrate a Bot workspace");
        if (options.waitingForInput?.()) throw new WorkspaceMigrationBusyError();
        await migrateDurableWorkspace(harness, options.workspaceMigrationFrom, options.cwd, ctx);
      }
      if (options.pinInitialDotsWorkspace) await bindDotsConversationWorkspace(conversation, options.cwd, ctx);
      const bound = await conversation.agent(ctx);
      if (bound.cwd && resolve(bound.cwd) !== resolve(options.cwd)) throw new Error("Bot 已绑定的工作目录与当前项目不一致");
      if (bound.model) {
        const boundModel = options.models.getModel(bound.model.provider, bound.model.modelId);
        runtime.modelWindow = boundModel?.contextWindow ?? initialModelWindow;
        runtime.modelOutputLimit = boundModel?.maxTokens;
        runtime.modelKeyCache = `${bound.model.provider}/${bound.model.modelId}`;
      }
      finishOpening(runtime.evidence);
      // Preserve existing native tool selections. A task resumed after an upgrade must
      // also be able to verify its work and end or park a Dots assignment.
      const configured = await conversation.commit(async tx => {
        const state = await tx.doc(AgentDoc, conversation.id);
        if (!options.readOnly && Array.isArray(state.tools) && !state.tools.includes("codemode")) {
          for (const tool of native) {
            if ([DOTS_TASK_END, DOTS_RECOVER_COMMIT, PROJECT_VERIFY_TOOL].includes(tool.name) && options.toolAllowed?.(tool.name) !== false
                && !state.tools.includes(tool.name)) state.tools.push(tool.name);
          }
        }
        return Boolean(state.tools);
      }, ctx);
      if (configured) {
        options.toolMode = bound.tools.some(tool => tool.name === "codemode") ? "codemode" : "native";
        // Normalize Code Mode sessions persisted before executeTool: scripts may call every registered tool,
        // while the model is still offered only codemode.
        if (!options.readOnly && options.toolMode === "codemode") await runtime.configure(undefined, "codemode");
        else if (!options.readOnly && options.maxTurns !== undefined && bound.maxTurns !== (options.maxTurns ?? undefined)) {
          await conversation.configure({ maxTurns: options.maxTurns }, ctx);
        }
      } else if (!options.readOnly) await runtime.configure(options.model, options.toolMode);
      // Context tools are created after Harness.open, so a reopened (already-configured) session
      // re-installs the extension once to make them visible to the model.
      if (runtime.contextManager) runtime.installExtension();
      runtime.watch = await conversation.watch(ctx);
      await runtime.refresh();
      runtime.watch.start(async () => { await runtime!.refresh(); });
      if (!options.readOnly) {
        await runtime.replayChildUsage();
        await runtime.resumeRegeneration();
      }
      return runtime;
    } catch (error) {
      resolveRequestHarness(undefined);
      finishOpening(undefined);
      return failedOpen(error, async () => {
        if (runtime) await runtime.close();
        else if (harness) await harness.close(ctx);
        else await storage.close(ctx);
        handle?.lease?.release();
      });
    }
  }

  async configure(model: DurableBotOptions["model"], toolMode: BotToolMode, thinkingLevel?: import("@earendil-works/pi-ai").ModelThinkingLevel,
    extensions?: readonly ToolRegistration[], contextHooks?: readonly DurableContextHook[], toolHooks?: Partial<ToolHooks>,
    foregroundHooks?: DurableDomainTools["foregroundHooks"],
    verifyTools?: (names: ReadonlySet<string>) => Promise<void>): Promise<void> {
    this.assertSessionHealthy();
    const nativeTools = extensions ? [...codingTools(this.options.directory, this.options.readonlyShell), ...extensions,
      ...this.contextTools.filter(tool => !extensions.some(item => item.name === tool.name))] : this.nativeTools;
    if (verifyTools) {
      const available = new Set(nativeTools.filter(tool => this.options.toolAllowed?.(tool.name) !== false
        && (toolMode !== "codemode" || tool.name === DOTS_TASK_END || (tool.callers?.includes("tools") ?? true)))
        .map(tool => tool.name));
      if (toolMode === "codemode") available.add(this.codemode.name);
      await verifyTools(available);
    }
    // Request-context hooks come from the same extension factories as the tools; they are re-installed
    // together so a refreshed tool set can never keep a stale (or dropped) context rewrite.
    if (contextHooks) this.options.contextHooks = [...contextHooks];
    if (extensions) this.options.foregroundHooks = foregroundHooks;
    if (toolHooks) this.options.toolHooks = toolHooks;
    if (model) {
      const resolved = this.options.models.getModel(model.provider, model.modelId);
      this.modelWindow = resolved?.contextWindow ?? this.modelWindow;
      this.modelOutputLimit = resolved?.maxTokens;
      this.modelKeyCache = `${model.provider}/${model.modelId}`;
    }
    if (extensions || contextHooks) {
      this.nativeTools = nativeTools;
      const available = this.nativeTools;
      this.codemode = createDurableCodeMode(() => available.filter(tool =>
        (tool.callers?.includes("tools") ?? true) && this.options.toolAllowed?.(tool.name) !== false), this.options.assets, join(this.options.directory, "images"), async (code, context) => {
        const tools = await this.options.prepareCodeMode?.(code, context) ?? [];
        this.installCompatibility(tools);
        return tools;
      });
      this.installExtension();
    }
    this.options.toolMode = toolMode;
    const tools = this.nativeTools.filter(tool => this.options.toolAllowed?.(tool.name) !== false);
    await this.conversation.configure({
      ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
      maxTurns: this.options.maxTurns,
      tools: toolMode === "codemode" ? [...tools, this.codemode] : tools,
      modelTools: toolMode === "codemode" ? [this.codemode, ...tools.filter(tool => tool.name === DOTS_TASK_END)] : null,
    }, ctx);
  }

  /** 重新安装扩展：重建 native 工具后，hooks 与工具必须和同一份注册表一起生效。 */
  private installExtension(): void {
    const names = new Set(this.nativeTools.map(tool => tool.name));
    const registered = [...this.nativeTools, ...this.compatibilityTools.filter(tool => !names.has(tool.name))];
    this.registry.install(botExtension(this.options, this.storage, registered, this.codemode,
      (id, message) => this.recordResponse(id, message),
      (code, context, conversationId) => this.prewarmCodeMode(code, context, conversationId), () => this.evidence,
      (call, api, context) => this.recordSkillRead(call, api, context), (id, context) => this.harness.getTask(id, context),
      (conversationId, context) => this.contextManagerFor(conversationId, context), this.harness.commit.bind(this.harness)));
  }

  /** Harness settings getter 的同步窗口来源；未知时返回 0，让策略回退保守值。 */
  currentModelWindow(): number { return this.modelWindow; }
  currentModelKey(): string | undefined { return this.modelKeyCache; }

  /** 工具 schema 的保守 token 估算：压力判断必须计入工具定义，否则会低估出站请求。 */
  private toolTokenCache = 0;
  private toolTokenCacheKey = "";
  estimateNativeToolTokens(): number {
    const key = `${this.nativeTools.length}:${this.nativeTools.map(tool => tool.name).join(",")}`;
    if (key !== this.toolTokenCacheKey) {
      this.toolTokenCacheKey = key;
      try {
        this.toolTokenCache = estimateTextTokens(JSON.stringify(this.nativeTools.map(tool => ({
          name: tool.name, description: tool.description, parameters: tool.parameters,
        }))));
      } catch {
        this.toolTokenCache = 8_000;
      }
    }
    return this.toolTokenCache;
  }

  /** 上下文管理真实状态；未启用时返回 undefined（UI/服务层不得伪造）。 */
  contextManagementStatus(): ContextManagementStatusDto | undefined { return this.contextManager?.statusSnapshot() ?? this.passiveContextStatus; }

  /** 当前设置的引擎：native = Pi 原生按比例压缩；billion-context = 内嵌分层摘要。 */
  currentCompactionEngine(): ContextManagementEngine {
    const configured = this.options.contextManagement?.engine?.();
    if (configured === "native") return "native";
    return this.options.contextManagement ? "billion-context" : "native";
  }

  /**
   * 每个 conversation 一份协调器：主会话用构造时那份；子代理/会诊按身份懒创建并缓存。
   * 其他私有会话（Code Mode 内部 conversation）没有子代理身份，不接管。
   */
  private contextManagerFor(conversationId: Conversation["id"], context: Context): Promise<DurableContextManager | undefined> {
    if (!this.contextManager || !this.options.contextManagement) return Promise.resolve(undefined);
    const key = String(conversationId);
    if (key === String(this.conversation.id)) return Promise.resolve(this.contextManager);
    const cached = this.childManagers.get(key);
    if (cached) return cached;
    const created = (async (): Promise<DurableContextManager | undefined> => {
      try {
        const conversation = await this.harness.conversation(conversationId, context);
        if (!conversation) return undefined;
        const [subagent, consult] = await Promise.all([
          this.harness.snapshot(DurableSubagentIdentity, conversationId, context),
          this.harness.snapshot(DurableConsultIdentity, conversationId, context),
        ]);
        if (!subagent?.value && !consult?.key) return undefined;
        const agent = await conversation.agent(context);
        const model = agent.model ? this.options.models.getModel(agent.model.provider, agent.model.modelId) : undefined;
        const window = model?.contextWindow ?? this.modelWindow;
        const manager: DurableContextManager = new DurableContextManager({
          conversation, models: this.options.models, archiveReader: this.harness,
          initialState: await this.harness.snapshot(DurableContextStateDoc, conversationId, context) as DurableContextPersistedState | undefined,
          policy: this.options.contextManagement!.policy,
          engine: () => this.currentCompactionEngine(),
          contextWindow: () => window,
          outputReserveTokens: () => model?.maxTokens,
          ...(agent.model ? { modelKey: () => `${agent.model!.provider}/${agent.model!.modelId}` } : {}),
          toolEstimateTokens: this.options.contextManagement!.toolEstimateTokens ?? (() => this.estimateNativeToolTokens()),
          log: (message, error) => console.warn(message, error ?? ""),
        });
        this.ownedChildManagers.add(manager);
        return manager;
      } catch (error) {
        console.warn("[Durable] 子会话上下文管理初始化失败，该会话沿用 Pi 原生压缩", error);
        return undefined;
      }
    })();
    this.childManagers.set(key, created);
    return created;
  }

  /** 设置里的压缩阈值变化后：Harness getter 每轮重读，这里刷新状态投影并推送一次。 */
  refreshContextPolicy(): void {
    const status = this.contextManager?.statusSnapshot();
    if (status) {
      try { this.options.contextManagement?.onStatus?.(status); }
      catch (error) { console.warn("[Durable] 上下文管理状态推送失败", error); }
    }
  }

  resume(): void { this.assertSessionHealthy(); this.harness.resume(); }

  async recoverRevokedGoal(): Promise<void> {
    const verify = this.options.verifyGoalContinuation;
    const taskId = this.options.taskId;
    if (!verify || !taskId) return;
    const conversation = this.conversation;
    const run = (await this.harness.snapshot(LiveDoc, conversation.id, ctx))?.run;
    let pending = (await this.harness.snapshot(RevokedGoalRecovery, conversation.id, ctx))?.pending;
    if (run) {
      if (run.inputs.length !== 1 || run.afterRun) return;
      const submission = await this.storage.submission(run.inputs[0], ctx);
      if (submission?.type !== "input" || !submission.requestId?.startsWith("goal-continuation:")) return;
      try {
        await assertDurableGoalContinuation(taskId, this.storage, { conversationId: conversation.id,
          snapshot: this.harness.snapshot.bind(this.harness) }, ctx, verify);
        return;
      } catch (error) {
        if (!(error instanceof CoreGoalContinuationRevokedError)) throw error;
      }
      pending = await conversation.commit(async tx => {
        const observed = (await tx.doc(LiveDoc, conversation.id)).run;
        if (!observed || observed.taskId !== run.taskId || observed.inputs.length !== 1 || observed.inputs[0] !== run.inputs[0]) return;
        const exact = { runTaskId: run.taskId, inputId: run.inputs[0] };
        (await tx.doc(RevokedGoalRecovery, conversation.id)).pending = exact;
        return exact;
      }, ctx);
    }
    if (!pending) return;
    const exact = pending;
    const bounded = { ...ctx, abortSignal: AbortSignal.timeout(10_000) };
    if (run) {
      await this.harness.abortTask(exact.runTaskId, bounded);
      await this.harness.waitForTask(exact.runTaskId, bounded);
    }
    await conversation.commit(async tx => {
      const live = await tx.doc(LiveDoc, conversation.id);
      const recovery = await tx.doc(RevokedGoalRecovery, conversation.id);
      if (live.run?.taskId === exact.runTaskId || recovery.pending?.runTaskId !== exact.runTaskId
        || recovery.pending.inputId !== exact.inputId) return;
      if (live.run || live.runFailure?.taskId !== exact.runTaskId || live.runFailure.inputs.length !== 1
        || live.runFailure.inputs[0] !== exact.inputId) {
        recovery.pending = null;
        return;
      }
      const queued = (await tx.doc(InboxDoc, conversation.id)).items.filter(item => item.mode !== "write");
      for (const item of queued) {
        const data = item.entry?.data;
        const input = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
        if (!input || typeof input !== "object" || Array.isArray(input)) continue;
        const requestId = input.inputRequestId;
        if (input.goalContinuation || input.gatewayOrigin || input.botRequestId
          || typeof requestId === "string" && /^(?:goal-continuation:|dots-input-)/.test(requestId)) {
          recovery.pending = null;
          return;
        }
      }
      if (queued.length) await conversation.submit(tx, { type: "continue", requestId: `mybuddy:resume-inputs-after-revoked-goal:${exact.runTaskId}` });
      recovery.pending = null;
    }, bounded);
  }
  private installCompatibility(tools: readonly ToolRegistration[]): void {
    if (!tools.length) return;
    const compatibility = new Map(this.compatibilityTools.map(tool => [tool.name, tool]));
    for (const tool of tools) compatibility.set(tool.name, tool);
    this.compatibilityTools = [...compatibility.values()];
    this.installExtension();
  }
  /** Install Code Mode's dynamically discovered tools before the nested ToolTask freezes its registry snapshot. */
  private async prewarmCodeMode(code: string, context: Parameters<ToolRegistration["execute"]>[2], conversationId = this.conversation.id): Promise<void> {
    const tools = await this.options.prepareCodeMode?.(code, context) ?? [];
    if (!tools.length) return;
    this.installCompatibility(tools);
    const conversation = conversationId === this.conversation.id ? this.conversation : await this.harness.conversation(conversationId, context);
    if (!conversation) throw new Error("Code Mode conversation is unavailable");
    const agent = await conversation.agent(context);
    const callable = new Map([...agent.callable, ...agent.tools].map(tool => [tool.name, tool]));
    for (const tool of tools) if (this.options.toolAllowed?.(tool.name) !== false) callable.set(tool.name, tool);
    await conversation.configure({ tools: [...callable.values()] }, context);
  }

  get snapshot(): DurableBotSnapshot { return this.latest; }
  inputMetadata(entryId: number): DurableInputMetadata | undefined { return this.metadataByEntry.get(entryId); }

  /** Query native state before changing a task identity; UI idle alone is not a boundary. */
  async isIdle(): Promise<boolean> {
    const snapshot = await this.refresh();
    return !snapshot.busy && snapshot.queued === 0;
  }

  /** Root idle is insufficient: include child tasks, queues and pending regeneration. */
  async canRebindWorkspace(): Promise<boolean> {
    this.assertSessionHealthy();
    return this.options.waitingForInput?.() !== true && await canRebindDurableWorkspace(this.harness, ctx);
  }

  /**
   * Every terminal provider message: keep its completion clock and, when the stream was observed,
   * settle the host-side generation clock with the authoritative `usage.output`.
   * pi never timestamps `LiveState.generation`, so this observed stream is the only real speed source.
   */
  private async recordResponse(taskId: number, message: AssistantMessage): Promise<void> {
    const completedAt = Date.now();
    const metrics = this.generationTimings.get(taskId)?.timing.finalize(message.usage?.output ?? 0, completedAt);
    this.generationTimings.delete(taskId);
    await this.conversation.commit(async tx => {
      const timing = await tx.doc(ResponseTiming, this.conversation.id);
      const key = `${taskId}:${message.timestamp}`;
      timing.completed[key] ??= completedAt;
      // Nothing measured (never observed, or a failed attempt with no output) → keep the doc honest.
      if (!metrics || (metrics.tps === null && metrics.ttftMs === null)) return;
      timing.speed ??= {};
      // A retried attempt appends its own message with its own timestamp, so this write replaces only
      // a replay of the same terminal message.
      timing.speed[key] = { tps: metrics.tps, ttftMs: metrics.ttftMs };
    }, ctx);
  }

  /**
   * Feed one observed live generation. A generation appears before pi requests the provider
   * (`live.generation = { attempt }`), then its throttled partial arrives on later commits;
   * a retried attempt bumps `attempt`, which restarts the clock.
   */
  private observeGeneration(taskId: number, attempt: number, message: AssistantMessage | undefined, now: number): { attempt: number; timing: GenerationTiming } {
    let entry = this.generationTimings.get(taskId);
    if (!entry || entry.attempt !== attempt) {
      entry = { attempt, timing: new GenerationTiming(now) };
      this.generationTimings.set(taskId, entry);
      // Timings of tasks whose terminal response never reached afterResponse (abort/fault) must not accumulate.
      if (this.generationTimings.size > 4) for (const id of [...this.generationTimings.keys()]) if (id !== taskId) this.generationTimings.delete(id);
    }
    if (message) entry.timing.observe(generationContentTokens(message.content), now);
    return entry;
  }

  private async recordSkillRead(call: Parameters<ToolHooks["afterTool"]>[0], api: HookApi, context: Parameters<ToolRegistration["execute"]>[2]): Promise<void> {
    if (typeof call.arguments.path !== "string") return;
    const path = call.arguments.path;
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const userMessageIds: string[] = [];
    for (const id of live?.run?.inputs ?? []) {
      const receipt = await this.storage.submission(id, context);
      const entry = receipt?.entry && await api.entry(receipt.entry, context);
      const data = entry && entry.data;
      const input = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
      const audit = input && typeof input === "object" && !Array.isArray(input) ? durableInputAuditSchema.safeParse(input.audit) : undefined;
      if (audit?.success) userMessageIds.push(audit.data.userMessageId);
    }
    if (!userMessageIds.length) return;
    const conversation = await this.harness.conversation(api.conversationId, context);
    if (conversation) await conversation.commit(tx => tx.appendEntry(api.conversationId, { kind: "mybuddy.skill-read",
      data: { callId: call.id, path, userMessageIds, at: Date.now() } }), context);
  }

  private async reconcileAuditReceipts(): Promise<void> {
    if (this.options.readOnly) return;
    for (const [requestId, audit] of this.pendingAuditInputs) {
      const receipt = await this.storage.submissionByRequest(this.conversation.id, requestId, ctx);
      if (!receipt || (receipt.status !== "done" && receipt.status !== "unanswered")) continue;
      const outcome = receipt.status === "done" ? "completed" : receipt.reason === "aborted" ? "aborted" : "failed";
      await this.conversation.commit(async tx => {
        const state = await tx.doc(AuditReceipts, this.conversation.id);
        if (state.settled[requestId] !== undefined) return;
        const stored = await tx.appendEntry(this.conversation.id, { kind: "mybuddy.input-outcome",
          data: { userMessageId: requestId, assistantMessageId: audit.assistantMessageId, outcome, at: Date.now() } });
        state.settled[requestId] = stored.id;
      }, ctx);
      // The watch consumes this marker after all earlier read evidence. Receipt state may be newer than this view.
      this.pendingAuditInputs.delete(requestId);
    }
  }

  dotsInputVersion() {
    return this.conversation.commit(tx => dotsInputVersion(tx, this.conversation.id), ctx);
  }

  async appendDotsReply(reply: DotsAssistantReply, isCurrent: () => boolean, outboxEventKey?: string) {
    if (this.options.readOnly || this.options.taskId !== DOTS_TASK_ID) throw new Error("Dots 交付只能写入原生 Dots 会话");
    const origin = reply.origin?.conversationId;
    const destination = origin !== undefined && origin !== this.conversation.id
      ? await this.harness.conversation(origin as typeof this.conversation.id, ctx)
      : this.conversation;
    if (!destination) return { status: "discarded" } as const;
    const outcome = await appendDurableDotsReply(destination, reply, isCurrent, outboxEventKey);
    if ("reply" in outcome && destination.id === this.conversation.id) await this.refresh();
    return outcome;
  }

  async appendDotsProactive(key: string, text: string, isCurrent: () => boolean) {
    if (this.options.readOnly || this.options.taskId !== DOTS_TASK_ID) throw new Error("主动消息只能写入 Dots 会话");
    const outcome = await appendDurableDotsProactive(this.conversation, key, text, isCurrent);
    if (outcome.status !== "pending") await this.refresh();
    return outcome;
  }

  async submit(content: UserInput, requestId: string, whenBusy: "steer" | "followUp" | "reject" = "followUp", metadata?: BotInputMetadata, mark?: (stage: string) => void, requireActiveRun = false, guard?: { inputVersion?: string; validate(): void | Promise<void> }) {
    this.assertSessionHealthy();
    try {
      const draft = { type: "input" as const, content, requestId, whenBusy, ...(requireActiveRun ? { whenIdle: "reject" as const } : {}),
        ...(metadata ? { entry: { kind: "mybuddy.user", data: { mybuddyInput: { ...metadata, inputRequestId: requestId } } } } : {}),
      };
      const submitGuarded = async () => {
        const id = await this.conversation.commit(async tx => {
          if (requireActiveRun) {
            const live = await tx.doc(LiveDoc, this.conversation.id);
            if (!live.run || live.run.afterRun) throw new DotsIntentChanged("原任务已收尾，改向未接收");
          }
          if (guard?.inputVersion && await dotsInputVersion(tx, this.conversation.id) !== guard.inputVersion)
            throw new DotsIntentChanged("原任务已有新的用户要求，本次跟进未派发");
          await guard?.validate();
          return this.conversation.submit(tx, draft);
        }, ctx);
        const accepted = await this.harness.submission(id, ctx);
        if (!accepted) throw new Error("任务跟进回执不存在");
        return accepted;
      };
      const submission = (guard || requireActiveRun) ? await submitGuarded() : await this.conversation.submit(draft, ctx);
      mark?.("committed");
      await this.refresh();
      mark?.("projected");
      return submission;
    } catch (error) {
      return await this.normalizeFailure(error);
    }
  }

  async refresh(): Promise<DurableBotSnapshot> {
    if (this.closeState.kind !== "open") return this.latest;
    this.assertSessionHealthy();
    // Keep the single-writer lease fresh; a stale lease only matters after an unclean shutdown.
    this.lease?.heartbeat();
    // Serialize presentation reads only. Durable alone schedules execution.
    const projection = this.projection.then(async () => {
      if (this.closeState.kind !== "open" || this.failed) return;
      await this.project(this.watch.value);
    });
    this.projection = projection.catch(() => {});
    try {
      await projection;
    } catch (error) {
      return await this.normalizeFailure(error);
    }
    return this.latest;
  }

  /**
   * 读取一段更早历史的独立块（不改变实时窗口，也不写 latest）。
   *
   * 一页 50 条 entry 里可能有 0 条可见消息（toolResult / context-import / skill-read 都不产行），
   * 所以空页时继续向前读，最多 4 轮；扫到最老仍为空则返回空块与 before=undefined。
   */
  async loadHistoryBlock(beforeEntryId: number, limit = 50): Promise<DurableHistoryBlock> {
    if (!Number.isSafeInteger(beforeEntryId) || beforeEntryId < 1) throw new Error("Invalid history cursor");
    const size = Math.max(1, Math.min(200, Math.floor(limit)));
    await this.projection;
    const metadata = new Map<number, BotInputMetadata>();
    const timing = await this.harness.snapshot(ResponseTiming, this.conversation.id, ctx);
    const history = new DurableHistoryProjection();
    let before: number | undefined = beforeEntryId;
    for (let round = 0; round < 4 && before !== undefined; round++) {
      const page = await this.conversation.entries({ maxEntryId: before as EntryId, order: "descending" }, size + 1, undefined, ctx);
      const entries = page.items.slice(0, size).filter(entry => entry.kind !== "mybuddy.context-import");
      await this.loadInputMetadata(entries, metadata);
      await this.mergeHistory(history, entries, metadata, timing);
      before = page.items[size]?.id;
      if (history.messages.length) break;
    }
    await this.completeHistoryTools(history, beforeEntryId, metadata);
    return { historyId: this.historyId, before, messages: history.messages };
  }

  /**
   * 把孤立的工具结果接回它的调用行。
   *
   * 窗口按条数保留（默认最新 50 条），一次 25 分钟的子代理派发里，调用行（对话开头那条
   * assistant）会被后续条目挤出窗口，结果行却落在窗口内。`applyResult` 找不到 owner 就返回，
   * 于是“八个子代理全部完成”这条结果在界面上完全不存在（顶栏只剩后来单派发的那一个）。
   *
   * 这里从结果 entry 向前扫，找到包含这些 toolCallId 的 entry 后补成普通行；结果随后由
   * `merge` 的 assistant 分支 apply 回去。扫描有界，且同一 callId 只扫一次（失败不重试）。
   */
  private async mendOrphanToolCalls(): Promise<boolean> {
    const orphans = this.history.orphanToolCalls().filter(orphan => !this.orphanScans.has(orphan.entryId));
    if (orphans.length === 0) return false;
    const wanted = new Set(orphans.filter(orphan => !orphan.ownerId).map(orphan => orphan.callId));
    const found: EntryRecord[] = [];
    const owners = new Set(orphans.flatMap(orphan => orphan.ownerId ? [Number(orphan.ownerId.slice(8))] : []));
    for (const owner of owners) {
      if (!Number.isSafeInteger(owner)) continue;
      const record = await this.storage.entry(this.conversation.id, owner as EntryId, ctx);
      if (record) found.push(record.entry);
    }
    let before: EntryId | undefined = Math.min(...orphans.map(orphan => orphan.entryId)) as EntryId;
    let scanned = 0;
    while (wanted.size > 0 && before !== undefined && before > 1 && scanned < ORPHAN_CALL_SCAN_ENTRIES) {
      const page = await this.conversation.entries({ maxEntryId: (before - 1) as EntryId, order: "descending" }, 100, undefined, ctx);
      const items = page.items.filter(entry => entry.kind !== "mybuddy.context-import");
      if (items.length === 0) break;
      scanned += items.length;
      for (const entry of items) {
        for (const message of entry.model ?? []) {
          if (message.role !== "assistant") continue;
          for (const part of message.content) if (part.type === "toolCall" && wanted.has(part.id)) { found.push(entry); wanted.delete(part.id); }
        }
      }
      before = items.at(-1)?.id as EntryId | undefined;
    }
    for (const orphan of orphans) this.orphanScans.add(orphan.entryId);
    if (found.length === 0) return false;
    await this.loadInputMetadata(found, this.metadataByEntry);
    await this.mergeHistory(this.history, found, this.metadataByEntry);
    return true;
  }

  private async historyEntries(history: DurableHistoryProjection, entries: readonly EntryRecord[]): Promise<EntryRecord[]> {
    const fresh = entries.filter(entry => !history.has(entry.id));
    return Promise.all(fresh.map(entry => entry.model?.some(m => m.role === "toolResult" && m.toolName === "pstack_delegate")
      ? recoverChildMeasurements(entry, this.storage, this.harness, ctx, this.options.observedUsage)
      : entry));
  }

  private async mergeHistory(history: DurableHistoryProjection, entries: readonly EntryRecord[], metadata: Map<number, BotInputMetadata>,
    timing?: { completed?: Readonly<Record<string, number>>; speed?: Readonly<Record<string, DurableResponseSpeed>> }) {
    const fresh = await this.historyEntries(history, entries);
    const dotsEntries = new Set<number>();
    const recoveredReplies = new Map<number, string>();
    const isDots = this.options.isDotsWorkerInput;
    if (isDots) {
      const ordered = fresh.slice().sort((a, b) => a.id - b.id);
      const isUser = (entry: EntryRecord) => entry.kind === "mybuddy.user" || entry.kind === "pi.user";
      let user: EntryRecord | undefined;
      let scannedBefore = false;
      let hasDelegation: boolean | undefined;
      for (const entry of ordered) {
        if (isUser(entry)) { user = entry; continue; }
        const message = entry.model?.find(item => item.role === "assistant");
        if (!message) continue;
        const text = contentText(message.content);
        const workerOutcome = readDotsWorkerOutcome(text);
        const narrative = message.stopReason === "stop" ? recoverDotsNarrativeReply(text) : undefined;
        if (!workerOutcome && narrative === undefined) continue;
        const known = history.priorUser(entry.id);
        if (known && known.id > (user?.id ?? 0)) user = known;
        if (!user && !scannedBefore) {
          scannedBefore = true;
          let cursor: Cursor | undefined;
          do {
            const page = await this.conversation.entries({ maxEntryId: (entry.id - 1) as EntryId, order: "descending" }, 80, cursor, ctx);
            user = page.items.find(isUser);
            cursor = page.next;
          } while (!user && cursor);
          if (user) await this.loadInputMetadata([user], metadata);
        }
        const input = user && metadata.get(user.id);
        const requestId = input?.inputRequestId;
        if (workerOutcome && requestId && isDots(requestId)) dotsEntries.add(entry.id);
        if (narrative !== undefined && allowsDotsReplyRecovery(input)
          && (hasDelegation ??= this.options.hasDotsDelegation?.() ?? false)) recoveredReplies.set(entry.id, narrative);
      }
    }
    return history.merge(fresh, metadata, timing?.completed ?? {}, timing?.speed ?? {}, dotsEntries, recoveredReplies);
  }

  /** Results outside a window update its tool rows without adding intervening messages. */
  private async completeHistoryTools(history: DurableHistoryProjection, afterEntryId: number, metadata: Map<number, BotInputMetadata>) {
    const unresolved = new Map<string, Set<string>>();
    for (const row of history.messages) for (const tool of row.tools ?? []) {
      if (tool.status !== "running") continue;
      const owners = unresolved.get(tool.id) ?? new Set<string>();
      owners.add(row.id);
      unresolved.set(tool.id, owners);
    }
    let cursor: Cursor | undefined;
    while (unresolved.size) {
      const later = await this.conversation.entries({ minEntryId: (afterEntryId + 1) as EntryId, order: "ascending" }, 100, cursor, ctx);
      for (const entry of later.items) {
        const matches = new Map<string, string>();
        const results = entry.model?.filter(message => {
          if (message.role !== "toolResult") return false;
          const owner = toolMessageReceipt(message, entry)?.assistantMessageId ?? history.ownerId(message.toolCallId);
          if (!owner || !unresolved.get(message.toolCallId)?.has(owner)) return false;
          matches.set(message.toolCallId, owner);
          return true;
        });
        if (results?.length) {
          history.merge(await this.historyEntries(history, [{ ...entry, model: results }]), metadata, {});
          for (const [callId, owner] of matches) {
            const owners = unresolved.get(callId)!;
            owners.delete(owner);
            if (!owners.size) unresolved.delete(callId);
          }
        }
      }
      if (!later.next) break;
      cursor = later.next;
    }
  }

  async loadHistoryWindow(target: TaskHistoryTarget): Promise<DurableHistoryBlock> {
    if (typeof target === "number") return this.loadHistoryBlock(target);
    const entryId = "aroundEntryId" in target ? target.aroundEntryId : target.afterEntryId;
    if (!Number.isSafeInteger(entryId) || entryId < 1) throw new Error("Invalid history anchor");
    await this.projection;
    const around = "aroundEntryId" in target;
    const earlier = around
      ? await this.conversation.entries({ maxEntryId: entryId as EntryId, order: "descending" }, 26, undefined, ctx)
      : { items: [] };
    if (around && earlier.items[0]?.id !== entryId) throw new Error("历史消息不属于当前分支，请刷新后重试");
    const later = await this.conversation.entries({ minEntryId: (entryId + 1) as EntryId, order: "ascending" }, around ? 26 : 51, undefined, ctx);
    const size = around ? 25 : 50;
    const entries = [...earlier.items.slice(0, 25).reverse(), ...later.items.slice(0, size)]
      .filter(entry => entry.kind !== "mybuddy.context-import");
    const metadata = new Map<number, BotInputMetadata>();
    await this.loadInputMetadata(entries, metadata);
    const timing = await this.harness.snapshot(ResponseTiming, this.conversation.id, ctx);
    const history = new DurableHistoryProjection();
    await this.mergeHistory(history, entries, metadata, timing);
    await this.completeHistoryTools(history, entries.at(-1)?.id ?? entryId, metadata);
    return { historyId: this.historyId, before: earlier.items[25]?.id, after: later.items[size]?.id === undefined ? undefined : later.items[size - 1]?.id,
      messages: history.messages };
  }

  /**
   * 完整会话里的可续读提问页，按最近到最早扫描，每页最多处理 2000 entries、返回 200 问。
   *
   * 实时窗口最多保留 DURABLE_HISTORY_ENTRY_LIMIT 条 entry，历史提问弹窗不能只
   * 依赖窗口（否则长会话里只剩最近一条提问）。这里只读扫描已提交 entry，按
   * 与投影相同的 id / displayText 口径返回，id 可直接用于消息滚动定位。
   */
  async loadUserQuestions(query: TaskUserQuestionsQuery = {}): Promise<TaskUserQuestionsDto> {
    await this.projection;
    if (query.historyId !== undefined && query.historyId !== this.historyId) throw new Error("历史分支已变化，请重新打开提问列表");
    if (query.beforeEntryId !== undefined && (!Number.isSafeInteger(query.beforeEntryId) || query.beforeEntryId < 1)) throw new Error("Invalid question cursor");
    const questions: Array<{ id: string; text: string }> = [];
    const metadata = new Map<number, BotInputMetadata>();
    let before = query.beforeEntryId;
    let scanned = 0;
    do {
      const page = await this.conversation.entries({ order: "descending", ...(before === undefined ? {} : { maxEntryId: before as EntryId }) }, 501, undefined, ctx);
      const entries = page.items.slice(0, 500);
      const users = entries.filter(entry => entry.kind === "pi.user" || entry.kind === "mybuddy.user");
      await this.loadInputMetadata(users, metadata);
      for (const [index, entry] of entries.entries()) {
        scanned++;
        if (entry.kind !== "pi.user" && entry.kind !== "mybuddy.user") continue;
        const message = entry.model?.find(item => item.role === "user");
        if (!message) continue;
        const text = metadata.get(entry.id)?.displayText ?? contentText(message.content);
        if (!text.trim()) continue;
        questions.push({ id: `durable-${entry.id}`, text });
        if (questions.length >= 200) return { historyId: this.historyId, questions: questions.reverse(), nextBefore: page.items[index + 1]?.id };
      }
      before = page.items[500]?.id;
    } while (before !== undefined && scanned < 2000);
    return { historyId: this.historyId, questions: questions.reverse(), nextBefore: before };
  }

  /**
   * 会话开头的前 N token（用户/助手文本），供 AI 命名等一次性任务读取。
   * 只读扫描 committed entries，按最老 entry 开始累计；工具/上下文导入不参与。
   */
  async loadHistoryHead(maxTokens = 1024): Promise<string> {
    await this.projection;
    const parts: string[] = [];
    let estimated = 0;
    let cursor: Cursor | undefined;
    let scanned = 0;
    do {
      const page = await this.conversation.entries({ order: "ascending" }, 200, cursor, ctx);
      for (const entry of page.items) {
        if (entry.kind !== "pi.user" && entry.kind !== "mybuddy.user" && entry.kind !== "pi.assistant") continue;
        for (const message of entry.model ?? []) {
          if (message.role !== "user" && message.role !== "assistant") continue;
          const text = contentText(message.content).trim();
          if (!text) continue;
          parts.push(`${message.role === "user" ? "用户" : "助手"}：${text}`);
          estimated += estimateTextTokens(text);
          if (estimated >= maxTokens) return parts.join("\n\n");
        }
      }
      cursor = page.next;
      scanned += page.items.length;
    } while (cursor && scanned < 4000);
    return parts.join("\n\n");
  }

  /** The service releases and reopens after this atomic branch switch. */
  async forkAt(entryId?: number): Promise<string> {
    if (entryId !== undefined && (!Number.isSafeInteger(entryId) || entryId < 1)) throw new Error("Invalid conversation entry");
    return String((await forkDurableConversation(this.harness, this.conversation, entryId as EntryId | undefined, ctx)).id);
  }

  async newDotsConversation(workspace: string): Promise<void> {
    await forkDurableConversation(this.harness, this.conversation, undefined, ctx, { dotsWorkspace: workspace });
  }

  async regeneration(): Promise<DurableRegenerationState | undefined> {
    return (await this.harness.snapshot(ActiveDurableConversation, ctx))?.regeneration;
  }

  private async replayChildUsage(): Promise<void> {
    if (!this.options.onEntries) return;
    try {
      let cursor: Cursor | undefined;
      do {
        const page = await this.storage.scanConversations({}, 100, cursor, ctx);
        for (const record of page.items) {
          if (!(await this.harness.snapshot(DurableSubagentIdentity, record.id, ctx))?.value && !(await this.harness.snapshot(DurableConsultIdentity, record.id, ctx))?.key) continue;
          const conversation = await this.harness.conversation(record.id, ctx);
          if (!conversation) continue;
          let next: Cursor | undefined;
          do {
            const entries = await conversation.entries({ order: "ascending" }, 500, next, ctx);
            this.options.onEntries(entries.items.filter(entry => entry.byTaskId !== undefined), { conversationId: String(record.id), sourceKind: "subagent" });
            next = entries.next;
          } while (next);
        }
        cursor = page.next;
      } while (cursor);
    } catch (error) { console.warn("[Durable] Child usage recovery failed", error); }
  }

  /** Native fork and the prepared input persist together; reopening admits the input once. */
  async forkForRegeneration(entryId: number | undefined, input: DurableRegenerationInput): Promise<string> {
    if (!input.operationId.trim()) throw new Error("重新生成缺少操作身份");
    if (entryId !== undefined && (!Number.isSafeInteger(entryId) || entryId < 1)) throw new Error("Invalid conversation entry");
    return String((await forkDurableConversation(this.harness, this.conversation, entryId as EntryId | undefined, ctx, { regeneration: input })).id);
  }

  /** Only submission admission is retried, under the original request ID; execution remains native. */
  async resumeRegeneration(): Promise<Submission | undefined> {
    const state = await this.regeneration();
    if (!state) return undefined;
    if (state.kind === "admitted") return this.harness.submission(state.submissionId, ctx);
    const input = state.input;
    const submissionId = await this.conversation.commit(async tx => {
      const active = await tx.doc(ActiveDurableConversation);
      if (active.conversationId !== this.conversation.id || active.regeneration?.kind !== "pending" || active.regeneration.input.operationId !== input.operationId) throw new Error("重新生成输入归属已变化");
      const id = await this.conversation.submit(tx, { type: "input", content: input.content, requestId: input.operationId,
        ...(input.metadata ? { entry: { kind: "mybuddy.user", data: { mybuddyInput: { ...input.metadata, inputRequestId: input.operationId } } } } : {}),
      });
      active.regeneration = { kind: "admitted", operationId: input.operationId, submissionId: id };
      return id;
    }, ctx);
    const submission = await this.harness.submission(submissionId, ctx);
    if (!submission) throw new Error("重新生成回执不存在");
    await this.refresh();
    return submission;
  }

  private async loadInputMetadata(entries: readonly EntryRecord[], target = this.metadataByEntry): Promise<void> {
    for (const entry of entries) {
      const data = entry.data;
      const input = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
      if (!input || typeof input !== "object" || Array.isArray(input)
        || typeof input.text !== "string" || typeof input.displayText !== "string" || !Array.isArray(input.attachments)) continue;
      const attachments = input.attachments.flatMap(item => item && typeof item === "object" && !Array.isArray(item)
        && typeof item.name === "string" && typeof item.path === "string" ? [{ name: item.name, path: item.path }] : []);
      const audit = durableInputAuditSchema.safeParse(input.audit);
      const gatewayOrigin = gatewayBotOriginSchema.omit({ workTarget: true }).safeParse(input.gatewayOrigin);
      const rawContinuation = input.goalContinuation;
      const intentRevision = rawContinuation && typeof rawContinuation === "object" && !Array.isArray(rawContinuation)
        ? Number(rawContinuation.intentRevision) : NaN;
      const attempt = rawContinuation && typeof rawContinuation === "object" && !Array.isArray(rawContinuation)
        ? Number(rawContinuation.attempt) : NaN;
      const goalContinuation = rawContinuation && typeof rawContinuation === "object" && !Array.isArray(rawContinuation)
        && typeof rawContinuation.workId === "string" && Number.isSafeInteger(intentRevision) && Number.isSafeInteger(attempt)
        ? { workId: rawContinuation.workId, intentRevision, attempt }
        : undefined;
      target.set(entry.id, { text: input.text, displayText: input.displayText, attachments,
        ...(typeof input.inputRequestId === "string" ? { inputRequestId: input.inputRequestId } : {}),
        ...(typeof input.botRequestId === "string" ? { botRequestId: input.botRequestId } : {}), ...(audit.success ? { audit: audit.data } : {}),
        ...(goalContinuation ? { goalContinuation } : {}), ...(gatewayOrigin.success ? { gatewayOrigin: gatewayOrigin.data } : {}) });
    }
  }

  private async consumerEntries(value: ConversationView, fresh: readonly EntryRecord[]): Promise<EntryRecord[]> {
    if (!this.options.onEntries && !this.options.onTurns) return [];
    const tail = value.entries.at(-1)?.id;
    if (tail === undefined) return [];
    let entries: EntryRecord[];
    if (this.consumerCursor === undefined) {
      // Projection checkpoints can lag a crash. Catch up consumers once without expanding the visible window.
      entries = [];
      let cursor: Cursor | undefined;
      do {
        const page = await this.conversation.entries({ minEntryId: ((this.options.projectionAfterEntryId ?? 0) + 1) as EntryId, maxEntryId: tail, order: "ascending" }, 500, cursor, ctx);
        entries.push(...page.items); cursor = page.next;
      } while (cursor);
    } else entries = fresh.filter(entry => entry.id > this.consumerCursor!);
    this.consumerCursor = tail;
    return entries.filter(entry => entry.kind !== "mybuddy.context-import"
      && (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data) || (entry.data.mybuddyImported !== true && entry.data.inherited !== true)));
  }

  /** The answer belongs to this receipt even if another turn has already started or failed. */
  async reply(submission: Submission, options?: { requireText?: boolean; context?: Context }): Promise<string> {
    this.assertSessionHealthy();
    const callContext = options?.context ?? ctx;
    try {
      const settled = await submission.wait(callContext);
      if (settled.status === "unanswered") {
        if (settled.reason === "turn_limit") throw new DurableReplyError(DURABLE_TURN_LIMIT_MESSAGE);
        throw new DurableReplyError(settled.reason === "aborted" ? "任务已取消" : `Durable 未完成回复：${typeof settled.detail === "string" ? settled.detail : settled.reason}`);
      }
      if (settled.type !== "input") throw new Error("Gateway 需要用户输入回执");
      const record = await this.storage.entry(this.conversation.id, settled.answer, callContext);
      const message = record?.entry.model?.find(item => item.role === "assistant");
      if (!message) throw new Error("Durable 回复记录不存在");
      if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
        throw new Error(message.errorMessage || `Durable 回复未完成：${message.stopReason}`);
      }
      const text = (contentText(message.content) + deepseekCitationMarkdown(message)).trim();
      if (!text && options?.requireText) throw new DurableReplyError("接收方未产生文本回复");
      return text || "任务已处理，但未产生文本回复。";
    } catch (error) {
      return await this.normalizeFailure(error);
    }
  }

  /** Stop only the native work visible at capture. Later submissions and generations
   * belonging to a different run remain independently runnable. */
  async stopObservedRun(inputVersion?: string, stopChildren?: () => Promise<void>): Promise<"intent_changed" | void> {
    const conversation = this.conversation;
    const observed = await conversation.commit(async tx => {
      if (inputVersion !== undefined && await dotsInputVersion(tx, conversation.id) !== inputVersion) return;
      const live = await tx.doc(LiveDoc, conversation.id);
      const inbox = await tx.doc(InboxDoc, conversation.id);
      return { run: live.run && { taskId: live.run.taskId, first: live.run.first, inputs: [...live.run.inputs] },
        queued: inbox.items.filter(item => item.mode !== "write").map(item => item.id) };
    }, ctx);
    if (!observed) return "intent_changed";
    const stopQueued = observed.queued.map(async id => (await this.harness.submission(id, ctx))?.abort(ctx));
    const stopActive = async () => {
      let run = observed.run;
      while (run) {
        await this.harness.abortTask(run.taskId, ctx);
        const next = (await this.harness.snapshot(LiveDoc, conversation.id, ctx))?.run;
        if (!next || next.taskId === run.taskId || !(run.first !== undefined && next.first === run.first ||
          next.inputs.some(id => run!.inputs.includes(id)))) break;
        run = { taskId: next.taskId, first: next.first, inputs: next.inputs };
      }
    };
    await Promise.all([...stopQueued, stopActive(), stopChildren?.()]);
    await this.refresh();
  }

  async abort(): Promise<void> {
    this.assertSessionHealthy();
    try {
      await this.conversation.abort(ctx, { background: true });
      await this.refresh();
    } catch (error) {
      return await this.normalizeFailure(error);
    }
  }

  /**
   * 手动“立即整理上下文”。BC 启用时由它做真实的分层摘要；BC 不可用或明确失败时回退原生压缩。
   * 返回值必须区分 completed 与 skipped，并把真实前后口径交给服务层。
   */
  async compact(): Promise<DurableCompactionOutcome> {
    this.assertSessionHealthy();
    const beforeTokens = this.latest?.contextUsage?.usedTokens ?? undefined;
    if (this.contextManager && this.currentCompactionEngine() === "billion-context") {
      try {
        const outcome = await this.contextManager.compressNow(ctx);
        if (outcome.applied || !outcome.skippedReason?.includes("失败")) {
          await this.refresh();
          return { ...outcome, ...(outcome.beforeTokens === undefined && beforeTokens !== undefined ? { beforeTokens } : {}) };
        }
      } catch (error) {
        console.warn("[Durable] BC 手动整理失败，回退原生压缩", error);
      }
    }
    try {
      const id = await this.conversation.compact(undefined, ctx);
      const result = await this.harness.waitForTask(id, ctx);
      if (result.state.outcome.status !== "completed") throw new Error(`Durable 压缩${result.state.outcome.status}`);
      const payload = result.state.outcome.result;
      const submissionId = payload.submissionId;
      if (submissionId) await (await this.harness.submission(submissionId, ctx))?.wait(ctx);
      this.contextManager?.markNativeCompaction();
      await this.contextManager?.nativeCompactionCommitted(ctx);
      await this.refresh();
      const applied = payload.entryId !== undefined || payload.submissionId !== undefined;
      const afterTokens = this.latest?.contextUsage?.usedTokens ?? undefined;
      return {
        applied, engine: "native",
        ...(beforeTokens !== undefined ? { beforeTokens } : {}),
        ...(afterTokens !== undefined ? { afterTokens } : {}),
        estimated: true,
        ...(payload.entryId !== undefined ? { entryId: payload.entryId } : {}),
        ...(applied ? {} : { skippedReason: "没有可压缩的历史" }),
      };
    } catch (error) {
      return await this.normalizeFailure(error);
    }
  }

  async abortCompaction(): Promise<boolean> {
    this.assertSessionHealthy();
    // 内嵌引擎的手动整理不是 Durable task：先取消它的摘要调用，再检查原生 manual compaction。
    if (this.contextManager?.cancelMaintenance()) { await this.refresh(); return true; }
    const live = await this.harness.snapshot(LiveDoc, this.conversation.id, ctx);
    const manual = live?.compactions?.filter(compaction => compaction.trigger === "manual") ?? [];
    for (const compaction of manual) await this.harness.abortTask(compaction.taskId, ctx);
    await this.refresh();
    return manual.length > 0;
  }

  /** Read-only historical context export for an independent task branch. */
  contextBranchAt(conversationId: Conversation["id"], entryId: EntryId) {
    return captureContextBranchAt(this.storage, conversationId, entryId, ctx);
  }

  close(): Promise<void> {
    if (this.closeState.kind === "closed") return Promise.resolve();
    if (this.closeState.kind === "closing") return this.closeState.completion;
    const completion = Promise.resolve().then(async () => {
      try { await this.watch?.stop(); }
      catch (error) { if (!this.failed) throw error; }
      await Promise.allSettled([...this.children.values()].map(watch => watch.stop()));
      await this.projection.catch(() => {});
      await this.options.drainTaskProjection?.();
      // 关闭前把节流中的上下文状态强制落盘一次（失败只影响跨重启恢复）。
      try {
        await this.contextManager?.flush(ctx);
        for (const manager of this.ownedChildManagers) await manager.flush(ctx);
      } catch (error) { console.warn("[Durable] Context state flush before close failed", error); }
      // close checkpoints pending work; abort would permanently cancel it.
      await this.harness.close(ctx);
      // Keep ownership and retryable resources until the underlying close succeeds.
      this.evidence?.dispose();
      this.contextManager?.dispose();
      for (const manager of this.ownedChildManagers) manager.dispose();
      this.ownedChildManagers.clear();
      this.childManagers.clear();
      this.lease?.release();
    }).then(() => {
      this.closeState = { kind: "closed" };
    }, (error: unknown) => {
      this.closeState = { kind: "retry" };
      throw error;
    });
    this.closeState = { kind: "closing", completion };
    return completion;
  }

  /**
   * Recovered nested calls of an interrupted Code Mode run have no details.calls and no live slot: read the caller
   * task's NestedCallDoc members and project the ones without a result as interrupted errors.
   */
  private async projectInterruptedNested(
    owner: ChatMessageDto,
    message: Extract<Message, { role: "toolResult" }>,
    toolTaskId: TaskId,
    tools: Map<string, NonNullable<ChatMessageDto["tools"]>[number]>,
  ): Promise<void> {
    let found = false;
    for (let index = 1; index <= 32; index++) {
      const key = String(index);
      let state;
      try { state = await this.harness.snapshot(NestedCallDoc, toolTaskId, key, ctx); }
      catch { break; }
      if (!state) break;
      found = true;
      if (state.result) continue;
      let name = "nested";
      let args: unknown = {};
      const nestedTaskId = state.taskId;
      if (nestedTaskId !== undefined) {
        try {
          const task = await this.harness.getTask(nestedTaskId, ctx);
          const input = task?.input as { kind?: string; call?: { name?: string; arguments?: unknown } } | undefined;
          if (input?.kind === "nested" && input.call) {
            name = input.call.name ?? name;
            args = input.call.arguments ?? {};
          }
        } catch { /* A retired or unreadable task still projects as interrupted. */ }
      }
      this.pushInterruptedRow(owner, message, tools, key, name, args);
    }
    // The caller's NestedCallDoc retires with its task, so an interrupted call may leave only its error result.
    if (!found) this.pushInterruptedRow(owner, message, tools, undefined, "nested", {});
  }

  private pushInterruptedRow(
    owner: ChatMessageDto,
    message: Extract<Message, { role: "toolResult" }>,
    tools: Map<string, NonNullable<ChatMessageDto["tools"]>[number]>,
    key: string | undefined,
    name: string,
    args: unknown,
  ): void {
    const row: NonNullable<ChatMessageDto["tools"]>[number] = {
      id: `${message.toolCallId}:nested:interrupted${key ? ":" + key : ""}`,
      parentToolCallId: message.toolCallId,
      tool: name,
      summary: summarizeToolInput(name, args).summary,
      status: "error",
      output: "",
    };
    tools.set(row.id, row);
    if (!owner.tools?.some(item => item.id === row.id)) (owner.tools ??= []).push(row);
  }

  /**
   * 本轮 run 的起点时间：以 `live.run.first`（本轮第一个 entry 的 id）为准，窗口外也能按 id 读回；
   * 读不到才退回投影里见过的用户条目，最后退回观测时刻。
   *
   * 不能用投影窗口里的用户条目单独决定：窗口只有最新 50~100 条 entry，长任务里用户条目早被挤出去，
   * 重开会话后起点变 undefined，实时占位行拿到 `createdAt: 0`，渲染层把它当任务时间 → 侧栏「20774 天」。
   */
  private async resolveRunStart(live: LiveState, now: number): Promise<number | undefined> {
    const run = live.run;
    if (!run) return activityTimeOrUndefined(this.history.turnStartedAt);
    if (this.runStarted?.taskId === run.taskId) return this.runStarted.at;
    let fromEntry: number | undefined;
    if (run.first !== undefined) {
      const page = await this.conversation.entries({ minEntryId: run.first, maxEntryId: run.first, order: "ascending" }, 1, undefined, ctx);
      fromEntry = latestActivityTime(...(page.items[0]?.model ?? []).map(message => message.timestamp));
    }
    const at = fromEntry ?? activityTimeOrUndefined(this.history.turnStartedAt) ?? now;
    this.runStarted = { taskId: run.taskId, at };
    return at;
  }

  private async dotsWorkerCompleted(entries: readonly EntryRecord[]): Promise<boolean> {
    const isWorkerInput = this.options.isDotsWorkerInput;
    if (!isWorkerInput) return false;
    const final = [...entries].reverse().find(entry => entry.model?.some(message => message.role === "assistant" || message.role === "user"));
    if (!final?.model?.some(message => message.role === "assistant" && message.stopReason === "toolUse"
        && message.content.some(part => part.type === "toolCall" && part.name === DOTS_TASK_END))) return false;
    const conversationId = this.conversation.id;
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanSubmissions({ conversationId, order: "descending" }, 50, cursor, ctx);
      const input = page.items.find(item => item.type !== "write");
      if (input) {
        if (input.type !== "input" || input.status !== "done" || input.answer !== final.id
            || !input.requestId || !isWorkerInput(input.requestId)) return false;
        return this.conversation.commit(async tx => {
          const live = await tx.doc(LiveDoc, conversationId);
          const inbox = await tx.doc(InboxDoc, conversationId);
          if (live.run || live.runFailure || live.compactions?.length || inbox.items.length) return false;
          return (await readDurableDotsTerminal(tx, input, final))?.action === "complete";
        }, ctx);
      }
      cursor = page.next;
    } while (cursor);
    return false;
  }

  private async project(value: ConversationView): Promise<void> {
    if (this.closeState.kind !== "open" || this.failed) return;
    // One observation clock for this revision: the same `now` feeds the stream clocks and the retry countdown.
    const now = Date.now();
    const entries = value.entries.filter(entry => entry.kind !== "mybuddy.context-import");
    if (this.history.oldest === undefined || !Number.isFinite(this.history.oldest)) this.historyBefore = value.before;
    // A stalled observer may receive a window beyond the last delivered entry. Fill only that gap.
    const newest = this.history.newest;
    if (newest !== undefined && value.before !== undefined && value.before > newest) {
      let cursor: Cursor | undefined;
      do {
        const page = await this.conversation.entries({ minEntryId: (newest + 1) as EntryId, maxEntryId: value.before, order: "ascending" }, 100, cursor, ctx);
        entries.unshift(...page.items.filter(entry => entry.kind !== "mybuddy.context-import")); cursor = page.next;
      } while (cursor);
    }
    const live = (value.docs["pi.live"] ?? {}) as LiveState;
    const timing = entries.some(entry => !this.history.has(entry.id)) ? await this.harness.snapshot(ResponseTiming, this.conversation.id, ctx) : undefined;
    await this.loadInputMetadata(entries);
    const fresh = await this.mergeHistory(this.history, entries, this.metadataByEntry, timing);
    // 长耗时工具的调用行可能已在窗口外：只补回 owner 行，否则结果（含子代理的 8 条记录）
    // 会被 `applyResult` 静默丢弃，界面上这次调用从此不存在。
    await this.mendOrphanToolCalls();
    const activeCalls = new Set([...(live.tools ?? []).map(slot => slot.callId), ...(live.nestedTools ?? []).map(slot => slot.parentCallId)]);
    const evictedBefore = this.history.trim(activeCalls);
    if (evictedBefore !== undefined) this.historyBefore = evictedBefore as EntryId;
    const messages = this.history.messages.slice();
    const tools = new Map<string, NonNullable<ChatMessageDto["tools"]>[number]>();
    // Historical rows stay immutable. Only rows with active tools or a live generation need copies.
    const activeRows = new Set([...activeCalls].map(id => this.history.ownerId(id)).filter((id): id is string => id !== undefined));
    const generationId = this.history.presentationId(`durable-generation-${live.run?.taskId}`);
    if (generationId) activeRows.add(generationId);
    for (const id of activeRows) {
      const index = this.history.index(id);
      if (index === undefined) continue;
      const row = messages[index];
      messages[index] = { ...row, projectionVersion: undefined, tools: row.tools?.map(tool => ({ ...tool })) };
      for (const tool of messages[index].tools ?? []) tools.set(tool.id, tool);
    }
    const childIds = new Map(this.history.children);
    const nestedEntries = new Map<number, EntryRecord[]>();
    let error = this.history.error;
    let outcome = this.history.outcome;
    const turnStartedAt = await this.resolveRunStart(live, now);
    for (const item of this.history.interrupted.splice(0)) {
      const index = this.history.index(item.ownerId);
      if (index === undefined) continue;
      const owner = { ...messages[index], tools: messages[index].tools?.map(tool => ({ ...tool })) };
      await this.projectInterruptedNested(owner, item.message, item.toolTaskId, tools);
      const saved = this.history.replace(owner);
      messages[index] = { ...saved, projectionVersion: undefined, tools: saved.tools?.map(tool => ({ ...tool })) };
    }
    if (live.run && live.generation?.message) {
      const inputId = live.run.inputs.at(-1);
      const body = contentText(live.generation.message.content);
      const narrative = recoverDotsNarrativeReply(body, true);
      let dotsWorker = false;
      let recoveredReply: string | undefined;
      if (this.options.isDotsWorkerInput && inputId !== undefined &&
        (this.options.hasDotsDelegation?.() || narrative !== undefined || /^\s*(?:\{|\x60)/u.test(body))) {
        if (this.liveDotsInput?.id !== inputId) {
          const input = await this.storage.submission(inputId, ctx);
          const requestId = input?.type === "input" ? input.requestId : undefined;
          const worker = Boolean(requestId && this.options.isDotsWorkerInput(requestId));
          let recoverNarrative = false;
          if (!worker && input?.type === "input" && input.entry !== undefined && this.options.hasDotsDelegation?.()) {
            if (!this.metadataByEntry.has(input.entry)) {
              const user = await this.storage.entry(input.conversationId, input.entry, ctx);
              if (user) await this.loadInputMetadata([user.entry]);
            }
            recoverNarrative = allowsDotsReplyRecovery(this.metadataByEntry.get(input.entry));
          }
          this.liveDotsInput = { id: inputId, operationId: worker ? requestId : undefined, recoverNarrative };
        }
        dotsWorker = Boolean(this.liveDotsInput.operationId);
        if (this.liveDotsInput.recoverNarrative) recoveredReply = narrative;
      }
      const row = assistantRow(`durable-live-${live.run.taskId}`, live.run.taskId, live.generation.message, undefined, turnStartedAt, true, undefined, dotsWorker, recoveredReply);
      if (dotsWorker && this.liveDotsInput?.operationId)
        row.dotsWorkerOutput = { operationId: this.liveDotsInput.operationId, generationId: live.run.taskId };
      messages.push(row);
      for (const tool of row.tools ?? []) tools.set(tool.id, tool);
    }
    if (live.run) {
      const key = `durable-generation-${live.run.taskId}`;
      const currentIndex = generationId ? this.history.index(generationId) : undefined;
      let current = currentIndex !== undefined ? messages[currentIndex] : messages.at(-1)?.presentationKey === key ? messages.at(-1) : undefined;
      if (!current) {
        current = { id: `durable-live-${live.run.taskId}`, presentationKey: key, role: "assistant", text: "", createdAt: turnStartedAt ?? now };
        messages.push(current);
      }
      current.streaming = true;
      current.durationMs = undefined;
      // Durable's attempt counts the initial one too; Pi's retry counter counts retries only.
      const liveAttempt = live.generation?.attempt;
      const liveRetry = live.generation?.retry;
      const phase = liveRetry ? "retrying" as const : live.compactions?.some(item => item.blocking) ? "compacting" as const
        : live.tools?.length ? "tools" as const : live.generation?.message ? "generating" as const : "waiting" as const;
      // pi's live generation has no timestamps: this refresh observes the attempt and its throttled
      // partial, so the host keeps the stream clock. `updatedAt` only advances when output grew —
      // a silent model must keep saying "等待输出", not pretend to be streaming.
      const observed = liveAttempt === undefined ? undefined
        : this.observeGeneration(live.run.taskId, liveAttempt, live.generation?.message, now).timing.snapshot(now);
      const streamedTps = phase === "generating" ? observed?.tps ?? null : null;
      // `startedAt` stays the reply-level clock the renderer reads for "等待 Ns"; TTFT is measured against
      // this attempt's own observation (`generation-timing.ts`), never the user message timestamp.
      current.generationStats = { phase,
        startedAt: turnStartedAt ?? current.createdAt, updatedAt: observed?.updatedAt ?? current.createdAt,
        // Same convention as the native `GenerationSpeedTracker`: a generating request carries an estimate
        // (null until there is enough output to publish one); a settled reply carries the measured average.
        tps: streamedTps, estimated: phase === "generating",
        // `outputTokens` is the authoritative total only; a stream has none yet.
        outputTokens: null, ttftMs: observed?.ttftMs ?? null,
        ...(liveAttempt !== undefined ? { attempts: liveAttempt } : {}),
        ...(liveRetry ? { retry: { attempt: Math.max(1, (liveAttempt ?? 2) - 1), error: liveRetry.error,
          delayMs: Math.max(0, liveRetry.at - now) } } : {}) };
    }
    for (const slot of live.tools ?? []) {
      const tool = tools.get(slot.callId);
      if (tool) {
        tool.output = slot.output ?? tool.output;
        if (slot.details !== undefined) {
          tool.detail = JSON.stringify(slot.details);
          tool.capabilityResult = capabilityResultFromDetails(slot.name, slot.details) ?? tool.capabilityResult;
          tool.webSearch = searchReportFromDetails(slot.details) ?? tool.webSearch;
          tool.consult = consultReportFromDetails(slot.details) ?? tool.consult;
        }
        if (slot.status !== "done") tool.status = "running";
      }
      const details = slot.details as { conversationId?: number; calls?: readonly NestedCallDetail[] } | undefined;
      if (details?.conversationId && slot.name === "codemode") childIds.set(slot.callId, details.conversationId);
      const ownerIndex = this.history.index(this.history.ownerId(slot.callId) ?? "");
      const owner = ownerIndex === undefined ? messages.at(-1)?.tools?.some(item => item.id === slot.callId) ? messages.at(-1) : undefined : messages[ownerIndex];
      if (slot.name === "codemode" && details?.calls && owner) for (const [index, call] of details.calls.entries()) {
        const row = nestedToolRow(slot.callId, call, index);
        tools.set(row.id, row);
        if (!owner.tools!.some(item => item.id === row.id)) owner.tools!.push(row);
      }
    }
    for (const slot of live.nestedTools ?? []) {
      const ownerIndex = this.history.index(this.history.ownerId(slot.parentCallId) ?? "");
      const owner = ownerIndex === undefined ? undefined : messages[ownerIndex];
      if (!owner) continue;
      // Pi's live summary intentionally carries only its projection of the exact nested result.
      const status = slot.status === "done" ? durableToolStatus(slot.summary ?? {}) : "running" as const;
      const text = summarizeToolInput(slot.name, slot.arguments);
      const row: NonNullable<ChatMessageDto["tools"]>[number] = { id: slot.callId, parentToolCallId: slot.parentCallId, tool: slot.name,
        summary: text.summary, ...(text.detail === undefined ? {} : { detail: text.detail }), status, output: slot.output ?? slot.summary?.error ?? "",
        capabilityResult: capabilityResultFromDetails(slot.name, slot.details), webSearch: searchReportFromDetails(slot.details), consult: consultReportFromDetails(slot.details) };
      tools.set(row.id, row);
      const index = owner.tools!.findIndex(item => item.id === row.id);
      if (index < 0) owner.tools!.push(row); else owner.tools![index] = row;
    }
    for (const [parentId, childId] of childIds) {
      const index = this.history.index(this.history.ownerId(parentId) ?? "");
      if (index === undefined) continue;
      let watch = this.children.get(childId);
      let cached = this.nestedHistory.get(childId);
      if (!watch && cached) { nestedEntries.set(childId, cached.entries); continue; }
      if (!watch) {
        const child = await this.harness.conversation(childId as Conversation["id"], ctx);
        if (!child) continue;
        watch = await child.watch(ctx); this.children.set(childId, watch);
        watch.start(async () => { await this.refresh(); });
      }
      cached ??= { entries: [], toolsByAssistant: new Map(), latestToolByCall: new Map() };
      const added = watch.value.entries.filter(entry => entry.id > (cached.newest ?? 0));
      if (added.length) {
        cached.entries.push(...added); cached.newest = added.at(-1)?.id;
        this.nestedHistory.set(childId, cached);
        const base = this.history.row(messages[index].id) ?? messages[index];
        const owner = { ...base, tools: base.tools?.map(tool => ({ ...tool })) ?? [] };
        const childTools = new Map(owner.tools.map(tool => [tool.id, tool]));
        for (const entry of added) for (const message of entry.model ?? []) {
          if (message.role === "assistant") for (const call of message.content) {
            if (call.type !== "toolCall") continue;
            const assistantId = `durable-${entry.id}`;
            const byCall = cached.toolsByAssistant.get(assistantId) ?? new Map<string, string>();
            if (byCall.has(call.id)) continue;
            const id = childTools.has(call.id) ? `${assistantId}:${call.id}` : call.id;
            byCall.set(call.id, id);
            cached.toolsByAssistant.set(assistantId, byCall);
            cached.latestToolByCall.set(call.id, id);
            const text = summarizeToolInput(call.name, call.arguments);
            const tool = { id, parentToolCallId: parentId, tool: call.name, summary: text.summary,
              ...(text.detail === undefined ? {} : { detail: text.detail }), status: "running" as const };
            childTools.set(id, tool); owner.tools.push(tool);
          }
          if (message.role === "toolResult") {
            const receipt = toolMessageReceipt(message, entry);
            const id = receipt ? cached.toolsByAssistant.get(receipt.assistantMessageId)?.get(message.toolCallId)
              : cached.latestToolByCall.get(message.toolCallId);
            const tool = id === undefined ? undefined : childTools.get(id);
            if (tool) {
              tool.status = durableToolStatus(message, { conversationId: entry.conversationId,
                toolTaskId: entry.byTaskId, callId: message.toolCallId, toolName: message.toolName }); tool.output = contentText(message.content);
              tool.capabilityResult = capabilityResultFromDetails(message.toolName, message.details);
              tool.webSearch = searchReportFromDetails(message.details); tool.consult = consultReportFromDetails(message.details);
            }
          }
        }
        const saved = this.history.replace(owner);
        messages[index] = activeRows.has(saved.id) ? { ...messages[index], projectionVersion: undefined, tools: saved.tools?.map(tool => ({ ...tool })) } : saved;
      }
      nestedEntries.set(childId, cached.entries);
      if ((tools.get(parentId) ?? messages[index].tools?.find(tool => tool.id === parentId))?.status !== "running") { await watch.stop(); this.children.delete(childId); }
    }
    const inbox = value.docs["pi.inbox"] as InboxState | undefined;
    const busy = Boolean(live.run || live.compactions?.length);
    const agent = await this.conversation.agent(ctx);
    const model = agent.model && this.options.models.getModel(agent.model.provider, agent.model.modelId);
    const ledger = value.docs["pi.usage"] as UsageState | undefined;
    const totals = Object.values(ledger?.models ?? {}).reduce((sum, usage) => ({
      input: sum.input + usage.input, output: sum.output + usage.output,
      cacheRead: sum.cacheRead + usage.cacheRead, cacheWrite: sum.cacheWrite + usage.cacheWrite,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    for (const entry of fresh) {
      if (entry.head) this.contextTokens = null;
      // Dots deliveries are stored as assistant messages without model usage.
      if (entry.kind !== "pi.assistant") continue;
      const assistant = entry.model?.find(message => message.role === "assistant");
      if (!assistant) continue;
      const { input, cacheRead, cacheWrite, output } = assistant.usage;
      const tokens = input + cacheRead + cacheWrite + output;
      if (Number.isFinite(tokens) && tokens > 0) this.contextTokens = tokens;
    }
    const usedTokens = this.contextTokens;
    const queued = inbox?.items?.length ?? 0;
    if (live.runFailure && !live.run) {
      outcome = live.runFailure.reason === "aborted" || live.runFailure.reason === "reset" ? "aborted" : "failed";
      if (outcome === "aborted") error = undefined;
      else error = live.runFailure.reason === "turn_limit" ? DURABLE_TURN_LIMIT_MESSAGE : live.runFailure.detail ?? live.runFailure.reason;
    } else if (!busy && !queued && !outcome && await this.dotsWorkerCompleted(entries)) {
      outcome = "completed";
    }
    const waitingForInput = this.options.waitingForInput?.() === true || [...live.tools ?? [], ...live.nestedTools ?? []].some(slot => slot.status !== "done"
      && (slot.name === "request_user_input" || (slot.details && typeof slot.details === "object" && !Array.isArray(slot.details) && slot.details.waitingForInput === true)));
    const status: DurableBotSnapshot["status"] = waitingForInput ? "waiting_input" : live.generation?.retry ? "retrying"
      : busy ? "running" : queued ? "queued" : outcome === "failed" ? "failed" : outcome === "aborted" ? "stopped" : outcome === "completed" ? "completed" : "idle";
    const snapshot: DurableBotSnapshot = { backend: "pi-durable", epoch: this.epoch, historyId: this.historyId, revision: ++this.revision,
      conversationId: String(this.conversation.id), toolMode: this.options.toolMode,
      busy, queued, status, historyBefore: this.historyBefore, messages, ...(error ? { error } : {}),
      // 本轮起点与「投影见过的最新消息时间」取大：与行、与窗口无关，也永不是 0。
      activityAt: latestActivityTime(turnStartedAt, this.history.observedAt),
      pendingInputs: (inbox?.items ?? []).flatMap(item => {
        if (item.mode === "write") return [];
        const data = item.entry?.data;
        const input = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
        return [{ id: String(item.id), mode: item.mode,
          inputRequestId: input && typeof input === "object" && !Array.isArray(input) && typeof input.inputRequestId === "string" ? input.inputRequestId : undefined,
          text: input && typeof input === "object" && !Array.isArray(input) && typeof input.displayText === "string" ? input.displayText : contentText(item.content) }];
      }),
      retry: live.generation?.retry, compacting: Boolean(live.compactions?.length),
      outcome: busy ? undefined : outcome,
      ...(model ? { contextUsage: { usedTokens, estimated: usedTokens !== null, contextWindow: model.contextWindow,
        percent: usedTokens === null ? null : usedTokens / model.contextWindow * 100,
        // 观测值只补它确实知道的字段；null 不能覆盖账本算出的计数/命中率。
        ...mergeContextUsage({ inputTokens: totals.input, outputTokens: totals.output,
          cacheReadTokens: totals.cacheRead, cacheWriteTokens: totals.cacheWrite },
          this.options.observedUsage?.(String(this.conversation.id))) } } : {}),
    };
    if (this.options.prepareSnapshot) {
      if (this.closeState.kind !== "open" || this.failed) return;
      await this.options.prepareSnapshot(snapshot);
      if (this.closeState.kind !== "open" || this.failed) return;
    }
    this.latest = snapshot;
    this.options.onSnapshot(snapshot);
    const evidenceEntries = await this.consumerEntries(value, fresh);
    if (evidenceEntries.length) {
      await this.loadInputMetadata(evidenceEntries);
      for (const entry of evidenceEntries) {
        const audit = this.metadataByEntry.get(entry.id)?.audit;
        if (audit) this.pendingAuditInputs.set(audit.userMessageId, audit);
      }
      if (this.options.onDotsProgress && this.options.isDotsWorkerInput) {
        try {
          for (const entry of evidenceEntries) {
            if (entry.kind !== DOTS_ARTIFACT_KIND) continue;
            const data = durableArtifactRegistrationSchema.safeParse(entry.data);
            const id = data.success ? data.data.inputIds.at(-1) : undefined;
            if (id === undefined) continue;
            const artifact = registeredDotsArtifact(entry, id, undefined, this.options.directory);
            if (!artifact) continue;
            const input = await this.storage.submission(id as Parameters<Storage["submission"]>[0], ctx);
            if (input?.type === "input" && input.requestId && this.options.isDotsWorkerInput(input.requestId))
              this.options.onDotsProgress(input.requestId, JSON.stringify([artifact.path, artifact.digest]), artifact.registeredAt);
          }
        } catch (error) { console.warn("[Durable] Dots progress observation failed", error); }
      }
      try { this.options.onEntries?.(evidenceEntries, { conversationId: String(this.conversation.id), sourceKind: "main" }); }
      catch (error) { console.warn("[Durable] Usage projection failed", error); }
      await this.reconcileAuditReceipts();
      if (this.options.onTurns) {
        this.pendingTurnEntries.push(...evidenceEntries);
        try {
          const turns = durableCompletedTurns(this.options.taskId ?? this.options.directory, String(this.conversation.id), this.pendingTurnEntries, nestedEntries, this.metadataByEntry, this.options.isDelegatedMemoryInput);
          if (turns.length) {
            await this.options.onTurns(turns);
            const consumed = turns.at(-1)!.entryId;
            this.pendingTurnEntries = this.pendingTurnEntries.filter(entry => entry.id > consumed);
          }
        } catch (error) { console.warn("[Durable] Memory projection failed; committed entries remain recoverable", error); }
      }
    }
    if (!evidenceEntries.length && !snapshot.busy) await this.reconcileAuditReceipts();
    const pendingIds = new Set<number>(this.pendingTurnEntries.map(entry => entry.id));
    for (const id of this.metadataByEntry.keys()) if (!this.history.has(id) && !pendingIds.has(id)) this.metadataByEntry.delete(id);
    const retainedChildren = new Set(this.history.children.values());
    for (const id of this.nestedHistory.keys()) if (!retainedChildren.has(id)) this.nestedHistory.delete(id);
    for (const [id, child] of this.children) if (!retainedChildren.has(id)) { await child.stop(); this.children.delete(id); }
    await this.options.onProjected?.(snapshot);
  }
}

/**
 * Durable leaves the platform shell tool opt-in：Windows 额外暴露 PowerShell 的原生 argv 执行
 * （两个 Tag 都生效），Linux/macOS 复用 CodingTools 自带的 bash。
 * 平台判定见 `platform/shell-tools.ts`（业务侧不再直接判断 process.platform）。
 */
function codingTools(directory: string, readonlyShell?: () => boolean): ToolRegistration[] {
  return [
    ...(CodingTools.tools ?? []).map(tool => {
      if (tool.name === "write") return createWriteTool(admittedFileMutationPath);
      if (tool.name === "edit") return createEditTool(admittedFileMutationPath);
      if (tool.name === "read") return withWindowsBashWorkspacePath(withMissingFileRecovery(withDurableFileReadEvidence(withDurableImageRead(tool))));
      return withDurableArtifactRegistration(tool, directory);
    }),
    ...createPlatformShellTools().map(tool => withDurableArtifactRegistration(tool, directory)),
    withWindowsBashWorkspacePath(createDurableArtifactRegistrationTool(directory)),
  ].map(withShellTerminalGuidance);
}

async function durableExecutionEnv(target: EnvTarget, context: Context, rootCwd: string): Promise<DurableExecutionEnv> {
  const cwd = await resolveDurableExecutionCwd(target, context, rootCwd);
  if (!statSync(cwd).isDirectory()) throw new Error("任务工作目录失效，请修复项目目录后继续");
  return new DurableExecutionEnv({ cwd, shellPath: getAgentBashShellPath(cwd, getMyBuddyDir()) });
}

/** Every native generation, including retries and compaction, uses the owning task's settings. */
const modelUsageEvidence = new WeakMap<Models, WeakMap<AbortSignal, ProviderUsageEvidence>>();
type RequestGuard = (providerMessages?: readonly Message[]) => void | Promise<void>;
const modelRequestGuards = new WeakMap<Models, WeakMap<AbortSignal, RequestGuard>>();
const goalModelRequests = new WeakMap<Models, WeakSet<AbortSignal>>();
const recoveryToolRequests = new WeakMap<Models, WeakMap<AbortSignal, DotsRecoveryToolScope>>();

/**
 * Durable has no AgentSession, so a task invocation's abort signal identifies its model requests and the
 * task kind identifies the operation. This is the same signal-keyed contract as `modelRequestGuards`.
 */
function traceBoundary(api: HookApi, operation: CacheTraceOperation): () => CacheTraceBoundary {
  return () => ({ sessionId: String(api.conversationId), operation });
}

function taskScopedModels(models: Models, cwd: string,
  taskId?: string,
  onProviderUsage?: DurableBotOptions["onProviderUsage"], beforeProviderRequest?: DurableBotOptions["beforeProviderRequest"],
  nextCompactionRequest?: () => Promise<number>, providerAuthorityGuarded?: () => boolean,
  verifyCompaction?: (sessionId: string | undefined, signal?: AbortSignal) => Promise<void>): Models {
  const settings = createAgentSettingsManager(cwd, getMyBuddyDir());
  const guards = new WeakMap<AbortSignal, RequestGuard>();
  const goalRequests = new WeakSet<AbortSignal>();
  const recoveryTools = new WeakMap<AbortSignal, DotsRecoveryToolScope>();
  const evidence = new WeakMap<AbortSignal, ProviderUsageEvidence>();
  const scoped = new Proxy(models, { get(target, key) {
    if (key === "getModel") return (provider: string, id: string) => target.getModel(provider === "azure-openai-responses" ? "azure" : provider, id);
    if (key === "streamSimple") return (...args: Parameters<Models["streamSimple"]>) => {
      // Pi passes the generation invocation signal to both its hooks and streamSimple.
      const signal = args[2]?.signal;
      const validate = signal ? guards.get(signal) : undefined;
      // Pi deliberately swallows extension-hook errors. Authority checks must live outside that
      // chain, in the provider's awaited payload transform, before any HTTP send.
      const options = args[2];
      const observed=emptyUsageEvidence();if(signal)evidence.set(signal,observed);
      const scope = signal && recoveryTools.get(signal);
      const input = scope
        ? {
          ...args[1],
          tools: args[1].tools?.filter(tool => dotsRecoveryAllowsTool(scope, tool.name)),
          messages: args[1].messages.map(message => message.role === "system" && (message.toolsAdded || message.toolsRemoved)
            ? {
              ...message,
              toolsAdded: message.toolsAdded?.filter(tool => dotsRecoveryAllowsTool(scope, tool.name)),
              toolsRemoved: message.toolsRemoved?.filter(tool => dotsRecoveryAllowsTool(scope, tool.name)),
            }
            : message),
        }
        : args[1];
      return startGuardedModelStream(args[0], signal, async () => {
        await validate?.(input.messages);
        signal?.throwIfAborted();
        return withModelInvocationSettings(settings, () => target.streamSimple(args[0], input, {
          ...options,
          ...(signal && goalRequests.has(signal) ? { deferred: false } : {}),
          ...(supportsUsageObservation(args[0].api)?{fetch:withUsageEvidence(options?.fetch??globalThis.fetch,observed,args[0].api)}:{}),
          ...durableAuthorityRequestOptions(args[0].api, Boolean(beforeProviderRequest)),
          onPayload: async (payload, model) => {
            const replacement = await options?.onPayload?.(payload, model);
            signal?.throwIfAborted();
            await beforeProviderRequest?.();
            signal?.throwIfAborted();
            await validate?.();
            signal?.throwIfAborted();
            return replacement;
          },
        }), validate);
      });
    };
    if (key === "completeSimple") return async (...args: Parameters<Models["completeSimple"]>) => {
      // Pi's compaction task is the harness's only completeSimple caller. A summarization resumed from its
      // `summarize` checkpoint never reruns `beforeCompact`, so keep the operation its call form proves
      // instead of letting that request join the unbound chain with a generation request.
      const signal = args[2]?.signal;
      await beforeProviderRequest?.();
      await verifyCompaction?.(args[2]?.sessionId, signal);
      signal?.throwIfAborted();
      const generationTaskId = -(await nextCompactionRequest!());
      // Separate persisted IDs from legacy per-open negative counters.
      const conversationId = `${String(args[2]?.sessionId ?? "")}:compaction-v2`;
      const observed=emptyUsageEvidence();
      const result = await withModelInvocationSettings(settings, () => target.completeSimple(args[0], args[1], {
        ...args[2],
        ...(supportsUsageObservation(args[0].api)?{fetch:withUsageEvidence(args[2]?.fetch??globalThis.fetch,observed,args[0].api)}:{}),
        ...durableAuthorityRequestOptions(args[0].api, Boolean(beforeProviderRequest)),
        onPayload: async (payload, model) => {
          const replacement = await args[2]?.onPayload?.(payload, model);
          signal?.throwIfAborted();
          await beforeProviderRequest?.();
          await verifyCompaction?.(args[2]?.sessionId, signal);
          signal?.throwIfAborted();
          return replacement;
        },
      }), undefined,
        requestTraceBoundary(signal) ?? (() => ({ operation: "compact" })));
      const message = result as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; stopReason?: string };
      if (message.usage) onProviderUsage?.({ taskId, conversationId, generationTaskId, usageEvidence:{...observed},usagePresence:usagePresence(observed),
        reported: message.stopReason !== "error" && message.stopReason !== "aborted",
        inputTokens: message.usage.input ?? 0, outputTokens: message.usage.output ?? 0,
        cacheReadTokens: message.usage.cacheRead ?? 0, cacheWriteTokens: message.usage.cacheWrite ?? 0 });
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? (...args: unknown[]) => withModelInvocationSettings(settings, () => value.apply(target, args)) : value;
  } });
  modelRequestGuards.set(scoped, guards);
  goalModelRequests.set(scoped, goalRequests);
  recoveryToolRequests.set(scoped, recoveryTools);
  modelUsageEvidence.set(scoped,evidence);
  return scoped;
}

/** Hidden transport retries must not outlive task lifecycle checks. */
export function durableAuthorityRequestOptions(_api: string, lifecycleChecked: boolean) {
  // Keep each retry visible to task cancellation/stop checks. This is not approval.
  return lifecycleChecked ? { maxRetries: 0 } : {};

}

function botExtension(
  options: DurableBotOptions,
  storage: Storage,
  native: readonly ToolRegistration[],
  codemode: ToolRegistration,
  recordResponse: (taskId: number, message: AssistantMessage) => void | Promise<void>,
  prewarmCodeMode?: (code: string, context: Parameters<ToolRegistration["execute"]>[2], conversationId: Conversation["id"]) => Promise<void> | void,
  evidence?: () => DurableEvidenceProjection | undefined | Promise<DurableEvidenceProjection | undefined>,
  recordSkillRead?: (call: Parameters<ToolHooks["afterTool"]>[0], api: HookApi, context: Parameters<ToolRegistration["execute"]>[2]) => Promise<void> | void,
  readNativeTask?: (id: Parameters<Harness["getTask"]>[0], context: Parameters<Harness["getTask"]>[1]) => ReturnType<Harness["getTask"]>,
  getContextManager?: (conversationId: Conversation["id"], context: Context) => Promise<DurableContextManager | undefined>,
  commit?: Harness["commit"],
) {
  const childConversation = async (api: Pick<HookApi, "snapshot" | "conversationId">, context: Parameters<ToolRegistration["execute"]>[2]) =>
    Boolean((await api.snapshot(DurableSubagentIdentity, api.conversationId, context))?.value || (await api.snapshot(DurableConsultIdentity, api.conversationId, context))?.key);
  const verifyGoal = options.verifyGoalContinuation;
  const goalTaskId = options.taskId;
  const checkGoal = verifyGoal && goalTaskId ? (api: Pick<HookApi, "snapshot" | "conversationId">,
    context: Context, toolTask?: TaskId) => assertDurableGoalContinuation(goalTaskId, storage, api, context, verifyGoal, toolTask) : undefined;
  const managed = options.nativeHooks && new DurableNativeHooks(options.nativeHooks, storage);
  // 工具任务是独立的 ToolTask（toolTaskId），触发它的却是一次 generation。
  // 只按 toolTaskId 记诊断会让每个工具单独成「一轮」；这里记录每个会话最近一次
  // generation，并在工具开始时固化到 toolTaskId，供执行诊断把工具挂回模型轮次。
  const currentGenerationByConversation = new Map<string, number>();
  const generationByToolTask = new Map<number, number>();
  const rememberGeneration = (conversationId: string, generationTaskId: number) => {
    currentGenerationByConversation.set(conversationId, generationTaskId);
    while (currentGenerationByConversation.size > 256) currentGenerationByConversation.delete(currentGenerationByConversation.keys().next().value!);
  };
  const rememberToolGeneration = (toolTaskId: number, generationTaskId: number | undefined) => {
    if (generationTaskId === undefined) return;
    generationByToolTask.set(toolTaskId, generationTaskId);
    while (generationByToolTask.size > 4096) generationByToolTask.delete(generationByToolTask.keys().next().value!);
  };
  const toolGeneration = (toolTaskId: number, conversationId: string): number | undefined =>
    generationByToolTask.get(toolTaskId) ?? currentGenerationByConversation.get(conversationId);
  const toolOrigin = async (api: HookApi, task: Awaited<ReturnType<Harness["getTask"]>>,
    context: Parameters<ToolRegistration["execute"]>[2]) => {
    const checkpoint = task?.state.status !== "terminal" ? task?.state.checkpoint : undefined;
    let input = task?.input;
    let ownerTaskId: number = api.taskId;
    while (input && typeof input === "object" && !Array.isArray(input) && input.kind === "nested" &&
      typeof input.parent === "number" && input.parent < ownerTaskId) {
      ownerTaskId = input.parent;
      input = (await readNativeTask?.(ownerTaskId as TaskId, context))?.input;
    }
    return { taskId: api.taskId, conversationId: String(api.conversationId),
      assistantEntryId: input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? input.assistant : undefined,
      notStarted: Boolean(checkpoint && typeof checkpoint === "object" && "phase" in checkpoint && checkpoint.phase === "call") };
  };
  const dotsToolOwners = new Map<number, string>();
  const dotsOwner = async (api: HookApi, context: Parameters<ToolRegistration["execute"]>[2]) => {
    if (!options.isDotsWorkerInput || options.taskId === DOTS_TASK_ID || await childConversation(api, context)) return;
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    if (!live?.tools?.some(slot => slot.taskId === api.taskId)) return;
    const id = live.run?.inputs.at(-1);
    if (id === undefined) return;
    const input = await storage.submission(id, context);
    if (input?.type === "input" && input.requestId && options.isDotsWorkerInput(input.requestId)) {
      dotsToolOwners.set(api.taskId, input.requestId);
      if (dotsToolOwners.size > 4096) dotsToolOwners.delete(dotsToolOwners.keys().next().value!);
      return input.requestId;
    }
  };
  const recoveryScope = async (api: Pick<HookApi, "conversationId" | "snapshot">,
    context: Parameters<ToolRegistration["execute"]>[2]): Promise<DotsRecoveryToolScope | undefined> => {
    if (!options.dotsRecoveryScope || options.hasDotsDelegation?.() === false) return;
    let id = api.conversationId;
    for (;;) {
      const live = await api.snapshot(LiveDoc, id, context);
      for (const submissionId of live?.run?.inputs ?? []) {
        const input = await storage.submission(submissionId, context);
        const scope = input?.type === "input" && input.requestId ? await options.dotsRecoveryScope(input.requestId) : undefined;
        if (scope) return live!.run!.inputs.length === 1 && id === api.conversationId ? scope : { kind: "report-only" };
      }
      const owner = (await storage.conversation(id, context))?.owner;
      if (!owner) return;
      id = owner.conversationId;
    }
  };
  const toolRecoveryScope = async (api: Pick<HookApi, "conversationId" | "snapshot" | "memo">,
    context: Parameters<ToolRegistration["execute"]>[2]) => {
    if (!options.dotsRecoveryScope) return;
    const key = "mybuddy.dots.recovery-tool-scope";
    const retained = await api.memo<DotsRecoveryToolScope>(key, context);
    const active = await recoveryScope(api, context);
    if (!retained && active) return api.memo(key, active, context);
    return active?.kind === "report-only" ? active : retained ?? active;
  };
  const recoveryTarget = (scope: DotsRecoveryToolScope, tool: string, args: unknown, cwd: string | undefined) => {
    if (scope.kind === "report-only" || !cwd || resolvedPathKey(cwd) !== resolvedPathKey(options.cwd) ||
      !args || typeof args !== "object" || !("path" in args) || typeof args.path !== "string") return;
    const path = resolve(cwd, args.path);
    const target = resolvedPathKey(path);
    if (tool === "edit") {
      if (scope.kind === "local-repair" && isPathInsideOrEqual(cwd, path) && scope.edits.some(file => resolvedPathKey(file) === target)) return path;
      return;
    }
    const file = scope.files.find(name => validDotsRecoveryFilename(name) && resolvedPathKey(resolve(cwd, name)) === target);
    if (tool === "write" && file && /\.(?:xlsx|docx|pptx)$/iu.test(file)) return;
    if (file) return resolve(cwd, file);
  };
  const verificationChild = async (scope: DotsRecoveryToolScope, args: unknown, api: Pick<HookApi, "conversationId" | "taskId">,
    context: Parameters<ToolRegistration["execute"]>[2]) => {
    if (scope.kind !== "local-repair" || !readNativeTask || !args || typeof args !== "object" || !("command" in args)) return false;
    const task = await readNativeTask(api.taskId, context);
    const nested = task?.input as ToolTaskInput | undefined;
    if (task?.kind !== ToolTask.definition.name || task.conversationId !== api.conversationId || nested?.kind !== "nested" ||
      nested.key !== PROJECT_VERIFY_CHILD_KEY || nested.call.name !== "bash" || task.owner !== nested.parent) return false;
    const owner = await readNativeTask(nested.parent, context);
    const parent = owner?.input as ToolTaskInput | undefined;
    if (owner?.kind !== ToolTask.definition.name || owner.conversationId !== api.conversationId || owner.state.status === "terminal" || !parent) return false;
    const call = parent.kind === "nested" ? parent.call :
      (await storage.entry(api.conversationId, parent.assistant, context))?.entry.model
        ?.find(message => message.role === "assistant")?.content.find(part => part.type === "toolCall" && part.id === parent.callId);
    if (!call || call.type !== "toolCall" || call.name !== PROJECT_VERIFY_TOOL || call.id !== nested.parentCallId ||
      !dotsRecoveryAllowsVerify(scope, call.arguments)) return false;
    const manager = call.arguments.manager === "npm" ? "npm" : "pnpm";
    return args.command === projectVerificationShellCommand(String(call.arguments.script), [], manager);
  };
  const recoveryToolBlock = async (tool: string, args: unknown, api: Pick<HookApi, "conversationId" | "taskId" | "snapshot" | "memo">,
    context: Parameters<ToolRegistration["execute"]>[2]) => {
    if (tool === DOTS_TASK_END && args && typeof args === "object" && "action" in args && args.action === "complete") return;
    const scope = await toolRecoveryScope(api, context);
    if (!scope) return tool === DOTS_RECOVER_COMMIT ? "当前补救轮没有本地提交授权。" : undefined;
    if (scope.kind === "report-only") return "本轮只根据已有结果补报，业务工具未启动。";
    if (tool === "bash" && await verificationChild(scope, args, api, context)) return;
    const denied = "此工具不在本轮补救范围内。";
    if (!dotsRecoveryAllowsTool(scope, tool) || tool === DOTS_TASK_END ||
      tool === PROJECT_VERIFY_TOOL && !dotsRecoveryAllowsVerify(scope, args)) return denied;
    if (tool === "write" || tool === "edit" || tool === OFFICE_USE_TOOLS.documentCreate) {
      const path = recoveryTarget(scope, tool, args, (await api.snapshot(AgentDoc, api.conversationId, context))?.cwd);
      if (!path || tool === "edit" && await realpath(path).then(resolvedPathKey, () => undefined) !== resolvedPathKey(path)) return denied;
    }
  };
  const toolHooks: Partial<ToolHooks> = {
    beforeTool: async (call, api, context) => {
      const recoveryBlock = await recoveryToolBlock(call.name, call.arguments, api, context);
      if (recoveryBlock) return { block: recoveryBlock };
      let mappedArguments: JsonObject | undefined;
      if ((call.name === "write" || call.name === "edit") && typeof call.arguments.path === "string") {
        let target = await api.memo<FileMutationTarget>(FILE_MUTATION_TARGET_MEMO, context);
        if (!target) {
          const { conversationId } = api;
          const agent = await api.snapshot(AgentDoc, conversationId, context);
          const env = await durableExecutionEnv({ conversationId, cwd: agent?.cwd, read: api }, context, options.cwd);
          try {
            target = await api.memo(FILE_MUTATION_TARGET_MEMO, await resolveFileMutationTarget(call.arguments.path, env, context), context);
          } finally {
            await env.cleanup(context);
          }
        }
        mappedArguments = { ...call.arguments, path: target.path };
        call = { ...call, arguments: mappedArguments };
      }
      if (options.foregroundHooks && !await childConversation(api, context)) {
        const gate = await options.foregroundHooks.beforeTool(call, api, context);
        if (gate && "block" in gate) return gate;
      }
      const decision = options.toolHooks?.beforeTool
        ? await withNativeToolOrigin(await toolOrigin(api, await readNativeTask?.(api.taskId, context), context),
          () => options.toolHooks?.beforeTool?.(call, api, context)) : undefined;
      const generationTaskId = toolGeneration(api.taskId, String(api.conversationId));
      rememberToolGeneration(api.taskId, generationTaskId);
      if (!(decision && "block" in decision)) try {
        options.onTool?.({ phase: "start", taskId: options.executionIdentity ? options.executionIdentity.taskId : options.taskId,
          executionScope: options.executionIdentity?.executionScope, conversationId: String(api.conversationId), toolTaskId: api.taskId,
          generationTaskId, dotsOperationId: await dotsOwner(api, context),
          callId: call.id, name: call.name, at: Date.now(),
          sourceKind: options.executionIdentity?.sourceKind ?? (await childConversation(api, context) ? "subagent" : "main") });
      } catch { /* Observers never change tool execution. */ }
      return decision ?? (mappedArguments && { arguments: mappedArguments });
    },
    afterTool: async (call, result, api, context) => {
      const task = await readNativeTask?.(api.taskId, context);
      const changed = options.toolHooks?.afterTool
        ? await withNativeToolOrigin(await toolOrigin(api, task, context), () => options.toolHooks?.afterTool?.(call, result, api, context))
        : undefined;
      const observed = changed ?? result;
      const isError = !nativeExecutionSucceeded(observed, { conversationId: api.conversationId,
        toolTaskId: api.taskId, callId: call.id, toolName: call.name });
      if (options.foregroundHooks?.afterTool && !await childConversation(api, context))
        await options.foregroundHooks.afterTool(call, observed, api, context, commit);
      const rawRead = observed.details && typeof observed.details === "object" && !Array.isArray(observed.details)
        ? nativeFileReadAttemptSchema.safeParse(observed.details[NATIVE_FILE_READ_ATTEMPT]).data : undefined;
      const readPath = !isError && call.name === "read" ? readNativeExecutionReceipt(observed.details)?.fileRead?.target
        ?? (rawRead && !rawRead.openFailure ? rawRead.target : undefined) : undefined;
      if (readPath) await recordSkillRead?.({ ...call, arguments: { ...call.arguments, path: readPath } }, api, context);
      if (options.onGoalToolEvidence) {
        try {
          const receipt = readPath && /(?:^|[\\/])SKILL\.md$/i.test(readPath)
            ? { readPath }
            : durableGoalToolEvidence(call.name, observed);
          if (receipt) {
            const owner = await nativeGoalParentGeneration(storage, task?.owner, context);
            if (owner) options.onGoalToolEvidence(owner, api.taskId, receipt);
          }
        } catch (error) { console.warn("[Durable] Goal tool observation failed", error); }
      }
      try {
        if (options.onGoalToolResult && !isError && (call.name === "subagent" || call.name === "pstack_delegate")) {
          const parent = await nativeGoalParentGeneration(storage, task?.owner, context);
          if (parent) options.onGoalToolResult(parent, { name: call.name, callId: call.id,
            details: observed.details ?? observed.structuredOutput });
        }
        options.onTool?.({ phase: "finish", taskId: options.executionIdentity ? options.executionIdentity.taskId : options.taskId,
          executionScope: options.executionIdentity?.executionScope, conversationId: String(api.conversationId), toolTaskId: api.taskId,
          generationTaskId: toolGeneration(api.taskId, String(api.conversationId)), dotsOperationId: dotsToolOwners.get(api.taskId),
          callId: call.id, name: call.name, at: Date.now(), isError,
          diagnostics: durableToolDiagnosticMessages(observed),
          sourceKind: options.executionIdentity?.sourceKind ?? (await childConversation(api, context) ? "subagent" : "main") });
      } catch { /* Observers never change tool execution. */ }
      dotsToolOwners.delete(api.taskId);
      return await managed?.afterTool(call, observed, api, context) ?? changed;
    },
  };
  const tools = [...native, codemode].map(tool => {
    let guarded: ToolRegistration = tool;
    if (tool.name === "write" && options.dotsRecoveryScope) guarded = { ...tool, execute: async (args, api, context) => {
      const scope = await toolRecoveryScope(api, context);
      if (!scope) return tool.execute(args, api, context);
      const cwd = api.env?.cwd;
      const path = recoveryTarget(scope, "write", args, cwd);
      if (!path || !cwd || resolvedPathKey(await realpath(cwd)) !== resolvedPathKey(cwd) ||
        !args || typeof args !== "object" || !("content" in args) || typeof args.content !== "string")
        throw new Error("缺失文件的工作区或路径无法确认。");
      context.abortSignal?.throwIfAborted();
      await writeFile(path, args.content, { flag: "wx", signal: context.abortSignal });
      return { output: [{ type: "text", text: `Successfully created ${path}` }] };
    } };
    if (tool.name === OFFICE_USE_TOOLS.documentCreate && options.isDotsWorkerInput) guarded = { ...tool, execute: async (args, api, context) => {
      const scope = await toolRecoveryScope(api, context);
      if (scope && scope.kind !== "report-only") await api.memo(OFFICE_RECOVERY_CREATE_MEMO, true, context);
      const result = await tool.execute(args, api, context);
      const detail = result.details;
      if (!result.isError && (scope || dotsToolOwners.has(api.taskId)) && detail && typeof detail === "object" && !Array.isArray(detail) &&
        detail.status === "created" && typeof detail.path === "string") {
        const proof = await registerNativeMutation(detail.path, api, context, options.directory, undefined, true);
        if (proof) await api.memo(NATIVE_FILE_EVIDENCE_MEMO, proof, context);
      }
      return result;
    } };
    const coordinated = withDurableToolCoordination(guarded, options.cwd, (name, args, cwd) => {
      if (options.toolAllowed?.(name) === false) throw new Error(`当前任务工具已不可用：${name}`);
      return options.beforeToolExecution?.(name, args, cwd);
    }, options.admittingUserInputs, options.codeReview, options.directory,
      tool.name === "write" && options.dotsRecoveryScope ? async (api, context) => {
        const scope = await toolRecoveryScope(api, context);
        return Boolean(scope && scope.kind !== "report-only");
      } : undefined, checkGoal && ((api, context) => checkGoal(api, context, api.taskId)));
    return { ...coordinated, execute: async (args, api, context) => {
      // Pi can recover a started or nested ToolTask without re-entering beforeTool.
      const recoveryBlock = await recoveryToolBlock(tool.name, args, api, context);
      if (recoveryBlock) return { isError: true, output: [{ type: "text" as const, text: recoveryBlock }] };
      return coordinated.execute(args, api, context);
    } } satisfies ToolRegistration;
  });
  return defineExtension({ name: "mybuddy.bot", tasks: [], tools: managed ? tools.map(tool => managed.wrap(tool)) : tools,
    sections: [section("mybuddy", async (input, context) => {
      const child = await input.read.snapshot(DurableSubagentIdentity, input.conversationId, context);
      const consult = await input.read.snapshot(DurableConsultIdentity, input.conversationId, context);
      if (child?.value || consult?.key) return undefined;
      const instructions = await options.instructions();
      const delivered = options.deliveredDotsInput?.();
      if (!delivered) return instructions;
      const live = await input.read.snapshot(LiveDoc, input.conversationId, context);
      const currentId = live?.run?.inputs.at(-1);
      if (currentId === undefined) return instructions;
      const prior = await storage.submissionByRequest(input.conversationId, delivered, context);
      if (prior?.type !== "input" || prior.status !== "done") return instructions;
      const current = await storage.submission(currentId, context);
      const followup = current?.type === "input" && current.entry !== undefined && current.entry > prior.answer
        && current.requestId && !isDotsAutomaticInput(current.requestId) && !options.isDotsWorkerInput?.(current.requestId);
      return followup
        ? `${instructions}\n\n上一笔 Dots 交办已经交付。沿用仍适用的限制和既有成果，按本轮用户的新要求处理。只有用户要求复验，或本轮变更影响了已有结果时，才重跑对应验收。`
        : instructions;
    }, { tag: false })],
    hooks: [hook(ToolTask, toolHooks), hook(CompactionTask, { beforeCompact: async (compaction, api, context) => {
      // Compaction is its own task, never a GenerationTask: its summarization request must not share a
      // prefix chain with the visible answer, so it registers `compact` under its own invocation signal.
      setRequestTraceBoundary(context.abortSignal, traceBoundary(api, "compact"));
      // 主会话与子代理/会诊各自持有独立协调器；Code Mode 私有会话没有子代理身份，不会命中。
      const manager = await getContextManager?.(api.conversationId, context);
      if (!manager) return undefined;
      // BC 安全文本前缀通过 SDK 提交真实 head；受保护的固定 cut 拒绝，手动/溢出仍使用有界 fallback。
      const decision = await manager.beforeCompact({ reason: compaction.reason, messages: compaction.messages, entries: compaction.entries, firstKept: compaction.firstKept }, api, context);
      if (decision === undefined || (decision !== undefined && "summary" in decision)) manager.markNativeCompaction();
      return decision;
    } }), hook(GenerationTask, { beforeRequest: async (request, api, context) => {
      // Same signal-keyed contract as modelRequestGuards: the invocation signal identifies the request.
      setRequestTraceBoundary(context.abortSignal, traceBoundary(api, "stream"));
      let messages = request.messages;
      let changed = false;
      let validate: RequestGuard = () => { throw new Error("本轮上下文投影未完成"); };
      const guards = modelRequestGuards.get(options.models);
      if (context.abortSignal) guards?.set(context.abortSignal, messages => validate(messages));
      const validateGoal = async () => {
        const goal = await checkGoal?.(api, context);
        if (goal && context.abortSignal) goalModelRequests.get(options.models)?.add(context.abortSignal);
      };
      try {
        await validateGoal();
        const scope = context.abortSignal && await recoveryScope(api, context);
        if (scope && context.abortSignal) recoveryToolRequests.get(options.models)?.set(context.abortSignal, scope);
        const child = await childConversation(api, context);
        const hookNote = await managed?.beforeRequest(messages, api, context);
        const requestWithHook = (projected: readonly Message[]) => hookNote
          ? [...projected, { role: "user" as const, content: hookNote, timestamp: 0 }] : projected;
        rememberGeneration(String(api.conversationId), api.taskId);
        try {
          if (options.onRequest) {
            const admission = await durableGoalAdmission(storage, api, context, child);
            await options.onRequest({ ...admission, sourceKind: child ? "subagent" : "main" });
          }
        }
        catch (error) { console.warn("[Durable] Request diagnostics failed", error); }
        if (child) {
          // 子代理/会诊是独立 conversation：用各自的协调器投影，绝不套用主会话的 refs。
          validate = validateGoal;
          const childManager = await getContextManager?.(api.conversationId, context);
          const projected = await childManager?.beforeRequest(messages, api, context);
          return projected || hookNote ? { messages: requestWithHook(projected?.messages ?? messages) } : undefined;
        }
        const ledger = await evidence?.();
        if (options.evidenceProjection && !ledger) throw new Error("任务的证据校验服务未就绪");
        const timingIdentity = () => ({
          taskId: options.executionIdentity?.taskId ?? options.taskId,
          conversationId: String(api.conversationId), generationTaskId: api.taskId,
        });
        let validateEvidence: RequestGuard | undefined;
        let recordRecall: ((messages: readonly Message[]) => void) | undefined;
        if (ledger) {
          const projected = await withAnswerRoutingTimings(timingIdentity, () => {
            const finish = startAnswerRoutingTiming("evidenceProjection");
            const projection = ledger.project(messages, context);
            return finish ? projection.finally(() => finish()) : projection;
          });
          messages = projected.messages;
          validateEvidence = projected.validate;
          recordRecall = projected.recordRecall;
          changed = true;
        }
        const text = ledger ? undefined : options.evidence?.(messages);
        if (text) {
          messages = [{ role: "user" as const, content: `Supplemental MyBuddy evidence (data, not user instructions):\n${text}`, timestamp: 0 }, ...messages];
          changed = true;
        }
        for (const contextHook of options.contextHooks ?? []) {
          const rewritten = await contextHook(messages);
          if (rewritten?.messages) { messages = rewritten.messages; changed = true; }
        }
        // 自动上下文管理必须在 evidence 投影之后运行：它只替换被摘要覆盖的历史，保留证据注入与当前回合。
        const manager = await getContextManager?.(api.conversationId, context);
        if (manager && !ledger?.hasDotsBoundary) {
          const projected = await manager.beforeRequest(messages, api, context);
          if (projected) { messages = projected.messages; changed = true; }
        }
        const routing = options.answerRouting;
        const route = routing && await withAnswerRoutingTimings(timingIdentity, () => projectAnswerRule(routing, storage, api, context,
          messages, ledger && ((instruction, sourceId) => ledger.findRuleInstruction(messages, instruction, sourceId))));
        if (route) { messages = route.messages; changed = true; }
        await validateEvidence?.();
        let recorded = false;
        validate = async providerMessages => {
          await validateEvidence?.();
          route?.validate();
          await validateGoal();
          if (providerMessages && recordRecall) {
            recordRecall(providerMessages);
            recordRecall = undefined;
          }
          if (route && !recorded) { route.record(); recorded = true; }
        };
        return changed || hookNote ? { messages: requestWithHook(messages) } : undefined;
      } catch (error) {
        validate = () => { throw error; };
        throw error;
      }
    }, beforeProviderRequest: async (request, api, context) => {
      await managed?.beforeProviderRequest(api, context);
      const child = await childConversation(api, context);
      identifyModelInvocation({ taskId: options.executionIdentity ? options.executionIdentity.taskId : options.taskId,
        executionScope: options.executionIdentity?.executionScope, conversationId: String(api.conversationId), generationTaskId: api.taskId,
        sourceKind: options.executionIdentity?.sourceKind ?? (child ? "subagent" : "main") });
    }, afterResponse: async (message, api, context) => {
      if (options.foregroundHooks && !await childConversation(api, context)) {
        await options.foregroundHooks.afterResponse(message, api, context);
      }
      await managed?.beforeFinish(message, api, context);
      const observed=context.abortSignal?modelUsageEvidence.get(options.models)?.get(context.abortSignal):undefined;
      const raw=observed?{...observed}:emptyUsageEvidence();
      try { options.onResponse?.(message, { conversationId: String(api.conversationId), generationTaskId: api.taskId,
        sourceKind: await childConversation(api, context) ? "subagent" : "main",usageEvidence:raw,usagePresence:usagePresence(raw) }); }
      catch (error) { console.warn("[Durable] Request diagnostics failed", error); }
      await recordResponse(api.taskId, message);
      if (context.abortSignal && recoveryToolRequests.get(options.models)?.has(context.abortSignal)) return;
      const codes = message.content.flatMap(content => content.type === "toolCall" && content.name === "codemode"
        ? [(content.arguments as { code?: unknown }).code].filter((code): code is string => typeof code === "string")
        : []);
      for (const code of codes) await prewarmCodeMode?.(code, context, api.conversationId);
    }, afterTools: async (_assistant, results, api, context) => {
      if (commit) await prioritizeInputAfterDeferredGoal(results, api, context, commit);
    }, onYield: async (answer, api, context) => {
      const note = managed?.continuation(answer);
      if (note) return { continue: note };
      if (options.foregroundHooks && !await childConversation(api, context)) return options.foregroundHooks.onYield(answer, api, context);
    }, afterRun: async (run, api, context) => {
      if (!options.onEntries || !await childConversation(api, context)) return undefined;
      try {
        let cursor: Cursor | undefined;
        do {
          const page = await api.entries({ minEntryId: run.first, maxEntryId: run.last, order: "ascending" }, 500, cursor, context);
          options.onEntries(page.items.filter(entry => entry.byTaskId !== undefined), { conversationId: String(api.conversationId), sourceKind: "subagent" });
          cursor = page.next;
        } while (cursor);
      } catch (error) { console.warn("[Durable] Child usage projection failed", error); }
      return undefined;
    } })],
  });
}
