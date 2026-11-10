import type { WorkSubitemDto, WorkContinuationDto } from "./bot-work-phase3";
import type { WorkCollaborationMessage, WorkNotificationIdentity } from "./bot-work-collaboration";
/**
 * BOT-WORK-1.0 shared contract.
 *
 * Bot is the durable identity; Work is the single delegation record (it replaces the
 * earlier conversation goal). Execution stays in Durable: these types only carry the
 * business binding, provenance and settlement facts.
 *
 * The control request types intentionally do not contain an actor field. Identity is
 * injected by the host entry point (`WorkActor`) and never read from model payloads.
 */

export const WORK_MAX_CRITERIA = 12;
export const WORK_MAX_PARTICIPANTS = 24;
export const LOCAL_USER_ID = "user-local-primary";
export const DEFAULT_BOT_ID = "bot-mybuddy-default";

/** Keys that are accepted in model payloads but carry no business meaning. */
const IGNORED_CONTROL_INPUT_KEYS = new Set(["requestedAt", "clientTimestamp"]);
/** Identity keys a control payload must never declare. */
const RESERVED_ACTOR_KEYS = new Set([
  "actor",
  "actorUserId",
  "actorBotId",
  "allowWorkerActor",
  "actorKind",
  "hostBinding",
]);

export type BotLifecycleStatus = "active" | "paused" | "disabled";

export type WorkMode = "once" | "watch";

export type WorkLifecycle = "active" | "paused" | "closing" | "closed";

export type WorkClosureConclusion = "succeeded" | "cancelled" | "ended_unsuccessfully";

export type WorkCatchUpPolicy = "latest" | "each" | "skip";

export type WorkParticipantRole = "collaborator" | "worker" | "watcher";

export type WorkCriterionStatus = "pending" | "satisfied" | "failed" | "blocked" | "waived";

export type DeliverableStatus = "proposed" | "accepted" | "rejected" | "superseded";

export type WorkExecutionStatus =
  | "pending"
  | "submitted"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown"
  | "invalidated";

export type WorkBlockerStatus = "open" | "cleared";

export type WorkEvidenceKind =
  | "automated_test"
  | "tool_receipt"
  | "inspection"
  | "artifact"
  | "real_environment"
  | "user_attestation";

export type WorkEvidenceProvenance = "execution" | "user" | "system";

export type WorkAdmissionState = "admitted" | "consumed" | "released" | "unknown";

export type WorkInstructionStatus = "pending" | "attempted" | "delivered" | "unknown" | "invalidated";

export type WorkNotificationDelivery = "pending" | "sent" | "unknown" | "failed";

export type WorkGoalSourceType = "git_commit" | "file" | "external_input";

/** Immutable expert configuration snapshot. Version and content travel together. */
export interface ExpertConfigSnapshotDto {
  expertId: string;
  revision: string;
  version: number;
  systemPromptHash: string;
  allowedMcpIds: string[];
  allowedSkillIds: string[];
  allowedConnectorIds: string[];
  capturedAt: number;
  configuration?: import("./expert-binding").TaskExpertSnapshot;
  skillPackages?: Array<{ id: string; directory: string; origin?: "private" | "global" }>;
}

export interface ExpertProfileDto extends ExpertConfigSnapshotDto {
  desiredVersion: number;
  activeVersion: number;
  pendingVersion?: number;
}

export interface BotMemoryScopeDto {
  personalMemoryNamespace: string;
  sharePersonalMemoryWithTeam: boolean;
  allowUnconfirmedSpeculationInMemory: boolean;
}

/** One immutable staged/active expert configuration, for explicit review (R09). */
export interface BotExpertVersionDto {
  botId: string;
  version: number;
  snapshotId: string;
  state: "pending" | "active" | "superseded";
  expertId: string;
  sourceRevision: string;
  systemPromptHash: string;
  allowedMcpIds: string[];
  allowedSkillIds: string[];
  allowedConnectorIds: string[];
  configuration?: {
    name: string;
    instructions: string;
    skillIds: string[];
    mcpIds: string[];
    connectorIds: string[];
  };
  stagedBy: string;
  createdAt: number;
  adoptedAt?: number;
}

export interface BotChannelBindingDto {
  channelType: "desktop" | "mobile" | "remote" | "gateway";
  channelIdentifier: string;
  botId: string;
  boundAt: number;
}

