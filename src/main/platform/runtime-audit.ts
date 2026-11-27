import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable, Writable } from "node:stream";
import type { EventEmitter } from "node:events";
import type { TaskDiagnosticsDto, ToolDiagnosticEvent } from "../../shared/task-diagnostics";
import type { ExternalAgentHistoryCursor, ExternalAgentHistoryPage } from "../external-agent/ExternalAgentHistoryData";
import type { ConversationBranchInfoDto } from "../../shared/conversation-branch";
import type { SpaceDto, TaskDto, TaskSidebarEdit, TaskUserQuestionsDto } from "../../shared/agent-ipc";
import type { TrashedTaskDto } from "../../shared/archive-deletion";
import type { WorkspaceIconAppearance } from "../../shared/workspace-icon";
import type { ArchiveTaskCandidate } from "../task/ArchivedContentDeletion";
import type { LibraryItemDto, LibraryOwnerScope } from "../../shared/library-ipc";
import type { RuntimeSnapshotMutation, RuntimeSnapshotPage } from "../agent/RuntimeContextSnapshotRepository";
import type { RuntimeDiagnosticTrace } from "../agent/TaskDiagnosticsRepository";
import type { ExecutionFailureDismissReply, ExecutionFailureRow } from "../agent/ExecutionFailureRepository";
import type { ExecutionAttempt } from "../agent/ExecutionAttemptRepository";
import type { ConversationExecutionContext } from "../agent/ConversationExecutionContext";
import type { TaskContextUsageSnapshot } from "../agent/TaskContextUsageWrites";
import type { RuntimeNotificationMutation, RuntimeNotificationQuery, RuntimeNotificationSqlRow, RuntimeNotificationWriteReply } from "../notification/NotificationRepository";
import type { NativeHookMutation, NativeHookQuery } from "../agent/hooks/NativeHookStore";
import type { ReadHintMutation, ReadHintQuery } from "../agent/hooks/ReadRecoveryHints";
import type { ImprovementPackageMutation, ImprovementPackageQuery } from "../agent/hooks/ImprovementPackages";
import type { ImprovementReviewMutation, ImprovementReviewQuery } from "../agent/hooks/ImprovementReviewStore";
import type { RuntimeWorkGraphMutation, RuntimeWorkGraphQuery, RuntimeWorkGraphReply } from "../workgraph/WorkGraphService";
import type { WorkGraphEdgeDto } from "../../shared/work-graph";
import type { FileBackupInfoDto } from "../../shared/agent-ipc";
import type { GatewayListMessagesRequest, GatewayMessageDto } from "../../shared/gateway-ipc-types";
import type { TaskWriteGrantRow } from "../../shared/external-write";
import type { GatewayChannelRecord } from "../db/gateway-channel-store";
import type { DotsAssistantReply, DotsDelegation, DotsTaskDelivery } from "../../shared/dots";
import type { DotsSchedulingPolicy } from "../../shared/answer-routing";
import type { DotsForegroundCommand, DotsForegroundQuery } from "../dots/DotsForegroundReads";
import type { DeferredRequirementsCommand, DeferredRequirementsQuery } from "../dots/DotsDeferredRequirements";
import type { DotsActivityCursor, DotsActivityPage } from "../dots/DotsActivity";
import type { GatewayInboxEntry, GatewayOutboxEntry } from "../gateway/GatewayDeliveryJournal";
import type { GatewayExecutionAuthority, GatewayTaskMaterialization, GatewayTaskMaterializationResult } from "../gateway/GatewayExecutionAuthority";
import type { GatewayBotOrigin } from "../agent/work/BotTurnOrigins";
import type { RuntimeFileBackupRestoreRequest, RuntimeFileBackupRestoreReply } from "../agent/FileBackupService";
import type { RuntimeSubagentSettingsRequest, RuntimeSubagentSettingsReply } from "../agent/SubagentSettingsPersistence";
import type { RuntimeMaterialRetrievalRequest, RuntimeMaterialRetrievalReply } from "../library/MaterialRetrievalSettings";
import type { RuntimeTaskTrashRestore, RuntimeTaskTrashRestoreReply } from "../task/TaskExecutionWorkspaceLifecycle";
import type { RuntimeCodeReviewQuery, RuntimeCodeReviewData } from "../agent/CodeReviewService";
import type { RuntimeSoulProfileReply, RuntimeSoulProfileRequest } from "../agent/SoulProfileData";
import type { RuntimeDurableWorkspaceMoveReply, RuntimeDurableWorkspaceMoveRequest } from "../agent/durable/DurableWorkspaceMoves";
import type { RuntimeTaskExpertBindingState, RuntimeTaskExpertBindingMutation, RuntimeTaskExpertBindingWriteReply } from "../experts/TaskExpertBindingService";
import type { RuntimeMemoryOrganizationProgress } from "../memory/MemoryOrganizationService";
import type { RuntimeAnswerRoutingRequest, RuntimeAnswerRoutingReply } from "../agent/AnswerRoutingService";
import type { RuntimeLoadoutObservationRow } from "../agent/AgentLoadoutObservationService";
import type { RuntimeBotHistoryPage, RuntimeBotHistoryQuery } from "../agent/work/BotHistoryData";
import type { RuntimeBotListQuery, RuntimeBotLookup, RuntimeBotRegistration, RuntimeBotRegistrationReply, RuntimeBotRow } from "../agent/work/BotRegistry";
import type { RuntimeConversationGoalCreateReply, RuntimeConversationGoalDraft, RuntimeConversationSnapshot, WorkTaskAccess } from "../agent/ConversationRuntimeData";
import type { IntegrityReport, RepairPreview, RuntimeWorkGraphRepairReply } from "../workgraph/WorkGraphIntegrity";
import type { RuntimeDurableTaskProjectionRequest, RuntimeDurableTaskProjectionReply } from "../agent/durable/DurableTaskProjection";
import type { TaskWorkspaceAuthority } from "../task/TaskWorkspaceResolver";
import type { RuntimeDurableOpenState } from "../agent/durable/DurableBotService";
import type { RuntimeWorkExecutionMetrics } from "../agent/work/WorkExecutionMetrics";
import type { RuntimeWorkspaceSharedData } from "../workspace/WorkspaceSharedContextService";
import type { RuntimeWorkspaceBindingSnapshot } from "../workspace/WorkspaceLibraryBindingView";
import type { RuntimeWorkspaceBindingMutation } from "../workspace/WorkspaceLibraryBindingService";
import type { MemoryExtractionRetry, MemoryExtractionSnapshot, RuntimeMemoryTurnData, RuntimeMemoryTurnQuery, RuntimeMemoryTurnExtractionCommand, RuntimeMemoryTurnExtractionReply } from "../memory/MemoryTurnRepository";
import type { RuntimeMemoryRecordsQuery, RuntimeMemoryRecordsData } from "../memory/MemoryRecordsData";
import type { RuntimeMemoryRecordWriteRequest, RuntimeMemoryRecordWriteReply } from "../memory/MemoryRecordWrite";
import type { RuntimeProjectEventRequest, RuntimeProjectEventReply, RuntimeProjectPinRequest, RuntimeProjectPinReply, RuntimeProjectPostRequest, RuntimeProjectPostReply } from "../project/ProjectRepository";
import type { RuntimeWorkQueueQuery, RuntimeWorkQueueSnapshot, RuntimeWorkCardRead, RuntimeWorkCardReadReply } from "../agent/work/WorkQueueData";
import type { RuntimeWorkHostLeaseRequest, RuntimeWorkHostLeaseReply } from "../agent/work/WorkHostAuthority";
import type { SpaceRow, TaskExecutionWorkspaceStateRow, TaskRow } from "../db/AppDatabase";
import type { BotWorkspaceNavigationDto } from "../../shared/bot-workspace-navigation";
import type { GadgetStateAction, GadgetStateAuthorization, GadgetStateBucket, GadgetStateReply } from "../gadget/GadgetState";
import type { RuntimeBlueprintInstance, RuntimeBlueprintInstanceStatus } from "../blueprint/BlueprintInstanceWrite";
import type {
  ProjectDeletionResult, ProjectLibraryPromotionReply, ProjectMutation, ProjectWithdrawal, ProjectWithdrawalSnapshot,
  ProjectWriteDomain, ProjectWriteStatus, RuntimeProjectLibraryPromotion,
} from "../project/ProjectMutation";
import type { CronRunWrite } from "../db/CronRunPersistence";
import type { CronPlanWrite } from "../db/CronPlanPersistence";
import type { ArtifactRow, StoredArtifactSnapshot } from "../artifact/ArtifactRepository";
import type { ArtifactDescriptor, ArtifactFileDependency, ArtifactMessageRef } from "../../shared/artifact-types";
import type { TaskExpertBindingDto } from "../../shared/expert-binding";
import type { RuntimeMemoryCapture } from "../memory/MemoryTurnRepository";
import type { MemoryBaselineCandidate } from "../memory/MemorySearchScope";
import type { ContentExtractionStatus } from "../library/ContentExtractorRegistry";
import type { SemanticInstallation } from "../retrieval/SemanticModelManager";
import type { RuntimeUsageJob, RuntimeUsageReport, UsageReportResult } from "../usage/UsageStatsService";
import { currentPlatformId } from "./index";
import { connectCoreWorker, type CoreClientRole } from "./core-client";

function utf16Units(text: string): number[] {
  return Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
}

export function locateRuntimeAudit(appPath: string, resources?: string): string | undefined {
  if (process.arch !== "x64" || currentPlatformId === "macos") return undefined;
  const windows = currentPlatformId === "windows";
  const directory = resources
    ? join(resources, "runtime-audit")
    : join(appPath, "out", "native", windows ? "win-x64" : "linux-x64");
  return join(directory, windows ? "mybuddy-runtime-audit.exe" : "mybuddy-runtime-audit");
}

export function locateSemanticInferenceLibrary(): string | undefined {
  if (process.arch !== "x64" || currentPlatformId === "macos") return undefined;
  try {
    const windows = currentPlatformId === "windows";
    const root = resolve(dirname(require.resolve("onnxruntime-node")), "..")
      .replace(/([\\/])app\.asar([\\/])/i, "$1app.asar.unpacked$2");
    const library = join(root, "bin", "napi-v6", windows ? "win32" : "linux", "x64",
      windows ? "onnxruntime.dll" : "libonnxruntime.so.1");
    if (existsSync(library)) return library;
  } catch { /* Existing JavaScript fallback owns model availability. */ }
}

type TaskDueDateResult =
  | { status: "saved"; projectId: string | null }
  | { status: "beforeStart" | "unavailable" };

type TaskSidebarResult = { status: "saved"; projectId: string | null } | { status: "missing" | "unavailable" };

export type RuntimeDiagnosticWrite =
  | { kind: "trace"; request: { id: string; provider: string; model: string; startedAt: number; events: RuntimeDiagnosticTrace[] } }
  | { kind: "tool"; event: ToolDiagnosticEvent };

export type RuntimeWorkspaceQuery =
  | { kind: "spaces" }
  | { kind: "visibleSpaces" | "navigation"; userId: string };

export interface RuntimePythonProjectBinding {
  dir_key: string;
  project_dir: string;
  python_path: string;
  python_version: string | null;
  manifest_path: string | null;
  bound_at: number;
}

/** One gateway log row as the Rust writer appends it. */
export interface RuntimeGatewayMessageWrite {
  channelId: string;
  chatId: string;
  direction: string;
  senderId?: string;
  senderName?: string;
  text: string;
  at: number;
}

/** `needsHost` is the writer declining ownership; a missing reply stays unknown. */
export type RuntimeGatewayMessageWriteReply = { status: "saved" } | { status: "needsHost" };
export type RuntimeGatewayChannelWriteReply = { status: "saved" | "conflict" | "invalid" | "operationReused" };
export type RuntimeGatewayChannelState = { channel: GatewayChannelRecord | null; revision: number; isolationInstalledAt: number };
export type RuntimeDotsRecoveryRow = { sequence: number; operationId: string; taskId: string };
export type RuntimeDotsActiveDelegation = Pick<DotsDelegation, "id" | "taskId" | "sourceMessageId" | "title" | "createdAt" | "updatedAt">
  & { sequence: number; status: "pending" | "running" | "blocked"; goalId: string | null; waitingOnPrerequisite: boolean;
    trackingRevoked: boolean; trackingPolicy: DotsSchedulingPolicy["trackingPolicy"] | null };
export type RuntimeDotsRecoveryGuard = { sequence: number; spaceIds: string[] | null; allowAutomatic: boolean };
type RuntimeDotsPage<Row> = { rows: Row[]; nextAfterSeq: number | null };
type RuntimeDotsReplyState = { status: "prepared"; reply: DotsAssistantReply }
  | { status: "settled" | "missing" | "held" | "stale" | "invalid" };
export type RuntimeGatewayChannelTransition =
  | { kind: "connect"; accountKey: string | null; personalMemoryOwnerId?: string }
  | { kind: "restore"; accountKey: string | null }
  | { kind: "disconnect" };
export type RuntimeGatewayAdmission = {
  platform: string;
  accountKey: string;
  sessionKey: string;
  payloadJson: string;
  replayNativeReceipts: boolean;
  maxPending: number;
  maxReceipts: number;
  retentionMs: number;
};
export type RuntimeGatewayAdmissionReply = { status: "accepted"; entry: GatewayInboxEntry; duplicate: boolean }
  | { status: "rejected"; code: string };
export type RuntimeGatewayAssignment = { status: "assigned"; taskId: string; currentTaskId: string; command: boolean;
  oldTaskAvailable: boolean; personalMemoryBindingId: string | null } | { status: "rejected"; code: string };
export type RuntimeGatewayRecoveryQuery = { channelId: string; accountKey?: string; sessionKey?: string; cutoff: number; limit: number;
  retryBlocked: boolean; continuationsOnly: boolean };
export type RuntimeGatewayRecovery = { kind: "recovery"; pending: GatewayInboxEntry[]; counts: Record<string, number>;
  nextRetryAt: number | null; truncated: boolean };
export type RuntimeGatewayReplyOutcome = "sent" | "pending" | "blocked" | "failed" | "unknown";
export type RuntimeGatewayExecutionOutcome = "completed" | "interrupted" | "failed";
export type RuntimeGatewayDeliveryCommand =
  | { action: "claimExecution" }
  | { action: "claimReply"; maxAttempts: number }
  | { action: "queueReply"; attempt: number; text: string }
  | { action: "finishExecution"; attempt: number; outcome: RuntimeGatewayExecutionOutcome }
  | { action: "finishReply"; attempt: number; outcome: RuntimeGatewayReplyOutcome; reason?: string; nextAttemptAt?: number };
export type RuntimeGatewayDeliveryReply =
  | { status: "claimed"; attempt: number }
  | { status: "sending"; entry: GatewayOutboxEntry }
  | { status: "waiting"; nextAttemptAt: number }
  | { status: "applied" | "sent" | "unavailable" | "stale" | "invalid" | "conflict" | "integrity" | "exhausted" };

interface RuntimeWorkspaceData {
  spaces: Array<SpaceRow & { effective_archived: boolean; path_missing: boolean }>;
  navigation?: Pick<BotWorkspaceNavigationDto, "foregroundRequests" | "conversations">;
}

export interface RuntimeOperationReceipt {
  requestId: string;
  state: "queued" | "running" | "committed" | "cancelled" | "expired" | "failed" | "unknown";
  result?: unknown;
  error?: string;
  generation?: string;
  neverStarted?: boolean;
}

/** A dispatched write cannot be declared failed just because its reply was lost. */
export interface ApplicationDatabaseIdentity {
  format: string;
  schemaVersion: number;
  databaseGeneration: string;
}

export class RuntimeAuditUnknownOperationError extends Error {
  readonly code = "RUNTIME_OPERATION_UNKNOWN";
  constructor(readonly requestId: string, readonly operation: string) {
    super("操作仍在处理或结果尚未确认，请先查看操作状态，避免重复执行");
    this.name = "RuntimeAuditUnknownOperationError";
  }
}

/** Native declined this attempt before an effect; host writes must still respect ordering. */
export class RuntimeAuditNotStartedOperationError extends Error {
  readonly code = "RUNTIME_OPERATION_NOT_STARTED";
  constructor(readonly requestId: string, readonly operation: string, readonly reason: string) {
    super("操作尚未执行，后台暂时不可用或请求已取消，请稍后重试");
    this.name = "RuntimeAuditNotStartedOperationError";
  }
}

/** Execution ended with a confirmed failure; this is neither not-started nor unknown. */
export class RuntimeAuditOperationFailedError extends Error {
  readonly code = "RUNTIME_OPERATION_FAILED";
  constructor(readonly requestId: string, readonly operation: string, readonly reason?: string) {
    super("操作执行失败，未完成请求的变更，请检查后重试");
    this.name = "RuntimeAuditOperationFailedError";
  }
}

export interface RuntimeAuditReaderOptions {
  /** Production opts in to the directory-owned Core. Isolated fixtures use direct stdio. */
  coreDataDirectory?: string;
  coreRole?: CoreClientRole;
  coreClientId?: string;
  /** Maximum concurrent read operations in flight on one client (default 4 on supervised/capable workers, 1 on legacy). */
  maxConcurrentReads?: number;
  /** Maximum concurrent mutating DB requests queued from one client to Core writer (default 4 when parallel reads enabled, 1 on legacy). */
  maxConcurrentWrites?: number;
}

export interface PiStorageClient {
  piStorage<T = Record<string, unknown>>(
    command: Record<string, unknown> & { action: string },
    signal?: AbortSignal,
  ): Promise<T | undefined>;
}

export type NativePersistenceReply<T> = { status: "ok"; data: T } | { status: "rejected"; message: string };

/** One worker per host database for read-only queries and bounded writes. */
export class RuntimeAuditReader implements PiStorageClient {
  private readonly queues: Record<AuditLane, AuditRequest[]> = {
    database: [], inference: [], maintenance: [], scan: [],
  };
  private readonly pumping = new Set<AuditLane>();
  /** A caller may have timed out while the worker still owns this slot. */
  private readonly executing: Record<AuditLane, Map<string, AuditRequest>> = {
    database: new Map(), inference: new Map(), maintenance: new Map(), scan: new Map(),
  };
  private readonly maxInFlight: Record<AuditLane, number> = {
    database: 0, inference: 0, maintenance: 0, scan: 0,
  };
  private readonly unconfirmed = new Map<string, { operation: string; lane: AuditLane }>();
  private connecting?: Promise<AuditSession | undefined>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  /** Requests accepted into each lane and not yet settled. */
  private readonly laneQueued: Record<AuditLane, number> = {
    database: 0, inference: 0, maintenance: 0, scan: 0,
  };
  private readonly laneTotals: Record<AuditLane, RuntimeAuditLaneTotals> = {
    database: emptyLaneTotals(), inference: emptyLaneTotals(), maintenance: emptyLaneTotals(),
    scan: emptyLaneTotals(),
  };
  private readonly laneRecords: RuntimeAuditLaneRecord[] = [];
  private readonly laneWarnedAt: Record<AuditLane, number> = {
    database: 0, inference: 0, maintenance: 0, scan: 0,
  };
  /** Writes the caller had to replay on the host because the worker never confirmed them. */
  private readonly fallbacks = new Map<string, number>();
  private fallbackWarnedAt = 0;
  private inferenceCapability?: Promise<boolean>;
  private embeddingIndexCapability?: Promise<boolean>;
  private embeddingPlannerCapability?: Promise<boolean>;
  private modelProbeCapability?: Promise<boolean>;
  /** Every spawned Rust process is a new generation; failures belong to one generation. */
  private inferenceGeneration = 0;
  private lastCoreGeneration?: string;
  /** Inference is blocked for the generation that failed, or after repeated failures. */
  private inferenceFailure?: { generation: number; streak: number };
  private session?: AuditSession;
  private closed = false;
  private state?: "ready" | "unavailable";
  private stopping?: Promise<void>;
  private diagnosticWriterReady = false;
  private snapshotWriterReady = false;
  private usageReaderReady = false;
  private usageHistoryReady = false;
  private usageCsvReady = false;
  private liveUsageReady = false;
  private memoryCaptureReady = false;
  private libraryIndexWriterReady = false;
  private embeddingIndexWriterReady = false;
  private embeddingPlannerReady = false;
  private modelProbeReady = false;
  private taskListReady = false;
  private workspaceDataReady = false;
  private workspaceMoveCapability?: Promise<boolean>;
  private sidebarArchiveCapability?: Promise<boolean>;
  private workspaceLabelsCapability?: Promise<boolean>;
  private workspacePersistenceCapability?: Promise<boolean>;
  private workspaceDeleteCapability?: Promise<boolean>;
  private workspaceBindingCapability?: Promise<boolean>;
  private projectPostsCapability?: Promise<boolean>;
  private projectEventDataCapability?: Promise<boolean>;
  private answerRoutingDataCapability?: Promise<boolean>;
  private projectPinsCapability?: Promise<boolean>;
  private workQueueCapability?: Promise<boolean>;
  private workGraphCapability?: Promise<boolean>;
  private workGraphIntegrityCapability?: Promise<boolean>;
  private fileBackupListCapability?: Promise<boolean>;
  private fileBackupRestoreCapability?: Promise<boolean>;
  private subagentSettingsCapability?: Promise<boolean>;
  private materialRetrievalCapability?: Promise<boolean>;
  private taskTrashRestoreCapability?: Promise<boolean>;
  private soulProfileCapability?: Promise<boolean>;
  private durableWorkspaceMoveCapability?: Promise<boolean>;
  private taskExpertBindingCapability?: Promise<boolean>;
  private memoryOrganizationProgressCapability?: Promise<boolean>;
  private workGraphRepairCapability?: Promise<boolean>;
  private durableTaskProjectionCapability?: Promise<boolean>;
  private memoryRecordWriteCapability?: Promise<boolean>;
  private notificationDataCapability?: Promise<boolean>;
  private taskRecordsCapability?: Promise<boolean>;
  private taskContextUsageCapability?: Promise<boolean>;
  private executionFailuresCapability?: Promise<boolean>;
  private taskTrashCapability?: Promise<boolean>;
  private taskTrashPurgeCapability?: Promise<boolean>;
  private taskTrashReady = false;
  private artifactSnapshotsReady = false;
  private managedArtifactFilesCapability?: Promise<boolean>;
  private artifactCleanupCapability?: Promise<boolean>;
  private workspaceFilePreviewCapability?: Promise<boolean>;
  private workspaceScanCapability?: Promise<boolean>;
  private dotsFileRevisionCapability?: Promise<boolean>;
  private dotsFileWatchCapability?: Promise<boolean>;
  private workspaceArtifactStreamCapability?: Promise<boolean>;
  private managedArtifactImageStreamCapability?: Promise<boolean>;
  private remoteArtifactImageCapability?: Promise<boolean>;
  private artifactWriterReady = false;
  private taskBoardReady = false;
  private libraryMetadataReady = false;
  private libraryNoteWriteCapability?: Promise<boolean>;
  private libraryNoteRestoreCapability?: Promise<boolean>;
  private libraryTextSaveCapability?: Promise<boolean>;
  private libraryTextWriterReady = false;
  private libraryDeleteCapability?: Promise<boolean>;
  private libraryDeleteReady = false;
  private libraryBackupCapability?: Promise<boolean>;
  private libraryBackupExporterReady = false;
  private libraryRestoreCapability?: Promise<boolean>;
  private libraryRestoreReady = false;
  private libraryRestoreTail: Promise<unknown> = Promise.resolve();
  private libraryNoteWriterReady = false;
  private libraryNoteRestorerReady = false;
  private scopedNotesReady = false;
  private projectMetadataReady = false;
  private readonly projectWriteCapabilities = new Map<ProjectWriteDomain, Promise<boolean>>();
  private projectWriterReady = false;
  private cronDataReady = false;
  private cronWriterReady = false;
  private cronPlanWriterReady = false;
  private workbenchDataReady = false;
  private workbenchWriteCapability?: Promise<boolean>;
  private workbenchWriterReady = false;
  private blueprintInstantiationCapability?: Promise<boolean>;
  private managedStorageCapability?: Promise<boolean>;
  private blueprintInstantiationReady = false;
  private gadgetStateCapability?: Promise<boolean>;
  private gadgetFileMutationsCapability?: Promise<boolean>;
  private gadgetStateReady = false;
  private pluginCatalogReady = false;
  private pluginCatalogScanCapability?: Promise<boolean>;
  private pluginConfigCapability?: Promise<boolean>;
  private connectorInstallationCapability?: Promise<boolean>;
  private connectorMaintenanceCapability?: Promise<boolean>;
  private connectorMarketImportCapability?: Promise<boolean>;
  private connectorMarketImportReady = false;
  private connectorMarketMutationCapability?: Promise<boolean>;
  private connectorMarketMutationReady = false;
  private connectorInstallerReady = false;
  private gatewayMessageWriteCapability?: Promise<boolean>;

