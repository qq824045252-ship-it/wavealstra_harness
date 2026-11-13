import { z } from "zod";

const identifier = z.string().trim().min(1).max(512);
export const gatewayBotBindingSchema = z.object({
  botId: identifier,
  connectionKey: z.string().regex(/^[a-f0-9]{64}$/),
  ownerSenderIds: z.array(identifier).min(1).max(100),
}).strict();
export type GatewayBotBinding = z.infer<typeof gatewayBotBindingSchema>;
export const gatewayBotBindingRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("bind"), channelId: identifier, botId: identifier,
    ownerSenderIds: z.array(identifier).min(1).max(100), connectionRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal("unbind"), channelId: identifier }).strict(),
]);
export type GatewayBotBindingRequest = z.infer<typeof gatewayBotBindingRequestSchema>;
export const GatewayBotBindingIpc = { configure: "gateway:configureBotBinding" } as const;
