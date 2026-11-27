import { latestActivityTime } from "../../../../shared/src/activity-time";
import { DotsIntentChanged } from "../../dots/DotsNativeIntent";
import type { DotsRecoveryToolScope } from "../../dots/DotsRecovery";
import { DotsCapabilityUnavailable } from "../../dots/DotsCapabilityRequirements";
import { dotsGoalConclusion } from "../../dots/DotsGoalConclusion";
import { ConversationBusy, ConversationIdle } from "@earendil-works/pi-durable";
import { DOTS_TASK_ID, isDotsAutomaticInput, type DotsAssistantReply, type DotsCapabilityRequirement } from "../../../shared/dots";
import { sameWorkspacePath } from "../../task/QQTaskWorkspace";
import { readDurableDotsResult, type DurableDotsOutcome } from "./DurableDotsResult";
import { DOTS_OUTBOX_WRITE_REVOKED } from "./DurableDotsReply";
import { ConversationInteractionRepository, mapConversationInteraction } from "../ConversationInteractionRepository";
import { isGatewayConversation } from "../../gateway/GatewayConversation";
import { DEFAULT_WELCOME_MODE, defaultModePresetId } from "../../../shared/mode-profile";
import type { GatewayBotTurnRequest } from "../../gateway/GatewayAgentTurn";
import { rejectGatewayExecution } from "../../gateway/GatewayExecutionAuthority";
import { importGatewayAttachments } from "../../gateway/GatewayMedia";
import { WorkExecutionMetricsStore } from "../work/WorkExecutionMetrics";
import { recordCollaborationExecutionStarted } from "../work/BotCollaborationExecutionFacts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, statSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, extname, resolve, dirname } from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { durableSandboxAssets, type NativeHookStore } from "../hooks/NativeHookStore";
import { McpOAuthCredentialStore, SessionManager, convertToLlm, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentDeleteUserMessageRequest, AgentRegenerateRequest, AgentRegenerateResult, AgentPromptRequest, AgentPromptResult, AgentSubmissionReceipt, AgentUiPatch, TaskDto, TaskHistoryDto, TaskHistoryTarget, TaskUserQuestionsDto, TaskUserQuestionsQuery } from "../../../shared/agent-ipc";
import type { GoalContinuationOrigin } from "../../../shared/conversation-goal";
import type { GoalUserInputWitness } from "../ConversationRuntimeData";
import { normalizedEditorTextHash } from "../../../shared/regenerate-hash";
import { durableTaskStatus, type BotToolMode, type DurableBotSnapshot } from "../../../shared/durable-bot";
import { durableDelta } from "../../../../shared/src/durable-sync";
import { GATEWAY_SIDEBAR_CHANNELS, isGatewayBotTaskId } from "../../../shared/gateway-task";
import { gatewayChannelDirectory } from "../../gateway/gateway-task-space";
import { gatewayConversationDirectory, organizeGatewayConversationStores } from "./GatewayConversationStorage";
import type { AppDatabase } from "../../db/AppDatabase";
import { McpConfigService } from "../../mcp/McpConfigService";
import { emptyMcpFilterResult } from "../../mcp/McpModeFilter";
import { toNativeMcpConfig } from "../../mcp/NativeMcpConfig";
import { McpCredentialBackend } from "../../mcp/McpCredentialBackend";
import { DurableBotRuntime, type DurableBotOptions } from "./DurableBotRuntime";
import { DURABLE_TURN_LIMIT_MESSAGE } from "./DurableRunLimits";
import type { AnswerRoutingService } from "../AnswerRoutingService";
import type { DurableCompactionOutcome, ProductCompactionSettings } from "./context/types";
import { DEFAULT_PRODUCT_COMPACTION_SETTINGS } from "./context/CompactionPolicy";
import type { ContextManagementEngine, ContextManagementStatusDto } from "../../../shared/context-management";
import { readDurableContextStatus } from "./context/DurableContextStatus";
import { DurableTaskProjection } from "./DurableTaskProjection";
import { ToolGate } from "./ToolGate";
import { DEFAULT_DURABLE_RESUME_CONCURRENCY, ResumeAdmission, type ResumeAdmissionReport } from "./ResumeAdmission";
import { bindDotsConversationWorkspace, WorkspaceMigrationBusyError } from "./DurableWorkspaceMigration";
import { DurableWorkspaceMoves } from "./DurableWorkspaceMoves";
import { readDurableConversationHead, readDurableReadOnlyHistory, readDurableUserQuestions } from "./DurableReadOnlyHistory";
import { resolveStoreId } from "./DuckDbStorage";
import type { ActiveCoreGoalContinuation, CoreGoalContinuationClaim, CoreGoalPlacement, CoreGoalRuntimeWindow } from "../work/CoreGoalContinuationDriver";
import { continuationNudge } from "../work/GoalContinuationService";
import { modelKey, resolveBotModel, type BotModelResolution } from "./BotModelCatalog";
import type { DurableDomainTools } from "./DurableDomainTools";
import type { DurableEvidenceOptions } from "./DurableEvidenceProjection";
import { DurableUserEntryNotFoundError, findDurableUserEntry, readDotsWorkspace } from "./DurableConversationBranch";
import { stopDurableSubagentsForTask } from "./DurableSubagents";
import { readDurableSteerReceipts } from "./DurableSteerReceipts";
import { durableContentText } from "./DurableHistoryProjection";
import { DurableMcp } from "./DurableMcp";
import type { ExternalEffectRecovery } from "./DurableEffectRecovery";
import { DurableStorageOwnedError } from "./DurableStorageLease";
import { purgeDurableStorage } from "./DurableStorage";
import { LOCAL_USER_ID, type WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { RuntimeAuditReader } from "../../platform/runtime-audit";
import { snapshotWorkspace } from "../../workspace/WorkspaceService";
import { AgentDoc, LiveDoc, SessionFailed, type Cursor, type EntryRecord, type SubmissionId, type SubmissionRecord } from "@earendil-works/pi-durable";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { durableCompletedTurns } from "./DurableTurnProjection";
import type { TaskExpertBindingService } from "../../experts/TaskExpertBindingService";
import type { ToolDiagnosticEvent } from "../../../shared/task-diagnostics";
import type { CreateConversationBranchRequest } from "../../../shared/conversation-branch";
import { captureDurableBranch, resolveDurableBranch, type DurableBranchAnchor, type MaterializedDurableBranch } from "./DurableTaskBranch";

interface BotBinding { directory: string; cwd: string }
export interface RuntimeDurableOpenState {
  binding: BotBinding | null;
  workspaceMove: { fromCwd: string; toCwd: string } | null;
  memoryProjectionEntryId: number | null;
  trashed: boolean;
}
type AdmissionMark = (stage: string) => void;
const STOP_SETTLEMENT_TIMEOUT_MS = 10_000;

function lastConversationMessageId({ messages }: DurableBotSnapshot) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!messages[index].dotsProactive) return messages[index].id;
  }
  return "";
}

class InputAdmissionStopped extends Error {
  constructor() { super("当前输入已停止"); }
}
class DurableToolAssemblyError extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }); }
}
interface BotModelRepair { from: string; to: string }
interface OpenBot {
  runtime: DurableBotRuntime; mcp: DurableMcp; mcpConfigKey: string;
  cwd: string; directory: string;
  retiredMcp: Set<DurableMcp>;
  readWaitingForInput(): Promise<boolean>;
  refreshPermissions(task?: TaskDto): Promise<TaskDto>;
  refreshingMcp?: { key: string; promise: Promise<DurableMcp> };
  /** 打开任务时持久化模型已失效，本次执行实际使用的替换模型。必须展示给用户。 */
  modelRepair?: BotModelRepair;
  /** Set while this runtime and its MCP clients are being torn down after a Session failure. */
  closing?: Promise<void>;
  dotsWorkspace?: string;
}
export interface DurableInputOrigin {
  goalContinuation?: GoalContinuationOrigin;
  goalUserInput?: GoalUserInputWitness;
  gatewayOrigin?: Omit<GatewayBotTurnRequest["gatewayOrigin"], "workTarget">;
}

