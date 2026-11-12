/**
 * MyBuddy Memory Kernel — unified long-term memory contract.
 *
 * Memory != Context != Library != Work Graph.
 * - Memory: durable distilled cognition.
 * - Context: per-run projection assembled from Memory + other sources.
 * - Library: source material / evidence.
 * - Work Graph: business/execution relations between durable entities.
 */

export type MemoryKind =
  | "identity"
  | "preference"
  | "fact"
  | "decision"
  | "constraint"
  | "risk"
  | "open_question"
  | "progress"
  | "procedure";

export type MemoryStatus = "active" | "superseded" | "resolved" | "invalid";
export type MemoryScopeType = "global" | "workspace" | "project" | "task" | "bot" | "team" | "conversation" | "work";
export type MemoryScopeBinding = "owned" | "promoted";
export type MemorySourceType = "user" | "agent" | "tool" | "library" | "event" | "manual" | "import";
export type MemoryEvidenceKind =
  | "conversation"
  | "message"
  | "task"
  | "artifact"
  | "library_item"
  | "library_chunk"
  | "project_event"
  | "agent_run"
  | "external";
export type MemoryRelationType = "SUPERSEDES" | "CONTRADICTS" | "SUPPORTS" | "DUPLICATE_OF" | "DERIVED_FROM";
export type MemoryCandidateStatus = "pending" | "committed" | "rejected" | "needs_review";
export type MemorySkillCandidateStatus = "draft" | "ready" | "rejected" | "materialized" | "stale";
export type MemorySkillRevisionStatus = "draft" | "ready" | "rejected" | "materialized" | "stale";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "identity",
  "preference",
  "fact",
  "decision",
  "constraint",
  "risk",
  "open_question",
  "progress",
  "procedure",
] as const;
export const MEMORY_STATUSES: readonly MemoryStatus[] = ["active", "superseded", "resolved", "invalid"] as const;
export const MEMORY_SCOPE_TYPES: readonly MemoryScopeType[] = ["global", "workspace", "project", "task", "bot", "team", "conversation", "work"] as const;
export const MEMORY_EVIDENCE_KINDS: readonly MemoryEvidenceKind[] = [
  "conversation", "message", "task", "artifact", "library_item",
  "library_chunk", "project_event", "agent_run", "external",
] as const;
export const MEMORY_RELATIONS: readonly MemoryRelationType[] = [
  "SUPERSEDES",
  "CONTRADICTS",
  "SUPPORTS",
  "DUPLICATE_OF",
  "DERIVED_FROM",
] as const;

export interface MemoryScopeDto {
  memoryId: string;
  scopeType: MemoryScopeType;
  scopeId?: string;
  binding: MemoryScopeBinding;
  createdAt: number;
}

export interface MemoryEvidenceDto {
  id: string;
  memoryId: string;
  evidenceKind: MemoryEvidenceKind;
  refId: string;
  refTitle?: string;
  excerpt?: string;
  createdAt: number;
}

export interface MemoryRelationDto {
  id: string;
  fromMemoryId: string;
  relation: MemoryRelationType;
  toMemoryId: string;
  createdAt: number;
}

export interface MemoryRevisionDto {
  id: string;
  memoryId: string;
  revision: number;
  kind: MemoryKind;
  title: string;
  content: string;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  validFrom?: number;
  validUntil?: number;
  changedBy: MemorySourceType;
  changeReason?: string;
  createdAt: number;
}

export interface MemoryRecordDto {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  explicit: boolean;
  sourceType: MemorySourceType;
  sourceId?: string;
  sourceTaskId?: string;
  validFrom?: number;
  validUntil?: number;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  lastRecalledAt?: number;
  recallCount: number;
  metadata: Record<string, unknown>;
  scopes: MemoryScopeDto[];
  evidence: MemoryEvidenceDto[];
  relations: MemoryRelationDto[];
}

export interface MemoryEvidenceInput {
  evidenceKind: MemoryEvidenceKind;
  refId: string;
  refTitle?: string;
  excerpt?: string;
}

