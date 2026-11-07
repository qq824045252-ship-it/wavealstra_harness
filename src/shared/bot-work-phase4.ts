import { z } from "zod";
import type { ExpectedVersionGuard, WorkCatchUpPolicy } from "./bot-work";

/** One injected clock for Work control, ingress, dispatch, scheduling and budgets. */
export interface WorkClock {
  now(): number;
  /** Monotonic elapsed observation; used to separate wall-clock jumps from real waiting. */
  monotonicMs?(): number;
}

export const workVersionModeSchema = z.enum(["monotonic", "provider-sequence", "readback", "none"]);
export type WorkVersionMode = z.infer<typeof workVersionModeSchema>;

export const workDstPolicySchema = z.enum(["first-valid", "first-occurrence"]);
export type WorkDstPolicy = z.infer<typeof workDstPolicySchema>;

/** Declared by a trusted source adapter; the ingress never guesses a global order. */
export interface WorkSourceAdapterCapability {
  source: string;
  /** Connection/repository scope; the same event id under another namespace is another fact. */
  namespace: string;
  versionMode: WorkVersionMode;
  targetKeyOf(input: { eventType: string; payload: Record<string, unknown> }): string;
  compareVersion?(left: string, right: string): number | undefined;
  canQueryHistory: boolean;
  supportsRetry: boolean;
  maxPayloadBytes: number;
}

export interface WorkSubscriptionMonitorDto {
  subscriptionId: string;
  workId: string;
  source: string;
  targetKey?: string;
  status: "online" | "paused" | "offline" | "stopped" | "closing";
  catchUpPolicy: WorkCatchUpPolicy;
  timezone?: string;
  cronExpression?: string;
  scheduleRevision: number;
  configRevision: number;
  nextWakeAt?: number;
  lastCheckedAt?: number;
  versionMode: WorkVersionMode;
  queue: {
    ready: number;
    frozen: number;
    blocked: number;
    bytes: number;
    maxEvents: number;
    maxBytes: number;
    oldestAt?: number;
    mergeDeadlineAt?: number;
    readySince?: number;
    waitReason?: string;
  };
  cursors: Array<{
    source: string;
    targetKey: string;
    highestAcceptedVersion?: string;
    highestConsumedVersion?: string;
    highestFrozenVersion?: string;
    replayCursor?: string;
    enumerationWatermark?: string;
  }>;
}

export interface WorkOfflineGapDto {
  gapId: string;
  subscriptionId?: string;
  workId?: string;
  offlineGapFrom: number;
  offlineGapTo: number;
  detectedBy: string;
  confidence: "evidence" | "inferred";
  policy: WorkCatchUpPolicy;
  policyRevision: number;
  queryable: boolean;
  recoveredCount: number;
  mergedCount: number;
  skippedCount?: number;
  unknownCount?: number;
  state: "open" | "recovering" | "recovered" | "unqueryable";
  gapReason?: string;
}

export interface WorkBudgetWindowDto {
  windowId: string;
  policyRevision: number;
  scope: "work" | "window";
  periodStartAt: number;
  periodEndAt?: number;
  timezone?: string;
  limitTokens: number;
  committedTokens: number;
  reservedTokens: number;
  unknownTokens: number;
  unknownUsageCount: number;
  availableTokens: number;
  autoRollover: boolean;
  carryPolicy: "none" | "outstanding";
  status: "open" | "closed" | "exhausted";
  pendingRollover?: string;
}

export interface WorkCausalMonitorDto {
  chainId: string;
  rootEventId: string;
  parentChainId?: string;
  originWorkId: string;
  targetWorkId: string;
  depth: number;
  hops: number;
  dispatchCount: number;
  decision: "admitted" | "blocked-loop" | "blocked-depth" | "blocked-hops" | "blocked-budget" | "unknown-attribution";
  reasonCode?: string;
  createdAt: number;
}

export interface WorkWatchHostStateDto {
  authorityId?: string;
  sessionId?: string;
  online: boolean;
  lastScanAt?: number;
  lastScanCursor?: string;
  activeSince?: number;
  stoppedAt?: number;
  suspendEvidence?: string;
}

export interface WorkPhase4Projection {
  subscriptions: WorkSubscriptionMonitorDto[];
  offlineGaps: WorkOfflineGapDto[];
  budget: WorkBudgetWindowDto;
  causal: WorkCausalMonitorDto[];
  deadlineAt?: number;
  deadlineRevision: number;
  host: WorkWatchHostStateDto;
}