export interface DurableBotServiceOptions {
  db: AppDatabase;
  passiveReader?: RuntimeAuditReader;
  codeReview?: import("../CodeReviewService").CodeReviewService;
  models: ModelRuntime;
  agentDir: string;
  mcpDir: string;
  assetsDir?: string;
  resolveCwd: (taskId: string) => string | Promise<string>;
  createDotsWorkspace?: () => string;
  validateGatewayWorkspace?: (taskId: string, cwd: string, from?: string) => void | Promise<void>;
  /** Desired organization root; undefined pins an execution-owned workspace. No projection writes. */
  resolveNextCwd?: (taskId: string) => string | undefined | Promise<string | undefined>;
  instructions: (task: TaskDto) => string | Promise<string>;
  evidence?: (task: TaskDto, messages: readonly Message[]) => string;
  evidenceProjection?: (task: TaskDto) => DurableEvidenceOptions | undefined;
  canReadAnswerEvidence?: (taskId: string, resource: "read" | "library_read") => boolean;
  answerRouting?: Pick<AnswerRoutingService, "prepare" | "hasRulesForTask" | "clearPreparedTurns">;
  dotsAnswerRoutingEnabled?: () => boolean;
  nativeHooks?: NativeHookStore;
  nativeImprovement?: import("../hooks/NativeImprovementService").NativeImprovementService;
  improvementSkillAllowed?: (taskId: string, name: string) => boolean;
  readHints?: import("../hooks/ReadRecoveryHints").ReadRecoveryHints;
  tools?: (task: TaskDto, cwd: string, recovery: ExternalEffectRecovery) => Promise<DurableDomainTools>;
  mcpSelection?: (task: TaskDto) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
  prepareToolPermissions?: (task: TaskDto) => Promise<unknown>;
  toolAllowed?: (task: TaskDto, name: string) => boolean;
  assertDotsCapabilities?: (task: TaskDto, cwd: string, requirements: readonly DotsCapabilityRequirement[]) => void | Promise<void>;
  onTurns?: (taskId: string, turns: ReturnType<typeof durableCompletedTurns>) => Promise<void>;
  onDotsProgress?: (taskId: string, operationId: string, identity: string, at: number) => void;
  dotsRecoveryScope?: (taskId: string, operationId: string) => DotsRecoveryToolScope | undefined | Promise<DotsRecoveryToolScope | undefined>;
  onEntries?: (taskId: string, entries: readonly EntryRecord[], info: { conversationId: string; sourceKind: "main" | "subagent" }) => void;
  onResponse?: (taskId: string, message: AssistantMessage, info: { conversationId: string; generationTaskId: number; sourceKind: "main" | "subagent" }) => void;
  onGoalToolResult?: (taskId: string, identity: import("../../../shared/conversation-goal-activity").GoalActivityIdentity, tool: {
    name: string; callId: string; details: unknown;
  }) => void;
  onRequest?: (taskId: string, info: import("../../../shared/conversation-goal-activity").GoalActivityAdmission & { sourceKind: "main" | "subagent" }) => void | Promise<void>;
  onTool?: (event: ToolDiagnosticEvent) => void;
  onGoalToolEvidence?: (taskId: string, ...args: Parameters<NonNullable<DurableBotOptions["onGoalToolEvidence"]>>) => void;
  observedUsage?: (taskId: string, conversationId: string) => import("../../../shared/task-diagnostics").ConversationUsageReceipt;
  waitingForInput?: (taskId: string) => boolean;
  /** Startup resumption width; interactive access bypasses the queue and is never throttled here. */
  resumeConcurrency?: number;
  onSettled?: (taskId: string, snapshot: DurableBotSnapshot) => void | Promise<void>;
  onRelease?: (taskId: string) => void;
  toolMode: (task: TaskDto) => BotToolMode;
  maxTurns?: (task: TaskDto) => number | null;
  defaultModel: () => string | undefined;
  dotsModel?: () => Promise<BotModelResolution["target"]>;
  /** 产品压缩阈值（同步 getter：每次使用重新读取，运行中改设置即时生效）。缺省用产品默认值。 */
  productCompaction?: () => ProductCompactionSettings;
  /** 上下文管理引擎选择（billion-context / native）；同步 getter，切换后下一轮生效。 */
  compactionEngine?: () => ContextManagementEngine;
  /** 上下文管理状态投影回调：只做 UI 投影，绝不在这里等待或阻塞运行时线程。 */
  onContextStatus?: (taskId: string, status: ContextManagementStatusDto) => void;
  emit: (patch: AgentUiPatch) => void;
  projectArtifacts?: (taskId: string, snapshot: DurableBotSnapshot, before: Map<string, string>, cwd: string, messageWorkspaces?: ReadonlyMap<string, string>) => Promise<void>;
  thinking?: (task: TaskDto, request: AgentPromptRequest) => ModelThinkingLevel | undefined;
  prepareInput?: (request: AgentPromptRequest) => Promise<string> | string;
  auditInput?: (request: AgentPromptRequest, origin?: DurableInputOrigin) => import("./DurableSkillProjection").DurableInputAudit | undefined
    | Promise<import("./DurableSkillProjection").DurableInputAudit | undefined>;
  prepareImages?: (request: AgentPromptRequest) => Promise<{ images: Array<{ type: "image"; mimeType: string; data: string }>; text?: string }>;
  prepareTask?: (request: AgentPromptRequest, mark?: AdmissionMark) => Promise<AgentPromptRequest>;
  beforeSubmit?: (request: AgentPromptRequest) => void | Promise<void>;
  beforeModelRequest?: (taskId: string) => void | Promise<void>;
  verifyGoalContinuation?: (origin: ActiveCoreGoalContinuation) => Promise<void>;
  beforeToolExecution?: (taskId: string, cwd: string, name: string, args: unknown) => void;
  providerAuthorityGuarded?: (taskId: string) => boolean;
  onProviderUsage?: (taskId: string, input: { conversationId: string; generationTaskId: number;
    reported: boolean; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
  resumeAllowed?: (taskId: string) => boolean | Promise<boolean>;
  expertBindings?: TaskExpertBindingService;
}

/** One process owns each store. Core owns durable bindings in production. */
export class DurableBotService {
  private readonly rebinding = new Map<string, Promise<OpenBot>>();
  private readonly opening = new Map<string, Promise<OpenBot>>();
  private readonly opened = new Map<string, OpenBot>();
  private readonly config: McpConfigService;
  private readonly credentials: McpOAuthCredentialStore;
  private closing = false;
  private readonly invalidations = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string, Map<Promise<unknown>, AbortController | undefined>>();
  private readonly admissionTails = new Map<string, Promise<unknown>>();
  private readonly admittingUserInputs = new Map<string, Set<{ requestId: string }>>();
  private readonly goalAdmissions = new Map<string, AbortController>();
  private readonly projections = new Map<string, Promise<void>>();
  private readonly passiveReads = new Map<string, Promise<void>>();
  private resumeAdmission?: ResumeAdmission;
  /** Last startup drain outcome: delivered means open+resume was handed over, not that native work finished. */
  lastResumeReport?: ResumeAdmissionReport;
  private readonly workMetrics: WorkExecutionMetricsStore;
  private readonly workspaceMoves: DurableWorkspaceMoves;
  constructor(private readonly options: DurableBotServiceOptions) {
    const fixture = options.db.fixtureConnection;
    this.workMetrics = new WorkExecutionMetricsStore(fixture, this.core);
    this.workspaceMoves = new DurableWorkspaceMoves(options.db);
    if (fixture && !fixture.readonly) {
      fixture.exec(`CREATE TABLE IF NOT EXISTS durable_bot_bindings (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        backend TEXT NOT NULL CHECK(backend = 'pi-durable'), directory TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL)`);
      fixture.exec(`CREATE TABLE IF NOT EXISTS durable_bot_memory_projection (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, entry_id INTEGER NOT NULL)`);
      fixture.exec(`CREATE TABLE IF NOT EXISTS durable_bot_workspace_moves (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        from_cwd TEXT NOT NULL, to_cwd TEXT NOT NULL)`);
      fixture.exec(`CREATE TABLE IF NOT EXISTS durable_bot_message_workspaces (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, cwd TEXT NOT NULL, PRIMARY KEY(task_id, message_id))`);
    }
    // Moving legacy SQLite directories would change the identity of an existing Core store.
    if (fixture) organizeGatewayConversationStores(options.db, options.agentDir);
    this.config = new McpConfigService();
    this.credentials = new McpOAuthCredentialStore(
      new McpCredentialBackend(join(options.mcpDir, "mcp-native-auth.encrypted.json")), join(options.mcpDir, "mcp-native-refresh-locks"));
  }

  private get core(): RuntimeAuditReader | undefined {
    const reader = this.options.db.runtimeAuditReader;
    return reader?.supervised ? reader : undefined;
  }

  owns(taskId: string): boolean {
    if (this.core) return this.opened.has(taskId) || this.opening.has(taskId);
    return Boolean(this.options.db.getTask(taskId) || this.binding(taskId));
  }

  async ownsTask(taskId: string): Promise<boolean> {
    return this.core ? Boolean(await this.options.db.readTask(taskId, { includeExpertBinding: false })) : this.owns(taskId);
  }
  busy(taskId: string): boolean {
    const snapshot = this.opened.get(taskId)?.runtime.snapshot;
    const admissions = this.admissions.get(taskId);
    return Boolean(snapshot?.busy || snapshot?.queued || this.opening.has(taskId)
      || admissions && Array.from(admissions.values()).some(controller => !controller?.signal.aborted));
  }
  cwd(taskId: string): string | undefined {
    return this.core ? this.opened.get(taskId)?.cwd : this.workspaceMoves.read(taskId)?.toCwd ?? this.binding(taskId)?.cwd;
  }

  async readCwd(taskId: string): Promise<string | undefined> {
    if (!this.core) return this.cwd(taskId);
    const state = await this.readOpenState(taskId);
    return state?.workspaceMove?.toCwd ?? state?.binding?.cwd;
  }
  liveConversationId(taskId: string): string | undefined { return this.opened.get(taskId)?.runtime.snapshot.conversationId; }
  /** Called only within a Gateway trash restore transaction. Native cwd stays authoritative until migration commits. */
  prepareGatewayTrashRestore(taskId: string, legacy: string, destination: string): void {
    const { db } = this.options;
    if (!isGatewayConversation(taskId) || db.getTaskExecutionWorkspaceState(taskId)?.state !== "trashed"
      || this.opened.has(taskId) || this.opening.has(taskId) || this.rebinding.has(taskId)
      || this.invalidations.has(taskId) || this.admissions.get(taskId)?.size) {
      throw new Error("渠道任务未处于可安全恢复的状态");
    }
    const binding = this.binding(taskId);
    const pending = this.workspaceMoves.read(taskId);
    if (pending || (binding && !sameWorkspacePath(binding.cwd, legacy) && !sameWorkspacePath(binding.cwd, destination))) {
      throw new Error("渠道任务已有冲突的工作目录绑定");
    }
    if (binding && !sameWorkspacePath(binding.cwd, destination)) {
      db.connection.prepare("INSERT INTO durable_bot_workspace_moves VALUES (?, ?, ?)").run(taskId, binding.cwd, destination);
    } else {
      db.bindTaskExecutionWorkspaceCwd(taskId, destination);
    }
  }
  lastAssistantId(taskId: string): string | undefined { return this.opened.get(taskId)?.runtime.snapshot.messages.filter(message => message.role === "assistant" && !message.dotsProactive).at(-1)?.id; }
  contextUsage(taskId: string) {
    const value = this.opened.get(taskId)?.runtime.snapshot.contextUsage;
    return value ? { taskId, ...value } : null;
  }
  /**
   * 会话级上下文管理的只读状态投影：不打开运行时、不建 host、无副作用。
   * 未打开运行时时只读取 Durable 文档，绝不创建 Harness、模型或维护任务。
   */
  async contextManagementStatus(taskId: string): Promise<ContextManagementStatusDto | undefined> {
    const live = this.opened.get(taskId)?.runtime.contextManagementStatus();
    if (live) return live;
    const binding = await this.readBinding(taskId);
    return binding ? readDurableContextStatus(binding.directory) : undefined;
  }
  /**
   * MCP 元工具定义的字符口径（只读投影）：当前已打开 bot 的元工具字符数 / 元工具个数 / 已配置服务数。
   * 没有已打开的 bot（未启动或已释放）返回 null；不 open()、不建 host、不连接任何服务器、无副作用。
   */
  mcpContext(taskId: string): { chars: number; tools: number; servers: number } | null {
    const open = this.opened.get(taskId);
    if (!open || open.closing) return null;
    return open.mcp.contextFacts();
  }
  async subagentSteerReceipts(taskId: string, childId: string) {
    const binding = await this.readBinding(taskId);
    return binding ? await readDurableSteerReceipts(binding.directory, childId) : [];
  }

  async goalNativeEvidence(taskId: string, runs: readonly import("../../../shared/conversation-goal-activity").GoalActivityIdentity[]) {
    const binding = await this.readBinding(taskId);
    if (!binding || !runs.length) return [];
    const { readGoalNativeEvidence } = await import("./DurableGoalNativeEvidence");
    return await readGoalNativeEvidence(binding.directory, runs);
  }

  private binding(taskId: string): BotBinding | undefined {
    return this.options.db.connection.prepare("SELECT * FROM durable_bot_bindings WHERE task_id = ?").get(taskId) as BotBinding | undefined;
  }

  private async readBinding(taskId: string): Promise<BotBinding | undefined> {
    const core = this.core;
    if (!core) return this.binding(taskId);
    const binding = await core.readDurableTaskBinding(taskId);
    if (binding === undefined) throw new Error("Core 未确认 Durable 会话绑定");
    return binding ?? undefined;
  }

  private async readOpenState(taskId: string): Promise<RuntimeDurableOpenState | null> {
    const state = await this.core!.readDurableOpenState(taskId);
    if (state === undefined) throw new Error("Core 未确认 Durable 会话打开状态");
    return state;
  }

  private async readWorkspaceMove(taskId: string) {
    if (!this.core) return this.workspaceMoves.read(taskId);
    return (await this.readOpenState(taskId))?.workspaceMove ?? undefined;
  }

  private async readWaitingForInput(taskId: string): Promise<boolean> {
    if (!this.core) return this.options.waitingForInput?.(taskId) ?? false;
    const snapshot = await this.core.readConversationRuntime(taskId, LOCAL_USER_ID);
    if (snapshot === undefined) throw new Error("Core 未确认 Durable 任务的待答问题");
    return snapshot?.interactions.some(interaction => interaction.status === "pending") ?? false;
  }

  private async readAdmissionCwd(taskId: string, open: Pick<OpenBot, "cwd" | "directory">, existingRun = false): Promise<string> {
    const gateway = isGatewayConversation(taskId);
    if (!this.core) {
      const binding = this.binding(taskId);
      if (!binding) throw new Error("Durable 会话绑定不存在");
      if (gateway) {
        if (!sameWorkspacePath(binding.cwd, open.cwd) || !sameWorkspacePath(binding.directory, open.directory)) {
          throw new Error("Durable 会话绑定或工作目录已变化，请重新打开任务");
        }
        await this.options.validateGatewayWorkspace?.(taskId, binding.cwd);
      }
      return binding.cwd;
    }
    const state = await this.readOpenState(taskId);
    if (!state || state.trashed) throw new Error("任务已删除或在回收站中");
    const binding = state.binding;
    const move = state.workspaceMove;
    if (!binding || (move && (!existingRun || !sameWorkspacePath(move.fromCwd, open.cwd))) || !sameWorkspacePath(binding.cwd, open.cwd)
      || !sameWorkspacePath(binding.directory, open.directory)) {
      throw new Error("Durable 会话绑定或工作目录已变化，请重新打开任务");
    }
    if (gateway) await this.options.validateGatewayWorkspace?.(taskId, binding.cwd);
    return binding.cwd;
  }

  private async readCoreDotsInputs(taskId: string) {
    const core = this.core!;
    const operationIds = new Set<string>();
    if (taskId === DOTS_TASK_ID) return { operationIds };
    const latest = await core.readDotsFollowupData<{ operationId: string } | null>({ kind: "latest", taskId });
    if (latest === undefined) throw new Error("Core 未确认原任务 Dots 交办");
    if (!latest) return { operationIds };
    operationIds.add(latest.operationId);
    for await (const row of core.readActiveDotsDelegations(taskId)) operationIds.add(row.id);
    return { operationIds, latestOperationId: latest.operationId };
  }

  private toolMode(task: TaskDto): BotToolMode {
    return isGatewayBotTaskId(task.id) ? "native" : this.options.toolMode(task);
  }

  async resumePersisted(): Promise<string[]> {
    const admission = new ResumeAdmission({
      concurrency: this.options.resumeConcurrency ?? DEFAULT_DURABLE_RESUME_CONCURRENCY,
      shouldSkip: taskId => this.resumeSkipReason(taskId),
      // `open()` deduplicates by taskId, so a session the user opened first is only a no-op open
      // plus the same resume hand-over. Skipping it here would drop that recovery obligation.
      run: async taskId => {
        const { runtime } = await this.open(taskId);
        await runtime.recoverRevokedGoal();
        runtime.resume();
      },
    });
    this.resumeAdmission = admission;
    const reader = this.options.db.runtimeAuditReader;
    if (reader?.supervised) {
      let after: string | undefined;
      do {
        const page = await reader.readDurableResumePage(after);
        if (!page) throw new Error("Durable 启动恢复候选列表未获 Rust Core 确认");
        admission.enqueue(page.taskIds);
        after = page.next ?? undefined;
      } while (after !== undefined && !this.closing);
    } else {
      const bindings = this.options.db.connection.prepare("SELECT task_id FROM durable_bot_bindings").pluck().all() as string[];
      admission.enqueue(bindings);
    }
    const report = await admission.drain();
    this.lastResumeReport = report;
    if (report.failed.length) {
      console.warn(`[Durable] 启动恢复交付 ${report.delivered.length} 个会话，${report.failed.length} 个失败`, report.failed.slice(0, 5));
    }
    return report.delivered;
  }

  /** Queue-time conditions can change while an item waits; re-check before spending a slot. */
  private async resumeSkipReason(taskId: string): Promise<string | undefined> {
    const reader = this.options.db.runtimeAuditReader;
    if (reader?.supervised) {
      const binding = await reader.readDurableTaskBinding(taskId);
      if (binding === undefined) throw new Error("Durable 恢复绑定读取未获 Rust Core 确认");
      if (!binding) return "binding-removed";
      if (await this.options.resumeAllowed?.(taskId) === false) return "not-resumable";
      return binding.trashed ? "trashed" : undefined;
    }
    if (!this.binding(taskId)) return "binding-removed";
    if (await this.options.resumeAllowed?.(taskId) === false) return "not-resumable";
    if (this.options.db.getTaskExecutionWorkspaceState(taskId)?.state === "trashed") return "trashed";
    return undefined;
  }

  private open(taskId: string, admissionBoundary = false, signal?: AbortSignal): Promise<OpenBot> {
    // Reading history opens a paused native Harness but does not resume it. Keep the
    // startup queue entry: openBound deduplicates the runtime, and the drain still
    // owes this original input its resume hand-over. Claiming here stranded work
    // whenever a foreground read beat the bounded startup queue.
    const pending = this.rebinding.get(taskId);
    if (pending) return pending;
    const operation = (async () => {
      let open: OpenBot;
      try { open = await this.openBound(taskId); }
      catch (error) {
        if (!(error instanceof WorkspaceMigrationBusyError) || isGatewayConversation(taskId)) throw error;
        const move = await this.readWorkspaceMove(taskId);
        if (!move) throw error;
        await this.workspaceMoves.write({ kind: "cancel", taskId, ...move });
        open = await this.openBound(taskId);
      }
      if (signal?.aborted || (!admissionBoundary && this.admissions.get(taskId)?.size)) return open;
      if (taskId === DOTS_TASK_ID && this.options.createDotsWorkspace) {
        if (open.dotsWorkspace || await open.readWaitingForInput() || !await open.runtime.canRebindWorkspace()) return open;
        await this.rememberWorkspaceHistory(taskId, open);
        if (signal?.aborted) return open;
        const workspace = this.options.createDotsWorkspace();
        try { await bindDotsConversationWorkspace(open.runtime.conversation, workspace, context); }
        catch (error) {
          if (error instanceof WorkspaceMigrationBusyError) return open;
          throw error;
        }
        await this.invalidate(taskId, open);
        await this.projections.get(taskId);
        return this.openBound(taskId);
      }
      if (!this.options.resolveNextCwd || await open.readWaitingForInput()) return open;
      let desired: string | undefined;
      try { desired = await this.options.resolveNextCwd(taskId); }
      catch (error) {
        // A broken destination must not prevent cancellation or recovery of the old namespace.
        if (!await open.runtime.canRebindWorkspace()) return open;
        throw error;
      }
      const current = await this.readBinding(taskId);
      if (!desired || !current || resolve(desired) === resolve(current.cwd)) return open;
      // Scan the native graph only when the directory actually changes, not on every UI read.
      if (!await open.runtime.canRebindWorkspace() || signal?.aborted) return open;
      if (!existsSync(desired) || !statSync(desired).isDirectory()) throw new Error(`Bot 工作目录不存在：${desired}`);
      await this.rememberWorkspaceHistory(taskId, open);
      if (signal?.aborted) return open;
      await this.invalidate(taskId, open);
      await this.projections.get(taskId);
      // Persist intent before mutating the native store. A restart resumes this exact migration,
      // including the crash window after native commit and before the SQLite projection commits.
      const move = { fromCwd: current.cwd, toCwd: desired };
      await this.workspaceMoves.write({ kind: "stage", taskId, ...move });
      try { return await this.openBound(taskId); }
      catch (error) {
        if (!(error instanceof WorkspaceMigrationBusyError)) throw error;
        // Native transaction refused before changing any cwd. Restore the original namespace
        // so pending recovery/approval remains reachable; retry the desired move after it settles.
        await this.workspaceMoves.write({ kind: "cancel", taskId, ...move });
        return this.openBound(taskId);
      }
    })();
    this.rebinding.set(taskId, operation);
    void operation.finally(() => { if (this.rebinding.get(taskId) === operation) this.rebinding.delete(taskId); }).catch(() => {});
    return operation;
  }

  private async rememberWorkspaceHistory(taskId: string, open: OpenBot): Promise<void> {
    // UI snapshots are windowed. Record all historical branches before the first directory
    // change so a later fork/history page cannot reinterpret an older relative file path.
    const rows = await open.runtime.harness.commit(async tx => {
      const result: Array<{ messageId: string; cwd: string }> = [];
      let conversations: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 100, conversations);
        for (const conversation of page.items) {
          const cwd = (await tx.doc(AgentDoc, conversation.id)).cwd ?? open.cwd;
          let entries: Cursor | undefined;
          do {
            const history = await tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 500, entries);
            for (const entry of history.items) result.push({ messageId: `durable-${entry.id}`, cwd });
            entries = history.next;
          } while (entries);
        }
        conversations = page.next;
      } while (conversations);
      return result;
    }, context);
    const { db } = this.options;
    await new DurableTaskProjection(db.fixtureConnection, db.runtimeAuditReader).rememberWorkspaces(taskId, rows);
  }

  private openBound(taskId: string): Promise<OpenBot> {
    if (this.closing) return Promise.reject(new Error("Bot runtime is closing"));
    const passive = this.passiveReads.get(taskId);
    if (passive) return passive.then(() => this.openBound(taskId));
    // A failed Session is being torn down; reopen only after its lease/MCP are released.
    const invalidating = this.invalidations.get(taskId);
    if (invalidating) return invalidating.then(() => this.openBound(taskId));
    const existing = this.opened.get(taskId);
    if (existing) {
      if (!existing.runtime.isSessionFailed()) return Promise.resolve(existing);
      this.opened.delete(taskId);
      return this.invalidate(taskId, existing).then(() => this.openBound(taskId));
    }
    const opening = this.opening.get(taskId);
    if (opening) return opening;
    const pending = this.openInternal(taskId).then(open => {
      this.opened.set(taskId, open);
      this.observeFailure(taskId, open);
      return open;
    }).finally(() => this.opening.delete(taskId));
    this.opening.set(taskId, pending);
    return pending;
  }

  /** A failed Session must leave routing so the next open() constructs a fresh Harness over committed content. */
  private observeFailure(taskId: string, open: OpenBot): void {
    open.runtime.onSessionFailed(error => {
      if (this.opened.get(taskId) !== open) return;
      console.warn(`[Durable] Session failed for ${taskId}; reopening on next access`, error);
      void this.invalidate(taskId, open).catch(closeError => console.warn(`[Durable] Failed runtime cleanup failed for ${taskId}`, closeError));
    });
  }

  /** Idempotently evict one OpenBot and release its runtime lease plus MCP clients. */
  private invalidate(taskId: string, open: OpenBot): Promise<void> {
    if (open.closing) return open.closing;
    if (this.opened.get(taskId) === open) this.opened.delete(taskId);
    const closing = (async () => {
      this.options.onRelease?.(taskId);
      await open.runtime.close();
      await open.refreshingMcp?.promise.catch(() => {});
      await Promise.allSettled([open.mcp, ...open.retiredMcp].map(mcp => mcp.close()));
    })().catch(error => { console.warn(`[Durable] Failed to close failed session ${taskId}`, error); });
    open.closing = closing;
    this.invalidations.set(taskId, closing);
    void closing.finally(() => { if (this.invalidations.get(taskId) === closing) this.invalidations.delete(taskId); });
    return closing;
  }

  /** Reopen exactly once on SessionFailed; StorageRequestError and ordinary errors propagate unchanged. */
  private async withRecovery<T>(taskId: string, operation: (open: OpenBot) => Promise<T>): Promise<T> {
    const open = await this.open(taskId);
    try {
      return await operation(open);
    } catch (error) {
      if (!(error instanceof SessionFailed)) throw error;
      await this.invalidate(taskId, open);
      const reopened = await this.open(taskId);
      return operation(reopened);
    }
  }

  private async openInternal(taskId: string): Promise<OpenBot> {
    const { db, agentDir, models } = this.options;
    const core = this.core;
    if (!core) this.options.expertBindings?.ensureLegacy(taskId);
    const [task, state] = await Promise.all([db.readTask(taskId), core ? this.readOpenState(taskId) : undefined]);
    if (!task) throw new Error("任务不存在");
    if (core && (!state || state.trashed)) throw new Error("任务已删除或在回收站中");
    if (isGatewayConversation(taskId) && !task.gatewaySidebarChannelId) throw new Error("网关对话缺少可信渠道，无法打开会话存储");
    const prior = core ? state?.binding ?? undefined : this.binding(taskId);
    const move = core ? state?.workspaceMove ?? undefined : this.workspaceMoves.read(taskId);
    const directoryName = createHash("sha256").update(taskId).digest("hex");
    const originalDirectory = join(agentDir, "durable", directoryName);
    let directory = prior?.directory ?? originalDirectory;
    if (isGatewayConversation(taskId) && task.gatewaySidebarChannelId) {
      if (!core) directory = gatewayConversationDirectory(db, taskId, task.gatewaySidebarChannelId, originalDirectory, prior?.directory);
      else {
        const target = join(gatewayChannelDirectory(db, task.gatewaySidebarChannelId, !prior), directoryName);
        directory = prior?.directory ?? target;
        if (![resolve(originalDirectory), resolve(target)].includes(resolve(directory))) throw new Error("渠道会话存储不属于原会话");
        const entry = lstatSync(directory, { throwIfNoEntry: false });
        if (entry && !entry.isDirectory()) throw new Error("渠道会话目录无效");
      }
    }
    const dots = taskId === DOTS_TASK_ID && this.options.createDotsWorkspace;
    const pinnedDotsWorkspace = dots ? await readDotsWorkspace(directory, context) : undefined;
    const initialDotsWorkspace = dots && !prior && !pinnedDotsWorkspace ? dots() : undefined;
    const dotsWorkspace = pinnedDotsWorkspace ?? initialDotsWorkspace;
    const storedCwd = core ? task.cwd : undefined;
    const cwd = dotsWorkspace ?? move?.toCwd ?? prior?.cwd ?? storedCwd ?? await this.options.resolveCwd(taskId);
    if (isGatewayConversation(taskId)) await this.options.validateGatewayWorkspace?.(taskId, cwd, move?.fromCwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Bot 工作目录不存在：${cwd}`);
    // Pending native operations retain their root; idle moves are committed below.
    if (!core && !move && task.cwd !== cwd) db.bindTaskExecutionWorkspaceCwd(taskId, cwd);
    task.cwd = cwd;
    const taskProjection = new DurableTaskProjection(db.fixtureConnection, db.runtimeAuditReader);
    await taskProjection.bindBot(taskId, directory, cwd, Boolean(pinnedDotsWorkspace && prior?.cwd !== cwd));
    const config = await this.mcpConfiguration(taskId, task);
    const mcp = await DurableMcp.open(config, this.credentials, models, cwd);
    let openedRuntime: DurableBotRuntime | undefined;
    try {
      // Existing project files are not newly produced artifacts on reconnect. Persisted native
      // write/edit records restore their cards independently of this workspace diff baseline.
      // Baseline and the end-of-turn snapshot MUST use the same snapshotWorkspace filter: an
      // unfiltered baseline used to collide with a filtered after snapshot and made every
      // pre-existing project file look like a newly produced artifact of the current turn.
      let workspaceBefore = await snapshotWorkspace(cwd, this.options.db.runtimeAuditReader);
      let projected = "";
      let messageWorkspaces = new Map<string, string>();
      // 打开会话/读历史不是「发请求」：模型目录暂时解析不到也不能阻断，先沿用任务记录的坐标。
      const resolvedModel = await this.resolveTaskModelForOpen(task);
      const selected = resolvedModel?.target;
      const modelRepair = resolvedModel?.repairedFrom
        ? { from: resolvedModel.repairedFrom, to: modelKey(resolvedModel.target) }
        : undefined;
      let domain: DurableDomainTools | undefined;
      try { domain = await this.options.tools?.(task, cwd, mcp); }
      catch (error) { throw new DurableToolAssemblyError(error); }
      const initialHistory = core ? undefined : async () => {
        const legacy = task.sessionFile ? SessionManager.open(task.sessionFile, undefined, cwd) : undefined;
        return legacy ? {
          messages: convertToLlm(legacy.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : [])),
          context: convertToLlm(legacy.buildSessionContext().messages),
        } : undefined;
      };
      const projectionCheckpoint = core ? state?.memoryProjectionEntryId : (db.connection.prepare(
        "SELECT entry_id FROM durable_bot_memory_projection WHERE task_id = ?").get(taskId) as { entry_id: number } | undefined)?.entry_id;
      let previousSnapshot: DurableBotSnapshot | undefined;
      let settledKey: string | undefined;
      // One task + binding read per synchronous permission phase. Approval/resource re-checks
      // land after a microtask, so the gate has already expired and they read fresh state.
      const readActivity = core ? undefined : db.connection.prepare("SELECT updated_at FROM tasks WHERE id = ?").pluck();
      let indexedActivity = task.updatedAt;
      const pendingOrigins = new Map<string, string>();
      let pendingSnapshot: DurableBotSnapshot | undefined;
      let writer: Promise<void> | undefined;
      let projectionError: unknown;

      // A writer belongs to one opened task/epoch. A newer revision replaces only
      // pending metadata; every not-yet-confirmed origin survives coalescing.
      async function writePending(): Promise<void> {
        while (pendingSnapshot) {
          const next = pendingSnapshot;
          pendingSnapshot = undefined;
          const workspaces = Array.from(pendingOrigins, ([messageId, cwd]) => ({ messageId, cwd }));
          try {
            const result = await taskProjection.writeSnapshot(taskId, durableTaskStatus(next), next.activityAt, workspaces);
            indexedActivity = latestActivityTime(indexedActivity, result.activityAt) ?? indexedActivity;
            const visible = new Map(result.workspaces.map(row => [row.messageId, row.cwd]));
            for (const row of next.messages) {
              const known = messageWorkspaces.get(row.id);
              if (known !== undefined) visible.set(row.id, known);
            }
            messageWorkspaces = visible;
            for (const row of workspaces) pendingOrigins.delete(row.messageId);
            projectionError = undefined;
          } catch (error) {
            // Do not replay an uncertain native mutation on the host. A later
            // authoritative revision (including reopen) can rebuild the index.
            projectionError = error;
            console.warn("[Durable] Task index projection failed", taskId, next.revision, error);
          }
        }
        writer = undefined;
      }
      let permissionTask = task;
      if (core) await this.options.prepareToolPermissions?.(task);
      let coreWaitingForInput = core ? await this.readWaitingForInput(taskId) : false;
      let interactionReads: Promise<unknown> = Promise.resolve();
      const readWaitingForInput = () => {
        if (!core) return this.readWaitingForInput(taskId);
        const reading = interactionReads.then(async () => {
          coreWaitingForInput = await this.readWaitingForInput(taskId);
          return coreWaitingForInput;
        });
        interactionReads = reading.catch(() => {});
        return reading;
      };
      const toolGate = new ToolGate(
        () => core ? permissionTask : db.getTask(taskId) ?? task,
        (candidate, name) => this.options.toolAllowed?.(candidate, name) ?? true,
      );
      let permissionRead = 0;
      const refreshPermissions = async (knownTask?: TaskDto) => {
        if (!core) return permissionTask;
        const revision = ++permissionRead;
        const current = knownTask ?? await db.readTask(taskId);
        if (!current) throw new Error("Durable 所属任务已不可用");
        await this.options.prepareToolPermissions?.(current);
        if (permissionRead === revision) {
          permissionTask = current;
          toolGate.reset();
        }
        return current;
      };
      let dotsInputs: Set<string> | undefined;
      let deliveredInput: string | undefined;
      const refreshDotsFacts = async () => {
        if (!core) return;
        const { operationIds, latestOperationId } = await this.readCoreDotsInputs(taskId);
        const delivered = latestOperationId ? await core.readLatestDotsReply(taskId, null) : undefined;
        deliveredInput = delivered?.operationId === latestOperationId ? delivered?.operationId : undefined;
        dotsInputs = operationIds;
      };
      await refreshDotsFacts();
      const routing = taskId === DOTS_TASK_ID ? this.options.answerRouting : undefined;
      const runtime = await DurableBotRuntime.open({ directory, cwd, models, initialHistory,
        codeReview: this.options.codeReview && { taskId, workspace: cwd, review: this.options.codeReview },
        nativeHooks: this.options.nativeHooks && { store: this.options.nativeHooks, readHints: this.options.readHints, cwd, directory,
          improvement: this.options.nativeImprovement, skillAllowed: name => toolGate.allowed("read") && Boolean(this.options.improvementSkillAllowed?.(taskId, name)),
          toolAllowed: name => toolGate.allowed(name), scope: () => {
          const current = core ? permissionTask : db.getTask(taskId);
          if (!current) throw new Error("Hook 所属任务已不可用");
          return { taskId, projectId: current.projectId, spaceId: current.spaceId };
        } },
        answerRouting: routing && {
          enabled: () => this.options.dotsAnswerRoutingEnabled?.() !== false && routing.hasRulesForTask(taskId),
          prepare: (inputId, query, appended) => routing.prepare({ taskId, inputId, query, cwd, appended,
            canRead: () => this.options.canReadAnswerEvidence?.(taskId, "read") ?? toolGate.allowed("read"),
            canReadLibrary: () => this.options.canReadAnswerEvidence?.(taskId, "library_read") ?? toolGate.allowed("library_read") }),
        },
        workspaceMigrationFrom: move?.fromCwd,
        pinInitialDotsWorkspace: initialDotsWorkspace !== undefined,
        projectionAfterEntryId: projectionCheckpoint ?? 0,
        toolAllowed: name => toolGate.allowed(name),
        beforeToolExecution: async (name, args, toolCwd) => {
          await this.options.beforeModelRequest?.(taskId);
          if (core) {
            const current = await refreshPermissions();
            if (this.options.toolAllowed?.(current, name) === false) throw new Error(`当前任务工具已不可用：${name}`);
          }
          if (core || isGatewayConversation(taskId)) await this.readAdmissionCwd(taskId, { cwd, directory }, true);
          this.options.beforeToolExecution?.(taskId, toolCwd, name, args);
        },
        admittingUserInputs: () => Array.from(this.admittingUserInputs.get(taskId) ?? [], item => item.requestId),
        // 产品阈值以同步 getter 注入运行时：运行中改设置不需要重开会话，也不会留在旧副本上。
        // 只有宿主显式提供设置源/状态回调时才启用内嵌上下文管理；直接构造服务的测试
        // （无 productCompaction）沿用 Pi 原生压缩，避免改变既有语义。
        ...(this.options.productCompaction ? {
          contextManagement: {
            policy: this.options.productCompaction,
            engine: () => this.options.compactionEngine?.() ?? "billion-context",
            // 状态从运行时同步回调；这里只转发，不做等待（回调方只 emit UI patch）。
            ...(this.options.onContextStatus ? {
              onStatus: status => {
                try { this.options.onContextStatus?.(taskId, status); }
                catch (error) { console.warn(`[Durable] Context management status push failed for ${taskId}`, error); }
              },
            } : {}),
          },
        } : {}),
        taskId, model: selected, toolMode: this.toolMode(task), maxTurns: this.options.maxTurns?.(task),
        tools: [...mcp.tools, ...domain?.tools ?? []],
        contextHooks: domain?.contextHooks ?? [],
        toolHooks: domain?.toolHooks,
        foregroundHooks: domain?.foregroundHooks,
        restoreTools: names => mcp.restoreTools(names),
        prepareCodeMode: (code, context) => (this.opened.get(taskId)?.mcp ?? mcp).codeModeTools(code, context),
        onDotsProgress: (operationId, identity, at) => this.options.onDotsProgress?.(taskId, operationId, identity, at),
        onEntries: (entries, info) => this.options.onEntries?.(taskId, entries, info),
        onResponse: (message, info) => { this.workMetrics.response(taskId, message, info); this.options.onResponse?.(taskId, message, info); },
        onRequest: info => this.options.onRequest?.(taskId, info),
        onGoalToolResult: (identity, tool) => this.options.onGoalToolResult?.(taskId, identity, tool),
        verifyGoalContinuation: core && taskId !== DOTS_TASK_ID && !isGatewayConversation(taskId) ? async origin => {
          if (!this.options.verifyGoalContinuation) throw new Error("Goal 自动续跑的执行宿主未就绪");
          await this.options.verifyGoalContinuation(origin);
        } : undefined,
        beforeProviderRequest: async () => {
          await this.options.beforeModelRequest?.(taskId);
          if (core) await Promise.all([refreshPermissions(), refreshDotsFacts()]);
          if (core || isGatewayConversation(taskId)) await this.readAdmissionCwd(taskId, { cwd, directory }, true);
          const fixture = this.options.db.fixtureConnection;
          if (fixture) recordCollaborationExecutionStarted(fixture, taskId);
        },
        providerAuthorityGuarded: () => this.options.providerAuthorityGuarded?.(taskId) ?? false,
        onProviderUsage: input => { this.workMetrics.usage(taskId, input); this.options.onProviderUsage?.(taskId, input); },
        onTool: this.options.onTool,
        onGoalToolEvidence: this.options.onGoalToolEvidence ? (...args) => this.options.onGoalToolEvidence?.(taskId, ...args) : undefined,
        observedUsage: conversationId => this.options.observedUsage?.(taskId, conversationId) ?? { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheHitRate: null },
        waitingForInput: () => core ? coreWaitingForInput : this.options.waitingForInput?.(taskId) ?? false,
        evidence: messages => this.options.evidence?.(core ? permissionTask : db.getTask(taskId) ?? task, messages) ?? "",
        evidenceProjection: this.options.evidenceProjection?.(task),
        isDotsWorkerInput: requestId => /^(?:dots-input-|goal-continuation:)/.test(requestId) &&
          (dotsInputs?.has(requestId) ?? this.hasDotsDelegation(taskId, requestId)),
        dotsRecoveryScope: this.options.dotsRecoveryScope && (operationId => this.options.dotsRecoveryScope?.(taskId, operationId)),
        hasDotsDelegation: () => dotsInputs ? dotsInputs.size > 0 : this.hasDotsDelegation(taskId),
        deliveredDotsInput: () => core ? deliveredInput : this.deliveredDotsInput(taskId),
        isDelegatedMemoryInput: requestId => (taskId === DOTS_TASK_ID && isDotsAutomaticInput(requestId)) || (requestId.startsWith("dots-input-")
          && (dotsInputs?.has(requestId) ?? this.hasDotsDelegation(taskId, requestId))),
        onTurns: this.options.onTurns && (turns => this.options.onTurns!(taskId, turns)),
        assets: durableSandboxAssets(this.options.assetsDir),
        instructions: async () => this.options.instructions((await db.readTask(taskId)) ?? task),
        prepareSnapshot: async snapshot => {
          snapshot.activityAt = latestActivityTime(snapshot.activityAt, core ? indexedActivity : readActivity?.get(taskId));
          for (const message of snapshot.messages) {
            if (!messageWorkspaces.has(message.id)) pendingOrigins.set(message.id, cwd);
          }
          pendingSnapshot = snapshot;
        },
        drainTaskProjection: async () => { await writer; },
        onSnapshot: snapshot => {
          this.workMetrics.project(taskId, snapshot);
          const { messages: _messages, epoch: _epoch, revision: _revision, ...state } = snapshot;
          this.options.emit(previousSnapshot?.epoch === snapshot.epoch
            ? { type: "durable_delta", taskId, delta: durableDelta(previousSnapshot, snapshot, state) }
            : { type: "durable_snapshot", taskId, snapshot });
          previousSnapshot = snapshot;
          writer ??= Promise.resolve().then(writePending);
          if (snapshot.contextUsage) this.options.emit({ type: "context_usage", taskId, ...snapshot.contextUsage });
        },
        onProjected: async snapshot => {
          if (snapshot.busy || snapshot.queued) return;
          await writer;
          // The Durable snapshot owns the conversation outcome. Consumers that
          // require a committed app.db index run only after a confirmed write.
          if (projectionError) return;
          const signature = lastConversationMessageId(snapshot);
          if ((!dots || dotsWorkspace) && !snapshot.busy && signature && signature !== projected && this.options.projectArtifacts) {
            projected = signature;
            const origins = messageWorkspaces;
            const projection = (this.projections.get(taskId) ?? Promise.resolve()).then(async () => {
              await this.options.projectArtifacts!(taskId, snapshot, workspaceBefore, cwd, origins);
              workspaceBefore = await snapshotWorkspace(cwd, this.options.db.runtimeAuditReader);
            }).catch(error => console.warn("[Durable] Artifact projection failed", taskId, error));
            this.projections.set(taskId, projection);
          }
          const key = `${snapshot.conversationId}:${lastConversationMessageId(snapshot)}:${snapshot.outcome ?? ""}`;
          if (!snapshot.busy && !snapshot.queued && snapshot.outcome && key !== settledKey) {
            settledKey = key;
            const currentInput = [...snapshot.messages].reverse().find(message => message.role === "user")?.inputRequestId;
            if (currentInput) routing?.clearPreparedTurns(taskId, currentInput);
            await this.options.onSettled?.(taskId, snapshot);
          }
        },
      });
      openedRuntime = runtime;
      if (move) await this.workspaceMoves.write({ kind: "commit", taskId, ...move, cwd, at: Date.now() });
      return { runtime, mcp, cwd, directory, readWaitingForInput, refreshPermissions, mcpConfigKey: JSON.stringify(config), retiredMcp: new Set(), dotsWorkspace,
        ...(modelRepair ? { modelRepair } : {}) };
    } catch (error) { await openedRuntime?.close(); await mcp.close(); throw error; }
  }

  private async mcpConfiguration(taskId: string, knownTask?: TaskDto) {
    const config = this.config.loadRuntimeConfig();
    const task = knownTask ?? await this.options.db.readTask(taskId);
    const selected = task && this.options.mcpSelection ? await this.options.mcpSelection(task)
      : this.core ? task?.expertBinding?.active?.mcpIds : this.options.expertBindings?.active(taskId)?.mcpIds;
    const selectedConfig = selected === undefined ? config : {
      ...config, mcpServers: Object.fromEntries(Object.entries(config.mcpServers ?? {}).filter(([id]) => selected.includes(id))),
    };
    // Project the existing entries unchanged: a selected disabled service stays disabled.
    return toNativeMcpConfig(emptyMcpFilterResult(selectedConfig), this.config.getAppGlobalConfigPath(), false);
  }

  private async configuredMcp(open: OpenBot, cwd: string, task: TaskDto): Promise<DurableMcp> {
    const config = await this.mcpConfiguration(task.id, task);
    const key = JSON.stringify(config);
    if (key === open.mcpConfigKey) return open.mcp;
    if (open.refreshingMcp?.key === key) return open.refreshingMcp.promise;
    const promise = DurableMcp.open(config, this.credentials, this.options.models, cwd).then(mcp => {
      // In-flight native ToolTasks may still own the previous client. Keep it alive until release.
      open.retiredMcp.add(open.mcp);
      open.mcp = mcp; open.mcpConfigKey = key;
      return mcp;
    });
    open.refreshingMcp = { key, promise };
    try { return await promise; }
    finally { if (open.refreshingMcp?.promise === promise) open.refreshingMcp = undefined; }
  }

  /**
   * 任务持久化的模型坐标可能已被模型目录淘汰（网关路由重组、厂商目录收缩）。
   * 这里按 BotModelCatalog 的确定规则替换并**立即写回任务**，让输入框后续显示与实际执行一致；
   * 替换事实存进 OpenBot.modelRepair，历史打开时作为 modelRecovery 展示，不静默换模型。
   */
  private async resolveTaskModel(task: TaskDto): Promise<BotModelResolution> {
    if (task.id === DOTS_TASK_ID && this.options.dotsModel) return { target: await this.options.dotsModel() };
    const resolution = await resolveBotModel(this.options.models, task.modelId, this.options.defaultModel());
    const target = resolution.target;
    if (!resolution.repairedFrom) return resolution;
    const repair: BotModelRepair = { from: resolution.repairedFrom, to: modelKey(target) };
    const current = await this.options.db.readTask(task.id) ?? task;
    if (current.modelId !== repair.to) {
      // updatedAt 保持不变：修复模型归属不应把任务顶到列表最前。
      await this.options.db.writeTaskRecord({
        id: current.id, title: current.title, updatedAt: current.updatedAt, modelId: repair.to,
      }, { preserveTitle: true });
      console.warn(`[Durable] 任务 ${task.id} 的模型 ${repair.from} 已不在模型目录中，改用 ${repair.to}（${resolution.reason}）`);
    }
    return resolution;
  }

  /**
   * 打开会话（含只读历史）时的模型解析：尽力而为，绝不抛错。
   * 模型目录 = 为「发请求」准备的运行时配置；历史能否打开只取决于 Durable 存储本身。
   */
  private async resolveTaskModelForOpen(task: TaskDto): Promise<BotModelResolution | undefined> {
    try { return await this.resolveTaskModel(task); }
    catch (error) {
      console.warn(`[Durable] 任务 ${task.id} 暂时解析不到可用模型，打开会话先沿用 ${task.modelId ?? "(未记录)"}：${failureText(error)}`);
      return undefined;
    }
  }

  private async prepareRequest(request: AgentPromptRequest, mark?: AdmissionMark, signal?: AbortSignal): Promise<AgentPromptRequest> {
    request = await this.options.prepareTask?.(request, mark) ?? request;
    signal?.throwIfAborted();
    mark?.("task");
    await this.options.models.refresh({ allowNetwork: false });
    signal?.throwIfAborted();
    mark?.("catalog");
    if (!this.core) this.options.expertBindings?.ensureLegacy(request.taskId);
    const task = await this.options.db.readTask(request.taskId);
    if (!task) throw new Error("任务不存在");
    signal?.throwIfAborted();
    const expertBinding = this.core ? task.expertBinding : this.options.expertBindings?.get(task.id);
    // Product selections are durable task configuration, never global scene state.
    await this.options.db.writeTaskRecord({ id: task.id, title: task.title,
      modelId: task.id === DOTS_TASK_ID ? task.modelId : request.modelId ?? task.modelId,
      permissionMode: request.permissionMode ?? task.permissionMode,
      welcomeMode: request.welcomeMode ?? task.welcomeMode,
      expertId: expertBinding ? task.expertId : request.expertId ?? task.expertId,
      modePresetId: request.modePresetId !== undefined ? request.modePresetId : task.modePresetId, updatedAt: Date.now() },
    { preserveTitle: true });
    return request;
  }

  private async configureRequest(open: OpenBot, request: AgentPromptRequest, mark?: AdmissionMark,
    signal?: AbortSignal): Promise<BotModelResolution["target"]> {
      const { db, expertBindings } = this.options;
      const core = this.core;
      let current = await db.readTask(request.taskId);
      if (!current) throw new Error("任务不存在");
      // Admission is serialized. Queued inputs and resumed work finish with the old active identity;
      // only a newly admitted input after native idle can adopt a saved desired revision.
      if (await open.runtime.isIdle()) {
        if (core) {
          if (current.expertBinding?.pending && !await open.readWaitingForInput()) {
            signal?.throwIfAborted();
            const promoted = await core.batch2Write<{ ok: boolean }>({ kind: "taskExpertPromote", taskId: request.taskId, updatedAt: Date.now() });
            if (!promoted?.ok) throw new Error("Core 未确认任务专家配置已激活");
            current = await db.readTask(request.taskId);
            if (!current) throw new Error("任务不存在");
            if (current.expertBinding) this.options.emit({ type: "expert_binding", taskId: request.taskId, binding: current.expertBinding });
          }
        } else {
          const before = expertBindings?.get(request.taskId);
          const binding = expertBindings?.promote(request.taskId);
          if (before?.pending && binding) this.options.emit({ type: "expert_binding", taskId: request.taskId, binding });
          current = await db.readTask(request.taskId);
          if (!current) throw new Error("任务不存在");
        }
      }
      const cwd = await this.readAdmissionCwd(request.taskId, open);
      signal?.throwIfAborted();
      const requirements = request.dotsRequiredCapabilities;
      if (requirements?.length) await this.options.assertDotsCapabilities?.(current, cwd, requirements);
      const mcp = await this.configuredMcp(open, cwd, current);
      mark?.("mcp");
      // 只有真正要发请求时才要求模型可用：这里解析失败会明确报错，而不是把会话标成损坏。
      const resolvedModel = await this.resolveTaskModel(current);
      // 替换提示是一次性的开卷告知：一旦本轮能按任务模型正常执行（用户也可能已手动改选模型），就收起。
      open.modelRepair = resolvedModel.repairedFrom
        ? { from: resolvedModel.repairedFrom, to: modelKey(resolvedModel.target) }
        : undefined;
      const domain = await this.options.tools?.(current, cwd, mcp);
      mark?.("tools");
      const configuredRequest = current.id === DOTS_TASK_ID ? { ...request, modelId: modelKey(resolvedModel.target) } : request;
      const verifyTools = requirements?.length ? async (tools: ReadonlySet<string>) => {
        for (const requirement of requirements) {
          if (requirement.kind === "tool" && !tools.has(requirement.id))
            throw new DotsCapabilityUnavailable(requirement, "执行环境中没有登记可调用的该工具。");
          if (requirement.kind !== "mcp") continue;
          const callable = requirement.tool ? tools.has("mcp_list_tools") && tools.has("mcp_call_tool")
            : tools.has("mcp_call_tool") || tools.has("mcp_read_resource");
          if (!callable)
            throw new DotsCapabilityUnavailable(requirement, "当前执行工具策略未开放 MCP 调用。");
          let available: boolean;
          try {
            available = await mcp.hasRequiredCapability(requirement.id, requirement.tool, signal ? withAbortSignal(signal, context) : context);
          } catch {
            signal?.throwIfAborted();
            throw new DotsCapabilityUnavailable(requirement, "未能连接该服务或取得可用工具目录，请检查服务与认证设置。");
          }
          if (!available) throw new DotsCapabilityUnavailable(requirement, "该服务的工具目录没有开放所需工具。");
        }
      } : undefined;
      await open.refreshPermissions(current);
      await open.runtime.configure(resolvedModel.target, this.toolMode(current), this.options.thinking?.(current, configuredRequest),
        [...mcp.tools, ...domain?.tools ?? []], domain?.contextHooks ?? [], domain?.toolHooks, domain?.foregroundHooks, verifyTools);
      mark?.("configure");
      return resolvedModel.target;
  }

  private async admit(request: AgentPromptRequest, signal: AbortSignal, origin?: DurableInputOrigin, mark?: AdmissionMark) {
    // Committed retries retain their original configuration and input preparation.
    const binding = await this.readBinding(request.taskId);
    signal.throwIfAborted();
    if (binding) {
      const existing = await this.withRecovery(request.taskId, async open => {
        const record = await this.findSubmissionRecord(open, request.userMessageId);
        if (record?.type === "input" && origin?.gatewayOrigin) {
          const id = record.entry;
          const entry = id === undefined ? undefined : await open.runtime.conversation.commit(tx => tx.entry(id), context);
          const source = (entry?.data as { mybuddyInput?: import("./DurableHistoryProjection").DurableInputMetadata })?.mybuddyInput?.gatewayOrigin;
          const incoming = origin.gatewayOrigin;
          if (!source || source.channelId !== incoming.channelId || source.connectionKey !== incoming.connectionKey
            || source.senderId !== incoming.senderId || source.chatId !== incoming.chatId || source.messageId !== incoming.messageId
            || source.audience !== incoming.audience || source.personalMemoryBindingId !== incoming.personalMemoryBindingId) {
            throw new Error("原渠道消息来源或记忆授权已改变，请发送新消息");
          }
        }
        const submission = record && await open.runtime.harness.submission(record.id, context);
        return submission ? { submission, open } : undefined;
      });
      signal.throwIfAborted();
      if (existing) return existing;
    }
    mark?.("deduplicate");
    request = await this.prepareRequest(request, mark, signal);
    signal.throwIfAborted();
    mark?.("taskPersisted");
    return this.withRecovery(request.taskId, async open => {
      signal.throwIfAborted();
      mark?.("opened");
      if (origin?.gatewayOrigin && request.attachments?.length) {
        request = { ...request, attachments: await importGatewayAttachments(await this.readAdmissionCwd(request.taskId, open),
          request.userMessageId, request.attachments) };
      }
      const model = await this.configureRequest(open, request, mark, signal);
      let text = await this.options.prepareInput?.(request) ?? request.text;
      if (!this.options.prepareInput && request.terminalContext) text += `\n\nTerminal context supplied by the user:\n${JSON.stringify(request.terminalContext)}`;
      const content: Exclude<import("@earendil-works/pi-durable").UserInput, string> = [{ type: "text", text }];
      if (this.options.prepareImages) {
        const images = await this.options.prepareImages({ ...request, modelId: modelKey(model) });
        content.push(...images.images);
        if (images.text) content.push({ type: "text", text: images.text });
      }
      for (const attachment of request.attachments ?? []) {
        const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" } as Record<string,string>)[extname(attachment.path).toLowerCase()];
        if (mime && !this.options.prepareImages) content.push({ type: "image", mimeType: mime, data: readFileSync(attachment.path).toString("base64") });
        content.push({ type: "text", text: `\nAttached file: ${attachment.name}\n${attachment.path}` });
      }
      const audit = await this.options.auditInput?.(request, origin);
      signal.throwIfAborted();
      await this.options.beforeSubmit?.(request);
      signal.throwIfAborted();
      mark?.("payload");
      const guarded = request.dotsFileWatch || request.dotsSteerInputVersion || origin?.goalContinuation || origin?.goalUserInput
        || request.userMessageId.startsWith("dots-input-") || request.taskId === DOTS_TASK_ID && isDotsAutomaticInput(request.userMessageId);
      const submission = await open.runtime.submit(content, request.userMessageId, request.streamingBehavior,
        { dotsMemoryRefs: request.dotsMemoryRefs, text: request.text, displayText: request.displayText ?? request.text, attachments: request.attachments ?? [],
          ...(audit ? { audit } : {}), ...(origin?.gatewayOrigin ? { gatewayOrigin: origin.gatewayOrigin } : {}),
          ...(origin?.goalContinuation ? { goalContinuation: origin.goalContinuation } : {}),
          ...(origin?.goalUserInput ? { goalUserInput: origin.goalUserInput } : {}) }, mark, request.requireActiveRun,
        { inputVersion: request.dotsFileWatch?.inputVersion ?? request.dotsSteerInputVersion, validate: async () => {
          signal.throwIfAborted();
          if (guarded || !this.options.db.fixtureConnection) await this.options.beforeSubmit?.(request);
          if (this.core || isGatewayConversation(request.taskId)) await this.readAdmissionCwd(request.taskId, open);
          signal.throwIfAborted();
        } });
      return { submission, open };
    });
  }

  private async admitTracked(request: AgentPromptRequest, origin?: DurableInputOrigin) {
    const controller = new AbortController();
    const { signal } = controller;
    const admit = async (mark?: AdmissionMark) => {
      const pending = this.trackAdmission(request.taskId,
        () => this.admit(request, signal, origin, mark), mark, controller);
      const stopped = Promise.withResolvers<never>();
      const onStop = () => stopped.reject(signal.reason);
      signal.addEventListener("abort", onStop, { once: true });
      try { return await Promise.race([pending, stopped.promise]); }
      finally { signal.removeEventListener("abort", onStop); }
    };
    if (process.env.MYBUDDY_ADMISSION_TRACE !== "1") return admit();
    // Time only; never record the input, files, credentials or provider payload.
    const timestamps: Record<string, number> = {};
    const start = performance.now();
    const mark: AdmissionMark = stage => { timestamps[stage] = Math.round((performance.now() - start) * 10) / 10; };
    try { return await admit(mark); }
    catch (error) {
      if (error instanceof Error) {
        const cause = error.cause instanceof Error ? error.cause : error;
        console.warn("[SendAdmission] failed", cause.stack?.split("\n").slice(1).join("\n"));
      }
      throw error;
    }
    finally { mark("finished"); console.info("[SendAdmission]", JSON.stringify({ inputId: request.userMessageId, ...timestamps })); }
  }

  private trackAdmission<T>(taskId: string, operation: () => Promise<T>, mark?: AdmissionMark, controller?: AbortController): Promise<T> {
    const prior = this.admissionTails.get(taskId) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(async () => {
      controller?.signal.throwIfAborted();
      mark?.("queue");
      const task = await this.options.db.readTask(taskId, { includeExpertBinding: false });
      controller?.signal.throwIfAborted();
      if (task) await this.open(taskId, true, controller?.signal);
      mark?.("preopen");
      controller?.signal.throwIfAborted();
      return operation();
    });
    this.admissionTails.set(taskId, pending);
    const admissions = this.admissions.get(taskId) ?? new Map();
    admissions.set(pending, controller);
    this.admissions.set(taskId, admissions);
    return pending.finally(() => {
      admissions.delete(pending);
      if (!admissions.size) this.admissions.delete(taskId);
      if (this.admissionTails.get(taskId) === pending) this.admissionTails.delete(taskId);
    });
  }

  async deleteUserMessage(request: AgentDeleteUserMessageRequest): Promise<number> {
    return this.trackAdmission(request.taskId, async () => {
      // Stop inside this admission so the delete owns its own quiescence. The renderer's stop is a
      // separate, racing IPC call: with 9 subagent children live it only reaches the root branch and
      // leaves the children running, which is what made the retry loop hang without any error.
      await this.stopWithinAdmission(request.taskId);
      const open = await this.open(request.taskId);
      const selected = await findDurableUserEntry(open.runtime.conversation, request, context);
      const timestamp = selected.entry.model?.find(message => message.role === "user")?.timestamp ?? 0;
      await open.runtime.forkAt(selected.previous?.id);
      await this.release(request.taskId);
      await this.open(request.taskId);
      return timestamp;
    });
  }

  async openDots() {
    await this.options.db.openDotsAsync();
    await this.open(DOTS_TASK_ID);
    const task = await this.options.db.readTask(DOTS_TASK_ID);
    if (!task) throw new Error("未能读回 Dots 对话");
    return task;
  }

  async newDotsConversation(): Promise<void> {
    await this.options.db.openDotsAsync();
    return this.trackAdmission(DOTS_TASK_ID, async () => {
      const open = await this.open(DOTS_TASK_ID);
      if (!this.options.createDotsWorkspace) throw new Error("Dots 工作目录尚未初始化。");
      if (open.runtime.snapshot.busy || open.runtime.snapshot.queued) throw new Error("任务仍在运行，请先停止生成");
      await open.runtime.newDotsConversation(this.options.createDotsWorkspace());
      await this.release(DOTS_TASK_ID);
      await this.open(DOTS_TASK_ID);
    });
  }

  /**
   * Cancellation for a caller that already holds this task's admission. Native abort covers the
   * root conversation and, with `background`, every conversation reachable through a live task —
   * including the one each subagent child owns, so the subtree settles before the fork proceeds.
   */
  private async stopWithinAdmission(taskId: string): Promise<void> {
    // `trackAdmission` already ran `open(taskId, true)` before this body, so the runtime is bound.
    // Reuse it: going through withRecovery/open here would spend a second open on the same task and,
    // if the stop never settles, leave that open occupying `rebinding` for every later caller.
    const open = this.opened.get(taskId);
    if (!open) return;
    try {
      // Background abort resolves only once every reached task is terminal, and this service's
      // context carries no abort signal to cut that wait. A child that never settles would hold the
      // delete open forever — the "deleting…" state that neither finished nor reported an error — so
      // the wait is bounded and the fork below decides on the state it actually reached.
      const stopped = await this.withinStopBudget("delete stop",
        () => Promise.all([open.runtime.abort(), stopDurableSubagentsForTask(taskId)]));
      if (!stopped) console.warn(`[Durable] Stop before delete is still settling for ${taskId}`);
    } catch (error) { console.warn(`[Durable] Stop before delete failed for ${taskId}`, error); }
    finally { this.options.onRelease?.(taskId); }
  }

  /** Run a stop under a deadline and report whether it settled, without leaving a shared slot behind. */
  private async withinStopBudget(label: string, stop: () => Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => { console.warn(`[Durable] ${label} did not settle within ${STOP_SETTLEMENT_TIMEOUT_MS}ms`); resolve(false); }, STOP_SETTLEMENT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([stop().then(() => true), deadline]);
    } finally { clearTimeout(timer); }
  }

  async regenerate(request: AgentRegenerateRequest): Promise<AgentRegenerateResult> {
    return this.trackAdmission(request.taskId, async () => {
      const fail = (code: Extract<AgentRegenerateResult, { ok: false }>["code"], message: string): AgentRegenerateResult => ({ ok: false, requestId: request.requestId, code, message });
      try {
        if (!await this.options.db.readTask(request.taskId, { includeExpertBinding: false })) return fail("SESSION_NOT_FOUND", "任务不存在");
        const open = await this.open(request.taskId);
        const operationId = `regenerate:${request.requestId}`;
        const existing = await open.runtime.conversation.commit(tx => tx.submissionByRequest(open.runtime.conversation.id, operationId), context);
        if (existing?.type === "input") return { ok: true, requestId: request.requestId, assistantMessageId: request.assistantMessageId, userEntryId: existing.entry && String(existing.entry) };
        if (!await open.runtime.isIdle()) return fail("SESSION_BUSY", "任务仍在执行，请先停止生成");
        const selected = await findDurableUserEntry(open.runtime.conversation, { entryId: request.sourceUserEntryId, userMessageIndex: request.userMessageIndex }, context);
        const user = selected.entry.model?.find(message => message.role === "user");
        if (!user) return fail("TARGET_NOT_FOUND", "找不到所选用户输入");
        const metadata = open.runtime.inputMetadata(selected.entry.id);
        if (request.sourceUserMessageId !== `durable-${selected.entry.id}` && request.sourceUserMessageId !== metadata?.audit?.userMessageId) {
          return fail("TARGET_DRIFTED", "所选用户消息身份已变化，请刷新对话");
        }
        const displayText = metadata?.displayText ?? durableContentText(user.content);
        if (request.expectedUserTextHash && normalizedEditorTextHash(displayText) !== request.expectedUserTextHash) return fail("TARGET_DRIFTED", "所选输入已发生变化，请刷新对话");
        const prepared = await this.prepareRequest({ ...request, text: displayText, displayText, userMessageId: operationId });
        await this.configureRequest(open, prepared);
        const audit = await this.options.auditInput?.(prepared);
        await open.runtime.forkForRegeneration(selected.previous?.id, { operationId, content: user.content,
          metadata: { ...(metadata ?? { text: displayText, displayText, attachments: [] }), ...(audit ? { audit } : {}) } });
        await this.release(request.taskId);
        const submission = await (await this.open(request.taskId)).runtime.resumeRegeneration();
        if (!submission) throw new Error("重新生成回执不存在");
        const state = await submission.status(context);
        return { ok: true, requestId: request.requestId, assistantMessageId: request.assistantMessageId, userEntryId: state.entry && String(state.entry) };
      } catch (error) { return fail(error instanceof DurableUserEntryNotFoundError ? "TARGET_NOT_FOUND" : "PROMPT_FAILED", failureText(error)); }
    });
  }

  async submit(request: AgentPromptRequest, origin?: DurableInputOrigin): Promise<AgentPromptResult> {
    const inputs = origin?.goalContinuation ? undefined : this.admittingUserInputs.get(request.taskId) ?? new Set<{ requestId: string }>();
    const input = { requestId: request.userMessageId };
    if (inputs) {
      inputs.add(input);
      this.admittingUserInputs.set(request.taskId, inputs);
    }
    try {
      const { submission } = await this.admitTracked(request, origin);
      const state = await submission.status(context);
      return submissionResult(request.taskId, state);
    } catch (error) {
      if (error instanceof InputAdmissionStopped) return { queued: false, cancelled: true };
      throw error;
    } finally {
      inputs?.delete(input);
      if (inputs?.size === 0) this.admittingUserInputs.delete(request.taskId);
    }
  }





  /** Inspect an accepted input before an adapter validates or changes mutable task configuration. */
  async findSubmission(taskId: string, operationId: string): Promise<AgentPromptResult | undefined> {
    if (!operationId) throw new Error("无效执行身份");
    await this.admissionTails.get(taskId)?.catch(() => {});
    if (!await this.readBinding(taskId)) return undefined;
    return this.withRecovery(taskId, async open => {
      const record = await this.findSubmissionRecord(open, operationId);
      return record?.type === "input" ? submissionResult(taskId, record) : undefined;
    });
  }

  /** Resolve the exact accepted input. A later answer in the same task is never its result. */
  private isDotsWorkerInput(taskId: string, requestId: string): boolean {
    return /^(?:dots-input-|goal-continuation:)/.test(requestId) && this.hasDotsDelegation(taskId, requestId);
  }

  private hasDotsDelegation(taskId: string, requestId?: string): boolean {
    const db = this.options.db.connection;
    if (taskId === DOTS_TASK_ID || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dots_delegations'").get()) return false;
    return requestId === undefined
      ? Boolean(db.prepare("SELECT 1 FROM dots_delegations WHERE task_id=? LIMIT 1").get(taskId))
      : Boolean(db.prepare("SELECT 1 FROM dots_delegations WHERE task_id=? AND operation_id=?").get(taskId, requestId));
  }

  private deliveredDotsInput(taskId: string): string | undefined {
    const db = this.options.db.connection;
    if (!this.hasDotsDelegation(taskId) || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dots_reply_events'").get()) return;
    return db.prepare(`SELECT latest.operation_id FROM (
      SELECT operation_id,status FROM dots_delegations WHERE task_id=? ORDER BY seq DESC LIMIT 1
    ) latest WHERE latest.status='completed' AND EXISTS (
      SELECT 1 FROM dots_reply_events WHERE operation_id=latest.operation_id AND settled=1 AND json_valid(snapshot)
        AND json_extract(snapshot,'$.delivered')='conclusion'
    )`).pluck().get(taskId) as string | undefined;
  }

  async dotsSubmission(taskId: string, operationId: string, requestedFilename?: string):
    Promise<(DurableDotsOutcome & { completion?: import("../../dots/DotsGoalConclusion").DotsGoalCompletion }) | undefined> {
    const binding = await this.readBinding(taskId);
    if (!binding) return undefined;
    return this.withRecovery(taskId, async open => {
      const input = await this.findSubmissionRecord(open, operationId);
      if (!input || input.type !== "input") return undefined;
      let question: import("../../../shared/conversation-interaction").ConversationInteractionDto | undefined;
      if (input.status === "queued") return { status: "running" as const, text: "", messageIds: [], files: [] };
      if (input.status === "placed") {
        const live = await open.runtime.harness.snapshot(LiveDoc, input.conversationId, context);
        if (live?.run?.inputs.at(-1) === input.id) {
          const core = this.core;
          const snapshot = core && await core.readConversationRuntime(taskId, LOCAL_USER_ID);
          if (core && snapshot === undefined) throw new Error("Core 未确认原任务待答问题");
          const fixture = core ? undefined : new ConversationInteractionRepository(this.options.db.connection);
          const pending = new Map(snapshot?.interactions.filter(row => row.status === "pending").map(row => [row.execution_id, row]));
          for (const slot of [...live.tools ?? [], ...live.nestedTools ?? []]) {
            if (!slot.taskId || slot.status === "done") continue;
            const executionId = `durable:${taskId}:${input.conversationId}:${slot.taskId}`;
            const row = pending.get(executionId);
            const found = row ? mapConversationInteraction(row) : fixture?.pendingByExecution(executionId);
            if (found?.taskId === taskId) { question = found; break; }
          }
        }
        if (live?.run?.inputs.at(-1) !== input.id) return { status: "running" as const, text: "", messageIds: [], files: [] };
      }
      let acceptance: { text: string; completion?: import("../../dots/DotsGoalConclusion").DotsGoalCompletion } | null | undefined;
      if (input.status === "done" || input.status === "unanswered") {
        const core = this.core;
        if (core) {
          acceptance = await core.readDotsFollowupData({ kind: "conclusion", taskId, operationId });
          if (acceptance === undefined) throw new Error("Core 未确认原任务 Goal 回执");
        } else if (this.hasDotsDelegation(taskId, operationId)) {
          acceptance = dotsGoalConclusion(this.options.db.connection, taskId, operationId);
        }
      }
      const proof = acceptance?.completion?.native;
      const accepted = proof && (proof.conversationId !== input.conversationId || proof.submissionId !== input.id ||
        proof.entryId !== input.entry) ? undefined : acceptance;
      const result = await open.runtime.conversation.commit(
        tx => readDurableDotsResult(tx, input, binding.directory, question, accepted ?
          { text: accepted.text, citations: accepted.completion?.citations } : undefined, requestedFilename), context);
      // Logical waits can outlive a completed native turn. Refreshing them here
      // wakes the same Dots inspector again even though no new result exists.
      if (input.status === "done" && result.status !== "blocked") await open.runtime.refresh();
      await this.projections.get(taskId);
      return { ...result, completion: accepted?.completion };
    });
  }

  private findSubmissionRecord(open: OpenBot, operationId: string): Promise<SubmissionRecord | undefined> {
    return open.runtime.conversation.commit(async tx => {
      const current = await tx.submissionByRequest(open.runtime.conversation.id, operationId);
      if (current) return current;
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 200, cursor);
        for (const conversation of page.items) {
          if (conversation.owner || conversation.id === open.runtime.conversation.id) continue;
          const prior = await tx.submissionByRequest(conversation.id, operationId);
          if (prior) return prior;
        }
        cursor = page.next;
      } while (cursor);
      return undefined;
    }, context);
  }

  /** Scheduling inspection only: opens the native session if needed, never submits. */
  async inspect(taskId: string): Promise<DurableBotSnapshot | undefined> {
    if (!await this.ownsTask(taskId)) return undefined;
    const open = await this.open(taskId);
    await open.runtime.refresh();
    return open.runtime.snapshot;
  }

  async goalContinuationStoreId(taskId: string): Promise<string | undefined> {
    const core = this.core;
    const open = this.opened.get(taskId);
    if (!core || !open || open.closing || this.closing) return;
    const storeId = await resolveStoreId(core, open.directory);
    if (this.opened.get(taskId) === open && !open.closing && !this.closing) return storeId;
  }

  async inspectGoalContinuation(taskId: string): Promise<CoreGoalRuntimeWindow | undefined> {
    await this.admissionTails.get(taskId)?.catch(() => undefined);
    const open = this.opened.get(taskId);
    if (!open || !this.goalWindowAvailable(taskId, open)) return;
    const storeId = await this.goalContinuationStoreId(taskId);
    if (!storeId) return;
    if (await open.readWaitingForInput()) return;
    const snapshot = await open.runtime.refresh();
    if (!this.goalWindowAvailable(taskId, open) || snapshot.busy || snapshot.queued > 0 || snapshot.compacting
      || snapshot.status === "waiting_input") return;
    return { snapshot, storeId };
  }

  private goalWindowAvailable(taskId: string, open: OpenBot): boolean {
    return Boolean(this.core && taskId !== DOTS_TASK_ID && !isGatewayConversation(taskId) && !this.closing && !open.closing && !open.runtime.isSessionFailed()
      && this.opened.get(taskId) === open && !this.admissionTails.has(taskId)
      && !this.admittingUserInputs.get(taskId)?.size);
  }

  async submitClaimedGoalContinuation(claim: CoreGoalContinuationClaim, policyCurrent: () => Promise<boolean>): Promise<CoreGoalPlacement> {
    const taskId = claim.taskId;
    if (this.goalAdmissions.has(taskId)) return "unknown";
    const open = this.opened.get(taskId);
    if (!open || !this.options.verifyGoalContinuation || !this.goalWindowAvailable(taskId, open)) return "rejected";
    const trace = (stage: string, error?: unknown) => {
      if (process.env.MYBUDDY_ADMISSION_TRACE === "1") console.info("[GoalContinuation]", taskId, stage, error instanceof Error ? error.message : "");
    };
    const controller = new AbortController();
    this.goalAdmissions.set(taskId, controller);
    const origin: DurableInputOrigin = { goalContinuation: { taskId, workId: claim.workId, intentRevision: claim.intentRevision,
      ownerEpoch: claim.ownerEpoch, attempt: claim.attempt, attemptSerial: claim.attemptSerial, claimOperationId: claim.operationId,
      hostGeneration: claim.hostGeneration, storeId: claim.storeId } };
    const request: AgentPromptRequest = { taskId, userMessageId: claim.requestId, assistantMessageId: claim.assistantMessageId,
      text: continuationNudge(claim.attempt, claim.maxAttempts, claim.budget === null ? null : Math.max(0, claim.budget - claim.tokensUsed)),
      displayText: `Goal 自动续跑 #${claim.attempt}/${claim.maxAttempts}`, announceUserMessage: false };
    const assertCurrent = async () => {
      if (controller.signal.aborted || !this.goalWindowAvailable(taskId, open)
        || String(open.runtime.conversation.id) !== String(claim.conversationId) || !await policyCurrent()) throw new InputAdmissionStopped();
      await this.readAdmissionCwd(taskId, open);
      await this.options.beforeSubmit?.(request);
      if (controller.signal.aborted || !this.goalWindowAvailable(taskId, open)) throw new InputAdmissionStopped();
    };
    try {
      let audit: Awaited<ReturnType<NonNullable<DurableBotServiceOptions["auditInput"]>>>;
      try {
        if (await this.goalContinuationStoreId(taskId) !== claim.storeId || await open.readWaitingForInput()) {
          trace("store_or_interaction_changed");
          return "rejected";
        }
        await assertCurrent();
        audit = await this.options.auditInput?.(request, origin);
      } catch (error) {
        trace("input_preflight_rejected", error);
        return "rejected";
      }
      // Normal input admission can configure tools or rebind a workspace. A claimed
      // continuation must use the already prepared conversation at the native store fence.
      try {
        const submission = await open.runtime.submit(request.text, claim.requestId, "reject",
          { text: request.text, displayText: request.displayText!, attachments: [], audit, goalContinuation: origin.goalContinuation },
          undefined, false, { validate: assertCurrent });
        const record = await submission.status(context);
        return record.type === "input" && record.requestId === claim.requestId && record.status !== "queued" ? "accepted" : "unknown";
      } catch (error) {
        if (error instanceof InputAdmissionStopped || error instanceof ConversationBusy) {
          trace("pi_placement_rejected", error);
          return "rejected";
        }
        console.warn("[GoalContinuation] Pi placement unconfirmed", error);
        return "unknown";
      }
    } finally {
      if (this.goalAdmissions.get(taskId) === controller) this.goalAdmissions.delete(taskId);
    }
  }

  async submissionStatus(receipt: AgentSubmissionReceipt, wait = false): Promise<AgentPromptResult> {
    if (!Number.isSafeInteger(receipt.submissionId) || receipt.submissionId <= 0 || !receipt.operationId) throw new Error("无效执行回执");
    return this.withRecovery(receipt.taskId, async open => {
      const submission = await open.runtime.harness.submission(receipt.submissionId as SubmissionId, context);
      if (!submission) throw new Error("执行回执不存在");
      const state = await submission.status(context);
      if (state.requestId !== receipt.operationId || state.type !== "input") throw new Error("执行回执不属于该任务或操作");
      const result = wait ? await submission.wait(context) : state;
      if (wait) await open.runtime.refresh();
      const response = submissionResult(receipt.taskId, result);
      if (result.status === "done" && result.type === "input") {
        const entry = await open.runtime.conversation.commit(tx => tx.entry(result.answer), context);
        const answer = entry?.model?.find(message => message.role === "assistant");
        if (!answer || answer.stopReason === "error" || answer.stopReason === "aborted" || answer.stopReason === "length" || !answer.content.some(block => block.type === "text" && block.text.trim())) {
          return { ...response, cancelled: answer?.stopReason === "aborted", error: { code: "DURABLE_FAILED", message: answer?.errorMessage ?? "该次输入未产生完整回复" } };
        }
      }
      return response;
    });
  }

  async prompt(request: AgentPromptRequest, admissionOnly = true, origin?: DurableInputOrigin): Promise<AgentPromptResult> {
    let accepted: AgentPromptResult;
    try { accepted = await this.submit(request, origin); }
    catch (error) {
      if (error instanceof DotsIntentChanged) return { queued: false, error: { code: "DOTS_INTENT_CHANGED", message: error.message } };
      if (request.requireActiveRun && error instanceof ConversationIdle) {
        return { queued: false, error: { code: "TASK_IDLE", message: "原任务已空闲，改向未接收" } };
      }
      throw error;
    }
    return admissionOnly || !accepted.receipt ? accepted : this.submissionStatus(accepted.receipt, true);
  }

  async history(taskId: string, beforeEntryId?: TaskHistoryTarget, source: "stored" | "current" = "stored"): Promise<TaskHistoryDto> {
    let binding: BotBinding | undefined;
    try {
      const [stored, task] = await Promise.all([this.readBinding(taskId), this.options.db.readTask(taskId, { includeExpertBinding: false })]);
      binding = stored;
      if (!binding && (this.core || !task?.sessionFile)) return { messages: [] };
      // Core history reads the persisted projection. Fixture sessions can seed history from a file.
      if (binding) {
        // Read the very projection used by onSnapshot to produce deltas. Opening
        // another writer (or refreshing this one) would itself produce events.
        const current = source === "current" && beforeEntryId === undefined;
        if (current && this.opening.has(taskId)) await this.opening.get(taskId)?.catch(() => {});
        const snapshot = current ? this.opened.get(taskId)?.runtime.snapshot : undefined;
        const history = snapshot
          ? { durable: snapshot, messages: snapshot.messages, cwd: this.opened.get(taskId)?.cwd ?? binding.cwd }
          : await this.passiveHistory(taskId, beforeEntryId);
        const modelId = task?.modelId;
        const modelRepair = this.opened.get(taskId)?.modelRepair;
        return { ...history, ...(modelId ? { modelId } : {}), ...(modelRepair ? { modelRecovery: modelRepair } : {}) };
      }
      const recovered = await this.withRecovery(taskId, async open => {
        const block = beforeEntryId === undefined ? undefined : await open.runtime.loadHistoryWindow(beforeEntryId);
        const snapshot = block ? open.runtime.snapshot : await open.runtime.refresh();
        return { runtime: open.runtime, cwd: open.cwd, snapshot, block, modelRepair: open.modelRepair };
      });
      await this.projections.get(taskId);
      // 复述任务当前模型（可能刚刚被目录漂移修复过），渲染层据此校正输入框的模型选择。
      const modelId = (await this.options.db.readTask(taskId, { includeExpertBinding: false }))?.modelId;
      return { messages: recovered.block?.messages ?? recovered.snapshot.messages, durable: recovered.snapshot,
        ...(recovered.block ? { page: { historyId: recovered.block.historyId, before: recovered.block.before, after: recovered.block.after } } : {}), cwd: recovered.cwd,
        ...(modelId ? { modelId } : {}), ...(recovered.modelRepair ? { modelRecovery: recovered.modelRepair } : {}) };
    } catch (error) {
      if (error instanceof DurableToolAssemblyError) {
        try { return await this.passiveHistory(taskId, beforeEntryId); }
        catch (readError) { error = readError; }
      }
      // A Bot conversation that cannot be opened must say so: an empty projection renders as the
      // product's "waiting for the first message" state, which hides real damage from the user.
      console.warn("[Durable] Cannot open history", taskId, error);
      return { messages: [], cwd: binding?.cwd, historyError: describeDurableHistoryFailure(error) };
    }
  }
  async refresh(taskId: string): Promise<void> {
    const open = this.opened.get(taskId);
    if (!open) return;
    if (this.core) await open.readWaitingForInput();
    await open.runtime.refresh();
  }

  /** 完整用户提问索引（历史提问弹窗用）；只读扫描，不改变实时窗口。 */
  async userQuestions(taskId: string, query?: TaskUserQuestionsQuery): Promise<TaskUserQuestionsDto> {
    const binding = await this.readBinding(taskId);
    if (!binding) return { questions: [] };
    try {
      const opening = this.opening.get(taskId);
      const live = this.opened.get(taskId)?.runtime ?? (opening ? (await opening).runtime : undefined);
      if (live && !this.options.passiveReader) return await live.loadUserQuestions(query);
      return await this.passiveRead(taskId, { questions: [] }, current => readDurableUserQuestions({
        directory: current.directory, cwd: current.cwd, models: this.options.models, reader: this.options.passiveReader, query,
        live: live && (() => live.loadUserQuestions(query)),
      }));
    } catch (error) {
      console.warn("[Durable] Cannot read the complete user-question index", taskId, error);
      throw error;
    }
  }

  /** 会话开头的前 N token（AI 命名用）；只读，不改变实时窗口。 */
  async historyHead(taskId: string, maxTokens = 1024): Promise<string> {
    const binding = await this.readBinding(taskId);
    if (!binding) return "";
    try {
      const opening = this.opening.get(taskId);
      const live = this.opened.get(taskId)?.runtime ?? (opening ? (await opening).runtime : undefined);
      if (live && !this.options.passiveReader) return await live.loadHistoryHead(maxTokens);
      return await this.passiveRead(taskId, "", current => readDurableConversationHead({
        directory: current.directory, cwd: current.cwd, models: this.options.models, reader: this.options.passiveReader, maxTokens,
        live: live && (() => live.loadHistoryHead(maxTokens)),
      }));
    } catch (error) {
      console.warn("[Durable] Cannot read the conversation head", taskId, error);
      return "";
    }
  }

  private passiveHistory(taskId: string, beforeEntryId?: TaskHistoryTarget): Promise<TaskHistoryDto> {
    return this.passiveRead(taskId, { messages: [] }, async binding => {
      const facts = this.core ? await this.readCoreDotsInputs(taskId) : undefined;
      return readDurableReadOnlyHistory({
        directory: binding.directory, cwd: binding.cwd, models: this.options.models, reader: this.options.passiveReader,
        beforeEntryId, observedUsage: this.options.observedUsage?.bind(undefined, taskId),
        isDotsWorkerInput: requestId => /^(?:dots-input-|goal-continuation:)/.test(requestId) &&
          (facts?.operationIds.has(requestId) ?? this.hasDotsDelegation(taskId, requestId)),
        hasDotsDelegation: () => facts ? facts.operationIds.size > 0 : this.hasDotsDelegation(taskId),
      });
    });
  }

  private async passiveRead<T>(taskId: string, empty: T, read: (binding: BotBinding) => Promise<T>): Promise<T> {
    for (;;) {
      const prior = this.passiveReads.get(taskId);
      if (!prior) break;
      await prior;
    }
    if (this.closing) throw new Error("Bot runtime is closing");
    // Passive readers never claim a writer lease, even if a live runtime exists.
    const reading = this.readBinding(taskId).then(binding => binding ? read(binding) : empty);
    const barrier = reading.then(() => {}, () => {}).finally(() => {
      if (this.passiveReads.get(taskId) === barrier) this.passiveReads.delete(taskId);
    });
    this.passiveReads.set(taskId, barrier);
    return reading;
  }

  async previewBranch(request: CreateConversationBranchRequest): Promise<DurableBranchAnchor> {
    return this.trackAdmission(request.sourceTaskId, async () => resolveDurableBranch((await this.open(request.sourceTaskId)).runtime, request));
  }

  async materializeBranch(sourceTaskId: string, childTaskId: string, cwd: string, anchor: DurableBranchAnchor): Promise<MaterializedDurableBranch> {
    const initialBranch = await this.trackAdmission(sourceTaskId, async () => captureDurableBranch((await this.open(sourceTaskId)).runtime, anchor));
    const directory = join(this.options.agentDir, "durable", createHash("sha256").update(childTaskId).digest("hex"));
    const runtime = await DurableBotRuntime.open({ directory, cwd, models: this.options.models, initialBranch,
      toolMode: "native", toolAllowed: () => false, instructions: () => "", onSnapshot: () => {} });
    try {
      const entries = await runtime.conversation.entries({ order: "descending" }, 1, undefined, context);
      const inheritedLastEntryId = entries.items[0]?.id;
      if (inheritedLastEntryId === undefined) throw new Error("分支历史未写入持久存储");
      return { directory, inheritedLastEntryId };
    } finally { await runtime.close(); }
  }

  commitBranch(taskId: string, cwd: string, branch: MaterializedDurableBranch): void {
    const projection = new DurableTaskProjection(this.options.db.connection, this.options.db.runtimeAuditReader);
    if (!this.options.db.connection.readonly) {
      this.options.db.connection.prepare("INSERT INTO durable_bot_bindings(task_id, backend, directory, cwd) VALUES (?, 'pi-durable', ?, ?)").run(taskId, branch.directory, cwd);
      this.options.db.connection.prepare("INSERT INTO durable_bot_memory_projection(task_id, entry_id) VALUES (?, ?)").run(taskId, branch.inheritedLastEntryId);
      return;
    }
    void projection.commitBranch(taskId, branch.directory, cwd, branch.inheritedLastEntryId).catch(error => {
      console.warn("[Durable] commitBranch projection failed", taskId, error);
    });
  }

  async inheritedBranchMessages(taskId: string): Promise<Map<string, string>> {
    const { runtime } = await this.open(taskId);
    const messages = new Map<string, string>();
    let cursor: Cursor | undefined;
    do {
      const page = await runtime.conversation.entries({ order: "ascending" }, 500, cursor, context);
      for (const entry of page.items) {
        const data = entry.data;
        if (entry.model?.some(message => message.role === "assistant") && data && typeof data === "object" && !Array.isArray(data)
          && data.inherited === true && typeof data.sourceEntryId === "string") messages.set(data.sourceEntryId, `durable-${entry.id}`);
      }
      cursor = page.next;
    } while (cursor);
    return messages;
  }
  async dotsInputVersion(taskId: string) {
    return (await this.open(taskId)).runtime.dotsInputVersion();
  }

  async appendDotsReply(reply: DotsAssistantReply, isCurrent: () => boolean, outboxEventKey?: string) {
    const core = this.options.db.runtimeAuditReader;
    if (outboxEventKey && core?.supervised) {
      const binding = await core.readDurableTaskBinding(DOTS_TASK_ID);
      if (!binding || binding.trashed) return { status: "pending" } as const;
    } else if (!this.binding(DOTS_TASK_ID)) return { status: "discarded" } as const;
    return this.withRecovery(DOTS_TASK_ID, async open => {
      try { return await open.runtime.appendDotsReply(reply, isCurrent, outboxEventKey); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== DOTS_OUTBOX_WRITE_REVOKED) throw error;
        await this.invalidate(DOTS_TASK_ID, open);
        return { status: "pending" } as const;
      }
    });
  }

  async appendDotsProactive(key: string, text: string, isCurrent: () => boolean) {
    await this.options.db.openDotsAsync();
    return this.withRecovery(DOTS_TASK_ID, open => open.runtime.appendDotsProactive(key, text, isCurrent));
  }

  async stopObservedRun(taskId: string, inputVersion?: string): Promise<"idle" | "stop_requested" | "intent_changed"> {
    if (inputVersion === undefined) this.cancelInputAdmissions(taskId);
    if (!await this.readBinding(taskId)) return "idle";
    let result: "idle" | "stop_requested" | "intent_changed" = "stop_requested";
    const settled = await this.withinStopBudget(`Dots stop ${taskId}`, async () => {
      const open = this.opened.get(taskId) ?? await this.openBound(taskId);
      const observed = await open.runtime.stopObservedRun(inputVersion, () => stopDurableSubagentsForTask(taskId));
      result = observed === "intent_changed" ? observed
        : open.runtime.snapshot.busy || open.runtime.snapshot.queued ? "stop_requested" : "idle";
    });
    return settled ? result : "stop_requested";
  }

  private cancelInputAdmissions(taskId: string): void {
    this.goalAdmissions.get(taskId)?.abort();
    for (const controller of this.admissions.get(taskId)?.values() ?? []) {
      if (controller) controller.abort(new InputAdmissionStopped());
    }
  }

  async abort(taskId: string): Promise<"idle" | "stop_requested"> {
    this.cancelInputAdmissions(taskId);
    try {
      const settled = await this.withinStopBudget(`stop ${taskId}`, () => Promise.all([
        (async () => {
          if (!await this.readBinding(taskId)) return;
          const open = this.opened.get(taskId) ?? await this.openBound(taskId);
          await open.runtime.abort();
        })(),
        stopDurableSubagentsForTask(taskId),
      ]));
      return settled ? "idle" : "stop_requested";
    } finally { this.options.onRelease?.(taskId); }
  }
  async compact(taskId: string): Promise<DurableCompactionOutcome> {
    return await this.trackAdmission(taskId, () => this.withRecovery(taskId, open => open.runtime.compact()));
  }
  /**
   * 产品阈值变更后让已打开运行时重算按阈值派生的缓存并重新投影状态。
   * 阈值本身是同步 getter，下一次请求自然读到新值；这里不打开任何新运行时。
   */
  refreshCompactionPolicy(taskId?: string): void {
    const targets = taskId ? [this.opened.get(taskId)] : [...this.opened.values()];
    for (const open of targets) {
      if (!open) continue;
      try { open.runtime.refreshContextPolicy(); }
      catch (error) { console.warn(`[Durable] Cannot refresh compaction policy for ${taskId ?? "opened sessions"}`, error); }
    }
  }
  async abortCompaction(taskId: string): Promise<boolean> { return await this.opened.get(taskId)?.runtime.abortCompaction() ?? false; }
  async purge(taskId: string): Promise<void> {
    if (await this.options.db.readTask(taskId, { includeExpertBinding: false })) {
      throw new Error("Only a permanently deleted task can purge Durable storage");
    }
    await this.release(taskId);
    this.options.answerRouting?.clearPreparedTurns(taskId);
    if (this.core) {
      // Core retires the bound Pi store in the same transaction that removes the task.
      this.projections.delete(taskId);
      return;
    }
    const root = resolve(this.options.agentDir, "durable");
    const digest = createHash("sha256").update(taskId).digest("hex");
    const directory = resolve(root, digest);
    if (dirname(directory) !== root) throw new Error("Invalid Durable storage path");
    if (isGatewayConversation(taskId)) {
      const channelDirs = Object.keys(GATEWAY_SIDEBAR_CHANNELS).map(channel =>
        join(gatewayChannelDirectory(this.options.db, channel, false), digest),
      );
      // A new inbound turn can recreate this exact task ID after release. Exclude admission during cleanup.
      this.options.db.connection.transaction(() => {
        if (this.options.db.getTask(taskId)) throw new Error("网关会话已重新创建，不能清理存储");
        rmSync(directory, { recursive: true, force: true });
        for (const channelDir of channelDirs) {
          rmSync(channelDir, { recursive: true, force: true });
        }
      }).immediate();
      await purgeDurableStorage(directory, this.options.db.runtimeAuditReader);
      for (const channelDir of channelDirs) {
        await purgeDurableStorage(channelDir, this.options.db.runtimeAuditReader);
      }
    } else {
      await purgeDurableStorage(directory, this.options.db.runtimeAuditReader);
      await rm(directory, { recursive: true, force: true });
    }
    this.projections.delete(taskId);
  }
  async release(taskId: string): Promise<void> {
    await this.passiveReads.get(taskId);
    const open = this.opened.get(taskId) ?? await this.opening.get(taskId);
    const invalidating = this.invalidations.get(taskId);
    if (!open) { await invalidating; return; }
    await this.invalidate(taskId, open);
    await this.projections.get(taskId);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.resumeAdmission?.cancel();
    await Promise.allSettled(this.passiveReads.values());
    await Promise.allSettled([...new Set([...this.opened.keys(), ...this.opening.keys()])].map(id => this.release(id)));
    await this.workMetrics.drained();
  }
  async runGatewayTurn({ gatewayOrigin, modelId, ...request }: GatewayBotTurnRequest): Promise<string> {
    const core = this.core;
    const fixture = this.options.db.fixtureConnection;
    const { workTarget: _workTarget, ...source } = gatewayOrigin;
    if (core) {
      const materialization = await core.materializeGatewayTask({ origin: source, taskId: request.taskId, modelId });
      if (materialization?.status !== "ready") rejectGatewayExecution(materialization);
    } else if (!fixture) {
      rejectGatewayExecution();
    } else if (fixture.readonly) {
      const task = this.options.db.getTask(request.taskId);
      if (task?.archived || this.options.db.getTaskExecutionWorkspaceState(request.taskId)?.state === "trashed") throw new Error("请先恢复已归档或回收的渠道任务");
      if (!task) {
        await this.options.db.writeTaskRecord({ id: request.taskId,
          title: (request.displayText ?? request.text).trim().slice(0, 60) || "助理",
          welcomeMode: DEFAULT_WELCOME_MODE, modePresetId: defaultModePresetId(DEFAULT_WELCOME_MODE),
          modelId, updatedAt: Date.now() });
      }
      this.options.db.bindGatewayConversationSpace(request.taskId, gatewayOrigin.channelId);
    } else {
      fixture.transaction(() => {
        const task = this.options.db.getTask(request.taskId);
        if (task?.archived || this.options.db.getTaskExecutionWorkspaceState(request.taskId)?.state === "trashed") throw new Error("请先恢复已归档或回收的渠道任务");
        if (!task) {
          this.options.db.upsertTask({ id: request.taskId,
            title: (request.displayText ?? request.text).trim().slice(0, 60) || "助理",
            welcomeMode: DEFAULT_WELCOME_MODE, modePresetId: defaultModePresetId(DEFAULT_WELCOME_MODE),
            modelId, updatedAt: Date.now() });
        }
        this.options.db.bindGatewayConversationSpace(request.taskId, gatewayOrigin.channelId);
      })();
    }
    const { submission, open } = await this.admitTracked(request, { gatewayOrigin: source });
    try {
      return await open.runtime.reply(submission, { requireText: true });
    } catch (error) {
      if (!(error instanceof SessionFailed)) throw error;
      await this.invalidate(request.taskId, open);
      const reopened = await this.open(request.taskId);
      const recovered = await reopened.runtime.harness.submission(submission.id, context);
      if (!recovered) throw error;
      return reopened.runtime.reply(recovered, { requireText: true });
    }
  }
}

