import { z } from "zod";

/** Host projection of native plan/result facts; a rejected item has no child. */
export const workSubitemSchema = z.object({
  itemId: z.string().min(1),
  task: z.string(),
  required: z.boolean(),
  dependencies: z.array(z.string()),
  criterionIds: z.array(z.string()),
  nativeStatus: z.string(),
  outcome: z.enum(["completed", "blocked", "rejected", "failed", "stopped", "unknown", "not_started"]),
  childId: z.string().optional(),
  childConversationId: z.string().optional(),
  workspaceBinding: z.string().optional(),
  artifactRefs: z.array(z.string()),
  writeConflicts: z.array(z.string()),
  summary: z.string(),
  isolation: z.enum(["shared", "worktree"]).optional(),
  origin:z.enum(["native","artifact_revalidation"]).optional(),
}).strict();
export type WorkSubitemResult = z.infer<typeof workSubitemSchema>;
export const workExecutionObservationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running"), subitems: z.array(workSubitemSchema).optional() }).strict(),
  z.object({ status: z.enum(["completed", "failed", "stopped"]), summary: z.string(), hasWriteConflicts: z.boolean(),
    artifactRefs: z.array(z.string()), sourceEntryId: z.number().optional(), usageTokens: z.number().nonnegative().optional(),
    subitems: z.array(workSubitemSchema).optional(),readPaths:z.array(z.string()).optional() }).strict(),
]);

const guard = z.object({ expectedStateVersion: z.number().int().positive(), expectedIntentRevision: z.number().int().positive(), expectedOwnerEpoch: z.number().int().positive() }).strict();
export const continuationWorkSchema = z.object({
  operationId: z.string().min(1), workId: z.string().min(1), sourceBindingId: z.string().min(1),
  gapItemIds: z.array(z.string().min(1)).min(1).max(200),
  reason: z.string().min(1).max(2000), versionGuard: guard,
}).strict();
export type ContinuationWorkParams = z.infer<typeof continuationWorkSchema>;
export interface WorkSubitemDto extends WorkSubitemResult {
  /** Host-proven eligibility; not permission to execute or erase a refusal. */
  coverageEligible?: boolean;
  coverage?: { deliverableId: string; criterionIds: string[]; evidenceRefs: string[];
    reason: string; resolvedAt: number; operationId: string };
  factId: string; workId: string; bindingId: string; inputSnapshotId: string; intentRevision: number;
  deliverableId?: string; continuationPlanId?: string; createdAt: number;
}
export interface WorkContinuationDto {
  planId: string; workId: string; sourceBindingId: string; gapItemIds: string[];
  intentRevision: number; inputSnapshotId: string; ownerEpoch: number; ownerBotId: string;
  state: "pending" | "dispatched" | "settled" | "cancelled"; reason: string; createdAt: number;
}

/** Persisted quarantine checks. Retrying never grants or releases the resource. */
export interface WorkResourceRecoveryDto {
  token: number;
  actionId?: string;
  actionDescription?: string;
  taskId?: string;
  workspacePath?: string;
  resourceScope?: string[];
  effectReviewPrepared?: { preparedAt: number; readyAt?: number };
  effectReview?: { conclusion: "not_occurred" | "occurred"; evidence: string; reviewedAt: number };
  resourceKinds: string[];
  attempts: number;
  pendingProbe?: boolean;
  exhaustedAt?: number;
  reason?: string;
}