/** Host-approved capability envelope; a Work can never exceed it. */
export interface WorkAuthorizationDto {
  allowedScopes: string[];
  targetWhitelist: string[];
  allowGitBranchOrWorktree: boolean;
  allowRedelegation: boolean;
  expiresAt?: number;
}

export interface BotDto {
  botId: string;
  userId: string;
  displayName: string;
  responsibilitySummary: string;
  expertProfile: ExpertProfileDto;
  memoryScope: BotMemoryScopeDto;
  authorization: WorkAuthorizationDto;
  foregroundAllowedTools: string[];
  notificationPolicyJson: string;
  status: BotLifecycleStatus;
  createdAt: number;
  updatedAt: number;
}

export interface WorkCriterionDto {
  id: string;
  text: string;
  /** Host-labelled planning checks are not user acceptance requirements. */
  origin?: "assistant_proposal";
  status: WorkCriterionStatus;
  requiredIntentRevision: number;
  verifiedIntentRevision?: number;
  requiresRealEnvironmentCheck: boolean;
  requiredEnvironment?: string;
  evidenceRefs: string[];
  waivedReason?: string;
  waivedByUserId?: string;
}

export interface WorkGoalSourceDto {
  sourceType: WorkGoalSourceType;
  /** Authoritative handle: commit SHA, file path or external issue/revision id. */
  sourceRef: string;
  /** Immutable identity of the inspected input (content hash or provider revision). */
  inputSnapshotId: string;
  observedAt: number;
}

export interface WorkWatchRuleDto {
  subscriptions: string[];
  cronExpression?: string;
  timezone?: string;
  catchUpPolicy: WorkCatchUpPolicy;
  maxMergeWaitMs: number;
  maxQueueDepth: number;
  stopConditionText?: string;
  nextWakeAt?: number;
}

export interface WorkParticipantDto {
  botId: string;
  role: WorkParticipantRole;
  delegatedScope: string[];
  expertSnapshot: ExpertConfigSnapshotDto;
  addedAt: number;
}

export interface WorkIntentSnapshotDto {
  snapshotId: string;
  workId: string;
  intentRevision: number;
  sourceVersion: number;
  title: string;
  goalDescription?: string;
  constraints: string[];
  criteria: WorkCriterionDto[];
  authorization: WorkAuthorizationDto;
  expertSnapshot: ExpertConfigSnapshotDto;
  inputSnapshotId: string;
  goalSources: WorkGoalSourceDto[];
  createdBy: "user" | "bot";
  sourceMessageId?: string;
  createdAt: number;
}

export interface WorkEvidenceDto {
  evidenceId: string;
  workId: string;
  deliverableId?: string;
  executionId?: string;
  criterionIds: string[];
  kind: WorkEvidenceKind;
  provenance: WorkEvidenceProvenance;
  sourceRef: string;
  sourceSha?: string;
  inputSnapshotId: string;
  environment?: string;
  intentRevision: number;
  detail?: string;
  recordedAt: number;
}

export interface WorkDeliverableDto {
  deliverableId: string;
  workId: string;
  producerBotId: string;
  executionId: string;
  intentRevision: number;
  ownerEpoch: number;
  inputSnapshotId: string;
  status: DeliverableStatus;
  summary: string;
  artifactRefs: string[];
  evidenceRefs: string[];
  uncoveredScope: string[];
  uncoveredCriterionIds: string[];
  isSpeculation: boolean;
  hasWriteConflicts: boolean;
  rejectedReason?: string;
  createdAt: number;
  reviewedAt?: number;
  reviewedByBotId?: string;
}

export type WorkBlockerReasonCode =
  | "user-input"
  | "backlog-overflow"
  | "merge-wait"
  | "causal-loop-guard"
  | "causal-depth"
  | "causal-hops"
  | "causal-attribution-unknown"
  | "unqueryable-offline-gap"
  | "source-readback"
  | "dispatch-blocked"
  | "resource-dispatch-wait"
  | "resource-recovery-exhausted"
  | "invalid-schedule"
  | "deadline-follow-up";

