import { z } from "zod";
import { continuationWorkSchema } from "./bot-work-phase3";
import { workCollaborationInputSchema } from "./bot-work-collaboration";
import type { WorkControlResult, WorkDto } from "./bot-work";

const text = z.string().min(1).max(200);
export const handoffWorkSchema = z.object({ operationId: text, workId: text, targetBotId: text,
  preparationId: text.optional(), delegatedScope: z.array(text).max(32).optional(),
  versionGuard: continuationWorkSchema.shape.versionGuard }).strict();
export const retryResourceRecoverySchema = z.object({
  operationId: text, workId: text, token: z.number().int().positive(),
  expectedAttempts: z.number().int().positive(), expectedExhaustedAt: z.number().int().nonnegative(),
  confirmEnvironmentSafe: z.literal(true), versionGuard: continuationWorkSchema.shape.versionGuard,
}).strict();
export type RetryResourceRecoveryParams = z.infer<typeof retryResourceRecoverySchema>;
export const workPhase3ControlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continue"), request: continuationWorkSchema }).strict(),
  z.object({ kind: z.literal("handoff"), request: handoffWorkSchema }).strict(),
  z.object({ kind: z.literal("prepare_handoff"), workId: text, targetBotId: text }).strict(),
  z.object({ kind: z.literal("collaborate"), request: workCollaborationInputSchema }).strict(),
  z.object({ kind: z.literal("retry_resource_recovery"), request: retryResourceRecoverySchema }).strict(),
]);
export type WorkPhase3ControlRequest = z.input<typeof workPhase3ControlSchema>;
export type WorkPhase3ControlResult = WorkControlResult
  | { ok: true; preparation: { preparationId: string; work: WorkDto; bindingIds: string[] } }
  | { ok: true; messageId: string; replayed: boolean };
