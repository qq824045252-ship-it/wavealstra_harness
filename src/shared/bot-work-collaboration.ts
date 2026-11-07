import { z } from "zod";

export const workExecutionReferenceSchema = z.object({
  bindingId: z.string().min(1), taskId: z.string().min(1), durableStoreKey: z.string().min(1),
  conversationId: z.string().min(1), workspaceBinding: z.string().min(1),
}).strict();
export const workCollaborationInputSchema = z.object({
  messageId: z.string().min(1).max(200), workId: z.string().min(1),
  kind: z.enum(["delegate", "accepted", "question", "result", "blocked", "change", "cancel", "handoff"]),
  recipientBotIds: z.array(z.string().min(1)).min(1).max(32),
  body: z.string().min(1).max(8000), replyToMessageId: z.string().optional(),
  causalMessageId: z.string().optional(), artifactRefs: z.array(z.string()).max(128).default([]),
  executionRefs: z.array(workExecutionReferenceSchema).max(64).default([]),
  versionGuard: z.object({ expectedStateVersion: z.number().int().nonnegative(),
    expectedIntentRevision: z.number().int().positive(), expectedOwnerEpoch: z.number().int().positive() }).strict(),
}).strict();
export type WorkCollaborationInput = z.input<typeof workCollaborationInputSchema>;
export type WorkCollaborationMessage = z.output<typeof workCollaborationInputSchema> & {
  senderBotId: string | null; senderKind: "user" | "bot" | "worker"; userId: string;
  intentRevision: number; inputSnapshotId: string; ownerEpoch: number; createdAt: number;
};
export interface WorkNotificationIdentity {
  inputSnapshotId: string; ownerEpoch: number; senderBotId: string;
  semanticValidity: "active" | "superseded" | "cancelled";
}
