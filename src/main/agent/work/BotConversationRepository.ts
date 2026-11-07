import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { botMessageSchema, type BotHistoryDto, type BotHistoryRequest, type BotMessageDto, type BotSendReceipt, type BotSendRequest } from "../../../shared/bot-conversation";

const conversationRow = z.object({ conversation_id: z.string(), bot_id: z.string(), user_id: z.string(), revision: z.number(),
  current_request_id: z.string().nullable(), archived_at: z.number().nullable(), created_at: z.number(), updated_at: z.number() });
export type BotConversation = z.infer<typeof conversationRow>;
const receiptRow = z.object({ user_id: z.string(), bot_id: z.string(), request_id: z.string(), payload_hash: z.string(),
  conversation_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string(),
  selected_work_id: z.string().nullable(), reference_message_id: z.string().nullable() });
export type BotMessageReceipt = z.infer<typeof receiptRow>;
const messageRow = z.object({ message_id: z.string(), conversation_id: z.string(), bot_id: z.string(), request_id: z.string(),
  ordinal: z.number(), role: botMessageSchema.shape.role, text: z.string(), status: botMessageSchema.shape.status,
  work_ids_json: z.string(), error: z.string().nullable(), created_at: z.number(), updated_at: z.number() });

export class BotConversationRepository {
  constructor(readonly db: Database.Database) {}

  conversation(userId: string, botId: string, conversationId?: string): BotConversation | undefined {
    const row = conversationId ? this.db.prepare("SELECT * FROM bot_conversations WHERE user_id=? AND bot_id=? AND conversation_id=?").get(userId, botId, conversationId)
      : this.db.prepare("SELECT * FROM bot_conversations WHERE user_id=? AND bot_id=? AND archived_at IS NULL").get(userId, botId);
    return row ? conversationRow.parse(row) : undefined;
  }

