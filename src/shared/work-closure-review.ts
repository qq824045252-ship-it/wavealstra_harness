import { z } from "zod";

/** A normal user request for read-only review, never an asserted outcome. */
export const workClosureReviewRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(120),
  workId: z.string().trim().min(1).max(200),
  expectedCloseOperationId: z.string().trim().min(1).max(200),
  versionGuard: z.object({
    expectedStateVersion: z.number().int().nonnegative(),
    expectedIntentRevision: z.number().int().positive(),
    expectedOwnerEpoch: z.number().int().positive(),
  }).strict(),
}).strict();
export type WorkClosureReviewRequest = z.infer<typeof workClosureReviewRequestSchema>;
