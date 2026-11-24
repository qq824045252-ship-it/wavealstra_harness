import { z } from "zod";
import { PROJECT_CHECK_NAME_PATTERN } from "../../../shared/project-check";
import { DOTS_WORK_ITEM_ID_PATTERN } from "../../dots/DotsWorkerOutcome";

export const DOTS_TASK_END = "dots_task_end";

const dependency = z.object({
  operationId: z.string().min(1),
  title: z.string(),
  deadlineAt: z.number().int().positive(),
});

export const dotsWorkEvidenceSchema = z.array(z.strictObject({
  id: z.string().regex(new RegExp(DOTS_WORK_ITEM_ID_PATTERN)),
  evidence: z.string().trim().min(1).max(1800),
})).max(48);

const outcome = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete"), result: z.string(), deliveryText: z.string(),
    verifiedCommit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
    completedItems: dotsWorkEvidenceSchema.optional(),
    verifiedChecks: z.array(z.string().regex(new RegExp(PROJECT_CHECK_NAME_PATTERN))).max(25).optional() }),
  z.object({ action: z.literal("wait"), progress: z.string(), dependencyWait: dependency }),
]);
const receipt = z.object({ dotsTerminal: z.object({ operationId: z.string(), outcome }) });

export type DotsTerminalDependency = z.infer<typeof dependency>;
export type DotsTerminalOutcome = z.infer<typeof outcome>;

export function readDotsTerminalReceipt(details: unknown) {
  return receipt.safeParse(details).data?.dotsTerminal;
}
