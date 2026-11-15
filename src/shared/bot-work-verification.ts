import { z } from "zod";

export const WORK_VERIFICATION_MAX_CHECKS = 32;
export const WORK_VERIFICATION_MAX_REFS = 8;
const identity = z.string().trim().min(1).max(200);

/** Display-only evidence frozen for one result review; never a new decision,
 * user requirement, permission, or claim that the current environment was tested. */
export const workVerificationSchema = z.object({
  version: z.literal(1),
  workId: identity, executionId: identity,
  intentRevision: z.number().int().positive(), inputSnapshotId: z.string().min(1).max(2000),
  ownerEpoch: z.number().int().positive(),
  reviewedAt: z.string().datetime().optional(), historicalExecution: z.boolean(),
  checks: z.array(z.object({
    id: z.string().min(1).max(240), kind: z.enum(["criterion", "artifact"]),
    origin: z.enum(["task_requirement", "assistant_proposal"]).optional(),
    label: z.string().min(1).max(1000),
    state: z.enum(["verified", "unverified", "failed", "waived", "read", "empty", "changed", "unavailable"]),
    summary: z.string().min(1).max(1000), limitations: z.array(z.string().max(1000)).max(8),
    evidenceRefs: z.array(z.string().min(1).max(4000)).max(WORK_VERIFICATION_MAX_REFS),
    omittedEvidenceRefs: z.number().int().nonnegative(),
  }).strict()).max(WORK_VERIFICATION_MAX_CHECKS),
  omittedCount: z.number().int().nonnegative(),
}).strict();

export type WorkVerificationDto = z.infer<typeof workVerificationSchema>;
export type WorkVerificationCheck = WorkVerificationDto["checks"][number];

export function workVerificationMatches(verification: WorkVerificationDto,
  target: Pick<WorkVerificationDto, "workId" | "executionId" | "intentRevision" | "inputSnapshotId" | "ownerEpoch">): boolean {
  return verification.workId === target.workId && verification.executionId === target.executionId
    && verification.intentRevision === target.intentRevision && verification.inputSnapshotId === target.inputSnapshotId
    && verification.ownerEpoch === target.ownerEpoch;
}
