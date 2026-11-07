import { z } from "zod";
import type { WorkClosureConclusion, WorkCriterionStatus, WorkLifecycle, WorkNotificationDelivery } from "./bot-work";

/**
 * Phase 5 contracts: stable semantic result cards, external delivery capability,
 * card read facts, and the layered summary/diagnostics projections.
 *
 * Identities here are the ones written by the host. A card is a projection of an
 * already-committed acceptance fact, never a second Work state: it carries no
 * lifecycle, owner, budget or execution authority.
 */

export const WORK_RESULT_CARD_KINDS = [
  "accepted_result",
  "closure_succeeded",
  "closure_cancelled",
  "closure_failed",
  "blocked_escalation",
  "owner_summary",
] as const;
export type WorkResultCardKind = (typeof WORK_RESULT_CARD_KINDS)[number];
export const workResultCardKindSchema = z.enum(WORK_RESULT_CARD_KINDS);

/** Ordering of a result relative to the current requirement. */
export const workCardCurrencySchema = z.enum(["current", "historical", "superseded"]);
export type WorkCardCurrency = z.infer<typeof workCardCurrencySchema>;

export interface WorkResultCardDto {
  cardKey: string;
  semanticCardKey: string;
  workId: string;
  userId: string;
  kind: WorkResultCardKind;
  intentRevision: number;
  inputSnapshotId: string;
  /** Owner epoch that produced the fact; evidence only, never the current owner. */
  originOwnerEpoch: number;
  canonicalOutcomeHash: string;
  /** Previous distinct owner summary; presentation linkage never changes semantic identity. */
  previousCardKey?: string;
  ownerSummary?: WorkOwnerSummaryPayload;
  title: string;
  summary: string;
  deliverableIds: string[];
  evidenceIds: string[];
  sourceRefs: string[];
  artifactRefs: string[];
  unverifiedScope: string[];
  createdAt: number;
  currency: WorkCardCurrency;
  readAt?: number;
  readByUserId?: string;
  readVersion: number;
  /** Linked notification intents (one card may have several channel/scope intents). */
  notificationIds: string[];
}

/** A member report remains a report until the current owner/user accepts its deliverable. */
export const workOwnerSummaryItemSchema = z.object({
  key: z.string(),
  kind: z.enum(["accepted", "reported", "awaiting_review", "blocked", "question", "rejected", "error", "awaiting_environment", "authorization"]),
  botId: z.string().optional(),
  text: z.string(),
  artifactRefs: z.array(z.string()),
  criterionIds: z.array(z.string()),
  writeConflicts: z.array(z.string()),
  isError: z.boolean(),
}).strict();
export type WorkOwnerSummaryItem = z.infer<typeof workOwnerSummaryItemSchema>;

/** Sorted substantive member outcomes; clocks, delivery attempts and message IDs stay outside. */
export const workOwnerSummaryPayloadSchema = z.object({
  version: z.literal(1),
  items: z.array(workOwnerSummaryItemSchema),
  waitingForBotIds: z.array(z.string()),
  pendingDecisionKeys: z.array(z.string()),
}).strict();
export type WorkOwnerSummaryPayload = z.infer<typeof workOwnerSummaryPayloadSchema>;

/**
 * Canonical, versioned outcome payload. Display titles and delivery wording,
 * notification attempts, read clocks, wall time and owner epoch stay outside.
 * Owner summaries include normalized member-report content: identical whitespace
 * rewrites are one fact, while a changed report can carry new substance.
 */
export interface WorkOutcomePayload {
  version: 1;
  kind: WorkResultCardKind;
  workId: string;
  intentRevision: number;
  inputSnapshotId: string;
  conclusion?: WorkClosureConclusion;
  deliverables: Array<{ deliverableId: string; artifactRefs: string[]; evidenceRefs: string[]; uncoveredCriterionIds: string[] }>;
  criteria: Array<{ id: string; status: WorkCriterionStatus; requiredIntentRevision: number; evidenceRefs: string[] }>;
  sourceRefs: string[];
  artifactRefs: string[];
  /** Stable reason codes of blockers that still require a human decision. */
  pendingBlockerCodes: string[];
  ownerSummary?: WorkOwnerSummaryPayload;
}

/** Deterministic serialisation: sorted keys, no whitespace, explicit array order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Length-prefixed tuple encoding; free text never concatenates into an ambiguous key. */
export function encodeSemanticTuple(parts: ReadonlyArray<string | number>): string {
  const encoded = parts.map(part => {
    const text = String(part);
    return `${text.length}:${text}`;
  });
  return `v1|${encoded.join("|")}`;
}

export interface SemanticCardInput {
  workId: string;
  intentRevision: number;
  inputSnapshotId: string;
  kind: WorkResultCardKind;
  canonicalOutcomeHash: string;
}