/** Extra subscription configuration accepted only from the guarded host entry. */
export interface WorkSubscriptionPhase4Config {
  targetKey?: string;
  versionMode?: WorkVersionMode;
  dstPolicy?: WorkDstPolicy;
  maxBacklogEvents?: number;
  maxBacklogBytes?: number;
  scheduleRevision?: number;
  configRevision?: number;
}

const optionalNonNegative = z.number().int().min(0).optional();

export const phase4ControlRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("configure-subscription"),
    operationId: z.string().min(1).max(200),
    workId: z.string().min(1),
    subscriptionId: z.string().min(1).max(200).optional(),
    source: z.string().min(1).max(200),
    filter: z.record(z.string(), z.unknown()).optional(),
    catchUpPolicy: z.enum(["latest", "each", "skip"]),
    maxMergeWaitMs: z.number().int().min(0).max(86_400_000).optional(),
    maxQueueDepth: z.number().int().min(1).max(10_000).optional(),
    stopConditionText: z.string().max(1000).optional(),
    timezone: z.string().max(100).optional(),
    cronExpression: z.string().max(200).optional(),
    nextWakeAt: z.number().int().optional(),
    targetKey: z.string().max(400).optional(),
    versionMode: workVersionModeSchema.optional(),
    dstPolicy: workDstPolicySchema.optional(),
    maxBacklogEvents: z.number().int().min(1).max(100_000).optional(),
    maxBacklogBytes: z.number().int().min(1024).max(1_073_741_824).optional(),
    scheduleRevision: z.number().int().min(1).optional(),
    configRevision: z.number().int().min(1).optional(),
    versionGuard: z.object({
      expectedStateVersion: z.number().int().optional(),
      expectedIntentRevision: z.number().int().optional(),
      expectedOwnerEpoch: z.number().int().optional(),
    }).optional(),
  }),
  z.object({
    kind: z.literal("stop-subscription"),
    operationId: z.string().min(1).max(200),
    workId: z.string().min(1),
    subscriptionId: z.string().min(1),
    reason: z.string().max(1000).optional(),
    versionGuard: z.object({
      expectedStateVersion: z.number().int().optional(),
      expectedIntentRevision: z.number().int().optional(),
      expectedOwnerEpoch: z.number().int().optional(),
    }).optional(),
  }),
  z.object({
    kind: z.literal("set-deadline"),
    operationId: z.string().min(1).max(200),
    workId: z.string().min(1),
    deadlineAt: z.number().int().min(0).nullable(),
    versionGuard: z.object({
      expectedStateVersion: z.number().int().optional(),
      expectedIntentRevision: z.number().int().optional(),
      expectedOwnerEpoch: z.number().int().optional(),
    }).optional(),
  }),
  z.object({
    kind: z.literal("set-budget-policy"),
    operationId: z.string().min(1).max(200),
    workId: z.string().min(1),
    maxTokens: z.number().int().min(0),
    windowMs: optionalNonNegative,
    timezone: z.string().max(100).optional(),
    autoRollover: z.boolean().optional(),
    versionGuard: z.object({
      expectedStateVersion: z.number().int().optional(),
      expectedIntentRevision: z.number().int().optional(),
      expectedOwnerEpoch: z.number().int().optional(),
    }).optional(),
  }),
  z.object({
    kind: z.literal("retry-backlog"),
    operationId: z.string().min(1).max(200),
    workId: z.string().min(1),
    subscriptionId: z.string().min(1),
    versionGuard: z.object({
      expectedStateVersion: z.number().int().optional(),
      expectedIntentRevision: z.number().int().optional(),
      expectedOwnerEpoch: z.number().int().optional(),
    }).optional(),
  }),
]);

export type WorkPhase4ControlRequest = z.infer<typeof phase4ControlRequestSchema>;

export type WorkPhase4ControlResult =
  | {
      ok: true;
      replayed: boolean;
      operationId: string;
      workId: string;
      subscriptionId?: string;
      deadlineAt?: number;
      budgetWindowId?: string;
    }
  | { ok: false; code: string; message: string };

export interface WorkPhase4ControlDeps {
  versionGuard?: ExpectedVersionGuard;
}
