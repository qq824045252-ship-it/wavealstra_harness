import { z } from "zod";
import type { WorkBlockerDto } from "./bot-work";

/** User decisions always carry the complete snapshot the user reviewed. */
const text = z.string().trim().min(1).max(200);
const versionGuard = z.object({
  expectedStateVersion: z.number().int().nonnegative(),
  expectedIntentRevision: z.number().int().positive(),
  expectedOwnerEpoch: z.number().int().positive(),
}).strict();
const decision = { operationId: text, workId: text, versionGuard };

export const workReviewControlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept_deliverable"), request: z.object({
    ...decision, deliverableId: text,
  }).strict() }).strict(),
  z.object({ kind: z.literal("reject_deliverable"), request: z.object({
    ...decision, deliverableId: text, reason: z.string().trim().min(1).max(2000),
  }).strict() }).strict(),
  z.object({ kind: z.literal("feedback"), request: z.object({
    ...decision, criterionIds: z.array(text).min(1).max(100),
    environment: z.string().trim().min(1).max(200),
    sourceRef: z.string().trim().min(1).max(2000),
    inputSnapshotId: z.string().min(1).max(2000),
    artifactSnapshotId: z.string().min(1).max(2000).optional(),
    failed: z.boolean(), detail: z.string().trim().max(8000).optional(),
  }).strict() }).strict(),
  z.object({ kind: z.literal("attest_criteria"), request: z.object({
    ...decision, inputSnapshotId: z.string().min(1).max(2000), artifactSnapshotId: z.string().min(1).max(2000).optional(),
    criterionUpdates: z.array(z.object({ criterionId: text, status: z.enum(["met", "not_met"]),
      evidence: z.string().trim().min(1).max(2000) }).strict()).min(1).max(100),
  }).strict() }).strict(),
  z.object({ kind: z.literal("reply_user_input"), request: z.object({
    ...decision, blockerId: text, blockerSnapshot: z.string().min(1).max(8000),
    inputSnapshotId: z.string().min(1).max(2000), reply: z.string().trim().min(1).max(2000),
    evidenceRef: z.string().trim().min(1).max(2000),
  }).strict() }).strict(),
  z.object({ kind: z.literal("reply_legacy_user_input"), request: z.object({
    ...decision, blockerId: text, reportOperationId: text, blockerSnapshot: z.string().min(1).max(8000),
    inputSnapshotId: z.string().min(1).max(2000), reply: z.string().trim().min(1).max(2000),
    evidenceRef: z.string().trim().min(1).max(2000), confirmedInformationOnly: z.literal(true),
  }).strict() }).strict(),
  z.object({ kind: z.literal("cover_not_started"), request: z.object({
    ...decision, factIds: z.array(text).min(1).max(100), deliverableId: text,
    criterionIds: z.array(text).min(1).max(100), inputSnapshotId: z.string().min(1).max(2000),
    artifactSnapshotId: z.string().min(1).max(2000).optional(),
    reason: z.string().trim().min(1).max(2000), confirmed: z.literal(true),
  }).strict() }).strict(),
  z.object({ kind: z.literal("close"), request: z.object({
    ...decision, conclusion: z.enum(["succeeded", "cancelled", "ended_unsuccessfully"]),
    closureSummary: z.string().trim().min(1).max(2000),
    confirmed: z.literal(true),
  }).strict() }).strict(),
]);
export type WorkReviewControlRequest = z.input<typeof workReviewControlSchema>;

/** Only explicitly typed information requests can be answered here. Operational,
 * resource and unknown-effect blockers must use their own guarded controls. */
export function userInputBlockerSnapshot(blocker: WorkBlockerDto): string | undefined {
  if (blocker.kind !== "operational" || blocker.reasonCode !== "user-input" || !blocker.waitingForUserInput
    || blocker.unknownExternalEffectRef || !blocker.sourceRef || blocker.subscriptionId
    || blocker.causalChainId) return undefined;
  const parsed = z.object({ kind: z.literal("reply"), inputSnapshotId: z.string().min(1).max(2000),
    intentRevision: z.number().int().positive(), ownerEpoch: z.number().int().positive(),
  }).strict().safeParse(blocker.details?.userInput);
  if (!parsed.success) return undefined;
  return JSON.stringify({ blockerId: blocker.blockerId, sourceRef: blocker.sourceRef,
    createdAt: blocker.createdAt, reason: blocker.reason, userInput: parsed.data });
}
export type ReplyUserInputParams = Extract<WorkReviewControlRequest, { kind: "reply_user_input" }>["request"];

export type ReplyLegacyUserInputParams = Extract<WorkReviewControlRequest, { kind: "reply_legacy_user_input" }>["request"];

export type CoverNotStartedParams = Extract<WorkReviewControlRequest, { kind: "cover_not_started" }>["request"];