export interface WorkBlockerDto {
  /** Read-only host proof for narrowly resolving an untyped historical owner report. */
  legacyUserInput?: { reportOperationId: string; blockerSnapshot: string; inputSnapshotId: string;
    intentRevision: number; ownerEpoch: number };
  blockerId: string;
  workId: string;
  reportedByBotId?: string;
  reason: string;
  kind: "external_effect" | "backpressure" | "write_conflict" | "operational";
  reasonCode?: WorkBlockerReasonCode;
  details?: Record<string, unknown>;
  sourceRef?: string;
  subscriptionId?: string;
  causalChainId?: string;
  unknownExternalEffectRef?: string;
  waitingForUserInput: boolean;
  status: WorkBlockerStatus;
  createdAt: number;
  clearedAt?: number;
}

export interface WorkExecutionBindingDto {
  bindingId: string;
  workId: string;
  operationId: string;
  botId: string;
  taskId: string;
  durableStoreKey: string;
  conversationId: string;
  intentRevision: number;
  ownerEpoch: number;
  inputSnapshotId: string;
  expertSnapshot: ExpertConfigSnapshotDto;
  delegatedScope: string[];
  workspaceBinding: string;
  inboxEventId?: string;
  status: WorkExecutionStatus;
  attemptId?: string;
  submissionReceipt?: string;
  settlementNote?: string;
  admittedAt: number;
  submittedAt?: number;
  invalidatedAt?: number;
  settledAt?: number;
}

export interface WorkAdmissionDto {
  admissionId: string;
  workId: string;
  bindingId?: string;
  operationId: string;
  actionKind: string;
  state: WorkAdmissionState;
  intentRevision: number;
  ownerEpoch: number;
  admittedAt: number;
  settledAt?: number;
}

export interface WorkSubscriptionDto {
  subscriptionId: string;
  workId: string;
  source: string;
  filter: Record<string, unknown>;
  catchUpPolicy: WorkCatchUpPolicy;
  maxMergeWaitMs: number;
  maxQueueDepth: number;
  stopConditionText?: string;
  timezone?: string;
  cronExpression?: string;
  nextWakeAt?: number;
  lastProcessedSourceVersion?: string;
  scheduleRevision?: number;
  configRevision?: number;
  sourceTarget?: string;
  versionMode?: "monotonic" | "provider-sequence" | "readback" | "none";
  dstPolicy?: "first-valid" | "first-occurrence";
  maxBacklogEvents?: number;
  maxBacklogBytes?: number;
  lastCheckedAt?: number;
  stoppedReason?: string;
  createdAt: number;
  updatedAt: number;
  stoppedAt?: number;
}

export interface WorkNotificationDto extends Partial<WorkNotificationIdentity> {
  notificationId: string;
  workId: string;
  semanticKey: string;
  kind: "result" | "blocked" | "closed" | "handoff" | "summary";
  title: string;
  body?: string;
  stateVersion: number;
  intentRevision: number;
  delivery: WorkNotificationDelivery;
  channel?: string;
  idempotencyKey?: string;
  attemptCount: number;
  externalReceipt?: string;
  readAt?: number;
  createdAt: number;
  sentAt?: number;
  /** The stable semantic card this intent announces; delivery stays a separate fact. */
  cardKey?: string;
  /** Provider-level effect identity; safe retries reuse it instead of minting a new one. */
  effectKey?: string;
  targetKey?: string;
  deliveryGuarantee?: import("./bot-work-phase5").WorkDeliveryGuarantee;
}

export interface WorkDto {
  workId: string;
  userId: string;
  projectId?: string;
  workspacePath?: string;
  sourceMessageId?: string;
  legacyTaskId?: string;

  ownerBotId: string;
  ownerEpoch: number;
  participants: WorkParticipantDto[];

  intentRevision: number;
  sourceVersion: number;
  title: string;
  goalDescription?: string;
  constraints: string[];
  criteria: WorkCriterionDto[];
  authorization: WorkAuthorizationDto;
  activeIntentSnapshotId: string;
  inputSnapshotId: string;
  goalSources: WorkGoalSourceDto[];

  mode: WorkMode;
  lifecycle: WorkLifecycle;
  pendingConclusion?: WorkClosureConclusion;
  cancelRequestedAt?: number;
  closureConclusion?: WorkClosureConclusion;
  closureSummary?: string;

  acceptedDeliverableIds: string[];
  activeExecutionIds: string[];
  progressSummary?: string;