/** The five-part semantic identity of a result card. */
export function semanticCardTuple(input: SemanticCardInput): string {
  return encodeSemanticTuple([
    "work-result-card",
    input.workId,
    input.intentRevision,
    input.inputSnapshotId,
    input.kind,
    input.canonicalOutcomeHash,
  ]);
}

// ------------------------------------------------------------------ delivery

/**
 * What the external endpoint can actually prove. `idempotent-queryable` supports both
 * a reusable effect key and a receipt read-back; `idempotent-unqueryable` can only replay
 * the original key; `best-effort-unqueryable` can do neither.
 */
export const workDeliveryGuaranteeSchema = z.enum([
  "idempotent-queryable",
  "idempotent-unqueryable",
  "best-effort-unqueryable",
]);
export type WorkDeliveryGuarantee = z.infer<typeof workDeliveryGuaranteeSchema>;

export interface WorkChannelCapability {
  deliveryGuarantee: WorkDeliveryGuarantee;
  supportsIdempotencyKey: boolean;
  supportsReceiptQuery: boolean;
}

/** Guarantee and the two independent capabilities must not contradict each other. */
export function capabilityOfGuarantee(guarantee: WorkDeliveryGuarantee): WorkChannelCapability {
  return {
    deliveryGuarantee: guarantee,
    supportsIdempotencyKey: guarantee !== "best-effort-unqueryable",
    supportsReceiptQuery: guarantee === "idempotent-queryable",
  };
}

export function capabilityIsConsistent(capability: WorkChannelCapability): boolean {
  if (capability.supportsReceiptQuery && !capability.supportsIdempotencyKey) return false;
  if (capability.deliveryGuarantee === "idempotent-queryable") return capability.supportsIdempotencyKey && capability.supportsReceiptQuery;
  if (capability.deliveryGuarantee === "idempotent-unqueryable") return capability.supportsIdempotencyKey && !capability.supportsReceiptQuery;
  return !capability.supportsIdempotencyKey && !capability.supportsReceiptQuery;
}

/** Recovery decision for one unresolved delivery attempt. */
export type WorkDeliveryRecoveryAction =
  | "settle-sent"
  | "safe-resend-same-effect"
  | "stay-unknown"
  | "manual-resend-only";

export function deliveryRecoveryAction(input: {
  lookup: "delivered" | "missing" | "unknown" | "unavailable";
  capability: WorkChannelCapability;
}): WorkDeliveryRecoveryAction {
  const { lookup, capability } = input;
  if (lookup === "delivered") return "settle-sent";
  if (lookup === "unknown") return "stay-unknown";
  // Confirmed not delivered, or the endpoint cannot report at all: only a contract that
  // promises replay safety may resend, and only under the original effect key.
  return capability.supportsIdempotencyKey ? "safe-resend-same-effect" : "stay-unknown";
}