function submissionResult(taskId: string, state: SubmissionRecord): AgentPromptResult {
  const receipt: AgentSubmissionReceipt = { taskId, operationId: state.requestId ?? "", submissionId: state.id, status: state.status };
  if (state.status === "unanswered") {
    if (state.reason === "turn_limit") {
      return { receipt, queued: false, error: { code: "DURABLE_TURN_LIMIT", message: DURABLE_TURN_LIMIT_MESSAGE } };
    }
    return state.reason === "aborted"
      ? { receipt, queued: false, cancelled: true }
      : { receipt, queued: false, error: { code: "DURABLE_UNANSWERED", message: typeof state.detail === "string" ? state.detail : state.reason } };
  }
  return { receipt, queued: state.status !== "done" };
}

function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try { return String(error); }
  catch { return Object.prototype.toString.call(error); }
}

function describeDurableHistoryFailure(error: unknown): string {
  if (error instanceof SessionFailed) {
    return `Bot 会话已失败（storage error）：${failureText(error.cause)}。已尝试自动重开，但恢复未成功。`;
  }
  if (error instanceof DurableStorageOwnedError) {
    return `该 Bot 会话正被另一个 MyBuddy 实例占用（PID ${error.owner.pid}）。请只保留一个 MyBuddy 实例，稍后重新打开本会话。`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message;
}