  watchRule?: WorkWatchRuleDto;

  /** Business commitment deadline, independent of authorization expiry. */
  deadlineAt?: number;
  deadlineRevision: number;
  deadlineSetAt?: number;
  causalPolicy?: { maxDepth: number; maxHops: number; maxDispatches: number };

  stateVersion: number;
  createdBy: "user" | "bot";
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  closeOperationId?: string;
}

/** Reconnect/UI projection. Derived from persisted facts only. */
export interface WorkProjectionDto {
  team?: import("./bot-work-team").WorkTeamDto;
  phase4?: import("./bot-work-phase4").WorkPhase4Projection;
  phase3?: {
    subitems: WorkSubitemDto[];
    continuations: WorkContinuationDto[];
    gaps: WorkSubitemDto[];
    /** 仍有准入但未结算的动作数（真实执行记录，不是审批）。 */
    settlingActions: number;
    pausedEventCount: number;
    artifactSnapshotId?: string;
    handoffs: WorkCollaborationMessage[];
    collaborationMessages: WorkCollaborationMessage[];
  };

  workId: string;
  title: string;
  mode: WorkMode;
  lifecycle: WorkLifecycle;
  pendingConclusion?: WorkClosureConclusion;
  closureConclusion?: WorkClosureConclusion;
  closureSummary?: string;
  ownerBotId: string;
  ownerEpoch: number;
  intentRevision: number;
  sourceVersion: number;
  stateVersion: number;
  inputSnapshotId: string;
  inputSnapshotBound: boolean;
  goalSources: WorkGoalSourceDto[];
  criteria: WorkCriterionDto[];
  acceptedDeliverableIds: string[];
  deliverables: WorkDeliverableDto[];
  runtimeObservations?: import("./bot-work-phase3").WorkRuntimeObservationDto[];
  generatedArtifacts?: Array<import("./bot-work-phase3").GeneratedArtifact & { bindingId: string }>;
  /** Previous input revisions: display/open only, never current completion evidence. */
  historicalGeneratedArtifacts?: Array<import("./bot-work-phase3").GeneratedArtifact & { bindingId: string }>;
  blockers: WorkBlockerDto[];
  executions: WorkExecutionBindingDto[];
  notifications: WorkNotificationDto[];
  /** Stable semantic cards; read state lives here and never on Work control fields. */
  cards?: import("./bot-work-phase5").WorkResultCardDto[];
  subscriptionIds: string[];
  uncoveredScope: string[];
  nextSteps: string[];
  updatedAt: number;
  closedAt?: number;
}

export interface ExpectedVersionGuard {
  expectedStateVersion?: number;
  expectedIntentRevision?: number;
  expectedOwnerEpoch?: number;
}

/** Host-injected identity. Never accepted from a model/tool payload. */
export type WorkActor =
  | {
      kind: "user";
      userId: string;
      entry?: "desktop" | "remote" | "mobile";
      grants: WorkAuthorizationDto;
    }
  | {
      kind: "bot";
      botId: string;
      userId: string;
      host: "foreground" | "background";
      /** Host-certified envelope for this bot entry; never accepted from model data. */
      grants: WorkAuthorizationDto;
    }
  | {
      kind: "worker";
      botId: string;
      bindingId: string;
    }
  | {
      kind: "system";
      reason: string;
    };

export type WorkControlErrorCode =
  | "invalid_request"
  | "not_found"
  | "version_conflict"
  | "epoch_mismatch"
  | "idempotency_conflict"
  | "unauthorized_actor"
  | "invalid_lifecycle_transition"
  | "unmet_acceptance_criteria"
  | "unsettled_effects"
  | "causal_guard"
  | "capacity_refused"
  | "speculation_not_acceptable"
  | "bot_disabled";

export type WorkControlResult =
  | {
      ok: true;
      replayed: boolean;
      operationId: string;
      work: WorkDto;
      outboxEventId?: string;
    }
  | {
      ok: false;
      code: WorkControlErrorCode;
      message: string;
      latestWorkSnapshot?: WorkDto;
    };

export interface WorkCriterionInput {
  origin?: "assistant_proposal";
  id?: string;
  text: string;
  requiresRealEnvironmentCheck?: boolean;
  requiredEnvironment?: string;
  status?: WorkCriterionStatus;
  waiveReason?: string;
}

