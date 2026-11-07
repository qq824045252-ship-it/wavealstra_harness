import { z } from "zod";

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
  z.object({ kind: z.literal("close"), request: z.object({
    ...decision, conclusion: z.enum(["succeeded", "cancelled", "ended_unsuccessfully"]),
    closureSummary: z.string().trim().min(1).max(2000),
    confirmed: z.literal(true),
  }).strict() }).strict(),
]);
export type WorkReviewControlRequest = z.input<typeof workReviewControlSchema>;
