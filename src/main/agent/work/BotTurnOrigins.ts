import { z } from "zod";
import { gatewayWorkTargetSchema } from "../../gateway/work-outbound";

const identifier = z.string().trim().min(1).max(1000);
export const gatewayBotOriginSchema = z.object({
  channelId: identifier, connectionKey: z.string().regex(/^[a-f0-9]{64}$/),
  chatId: identifier, senderId: identifier, messageId: identifier,
  audience: z.enum(["private", "shared"]), personalMemoryBindingId: z.string().uuid().optional(), workTarget: gatewayWorkTargetSchema.optional(),
}).strict();
export type GatewayBotOrigin = z.infer<typeof gatewayBotOriginSchema>;