export interface CreateWorkParams {
  operationId: string;
  title: string;
  goalDescription?: string;
  constraints?: string[];
  criteria?: WorkCriterionInput[];
  mode?: WorkMode;
  projectId?: string;
  workspacePath?: string;
  conversationId?: string;
  legacyTaskId?: string;
  sourceMessageId?: string;
  ownerBotId?: string;
  authorization?: Partial<WorkAuthorizationDto>;
  inputSnapshotId?: string;
  goalSources?: WorkGoalSourceDto[];
  watchRule?: Partial<WorkWatchRuleDto>;
  /** Business deadline, not authorization expiry or an implicit repeating interval. */
  deadlineAt?: number;
  causalEventId?: string;
}

export interface AmendWorkParams {
  operationId: string;
  workId: string;
  title?: string;
  goalDescription?: string;
  constraints?: string[];
  criteria?: WorkCriterionInput[];
  authorization?: Partial<WorkAuthorizationDto>;
  watchRule?: Partial<WorkWatchRuleDto> | null;
  mode?: WorkMode;
  /** null explicitly clears the business deadline. */
  deadlineAt?: number | null;
  inputSnapshotId?: string;
  goalSources?: WorkGoalSourceDto[];
  invalidateExecutionIds?: string[];
  progressSummary?: string;
  sourceMessageId?: string;
  causalEventId?: string;
  versionGuard?: ExpectedVersionGuard;
}

export interface PauseWorkParams {
  operationId: string;
  workId: string;
  reason?: string;
  versionGuard?: ExpectedVersionGuard;
}

export interface ResumeWorkParams {
  operationId: string;
  workId: string;
  versionGuard?: ExpectedVersionGuard;
}

export interface CancelWorkParams {
  operationId: string;
  workId: string;
  reason?: string;
  versionGuard?: ExpectedVersionGuard;
}

export interface HandoffOwnerParams {
  preparationId?: string;
  operationId: string;
  workId: string;
  targetBotId: string;
  delegatedScope?: string[];
  versionGuard?: ExpectedVersionGuard;
}

export interface AddParticipantParams {
  operationId: string;
  workId: string;
  botId: string;
  role?: WorkParticipantRole;
  delegatedScope?: string[];
  versionGuard?: ExpectedVersionGuard;
}

export interface DispatchExecutionParams {
  operationId: string;
  workId: string;
  bindingId?: string;
  botId: string;
  taskId: string;
  durableStoreKey: string;
  conversationId: string;
  workspaceBinding: string;
  delegatedScope?: string[];
  /** Immutable each-event obligation this binding executes. */
  inboxEventId?: string;
  causal?: {
    source: string;
    sourceEventId: string;
    causalEventId?: string;
    parentChainId?: string;
    trustedRoot?: boolean;
    actionKind?: string;
  };
  versionGuard?: ExpectedVersionGuard;
}

export interface ReconcileExecutionParams {
  bindingId: string;
  outcome: WorkExecutionStatus;
  note?: string;
  submissionReceipt?: string;
  /** Unknown external effects keep the work open until read back. */
  unknownExternalEffectRef?: string;
  usageTokens?: number;
}

export interface SubmitDeliverableParams {
  operationId: string;
  workId: string;
  bindingId: string;
  deliverableId?: string;
  summary: string;
  artifactRefs?: string[];
  uncoveredScope?: string[];
  uncoveredCriterionIds?: string[];
  isSpeculation?: boolean;
  hasWriteConflicts?: boolean;
  evidence?: WorkEvidenceInput[];
  versionGuard?: ExpectedVersionGuard;
}

export interface WorkEvidenceInput {
  kind: WorkEvidenceKind;
  sourceRef: string;
  sourceSha?: string;
  environment?: string;
  criterionIds?: string[];
  detail?: string;
}

export interface AcceptDeliverableParams {
  operationId: string;
  workId: string;
  deliverableId: string;
  /** Explicitly retain useful output while leaving the listed gaps unresolved. */
  partialAcceptance?: { reason: string; criterionIds: string[] };
  criterionUpdates?: Array<{ criterionId: string; evidenceIds: string[]; detail?: string }>;
  waivers?: Array<{ criterionId: string; reason: string }>;
  progressSummary?: string;
  versionGuard?: ExpectedVersionGuard;
}

