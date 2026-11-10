import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { botActivitySchema, type BotActivityDto, botAttachmentSchema, type BotAttachmentDto, botMessageSchema, workFeedbackSchema, type WorkFeedbackDto, type BotHistoryDto, type BotHistoryRequest, type BotMessageDto, type BotSendReceipt, type BotSendRequest } from "../../../shared/bot-conversation";
import type { WorkDto } from "../../../shared/bot-work";
import { BOT_MESSAGE_ID_PREFIX } from "../../../shared/bot-conversation";

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

  accept(userId: string, input: BotSendRequest, persistedAttachments: BotAttachmentDto[] = input.attachments ?? []): BotSendReceipt {
    const payload = JSON.stringify({ text: input.text, conversationId: input.conversationId ?? null,
      selectedWorkId: input.selectedWorkId ?? null, referenceMessageId: input.referenceMessageId ?? null,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}) });
    const hash = createHash("sha256").update(payload).digest("hex");
    const prior = this.receipt(userId, input.botId, input.requestId);
    if (prior) {
      if (prior.payload_hash !== hash) throw new Error("同一消息请求 ID 已用于不同正文、附件或事项引用");
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
      userMessageId: `${BOT_MESSAGE_ID_PREFIX}${randomUUID()}`, assistantMessageId: `${BOT_MESSAGE_ID_PREFIX}${randomUUID()}`, replayed: false };
    const insert = this.db.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    insert.run(receipt.userMessageId, receipt.conversationId, input.botId, input.requestId, "user", input.text, "completed", now, now);
    if (persistedAttachments.length) this.db.prepare("INSERT INTO bot_message_attachments(message_id,attachments_json) VALUES (?,?)")
      .run(receipt.userMessageId, JSON.stringify(z.array(botAttachmentSchema).parse(persistedAttachments)));
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

  update(messageId: string, status: BotMessageDto["status"], text: string, error?: string, activity?: BotActivityDto): void {
    this.db.transaction(() => {
      const message = this.message(messageId);
      if (!message) throw new Error("消息不存在");
      this.db.prepare("UPDATE bot_messages SET status=?,text=?,error=?,updated_at=? WHERE message_id=?")
        .run(status, text, error ?? null, Date.now(), messageId);
      if (status === "running" && activity) {
        this.db.prepare("INSERT OR REPLACE INTO bot_message_activity(message_id,activity_json) VALUES (?,?)")
          .run(messageId, JSON.stringify(botActivitySchema.parse(activity)));
      } else this.db.prepare("DELETE FROM bot_message_activity WHERE message_id=?").run(messageId);
      // A persisted user message is completed before its assistant starts. Only the
      // assistant's terminal transition ends the request's read-before-write scope.
      if (message.role === "assistant" && ["completed", "cancelled", "failed"].includes(status)) {
        this.db.prepare("DELETE FROM bot_work_reads WHERE conversation_id=? AND request_id=?")
          .run(message.conversationId, message.requestId);
      }
      this.touch(message.conversationId);
    })();
  }

  /** Prune proven terminal requests on recovery; unknown requests can still resume. */
  pruneTerminalWorkReads(userId: string): number {
    return this.db.prepare(`DELETE FROM bot_work_reads WHERE EXISTS (
      SELECT 1 FROM bot_send_receipts r
      JOIN bot_conversations c ON c.conversation_id=r.conversation_id
      JOIN bot_messages m ON m.message_id=r.assistant_message_id
      WHERE r.user_id=? AND c.user_id=r.user_id AND c.bot_id=r.bot_id
        AND r.conversation_id=bot_work_reads.conversation_id AND r.request_id=bot_work_reads.request_id
        AND m.conversation_id=r.conversation_id AND m.bot_id=r.bot_id AND m.request_id=r.request_id
        AND m.role='assistant' AND m.status IN ('completed','cancelled','failed')
    )`).run(userId).changes;
  }

  /** Work-owned request evidence survives removal of the original Bot/chat. */
  linkWorkUserInput(receipt: BotMessageReceipt, work: WorkDto): void {
    if (!this.db.inTransaction) throw new Error("用户原文必须与委托受理同事务保存");
    if (work.userId !== receipt.user_id || !this.conversation(receipt.user_id, receipt.bot_id, receipt.conversation_id))
      throw new Error("委托与用户原文不属于同一用户和会话");
    const current = this.message(receipt.user_message_id);
    if (!current || current.role !== "user" || current.botId !== receipt.bot_id
      || current.conversationId !== receipt.conversation_id || current.requestId !== receipt.request_id)
      throw new Error("缺少可核验的原始用户输入");
    // Retain the unresolved dialogue, including clarification answers. A prior
    // delegated request is a boundary, not an excuse to copy another Work's chat.
    const boundary = this.db.prepare(`SELECT MAX(ordinal) AS ordinal FROM bot_messages
      WHERE conversation_id=? AND role='user' AND ordinal<? AND json_array_length(work_ids_json)>0`)
      .get(receipt.conversation_id, current.ordinal) as { ordinal: number | null };
    const run = this.db.prepare('SELECT context_json FROM bot_request_runs WHERE message_id=?').get(receipt.assistant_message_id) as { context_json: string } | undefined;
    // New concurrent requests have no implicit adjacency relationship. Only the
    // current input is delegated; explicit reply references are retained separately.
    const sourceIds = run ? new Set<string>() : undefined;
    const dialogue = this.db.prepare(`SELECT m.* FROM bot_messages m
      JOIN bot_send_receipts r ON r.conversation_id=m.conversation_id AND r.bot_id=m.bot_id AND r.request_id=m.request_id
        AND r.user_id=? AND (r.user_message_id=m.message_id OR r.assistant_message_id=m.message_id)
      WHERE m.conversation_id=? AND m.ordinal>? AND m.ordinal<=? ORDER BY m.ordinal`)
      .all(receipt.user_id, receipt.conversation_id, boundary.ordinal ?? 0, current.ordinal).map(row => this.mapMessage(row))
      .filter(message => !sourceIds || message.messageId === current.messageId || sourceIds.has(message.messageId));
    const compact = (message: BotMessageDto) => ({ messageId: message.messageId, conversationId: message.conversationId,
      role: message.role, text: message.text, ordinal: message.ordinal,
      intentRevision: work.intentRevision, sourceVersion: work.sourceVersion,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}) });
    const reference = receipt.reference_message_id ? this.message(receipt.reference_message_id) : undefined;
    const references = reference?.botId === receipt.bot_id && reference.conversationId === receipt.conversation_id
      && reference.ordinal < current.ordinal ? [compact(reference)] : [];
    if (references.length && reference?.role === 'assistant') {
      const original = this.receipt(receipt.user_id, receipt.bot_id, reference.requestId);
      const originalUser = original && this.message(original.user_message_id);
      if (originalUser && originalUser.ordinal < current.ordinal) references.unshift(compact(originalUser));
    }
    this.db.prepare(`INSERT OR IGNORE INTO bot_work_user_inputs(work_id,source_message_id,intent_revision,source_version,messages_json,references_json)
      VALUES (?,?,?,?,?,?)`).run(work.workId, current.messageId, work.intentRevision, work.sourceVersion,
        JSON.stringify(dialogue.map(compact)), JSON.stringify(references));
  }

  /** Immutable input attachment snapshot, independent of human-readable goal length. */
  linkWorkAttachments(receipt: BotMessageReceipt, workId: string, inputSnapshotId: string, previousSnapshotId?: string): void {
    const existing = this.db.prepare("SELECT attachments_json FROM bot_work_attachments WHERE work_id=? AND input_snapshot_id=?")
      .get(workId, previousSnapshotId ?? inputSnapshotId) as { attachments_json: string } | undefined;
    const current = this.message(receipt.user_message_id);
    const reference = receipt.reference_message_id ? this.message(receipt.reference_message_id) : undefined;
    const referenced = reference?.botId === receipt.bot_id && reference.conversationId === receipt.conversation_id ? reference.attachments ?? [] : [];
    const source = this.db.prepare("SELECT messages_json,references_json FROM bot_work_user_inputs WHERE work_id=? AND source_message_id=?")
      .get(workId, receipt.user_message_id) as { messages_json: string; references_json: string } | undefined;
    const contextAttachments = source ? [source.messages_json, source.references_json].flatMap(value =>
      z.array(z.object({ attachments: z.array(botAttachmentSchema).optional() })).parse(JSON.parse(value))
        .flatMap(message => message.attachments ?? [])) : [];
    const inherited = existing ? z.array(botAttachmentSchema).parse(JSON.parse(existing.attachments_json)) : [];
    const attachments = [...new Map([...inherited, ...contextAttachments, ...(current?.attachments ?? []), ...referenced].map(item => [item.path, item])).values()];
    if (attachments.length) this.db.prepare("INSERT OR IGNORE INTO bot_work_attachments(work_id,input_snapshot_id,attachments_json) VALUES (?,?,?)")
      .run(workId, inputSnapshotId, JSON.stringify(attachments));
  }

  linkWork(receipt: BotMessageReceipt, workId: string): void {
    for (const id of [receipt.user_message_id, receipt.assistant_message_id]) {
      const message = this.message(id)!;
      this.db.prepare("UPDATE bot_messages SET work_ids_json=? WHERE message_id=?")
        .run(JSON.stringify([...new Set([...message.workIds, workId])]), id);
    }
    this.touch(receipt.conversation_id);
  }

  /** Resolve the original authenticated send, never the current owner or active chat. */
  workOrigin(userId: string, workId: string): BotConversation | undefined {
    const row = this.db.prepare(`SELECT c.* FROM bot_send_receipts r
      JOIN bot_conversations c ON c.conversation_id=r.conversation_id AND c.bot_id=r.bot_id AND c.user_id=r.user_id
      JOIN bot_messages m ON m.message_id=r.user_message_id AND m.conversation_id=c.conversation_id
        AND m.bot_id=r.bot_id AND m.request_id=r.request_id AND m.role='user'
      JOIN works w ON w.work_id=? AND w.user_id=r.user_id
      WHERE r.user_id=? AND (
        m.message_id=w.source_message_id OR EXISTS (
          SELECT 1 FROM json_each(m.work_ids_json) j WHERE j.value=w.work_id
        )
      ) ORDER BY m.ordinal LIMIT 1`).get(workId, userId);
    return row ? conversationRow.parse(row) : undefined;
  }

  /** The message itself is the delivery receipt: append and revision commit together.
   * Event identity is scoped to this Work, not a mutable owner/intent version. A
   * changed version after a previous delivery gets a new message, including a
   * blocker reopening after its cleared version was delivered.
   */
  appendWorkFeedback(origin: BotConversation, workId: string, event: string, version: string, text: string, metadata?: WorkFeedbackDto): boolean {
    return this.db.transaction(() => {
      if (!this.conversation(origin.user_id, origin.bot_id, origin.conversation_id)) return false;
      const key = createHash("sha256").update(JSON.stringify([workId, event])).digest("hex");
      const prefix = `work-feedback:${key}:`;
      const fingerprint = createHash("sha256").update(version).digest("hex");
      const previous = this.db.prepare(`SELECT message_id,request_id FROM bot_messages
        WHERE conversation_id=? AND bot_id=? AND role='assistant' AND message_id LIKE 'work-feedback-%' AND request_id LIKE ? ORDER BY ordinal DESC LIMIT 1`)
        .get(origin.conversation_id, origin.bot_id, `${prefix}%`) as { message_id: string; request_id: string } | undefined;
      const unchanged = previous?.request_id.endsWith(`:${fingerprint}`);
      let annotated = false;
      if (metadata) {
        // Backfill only authenticated host-generated identities from this exact
        // event. Older versions remain expandable history, never deleted or
        // reinterpreted from their human-written text.
        const legacy = this.db.prepare(`SELECT m.message_id FROM bot_messages m
          LEFT JOIN bot_work_feedback f ON f.message_id=m.message_id
          WHERE m.conversation_id=? AND m.bot_id=? AND m.role='assistant' AND m.message_id LIKE 'work-feedback-%'
            AND m.request_id LIKE ? AND f.message_id IS NULL`).all(origin.conversation_id, origin.bot_id, `${prefix}%`) as { message_id: string }[];
        for (const item of legacy) annotated = this.saveFeedbackMetadata(item.message_id,
          unchanged && item.message_id === previous?.message_id ? metadata : { ...metadata, report: undefined, category: "progress" }) || annotated;
      }
      if (unchanged) {
        // Upgrade only the exact unchanged event version. Never attach today's
        // result body/files to an older report, and never emit another message.
        if (metadata?.report && previous) {
          const saved = this.db.prepare("SELECT metadata_json FROM bot_work_feedback WHERE message_id=?")
            .get(previous.message_id) as { metadata_json: string } | undefined;
          if (saved) {
            const existing = workFeedbackSchema.parse(JSON.parse(saved.metadata_json));
            // Repair resolved file labels/targets after a re-execution. The event
            // fingerprint is unchanged and resolution is scoped to its binding;
            // preserve the saved report body and never substitute current files.
            const upgraded = !existing.report ? metadata : { ...existing,
              report: { ...existing.report, files: metadata.report.files } };
            const json = JSON.stringify(workFeedbackSchema.parse(upgraded));
            if (json !== saved.metadata_json) {
              this.db.prepare("UPDATE bot_work_feedback SET metadata_json=? WHERE message_id=?")
                .run(json, previous.message_id);
              annotated = true;
            }
          }
        }
        if (annotated) this.touch(origin.conversation_id);
        return false;
      }
      const generation = createHash("sha256").update(previous?.message_id ?? "initial").digest("hex").slice(0, 16);
      const requestId = `${prefix}${generation}:${fingerprint}`;
      const messageId = `work-feedback-${createHash("sha256").update(JSON.stringify([origin.conversation_id, requestId])).digest("hex")}`;
      const now = Date.now();
      this.db.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,work_ids_json,created_at,updated_at)
        VALUES (?,?,?,?,'assistant',?,'completed',?,?,?)`)
        .run(messageId, origin.conversation_id, origin.bot_id, requestId, text, JSON.stringify([workId]), now, now);
      if (metadata) this.saveFeedbackMetadata(messageId, metadata);
      this.touch(origin.conversation_id);
      return true;
    })();
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

  private saveFeedbackMetadata(messageId: string, metadata: WorkFeedbackDto): boolean {
    const json = JSON.stringify(workFeedbackSchema.parse(metadata));
    return this.db.prepare("INSERT OR IGNORE INTO bot_work_feedback(message_id,metadata_json) VALUES (?,?)").run(messageId, json).changes > 0;
  }

  private mapMessage(value: unknown): BotMessageDto {
    const row = messageRow.parse(value);
    const version = this.db.prepare('SELECT revision FROM bot_message_revisions WHERE message_id=?').get(row.message_id) as { revision: number } | undefined;
    const attachmentRow = this.db.prepare("SELECT attachments_json FROM bot_message_attachments WHERE message_id=?").get(row.message_id) as { attachments_json: string } | undefined;
    const attachments = attachmentRow ? z.array(botAttachmentSchema).parse(JSON.parse(attachmentRow.attachments_json)) : undefined;
    const metadata = this.db.prepare("SELECT metadata_json FROM bot_work_feedback WHERE message_id=?").get(row.message_id) as { metadata_json: string } | undefined;
    const parsed = metadata ? workFeedbackSchema.safeParse(JSON.parse(metadata.metadata_json)) : undefined;
    const activityRow = row.status === "running" ? this.db.prepare("SELECT activity_json FROM bot_message_activity WHERE message_id=?")
      .get(row.message_id) as { activity_json: string } | undefined : undefined;
    const activity = activityRow ? botActivitySchema.safeParse(JSON.parse(activityRow.activity_json)) : undefined;
    return { messageRevision: version?.revision ?? 0, messageId: row.message_id, conversationId: row.conversation_id, botId: row.bot_id, requestId: row.request_id,
      workFeedback: parsed?.success ? parsed.data : undefined, attachments, activity: activity?.success ? activity.data : undefined,
      ordinal: row.ordinal, role: row.role, text: row.text, status: row.status,
      workIds: z.array(z.string()).parse(JSON.parse(row.work_ids_json)), error: row.error ?? undefined,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
}
