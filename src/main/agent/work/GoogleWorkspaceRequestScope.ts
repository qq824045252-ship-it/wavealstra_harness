import type Database from "better-sqlite3";
import { LiveDoc, type ToolRegistration } from "@earendil-works/pi-durable";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { BotMessageDto } from "../../../shared/bot-conversation";
import type { BotMessageReceipt } from "./BotConversationRepository";
import { durableSourceUserMessageId } from "../durable/DurableInputProvenance";

export type WorkspaceRequestScopeResolver = (api: Parameters<ToolRegistration["execute"]>[1], context: Parameters<ToolRegistration["execute"]>[2]) => Promise<string>;
export function workspaceUserRequestScope(userId: string, sourceMessageId: string): string {
  if (!userId.trim() || !sourceMessageId.trim()) throw new Error("Google 写操作缺少可信原始用户消息；未执行。");
  return JSON.stringify([userId, sourceMessageId]);
}
export function foregroundWorkspaceScope(userId: string, botId: string, conversationId: string, requestId: string,
  receipt: BotMessageReceipt | undefined, user: BotMessageDto | undefined, assistant: BotMessageDto | undefined): string {
  if (!receipt || receipt.user_id !== userId || receipt.bot_id !== botId || receipt.conversation_id !== conversationId || receipt.request_id !== requestId
    || !user || user.messageId !== receipt.user_message_id || user.role !== "user" || user.botId !== botId || user.conversationId !== conversationId || user.requestId !== requestId
    || !assistant || assistant.messageId !== receipt.assistant_message_id || assistant.role !== "assistant" || assistant.botId !== botId || assistant.conversationId !== conversationId || assistant.requestId !== requestId
    || !["queued", "running", "unknown"].includes(assistant.status)) throw new Error("Google 写操作的原始用户消息不可核对；未执行。");
  return workspaceUserRequestScope(userId, receipt.user_message_id);
}
/** Versioned host Work bindings preserve the same source across new tasks and Bots. */
export function workWorkspaceScope(db: Database.Database, userId: string, taskId: string, binding: WorkExecutionBindingDto, work: WorkDto | undefined): string {
  if (!work || work.userId !== userId || binding.taskId !== taskId || binding.workId !== work.workId || binding.invalidatedAt
    || work.lifecycle !== "active" || ["completed", "failed", "stopped", "invalidated"].includes(binding.status)
    || binding.intentRevision !== work.intentRevision || binding.inputSnapshotId !== work.inputSnapshotId || binding.ownerEpoch !== work.ownerEpoch)
    throw new Error("Google 写操作的 Work 来源已失效；未执行。");
  // An amendment may retain its input without a new source_message_id. Resolve
  // only snapshots of this exact persisted input, never the newest arbitrary message.
  const sources = db.prepare(`SELECT DISTINCT r.user_message_id FROM work_intent_snapshots s
    JOIN bot_send_receipts r ON r.user_message_id=s.source_message_id AND r.user_id=?
    JOIN bot_messages m ON m.message_id=r.user_message_id AND m.role='user'
      AND m.bot_id=r.bot_id AND m.conversation_id=r.conversation_id AND m.request_id=r.request_id
    WHERE s.work_id=? AND s.input_snapshot_id=? AND s.intent_revision<=?`).all(userId, work.workId, binding.inputSnapshotId, binding.intentRevision) as Array<{user_message_id: string}>;
  if (sources.length !== 1) throw new Error("Google 写操作无法核对 Work 的唯一原始用户输入；未执行。");
  return workspaceUserRequestScope(userId, sources[0].user_message_id);
}
export function durableWorkspaceScope(userId: string): WorkspaceRequestScopeResolver {
  return async (api, context) => {
    const conversationId = await api.commit(async tx => {
      let id = api.conversationId;
      const visited = new Set<typeof id>();
      while (!visited.has(id)) {
        visited.add(id);
        const conversation = await tx.conversation(id);
        if (!conversation) throw new Error("Google 写操作缺少宿主对话；未执行。");
        if (!conversation.owner) return id;
        id = conversation.owner.conversationId;
      }
      throw new Error("Google 写操作来源链无效；未执行。");
    }, context);
    const live = await api.snapshot(LiveDoc, conversationId, context);
    const source = await durableSourceUserMessageId(api, context, conversationId, live?.run?.inputs ?? []);
    if (!source) throw new Error("Google 写操作缺少唯一原始用户输入；未执行。");
    return workspaceUserRequestScope(userId, source);
  };
}