export const workManualResendRequestSchema = z.object({
  operationId: z.string().min(1).max(200),
  workId: z.string().min(1),
  notificationId: z.string().min(1),
  reason: z.string().trim().min(1).max(1000),
  acknowledgedDuplicateRisk: z.literal(true),
  versionGuard: z.object({
    expectedStateVersion: z.number().int().nonnegative().optional(),
    expectedIntentRevision: z.number().int().positive().optional(),
    expectedOwnerEpoch: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();
export type WorkManualResendRequest = z.input<typeof workManualResendRequestSchema>;

export interface WorkDeliveryAttemptDto {
  attemptId: string;
  notificationId: string;
  ordinal: number;
  channel: string;
  providerEffectKey: string;
  payloadHash: string;
  guarantee: WorkDeliveryGuarantee;
  claimGeneration: number;
  status: "unknown" | "sent" | "missing" | "failed";
  claimedAt: number;
  settledAt?: number;
  receipt?: string;
}

// -------------------------------------------------------------- read facts

export const workCardReadRequestSchema = z.object({
  workId: z.string().min(1),
  semanticCardKey: z.string().min(1).max(200),
  /** Host clock wins; a client clock may only move the watermark backwards safely. */
  readAt: z.number().int().nonnegative().optional(),
}).strict();
export type WorkCardReadRequest = z.input<typeof workCardReadRequestSchema>;

export interface WorkCardReadResult {
  ok: boolean;
  message?: string;
  cardKey?: string;
  semanticCardKey?: string;
  readAt?: number;
  readVersion?: number;
  replayed?: boolean;
}

// ------------------------------------------------------------- projections

/** Why a criterion is not verified against the current artifact. */
export const workUnverifiedReasonSchema = z.enum([
  "auto_verified",
  "user_verified",
  "pending_real_environment",
  "historical_version_only",
  "artifact_changed",
  "no_evidence",
]);
export type WorkUnverifiedReason = z.infer<typeof workUnverifiedReasonSchema>;

export interface WorkUnverifiedScopeDto {
  criterionId: string;
  text: string;
  reason: WorkUnverifiedReason;
  requiredEnvironment?: string;
  /** Versioned evidence: what the evidence actually covered. */
  intentRevision?: number;
  inputSnapshotId?: string;
  artifactSnapshotId?: string;
  evidenceIds: string[];
}

/** Main view: decision-shaped, no ledgers. */
export interface WorkSummaryProjectionDto {
  workId: string;
  title: string;
  goal?: string;
  lifecycle: WorkLifecycle;
  /** Authoritative closure state; result-card kinds retain their original identity. */
  closureConclusion?: WorkClosureConclusion;
  mode: "once" | "watch";
  ownerBotId: string;
  ownerEpoch: number;
  intentRevision: number;
  inputSnapshotId: string;
  /** Current artifact identity required when submitting real-environment feedback. */
  artifactSnapshotId?: string;
  stateVersion: number;
  acceptedCount: number;
  currentCardKeys: string[];
  currentConclusion?: string;
  pendingUserDecisions: string[];
  nextSteps: string[];
  unverifiedScope: WorkUnverifiedScopeDto[];
  delivery: Array<{
    notificationId: string;
    cardKey?: string;
    kind: "result" | "blocked" | "closed" | "handoff" | "summary";
    state: WorkNotificationDelivery;
    /** Honest wording for a delivery that cannot be reconciled automatically. */
    externalStatus: "not_requested" | "in_app_only" | "waiting_receipt" | "delivered" | "unconfirmed_no_auto_retry" | "failed";
    attemptCount: number;
    readAt?: number;
  }>;
  updatedAt: number;
  closedAt?: number;
}

export interface WorkDiagnosticsSection<T> {
  items: T[];
  truncated: boolean;
  /** Facts the host could not read; shown as gaps, never as a pass. */
  missing?: string[];
  nextCursor?: string;
}

/** Expanded view: versioned evidence, read on demand with bounded pages. */
export interface WorkExpandedDiagnosticsDto {
  workId: string;
  intentRevision: number;
  inputSnapshotId: string;
  stateVersion: number;
  artifactSnapshotId?: string;
  /** Opaque resume token when any section has more rows. */
  nextCursor?: string;
  requirements: WorkDiagnosticsSection<{
    intentRevision: number;
    inputSnapshotId: string;
    sourceVersion: number;
    createdAt: number;
    supersededReason?: string;
    deliverableIds: string[];
  }>;
  responsibility: WorkDiagnosticsSection<{
    ownerEpoch: number;
    ownerBotId: string;
    reason?: string;
    at: number;
    adoptionState: "adopted" | "pending" | "missing";
    bindingId?: string;
  }>;
  executions: WorkDiagnosticsSection<{
    bindingId: string;
    taskId: string;
    status: string;
    intentRevision: number;
    inputSnapshotId: string;
    invalidatedAt?: number;
    artifactRefs: string[];
    blocked?: string;
    writeConflicts?: boolean;
    isError?: boolean;
  }>;
  acceptance: WorkDiagnosticsSection<{
    cardKey: string;
    semanticCardKey: string;
    kind: WorkResultCardKind;
    canonicalOutcomeHash: string;
    currency: WorkCardCurrency;
    createdAt: number;
    deliverableIds: string[];
    evidenceIds: string[];
    readAt?: number;
  }>;
  resources: WorkDiagnosticsSection<{
    kind: "lease" | "wait" | "recovery" | "subscription" | "causal" | "budget";
    ref: string;
    state: string;
    detail?: string;
    at?: number;
  }>;
  delivery: WorkDiagnosticsSection<WorkDeliveryAttemptDto>;
  unverifiedScope: WorkUnverifiedScopeDto[];
}

export const workDiagnosticsRequestSchema = z.object({
  workId: z.string().min(1),
  sections: z.array(z.enum(["requirements", "responsibility", "executions", "acceptance", "resources", "delivery"])).max(6).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(400).optional(),
}).strict();
export type WorkDiagnosticsRequest = z.input<typeof workDiagnosticsRequestSchema>;

export function externalDeliveryStatus(input: {
  delivery: WorkNotificationDelivery;
  capability?: WorkChannelCapability;
  attemptCount: number;
}): WorkSummaryProjectionDto["delivery"][number]["externalStatus"] {
  if (input.delivery === "sent") return "delivered";
  if (input.delivery === "failed") return "failed";
  if (input.attemptCount === 0) return "in_app_only";
  if (input.delivery === "pending") return "not_requested";
  return input.capability?.supportsReceiptQuery || input.capability?.supportsIdempotencyKey
    ? "waiting_receipt"
    : "unconfirmed_no_auto_retry";
}
