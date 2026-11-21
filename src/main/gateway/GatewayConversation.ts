import { createHash } from "node:crypto";
import type { GatewayBotOrigin } from "../agent/work/BotTurnOrigins";

/** New conversations never adopt retired gw-bot histories or share a group sender's context. */
export function gatewayConversationId<T extends Pick<GatewayBotOrigin, "channelId" | "connectionKey" | "chatId" | "senderId">>(origin: T): string {
  if (!origin.channelId?.trim() || !origin.chatId?.trim() || !origin.senderId?.trim()
    || !/^[a-f0-9]{64}$/.test(origin.connectionKey)) throw new Error("渠道对话缺少已核验的账号、会话或发送者身份");
  return `gateway-chat-${createHash("sha256").update(JSON.stringify([
    "conversation-v1", origin.channelId, origin.connectionKey, origin.chatId, origin.senderId,
  ])).digest("hex")}`;
}
export { isGatewayConversation } from "../../shared/gateway-task";
