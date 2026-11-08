import { z } from "zod";

export const workActionApprovalSchema = z.object({
  approvalId: z.string(), workId: z.string(), bindingId: z.string(), taskId: z.string(), operationId: z.string(),
  actionHash: z.string().optional(),
  toolName: z.string(), summary: z.string(), detail: z.string(), requiredScope: z.string(), scopeMissing: z.boolean(),
  intentRevision: z.number(), inputSnapshotId: z.string(), ownerEpoch: z.number(),
  status: z.enum(["pending", "approved", "denied", "expired", "invalidated", "consumed"]),
  version: z.number(), createdAt: z.number(), expiresAt: z.number(), resolvedAt: z.number().optional(),
  outcome: z.string().optional(),
});
export type WorkActionApprovalDto = z.infer<typeof workActionApprovalSchema>;
export const workActionDecisionSchema = z.object({
  approvalId: z.string().min(1), workId: z.string().min(1), bindingId: z.string().min(1),
  expectedVersion: z.number().int().positive(), expectedStateVersion: z.number().int().positive(),
  expectedIntentRevision: z.number().int().positive(), expectedOwnerEpoch: z.number().int().positive(),
  approved: z.boolean(), grantScopeOnce: z.boolean().default(false),
}).strict();
export type WorkActionDecision = z.infer<typeof workActionDecisionSchema>;
export type WorkActionDecisionResult = { ok: true; approval: WorkActionApprovalDto; replayed: boolean }
  | { ok: false; code: "invalid_request" | "forbidden" | "not_found" | "version_conflict" | "already_resolved"; message: string };