export interface RejectDeliverableParams {
  operationId: string;
  workId: string;
  deliverableId: string;
  reason: string;
  versionGuard?: ExpectedVersionGuard;
}

export interface RecordUserFeedbackParams {
  artifactSnapshotId?: string;
  operationId: string;
  workId: string;
  criterionIds: string[];
  environment: string;
  sourceRef: string;
  sourceSha?: string;
  inputSnapshotId: string;
  failed: boolean;
  detail?: string;
  versionGuard?: ExpectedVersionGuard;
}

/** User-confirmed criterion change from the conversation UI (not a model decision). */
export interface AttestCriteriaParams {
  inputSnapshotId?: string;
  artifactSnapshotId?: string;
  operationId: string;
  workId: string;
  criterionUpdates: Array<{ criterionId: string; status: "pending" | "met" | "not_met" | "waived"; evidence?: string }>;
  progressSummary?: string;
  versionGuard?: ExpectedVersionGuard;
}

export interface ReportBlockerParams {
  /** Explicit information request only, never permission or effect reconciliation. */
  userInput?: { kind: "reply" };
  operationId: string;
  workId: string;
  reason: string;
  kind?: WorkBlockerDto["kind"];
  unknownExternalEffectRef?: string;
  waitingForUserInput?: boolean;
  versionGuard?: ExpectedVersionGuard;
}

export interface ClearBlockerParams {
  operationId: string;
  workId: string;
  blockerId: string;
  resolutionNote?: string;
  versionGuard?: ExpectedVersionGuard;
}

export interface CloseWorkParams {
  operationId: string;
  workId: string;
  conclusion: WorkClosureConclusion;
  closureSummary?: string;
  versionGuard?: ExpectedVersionGuard;
}

export interface AdmitActionParams {
  admissionId: string;
  workId: string;
  bindingId?: string;
  actionKind: string;
  operationId: string;
  /** 工具声明的真实目标路径；只用于工作区目录归属，不是资源隔离或审批。 */
  paths?: string[];
  versionGuard?: ExpectedVersionGuard;
}

export interface WorkSourceEventDto {
  /** Trusted adapter namespace, not a closed enum; the ingress validates the registered adapter. */
  source: string;
  sourceEventId: string;
  eventType: string;
  sourceVersion?: string;
  workId?: string;
  subscriptionId?: string;
  causalEventId?: string;
  timestamp?: number;
  payload?: Record<string, unknown>;
}

export interface WorkSubscriptionInput {
  subscriptionId?: string;
  source: string;
  filter?: Record<string, unknown>;
  catchUpPolicy?: WorkCatchUpPolicy;
  maxMergeWaitMs?: number;
  maxQueueDepth?: number;
  stopConditionText?: string;
  timezone?: string;
  cronExpression?: string;
  nextWakeAt?: number;
}

export interface WorkInboxEventDto {
  eventId: string;
  dedupeKey: string;
  source: string;
  sourceEventId: string;
  eventType: string;
  workId: string;
  subscriptionId?: string;
  intentRevision: number;
  stateVersion: number;
  ownerEpoch: number;
  sourceVersion?: string;
  status: "pending" | "merged" | "skipped" | "blocked" | "processed";
  payload: Record<string, unknown>;
  causalEventId?: string;
  mergedCount: number;
  receivedAt: number;
  processAfter?: number;
  batchId?: string;
  batchDeadlineAt?: number;
  frozenAt?: number;
  frozenPayload?: Record<string, unknown>;
  claimVersion?: number;
  targetKey?: string;
  processReason?: string;
  processedAt?: number;
}

export interface WorkOutboxInstructionDto {
  eventId: string;
  dedupeKey: string;
  eventType: string;
  workId: string;
  bindingId?: string;
  intentRevision: number;
  stateVersion: number;
  ownerEpoch: number;
  requestId: string;
  causalEventId?: string;
  deliveryStatus: WorkInstructionStatus;
  attemptId?: string;
  attemptCount: number;
  payload: Record<string, unknown>;
  createdAt: number;
  deliveredAt?: number;
}

