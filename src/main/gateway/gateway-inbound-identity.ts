import { createHash, randomUUID } from "node:crypto";

/** Versioned, account-bound native identity. Old unscoped tasks are retained, not adopted:
 * their account cannot be proved, so reconnecting starts a fresh native conversation.
 * Public account identity (not rotating credentials) keeps retries stable across restart.
 */
export function gatewayInboundIdentity(channelId: string, connectionKey: string, chatId: string, messageId?: string): {
  taskId: string; turnId: string;
} {
  if (!channelId.trim() || !chatId.trim() || !/^[a-f0-9]{64}$/.test(connectionKey)) {
    throw new Error("Gateway 缺少已核验的会话账号身份");
  }
  const scope = ["gateway-inbound-v2", channelId, connectionKey, chatId];
  const hash = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return { taskId: `gw-bot-account-${hash(scope)}`,
    turnId: messageId ? hash([...scope, messageId]) : randomUUID() };
}
