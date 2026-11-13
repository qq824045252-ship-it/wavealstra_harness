import { z } from "zod";

const id = z.string().trim().min(1).max(500);
const time = z.number().int().nonnegative();
const target = z.object({ botId: id, displayName: z.string() }).strict();
const receipt = z.object({
  receiptId: id,
  step: z.enum(["discovery", "creation", "configuration", "contact"]),
  status: z.enum(["started", "succeeded", "failed", "unknown"]),
  createdAt: time,
  summary: z.string(),
}).strict();
export { receipt as botOrganizationReceiptSchema };
const base = z.object({
  organizationId: id,
  sourceBotId: id,
  sourceDisplayName: z.string(),
  sourceConversationId: id,
  sourceRequestId: id,
  sourceUserMessageId: id,
  sourceAssistantMessageId: id,
  createdAt: time,
  updatedAt: time,
  summary: z.string(),
  receipts: z.array(receipt).max(40),
  totalReceipts: z.number().int().nonnegative(),
}).strict();
const intent = base.extend({
  kind: z.literal("intent"),
  intentId: id,
  /** Read-model only: the linked collaboration's current Work title. It is joined
   * when a message is read, so a Work rename never rewrites an organization receipt. */
  taskTitle: z.string().trim().min(1).max(2000).optional(),
  times: z.object({
    searchedAt: time.nullable(),
    botCreatedAt: time.nullable(),
    configuredAt: time.nullable(),
    contactStartedAt: time.nullable(),
    linkedAt: time.nullable(),
  }).strict(),
});
const intentSchema = z.discriminatedUnion("phase", [
  intent.extend({ phase: z.literal("creating"), target: z.null(), collaborationId: z.null() }),
  intent.extend({ phase: z.literal("creation_failed"), target: z.null(), collaborationId: z.null() }),
  intent.extend({ phase: z.literal("configuring"), target, collaborationId: z.null() }),
  intent.extend({ phase: z.literal("configuration_failed"), target, collaborationId: z.null() }),
  intent.extend({ phase: z.literal("ready"), target, collaborationId: z.null() }),
  intent.extend({ phase: z.literal("contacting"), target, collaborationId: z.null() }),
  intent.extend({ phase: z.literal("contact_unknown"), target, collaborationId: z.null() }),
  intent.extend({ phase: z.literal("contact_failed"), target, collaborationId: z.null() }),
  intent.extend({ phase: z.literal("linked"), target, collaborationId: id }),
]);

/** Host-persisted management facts; these receipts are not bilateral messages. */
export const botOrganizationSummarySchema = z.discriminatedUnion("kind", [
  base.extend({
    kind: z.literal("discovery"),
    status: z.enum(["running", "succeeded", "failed", "unknown"]),
    matchedBotCount: z.number().int().nonnegative().nullable(),
    searchedAt: time.nullable(),
  }),
  intentSchema,
]);
export type BotOrganizationSummaryDto = z.infer<typeof botOrganizationSummarySchema>;