export interface MemoryCreateRequest {
  kind: MemoryKind;
  title: string;
  content?: string;
  status?: MemoryStatus;
  importance?: number;
  confidence?: number;
  explicit?: boolean;
  sourceType?: MemorySourceType;
  sourceId?: string;
  sourceTaskId?: string;
  validFrom?: number;
  validUntil?: number;
  metadata?: Record<string, unknown>;
  scopeType: MemoryScopeType;
  scopeId?: string;
  evidence?: MemoryEvidenceInput[];
}

export interface MemoryUpdateRequest {
  id: string;
  kind?: MemoryKind;
  title?: string;
  content?: string;
  status?: MemoryStatus;
  importance?: number;
  confidence?: number;
  explicit?: boolean;
  validFrom?: number | null;
  validUntil?: number | null;
  metadata?: Record<string, unknown>;
  changedBy?: MemorySourceType;
  changeReason?: string;
}

export interface MemorySearchRequest {
  /** Injected by a trusted Bot context. Ordinary task tools do not accept this field. */
  botId?: string;
  /** Trusted host bindings, never accepted from an ordinary task tool. */
  teamId?: string;
  conversationId?: string;
  workId?: string;
  query?: string;
  taskId?: string;
  projectId?: string;
  workspaceId?: string;
  scopeTypes?: MemoryScopeType[];
  kinds?: MemoryKind[];
  statuses?: MemoryStatus[];
  includeInherited?: boolean;
  limit?: number;
}

/** Cross-scope browse filter for the settings Memory explorer (not task-relative like search). */
export interface MemoryListRequest {
  query?: string;
  /** Optional exact identity within scopeType, applied before pagination. */
  scopeId?: string;
  scopeType?: MemoryScopeType;
  kind?: MemoryKind;
  status?: MemoryStatus;
  limit?: number;
  offset?: number;
}

export interface MemorySearchHit {
  memory: MemoryRecordDto;
  score: number;
  reasons: string[];
  scopeDistance: number;
}

export interface MemoryContextItem {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  scopeType: MemoryScopeType;
  scopeId?: string;
  importance: number;
  confidence: number;
  score: number;
  reasons: string[];
}

export interface ResolvedMemoryContext {
  items: MemoryContextItem[];
  text: string;
  query: string;
  budgetChars: number;
  includedChars: number;
  trimmed: boolean;
  scenarioIds?: string[];
  profileIds?: string[];
}

export interface MemoryCandidateDto {
  id: string;
  taskId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  scopeType: MemoryScopeType;
  scopeId?: string;
  confidence: number;
  importance: number;
  explicit: boolean;
  operationHint: "create" | "update" | "supersede" | "resolve" | "forget";
  replaces?: string;
  status: MemoryCandidateStatus;
  rawJson?: string;
  createdAt: number;
  resolvedAt?: number;
}

export type MemoryTurnExtractionState = "pending" | "processing" | "completed" | "failed" | "skipped";

export interface MemoryProcedureExecutionDto {
  version: 1;
  completed: true;
  tools: Array<{ toolCallId: string; name: string; arguments: string; result: string }>;
}

export interface MemorySkillLearningStatusDto {
  procedures: number;
  reusableProcedures: number;
  failedTurns: number;
  retryableFailedTurns: number;
  pendingTurns: number;
  latestError?: string;
  blockedSkills: Array<{ id: string; title: string; reason: string }>;
}

/** L0 raw conversation evidence. It is source material, not durable cognition. */
export interface MemoryTurnDto {
  id: string;
  taskId: string;
  taskTitle?: string;
  taskTrashed?: boolean;
  sessionId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  userText: string;
  assistantText: string;
  contentHash: string;
  capturedAt: number;
  extractionState: MemoryTurnExtractionState;
  extractedAt?: number;
  attemptCount: number;
  lastError?: string;
  metadata: Record<string, unknown>;
}

export interface MemoryTurnListRequest {
  taskId?: string;
  extractionState?: MemoryTurnExtractionState;
  query?: string;
  limit?: number;
}

export interface MemoryTurnTaskDto { id: string; title: string; trashed: boolean }

