import { createHash } from "node:crypto";
import type { AgentPromptRequest } from "../../shared/agent-ipc";
import type { GatewayBotOrigin } from "../agent/work/BotTurnOrigins";

/** New conversations never adopt retired gw-bot histories or share a group sender's context. */
export function gatewayConversationId(origin: GatewayBotOrigin): string {
  if (!origin.channelId?.trim() || !origin.chatId?.trim() || !origin.senderId?.trim()
    || !/^[a-f0-9]{64}$/.test(origin.connectionKey)) throw new Error("渠道对话缺少已核验的账号、会话或发送者身份");
  return `gateway-chat-${createHash("sha256").update(JSON.stringify([
    "conversation-v1", origin.channelId, origin.connectionKey, origin.chatId, origin.senderId,
  ])).digest("hex")}`;
}
export function isGatewayConversation(id: string): boolean { return /^gateway-chat-[a-f0-9]{64}$/.test(id); }

/** Explicit allowlist, not object spreading: no local selections, paths, expert or scope can cross this boundary. */
export function conversationalRequest(request: AgentPromptRequest): AgentPromptRequest {
  return { taskId: request.taskId, text: request.text + (request.attachments?.length ? "\n\n[渠道附件未读取：当前助理只支持文字对话。]" : ""), displayText: request.displayText ?? request.text,
    userMessageId: request.userMessageId, assistantMessageId: request.assistantMessageId,
    modelId: request.modelId, welcomeMode: "general", modePresetId: "native",
    permissionMode: "readonly", streamingBehavior: "followUp" };
}
export const GATEWAY_CONVERSATION_INSTRUCTIONS = "你是渠道对话助理。只根据当前发送者在本会话提供的文字回答。你没有本机文件、终端、浏览器、外部操作、个人记忆或项目资料访问能力，也没有工具。不能声称执行了操作或读取了附件。需要这些能力时明确说明当前仅支持文字对话。";