  accept(userId: string, input: BotSendRequest): BotSendReceipt {
    const payload = JSON.stringify({ text: input.text, conversationId: input.conversationId ?? null,
      selectedWorkId: input.selectedWorkId ?? null, referenceMessageId: input.referenceMessageId ?? null });
    const hash = createHash("sha256").update(payload).digest("hex");
    const prior = this.receipt(userId, input.botId, input.requestId);
    if (prior) {
      if (prior.payload_hash !== hash) throw new Error("同一消息请求 ID 已用于不同正文或事项引用");
      return { botId: input.botId, conversationId: prior.conversation_id, requestId: input.requestId,
        userMessageId: prior.user_message_id, assistantMessageId: prior.assistant_message_id, replayed: true };
    }
    let conversation = this.conversation(userId, input.botId, input.conversationId);
    if (input.conversationId && !conversation) throw new Error("对话不属于当前用户与 Bot");
    if (conversation?.archived_at) throw new Error("该对话已归档，请开始新对话");
    const now = Date.now();
    if (!conversation) {
      const conversationId = `bot-conversation-${randomUUID()}`;
      this.db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?)")
        .run(conversationId, input.botId, userId, now, now);
      conversation = this.conversation(userId, input.botId, conversationId)!;
    }
    const receipt: BotSendReceipt = { botId: input.botId, conversationId: conversation.conversation_id, requestId: input.requestId,
      userMessageId: `bot-message-${randomUUID()}`, assistantMessageId: `bot-message-${randomUUID()}`, replayed: false };
    const insert = this.db.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    insert.run(receipt.userMessageId, receipt.conversationId, input.botId, input.requestId, "user", input.text, "completed", now, now);
    insert.run(receipt.assistantMessageId, receipt.conversationId, input.botId, input.requestId, "assistant", "", "queued", now, now);
    this.db.prepare(`INSERT INTO bot_send_receipts(user_id,bot_id,request_id,payload_hash,conversation_id,user_message_id,
      assistant_message_id,selected_work_id,reference_message_id) VALUES (?,?,?,?,?,?,?,?,?)`).run(userId, input.botId,
      input.requestId, hash, receipt.conversationId, receipt.userMessageId, receipt.assistantMessageId,
      input.selectedWorkId ?? null, input.referenceMessageId ?? null);
    this.touch(receipt.conversationId);
    return receipt;
  }

  receipt(userId: string, botId: string, requestId: string): BotMessageReceipt | undefined {
    const row = this.db.prepare("SELECT * FROM bot_send_receipts WHERE user_id=? AND bot_id=? AND request_id=?").get(userId, botId, requestId);
    return row ? receiptRow.parse(row) : undefined;
  }

  message(messageId: string): BotMessageDto | undefined {
    const row = this.db.prepare("SELECT * FROM bot_messages WHERE message_id=?").get(messageId);
    return row ? this.mapMessage(row) : undefined;
  }

  history(userId: string, request: BotHistoryRequest): BotHistoryDto {
    const conversation = this.conversation(userId, request.botId, request.conversationId);
    if (!conversation) return { conversationId: "", botId: request.botId, revision: 0, archived: false, messages: [] };
    const rows = this.db.prepare("SELECT * FROM bot_messages WHERE conversation_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT 101")
      .all(conversation.conversation_id, request.before ?? Number.MAX_SAFE_INTEGER);
    const messages = rows.slice(0, 100).map(row => this.mapMessage(row)).reverse();
    return { conversationId: conversation.conversation_id, botId: request.botId, revision: conversation.revision,
      archived: conversation.archived_at !== null, messages, before: rows.length > 100 ? messages[0]?.ordinal : undefined };
  }

  pending(userId: string): BotConversation[] {
    return this.db.prepare(`SELECT DISTINCT c.* FROM bot_conversations c JOIN bot_messages m ON m.conversation_id=c.conversation_id
      WHERE c.user_id=? AND m.role='assistant' AND m.status IN ('queued','running','unknown')`).all(userId).map(row => conversationRow.parse(row));
  }

  next(conversationId: string): BotMessageDto | undefined {
    const row = this.db.prepare(`SELECT * FROM bot_messages WHERE conversation_id=? AND role='assistant'
      AND status IN ('queued','running','unknown') ORDER BY ordinal LIMIT 1`).get(conversationId);
    return row ? this.mapMessage(row) : undefined;
  }

  update(messageId: string, status: BotMessageDto["status"], text: string, error?: string): void {
    const message = this.message(messageId);
    if (!message) throw new Error("消息不存在");
    this.db.prepare("UPDATE bot_messages SET status=?,text=?,error=?,updated_at=? WHERE message_id=?")
      .run(status, text, error ?? null, Date.now(), messageId);
    this.touch(message.conversationId);
  }

  linkWork(receipt: BotMessageReceipt, workId: string): void {
    for (const id of [receipt.user_message_id, receipt.assistant_message_id]) {
      const message = this.message(id)!;
      this.db.prepare("UPDATE bot_messages SET work_ids_json=? WHERE message_id=?")
        .run(JSON.stringify([...new Set([...message.workIds, workId])]), id);
    }
    this.touch(receipt.conversation_id);
  }

  archive(userId: string, botId: string, conversationId: string): void {
    const conversation = this.conversation(userId, botId, conversationId);
    if (!conversation) throw new Error("对话不属于当前用户与 Bot");
    this.db.prepare("UPDATE bot_conversations SET archived_at=? WHERE conversation_id=?").run(Date.now(), conversationId);
    this.touch(conversationId);
  }

  private touch(conversationId: string): void {
    this.db.prepare("UPDATE bot_conversations SET revision=revision+1,updated_at=? WHERE conversation_id=?").run(Date.now(), conversationId);
  }

  private mapMessage(value: unknown): BotMessageDto {
    const row = messageRow.parse(value);
    return { messageId: row.message_id, conversationId: row.conversation_id, botId: row.bot_id, requestId: row.request_id,
      ordinal: row.ordinal, role: row.role, text: row.text, status: row.status,
      workIds: z.array(z.string()).parse(JSON.parse(row.work_ids_json)), error: row.error ?? undefined,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
}