export interface MemoryExtractionRunResult {
  processedTurns: number;
  failedTurns: number;
  skippedTasks: number;
  interrupted: boolean;
}

export interface MemoryPipelineStateDto {
  taskId: string;
  capturedTurns: number;
  turnsSinceL1: number;
  lastL1At?: number;
  lastL2At?: number;
  lastL3At?: number;
  l1RunCount: number;
  l2RunCount: number;
  l3RunCount: number;
  updatedAt: number;
}

/** L2 derived scenario projection. MemoryRecord remains the L1 truth. */
export interface MemoryScenarioDto {
  id: string;
  scopeType: "global" | "workspace" | "project";
  scopeId?: string;
  title: string;
  summary: string;
  status: "active" | "stale";
  sourceMemoryIds: string[];
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

/** L2/L3 projection dismissed by the user; suppressed until restored and regenerated. */
export interface MemoryDismissedProjectionDto {
  id: string;
  kind: "scenario" | "profile";
  title: string;
  scopeType: "global" | "workspace" | "project";
  scopeId?: string;
  dismissedAt: number;
}

/** Pending/rejected L2/L3 generation output awaiting manual approval. */
export interface MemoryProjectionProposalDto {
  id: string;
  kind: "scenario" | "profile";
  scopeType: "global" | "workspace" | "project";
  scopeId?: string;
  title: string;
  body: string;
  sourceIds: string[];
  targetId: string;
  status: "pending" | "rejected";
  createdAt: number;
  updatedAt: number;
}

/** Hard-delete live/history projections, their dismissal records, or specific proposals. */
export interface MemoryProjectionDeleteRequest {
  kind: "scenario" | "profile";
  all?: boolean;
  targetIds?: string[];
  proposalIds?: string[];
}

export interface MemoryProjectionDeleteResult {
  projections: number;
  dismissals: number;
  proposals: number;
  invalidatedProfiles: number;
  dependentProposals: number;
}

export type MemorySkillInvocationKind = "read" | "command";
export type MemorySkillOutcome = "pending" | "completed" | "failed" | "aborted";
export type MemorySkillFeedbackKind = "helpful" | "needs_revision" | "incorrect";

export interface MemorySkillEffectivenessDto {
  id: string;
  taskId: string;
  taskTitle?: string;
  assistantMessageId: string;
  skillId: string;
  candidateId?: string;
  sourceMemoryIds: string[];
  exposedAt: number;
  invokedAt?: number;
  invocationKind?: MemorySkillInvocationKind;
  toolCallId?: string;
  outcome: MemorySkillOutcome;
  outcomeAt?: number;
  feedbackKind?: MemorySkillFeedbackKind;
  feedbackNote?: string;
  feedbackAt?: number;
  updatedAt: number;
}

export interface MemorySkillEffectivenessSummaryDto {
  skillId: string;
  candidateId?: string;
  exposures: number;
  invocations: number;
  completedInvocations: number;
  failedInvocations: number;
  abortedInvocations: number;
  helpfulFeedback: number;
  needsRevisionFeedback: number;
  incorrectFeedback: number;
  adoptionRate: number;
  completionRate: number;
  correctionRate: number;
  lastInvokedAt?: number;
}

export interface MemorySkillRevisionCandidateDto {
  id: string;
  skillId: string;
  baseCandidateId?: string;
  baseVersion: string;
  baseContentHash: string;
  title: string;
  status: MemorySkillRevisionStatus;
  issueSummary: string;
  baseDescription: string;
  baseInstructions: string;
  proposedDescription: string;
  proposedInstructions: string;
  negativeFeedbackIds: string[];
  sourceMemoryIds: string[];
  feedbackSignature: string;
  needsRevisionCount: number;
  incorrectCount: number;
  failedInvocationCount: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  materializedCandidateId?: string;
  materializedVersion?: string;
}

export interface MemorySkillCandidateDto {
  id: string;
  slug: string;
  title: string;
  description: string;
  instructions: string;
  status: MemorySkillCandidateStatus;
  scopeType: "global" | "workspace" | "project" | "bot";
  scopeId?: string;
  sourceMemoryIds: string[];
  sourceSignature: string;
  supportCount: number;
  distinctTaskCount: number;
  completedTaskCount: number;
  evidenceCount: number;
  confidence: number;
  score: number;
  installedSkillId?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

/** Delete obsolete/rejected learning snapshots; installed and pending records are protected. */
export interface MemorySkillHistoryDeleteRequest {
  kind: "candidate" | "revision";
  all?: boolean;
  ids?: string[];
}

/** L3 stable high-level profile projection. */
export interface MemoryCoreProfileDto {
  id: string;
  scopeType: "global" | "workspace" | "project";
  scopeId?: string;
  title: string;
  content: string;
  status: "active" | "stale";
  sourceScenarioIds: string[];
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryKernelStats {
  total: number;
  active: number;
  byKind: Record<string, number>;
  byScope: Record<string, number>;
  candidates: Record<string, number>;
  recalled: number;
  l0Turns: number;
  pendingTurns: number;
  failedTurns: number;
  scenarios: number;
  coreProfiles: number;
  skillCandidates: number;
  readySkillCandidates: number;
  skillExposures: number;
  skillInvocations: number;
  skillNegativeFeedback: number;
  skillRevisionCandidates: number;
  readySkillRevisionCandidates: number;
}

export const MEMORY_TITLE_MAX_CHARS = 240;
export const MEMORY_CONTENT_MAX_CHARS = 6000;
export const MEMORY_CONTEXT_DEFAULT_BUDGET = 5000;
export const MEMORY_CONTEXT_HARD_BUDGET = 9000;

export const MemoryIpc = {
  list: "memory:list",
  turns: "memory:turns",
  turnTasks: "memory:turnTasks",
  deleteAllTurns: "memory:deleteAllTurns",
  deleteTurns: "memory:deleteTurns",
  getTurn: "memory:getTurn",
  memoriesForTurn: "memory:memoriesForTurn",
  search: "memory:search",
  get: "memory:get",
  create: "memory:create",
  update: "memory:update",
  forget: "memory:forget",
  promote: "memory:promote",
  detachScope: "memory:detachScope",
  retryFailedTurns: "memory:retryFailedTurns",
  extractPendingTurns: "memory:extractPendingTurns",
  dismissProjection: "memory:dismissProjection",
  deleteProjectionRecords: "memory:deleteProjectionRecords",
  restoreProjection: "memory:restoreProjection",
  dismissedProjections: "memory:dismissedProjections",
  generateL2Proposals: "memory:generateL2Proposals",
  generateL3Proposals: "memory:generateL3Proposals",
  projectionProposals: "memory:projectionProposals",
  approveProjectionProposal: "memory:approveProjectionProposal",
  rejectProjectionProposal: "memory:rejectProjectionProposal",
  restoreProjectionProposal: "memory:restoreProjectionProposal",
  history: "memory:history",
  candidates: "memory:candidates",
  resolveCandidate: "memory:resolveCandidate",
  stats: "memory:stats",
  scenarios: "memory:scenarios",
  coreProfiles: "memory:coreProfiles",
  skillCandidates: "memory:skillCandidates",
  skillLearningStatus: "memory:skillLearningStatus",
  deleteSkillHistory: "memory:deleteSkillHistory",
  refreshSkillCandidates: "memory:refreshSkillCandidates",
  approveSkillCandidate: "memory:approveSkillCandidate",
  rejectSkillCandidate: "memory:rejectSkillCandidate",
  skillEffectiveness: "memory:skillEffectiveness",
  skillEffectivenessSummary: "memory:skillEffectivenessSummary",
  setSkillFeedback: "memory:setSkillFeedback",
  skillRevisionCandidates: "memory:skillRevisionCandidates",
  refreshSkillRevisionCandidates: "memory:refreshSkillRevisionCandidates",
  approveSkillRevisionCandidate: "memory:approveSkillRevisionCandidate",
  rejectSkillRevisionCandidate: "memory:rejectSkillRevisionCandidate",
  reindexSemantic: "memory:reindexSemantic",
} as const;