  constructor(private readonly executable: string | undefined, private readonly dbPath: string,
    private readonly options: RuntimeAuditReaderOptions = {}) {}

  workHostLease(request: RuntimeWorkHostLeaseRequest): Promise<RuntimeWorkHostLeaseReply | undefined> {
    return this.read({ operation: "workHostLease", request }, "database", false, 5_000);
  }

  workScheduler<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T | undefined> {
    return this.read({ operation: "coreWorkScheduler", ...command }, "database", false, 15_000);
  }

  cronScheduler<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T | undefined> {
    if (!this.supervised) return Promise.resolve(undefined);
    return this.read({ operation: "coreCronScheduler", ...command }, "database", false, 15_000);
  }

  dotsScheduler<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T | undefined> {
    if (!this.supervised) return Promise.resolve(undefined);
    return this.read({ operation: "coreDotsScheduler", ...command }, "database", false, 15_000);
  }

  gatewayScheduler<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T | undefined> {
    if (!this.supervised) return Promise.resolve(undefined);
    return this.read({ operation: "coreGatewayScheduler", ...command }, "database", false, 15_000);
  }

  remoteControl<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T | undefined> {
    if (!this.supervised) return Promise.resolve(undefined);
    return this.read({ operation: "coreRemoteControl", ...command }, "database", false, 15_000);
  }

  gadgetHost<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T | undefined> {
    if (!this.executable) return Promise.resolve(undefined);
    return this.read({ operation: "coreGadgetHost", ...command }, "database", false, 15_000);
  }

  piHost<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T | undefined> {
    if (!this.supervised) return Promise.resolve(undefined);
    return this.read({ operation: "corePiHost", ...command }, "database", false, 20_000);
  }

  piStorage<T = Record<string, unknown>>(
    command: Record<string, unknown> & { action: string },
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    if (!this.executable) return Promise.resolve(undefined);
    return this.read({ operation: "piStorage", payload: command }, "database", false, 30_000, undefined, undefined, signal);
  }

  readNativeHooks<T>(query: NativeHookQuery, signal?: AbortSignal): Promise<NativePersistenceReply<T> | undefined> {
    return this.read({ operation: "readNativeHooks", query }, "database", false, 10_000, undefined, undefined, signal);
  }

  writeNativeHooks<T>(mutation: NativeHookMutation): Promise<NativePersistenceReply<T> | undefined> {
    return this.read({ operation: "writeNativeHooks", mutation });
  }

  readPathHints<T>(query: ReadHintQuery): Promise<NativePersistenceReply<T> | undefined> {
    return this.read({ operation: "readPathHints", query });
  }

  writePathHints<T>(mutation: ReadHintMutation): Promise<NativePersistenceReply<T> | undefined> {
    return this.read({ operation: "writePathHints", mutation });
  }

  readImprovementPackages<T>(query: ImprovementPackageQuery): Promise<NativePersistenceReply<T> | undefined> {
    return this.read({ operation: "readImprovementPackages", query });
  }

  writeImprovementPackages<T>(mutation: ImprovementPackageMutation): Promise<NativePersistenceReply<T> | undefined> {
    return this.read({ operation: "writeImprovementPackages", mutation }, "database", false, 30_000);
  }

  readImprovementReview<T>(query: ImprovementReviewQuery): Promise<NativePersistenceReply<T> | undefined> {
    return this.read({ operation: "readImprovementReview", query });
  }

  writeImprovementReview<T>(mutation: ImprovementReviewMutation): Promise<NativePersistenceReply<T> | undefined> {
    return this.read({ operation: "writeImprovementReview", mutation });
  }

  maintenanceScheduler<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T | undefined> {
    if (!this.supervised) return Promise.resolve(undefined);
    return this.read({ operation: "coreMaintenanceScheduler", ...command }, "database", false, 15_000);
  }

  runtimeMetrics(): Promise<Record<string, unknown> | undefined> {
    return this.control<Record<string, unknown>>({ action: "metrics" });
  }

  async queryOperation(requestId: string): Promise<RuntimeOperationReceipt | undefined> {
    const receipt = await this.control<RuntimeOperationReceipt>({ action: "status", targetRequestId: requestId });
    if (receipt?.requestId === requestId) this.applyReceipt(receipt);
    return receipt?.requestId === requestId ? receipt : undefined;
  }

  get supervised(): boolean {
    return Boolean(this.options.coreDataDirectory);
  }

  get hasExecutable(): boolean {
    return Boolean(this.executable);
  }

  async cancelOperation(requestId: string): Promise<RuntimeOperationReceipt | undefined> {
    for (const lane of AUDIT_LANES) {
      const queued = this.queues[lane].find(entry => entry.id === requestId);
      if (queued) {
        this.removeQueued(queued);
        this.settle(queued, "cancelled");
        return { requestId, state: "cancelled" };
      }
    }
    const receipt = await this.control<RuntimeOperationReceipt>({ action: "cancel", targetRequestId: requestId });
    if (receipt?.requestId === requestId) this.applyReceipt(receipt);
    return receipt?.requestId === requestId ? receipt : undefined;
  }

  snapshots(taskId: string, limit: number): Promise<RuntimeSnapshotPage | undefined> {
    if (!Number.isFinite(limit)) return Promise.resolve(undefined);
    return this.read({ operation: "snapshots", taskId, limit: Math.max(1, Math.min(200, Math.trunc(limit))) });
  }

  async artifactSnapshots(taskIds: readonly string[]): Promise<StoredArtifactSnapshot[] | undefined> {
    const rows = await this.read<StoredArtifactSnapshot[]>({ operation: "artifactSnapshots", taskIds });
    if (Array.isArray(rows)) {
      if (!this.artifactSnapshotsReady) {
        this.artifactSnapshotsReady = true;
        console.info("[RuntimeAudit] Rust artifact snapshots ready");
      }
      return rows;
    }
  }