export interface WorkNotificationChannel {
  channel: string;
  /**
   * Legacy hint kept for existing adapters. When capability fields are present they are
   * authoritative: `idempotent` never implies both replay safety and read-back support.
   */
  idempotent?: boolean;
  deliveryGuarantee?: import("./bot-work-phase5").WorkDeliveryGuarantee;
  supportsIdempotencyKey?: boolean;
  supportsReceiptQuery?: boolean;
  /** Delivery target scope, e.g. one gateway connection or one paired device. */
  targetKey?: string;
  send(input: {
    notification: WorkNotificationDto;
    idempotencyKey: string;
  }): { ok: true; receipt: string } | { ok: false; retryable: boolean; responseLost: boolean; error: string };
  lookup?(input: { notification: WorkNotificationDto; idempotencyKey: string }): "delivered" | "missing" | "unknown";
}

export function canonicalizeControlInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeControlInput(item));
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (IGNORED_CONTROL_INPUT_KEYS.has(key)) continue;
      if (source[key] === undefined) continue;
      out[key] = canonicalizeControlInput(source[key]);
    }
    return out;
  }
  return value;
}

/** Stable recursive serialization: nested objects sort, arrays keep order. */
export function canonicalControlInput(operationType: string, params: unknown): string {
  const normalized = canonicalizeControlInput(params);
  if (operationType === "createWork" && normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    const input = Object.fromEntries(Object.entries(normalized));
    input.title = typeof input.title === "string" ? input.title.trim().slice(0, 240) : input.title;
    if (typeof input.goalDescription === "string") input.goalDescription = input.goalDescription.trim().slice(0, 2000) || undefined;
    input.constraints ??= [];
    input.criteria ??= [];
    input.mode ??= "once";
    input.goalSources ??= [];
    return JSON.stringify({ operationType, params: canonicalizeControlInput(input) });
  }
  return JSON.stringify({ operationType, params: normalized });
}

/** A model payload must not smuggle an identity; the host injects it. */
export function assertNoActorField(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "请求体必须是对象";
  for (const key of Object.keys(params as Record<string, unknown>)) {
    if (RESERVED_ACTOR_KEYS.has(key)) return `请求体不得声明身份字段 ${key}`;
  }
  return undefined;
}

export function minimumAuthorization(): WorkAuthorizationDto {
  return {
    allowedScopes: ["workspace:read"],
    targetWhitelist: [],
    allowGitBranchOrWorktree: false,
    allowRedelegation: false,
  };
}

export function intersectAuthorization(
  requested: Partial<WorkAuthorizationDto> | undefined,
  granted: WorkAuthorizationDto,
): WorkAuthorizationDto {
  const wanted = requested ?? {};
  const requestedScopes = Array.isArray(wanted.allowedScopes) && wanted.allowedScopes.length > 0
    ? wanted.allowedScopes
    : granted.allowedScopes.includes("workspace:read") ? ["workspace:read"] : [];
  const allowedScopes = requestedScopes.filter((scope) => granted.allowedScopes.includes(scope));
  const expiresAt = [wanted.expiresAt, granted.expiresAt]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    allowedScopes: [...new Set(allowedScopes)].sort(),
    targetWhitelist: [...new Set((wanted.targetWhitelist ?? []).filter((target) => granted.targetWhitelist.includes(target)))].sort(),
    allowGitBranchOrWorktree: Boolean(wanted.allowGitBranchOrWorktree) && granted.allowGitBranchOrWorktree,
    allowRedelegation: Boolean(wanted.allowRedelegation) && granted.allowRedelegation,
    ...(expiresAt.length ? { expiresAt: Math.min(...expiresAt) } : {}),
  };
}

export function criterionNeedsEnvironment(criterion: WorkCriterionDto): boolean {
  return criterion.requiresRealEnvironmentCheck || Boolean(criterion.requiredEnvironment?.trim());
}

export function isRequiredCriterion(criterion: WorkCriterionDto): boolean {
  return criterion.origin !== "assistant_proposal";
}

/**
 * A criterion is verified only for the requirement revision in which its own
 * condition was introduced, and only with evidence for the current target input.
 */
export function isCriterionResolved(criterion: WorkCriterionDto): boolean {
  if (criterion.status === "waived") return true;
  return criterion.status === "satisfied" && criterion.verifiedIntentRevision === criterion.requiredIntentRevision;
}