  async writeArtifact<T>(taskId: string, operationId: string, mutation: RuntimeArtifactMutation): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "writeArtifact", taskId, operationId, mutation });
    if (result === undefined) await this.stopping;
    else if (!this.artifactWriterReady) {
      this.artifactWriterReady = true;
      console.info("[RuntimeAudit] Rust artifact writer ready");
    }
    return result;
  }

  artifactById(id: string): Promise<ArtifactDescriptor | null | undefined> {
    return this.read({ operation: "artifactData", query: { kind: "byId", id } });
  }

  artifactWriteReceipt<T>(taskId: string, operationId: string): Promise<T | null | undefined> {
    return this.read({ operation: "artifactData", query: { kind: "receipt", taskId, operationId } });
  }

  async artifactMessageRefs(taskId: string, filter?: { messageId?: string; artifactId?: string }): Promise<ArtifactMessageRef[] | undefined> {
    const rows = await this.read<Array<Omit<ArtifactMessageRef, "toolCallId"> & { toolCallId: string | null }>>({
      operation: "artifactData", query: { kind: "messageRefs", taskId, ...filter },
    });
    return rows?.map(row => ({ ...row, toolCallId: row.toolCallId ?? undefined }));
  }

  artifactFileDependencies(artifactId: string): Promise<ArtifactFileDependency[] | undefined> {
    return this.read({ operation: "artifactData", query: { kind: "fileDependencies", artifactId } });
  }

  private supportsManagedArtifactFiles(): Promise<boolean> {
    this.managedArtifactFilesCapability ??= this.read<boolean>({ operation: "managedArtifactFilesSupported" })
      .then(supported => supported === true);
    return this.managedArtifactFilesCapability;
  }

  async writeManagedArtifact(
    taskId: string, operationId: string, row: ArtifactRow, content: RuntimeArtifactContent,
  ): Promise<RuntimeManagedArtifactWrite | "needsHost" | undefined> {
    if (!await this.supportsManagedArtifactFiles()) return "needsHost";
    const result = await this.read<RuntimeManagedArtifactWrite>({
      operation: "writeManagedArtifact", taskId, operationId, row, content,
    }, "database", false, 30_000);
    if (result === undefined) await this.stopping;
    return result;
  }

  async readManagedArtifact(root: string, storagePath: string, inlineRaster = false): Promise<RuntimeManagedArtifactRead | undefined> {
    if (!await this.supportsManagedArtifactFiles()) return undefined;
    const cursor = randomUUID();
    const first = await this.read<RuntimeManagedArtifactReply>({ operation: "readManagedArtifact", root, storagePath, cursor, inlineRaster });
    if (first?.status === "content") {
      return { status: "content", content: Buffer.from(first.base64, "base64").toString("utf8") };
    }
    if (first?.status !== "chunk") return first;

    const session = this.session;
    const decoder = new StringDecoder("utf8");
    const text: string[] = [];
    let part = first;
    try {
      while (true) {
        text.push(decoder.write(Buffer.from(part.base64, "base64")));
        if (part.done) {
          text.push(decoder.end());
          return { status: "content", content: text.join("") };
        }
        const next = await this.read<RuntimeManagedArtifactReply>({ operation: "nextManagedArtifact", cursor }, "database", false, 10_000, session);
        if (next?.status === "failed") return next;
        if (next?.status !== "chunk") return { status: "failed", message: "成果读取中断，请重新打开" };
        part = next;
      }
    } finally {
      if (!part.done && session && this.session === session) {
        await this.read<boolean>({ operation: "closeManagedArtifact", cursor }, "database", false, 10_000, session);
      }
    }
  }

  async workspaceFilePreview(
    root: string,
    relativePath: string,
    kind: "text" | "imageHeader",
  ): Promise<RuntimeWorkspaceFilePreview | undefined> {
    this.workspaceFilePreviewCapability ??= this.read<boolean>({ operation: "workspaceFilePreviewSupported" })
      .then(supported => supported === true);
    if (!await this.workspaceFilePreviewCapability) return undefined;
    return this.read<RuntimeWorkspaceFilePreview>({ operation: "workspaceFilePreview", root, relativePath, kind });
  }

  async workspaceScan(query: RuntimeWorkspaceScanQuery): Promise<RuntimeWorkspaceScan | undefined> {
    this.workspaceScanCapability ??= this.read<boolean>({ operation: "workspaceScanSupported" })
      .then(supported => supported === true);
    if (!await this.workspaceScanCapability) return undefined;
    return this.read<RuntimeWorkspaceScan>({ operation: "workspaceScan", query }, "scan", false, 60_000);
  }

  async dotsFileRevision(root: string, file: string): Promise<RuntimeDotsFileRevision | undefined> {
    this.dotsFileRevisionCapability ??= this.read<boolean>({ operation: "dotsFileRevisionSupported" })
      .then(supported => supported === true);
    if (!await this.dotsFileRevisionCapability) return undefined;
    return this.read<RuntimeDotsFileRevision>({ operation: "dotsFileRevision", root, file }, "scan", false, 60_000);
  }

  async watchDotsFile(
    root: string, file: string, changed: () => void, lost: () => void,
  ): Promise<{ close(): void } | undefined> {
    this.dotsFileWatchCapability ??= this.read<boolean>({ operation: "dotsFileWatchSupported" })
      .then(supported => supported === true);
    if (!await this.dotsFileWatchCapability || !this.session) return undefined;
    const session = this.session;
    const id = randomUUID();
    const close = () => {
      if (!session.dotsFileWatches.delete(id)) return;
      void this.read<boolean>({ operation: "stopDotsFileWatch", id }, "database", false, 10_000, session)
        .catch(() => undefined);
    };
    session.dotsFileWatches.set(id, {
      changed,
      lost: () => {
        close();
        lost();
      },
    });
    const armed = await this.read<boolean>({ operation: "startDotsFileWatch", id, root, file }, "database", false, 10_000, session);
    if (armed !== true || this.session !== session || !session.dotsFileWatches.has(id)) {
      close();
      return undefined;
    }
    return { close };
  }

  async openWorkspaceArtifact(
    root: string, relativePath: string, { head, signal }: { head: boolean; signal?: AbortSignal },
  ): Promise<RuntimeWorkspaceArtifact | undefined> {
    this.workspaceArtifactStreamCapability ??= this.read<boolean>({ operation: "workspaceArtifactStreamSupported" })
      .then(supported => supported === true);
    if (!await this.workspaceArtifactStreamCapability) return undefined;
    const cursor = head ? undefined : randomUUID();
    const opened = await this.read<RuntimeWorkspaceArtifactHeader>({ operation: "openWorkspaceArtifact", root, relativePath, cursor });
    if (opened?.status !== "opened") return opened;
    const body = this.artifactStream(cursor, signal);
    return body === undefined ? { status: "failed", message: "成果读取中断，请重新打开" } : { ...opened, body };
  }

  async openManagedArtifactImage(
    root: string, storagePath: string, { head, signal }: { head: boolean; signal?: AbortSignal },
  ): Promise<RuntimeManagedArtifactImage | undefined> {
    this.managedArtifactImageStreamCapability ??= this.read<boolean>({ operation: "managedArtifactImageStreamSupported" })
      .then(supported => supported === true);
    if (!await this.managedArtifactImageStreamCapability) return undefined;
    const cursor = head ? undefined : randomUUID();
    const opened = await this.read<RuntimeManagedArtifactImageHeader>({ operation: "openManagedArtifactImage", root, storagePath, cursor });
    if (opened?.status !== "imageOpened") return opened;
    const body = this.artifactStream(cursor, signal);
    return body === undefined ? { status: "failed", message: "成果读取中断，请重新打开" } : { ...opened, body };
  }

  async openRemoteArtifactImage(
    root: string, relativePath: string, managed: boolean, { head, signal }: { head: boolean; signal?: AbortSignal },
  ): Promise<RuntimeRemoteArtifactImage | undefined> {
    this.remoteArtifactImageCapability ??= this.read<boolean>({ operation: "remoteArtifactImageSupported" })
      .then(supported => supported === true);
    if (!await this.remoteArtifactImageCapability) return undefined;
    const cursor = head ? undefined : randomUUID();
    const opened = await this.read<RuntimeRemoteArtifactImageHeader>({ operation: "openRemoteArtifactImage", root, relativePath, managed, cursor });
    if (opened?.status !== "remoteImageOpened") return opened;
    const body = this.artifactStream(cursor, signal);
    return body === undefined ? { status: "remoteImageRejected", failure: "unavailable" } : { ...opened, body };
  }

  private artifactStream(cursor: string | undefined, signal?: AbortSignal): ReadableStream<Uint8Array> | null | undefined {
    if (!cursor) return null;
    const session = this.session;
    if (!session) return undefined;
    let finished = false;
    let removeAbort = () => {};
    const finish = () => {
      finished = true;
      removeAbort();
    };
    const close = async () => {
      if (finished) return;
      finish();
      await this.read<boolean>({ operation: "closeManagedArtifact", cursor }, "database", false, 10_000, session);
    };
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (!signal) return;
        const abort = () => {
          void close();
          controller.error(signal.reason);
        };
        if (signal.aborted) abort();
        else {
          removeAbort = () => signal.removeEventListener("abort", abort);
          signal.addEventListener("abort", abort, { once: true });
        }
      },
      pull: async controller => {
        while (!finished) {
          const part = await this.read<RuntimeManagedArtifactReply>(
            { operation: "nextManagedArtifact", cursor }, "database", false, 10_000, session,
          );
          if (finished) return;
          if (part?.status !== "chunk") {
            void close();
            controller.error(new Error(part?.status === "failed" ? part.message : "成果读取中断，请重新打开"));
            return;
          }
          const bytes = Buffer.from(part.base64, "base64");
          if (bytes.length) controller.enqueue(bytes);
          if (part.done) {
            finish();
            controller.close();
          }
          if (part.done || bytes.length) return;
        }
      },
      cancel: close,
    }, { highWaterMark: 0 });
  }

  async cleanupArtifactFiles(
    root: string,
    cleanup: { kind: "selected"; paths: string[] } | { kind: "orphans" },
  ): Promise<RuntimeArtifactCleanup | "needsHost" | undefined> {
    this.artifactCleanupCapability ??= this.read<boolean>({ operation: "artifactCleanupSupported" })
      .then(supported => supported === true);
    if (!await this.artifactCleanupCapability) return "needsHost";
    const result = await this.read<RuntimeArtifactCleanup>(
      { operation: "cleanupArtifactFiles", root, cleanup }, "maintenance", false, 120_000,
    );
    if (!result) await this.stopping;
    return result;
  }

  async taskList(dotsTaskId: string, includeExpertBindings: boolean): Promise<Array<TaskRow & {
    expertBinding?: TaskExpertBindingDto;
  }> | undefined> {
    const rows = await this.read<Array<TaskRow & { expertBinding?: TaskExpertBindingDto }>>({
      operation: "taskList", dotsTaskId, includeExpertBindings,
    });
    if (Array.isArray(rows)) {
      if (!this.taskListReady) {
        this.taskListReady = true;
        console.info("[RuntimeAudit] Rust task list ready");
      }
      return rows;
    }
  }

  async pythonProjectBindings(ancestors?: string[]): Promise<RuntimePythonProjectBinding[] | undefined> {
    const rows = await this.read<RuntimePythonProjectBinding[]>({ operation: "pythonProjectBindings", ancestors });
    return Array.isArray(rows) ? rows : undefined;
  }

  taskRecord(taskId: string, includeExpertBindings: boolean): Promise<(TaskRow & { expertBinding?: TaskExpertBindingDto }) | null | undefined> {
    return this.read({ operation: "taskRecord", taskId, includeExpertBindings });
  }

  externalAgentHistoryPage(taskId: string, after?: ExternalAgentHistoryCursor): Promise<ExternalAgentHistoryPage | undefined> {
    return this.read({ operation: "externalAgentHistoryPage", taskId, after });
  }

  applicationDatabaseIdentity(): Promise<ApplicationDatabaseIdentity | undefined> {
    return this.read({ operation: "applicationDatabaseIdentity" });
  }

  taskWorkspacePaths(): Promise<{ cwds: Array<{ id: string; path: string }>; trashPaths: Array<{ id: string; path: string }> } | undefined> {
    return this.read({ operation: "taskWorkspacePaths" });
  }

  async workspaceData(query: RuntimeWorkspaceQuery): Promise<RuntimeWorkspaceData | undefined> {
    const data = await this.read<RuntimeWorkspaceData>({ operation: "workspaceData", query });
    if (!data || !Array.isArray(data.spaces)) return;
    if (!this.workspaceDataReady) {
      this.workspaceDataReady = true;
      console.info("[RuntimeAudit] Rust workspace data ready");
    }
    return data;
  }

  async moveWorkspaceTree(movement: RuntimeWorkspaceMove): Promise<RuntimeWorkspaceMoveReply | undefined> {
    this.workspaceMoveCapability ??= this.read<boolean>({ operation: "workspaceMoveSupported" }).then(result => result === true);
    if (!await this.workspaceMoveCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeWorkspaceMoveReply>({ operation: "moveWorkspaceTree", movement });
    if (result === undefined) await this.stopping;
    return result;
  }

  async setSidebarArchive(archive: RuntimeSidebarArchive): Promise<RuntimeSidebarArchiveReply | undefined> {
    this.sidebarArchiveCapability ??= this.read<boolean>({ operation: "sidebarArchiveSupported" }).then(result => result === true);
    if (!await this.sidebarArchiveCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeSidebarArchiveReply>({ operation: "setSidebarArchive", archive });
    if (result === undefined) await this.stopping;
    return result;
  }

  async writeWorkspaceLabel(mutation: RuntimeWorkspaceLabel): Promise<RuntimeWriteReply | undefined> {
    this.workspaceLabelsCapability ??= this.read<boolean>({ operation: "workspaceLabelsSupported" }).then(result => result === true);
    if (!await this.workspaceLabelsCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeWriteReply>({ operation: "writeWorkspaceLabel", mutation });
    if (result === undefined) await this.stopping;
    return result;
  }

  async upsertWorkspace(mutation: RuntimeWorkspacePersistence): Promise<RuntimeWorkspacePersistenceReply | undefined> {
    this.workspacePersistenceCapability ??= this.read<boolean>({ operation: "workspacePersistenceSupported" }).then(result => result === true);
    if (!await this.workspacePersistenceCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeWorkspacePersistenceReply>({ operation: "upsertWorkspace", mutation });
    if (result === undefined) await this.stopping;
    return result;
  }

  async deleteWorkspace(mutation: { id: string; archiveRoots?: string[]; dotsTaskId: string }): Promise<RuntimeWriteReply | undefined> {
    this.workspaceDeleteCapability ??= this.read<boolean>({ operation: "workspaceDeleteSupported" }).then(result => result === true);
    if (!await this.workspaceDeleteCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeWriteReply>({ operation: "deleteWorkspace", mutation });
    if (result === undefined) await this.stopping;
    return result;
  }

  private supportsWorkspaceBinding(): Promise<boolean> {
    this.workspaceBindingCapability ??= this.read<boolean>({ operation: "workspaceBindingSupported" }).then(result => result === true);
    return this.workspaceBindingCapability;
  }

  async workspaceBindingSnapshot(id: string): Promise<RuntimeWorkspaceBindingSnapshot | null | undefined> {
    if (!await this.supportsWorkspaceBinding()) return;
    return this.read<RuntimeWorkspaceBindingSnapshot | null>({ operation: "workspaceBindingSnapshot", id });
  }

  async writeWorkspaceBinding(mutation: RuntimeWorkspaceBindingMutation): Promise<RuntimeWriteReply | undefined> {
    if (!await this.supportsWorkspaceBinding()) return { status: "needsHost" };
    const result = await this.read<RuntimeWriteReply>({ operation: "writeWorkspaceBinding", mutation });
    if (result === undefined) await this.stopping;
    return result;
  }

  async memoryTurnData(query: RuntimeMemoryTurnQuery, userId: string): Promise<RuntimeMemoryTurnData | undefined> {
    const data = await this.read<RuntimeMemoryTurnData>({ operation: "memoryTurnData", query, userId });
    return data?.kind === query.kind ? data : undefined;
  }

  readMemoryExtractionQueue(taskIds?: readonly string[]): Promise<MemoryExtractionSnapshot | undefined> {
    return this.read({ operation: "readMemoryExtractionQueue", taskIds });
  }

  retryMemoryExtractionQueue(userId: string, operationId: string): Promise<MemoryExtractionRetry | undefined> {
    return this.read({ operation: "retryMemoryExtractionQueue", userId, operationId });
  }

  writeMemoryTurnExtraction(command: RuntimeMemoryTurnExtractionCommand, userId: string): Promise<RuntimeMemoryTurnExtractionReply | undefined> {
    return this.read({ operation: "writeMemoryTurnExtraction", command, userId });
  }

  async projectPosts(request: RuntimeProjectPostRequest): Promise<RuntimeProjectPostReply | undefined> {
    this.projectPostsCapability ??= this.read<boolean>({ operation: "projectPostsSupported" }).then(result => result === true);
    if (!await this.projectPostsCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeProjectPostReply>({ operation: "projectPosts", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  async projectEventData(request: RuntimeProjectEventRequest): Promise<RuntimeProjectEventReply | undefined> {
    this.projectEventDataCapability ??= this.read<boolean>({ operation: "projectEventDataSupported" }).then(result => result === true);
    if (!await this.projectEventDataCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeProjectEventReply>({ operation: "projectEventData", request });
    if (result === undefined && request.kind === "triage") await this.stopping;
    return result;
  }

  async answerRoutingData(request: RuntimeAnswerRoutingRequest): Promise<RuntimeAnswerRoutingReply | undefined> {
    this.answerRoutingDataCapability ??= this.read<boolean>({ operation: "answerRoutingDataSupported" }).then(result => result === true);
    if (!await this.answerRoutingDataCapability) return { status: "needsHost" };
    const reply = await this.read<RuntimeAnswerRoutingReply>({ operation: "answerRoutingData", request });
    if (reply === undefined && (request.kind === "save" || request.kind === "remove")) await this.stopping;
    return reply;
  }

  async memoryRecordsData(query: RuntimeMemoryRecordsQuery): Promise<RuntimeMemoryRecordsData | undefined> {
    const data = await this.read<RuntimeMemoryRecordsData>({ operation: "memoryRecordsData", query });
    return data?.kind === query.kind ? data : undefined;
  }

  async writeMemoryRecord(request: RuntimeMemoryRecordWriteRequest): Promise<RuntimeMemoryRecordWriteReply | undefined> {
    this.memoryRecordWriteCapability ??= this.read<boolean>({ operation: "memoryRecordWriteSupported" }).then(result => result === true);
    if (!await this.memoryRecordWriteCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeMemoryRecordWriteReply>({ operation: "writeMemoryRecord", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  async projectPins(request: RuntimeProjectPinRequest): Promise<RuntimeProjectPinReply | undefined> {
    this.projectPinsCapability ??= this.read<boolean>({ operation: "projectPinsSupported" }).then(result => result === true);
    if (!await this.projectPinsCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeProjectPinReply>({ operation: "projectPins", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  private supportsWorkQueue(): Promise<boolean> {
    this.workQueueCapability ??= this.read<boolean>({ operation: "workQueueSupported" }).then(result => result === true);
    return this.workQueueCapability;
  }

  async readWorkQueue(query: RuntimeWorkQueueQuery): Promise<RuntimeWorkQueueSnapshot | undefined> {
    if (!await this.supportsWorkQueue()) return;
    return this.read<RuntimeWorkQueueSnapshot>({ operation: "readWorkQueue", query });
  }

  async readBotHistoryPage(query: RuntimeBotHistoryQuery): Promise<RuntimeBotHistoryPage | undefined> {
    return this.read<RuntimeBotHistoryPage>({ operation: "readBotHistoryPage", query });
  }

  async markWorkCardRead(request: RuntimeWorkCardRead): Promise<RuntimeWorkCardReadReply | undefined> {
    if (!await this.supportsWorkQueue()) return { status: "needsHost" };
    const result = await this.read<RuntimeWorkCardReadReply>({ operation: "markWorkCardRead", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  async workspaceSharedData(currentSpaceId: string | null, taskId: string | null, includeMemories: boolean): Promise<RuntimeWorkspaceSharedData | undefined> {
    const data = await this.read<RuntimeWorkspaceSharedData>({ operation: "workspaceSharedData", currentSpaceId, taskId, includeMemories });
    if (data && Array.isArray(data.spaces) && Array.isArray(data.itemsBySpace) && Array.isArray(data.taskItems)) return data;
  }

  private supportsWorkGraph(): Promise<boolean> {
    this.workGraphCapability ??= this.read<boolean>({ operation: "workGraphSupported" }).then(result => result === true);
    return this.workGraphCapability;
  }

  async readWorkGraph(query: RuntimeWorkGraphQuery): Promise<WorkGraphEdgeDto[] | undefined> {
    if (!await this.supportsWorkGraph()) return;
    const edges = await this.read<WorkGraphEdgeDto[]>({ operation: "readWorkGraph", query });
    return Array.isArray(edges) ? edges : undefined;
  }

  async writeWorkGraph(mutation: RuntimeWorkGraphMutation): Promise<RuntimeWorkGraphReply | undefined> {
    if (!await this.supportsWorkGraph()) return { status: "needsHost" };
    const result = await this.read<RuntimeWorkGraphReply>({ operation: "writeWorkGraph", mutation });
    if (result === undefined) await this.stopping;
    return result;
  }

  async scanWorkGraphIntegrity(): Promise<IntegrityReport | undefined> {
    this.workGraphIntegrityCapability ??= this.read<boolean>({ operation: "workGraphIntegritySupported" }).then(result => result === true);
    if (!await this.workGraphIntegrityCapability) return;
    const result = await this.read<IntegrityReport>({ operation: "scanWorkGraphIntegrity" }, "scan", false, 60_000);
    if (result && Array.isArray(result.findings)) return result;
  }

  async listFileBackups(root: string, taskId?: string): Promise<FileBackupInfoDto[] | undefined> {
    this.fileBackupListCapability ??= this.read<boolean>({ operation: "fileBackupListSupported" }).then(result => result === true);
    if (!await this.fileBackupListCapability) return;
    const rows = await this.read<FileBackupInfoDto[]>({ operation: "fileBackupList", query: { root, taskId } }, "scan", false, 60_000);
    if (Array.isArray(rows)) return rows;
  }

  async readGatewayChannels(channelId?: string): Promise<GatewayChannelRecord[] | undefined> {
    const rows = await this.read<GatewayChannelRecord[]>({ operation: "readGatewayChannels", channelId });
    if (Array.isArray(rows)) return rows;
  }

  readGatewayChannelState(channelId: string): Promise<RuntimeGatewayChannelState | undefined> {
    return this.read({ operation: "readGatewayChannelState", channelId });
  }

  async readDotsDelegations(sourceIds?: string[], spaceIds?: string[] | null): Promise<DotsDelegation[]> {
    if (sourceIds?.length === 0 || spaceIds?.length === 0) return [];
    const rows: DotsDelegation[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = await this.read<RuntimeDotsPage<DotsDelegation>>({ operation: "readDotsDelegationData",
        query: { kind: "list", sourceIds, spaceIds, afterSeq, limit: 256 } });
      if (!page || !Array.isArray(page.rows)) throw new Error("Core 未确认 Dots 委派列表");
      rows.push(...page.rows);
      if (page.nextAfterSeq === null) return rows;
      if (!Number.isSafeInteger(page.nextAfterSeq) || page.nextAfterSeq <= afterSeq) throw new Error("Core 的 Dots 委派分页位置无效");
      afterSeq = page.nextAfterSeq;
    }
  }

  readDotsRecoveryPage(afterSeq: number): Promise<RuntimeDotsPage<RuntimeDotsRecoveryRow> | undefined> {
    return this.read({ operation: "readDotsDelegationData", query: { kind: "recovery", afterSeq, limit: 128 } });
  }

  readDotsActivityPage(spaceIds: readonly string[] | null, after?: DotsActivityCursor): Promise<DotsActivityPage | undefined> {
    return this.read({ operation: "readDotsActivityData", query: { spaceIds, after } });
  }

  dotsDeferredRead<T>(query: DeferredRequirementsQuery): Promise<T | undefined> {
    return this.read({ operation: "readDotsDeferredData", query });
  }

  dotsDeferredWrite<T>(command: DeferredRequirementsCommand): Promise<T | undefined> {
    return this.read({ operation: "writeDotsDeferredData", command });
  }

  readDotsFollowupData<T>(query: Record<string, unknown>): Promise<T | undefined> {
    return this.read({ operation: "readDotsFollowupData", query });
  }

  writeDotsFollowupData<T>(command: Record<string, unknown>): Promise<T | undefined> {
    return this.read({ operation: "writeDotsFollowupData", command });
  }

  readDotsForegroundData<T>(query: DotsForegroundQuery): Promise<T | undefined> {
    return this.read({ operation: "readDotsForegroundData", query });
  }

  writeDotsForegroundData<T>(command: DotsForegroundCommand): Promise<T | undefined> {
    return this.read({ operation: "writeDotsForegroundData", command });
  }

  readDotsProactiveData<T>(query: Record<string, unknown>): Promise<T | undefined> {
    return this.read({ operation: "readDotsProactiveData", query });
  }

  writeDotsProactiveData<T>(command: Record<string, unknown>): Promise<T | undefined> {
    return this.read({ operation: "writeDotsProactiveData", command });
  }

  readDotsFileWatchData<T>(query: Record<string, unknown>): Promise<T | undefined> {
    return this.read({ operation: "readDotsFileWatchData", query });
  }

  writeDotsFileWatchData<T>(command: Record<string, unknown>): Promise<T | undefined> {
    return this.read({ operation: "writeDotsFileWatchData", command });
  }

  async *readActiveDotsDelegations(taskId?: string): AsyncGenerator<RuntimeDotsActiveDelegation> {
    let beforeSeq: number | undefined;
    for (;;) {
      const page: { rows: RuntimeDotsActiveDelegation[]; nextBeforeSeq: number | null } | undefined = await this.read({
        operation: "readDotsDelegationData", query: { kind: "active", taskId, beforeSeq, limit: 128 },
      });
      if (!page || !Array.isArray(page.rows)) throw new Error("Core 未确认待对账的 Dots 委派");
      yield* page.rows;
      if (page.nextBeforeSeq === null) return;
      if (!Number.isSafeInteger(page.nextBeforeSeq) || page.nextBeforeSeq <= 0 || (beforeSeq !== undefined && page.nextBeforeSeq >= beforeSeq)) {
        throw new Error("Core 的 Dots 委派对账分页位置无效");
      }
      beforeSeq = page.nextBeforeSeq;
    }
  }

  readDotsPendingReplies(afterKey?: string): Promise<{ rows: { eventKey: string; taskId: string }[]; nextKey: string | null } | undefined> {
    return this.read({ operation: "readDotsReplyData", query: { kind: "pending", afterKey, limit: 128 } });
  }

  prepareDotsReply(eventKey: string, expectedSnapshot: string, reply: DotsAssistantReply): Promise<RuntimeDotsReplyState | undefined> {
    return this.read({ operation: "writeDotsReplyData", command: { kind: "prepare", eventKey, expectedSnapshot, reply } });
  }

  inspectDotsReply(eventKey: string): Promise<RuntimeDotsReplyState | undefined> {
    return this.read({ operation: "writeDotsReplyData", command: { kind: "inspect", eventKey } });
  }

  readDotsReportContext(operationId: string, deliveryKey: string): Promise<{
    goal: string | null; format: string | null; saved: string | null; previous: string | null; newerSample: boolean;
  } | undefined> {
    return this.read({ operation: "readDotsReplyData", query: { kind: "report", operationId, deliveryKey } });
  }

  async readLatestDotsReply(taskId: string, spaceIds: string[] | null): Promise<DotsTaskDelivery | undefined> {
    const result = await this.read<DotsTaskDelivery | null>({ operation: "readDotsReplyData", query: { kind: "latest", taskId, spaceIds } });
    if (result === undefined) throw new Error("Core 未确认 Dots 原对话交付");
    return result ?? undefined;
  }

  async dotsRecoveryCurrent(taskId: string, operationId: string, guard: RuntimeDotsRecoveryGuard): Promise<boolean> {
    const state = await this.read<{ current: boolean }>({ operation: "readDotsDelegationData",
      query: { kind: "current", taskId, operationId, guard } });
    if (typeof state?.current !== "boolean") throw new Error("Core 未确认 Dots 恢复范围");
    return state.current;
  }

  readDotsWorkerAuthority(taskId: string, operationId: string, spaceIds: string[] | null, hostGeneration?: string) {
    return this.read<{ spaceId: string | null; privateCwd: string | null } | null>({ operation: "readDotsDelegationData",
      query: { kind: "worker", taskId, operationId, spaceIds, hostGeneration } });
  }

  writeGatewayChannel(operationId: string, channel: GatewayChannelRecord, expected: GatewayChannelRecord | null,
    expectedRevision?: number, transition?: RuntimeGatewayChannelTransition): Promise<RuntimeGatewayChannelWriteReply | undefined> {
    return this.read({ operation: "writeGatewayChannel", operationId, draft: { channel, expected, expectedRevision, transition } });
  }

  readGatewayOutbox(deliveryId: string): Promise<GatewayOutboxEntry | null | undefined> {
    return this.read({ operation: "readGatewayOutbox", deliveryId });
  }

  readGatewayInbox(deliveryId: string): Promise<GatewayInboxEntry | null | undefined> {
    return this.read({ operation: "readGatewayInbox", deliveryId });
  }

  readGatewayRecovery(query: RuntimeGatewayRecoveryQuery): Promise<RuntimeGatewayRecovery | undefined> {
    return this.read({ operation: "readGatewayQueue", query: { kind: "recovery", ...query } });
  }

  readGatewayContinuation(deliveryId: string): Promise<{ kind: "continuation"; operationId: string | null } | undefined> {
    return this.read({ operation: "readGatewayQueue", query: { kind: "continuation", deliveryId } });
  }

  readGatewayAssignment({ channelId, connectionKey, chatId, senderId, messageId }: Pick<GatewayBotOrigin, "channelId" | "connectionKey" | "chatId" | "senderId" | "messageId">): Promise<RuntimeGatewayAssignment | undefined> {
    return this.read({ operation: "readGatewayAssignment", origin: { channelId, connectionKey, chatId, senderId, messageId } });
  }

  readGatewayExecutionAuthority(taskId: string): Promise<GatewayExecutionAuthority | undefined> {
    return this.read({ operation: "readGatewayExecutionAuthority", taskId });
  }

  materializeGatewayTask(command: GatewayTaskMaterialization): Promise<GatewayTaskMaterializationResult | undefined> {
    return this.read({ operation: "materializeGatewayTask", command });
  }

  admitGatewayInbound(draft: RuntimeGatewayAdmission): Promise<RuntimeGatewayAdmissionReply | undefined> {
    return this.read({ operation: "gatewayAdmitInbound", draft });
  }

  gatewayDeliveryControl(deliveryId: string, operationId: string, command: RuntimeGatewayDeliveryCommand): Promise<RuntimeGatewayDeliveryReply | undefined> {
    return this.read({ operation: "gatewayDeliveryControl", deliveryId, operationId, command });
  }

  async readGatewayMessages(query: GatewayListMessagesRequest & { limit: number }): Promise<GatewayMessageDto[] | undefined> {
    const rows = await this.read<GatewayMessageDto[]>({ operation: "readGatewayMessages", query });
    if (Array.isArray(rows)) return rows.map(row => ({
      ...row, senderId: row.senderId ?? undefined, senderName: row.senderName ?? undefined,
    }));
  }

  async appendGatewayMessage(message: RuntimeGatewayMessageWrite): Promise<RuntimeGatewayMessageWriteReply | undefined> {
    this.gatewayMessageWriteCapability ??= this.read<boolean>({ operation: "gatewayMessageWriteSupported" }).then(result => result === true);
    if (!await this.gatewayMessageWriteCapability) return { status: "needsHost" };
    const reply = await this.read<RuntimeGatewayMessageWriteReply>({ operation: "appendGatewayMessage", message });
    if (reply === undefined) await this.stopping;
    return reply?.status === "saved" || reply?.status === "needsHost" ? reply : undefined;
  }

  async codeReviewData(query: RuntimeCodeReviewQuery): Promise<RuntimeCodeReviewData | undefined> {
    const result = await this.read<RuntimeCodeReviewData>({ operation: "codeReviewData", query });
    return result?.kind === query.kind ? result : undefined;
  }

  async restoreFileBackup(request: RuntimeFileBackupRestoreRequest): Promise<RuntimeFileBackupRestoreReply | undefined> {
    this.fileBackupRestoreCapability ??= this.read<boolean>({ operation: "fileBackupRestoreSupported" }).then(result => result === true);
    if (!await this.fileBackupRestoreCapability) return { status: "needsHost" };
    return this.read<RuntimeFileBackupRestoreReply>({ operation: "restoreFileBackup", request }, "scan", false, 60_000);
  }

  async subagentSettings(request: RuntimeSubagentSettingsRequest): Promise<RuntimeSubagentSettingsReply | undefined> {
    this.subagentSettingsCapability ??= this.read<boolean>({ operation: "subagentSettingsSupported" }).then(result => result === true);
    if (!await this.subagentSettingsCapability) return { status: "needsHost" };
    return this.read<RuntimeSubagentSettingsReply>({ operation: "subagentSettings", request }, "scan", false, 60_000);
  }

  async materialRetrievalData(request: RuntimeMaterialRetrievalRequest): Promise<RuntimeMaterialRetrievalReply | undefined> {
    this.materialRetrievalCapability ??= this.read<boolean>({ operation: "materialRetrievalSupported" }).then(result => result === true);
    if (!await this.materialRetrievalCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeMaterialRetrievalReply>({ operation: "materialRetrievalData", request });
    if (result === undefined && (request.kind === "setSettings" || request.kind === "setScope")) await this.stopping;
    return result;
  }

  async restoreTrashedTask(request: RuntimeTaskTrashRestore): Promise<RuntimeTaskTrashRestoreReply | undefined> {
    this.taskTrashRestoreCapability ??= this.read<boolean>({ operation: "taskTrashRestoreSupported" }).then(result => result === true);
    if (!await this.taskTrashRestoreCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeTaskTrashRestoreReply>({ operation: "restoreTrashedTask", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  async soulProfile(request: RuntimeSoulProfileRequest): Promise<RuntimeSoulProfileReply | undefined> {
    this.soulProfileCapability ??= this.read<boolean>({ operation: "soulProfileSupported" }).then(result => result === true);
    if (!await this.soulProfileCapability) return { status: "needsHost" };
    const reply = await this.read<RuntimeSoulProfileReply>({ operation: "soulProfile", request });
    if (reply === undefined && request.kind === "update") await this.stopping;
    return reply;
  }

  async writeDurableWorkspaceMove(request: RuntimeDurableWorkspaceMoveRequest): Promise<RuntimeDurableWorkspaceMoveReply | undefined> {
    this.durableWorkspaceMoveCapability ??= this.read<boolean>({ operation: "durableWorkspaceMoveSupported" }).then(result => result === true);
    if (!await this.durableWorkspaceMoveCapability) return { status: "needsHost" };
    const reply = await this.read<RuntimeDurableWorkspaceMoveReply>({ operation: "writeDurableWorkspaceMove", request });
    if (reply === undefined) await this.stopping;
    return reply;
  }

  async readTaskExpertBinding(taskId: string): Promise<RuntimeTaskExpertBindingState | null | undefined> {
    return this.read<RuntimeTaskExpertBindingState | null>({ operation: "readTaskExpertBinding", taskId });
  }

  async writeTaskExpertBinding(mutation: RuntimeTaskExpertBindingMutation): Promise<RuntimeTaskExpertBindingWriteReply | undefined> {
    this.taskExpertBindingCapability ??= this.read<boolean>({ operation: "taskExpertBindingSupported" }).then(result => result === true);
    if (!await this.taskExpertBindingCapability) return { status: "needsHost" };
    const reply = await this.read<RuntimeTaskExpertBindingWriteReply>({ operation: "writeTaskExpertBinding", mutation });
    if (reply === undefined) await this.stopping;
    return reply;
  }

  async memoryOrganizationLatest(): Promise<string | null | undefined> {
    return this.read<string | null>({ operation: "memoryOrganizationLatest" });
  }

  async writeMemoryOrganizationProgress(progress: RuntimeMemoryOrganizationProgress): Promise<boolean | undefined> {
    this.memoryOrganizationProgressCapability ??= this.read<boolean>({ operation: "memoryOrganizationProgressSupported" }).then(result => result === true);
    if (!await this.memoryOrganizationProgressCapability) return;
    const written = await this.read<boolean>({ operation: "writeMemoryOrganizationProgress", progress });
    if (written === undefined) await this.stopping;
    return written;
  }

  async applyWorkGraphRepair(preview: RepairPreview): Promise<RuntimeWorkGraphRepairReply | undefined> {
    this.workGraphRepairCapability ??= this.read<boolean>({ operation: "workGraphRepairSupported" }).then(result => result === true);
    if (!await this.workGraphRepairCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeWorkGraphRepairReply>({ operation: "applyWorkGraphRepair", preview });
    if (result === undefined) await this.stopping;
    return result;
  }

  async writeDurableTaskProjection(request: RuntimeDurableTaskProjectionRequest): Promise<RuntimeDurableTaskProjectionReply | undefined> {
    this.durableTaskProjectionCapability ??= this.read<boolean>({ operation: "durableTaskOriginsSupported" }).then(result => result === true);
    if (!await this.durableTaskProjectionCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeDurableTaskProjectionReply>({ operation: "writeDurableTaskProjection", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  async readTaskWorkspaceAuthority(taskId: string): Promise<TaskWorkspaceAuthority | null | undefined> {
    return this.read({ operation: "readDurableTaskProjection", query: { kind: "workspaceAuthority", taskId } });
  }

  readTaskWriteGrants(taskId: string): Promise<TaskWriteGrantRow[] | undefined> {
    return this.read({ operation: "readDurableTaskProjection", query: { kind: "taskWriteGrants", taskId } });
  }

  readExecutionAttempt(id: string, execution: ConversationExecutionContext, toolCallId: string): Promise<ExecutionAttempt | null | undefined> {
    return this.read({ operation: "readDurableTaskProjection", query: { kind: "executionAttempt", ...execution, toolCallId, id } });
  }

  readDurableTaskBinding(taskId: string): Promise<{ directory: string; cwd: string; trashed: boolean } | null | undefined> {
    return this.read({ operation: "readDurableTaskProjection", query: { kind: "binding", taskId } });
  }

  readDurableOpenState(taskId: string): Promise<RuntimeDurableOpenState | null | undefined> {
    return this.read({ operation: "readDurableTaskProjection", query: { kind: "openState", taskId } });
  }

  readWorkExecutionMetrics(taskId: string, includeFacts: boolean): Promise<RuntimeWorkExecutionMetrics | null | undefined> {
    return this.read({ operation: "readDurableTaskProjection", query: { kind: "workMetrics", taskId, includeFacts } });
  }

  readDurableResumePage(after?: string): Promise<{ taskIds: string[]; next: string | null } | undefined> {
    return this.read({ operation: "readDurableTaskProjection", query: { kind: "resumePage", after } });
  }

  private supportsNotificationData(): Promise<boolean> {
    this.notificationDataCapability ??= this.read<boolean>({ operation: "notificationDataSupported" }).then(result => result === true);
    return this.notificationDataCapability;
  }

  async notificationData(query: RuntimeNotificationQuery): Promise<RuntimeNotificationSqlRow[] | number | undefined> {
    if (!await this.supportsNotificationData()) return;
    const result = await this.read<RuntimeNotificationSqlRow[] | number>({ operation: "notificationData", query });
    if (Array.isArray(result) || typeof result === "number") return result;
  }

  async notificationActivation(id: string, now: number): Promise<{ target: unknown } | undefined> {
    return this.read<{ target: unknown }>({ operation: "notificationData", query: { kind: "activation", id, now } });
  }

  async writeNotification(mutation: RuntimeNotificationMutation): Promise<RuntimeNotificationWriteReply | undefined> {
    if (!await this.supportsNotificationData()) return { status: "needsHost" };
    const result = await this.read<RuntimeNotificationWriteReply>({ operation: "writeNotification", mutation });
    if (result === undefined) await this.stopping;
    return result;
  }

  async upsertTaskRecord(mutation: RuntimeTaskRecord): Promise<RuntimeTaskRecordReply | undefined> {
    this.taskRecordsCapability ??= this.read<boolean>({ operation: "taskRecordsSupported" }).then(result => result === true);
    if (!await this.taskRecordsCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeTaskRecordReply>({ operation: "upsertTaskRecord", mutation });
    if (result === undefined) await this.stopping;
    return result;
  }

  async writeTaskContextUsageBatch(snapshots: readonly TaskContextUsageSnapshot[]): Promise<RuntimeWriteReply | undefined> {
    this.taskContextUsageCapability ??= this.read<boolean>({ operation: "taskContextUsageSupported" }).then(result => result === true);
    if (!await this.taskContextUsageCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeWriteReply>({ operation: "writeTaskContextUsage", snapshots });
    if (result === undefined) await this.stopping;
    return result;
  }

  private supportsExecutionFailures(): Promise<boolean> {
    this.executionFailuresCapability ??= this.read<boolean>({ operation: "executionFailuresSupported" }).then(result => result === true);
    return this.executionFailuresCapability;
  }

  async executionFailures(taskId: string): Promise<ExecutionFailureRow[] | undefined> {
    if (!await this.supportsExecutionFailures()) return;
    const rows = await this.read<ExecutionFailureRow[]>({ operation: "executionFailures", taskId });
    return Array.isArray(rows) ? rows : undefined;
  }

  async dismissExecutionFailure(taskId: string, id: string, at: number): Promise<ExecutionFailureDismissReply | undefined> {
    if (!Number.isSafeInteger(at) || !await this.supportsExecutionFailures()) return { status: "needsHost" };
    const result = await this.read<ExecutionFailureDismissReply>({ operation: "dismissExecutionFailure", taskId, id, at });
    if (result === undefined) await this.stopping;
    return result;
  }

  async writeExecutionFailures<T = unknown>(request: Record<string, unknown>): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "writeExecutionFailures", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  async batch1Write<T = unknown>(request: Record<string, unknown>): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "batch1Write", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  async batch2Write<T = unknown>(request: Record<string, unknown>): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "batch2Write", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  async batch3Write<T = unknown>(request: Record<string, unknown>): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "batch3Write", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  async batch4aWrite<T = unknown>(request: Record<string, unknown>): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "batch4aWrite", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  async batch4bWrite<T = unknown>(request: Record<string, unknown>): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "batch4bWrite", request });
    if (result === undefined) await this.stopping;
    return result;
  }

  registerBot(request: RuntimeBotRegistration): Promise<RuntimeBotRegistrationReply | undefined> {
    return this.batch4bWrite<RuntimeBotRegistrationReply>({ op: "botUpsert", ...request });
  }

  readBotRegistry(query: RuntimeBotListQuery): Promise<RuntimeBotRow[] | undefined>;
  readBotRegistry(query: RuntimeBotLookup): Promise<RuntimeBotRow | null | undefined>;
  readBotRegistry(query: RuntimeBotListQuery | RuntimeBotLookup): Promise<RuntimeBotRow[] | RuntimeBotRow | null | undefined> {
    return this.read({ operation: "readBotRegistry", query });
  }

  readConversationRuntime(taskId: string, userId: string): Promise<RuntimeConversationSnapshot | null | undefined> {
    return this.read({ operation: "readConversationRuntime", query: { kind: "snapshot", taskId, userId } });
  }

  readConversationGoalGeneration(taskId: string, userId: string, conversationId: string, generationTaskId: number): Promise<import("../agent/ConversationGoalActivity").OwnedGoalRun | null | undefined> {
    return this.read({ operation: "readConversationRuntime", query: { kind: "goalActivityGeneration", taskId, userId, conversationId, generationTaskId } });
  }

  readConversationGoalActivityOwner(taskId: string, userId: string, conversationId: string, messageId: string): Promise<import("../../shared/conversation-goal-activity").GoalActivityOwner | null | undefined> {
    return this.read({ operation: "readConversationRuntime", query: { kind: "goalActivityOwner", taskId, userId, conversationId, messageId } });
  }

  hasAuthoredGoalSkillAtPath(pathKey: string): Promise<boolean | undefined> {
    return this.read({ operation: "readConversationRuntime", query: { kind: "authoredGoalSkillAtPath", pathKey } });
  }

  readLoadoutObservations(taskId: string, limit: number): Promise<RuntimeLoadoutObservationRow[] | undefined> {
    return this.read({ operation: "readLoadoutObservations", taskId, limit });
  }

  createConversationGoal(operationId: string, draft: RuntimeConversationGoalDraft): Promise<RuntimeConversationGoalCreateReply | undefined> {
    return this.read({ operation: "createConversationGoal", operationId, draft });
  }

  readWorkTaskAccess(taskId: string): Promise<WorkTaskAccess | undefined> {
    return this.read({ operation: "readConversationRuntime", query: { kind: "taskAccess", taskId } });
  }

  async branchTitle(sourceTitle: string, dotsTaskId: string): Promise<string | undefined> {
    const title = await this.read<string>({ operation: "branchTitle", sourceTitle, dotsTaskId });
    return typeof title === "string" ? title : undefined;
  }

  readConversationBranchData(kind: "info" | "children", taskId: string): Promise<{ rows: ConversationBranchInfoDto[] } | undefined> {
    return this.read({ operation: "readConversationBranchData", query: { kind, taskId } });
  }

  async archivedTaskCandidates(dotsTaskId: string, taskIds: string[], spaceIds: string[]): Promise<ArchiveTaskCandidate[] | undefined> {
    const rows = await this.read<ArchiveTaskCandidate[]>({ operation: "archivedTaskCandidates", dotsTaskId, taskIds, spaceIds });
    return Array.isArray(rows) ? rows : undefined;
  }

  private supportsTaskTrash(): Promise<boolean> {
    this.taskTrashCapability ??= this.read<boolean>({ operation: "taskTrashSupported" }).then(result => result === true);
    return this.taskTrashCapability;
  }

  async listTrashedTasks(trashRoot: string): Promise<TrashedTaskDto[] | undefined> {
    if (!await this.supportsTaskTrash()) return;
    const rows = await this.read<TrashedTaskDto[]>({ operation: "listTrashedTasks", trashRoot }, "scan");
    if (!Array.isArray(rows)) return;
    if (!this.taskTrashReady) {
      this.taskTrashReady = true;
      console.info("[RuntimeAudit] Rust task trash data ready");
    }
    return rows;
  }

  async dueTrashedTasks(now: number): Promise<RuntimeDueTrashedTask[] | undefined> {
    if (!await this.supportsTaskTrash()) return;
    const rows = await this.read<RuntimeDueTrashedTask[]>({ operation: "dueTrashedTasks", now });
    return Array.isArray(rows) ? rows : undefined;
  }

  async alignTrashRetention(retentionMs: number): Promise<RuntimeTrashRetentionReply | undefined> {
    if (!Number.isSafeInteger(retentionMs) || !await this.supportsTaskTrash()) return { status: "needsHost" };
    const result = await this.read<RuntimeTrashRetentionReply>({ operation: "alignTrashRetention", retentionMs });
    if (result === undefined) await this.stopping;
    return result;
  }

  async purgeTrashedTask(purge: RuntimeTaskTrashPurge): Promise<RuntimeTaskTrashPurgeReply | undefined> {
    this.taskTrashPurgeCapability ??= this.read<boolean>({ operation: "taskTrashPurgeSupported" }).then(result => result === true);
    if (!await this.taskTrashPurgeCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeTaskTrashPurgeReply>({ operation: "purgeTrashedTask", purge });
    if (result === undefined) await this.stopping;
    return result;
  }

  async taskBoard<Row>(query: RuntimeTaskBoardQuery): Promise<RuntimeTaskBoardPage<Row> | undefined> {
    const page = await this.read<RuntimeTaskBoardPage<Row>>({ operation: "taskBoard", query });
    if (page && Array.isArray(page.rows)) {
      if (!this.taskBoardReady) {
        this.taskBoardReady = true;
        console.info("[RuntimeAudit] Rust task board ready");
      }
      return page;
    }
  }

  async writeTaskBoardAction(input: {
    id: string;
    action: import("../../shared/task-board").BoardAction;
    now: number;
    laterUntil: number | null;
  }): Promise<boolean> {
    const saved = await this.read<boolean>({ operation: "writeTaskBoardAction", input });
    if (saved === undefined) await this.stopping;
    return saved === true;
  }

  async writeTaskBoardNote(note: { id: string; kindName: "follow" | "visit" | "read" | "result"; detail: string; at: number }): Promise<boolean> {
    const result = await this.batch2Write<{ ok: boolean }>({ kind: "taskBoardNote", ...note });
    return result?.ok === true;
  }

  async acknowledgeTaskDone(taskId: string, at: number): Promise<boolean | undefined> {
    const result = await this.read<boolean>({ operation: "acknowledgeTaskDone", taskId, at });
    if (result === undefined) await this.stopping;
    return result;
  }

  async setTaskDueDate(taskId: string, dueAt: number | null, nextLocalDay: number | null): Promise<TaskDueDateResult | undefined> {
    const result = await this.read<TaskDueDateResult>({
      operation: "setTaskDueDate", taskId, dueAt, nextLocalDay,
    });
    if (result === undefined) await this.stopping;
    return result;
  }

  async editTaskSidebar(edit: TaskSidebarEdit): Promise<TaskSidebarResult | undefined> {
    const result = await this.read<TaskSidebarResult>({ operation: "editTaskSidebar", taskId: edit.id, edit });
    if (result === undefined) await this.stopping;
    return result;
  }

  async libraryMetadata<T>(query: RuntimeLibraryMetadataQuery): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "libraryMetadata", query });
    if (result !== undefined && !this.libraryMetadataReady) {
      this.libraryMetadataReady = true;
      console.info("[RuntimeAudit] Rust library metadata ready");
    }
    return result;
  }

  async writeLibraryNote<Row>(change: RuntimeLibraryNoteChange): Promise<RuntimeLibraryNoteWriteReply<Row> | undefined> {
    const restoring = change.kind === "restore";
    const capability = restoring
      ? this.libraryNoteRestoreCapability ??= this.noteWriteSupported("noteRestoresSupported")
      : this.libraryNoteWriteCapability ??= this.noteWriteSupported("noteWritesSupported");
    if (!await capability) return undefined;
    const result = await this.read<RuntimeLibraryNoteWriteReply<Row>>(
      { operation: "writeLibraryNote", change, updatedAt: Date.now() },
      "database", false, restoring ? 120_000 : undefined,
    );
    if (result) {
      if (result.status === "updated") {
        if (restoring && !this.libraryNoteRestorerReady) {
          this.libraryNoteRestorerReady = true;
          console.info("[RuntimeAudit] Rust library note restore ready");
        } else if (!restoring && !this.libraryNoteWriterReady) {
          this.libraryNoteWriterReady = true;
          console.info("[RuntimeAudit] Rust library note writer ready");
        }
      }
      return result;
    }
    await this.stopping;
    // A lost reply does not establish that the write failed. Replaying can overwrite a newer edit.
    throw new Error("无法确认笔记变更是否已保存，请刷新后再试");
  }

  private noteWriteSupported(kind: "noteWritesSupported" | "noteRestoresSupported"): Promise<boolean> {
    return this.read<boolean>({ operation: "libraryMetadata", query: { kind } }).then(supported => supported === true);
  }

  async saveLibraryText(save: RuntimeLibraryTextSave): Promise<RuntimeLibraryTextSaveResult | undefined> {
    this.libraryTextSaveCapability ??= this.read<boolean>({
      operation: "libraryMetadata", query: { kind: "textSavesSupported" },
    }).then(supported => supported === true);
    if (!await this.libraryTextSaveCapability) return "needsHost";
    const result = await this.read<RuntimeLibraryTextSaveResult>({ operation: "saveLibraryText", save });
    if (result === undefined) await this.stopping;
    if (result === "saved" && !this.libraryTextWriterReady) {
      this.libraryTextWriterReady = true;
      console.info("[RuntimeAudit] Rust library text writer ready");
    }
    return result;
  }

  private supportsLibraryDelete(): Promise<boolean> {
    return this.libraryDeleteCapability ??= this.read<boolean>({
      operation: "libraryMetadata", query: { kind: "deletesSupported" },
    }).then(supported => supported === true);
  }

  async deleteLibrary(root: string, target: RuntimeLibraryDeleteTarget): Promise<RuntimeLibraryDeleteReply | undefined> {
    if (!await this.supportsLibraryDelete()) return { status: "needsHost" };
    const result = await this.read<RuntimeLibraryDeleteReply>({ operation: "deleteLibrary", root, target }, "maintenance", false, 120_000);
    if (result === undefined) await this.stopping;
    if (result?.status === "deleted" && !this.libraryDeleteReady) {
      this.libraryDeleteReady = true;
      console.info("[RuntimeAudit] Rust library deletion ready");
    }
    return result;
  }

  async drainLibraryCleanup(root: string): Promise<number | undefined> {
    if (!await this.supportsLibraryDelete()) return undefined;
    const result = await this.read<number>({ operation: "drainLibraryCleanup", root }, "maintenance", false, 120_000);
    if (result === undefined) await this.stopping;
    return result;
  }

  async exportLibraryBackup(root: string, owner: LibraryOwnerScope, staging: string): Promise<RuntimeLibraryBackupResult | undefined> {
    this.libraryBackupCapability ??= this.read<boolean>({
      operation: "libraryMetadata", query: { kind: "backupsSupported" },
    }).then(supported => supported === true);
    if (!await this.libraryBackupCapability) return "needsHost";
    const result = await this.read<RuntimeLibraryBackupResult>({ operation: "exportLibraryBackup", root, owner, staging }, "maintenance", false, 120_000);
    if (result === undefined) await this.stopping;
    if (result === "saved" && !this.libraryBackupExporterReady) {
      this.libraryBackupExporterReady = true;
      console.info("[RuntimeAudit] Rust library backup export ready");
    }
    return result;
  }

  private supportsLibraryRestore(): Promise<boolean> {
    return this.libraryRestoreCapability ??= this.read<boolean>({
      operation: "libraryMetadata", query: { kind: "restoreBackupsSupported" },
    }).then(supported => supported === true);
  }

  restoreLibraryBackup(input: RuntimeLibraryRestoreInput, chooseDestination: () => string): Promise<RuntimeLibraryRestoreResult | undefined> {
    const task = this.libraryRestoreTail.then(async () => {
      if (!await this.supportsLibraryRestore()) return { status: "needsHost" } as const;
      const { source, operationId, ...restore } = input;
      const prepared = await this.read<
        { status: "prepared" } | { status: "rejected"; message: string }
      >({ operation: "prepareLibraryRestore", source, operationId }, "maintenance", false, 120_000);
      if (prepared?.status !== "prepared") {
        if (!prepared) await this.stopping;
        return prepared;
      }
      let defaultSpaceId: string;
      try {
        defaultSpaceId = chooseDestination();
      } catch (error) {
        await this.read<boolean>({ operation: "discardLibraryRestore", operationId }, "maintenance");
        throw error;
      }
      const result = await this.read<RuntimeLibraryRestoreResult>({
        operation: "restoreLibraryBackup", restore: { ...restore, operationId, defaultSpaceId },
      }, "maintenance", false, 120_000);
      if (result === undefined) await this.stopping;
      if (result?.status === "restored" && !this.libraryRestoreReady) {
        this.libraryRestoreReady = true;
        console.info("[RuntimeAudit] Rust library backup restore ready");
      }
      return result;
    });
    this.libraryRestoreTail = task.catch(() => undefined);
    return task;
  }

  async recoverLibraryRestores(root: string): Promise<number | undefined> {
    if (!await this.supportsLibraryRestore()) return undefined;
    const result = await this.read<number>({ operation: "recoverLibraryRestores", root }, "maintenance", false, 120_000);
    if (result === undefined) await this.stopping;
    return result;
  }

  readScopedNote(scope: RuntimeNoteScope, id: string): Promise<RuntimeScopedNoteReply | undefined> {
    return this.read({ operation: "readScopedNote", scope, id });
  }

  async saveScopedNote(scope: RuntimeNoteScope, id: string, save: RuntimeScopedNoteSave): Promise<RuntimeScopedNoteReply | undefined> {
    const result = await this.read<RuntimeScopedNoteReply>({ operation: "saveScopedNote", scope, id, save });
    if (result === undefined) await this.stopping;
    else if (!this.scopedNotesReady) {
      this.scopedNotesReady = true;
      console.info("[RuntimeAudit] Rust scoped notes ready");
    }
    return result;
  }

  async projectMetadata<T>(query: RuntimeProjectMetadataQuery): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "projectMetadata", query });
    if (result !== undefined && !this.projectMetadataReady) {
      this.projectMetadataReady = true;
      console.info("[RuntimeAudit] Rust project metadata ready");
    }
    return result;
  }

  async cronData<T>(query: RuntimeCronDataQuery): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "cronData", query });
    if (result !== undefined && !this.cronDataReady) {
      this.cronDataReady = true;
      console.info("[RuntimeAudit] Rust automation data ready");
    }
    return result;
  }

  async writeCronRun(mutation: CronRunWrite): Promise<boolean | undefined> {
    const result = await this.read<boolean>({ operation: "writeCronRun", mutation });
    if (typeof result !== "boolean") {
      await this.stopping;
      return undefined;
    }
    if (!this.cronWriterReady && result) {
      this.cronWriterReady = true;
      console.info("[RuntimeAudit] Rust automation writer ready");
    }
    return result;
  }

  async writeCronPlan(mutation: CronPlanWrite): Promise<boolean | undefined> {
    const result = await this.read<boolean>({ operation: "writeCronPlan", mutation });
    if (typeof result !== "boolean") {
      await this.stopping;
      return undefined;
    }
    if (!this.cronPlanWriterReady && result) {
      this.cronPlanWriterReady = true;
      console.info("[RuntimeAudit] Rust automation plan writer ready");
    }
    return result;
  }

  async workbenchData<Row>(query: RuntimeWorkbenchDataQuery): Promise<Row[] | undefined> {
    const rows = await this.read<Row[]>({ operation: "workbenchData", query });
    if (Array.isArray(rows)) {
      if (!this.workbenchDataReady) {
        this.workbenchDataReady = true;
        console.info("[RuntimeAudit] Rust workbench data ready");
      }
      return rows;
    }
  }

  async readGadgetSource(root: string, id: string): Promise<RuntimeGadgetSource | undefined> {
    return this.read<RuntimeGadgetSource>({ operation: "readGadgetSource", root, id });
  }

  readGadgetManifest(root: string, id: string): Promise<RuntimeGadgetManifest | undefined> {
    return this.read<RuntimeGadgetManifest>({ operation: "readGadgetManifest", root, id });
  }

  captureBlueprintGadget(root: string, id: string, deny: string): Promise<RuntimeBlueprintGadgetCapture | undefined> {
    return this.read<RuntimeBlueprintGadgetCapture>({ operation: "captureBlueprintGadget", root, id, deny });
  }

  captureBlueprintWorkspace(root: string, paths: string[], deny: string): Promise<RuntimeBlueprintFileCapture | undefined> {
    return this.read<RuntimeBlueprintFileCapture>({ operation: "captureBlueprintWorkspace", root, paths, deny });
  }

  async supportsGadgetFileMutations(): Promise<boolean> {
    this.gadgetFileMutationsCapability ??= this.read<boolean>({ operation: "gadgetFileMutationsSupported" })
      .then(supported => supported === true);
    return this.gadgetFileMutationsCapability;
  }

  async inspectGadgetSource(root: string, id: string): Promise<RuntimeGadgetSourceInfo | undefined> {
    return this.read<RuntimeGadgetSourceInfo>({ operation: "readGadgetSource", root, id, inspect: true });
  }

  async createGadgetFiles(create: RuntimeGadgetCreateFiles): Promise<RuntimeGadgetFileReply | undefined> {
    const request = { operation: "createGadgetFiles", create };
    const result = await this.read<RuntimeGadgetFileReply>(request, "database", false, 30_000);
    if (result !== undefined) return result;
    await this.stopping;
    return this.read<RuntimeGadgetFileReply>(request, "database", false, 30_000);
  }

  async exportGadgetFiles(input: RuntimeGadgetExportFiles): Promise<RuntimeGadgetFileReply | undefined> {
    return this.read<RuntimeGadgetFileReply>({ operation: "exportGadgetFiles", export: input }, "database", false, 30_000);
  }

  async saveGadgetSource(save: RuntimeGadgetSourceSave): Promise<RuntimeGadgetSourceSaved | undefined> {
    const request = { operation: "saveGadgetSource", save };
    const result = await this.read<RuntimeGadgetSourceSaved>(request, "database", false, 30_000);
    if (result !== undefined) return result;
    await this.stopping;
    return this.read<RuntimeGadgetSourceSaved>(request, "database", false, 30_000);
  }

  async reconcileGadgetStorage(root: string): Promise<string[] | undefined> {
    const failures = await this.read<string[]>({ operation: "reconcileGadgetStorage", root });
    if (failures === undefined) await this.stopping;
    return failures;
  }

  supportsManagedStorage(): Promise<boolean> {
    this.managedStorageCapability ??= this.read<boolean>({ operation: "managedStorageSupported" })
      .then(supported => supported === true);
    return this.managedStorageCapability;
  }

  async removeUnregisteredGadget(root: string, id: string): Promise<boolean | "needsHost" | undefined> {
    if (!await this.supportsManagedStorage()) return "needsHost";
    return this.read<boolean>({ operation: "removeGadgetFiles", root, id }, "database", false, 30_000);
  }

  async reconcileBlueprintStorage(root: string): Promise<string[] | "needsHost" | undefined> {
    if (!await this.supportsManagedStorage()) return "needsHost";
    return this.read<string[]>({ operation: "reconcileBlueprintStorage", root }, "database", false, 30_000);
  }

  async writeWorkbench(operationId: string, mutation: RuntimeWorkbenchMutation): Promise<RuntimeWorkbenchWriteStatus | "needsHost" | undefined> {
    this.workbenchWriteCapability ??= this.read<boolean>({
      operation: "workbenchData", query: { kind: "writesSupported" },
    }).then(supported => supported === true);
    if (!await this.workbenchWriteCapability) return "needsHost";
    const result = await this.read<RuntimeWorkbenchWriteStatus>({ operation: "writeWorkbench", operationId, mutation });
    if (result === undefined) await this.stopping;
    if (result === "changed" && !this.workbenchWriterReady) {
      this.workbenchWriterReady = true;
      console.info("[RuntimeAudit] Rust workbench writer ready");
    }
    return result;
  }

  async openGadgetState(path: string): Promise<GadgetStateReply | undefined> {
    this.gadgetStateCapability ??= this.read<GadgetStateReply>({
      operation: "gadgetState", request: { kind: "supported" },
    }).then(reply => reply?.kind === "supported");
    if (!await this.gadgetStateCapability) {
      await this.stopping;
      return;
    }
    const reply = await this.runGadgetState({ kind: "open", path });
    if (reply.kind === "opened" && !this.gadgetStateReady) {
      this.gadgetStateReady = true;
      console.info("[RuntimeAudit] Rust gadget state ready");
    }
    return reply;
  }

  async instantiateBlueprint(operationId: string, instance: RuntimeBlueprintInstance): Promise<RuntimeBlueprintInstanceStatus | "needsHost" | undefined> {
    if (instance.storage && !await this.supportsManagedStorage()) return "needsHost";
    this.blueprintInstantiationCapability ??= this.read<boolean>({
      operation: "workbenchData", query: { kind: "instantiationSupported" },
    }).then(supported => supported === true);
    if (!await this.blueprintInstantiationCapability) return "needsHost";
    const status = await this.read<RuntimeBlueprintInstanceStatus>(
      { operation: "instantiateBlueprint", operationId, instance }, "database", false, instance.storage ? 30_000 : 10_000,
    );
    if (!status) await this.stopping;
    if (status?.kind === "committed" && !this.blueprintInstantiationReady) {
      this.blueprintInstantiationReady = true;
      console.info("[RuntimeAudit] Rust Blueprint instantiation ready");
    }
    return status;
  }

  supportsProjectWrites(domain: ProjectWriteDomain = "project"): Promise<boolean> {
    const cached = this.projectWriteCapabilities.get(domain);
    if (cached) return cached;
    const queries = {
      project: "writesSupported", todo: "todoWritesSupported",
      eventTodoPromotion: "eventTodoPromotionSupported", eventLibraryPromotion: "eventLibraryPromotionSupported",
      deletion: "deletionSupported", memory: "memoryWritesSupported", memoryEdits: "memoryEditsSupported",
      review: "reviewWritesSupported",
    };
    const capability = this.read<boolean>({ operation: "projectMetadata", query: { kind: queries[domain] } })
      .then(supported => supported === true);
    this.projectWriteCapabilities.set(domain, capability);
    return capability;
  }

  readProjectWithdrawal(projectId: string, memoryId?: string): Promise<ProjectWithdrawalSnapshot | undefined> {
    return this.read<ProjectWithdrawalSnapshot>({
      operation: "projectMetadata", query: { kind: "withdrawalSnapshot", projectId, memoryId },
    }, "database", false, 30_000);
  }

  async promoteProjectEventToLibrary(promotion: RuntimeProjectLibraryPromotion): Promise<ProjectLibraryPromotionReply | undefined> {
    const result = await this.read<ProjectLibraryPromotionReply>({
      operation: "promoteProjectEventToLibrary", promotion,
    }, "maintenance", false, 120_000);
    if (result === undefined) await this.stopping;
    return result;
  }

  async deleteProject(operationId: string, id: string, root: string, withdrawal: ProjectWithdrawal): Promise<ProjectDeletionResult> {
    const result = await this.read<ProjectDeletionResult>({
      operation: "deleteProject", operationId, id, root, withdrawal,
    }, "maintenance", false, 120_000);
    if (result !== undefined) return result;
    await this.stopping;
    throw new Error("项目删除失败，请重试");
  }

  async writeProject(operationId: string, mutation: ProjectMutation): Promise<ProjectWriteStatus> {
    const status = await this.read<ProjectWriteStatus>({ operation: "writeProject", operationId, mutation });
    if (!status) {
      await this.stopping;
      throw new Error("项目数据写入失败，请重试");
    }
    if (status === "changed" && !this.projectWriterReady) {
      this.projectWriterReady = true;
      console.info("[RuntimeAudit] Rust project writer ready");
    }
    return status;
  }

  accessGadgetState(path: string, canonicalPath: string, bucket: GadgetStateBucket,
    action: GadgetStateAction & { writeId: string }, authorization: GadgetStateAuthorization,
    retired: () => boolean): Promise<GadgetStateReply> {
    if (retired()) return Promise.resolve({ kind: "error", error: "STALE_WRITE" });
    // `retired` runs again when the request leaves the lane, so a write the host
    // queued before it was cancelled never reaches the worker.
    return this.read<GadgetStateReply>(
      { operation: "gadgetState", request: { kind: "access", path, canonicalPath, bucket, action, authorization } },
      "database", false, 10_000, undefined, retired,
    ).then(
      reply => reply ?? (retired() ? { kind: "error", error: "STALE_WRITE" } : { kind: "error", error: "STORAGE_UNAVAILABLE" }),
      error => error instanceof RuntimeAuditNotStartedOperationError && retired()
        ? { kind: "error", error: "STALE_WRITE" }
        : { kind: "error", error: "STORAGE_UNAVAILABLE" },
    );
  }

  /** The worker also refuses writes whose lease expired, so a blocked worker cannot commit late. */
  async revokeGadgetInvocation(generation: string, invocationId: string): Promise<boolean> {
    return await this.revokeGadgetState({ kind: "revoke", generation, invocationId }) === true;
  }

  async revokeGadgetGeneration(generation: string): Promise<boolean> {
    return await this.revokeGadgetState({ kind: "revoke", generation }) === true;
  }

  private async revokeGadgetState(request: object): Promise<boolean> {
    const { generation, invocationId } = request as { generation: string; invocationId?: string };
    // Retire queued invocations immediately as well as fencing running work in
    // Core. They must not wait for an unrelated long request just to be cancelled.
    for (const entry of [...this.queues.database]) {
      const queued = entry.request as { operation?: string; request?: { authorization?: GadgetStateAuthorization } };
      const authorization = queued.request?.authorization;
      if (queued.operation === "gadgetState" && authorization?.generation === generation
        && (invocationId === undefined || authorization.invocationId === invocationId)) {
        this.removeQueued(entry);
        this.settle(entry, "cancelled", { kind: "error", error: "STALE_WRITE" });
      }
    }
    // Revocation is a control message, never a job behind the write it must fence.
    const reply = await this.control<{ kind?: string }>({ action: "revokeGadget", generation, invocationId });
    return reply?.kind === "revoked";
  }

  private async runGadgetState(request: object): Promise<GadgetStateReply> {
    const reply = await this.read<GadgetStateReply>({ operation: "gadgetState", request });
    if (reply) return reply;
    await this.stopping;
    return { kind: "error", error: "STORAGE_UNAVAILABLE" };
  }

  async pluginCatalog<T>(query: RuntimePluginCatalogQuery): Promise<T | undefined> {
    this.pluginCatalogScanCapability ??= this.read<boolean>({ operation: "pluginCatalogScanSupported" })
      .then(supported => supported === true);
    const offThread = await this.pluginCatalogScanCapability;
    const catalog = offThread
      ? await this.read<T>({ operation: "scanPluginCatalog", query }, "scan", false, 60_000)
      : await this.read<T>({ operation: "pluginCatalog", query });
    if (catalog == null) return undefined;
    if (!this.pluginCatalogReady) {
      this.pluginCatalogReady = true;
      console.info("[RuntimeAudit] Rust plugin catalog ready");
    }
    return catalog;
  }

  async readPluginConfig(target: RuntimePluginConfigTarget): Promise<RuntimePluginConfig | undefined> {
    this.pluginConfigCapability ??= this.read<boolean>({ operation: "pluginConfigSupported" }).then(value => value === true);
    if (!await this.pluginConfigCapability) return;
    return this.read<RuntimePluginConfig>({ operation: "readPluginConfig", target }, "scan", false, 60_000);
  }

  replacePluginConfig(target: RuntimePluginConfigTarget, version: string, text: string): Promise<RuntimePluginConfig | undefined> {
    return this.read<RuntimePluginConfig>({ operation: "replacePluginConfig", target, version, text }, "scan", false, 60_000);
  }

  async installConnector(install: RuntimeConnectorInstall): Promise<RuntimeConnectorInstallReply | undefined> {
    if (!await this.connectorInstallationSupported()) return { status: "needsHost" };
    const result = await this.read<RuntimeConnectorInstallReply>({ operation: "installConnector", install }, "scan", false, 60_000);
    if (result?.status === "installed" && !this.connectorInstallerReady) {
      this.connectorInstallerReady = true;
      console.info("[RuntimeAudit] Rust connector installer ready");
    }
    return result;
  }

  async recoverConnectorInstalls(root: string): Promise<RuntimeConnectorInstallReply | undefined> {
    if (!await this.connectorInstallationSupported()) return { status: "needsHost" };
    return this.read<RuntimeConnectorInstallReply>({ operation: "recoverConnectorInstalls", root }, "scan", false, 60_000);
  }

  async maintainConnectorStorage(
    root: string, legacySkillsRoot: string, task: { kind: "startup" } | { kind: "uninstall"; id: string },
  ): Promise<RuntimeConnectorInstallReply | undefined> {
    this.connectorMaintenanceCapability ??= this.read<boolean>({ operation: "connectorMaintenanceSupported" })
      .then(value => value === true);
    if (!await this.connectorMaintenanceCapability) return { status: "needsHost" };
    return this.read<RuntimeConnectorInstallReply>({
      operation: "maintainConnectorStorage", task: { ...task, root, legacySkillsRoot },
    }, "scan", false, 60_000);
  }

  async importConnectorMarket(
    root: string, request: { kind: "directory"; source: string; id: string } | { kind: "zip"; source: string },
  ): Promise<RuntimeConnectorImportReply | undefined> {
    this.connectorMarketImportCapability ??= this.read<boolean>({ operation: "connectorMarketImportSupported" })
      .then(value => value === true);
    if (!await this.connectorMarketImportCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeConnectorImportReply>({
      operation: "importConnectorMarket", request: { ...request, root },
    }, "scan", false, 60_000);
    if (result?.status === "imported" && !this.connectorMarketImportReady) {
      this.connectorMarketImportReady = true;
      console.info("[RuntimeAudit] Rust connector market import ready");
    }
    return result;
  }

  async mutateConnectorMarket(action: RuntimeConnectorMarketAction): Promise<RuntimeConnectorMarketReply | undefined> {
    this.connectorMarketMutationCapability ??= this.read<boolean>({ operation: "connectorMarketMutationSupported" })
      .then(value => value === true);
    if (!await this.connectorMarketMutationCapability) return { status: "needsHost" };
    const result = await this.read<RuntimeConnectorMarketReply>({ operation: "mutateConnectorMarket", action }, "scan", false, 60_000);
    if ((result?.status === "deleted" || result?.status === "updated") && !this.connectorMarketMutationReady) {
      this.connectorMarketMutationReady = true;
      console.info("[RuntimeAudit] Rust connector market mutations ready");
    }
    return result;
  }

  private connectorInstallationSupported(): Promise<boolean> {
    return this.connectorInstallationCapability ??= this.read<boolean>({ operation: "connectorInstallationSupported" })
      .then(value => value === true);
  }

  async compactSnapshots(): Promise<number> {
    const batchSize = 16;
    let total = 0;
    while (!this.closed) {
      const migrated = await this.read<number>({ operation: "compactSnapshots", limit: batchSize });
      if (migrated === undefined) break;
      total += migrated;
      if (migrated < batchSize) break;
      await delay(100, undefined, { ref: false });
    }
    return total;
  }

  async usageReport(report: RuntimeUsageReport, coverage: boolean): Promise<UsageReportResult | undefined> {
    const result = await this.read<UsageReportResult>({ operation: "usageReport", report, coverage });
    if (result !== undefined && !this.usageReaderReady) {
      this.usageReaderReady = true;
      console.info("[RuntimeAudit] Rust usage reports ready");
    }
    return result;
  }

  async usageCsv(since: number, coverage: boolean): Promise<string | undefined> {
    if (!Number.isSafeInteger(since)) return undefined;
    const result = await this.read<string>({ operation: "usageCsv", since, coverage });
    if (typeof result !== "string") return undefined;
    if (!this.usageCsvReady) {
      this.usageCsvReady = true;
      console.info("[RuntimeAudit] Rust usage CSV ready");
    }
    return result;
  }

  usageSessionFiles(): Promise<Array<{ session_file: string }> | undefined> {
    return this.read({ operation: "usageSessionFiles" });
  }

  async usageHistory(job: RuntimeUsageJob): Promise<number | "changed" | undefined> {
    const result = await this.read<number | "changed">({ operation: "usageHistory", job });
    if (result === "changed") return result;
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
      await this.stopping;
      return undefined;
    }
    if (job.kind === "live" && !this.liveUsageReady && result > 0) {
      this.liveUsageReady = true;
      console.info("[RuntimeAudit] Rust live usage writer ready");
    }
    if ((job.kind === "session" || job.kind === "subagents" || job.kind === "subagentBatch") && !this.usageHistoryReady && result > 0) {
      this.usageHistoryReady = true;
      console.info("[RuntimeAudit] Rust usage history writer ready");
    }
    return result;
  }

  async captureMemory(capture: RuntimeMemoryCapture): Promise<number | undefined> {
    const saved = await this.read<number>({ operation: "captureMemory", capture });
    if (typeof saved !== "number" || !Number.isSafeInteger(saved) || saved < 0) {
      await this.stopping;
      return undefined;
    }
    if (saved > 0 && !this.memoryCaptureReady) {
      this.memoryCaptureReady = true;
      console.info("[RuntimeAudit] Rust memory capture ready");
    }
    return saved;
  }

  async mutateSnapshot(writeId: string, mutation: RuntimeSnapshotMutation): Promise<number | undefined> {
    const count = await this.read<number>({ operation: "mutateSnapshot", writeId, mutation });
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
      await this.stopping;
      return undefined;
    }
    if (!this.snapshotWriterReady) {
      this.snapshotWriterReady = true;
      console.info("[RuntimeAudit] Rust snapshot writer ready");
    }
    return count;
  }

  snapshotReceipt(writeId: string): Promise<number | null | undefined> {
    return this.read({ operation: "snapshotReceipt", writeId });
  }

  diagnostics(taskId: string, limit?: number, offset = 0): Promise<TaskDiagnosticsDto | undefined> {
    const bound = typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.max(1, Math.min(500, Math.floor(limit))) : undefined;
    const skip = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    return this.read({ operation: "diagnostics", taskId, limit: bound, offset: skip, capturedAt: Date.now() });
  }

  async writeDiagnostics(writerId: string, sequence: number, writes: RuntimeDiagnosticWrite[]): Promise<boolean> {
    const committed = await this.read<boolean>({ operation: "writeDiagnostics", writerId, sequence, writes });
    if (committed === true && !this.diagnosticWriterReady) {
      this.diagnosticWriterReady = true;
      console.info("[RuntimeAudit] Rust diagnostics writer ready");
    }
    return committed === true;
  }

  semantic(search: RuntimeSemanticSearch): Promise<RuntimeSemanticHit[] | undefined> {
    if (!Number.isFinite(search.threshold) || search.query.length !== search.dimension
        || search.query.some(value => !Number.isFinite(value))) return Promise.resolve(undefined);
    return this.read({ ...search, operation: "semantic", query: Array.from(search.query) });
  }

  async semanticInference(model: RuntimeSemanticModel, text?: string | number[]): Promise<RuntimeSemanticEmbedding | undefined> {
    if (this.inferenceBlocked()) return undefined;
    this.inferenceCapability ??= this.read<boolean>({ operation: "nativeInferenceSupported" }).then(value => value === true);
    if (!await this.inferenceCapability) return undefined;
    return this.read({ operation: "semanticInference", request: { model, text } }, "inference");
  }

  async probeSemanticModel(probe: RuntimeSemanticModelProbe): Promise<SemanticInstallation | undefined> {
    this.modelProbeCapability ??= this.read<boolean>({ operation: "nativeModelProbeSupported" }).then(value => value === true);
    if (!await this.modelProbeCapability) return undefined;
    const status = await this.read<SemanticInstallation>({ operation: "semanticModelProbe", probe }, "inference", true);
    if (status?.status === "ready" && !this.modelProbeReady) {
      this.modelProbeReady = true;
      console.info("[RuntimeAudit] Rust semantic model verification ready");
    }
    return status;
  }

  async stageEmbedding(model: RuntimeSemanticModel, modelId: string, modelVersion: string,
    source: RuntimeEmbeddingSource): Promise<RuntimeEmbeddingStage | undefined> {
    if (this.inferenceBlocked()) return undefined;
    this.embeddingIndexCapability ??= this.read<boolean>({ operation: "nativeEmbeddingIndexSupported" })
      .then(value => value === true);
    if (!await this.embeddingIndexCapability) return undefined;
    const token = randomUUID();
    const status = await this.read<RuntimeEmbeddingStage["status"]>({
      operation: "stageEmbedding", request: { token, model, modelId, modelVersion, source },
    }, "inference");
    if (status === "staged") return { status, token };
    if (status === "current" || status === "skipped") return { status };
    return undefined;
  }

  async publishEmbeddings(tokens: string[]): Promise<RuntimeEmbeddingCounts | undefined> {
    const result = await this.read<RuntimeEmbeddingCounts>({ operation: "publishEmbeddings", tokens, at: Date.now() });
    if (!result) {
      await this.stopping;
      return undefined;
    }
    if (!this.embeddingIndexWriterReady && result.indexed > 0) {
      this.embeddingIndexWriterReady = true;
      console.info("[RuntimeAudit] Rust semantic index writer ready");
    }
    return result;
  }

  async discardEmbeddings(tokens: string[]): Promise<void> {
    if (tokens.length) await this.read<boolean>({ operation: "discardEmbeddings", tokens });
  }

  async embeddingIndex<Q extends RuntimeEmbeddingQuery>(query: Q): Promise<RuntimeEmbeddingQueryResults[Q["kind"]] | undefined> {
    this.embeddingPlannerCapability ??= this.read<boolean>({ operation: "nativeEmbeddingPlannerSupported" })
      .then(value => value === true);
    if (!await this.embeddingPlannerCapability) return undefined;
    const result = await this.read<RuntimeEmbeddingQueryResults[Q["kind"]]>({ operation: "embeddingIndex", query });
    if (result !== undefined && !this.embeddingPlannerReady) {
      this.embeddingPlannerReady = true;
      console.info("[RuntimeAudit] Rust semantic index planner ready");
    }
    return result;
  }

  memoryLexical(search: RuntimeMemoryLexicalSearch): Promise<RuntimeMemoryLexicalCandidates | undefined> {
    // The bundled ICU tables follow Unicode 17. Use the host tables if Electron's version changes.
    if (process.versions.unicode !== "17.0") return Promise.resolve(undefined);
    return this.read({
      ...search, operation: "memoryLexical", compact: utf16Units(search.compact),
      terms: search.terms.map(utf16Units), ftsQuery: search.ftsQuery === null ? null : utf16Units(search.ftsQuery),
    });
  }

  memoryLexicalScores(scoring: RuntimeMemoryLexicalScoring): Promise<Array<{ id: string; similarity: number }> | undefined> {
    if (process.versions.unicode !== "17.0") return Promise.resolve(undefined);
    return this.read({
      ...scoring, operation: "memoryLexicalScores", compact: utf16Units(scoring.compact),
    });
  }

  memoryBaselines(queries: Array<{
    scope: { sql: string; args: string[] };
    kinds?: string[];
    limit: number;
  }>): Promise<MemoryBaselineCandidate[][] | undefined> {
    return this.read({ operation: "memoryBaselines", queries });
  }

  async stageLibraryText(input: { path: string; stagingPath: string; expectedSize: number; chunkSize: number; overlap: number;
    copyTo?: string; refuseMarkdownLinks?: boolean }) {
    const result = await this.read<{ status: "ready"; contentHash: string; chunkCount: number } | { status: "needsLinkRewrite" }>({
      ...input, operation: "libraryText",
    });
    if (!result) await this.stopping;
    return result?.status === "ready" ? result : undefined;
  }

  async publishLibraryIndex(publication: RuntimeLibraryIndexPublication): Promise<RuntimeLibraryIndexStatus | undefined> {
    return this.writeLibraryIndex({ operation: "publishLibraryIndex", publication });
  }

  async publishLibraryDocument(publication: RuntimeLibraryDocumentPublication): Promise<RuntimeLibraryIndexStatus | undefined> {
    return this.writeLibraryIndex({ operation: "publishLibraryDocument", publication });
  }

  private async writeLibraryIndex(request: object): Promise<RuntimeLibraryIndexStatus | undefined> {
    const status = await this.read<RuntimeLibraryIndexStatus>(request);
    if (status === "indexed" && !this.libraryIndexWriterReady) {
      this.libraryIndexWriterReady = true;
      console.info("[RuntimeAudit] Rust library index writer ready");
    }
    if (status === "indexed" || status === "skipped" || status === "sourceChanged") return status;
    await this.stopping;
    return undefined;
  }

  async openDurable(path: string, expectedIncarnation?: string): Promise<RuntimeAuditDurableSnapshot | undefined> {
    if (this.closed || !this.executable || !this.dbPath || this.dbPath === ":memory:") return undefined;
    const owner = await this.obtainSession();
    if (!owner) return undefined;
    // Both forms are part of the current protocol: the greeting avoids making a
    // history read wait for a database capability reply on a busy worker.
    owner.historySupport ??= Promise.race([
      owner.historyReady,
      this.read<boolean>({ operation: "historyLaneSupported" }, "database", false, 10_000, owner).then(value => value === true),
    ]);
    const separate = await owner.historySupport;
    if (!separate || owner !== this.session) return undefined;
    const session = randomUUID();
    const request = <T>(action: { action: string; [key: string]: unknown }) => this.historyRequest<T>(owner, session, action);
    if (await request<boolean>({ action: "open", path: resolve(path), expectedIncarnation }) !== true) return undefined;
    let closing: Promise<void> | undefined;
    return {
      select: (sql, parameters, first) => request({ action: "select", sql, parameters, first }),
      head: (conversationId, maxTokens) => request({ action: "head", conversationId, maxTokens }),
      questions: (conversationId, beforeEntryId) => request({ action: "questions", conversationId, beforeEntryId }),
      close: () => closing ??= (async () => {
        if (owner === this.session && await request<boolean>({ action: "close" }) !== true) this.stop(owner, "closed");
        // A timed-out close cannot release the host read lease while Rust still owns the SQLite view.
        if (owner !== this.session) await owner.closed;
      })(),
    };
  }

  private historyRequest<T>(owner: AuditSession, session: string, action: { action: string; [key: string]: unknown }): Promise<T | undefined> {
    // Up to sixteen open snapshots may all need to close behind a full read queue.
    const limit = action.action === "close" ? 48 : 32;
    if (this.closed || this.session !== owner || owner.history.size >= limit) return Promise.resolve(undefined);
    const requestId = randomUUID();
    return new Promise(resolve => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        resolve(undefined);
        void this.control({ action: "cancel", targetRequestId: requestId }, owner);
      }, 10_000).unref();
      // Keep timed-out slots bounded and reserved until the late reply or process exit.
      owner.history.set(requestId, data => {
        clearTimeout(timer);
        if (expired && action.action === "open" && data === true) {
          void this.historyRequest(owner, session, { action: "close" });
        }
        resolve(data as T | undefined);
      });
      owner.child.stdin.write(JSON.stringify({ operation: "historyRead", session, requestId,
        deadlineAt: Date.now() + 10_000, lane: "history", ...action }) + "\n", error => {
        if (error) this.stop(owner);
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    for (const lane of AUDIT_LANES) {
      for (const entry of this.queues[lane].splice(0)) this.settle(entry, "closed");
    }
    if (this.session) this.stop(this.session, "closed");
    await this.connecting;
    await this.stopping;
  }

  private read<T>(
    request: object,
    lane: AuditLane = "database",
    allowAfterInferenceFailure = false,
    timeoutMs = lane === "inference" ? 120_000 : 10_000,
    expectedSession?: AuditSession,
    retired?: () => boolean,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    if (!this.executable || !this.dbPath || this.dbPath === ":memory:") return Promise.resolve(undefined);
    const enqueuedAt = Date.now();
    const operation = typeof (request as { operation?: unknown }).operation === "string"
      ? (request as { operation: string }).operation : "unknown";
    const id = randomUUID();
    const mutation = mutatesPersistentState(request, lane);
    const capability = isCapabilityRequest(request);
    const notStarted = (reason: string): Promise<undefined> => {
      if (capability) queueMicrotask(() => this.clearCapabilities());
      return mutation || capability
        ? Promise.reject(new RuntimeAuditNotStartedOperationError(id, operation, reason))
        : Promise.resolve(undefined);
    };
    if (this.closed || signal?.aborted) return notStarted(this.closed ? "closed" : "cancelled");
    // Include abandoned in-flight work in admission control. Timing out its caller
    // does not make the worker's queue shorter or authorize another write.
    if (this.queues[lane].length + this.executing[lane].size >= LANE_QUEUE_LIMIT) {
      this.recordOutcome(lane, operation, "overloaded", { enqueuedAt, finishedAt: enqueuedAt });
      return notStarted("overloaded");
    }
    return new Promise<T | undefined>((resolve, reject) => {
      const entry: AuditRequest = {
        id, request, operation, lane, enqueuedAt, deadline: enqueuedAt + Math.max(0, timeoutMs),
        expectedSession, retired, signal, allowAfterInferenceFailure,
        mutation, capability, settled: false,
        resolve: value => resolve(value as T | undefined), reject,
      };
      this.laneQueued[lane] += 1;
      this.queues[lane].push(entry);
      // This timer belongs to the caller and exists while it is still QUEUED.
      // A short request behind a long one therefore returns at its own deadline.
      entry.timer = setTimeout(() => this.expire(entry), Math.max(0, entry.deadline - Date.now())).unref();
      if (signal) {
        entry.abort = () => {
          if (entry.startedAt === undefined) {
            this.removeQueued(entry);
            this.settle(entry, "cancelled");
          } else {
            this.settle(entry, "cancelled", undefined, true);
            void this.cancelOperation(entry.id).catch(() => undefined);
          }
        };
        signal.addEventListener("abort", entry.abort, { once: true });
      }
      void this.pump(lane);
    });
  }

  private removeQueued(entry: AuditRequest): void {
    const queue = this.queues[entry.lane];
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  }

  private settle(entry: AuditRequest, outcome: RuntimeAuditOutcome, value?: unknown, uncertain = false, knownFailure = false): void {
    if (entry.settled) return;
    if (entry.capability && outcome === "completed" && typeof value !== "boolean"
      && !(entry.operation === "gadgetState" && (value as { kind?: string } | null)?.kind === "supported")) outcome = "failed";
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
    this.laneQueued[entry.lane] -= 1;
    this.recordOutcome(entry.lane, entry.operation, outcome, {
      enqueuedAt: entry.enqueuedAt, startedAt: entry.startedAt, finishedAt: Date.now(),
    });
    if (uncertain && entry.mutation) {
      this.unconfirmed.set(entry.id, { operation: entry.operation, lane: entry.lane });
      // Receipts remain queryable in Core; the UI diagnostic cache itself is bounded.
      if (this.unconfirmed.size > 1_024) this.unconfirmed.delete(this.unconfirmed.keys().next().value!);
      entry.reject(new RuntimeAuditUnknownOperationError(entry.id, entry.operation));
    } else if (entry.mutation && knownFailure) {
      entry.reject(new RuntimeAuditOperationFailedError(entry.id, entry.operation));
    } else if ((entry.mutation || entry.capability) && outcome !== "completed" && value === undefined) {
      if (entry.capability) this.clearCapabilities();
      entry.reject(new RuntimeAuditNotStartedOperationError(entry.id, entry.operation, outcome));
    } else if (entry.capability && outcome === "failed") {
      this.clearCapabilities();
      entry.reject(new RuntimeAuditNotStartedOperationError(entry.id, entry.operation, "invalid-capability-reply"));
    } else entry.resolve(value);
  }

  private expire(entry: AuditRequest): void {
    if (entry.settled) return;
    if (entry.startedAt === undefined) {
      this.removeQueued(entry);
      this.settle(entry, "expired-before-dispatch");
      return;
    }
    this.settle(entry, "timeout", undefined, true);
    // Control frames bypass all business queues. Keep the worker slot until a
    // terminal receipt arrives: cancellation requested is not cancellation done.
    void this.cancelOperation(entry.id).catch(() => undefined);
  }

  private async pump(lane: AuditLane): Promise<void> {
    if (this.closed || this.pumping.has(lane)) return;
    if (this.executing[lane].size > 0) {
      const hasDetached = [...this.executing[lane].values()].some(e => e.session !== this.session);
      if (hasDetached) this.scheduleRecovery();
    }
    this.pumping.add(lane);
    try {
      while (!this.closed && this.queues[lane].length) {
        const head = this.queues[lane][0]!;
        if (head.settled) { this.removeQueued(head); continue; }
        if (Date.now() >= head.deadline) { this.expire(head); continue; }
        if (head.expectedSession && this.session !== head.expectedSession) {
          this.removeQueued(head); this.settle(head, "retired"); continue;
        }
        if (head.retired?.()) {
          this.removeQueued(head); this.settle(head, "retired"); continue;
        }
        if (lane === "inference" && !head.allowAfterInferenceFailure && this.inferenceBlocked()) {
          this.removeQueued(head); this.settle(head, "blocked"); continue;
        }
        const session = await this.obtainSession();
        if (head.settled || this.closed) continue;
        if (!session) {
          for (const waiting of this.queues[lane].splice(0)) this.settle(waiting, "failed");
          break;
        }

        const entry = this.nextDispatchableEntry(lane, session);
        if (!entry) break;
        if (Date.now() >= entry.deadline) { this.expire(entry); continue; }
        if ((entry.expectedSession && entry.expectedSession !== session) || entry.retired?.()) {
          this.removeQueued(entry); this.settle(entry, "retired"); continue;
        }
        this.removeQueued(entry);
        entry.startedAt = Date.now();
        entry.session = session;
        this.executing[lane].set(entry.id, entry);
        if (this.executing[lane].size > this.maxInFlight[lane]) {
          this.maxInFlight[lane] = this.executing[lane].size;
        }
        session.pending.set(entry.id, entry);
        try {
          session.child.stdin.write(JSON.stringify({
            ...entry.request, requestId: entry.id, deadlineAt: entry.deadline, lane,
          }) + "\n", error => { if (error) this.stop(session, "exit"); });
        } catch { this.stop(session, "exit"); }
      }
    } finally { this.pumping.delete(lane); }
  }

  private nextDispatchableEntry(lane: AuditLane, session: AuditSession): AuditRequest | undefined {
    const active = this.executing[lane];
    const readLimit = lane === "database"
      ? session.parallelReadLimit
      : lane === "scan"
        ? session.parallelWorkspaceIoLimit
        : 1;
    const defaultWriteLimit = this.options.coreDataDirectory && this.options.maxConcurrentReads !== 1 ? 4 : 1;
    const writeLimit = lane === "database"
      ? Math.max(1, Math.min(4, Math.trunc(this.options.maxConcurrentWrites ?? defaultWriteLimit)))
      : 1;

    // Preserve strict single-slot behavior when concurrency is pinned to 1 or unadvertised.
    if (readLimit <= 1 && writeLimit <= 1) {
      return active.size === 0 ? this.queues[lane][0] : undefined;
    }

    let activeReads = 0;
    let activeWrites = 0;
    let hasAbandonedMutation = false;
    for (const item of active.values()) {
      if (item.mutation) {
        activeWrites += 1;
        if (item.settled) hasAbandonedMutation = true;
      } else {
        activeReads += 1;
      }
    }
    if (active.size >= readLimit + writeLimit) return undefined;

    for (const candidate of this.queues[lane]) {
      if (candidate.settled || Date.now() >= candidate.deadline || candidate.retired?.()
        || (candidate.expectedSession && candidate.expectedSession !== session)) {
        return candidate;
      }
      if (candidate.mutation) {
        if (!hasAbandonedMutation && activeWrites < writeLimit) return candidate;
      } else if (activeReads < readLimit) {
        return candidate;
      }
    }
    return undefined;
  }

  private releaseExecution(entry: AuditRequest): void {
    this.executing[entry.lane].delete(entry.id);
    entry.session?.pending.delete(entry.id);
    void this.pump(entry.lane);
  }

  private applyReceipt(receipt: RuntimeOperationReceipt): void {
    if (receipt.state === "queued" || receipt.state === "running") return;
    let entry: AuditRequest | undefined;
    for (const lane of AUDIT_LANES) {
      const hit = this.executing[lane].get(receipt.requestId);
      if (hit) {
        entry = hit;
        break;
      }
    }
    if (receipt.state !== "unknown") this.unconfirmed.delete(receipt.requestId);
    if (!entry) return;
    if (receipt.state === "committed") {
      // The durable receipt may omit a large result. Commitment is known, but
      // returning undefined as normal success could activate a caller's host
      // fallback and repeat the write. Preserve an explicit unknown result.
      if (entry.mutation && receipt.result === undefined) this.settle(entry, "failed", undefined, true);
      else this.settle(entry, "completed", receipt.result);
    }
    else if (receipt.state === "cancelled" || receipt.state === "expired") this.settle(entry, "cancelled");
    else this.settle(entry, "failed", undefined, receipt.state === "unknown",
      receipt.state === "failed" && receipt.neverStarted !== true);
    this.releaseExecution(entry);
  }

  private scheduleRecovery(): void {
    if (this.closed || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void (async () => {
        const detached: AuditRequest[] = [];
        for (const lane of AUDIT_LANES) {
          for (const entry of this.executing[lane].values()) {
            if (entry.session !== this.session) detached.push(entry);
          }
        }
        for (const entry of detached) await this.queryOperation(entry.id).catch(() => undefined);
        if (AUDIT_LANES.some(lane => [...this.executing[lane].values()]
          .some(entry => entry.session !== undefined && entry.session !== this.session))) {
          this.scheduleRecovery();
        }
      })();
    }, 500).unref();
  }

  private async control<T>(request: object, owner?: AuditSession): Promise<T | undefined> {
    if (this.closed) return undefined;
    const session = owner ?? await this.obtainSession();
    if (!session || session !== this.session) return undefined;
    const action = (request as { action?: string }).action;
    // Status polling cannot occupy every slot needed by cancellation/revocation.
    if (action === "status" && session.controls.size >= CONTROL_QUEUE_LIMIT - 8) return undefined;
    if (session.controls.size >= CONTROL_QUEUE_LIMIT) {
      const expendable = [...session.controls].find(([, pending]) => pending.action === "status");
      if (!expendable) {
        // Losing a revocation is not an acceptable overload policy. Retiring
        // the connection fences its Gadget generations in Core (and terminates
        // a direct fixture worker) instead of silently dropping control.
        this.stop(session, "control-overload");
        return undefined;
      }
      session.controls.delete(expendable[0]);
      expendable[1].resolve(undefined);
    }
    const requestId = randomUUID();
    const deadlineAt = Date.now() + 5_000;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        session.controls.delete(requestId);
        resolve(undefined);
      }, 5_000).unref();
      session.controls.set(requestId, {
        timer, action,
        resolve: value => { clearTimeout(timer); resolve(value as T | undefined); },
      });
      try {
        session.child.stdin.write(JSON.stringify({ ...request, operation: "control", requestId, deadlineAt }) + "\n",
          error => { if (error) this.stop(session, "exit"); });
      } catch { this.stop(session, "exit"); }
    });
  }

  /**
   * A caller is about to redo an idempotent write on the host because the worker's answer was
   * unknown. The replay converges, but a silent fallback hides a whole class of degradation.
   */
  noteFallback(domain: string): void {
    this.fallbacks.set(domain, (this.fallbacks.get(domain) ?? 0) + 1);
    const now = Date.now();
    if (now - this.fallbackWarnedAt >= 5_000) {
      this.fallbackWarnedAt = now;
      console.warn(`[RuntimeAudit] host fallback for ${domain} after an unconfirmed worker write`);
    }
  }

  /** How often each domain had to recover on the host. */
  fallbackTotals(): Record<string, number> {
    return Object.fromEntries(this.fallbacks);
  }

  /** Queue depth, terminal outcomes and the last few requests, per lane. */
  laneDiagnostics(): { queued: Record<AuditLane, number>; waiting: Record<AuditLane, number>;
    inFlight: Record<AuditLane, number>; maxInFlight: Record<AuditLane, number>;
    unconfirmed: Array<{ requestId: string; operation: string; lane: AuditLane }>;
    totals: Record<AuditLane, RuntimeAuditLaneTotals>; recent: RuntimeAuditLaneRecord[] } {
    return {
      queued: { ...this.laneQueued },
      waiting: Object.fromEntries(AUDIT_LANES.map(lane => [lane, this.queues[lane].length])) as Record<AuditLane, number>,
      inFlight: Object.fromEntries(AUDIT_LANES.map(lane => [lane, this.executing[lane].size])) as Record<AuditLane, number>,
      maxInFlight: { ...this.maxInFlight },
      unconfirmed: [...this.unconfirmed].map(([requestId, value]) => ({ requestId, ...value })),
      totals: {
        database: { ...this.laneTotals.database }, inference: { ...this.laneTotals.inference },
        maintenance: { ...this.laneTotals.maintenance }, scan: { ...this.laneTotals.scan },
      },
      recent: this.laneRecords.map(entry => ({ ...entry })),
    };
  }

  private recordOutcome(lane: AuditLane, operation: string, outcome: RuntimeAuditOutcome, times: {
    enqueuedAt: number; startedAt?: number; finishedAt: number;
  }): void {
    const totals = this.laneTotals[lane];
    const counter: Record<RuntimeAuditOutcome, keyof RuntimeAuditLaneTotals | undefined> = {
      completed: "completed", failed: "failed", timeout: "timedOut",
      "expired-before-dispatch": "expiredBeforeDispatch", overloaded: "overloaded",
      "slot-busy": "slotBusy", retired: "retired", blocked: "blocked", cancelled: "cancelled", closed: undefined,
    };
    const key = counter[outcome];
    if (key) totals[key] += 1;
    const waitedMs = Math.max(0, (times.startedAt ?? times.finishedAt) - times.enqueuedAt);
    const ranMs = times.startedAt === undefined ? 0 : Math.max(0, times.finishedAt - times.startedAt);
    this.laneRecords.push({
      ...totals, lane, operation, outcome,
      enqueuedAt: times.enqueuedAt, startedAt: times.startedAt, finishedAt: times.finishedAt, waitedMs, ranMs,
    });
    if (this.laneRecords.length > 64) this.laneRecords.shift();
    // A stuck lane can expire a whole backlog; report it once per window.
    if (outcome === "expired-before-dispatch" || outcome === "overloaded" || outcome === "slot-busy") {
      const now = Date.now();
      if (now - this.laneWarnedAt[lane] >= 5_000) {
        this.laneWarnedAt[lane] = now;
        console.warn(`[RuntimeAudit] ${lane} ${operation} ${outcome} after ${waitedMs}ms wait (further drops are counted, not logged)`);
      }
    }
  }

  private obtainSession(): Promise<AuditSession | undefined> {
    if (this.closed || !this.executable || !this.dbPath || this.dbPath === ":memory:") return Promise.resolve(undefined);
    if (this.session) return Promise.resolve(this.session);
    if (this.connecting) return this.connecting;
    this.connecting = this.start(this.executable).catch(() => {
      this.unavailable();
      return undefined;
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async start(executable: string): Promise<AuditSession | undefined> {
    const child: AuditTransport = this.options.coreDataDirectory
      ? await connectCoreWorker(executable, this.dbPath, {
        dataDirectory: this.options.coreDataDirectory,
        role: this.options.coreRole ?? "ui",
        clientId: this.options.coreClientId,
      })
      : spawn(executable, [this.dbPath], {
        windowsHide: true,
        env: {
          MYBUDDY_HISTORY_HANDSHAKE: "1",
          ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
          ...(process.env.TZ && { TZ: process.env.TZ }),
        },
      });
    const closed = new Promise<void>(resolve => child.once("close", resolve));
    if (this.closed) {
      child.once("error", () => undefined);
      child.kill();
      await closed;
      return undefined;
    }
    const wasBlocked = this.inferenceBlocked();
    if (!this.options.coreDataDirectory || child.generation !== this.lastCoreGeneration) this.inferenceGeneration += 1;
    this.lastCoreGeneration = child.generation;
    if (wasBlocked && !this.inferenceBlocked()) console.info("[RuntimeAudit] Rust restarted; native inference re-armed");
    let advertiseHistory!: () => void;
    const historyReady = new Promise<true>(resolve => { advertiseHistory = () => resolve(true); });
    const supervised = !!this.options.coreDataDirectory;
    const readCapOverride = this.options.maxConcurrentReads;
    const defaultReads = supervised ? Math.max(1, Math.min(16, Math.trunc(readCapOverride ?? 4))) : 1;
    const defaultWs = supervised && readCapOverride !== 1 ? 2 : 1;
    const session: AuditSession = {
      child, closed, historyReady, advertiseHistory, pending: new Map(), controls: new Map(),
      history: new Map(), chunks: [], bytes: 0, dotsFileWatches: new Map(),
      supervised,
      parallelReadLimit: defaultReads,
      parallelWorkspaceIoLimit: defaultWs,
    };
    this.session = session;
    child.on("error", () => this.stop(session, "exit"));
    child.on("exit", () => this.stop(session, "exit"));
    child.on("close", () => this.stop(session, "exit"));
    child.stdin.on("error", () => this.stop(session, "exit"));
    child.stdout.on("data", (chunk: Buffer) => this.receive(session, chunk));
    child.stderr.resume();
    return session;
  }

  private receive(session: AuditSession, chunk: Buffer): void {
    let offset = 0;
    while (this.session === session && offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, newline < 0 ? chunk.length : newline + 1);
      session.bytes += part.length;
      if (session.bytes > 32 * 1024 * 1024) { this.stop(session, "protocol"); return; }
      session.chunks.push(part);
      if (newline < 0) return;
      const line = Buffer.concat(session.chunks, session.bytes).toString("utf8");
      session.chunks = [];
      session.bytes = 0;
      this.receiveReply(session, line);
      offset = newline + 1;
    }
  }

  private receiveReply(session: AuditSession, line: string): void {
    let reply: {
      historyRequestId?: string; historyLane?: boolean; historyReady?: boolean;
      parallelReads?: number; parallelWorkspaceIo?: number;
      status?: string; data?: unknown; inference?: boolean; scan?: boolean; maintenance?: boolean; replyId?: unknown;
      neverStarted?: boolean; errorCode?: string;
      dotsFileWatches?: Array<{ id: string; lost: boolean }>;
    };
    try { reply = JSON.parse(line); } catch { this.stop(session, "protocol"); return; }
    if (reply.historyReady === true) {
      if (typeof reply.parallelReads === "number" && Number.isFinite(reply.parallelReads)) {
        const cap = this.options.maxConcurrentReads;
        session.parallelReadLimit = Math.max(1, Math.min(16, Math.trunc(cap ?? reply.parallelReads)));
      }
      if (typeof reply.parallelWorkspaceIo === "number" && Number.isFinite(reply.parallelWorkspaceIo)) {
        session.parallelWorkspaceIoLimit = this.options.maxConcurrentReads === 1
          ? 1
          : Math.max(1, Math.min(4, Math.trunc(reply.parallelWorkspaceIo)));
      }
      session.advertiseHistory();
      session.historySupport ??= session.historyReady;
      return;
    }
    const historyId = typeof reply.replyId === "string" && session.history.has(reply.replyId)
      ? reply.replyId : reply.historyRequestId;
    if (historyId !== undefined) {
      if (reply.replyId !== historyId) { this.stop(session, "protocol"); return; }
      const settle = session.history.get(historyId);
      if (!settle) return;
      session.history.delete(historyId);
      settle(reply.status === "ok" ? reply.data : undefined);
      return;
    }
    if (reply.historyLane === true) session.historySupport ??= Promise.resolve(true);
    if (reply.dotsFileWatches) {
      for (const notice of reply.dotsFileWatches) {
        const watch = session.dotsFileWatches.get(notice.id);
        if (notice.lost) watch?.lost();
        else watch?.changed();
      }
      return;
    }
    if (typeof reply.replyId !== "string") { this.stop(session, "protocol"); return; }
    const control = session.controls.get(reply.replyId);
    if (control) {
      session.controls.delete(reply.replyId);
      control.resolve(reply.status === "ok" ? reply.data : undefined);
      return;
    }
    const entry = session.pending.get(reply.replyId);
    // A terminal reply may follow its status receipt. Both carry the same id;
    // neither is allowed to consume a newer operation's slot.
    if (!entry) return;
    const succeeded = reply.status === "ok" && reply.data !== undefined;
    if (succeeded) {
      if (this.state !== "ready") console.info("[RuntimeAudit] Rust reader ready");
      this.state = "ready";
      if (entry.lane === "inference") this.inferenceFailure = undefined;
      this.unconfirmed.delete(entry.id);
      this.settle(entry, "completed", reply.data);
    } else if (reply.status === "cancelled" || reply.status === "expired") {
      this.unconfirmed.delete(entry.id);
      this.settle(entry, "cancelled");
    } else {
      if (entry.lane === "database") this.unavailable();
      if (entry.lane === "inference") this.recordInferenceFailure();
      const knownFailure = reply.errorCode === "FAILED" && reply.neverStarted !== true;
      this.settle(entry, "failed", undefined, reply.neverStarted !== true && !knownFailure, knownFailure);
    }
    this.releaseExecution(entry);
  }

  private clearCapabilities(): void {
    this.inferenceCapability = undefined;
    this.embeddingIndexCapability = undefined;
    this.embeddingPlannerCapability = undefined;
    this.libraryNoteWriteCapability = undefined;
    this.libraryNoteRestoreCapability = undefined;
    this.libraryTextSaveCapability = undefined;
    this.libraryDeleteCapability = undefined;
    this.libraryBackupCapability = undefined;
    this.libraryRestoreCapability = undefined;
    this.workbenchWriteCapability = undefined;
    this.blueprintInstantiationCapability = undefined;
    this.managedStorageCapability = undefined;
    this.managedArtifactFilesCapability = undefined;
    this.artifactCleanupCapability = undefined;
    this.projectWriteCapabilities.clear();
    this.gadgetStateCapability = undefined;
    this.gadgetFileMutationsCapability = undefined;
    this.modelProbeCapability = undefined;
    this.pluginCatalogScanCapability = undefined;
    this.pluginConfigCapability = undefined;
    this.connectorInstallationCapability = undefined;
    this.connectorMaintenanceCapability = undefined;
    this.connectorMarketImportCapability = undefined;
    this.connectorMarketMutationCapability = undefined;
    this.workspaceMoveCapability = undefined;
    this.sidebarArchiveCapability = undefined;
    this.workspaceLabelsCapability = undefined;
    this.workspacePersistenceCapability = undefined;
    this.workspaceDeleteCapability = undefined;
    this.workspaceBindingCapability = undefined;
    this.projectPostsCapability = undefined;
    this.projectEventDataCapability = undefined;
    this.answerRoutingDataCapability = undefined;
    this.projectPinsCapability = undefined;
    this.workQueueCapability = undefined;
    this.workGraphCapability = undefined;
    this.workGraphIntegrityCapability = undefined;
    this.fileBackupListCapability = undefined;
    this.fileBackupRestoreCapability = undefined;
    this.subagentSettingsCapability = undefined;
    this.materialRetrievalCapability = undefined;
    this.taskTrashRestoreCapability = undefined;
    this.soulProfileCapability = undefined;
    this.durableWorkspaceMoveCapability = undefined;
    this.taskExpertBindingCapability = undefined;
    this.memoryOrganizationProgressCapability = undefined;
    this.workGraphRepairCapability = undefined;
    this.durableTaskProjectionCapability = undefined;
    this.memoryRecordWriteCapability = undefined;
    this.notificationDataCapability = undefined;
    this.gatewayMessageWriteCapability = undefined;
    this.taskRecordsCapability = undefined;
    this.taskContextUsageCapability = undefined;
    this.executionFailuresCapability = undefined;
    this.taskTrashCapability = undefined;
    this.taskTrashPurgeCapability = undefined;
    this.workspaceScanCapability = undefined;
    this.dotsFileRevisionCapability = undefined;
    this.dotsFileWatchCapability = undefined;
    this.workspaceArtifactStreamCapability = undefined;
    this.managedArtifactImageStreamCapability = undefined;
    this.remoteArtifactImageCapability = undefined;
  }

  private stop(session: AuditSession, cause: AuditStopCause = "exit"): void {
    if (this.session !== session) return;
    let hasInference = false;
    let hasOtherPending = false;
    let hasDatabasePending = false;
    for (const pending of session.pending.values()) {
      if (pending.lane === "inference") hasInference = true;
      else hasOtherPending = true;
      if (pending.lane === "database") hasDatabasePending = true;
    }
    const inferenceWasOnlyJob = hasInference && !hasOtherPending && session.history.size === 0;
    this.session = undefined;
    for (const settle of session.history.values()) settle(undefined);
    session.history.clear();
    this.clearCapabilities();
    // A socket loss or a concurrent database failure is not evidence that the
    // model crashed. Only an isolated direct-worker inference death is attributed.
    if (!session.supervised && cause === "exit" && inferenceWasOnlyJob) {
      this.recordInferenceFailure();
    }
    this.stopping = session.closed;
    if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill();
    for (const pending of [...session.pending.values()]) {
      this.settle(pending, cause === "closed" ? "closed" : "retired", undefined, true);
      if (!session.supervised || this.closed) this.releaseExecution(pending);
    }
    for (const control of session.controls.values()) control.resolve(undefined);
    session.controls.clear();
    if (hasDatabasePending) this.unavailable();
    session.pending.clear();
    if (!this.closed && session.supervised) this.scheduleRecovery();
    const watches = [...session.dotsFileWatches.values()];
    session.dotsFileWatches.clear();
    for (const watch of watches) watch.lost();
  }

  private unavailable(): void {
    if (this.closed || this.state === "unavailable") return;
    this.state = "unavailable";
    console.warn("[RuntimeAudit] Rust reader unavailable");
  }

  /** Blocked inference belongs to one process generation unless failures keep repeating. */
  private inferenceBlocked(): boolean {
    const failure = this.inferenceFailure;
    return failure !== undefined &&
      (failure.streak >= INFERENCE_FAILURE_LIMIT || failure.generation >= this.inferenceGeneration);
  }

  private recordInferenceFailure(): void {
    const streak = (this.inferenceFailure?.streak ?? 0) + 1;
    this.inferenceFailure = { generation: this.inferenceGeneration, streak };
    if (streak === INFERENCE_FAILURE_LIMIT) {
      console.warn("[RuntimeAudit] Rust inference is not retried after repeated failures");
    }
  }
}

export type RuntimeTaskBoardQuery = Omit<import("../../shared/task-board").BoardQuery, "scope"> & {
  scope?: { spaceId: string | null };
  ordinary?: { taskId?: string; spaceIds?: readonly string[] | null };
  calendar: { now: number; today: number; tomorrow: number; recentFrom: number; weekFrom: number; weekUntil: number; automationFrom: number };
  waits: { id: string; token: string; message: string | null; detail: string; at: number }[];
};

export interface RuntimeTaskBoardPage<Row> {
  rows: Row[];
  total?: number;
}

export type RuntimeNoteScope = "project" | "workspace";

export interface RuntimeScopedNote {
  content: string;
  revision: number;
  updatedAt: number;
}

interface RuntimeScopedNoteSave {
  content: string;
  expectedRevision: number;
  updatedAt: number;
}

type RuntimeScopedNoteReply =
  | { status: "ok"; note: RuntimeScopedNote }
  | { status: "missing" | "archived" | "conflict" };

type RuntimeLibraryMetadataQuery =
  | { kind: "catalog"; spaceIds?: string[]; itemId?: string; owner?: LibraryOwnerScope }
  | { kind: "indexCandidates"; work: "documents" | "text" | "chunks"; after?: string; limit: number }
  | { kind: "taskScope"; taskId?: string; projectId?: string; workspaceId?: string; itemIds?: string[] }
  | { kind: "trash"; spaceIds: string[] }
  | { kind: "versions"; itemId: string }
  | { kind: "textBody"; itemId: string; root: string; maxChars?: number }
  | { kind: "versionBody"; itemId: string; version: number };

type RuntimeLibraryNoteTarget = Pick<LibraryItemDto, "id" | "spaceId">;
export type RuntimeLibraryNoteChange =
  | { kind: "metadata"; item: RuntimeLibraryNoteTarget; tags?: string[]; pinned?: boolean }
  | { kind: "move"; items: RuntimeLibraryNoteTarget[]; collectionId: string | null }
  | { kind: "trash"; items: RuntimeLibraryNoteTarget[] }
  | { kind: "restore"; items: RuntimeLibraryNoteTarget[]; root: string; chunkSize: number; overlap: number };

export interface RuntimeLibraryTextSave extends RuntimeLibraryNoteTarget {
  filename: string;
  path: string;
  root: string;
  operationId: string;
  title?: string;
  nextFilename?: string;
  expectedTitle?: string;
  expectedContentHash?: string;
  content: string;
  createdBy: string;
  updatedAt: number;
  chunkSize: number;
  overlap: number;
}

type RuntimeLibraryTextSaveResult = "saved" | "unchanged" | "conflict" | "pending" | "needsHost";

export type RuntimeLibraryDeleteTarget = { kind: "item" | "collection" | "space"; id: string };
export type RuntimeLibraryDeleteReply =
  | { status: "deleted"; itemIds: string[] }
  | { status: "scopeChanged" | "needsHost" };

type RuntimeLibraryBackupResult = "saved" | "tooLarge" | "sourceUnavailable" | "invalidMetadata" | "needsHost";

interface RuntimeLibraryRestoreInput {
  source: string;
  root: string;
  owner: LibraryOwnerScope;
  operationId: string;
  chunkSize: number;
  overlap: number;
}

export interface RuntimeLibraryRestoreReceipt {
  restored: number;
  skipped: number;
  indexedText: boolean;
  pendingExtraction: boolean;
}

type RuntimeLibraryRestoreResult =
  | { status: "needsHost" }
  | { status: "rejected"; message: string }
  | { status: "restored"; receipt: RuntimeLibraryRestoreReceipt };

type RuntimeLibraryNoteWriteReply<Row> =
  | { status: "updated"; item?: Row; indexed?: string[] }
  | { status: "scopeChanged" | "folderChanged" | "needsHost" | "sourceUnavailable" };

type RuntimeProjectMetadataQuery =
  | { kind: "writeReceipt"; operationId: string }
  | { kind: "list"; includeArchived: boolean }
  | { kind: "details"; projectId: string }
  | { kind: "contextSnapshot" | "contextWitness"; projectId: string }
  | { kind: "todos"; projectId: string }
  | { kind: "memories"; projectId: string }
  | { kind: "todo"; id: string }
  | { kind: "nextBoundary"; projectId: string; now: number }
  | { kind: "events"; projectId: string; limit: number }
  | { kind: "status"; projectId: string; now: number };

export type RuntimeArtifactMutation =
  | { kind: "register"; row: ArtifactRow }
  | { kind: "registerWorkspaceOutput"; row: ArtifactRow }
  | { kind: "refresh"; ids: string[]; at: number; messageId?: string; toolCallId?: string }
  | { kind: "remove"; id?: string; requireTrashed: boolean };

export interface RuntimeGadgetArtifactSource {
  root: string;
  id: string;
  entry: string;
  token: string;
}

export type RuntimeArtifactContent =
  | { kind: "text"; content: string }
  | ({ kind: "gadget" } & RuntimeGadgetArtifactSource);

export type RuntimeManagedArtifactWrite =
  | { status: "saved"; revision: number }
  | { status: "failed"; message: string };

type RuntimeManagedArtifactUnavailable =
  | { status: "missing" | "needsHost" }
  | { status: "failed"; message: string };

type RuntimeManagedArtifactReply =
  | { status: "content"; base64: string }
  | { status: "chunk"; base64: string; done: boolean }
  | { status: "raster" }
  | RuntimeManagedArtifactUnavailable;

type RuntimeManagedArtifactRead =
  | { status: "content"; content: string }
  | { status: "raster" }
  | RuntimeManagedArtifactUnavailable;

type RuntimeWorkspaceFilePreview =
  | { status: "text"; content: string; bytes: number; truncated: boolean }
  | { status: "imageHeader"; base64: string; bytes: number }
  | { status: "missing" }
  | { status: "failed"; message: string };

interface RuntimeWorkspaceScanQuery {
  root: string;
  kind: "tree" | "snapshot";
  maxDepth: number;
  fileLimit: number;
  excludedDirectories: string[];
  internalName: string;
  internalSuffix: string;
}

export type RuntimeWorkspaceScanNode =
  | { kind: "file"; name: string }
  | { kind: "folder"; name: string; children: RuntimeWorkspaceScanNode[] };

type RuntimeWorkspaceScan =
  | { kind: "tree"; nodes: RuntimeWorkspaceScanNode[] }
  | { kind: "snapshot"; files: Array<[string, number, number]> }
  | { kind: "needsHost" };

type RuntimeDotsFileRevision =
  | { status: "observed"; value: string }
  | { status: "rejected"; reason: "rootChanged" | "parentChanged" | "notFile" }
  | { status: "needsHost" };

type RuntimeWorkspaceArtifactOpen = { status: "opened"; bytes: number; modifiedMs: number | null };
type RuntimeWorkspaceArtifactError = { status: "missing" } | { status: "failed"; message: string };
type RuntimeWorkspaceArtifactHeader = RuntimeWorkspaceArtifactOpen | RuntimeWorkspaceArtifactError;
type RuntimeWorkspaceArtifact = (RuntimeWorkspaceArtifactOpen & { body: ReadableStream<Uint8Array> | null }) |
  RuntimeWorkspaceArtifactError;

type RuntimeManagedArtifactImageOpen = { status: "imageOpened"; mimeType: string };
type RuntimeManagedArtifactImageHeader = RuntimeManagedArtifactImageOpen | RuntimeManagedArtifactUnavailable;
type RuntimeManagedArtifactImage = (RuntimeManagedArtifactImageOpen & { body: ReadableStream<Uint8Array> | null }) |
  RuntimeManagedArtifactUnavailable;

type RuntimeRemoteArtifactImageOpen = { status: "remoteImageOpened"; mimeType: string; bytes: number };
type RuntimeRemoteArtifactImageFailure = { status: "remoteImageRejected"; failure: "unavailable" | "changed" | "tooLarge" | "unsupported" };
type RuntimeRemoteArtifactImageHeader = RuntimeRemoteArtifactImageOpen | RuntimeRemoteArtifactImageFailure;
type RuntimeRemoteArtifactImage = (RuntimeRemoteArtifactImageOpen & { body: ReadableStream<Uint8Array> | null }) |
  RuntimeRemoteArtifactImageFailure;

interface RuntimeArtifactCleanup {
  removed: string[];
  failed: string[];
}

export type RuntimeCronDataQuery =
  | { kind: "jobs" }
  | { kind: "jobState"; jobId: string }
  | { kind: "overview"; limit: number }
  | { kind: "runs"; limit: number; jobIds?: string[] }
  | { kind: "jobRuns"; jobId: string; limit: number; before?: { startedAt: number; id: string } }
  | { kind: "runInput"; runId: string }
  | { kind: "dotsRunAuthorization"; source: string; purpose: "continuation" | "notification" }
  | { kind: "dotsRunAuthorization"; source: string; purpose: "admission"; assistantMessageId: string; textHash: string };

export interface RuntimeGadgetSourceData {
  manifest: string;
  files: RuntimeCapturedFile[];
  token?: string;
}

export interface RuntimeCapturedFile {
  path: string;
  content: string;
  text: boolean;
}

type RuntimeCaptureUnavailable = { status: "rejected"; message: string } | { status: "needsHost" };

type RuntimeGadgetManifest = { status: "manifest"; manifest: string; token: string } | RuntimeCaptureUnavailable;

type RuntimeBlueprintFileCapture = { status: "captured"; files: RuntimeCapturedFile[] } | RuntimeCaptureUnavailable;

type RuntimeBlueprintGadgetCapture =
  | { status: "captured"; files: RuntimeCapturedFile[]; manifest: string }
  | RuntimeCaptureUnavailable;

type RuntimeGadgetSource =
  | ({ status: "read" } & RuntimeGadgetSourceData)
  | { status: "rejected"; message: string }
  | { status: "needsHost" };

type RuntimeGadgetSourceInfo =
  | { status: "inspected"; manifest: string; paths: string[]; token: string }
  | { status: "rejected"; message: string }
  | { status: "needsHost" };

interface RuntimeGadgetFile {
  path: string;
  base64: string;
}

interface RuntimeGadgetCreateFiles {
  root: string;
  gadget: RuntimeGadgetInsert;
  manifest: string;
  entry: string;
  backendEntry?: string;
  source: { kind: "generated"; files: RuntimeGadgetFile[] } | { kind: "copy"; sourceId: string; token: string };
}

interface RuntimeGadgetExportFiles {
  root: string;
  id: string;
  taskId?: string;
  token: string;
  taskDirectory: string;
  basename: string;
  manifest: string;
  entry: string;
  readme: string;
}

type RuntimeGadgetFileReply =
  | { status: "created" | "scopeChanged" | "sourceChanged" }
  | { status: "exported"; directory: string; entryPath: string; fileCount: number }
  | { status: "failed"; message: string };

interface RuntimeGadgetSourceSave {
  root: string;
  id: string;
  taskId?: string;
  operationId: string;
  token: string;
  updatedAt: number;
  files: RuntimeGadgetFile[];
  manifest?: string;
  update?: RuntimeGadgetPatch;
}

type RuntimeGadgetSourceSaved =
  | { status: "saved"; source: RuntimeGadgetSourceData }
  | { status: "conflict" | "scopeChanged" | "needsHost" | "manifestSaved" }
  | { status: "failed"; message: string };

type RuntimeWorkbenchDataQuery =
  | { kind: "gadgets"; scopes?: Array<{ scopeType: "global" | "workspace" | "task"; scopeId: string | null }> }
  | { kind: "gadget"; id: string }
  | { kind: "gadgetForTask"; id: string; taskId: string }
  | { kind: "inheritedGadgets"; scope: RuntimeGadgetScope }
  | { kind: "blueprint"; id: string }
  | { kind: "blueprints" }
  | { kind: "workbenchReceipt" | "blueprintReceipt"; operationId: string };

type RuntimeGadgetScope = { scopeType: "global" | "workspace" | "task"; scopeId: string | null };
type RuntimeGadgetUpdate = { id: string; name: string; description: string | null; metadataJson: string; updatedAt: number };
export type RuntimeGadgetPatch = { name?: string; description?: { value: string | null }; metadataJson?: string };
export type RuntimeGadgetOrigin = { kind: "generated" } | { kind: "copy"; sourceId: string };
type RuntimeBlueprintDefinition = { kind: string; schemaVersion: number; definitionJson: string };
export type RuntimeGadgetInsert = RuntimeGadgetUpdate & {
  scope: RuntimeGadgetScope; manifestPath: string; sourcePath: string;
  createdByTaskId: string | null; blueprintId: string | null; createdAt: number;
};

export type RuntimeWorkbenchMutation =
  | { kind: "createGadget"; origin: RuntimeGadgetOrigin; gadget: RuntimeGadgetInsert }
  | ({ kind: "updateGadget"; id: string; updatedAt: number } & RuntimeGadgetPatch)
  | { kind: "touchGadget"; id: string; updatedAt: number }
  | { kind: "moveGadget"; id: string; scope: RuntimeGadgetScope; updatedAt: number }
  | { kind: "deleteGadget" | "deleteBlueprint"; id: string }
  | { kind: "createBlueprint"; blueprint: { id: string; name: string; description: string | null;
    definition: RuntimeBlueprintDefinition; createdAt: number; updatedAt: number } }
  | { kind: "patchBlueprint"; id: string; name?: string; description?: { value: string | null };
    definition?: RuntimeBlueprintDefinition; updatedAt: number };

export type RuntimeWorkbenchWriteStatus = "changed" | "missing" | "scopeChanged";

export interface RuntimePluginConfigTarget {
  kind: "skill" | "expert" | "connector";
  root: string;
  file: string;
}

interface RuntimeConnectorInstall {
  root: string;
  legacySkillsRoot: string;
  sourcePath: string;
  id: string;
  directory: string;
  name: string;
  installedAt: number;
}

export interface RuntimeWorkspaceMove {
  kind: "space" | "task";
  id: string;
  targetParentId: string | null;
  targetIndex?: number;
  targetSortOrder?: number;
  now: number;
  gateway: boolean;
  gatewayChannel?: string;
}

type RuntimeWorkspaceMoveReply =
  | { status: "saved" | "needsHost" }
  | { status: "rejected"; message: string };

export type RuntimeSidebarArchive = { id: string; archived: boolean; at: number } &
  ({ kind: "space" } | { kind: "task"; directoryName: string });

type RuntimeSidebarArchiveReply =
  | { status: "saved" | "trashed" | "needsHost" }
  | { status: "rejected"; message: string };

export type RuntimeWorkspaceLabel =
  | { kind: "rename"; id: string; name: string; at: number }
  | { kind: "icon"; id: string; icon: WorkspaceIconAppearance | null };

type RuntimeWriteReply =
  | { status: "saved" | "needsHost" }
  | { status: "rejected"; message: string };

type RuntimeWorkspacePersistence = Pick<SpaceDto, "id" | "name" | "path" | "parentId" | "sortOrder"> & { at: number };

type RuntimeWorkspacePersistenceReply =
  | { status: "saved"; parentId: string | null; sortOrder: number }
  | { status: "needsHost" }
  | { status: "rejected"; message: string };

type RuntimeTaskRecord = Pick<TaskDto, "id" | "title" | "spaceId" | "projectId" | "status" | "sessionFile"
  | "cwd" | "welcomeMode" | "modelId" | "permissionMode" | "expertId" | "modePresetId" | "startAt"
  | "dueAt" | "spaceSortOrder" | "isFavorited" | "doneAckedAt"> & {
  at: number;
  updatedAt?: number;
  expectedTitle?: string;
  preserveTitle: boolean;
  preserveWorkspace: boolean;
  workspaceFallback?: { name: string; path?: string };
  externalAgentPinJson?: string | null;
};

type RuntimeTaskRecordReply =
  | { status: "saved"; previousProjectId: string | null }
  | { status: "needsHost" | "missingWorkspace" }
  | { status: "rejected"; message: string };

export interface RuntimeDueTrashedTask {
  taskId: string;
  projectId: string | null;
}

type RuntimeTrashRetentionReply =
  | { status: "saved"; changed: number }
  | { status: "needsHost" }
  | { status: "rejected"; message: string };

export interface TaskArchivePurgeScope {
  direct: "explicit" | "inherited" | "none";
  selectedRoots: string[];
}

type RuntimeTaskTrashPurge = Pick<TaskExecutionWorkspaceStateRow, "taskId" | "updatedAt" | "trashedAt" | "trashPath"> & {
  archiveScope?: TaskArchivePurgeScope;
};

type RuntimeTaskTrashPurgeReply =
  | { status: "saved" | "needsHost" }
  | { status: "rejected"; message: string };

type RuntimeConnectorInstallReply =
  | { status: "installed"; names: string[] }
  | { status: "recovered"; warnings: string[] }
  | { status: "maintained"; warnings: string[]; migrated: number; removed: number; skipped: number }
  | { status: "uninstalled"; warning: string | null }
  | { status: "missing" }
  | { status: "needsHost" }
  | { status: "failed"; message: string };

type RuntimeConnectorImportReply =
  | { status: "imported"; id: string }
  | { status: "needsHost" }
  | { status: "failed"; message: string };

type RuntimeConnectorMarketAction =
  | { kind: "delete"; id: string; roots: string[]; pluginRoot: string; installedRoot: string; legacySkillsRoot: string }
  | { kind: "unhide"; id: string; pluginRoot: string }
  | { kind: "cleanup"; roots: string[] };

type RuntimeConnectorMarketReply =
  | { status: "deleted" | "cleaned"; warnings: string[] }
  | { status: "updated" | "needsHost" }
  | { status: "failed"; message: string };

type RuntimePluginConfig =
  | { status: "observed"; version: string; text: string | null }
  | { status: "saved" | "changed" | "needsHost" }
  | { status: "failed"; message: string };

type RuntimePluginCatalogQuery =
  | { kind: "connectors"; roots: string[]; installedRoot: string; hiddenPath: string }
  | { kind: "experts"; installedRoot: string; marketRoots?: string[]; hiddenPath?: string }
  | { kind: "expertDetail"; installedRoot: string; directory: string }
  | { kind: "expertPrivateSkills"; installedRoot: string; directory: string; skillRoot: string }
  | { kind: "skillMarket"; legacyRoot: string; marketRoots: string[]; hiddenPath: string };

export type RuntimeLibraryIndexStatus = "indexed" | "skipped" | "sourceChanged";

type RuntimeLibraryIndexItem = Pick<LibraryItemDto,
  "id" | "spaceId" | "title" | "filename" | "kind" | "mimeType" | "contentHash" | "updatedAt" | "sizeBytes" | "extractStatus">;

export interface RuntimeLibrarySourceVersion {
  sourcePath: string;
  sourceSize: number;
  sourceModifiedNanos: string;
}

interface RuntimeLibraryIndexPublication extends RuntimeLibrarySourceVersion {
  item: RuntimeLibraryIndexItem;
  stagingUri: string;
  chunkCount: number;
  indexedAt: number;
  onlyMissing: boolean;
}

export type RuntimeLibraryDocumentContent =
  | { kind: "textFile" }
  | { kind: "extracted"; status: ContentExtractionStatus; text: string | null };

interface RuntimeLibraryDocumentPublication {
  item: RuntimeLibraryIndexItem;
  source?: RuntimeLibrarySourceVersion;
  content: RuntimeLibraryDocumentContent;
  indexedAt: number;
  onlyMissing: boolean;
  chunkSize: number;
  overlap: number;
}

export interface RuntimeAuditDurableSnapshot {
  select(sql: string, parameters: Array<string | number | null>, first: boolean): Promise<unknown>;
  head(conversationId: number, maxTokens: number): Promise<string | undefined>;
  questions(conversationId: number, beforeEntryId?: number): Promise<(Omit<TaskUserQuestionsDto, "nextBefore"> & { nextBefore: number | null }) | undefined>;
  close(): Promise<void>;
}

type RuntimeSemanticSearch = {
  modelId: string;
  modelVersion: string;
  dimension: number;
  query: Float32Array;
  threshold: number;
  scope: { sql: string; args: Array<string | number> };
} & ({ target: "memory" } | { target: "library"; limit: number });

export interface RuntimeSemanticHit { id: string; hash: string; score: number }

export interface RuntimeSemanticModel {
  libraryPath: string;
  modelPath: string;
  tokenizerPath: string;
  dimension: number;
  revision?: string;
}

export interface RuntimeSemanticModelProbe {
  roots: string[];
  fallbackRoot: string;
  modelId: string;
  modelVersion: string;
  dimension: number;
  requiredFiles: readonly string[];
}

export interface RuntimeEmbeddingSource {
  kind: "memory" | "library";
  id: string;
  hash: string;
}

export type RuntimeEmbeddingStage = { status: "staged"; token: string } | { status: "current" | "skipped" };

type RuntimeEmbeddingIndexModel = { modelId: string; modelVersion: string; dimension: number };
export interface RuntimeEmbeddingStats { total: number; completed: number }
type RuntimeEmbeddingCandidate = { id: string; hash: string | null };

type RuntimeEmbeddingQuery =
  | { kind: "libraryStats"; model: RuntimeEmbeddingIndexModel }
  | { kind: "libraryPage"; model: RuntimeEmbeddingIndexModel; after: string | null; limit: number }
  | { kind: "openMemoryQueue"; model: RuntimeEmbeddingIndexModel; queueId: string; limit?: number }
  | { kind: "memoryPage"; queueId: string; limit: number }
  | { kind: "closeMemoryQueue"; queueId: string };

interface RuntimeEmbeddingQueryResults {
  libraryStats: RuntimeEmbeddingStats;
  libraryPage: Array<{ id: string; hash: string }>;
  openMemoryQueue: RuntimeEmbeddingStats;
  memoryPage: RuntimeEmbeddingCandidate[];
  closeMemoryQueue: boolean;
}

interface RuntimeEmbeddingCounts {
  indexed: number;
  current: number;
  skipped: number;
}

interface RuntimeSemanticEmbedding {
  loadMs: number;
  vector?: number[] | null;
}

type RuntimeMemoryLexicalSearch = {
  scope: { sql: string; args: Array<string | number> };
  compact: string;
  terms: string[];
  ftsQuery: string | null;
  exactIdentifier: boolean;
};

type RuntimeMemoryLexicalScoring = Pick<RuntimeMemoryLexicalSearch, "scope" | "compact"> & {
  targets: Array<{ id: string; contentHash: string }>;
};

export interface RuntimeMemoryLexicalMatch {
  id: string;
  content_hash: string;
  importance: number;
  updated_at: number;
  exact: number;
  relevance: number;
}

export interface RuntimeMemoryLexicalCandidates {
  fts: string[];
  lexical: RuntimeMemoryLexicalMatch[];
}

type AuditLane = "database" | "inference" | "maintenance" | "scan";
const AUDIT_LANES: AuditLane[] = ["database", "inference", "maintenance", "scan"];

/** Caller outcomes. A timeout does not claim that the worker stopped or rolled back. */
export type RuntimeAuditOutcome =
  | "completed" | "failed" | "timeout" | "expired-before-dispatch"
  | "overloaded" | "slot-busy" | "retired" | "blocked" | "closed" | "cancelled";

/** Per-lane accounting so a blocked channel is visible instead of looking like a model error. */
export interface RuntimeAuditLaneTotals {
  completed: number;
  failed: number;
  timedOut: number;
  expiredBeforeDispatch: number;
  overloaded: number;
  /** A scan or maintenance request that timed out still owns its reply slot; new ones are refused until it lands. */
  slotBusy: number;
  retired: number;
  blocked: number;
  cancelled: number;
}

export interface RuntimeAuditLaneRecord extends RuntimeAuditLaneTotals {
  lane: AuditLane;
  operation: string;
  outcome: RuntimeAuditOutcome;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt: number;
  waitedMs: number;
  ranMs: number;
}

/** Why a Rust process generation is being retired; only inference faults disable inference. */
type AuditStopCause = "exit" | "protocol" | "closed" | "control-overload";

/** Consecutive inference-attributed failures tolerated across process restarts. */
const INFERENCE_FAILURE_LIMIT = 3;

/** Backpressure bound per lane: past this, requests fail fast instead of growing the queue. */
const LANE_QUEUE_LIMIT = 256;
const CONTROL_QUEUE_LIMIT = 64;

const emptyLaneTotals = (): RuntimeAuditLaneTotals => ({
  completed: 0, failed: 0, timedOut: 0,
  expiredBeforeDispatch: 0, overloaded: 0, slotBusy: 0, retired: 0, blocked: 0, cancelled: 0,
});

interface AuditTransport extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  generation?: string;
  kill(): boolean;
}

interface AuditRequest {
  id: string;
  request: object;
  operation: string;
  lane: AuditLane;
  enqueuedAt: number;
  deadline: number;
  startedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  session?: AuditSession;
  expectedSession?: AuditSession;
  retired?: () => boolean;
  signal?: AbortSignal;
  abort?: () => void;
  allowAfterInferenceFailure: boolean;
  mutation: boolean;
  capability: boolean;
  settled: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface AuditSession {
  historySupport?: Promise<boolean>;
  historyReady: Promise<true>;
  advertiseHistory(): void;
  history: Map<string, (value: unknown) => void>;
  child: AuditTransport;
  supervised: boolean;
  closed: Promise<void>;
  chunks: Buffer[];
  bytes: number;
  dotsFileWatches: Map<string, { changed(): void; lost(): void }>;
  pending: Map<string, AuditRequest>;
  parallelReadLimit: number;
  parallelWorkspaceIoLimit: number;
  controls: Map<string, {
    timer: ReturnType<typeof setTimeout>;
    action?: string;
    resolve(value: unknown): void;
  }>;
}

/** Conservative classification: an unlisted command may mutate and cannot silently replay. */
function mutatesPersistentState(request: object, lane: AuditLane): boolean {
  if (lane === "inference") return false;
  const value = request as { operation?: string; action?: string; ephemeral?: boolean; request?: { kind?: string; action?: { operation?: string } } };
  const operation = value.operation ?? "";
  if (operation.endsWith("Supported") || READ_ONLY_OPERATIONS.has(operation)) return false;
  if (operation === "coreGadgetHost") {
    return !["supported", "list", "health"].includes(value.action ?? "");
  }
  if (operation === "corePiHost") {
    return !["status", "verifyLease"].includes(value.action ?? "");
  }
  if (operation === "piStorage") {
    const payload = (request as { payload?: { action?: string } }).payload;
    return !PI_STORAGE_READ_ONLY_ACTIONS.has(payload?.action ?? value.action ?? "");
  }
  if (operation === "coreMaintenanceScheduler") {
    return value.action !== "status";
  }
  if (
    operation === "coreWorkScheduler"
    || operation === "coreCronScheduler"
    || operation === "coreDotsScheduler"
    || operation === "coreGatewayScheduler"
    || operation === "coreRemoteControl"
  ) {
    return value.action !== "status";
  }
  if (operation === "coreExecution") {
    if (value.action === "status") return false;
    if (value.action === "executorProgress" && value.ephemeral === true) return false;
  }
  if (operation === "gadgetState") {
    return value.request?.kind === "access" && !["read", "keys"].includes(value.request.action?.operation ?? "");
  }
  return true;
}

function isCapabilityRequest(request: object): boolean {
  const value = request as { operation?: string; query?: { kind?: string }; request?: { kind?: string } };
  return value.operation?.endsWith("Supported") === true || value.query?.kind?.endsWith("Supported") === true
    || (value.operation === "gadgetState" && value.request?.kind === "supported");
}

const PI_STORAGE_READ_ONLY_ACTIONS = new Set([
  "resolveStoreId", "storeInfo", "openReadOnly", "conversation", "scanConversations", "entry",
  "findLatestHeadMarker", "scanEntries", "task", "scanTasks", "submission", "scanSubmissions",
  "submissionByRequest", "findDocument", "document", "scanDocuments",
]);

const READ_ONLY_OPERATIONS = new Set([
  "readMemoryExtractionQueue",
  "externalAgentHistoryPage", "readLoadoutObservations", "readGatewayExecutionAuthority",
  "snapshots", "snapshotReceipt", "artifactSnapshots", "artifactData", "readManagedArtifact", "nextManagedArtifact", "closeManagedArtifact",
  "workspaceFilePreview", "workspaceScan", "dotsFileRevision", "startDotsFileWatch", "stopDotsFileWatch",
  "openWorkspaceArtifact", "openManagedArtifactImage",
  "openRemoteArtifactImage", "taskList", "taskRecord", "applicationDatabaseIdentity", "taskWorkspacePaths", "workspaceData", "readWorkQueue", "readBotHistoryPage", "readBotRegistry", "workspaceSharedData", "pythonProjectBindings",
  "readWorkGraph", "scanWorkGraphIntegrity", "fileBackupList", "readGatewayChannels", "readGatewayChannelState", "readDotsDelegationData", "readDotsReplyData", "readDotsActivityData", "readDotsDeferredData", "readDotsFollowupData", "readDotsForegroundData", "readDotsProactiveData", "readDotsFileWatchData", "readGatewayOutbox", "readGatewayInbox", "readGatewayAssignment", "readGatewayQueue", "readGatewayMessages", "codeReviewData", "readConversationRuntime", "readDurableTaskProjection",
  "readTaskExpertBinding", "memoryOrganizationLatest", "notificationData", "readNativeHooks", "readPathHints",
  "readImprovementPackages", "readImprovementReview", "executionFailures", "branchTitle", "readConversationBranchData",
  "archivedTaskCandidates", "listTrashedTasks", "dueTrashedTasks", "taskBoard", "libraryMetadata", "readScopedNote",
  "projectMetadata", "cronData", "workbenchData",
  "captureBlueprintWorkspace", "scanPluginCatalog", "pluginCatalog", "readPluginConfig", "usageReport", "usageCsv", "usageSessionFiles",
  "diagnostics", "semantic", "embeddingIndex", "memoryLexical", "memoryLexicalScores", "memoryBaselines",
  "historyRead", "durable", "coreEventsSnapshot", "coreEventsReplay",
]);
