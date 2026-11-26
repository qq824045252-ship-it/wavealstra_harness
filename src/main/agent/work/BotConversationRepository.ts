import { botClarificationSchema } from "../../../shared/bot-conversation";
import { botOrganizationsForMessage } from "./BotOrganizationProjection";
import { BotForegroundMetricsStore } from "./BotForegroundMetrics";
import { BotPeerCallRepository } from "./BotPeerCallRepository";
import { BotCollaborationRepository } from "./BotCollaborationRepository";
import { botInboxId, ensurePersonalConversation, ensureTeamConversation } from "./WorkDeliveryTargets";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { botActivitySchema, botReplySegmentSchema, type BotReplySegment, type BotActivityDto, botAttachmentSchema, type BotAttachmentDto, botMessageSchema, workFeedbackSchema, type WorkFeedbackDto, type BotHistoryDto, type BotHistoryRequest, type BotMessageDto, type BotSendReceipt, type BotSendRequest } from "../../../shared/bot-conversation";
import type { WorkDto } from "../../../shared/bot-work";
import { BOT_MESSAGE_ID_PREFIX } from "../../../shared/bot-conversation";
import { BotTurnOrigins } from "./BotTurnOrigins";
import { BotPeerIngress } from "./BotPeerIngress";
import { projectBotMemoryHistory } from "./BotMemoryHistoryProjection";
import { botDelegationSourceSchema, type BotDelegationSource } from "./BotDelegationSources";
import { settleBotCapabilityTools } from "./BotCapabilityPresentation";
import { delegatedFeedbackText, delegatedReplyWorkIds, reconcileDelegatedFeedback } from "./BotDelegatedTaskProjection";
import type { ChatToolCallDto } from "../../../shared/agent-ipc";
import type { RuntimeBotHistoryFacts, RuntimeBotHistoryPage } from "./BotHistoryData";
import { enqueueWorkOp, overlayDelete, overlayFindAll, overlayHasTable, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites, workDomainInTx, workDomainRunTx } from "./WorkDomainRuntime";

const conversationRow = z.object({ conversation_id: z.string(), bot_id: z.string(), team_id: z.string().nullable().optional(), user_id: z.string(), revision: z.number(),
  current_request_id: z.string().nullable(), archived_at: z.number().nullable(), created_at: z.number(), updated_at: z.number() });
export type BotConversation = z.infer<typeof conversationRow>;
const receiptRow = z.object({ user_id: z.string(), bot_id: z.string(), request_id: z.string(), payload_hash: z.string(),
  conversation_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string(),
  selected_work_id: z.string().nullable(), reference_message_id: z.string().nullable() });
export type BotMessageReceipt = z.infer<typeof receiptRow>;
const messageRow = z.object({ message_id: z.string(), conversation_id: z.string(), bot_id: z.string(), request_id: z.string(),
  ordinal: z.number(), role: botMessageSchema.shape.role, text: z.string(), status: botMessageSchema.shape.status,
  work_ids_json: z.string(), error: z.string().nullable(), created_at: z.number(), updated_at: z.number() });
type MessageRow = z.infer<typeof messageRow>;

export class BotConversationRepository {
  readonly metrics: BotForegroundMetricsStore;
  readonly peerCalls: BotPeerCallRepository;
  readonly collaborations: BotCollaborationRepository;
  readonly origins: BotTurnOrigins;
  readonly peers: BotPeerIngress;
  constructor(readonly db: Database.Database) {
    this.metrics = new BotForegroundMetricsStore(db);
    this.peerCalls = new BotPeerCallRepository(db);
    this.collaborations = new BotCollaborationRepository(db);
    this.origins = new BotTurnOrigins(db);
    this.peers = new BotPeerIngress(db);
    if (db.readonly) return;
    // Additive presentation storage: existing conversations need no destructive schema reset.
    db.exec(`CREATE TABLE IF NOT EXISTS bot_message_segments (
      message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      segments_json TEXT NOT NULL CHECK(json_valid(segments_json))
    );
    CREATE TABLE IF NOT EXISTS bot_message_tools (
      message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      tools_json TEXT NOT NULL CHECK(json_valid(tools_json))
    );
    CREATE TABLE IF NOT EXISTS bot_clarification_answers (
      question_message_id TEXT NOT NULL REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL, answer_message_id TEXT NOT NULL REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      PRIMARY KEY(question_message_id,goal_id));
    CREATE INDEX IF NOT EXISTS idx_bot_messages_conversation_ordinal ON bot_messages(conversation_id,ordinal);
    CREATE INDEX IF NOT EXISTS idx_bot_messages_conversation_request ON bot_messages(conversation_id,request_id);
    CREATE INDEX IF NOT EXISTS idx_bot_peer_inputs_assistant ON bot_peer_inputs(assistant_message_id);
    CREATE INDEX IF NOT EXISTS idx_bot_collaboration_requests_assistant ON bot_collaboration_requests(assistant_message_id);`);
  }

  private getConvRaw(conversationId: string): Record<string, unknown> | undefined {
    return overlayReadOne(this.db, "bot_conversations", conversationId, () =>
      this.db.prepare("SELECT * FROM bot_conversations WHERE conversation_id=?").get(conversationId) as Record<string, unknown> | undefined);
  }

  private getMessageRaw(messageId: string): Record<string, unknown> | undefined {
    return overlayReadOne(this.db, "bot_messages", messageId, () =>
      this.db.prepare("SELECT * FROM bot_messages WHERE message_id=?").get(messageId) as Record<string, unknown> | undefined);
  }

  private listMessagesForConversation(conversationId: string): Array<Record<string, unknown>> {
    const dbRows = this.db.prepare("SELECT * FROM bot_messages WHERE conversation_id=? ORDER BY ordinal ASC")
      .all(conversationId) as Array<Record<string, unknown>>;
    return overlayFindAll(this.db, "bot_messages", dbRows, r => String(r.message_id),
      r => r.conversation_id === conversationId, (a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
  }

  private nextMessageOrdinal(conversationId: string): number {
    const msgs = this.listMessagesForConversation(conversationId);
    const maxOrd = msgs.reduce((max, r) => Math.max(max, Number(r.ordinal ?? 0)), 0);
    return maxOrd + 1;
  }

  private hasGatewayConversation(conversationId: string): boolean {
    const row = overlayReadOne(this.db, "bot_gateway_conversations", conversationId, () =>
      this.db.prepare("SELECT * FROM bot_gateway_conversations WHERE conversation_id=?").get(conversationId) as Record<string, unknown> | undefined);
    return Boolean(row);
  }

  private feedbackForMessage(messageId: string): { message_id: string; metadata_json: string } | undefined {
    return overlayReadOne<{ message_id: string; metadata_json: string }>(this.db, "bot_work_feedback", messageId, () =>
      this.db.prepare("SELECT * FROM bot_work_feedback WHERE message_id=?").get(messageId) as { message_id: string; metadata_json: string } | undefined);
  }

  conversation(userId: string, botId: string, conversationId?: string, teamId?: string): BotConversation | undefined {
    // Explicit IDs are internal receipt identities. External send/history validate
    // team scope separately; old requests retain their original executing Bot.
    if (conversationId) {
      const row = this.getConvRaw(conversationId);
      if (!row || row.user_id !== userId || (row.bot_id !== botId && (row.team_id ?? null) === null)) return undefined;
      return conversationRow.parse(row);
    }
    if (teamId) {
      const dbRows = this.db.prepare("SELECT * FROM bot_conversations WHERE user_id=? AND team_id=? AND archived_at IS NULL")
        .all(userId, teamId) as Array<Record<string, unknown>>;
      const row = overlayFindAll(this.db, "bot_conversations", dbRows, r => String(r.conversation_id),
        r => r.user_id === userId && r.team_id === teamId && (r.archived_at ?? null) === null)[0];
      return row ? conversationRow.parse(row) : undefined;
    }
    const dbRows = this.db.prepare(`SELECT c.* FROM bot_conversations c WHERE user_id=? AND bot_id=? AND team_id IS NULL AND archived_at IS NULL AND ingress_kind='desktop' AND source_kind='user'
      AND NOT EXISTS(SELECT 1 FROM bot_gateway_conversations g WHERE g.conversation_id=c.conversation_id)`)
      .all(userId, botId) as Array<Record<string, unknown>>;
    const row = overlayFindAll(this.db, "bot_conversations", dbRows, r => String(r.conversation_id),
      r => r.user_id === userId && r.bot_id === botId && (r.team_id ?? null) === null
        && (r.archived_at ?? null) === null && (r.ingress_kind ?? "desktop") === "desktop" && (r.source_kind ?? "user") === "user"
        && !this.hasGatewayConversation(String(r.conversation_id)))[0];
    return row ? conversationRow.parse(row) : undefined;
  }

  assertScope(conversation: BotConversation | undefined, teamId?: string): void {
    if (conversation && (conversation.team_id ?? undefined) !== teamId) throw new Error("对话不属于当前团队或个人空间");
  }

  accept(userId: string, input: BotSendRequest, persistedAttachments: BotAttachmentDto[] = input.attachments ?? []): BotSendReceipt {
    const payload = JSON.stringify({ text: input.text, conversationId: input.conversationId ?? null,
      ...(input.teamId ? { teamId: input.teamId } : {}), ...(input.clarificationGoalId ? {clarificationGoalId:input.clarificationGoalId} : {}), selectedWorkId: input.selectedWorkId ?? null, referenceMessageId: input.referenceMessageId ?? null,
      ...(input.selectedCollaborationId ? { selectedCollaborationId: input.selectedCollaborationId } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.selection ? { selection: input.selection } : {}) });
    const hash = createHash("sha256").update(payload).digest("hex");
    return workDomainRunTx(this.db, () => {
      const prior = this.receipt(userId, input.botId, input.requestId);
      if (prior) {
        if (prior.payload_hash !== hash) throw new Error("同一消息请求 ID 已用于不同正文、附件或事项引用");
        return { botId: input.botId, teamId: input.teamId, conversationId: prior.conversation_id, requestId: input.requestId,
          userMessageId: prior.user_message_id, assistantMessageId: prior.assistant_message_id, replayed: true };
      }
      let conversation = this.conversation(userId, input.botId, input.conversationId, input.teamId);
      this.assertScope(conversation, input.teamId);
      if (input.conversationId && !conversation) throw new Error("对话不属于当前用户与 Bot");
      if (conversation?.archived_at) throw new Error("该对话已归档，请开始新对话");
      if(input.clarificationGoalId) {
        const question=input.referenceMessageId ? this.message(input.referenceMessageId) : undefined;
        if(!question || question.conversationId!==conversation?.conversation_id || question.botId!==input.botId
          || !question.clarifications?.some(card=>card.goalId===input.clarificationGoalId && card.status==="pending"))
          throw Error("这个问题已回答、失效或不属于当前对话，请刷新后继续");
      }
      const now = Date.now();
      const rust = requiresWorkRustWrites(this.db);
      if (!conversation) {
        const conversationId = `bot-conversation-${randomUUID()}`;
        if (rust) {
          overlaySet(this.db, "bot_conversations", conversationId, {
            conversation_id: conversationId, bot_id: input.botId, user_id: userId, team_id: input.teamId ?? null,
            ingress_kind: "desktop", source_kind: "user", revision: 0, current_request_id: null,
            archived_at: null, created_at: now, updated_at: now,
          });
          enqueueWorkOp(this.db, {
            op: "botConvInsert", conversationId, botId: input.botId, userId, teamId: input.teamId ?? null,
            ingressKind: "desktop", sourceKind: "user", archivedAt: null, createdAt: now, updatedAt: now, orIgnore: false,
          });
        } else {
          this.db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at,team_id) VALUES (?,?,?,?,?,?)")
            .run(conversationId, input.botId, userId, now, now, input.teamId ?? null);
        }
        conversation = this.conversation(userId, input.botId, conversationId, input.teamId)!;
      }
      const receipt: BotSendReceipt = { botId: input.botId, teamId: input.teamId, conversationId: conversation.conversation_id, requestId: input.requestId,
        userMessageId: `${BOT_MESSAGE_ID_PREFIX}${randomUUID()}`, assistantMessageId: `${BOT_MESSAGE_ID_PREFIX}${randomUUID()}`, replayed: false };
      if (rust) {
        const nextOrd = this.nextMessageOrdinal(receipt.conversationId);
        const attachmentsJson = persistedAttachments.length
          ? JSON.stringify(z.array(botAttachmentSchema).parse(persistedAttachments))
          : null;
        overlaySet(this.db, "bot_messages", receipt.userMessageId, {
          message_id: receipt.userMessageId, conversation_id: receipt.conversationId, bot_id: input.botId,
          request_id: input.requestId, ordinal: nextOrd, role: "user", text: input.text, status: "completed",
          work_ids_json: "[]", error: null, created_at: now, updated_at: now,
        });
        if (attachmentsJson) {
          overlaySet(this.db, "bot_message_attachments", receipt.userMessageId, {
            message_id: receipt.userMessageId, attachments_json: attachmentsJson,
          });
        }
        enqueueWorkOp(this.db, {
          op: "botMsgInsert", messageId: receipt.userMessageId, conversationId: receipt.conversationId,
          botId: input.botId, requestId: input.requestId, role: "user", text: input.text, status: "completed",
          workIdsJson: "[]", createdAt: now, updatedAt: now, orIgnore: false, attachmentsJson,
        });
        overlaySet(this.db, "bot_messages", receipt.assistantMessageId, {
          message_id: receipt.assistantMessageId, conversation_id: receipt.conversationId, bot_id: input.botId,
          request_id: input.requestId, ordinal: nextOrd + 1, role: "assistant", text: "", status: "queued",
          work_ids_json: "[]", error: null, created_at: now, updated_at: now,
        });
        enqueueWorkOp(this.db, {
          op: "botMsgInsert", messageId: receipt.assistantMessageId, conversationId: receipt.conversationId,
          botId: input.botId, requestId: input.requestId, role: "assistant", text: "", status: "queued",
          workIdsJson: "[]", createdAt: now, updatedAt: now, orIgnore: false, attachmentsJson: null,
        });
        overlaySet(this.db, "bot_send_receipts", `${userId}\0${input.botId}\0${input.requestId}`, {
          user_id: userId, bot_id: input.botId, request_id: input.requestId, payload_hash: hash,
          conversation_id: receipt.conversationId, user_message_id: receipt.userMessageId,
          assistant_message_id: receipt.assistantMessageId,
          selected_work_id: input.selectedWorkId ?? null, reference_message_id: input.referenceMessageId ?? null,
        });
        enqueueWorkOp(this.db, {
          op: "botSendReceiptInsert", userId, botId: input.botId, requestId: input.requestId, payloadHash: hash,
          conversationId: receipt.conversationId, userMessageId: receipt.userMessageId,
          assistantMessageId: receipt.assistantMessageId,
          selectedWorkId: input.selectedWorkId ?? null, referenceMessageId: input.referenceMessageId ?? null,
        });
        if (input.clarificationGoalId && input.referenceMessageId) {
          overlaySet(this.db, "bot_clarification_answers", `${input.referenceMessageId}\0${input.clarificationGoalId}`, {
            question_message_id: input.referenceMessageId, goal_id: input.clarificationGoalId, answer_message_id: receipt.userMessageId,
          });
          enqueueWorkOp(this.db, {
            op: "botClarificationAnswerInsert", questionMessageId: input.referenceMessageId,
            goalId: input.clarificationGoalId, answerMessageId: receipt.userMessageId,
          });
        }
        this.touch(receipt.conversationId);
        return receipt;
      }
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
      if(input.clarificationGoalId) this.db.prepare("INSERT INTO bot_clarification_answers(question_message_id,goal_id,answer_message_id) VALUES (?,?,?)").run(input.referenceMessageId,input.clarificationGoalId,receipt.userMessageId);
      this.touch(receipt.conversationId);
      return receipt;
    });
  }

  receipt(userId: string, botId: string, requestId: string): BotMessageReceipt | undefined {
    const row = overlayReadOne(this.db, "bot_send_receipts", `${userId}\0${botId}\0${requestId}`, () =>
      this.db.prepare("SELECT * FROM bot_send_receipts WHERE user_id=? AND bot_id=? AND request_id=?").get(userId, botId, requestId) as Record<string, unknown> | undefined);
    return row ? receiptRow.parse(row) : undefined;
  }

  /** The original human statement, never the peer's generated paraphrase. */
  userSource(receipt: BotMessageReceipt): BotMessageReceipt {
    const peer = this.peers.origin(receipt.user_message_id);
    if (!peer) return receipt;
    if (peer.kind !== "request") throw new Error("回传事件不是新的用户授权");
    const source = this.receipt(receipt.user_id, peer.sourceBotId, peer.sourceRequestId);
    if (!source || source.conversation_id !== peer.sourceConversationId || source.user_message_id !== peer.sourceUserMessageId
      || source.assistant_message_id !== peer.sourceAssistantMessageId || this.peers.origin(source.user_message_id))
      throw new Error("协作的原始用户来源已不可用");
    return source;
  }

  message(messageId: string): BotMessageDto | undefined {
    const row = this.getMessageRaw(messageId);
    return row ? this.mapMessage(row) : undefined;
  }

  /** Image recovery only needs host feedback messages. Filter the current DB
   * before mapping unrelated attachments/metrics/segments; never trust a stale
   * history DTO to decide whether feedback has since been added. */
  messageWithWorkFeedback(messageId: string): BotMessageDto | undefined {
    const row = this.getMessageRaw(messageId);
    if (!row || row.role !== "assistant" || !this.feedbackForMessage(messageId)) return undefined;
    return this.mapMessage(row);
  }

  messageBelongsToConversation(userId: string, conversationId: string, messageId: string): boolean {
    const m = this.getMessageRaw(messageId);
    if (!m) return false;
    const mc = this.getConvRaw(String(m.conversation_id));
    const target = this.getConvRaw(conversationId);
    if (!mc || !target || mc.user_id !== userId || target.user_id !== userId) return false;
    if (mc.conversation_id === target.conversation_id) return true;
    if (!String(m.conversation_id).startsWith("bot-inbox-")) return false;
    const fb = this.feedbackForMessage(messageId);
    if (!fb) return false;
    const meta = JSON.parse(fb.metadata_json) as { workId?: string };
    if (!meta.workId) return false;
    const dbLinks = this.db.prepare("SELECT * FROM work_conversations WHERE work_id=? AND channel_type='bot-delivery' AND conversation_id=?")
      .all(meta.workId, conversationId) as Array<Record<string, unknown>>;
    return overlayFindAll(this.db, "work_conversations", dbLinks, r => `${r.work_id}\0${r.conversation_id}`,
      r => r.work_id === meta.workId && r.channel_type === "bot-delivery" && r.conversation_id === conversationId).length > 0;
  }

  history(userId: string, request: BotHistoryRequest, options: { reconcile?: boolean } = {}): BotHistoryDto {
    let conversation = this.conversation(userId, request.botId, request.inbox ? botInboxId(userId, request.botId) : request.conversationId, request.teamId);
    this.assertScope(conversation, request.teamId);
    if (!conversation) return this.emptyHistory(request);
    // Current-format completed delegations may predate source projection. Repair
    // at most one bounded batch on initial/catch-up reads, never on older-page or
    // exact-message navigation. This neither creates a turn nor reruns Work.
    if (options.reconcile !== false && !request.teamId && request.before === undefined && !request.messageIds
      && reconcileDelegatedFeedback(this.db, userId, conversation.conversation_id, value => workFeedbackSchema.parse(value))) {
      conversation = this.conversation(userId, request.botId, conversation.conversation_id)!;
    }
    // Query each disjoint source using its conversation/ordinal index. A single
    // OR scans unrelated messages; a feedback-driven UNION instead scans/sorts
    // all feedback when an inbox is large. Each source contributes at most 101
    // rows, and the rolling merge keeps the same bounded global page.
    const ascending = request.after !== undefined;
    const before = request.before ?? Number.MAX_SAFE_INTEGER;
    const after = request.after ?? 0;
    const idSet = request.messageIds ? new Set(request.messageIds) : undefined;
    const cmp = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      ascending ? Number(a.ordinal) - Number(b.ordinal) : Number(b.ordinal) - Number(a.ordinal);
    const idsSql = request.messageIds ? "AND m.message_id IN (SELECT value FROM json_each(@ids))" : "";
    const params = { conversationId: conversation.conversation_id, before, after, ids: JSON.stringify(request.messageIds ?? []) };
    const pageSql = `SELECT m.* FROM bot_messages m WHERE m.conversation_id=@sourceId
      AND m.ordinal<@before AND m.ordinal>@after ${idsSql}`;
    const mainDbRows = this.db.prepare(pageSql + ` ORDER BY m.ordinal ${ascending ? "ASC" : "DESC"} LIMIT 101`)
      .all({ ...params, sourceId: conversation.conversation_id }) as Array<Record<string, unknown>>;
    let rows = overlayFindAll(this.db, "bot_messages", mainDbRows, r => String(r.message_id),
      r => r.conversation_id === conversation!.conversation_id && Number(r.ordinal) < before && Number(r.ordinal) > after
        && (!idSet || idSet.has(String(r.message_id))), cmp).slice(0, 101);
    const dbInboxes = this.db.prepare(`SELECT conversation_id FROM bot_conversations
      WHERE user_id=? AND conversation_id LIKE 'bot-inbox-%' AND conversation_id<>?`)
      .all(userId, conversation.conversation_id) as Array<{ conversation_id: string }>;
    const inboxes = overlayFindAll(this.db, "bot_conversations", dbInboxes.map(r => ({ conversation_id: r.conversation_id, user_id: userId })),
      r => String(r.conversation_id),
      r => r.user_id === userId && String(r.conversation_id).startsWith("bot-inbox-") && r.conversation_id !== conversation!.conversation_id);
    if (inboxes.length) {
      const useIndexedSqlExists = !overlayHasTable(this.db, "bot_messages")
        && !overlayHasTable(this.db, "bot_work_feedback")
        && !overlayHasTable(this.db, "work_conversations");
      if (useIndexedSqlExists) {
        const linkedSql = this.db.prepare(pageSql + ` AND EXISTS (
          SELECT 1 FROM bot_work_feedback f JOIN work_conversations t ON t.work_id=json_extract(f.metadata_json,'$.workId')
          WHERE f.message_id=m.message_id AND t.channel_type='bot-delivery' AND t.conversation_id=@conversationId
        ) ORDER BY m.ordinal ${ascending ? "ASC" : "DESC"} LIMIT 101`);
        for (const inbox of inboxes) {
          const edge = rows.length === 101 ? Number(rows[100].ordinal) : undefined;
          const inboxBefore = ascending && edge !== undefined ? Math.min(params.before, edge) : params.before;
          const inboxAfter = !ascending && edge !== undefined ? Math.max(params.after, edge) : params.after;
          const linked = linkedSql.all({ ...params, sourceId: String(inbox.conversation_id), before: inboxBefore, after: inboxAfter }) as Array<Record<string, unknown>>;
          const byId = new Map<string, Record<string, unknown>>();
          for (const r of rows) byId.set(String(r.message_id), r);
          for (const r of linked) byId.set(String(r.message_id), r);
          rows = [...byId.values()].sort(cmp).slice(0, 101);
        }
      } else {
        const dbDeliveryWorks = this.db.prepare("SELECT work_id FROM work_conversations WHERE channel_type='bot-delivery' AND conversation_id=?")
          .all(conversation.conversation_id) as Array<{ work_id: string }>;
        const deliveryWorks = new Set(overlayFindAll(this.db, "work_conversations",
          dbDeliveryWorks.map(r => ({ work_id: r.work_id, conversation_id: conversation!.conversation_id, channel_type: "bot-delivery" })),
          r => `${r.work_id}\0${r.conversation_id}`,
          r => r.channel_type === "bot-delivery" && r.conversation_id === conversation!.conversation_id).map(r => String(r.work_id)));
        const linkedSql = this.db.prepare(pageSql + ` ORDER BY m.ordinal ${ascending ? "ASC" : "DESC"}`);
        for (const inbox of inboxes) {
          const edge = rows.length === 101 ? Number(rows[100].ordinal) : undefined;
          const inboxBefore = ascending && edge !== undefined ? Math.min(params.before, edge) : params.before;
          const inboxAfter = !ascending && edge !== undefined ? Math.max(params.after, edge) : params.after;
          const dbCandidates = linkedSql.all({ ...params, sourceId: String(inbox.conversation_id), before: inboxBefore, after: inboxAfter }) as Array<Record<string, unknown>>;
          const linked = overlayFindAll(this.db, "bot_messages", dbCandidates, r => String(r.message_id), r => {
            if (r.conversation_id !== inbox.conversation_id) return false;
            const ord = Number(r.ordinal);
            if (!(ord < inboxBefore && ord > inboxAfter)) return false;
            if (idSet && !idSet.has(String(r.message_id))) return false;
            const fb = this.feedbackForMessage(String(r.message_id));
            if (!fb) return false;
            const meta = JSON.parse(fb.metadata_json) as { workId?: string };
            return Boolean(meta.workId && deliveryWorks.has(meta.workId));
          }, cmp).slice(0, 101);
          const byId = new Map<string, Record<string, unknown>>();
          for (const r of rows) byId.set(String(r.message_id), r);
          for (const r of linked) byId.set(String(r.message_id), r);
          rows = [...byId.values()].sort(cmp).slice(0, 101);
        }
      }
    }
    const messages = rows.slice(0, 100).map(row => this.mapMessage(row));
    if (request.after === undefined) messages.reverse();
    return { conversationId: conversation.conversation_id, botId: request.botId, teamId: request.teamId, revision: conversation.revision,
      archived: conversation.archived_at !== null, messages, before: !request.messageIds && (request.after !== undefined || rows.length > 100) ? messages[0]?.ordinal : undefined };
  }

  projectHistoryPage(request: BotHistoryRequest, page: Exclude<RuntimeBotHistoryPage, { kind: "needsHost" }>): BotHistoryDto {
    if (page.kind === "scopeMismatch") throw new Error("对话不属于当前团队或个人空间");
    if (page.kind === "missing") return this.emptyHistory(request);
    return {
      conversationId: page.conversationId, botId: request.botId, teamId: request.teamId,
      revision: page.revision, archived: page.archived, before: page.before ?? undefined,
      messages: page.rows.map(row => this.mapMessage(row, row)),
    };
  }

  private emptyHistory(request: BotHistoryRequest): BotHistoryDto {
    return { conversationId: "", botId: request.botId, teamId: request.teamId, revision: 0, archived: false, messages: [] };
  }

  activeRequests(userId: string): import("../../../shared/bot-conversation").BotActiveRequestDto[] {
    // Scope comes from the host, never renderer input. No runtime creation, mutation
    // or current-conversation restriction: queued and archived requests stay visible.
    const dbConvs = this.db.prepare("SELECT * FROM bot_conversations WHERE user_id=?").all(userId) as Array<Record<string, unknown>>;
    const convById = new Map(overlayFindAll(this.db, "bot_conversations", dbConvs, r => String(r.conversation_id), r => r.user_id === userId)
      .map(c => [String(c.conversation_id), c]));
    const dbMsgs = this.db.prepare(`SELECT m.* FROM bot_messages m JOIN bot_conversations c ON c.conversation_id=m.conversation_id
      WHERE c.user_id=? AND m.role='assistant' AND m.status IN ('queued','running','unknown')`).all(userId) as Array<Record<string, unknown>>;
    const activeMsgs = overlayFindAll(this.db, "bot_messages", dbMsgs, r => String(r.message_id),
      r => convById.has(String(r.conversation_id)) && r.role === "assistant" && ["queued", "running", "unknown"].includes(String(r.status)),
      (a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0) || Number(b.ordinal ?? 0) - Number(a.ordinal ?? 0));
    return activeMsgs.map(row => {
      const conv = convById.get(String(row.conversation_id));
      const message = this.mapMessage(row);
      const source = this.listMessagesForConversation(message.conversationId)
        .find(m => m.bot_id === message.botId && m.request_id === message.requestId && m.role === "user");
      return { message, prompt: source ? this.mapMessage(source) : undefined, archived: (conv?.archived_at ?? null) !== null };
    });
  }

  pending(userId: string): BotConversation[] {
    const dbConvs = this.db.prepare("SELECT * FROM bot_conversations WHERE user_id=?").all(userId) as Array<Record<string, unknown>>;
    const convs = overlayFindAll(this.db, "bot_conversations", dbConvs, r => String(r.conversation_id), r => r.user_id === userId);
    const dbMsgs = this.db.prepare(`SELECT DISTINCT m.* FROM bot_messages m JOIN bot_conversations c ON c.conversation_id=m.conversation_id
      WHERE c.user_id=? AND m.role='assistant' AND m.status IN ('queued','running','unknown')`).all(userId) as Array<Record<string, unknown>>;
    const activeConvIds = new Set(overlayFindAll(this.db, "bot_messages", dbMsgs, r => String(r.message_id),
      r => r.role === "assistant" && ["queued", "running", "unknown"].includes(String(r.status)))
      .map(m => String(m.conversation_id)));
    return convs.filter(c => activeConvIds.has(String(c.conversation_id))).map(row => conversationRow.parse(row));
  }

  next(conversationId: string): BotMessageDto | undefined {
    const row = this.listMessagesForConversation(conversationId)
      .find(m => m.role === "assistant" && ["queued", "running", "unknown"].includes(String(m.status)));
    return row ? this.mapMessage(row) : undefined;
  }

  update(messageId: string, status: BotMessageDto["status"], text: string, error?: string, activity?: BotActivityDto, segments?: BotReplySegment[], presentation?: { taskId: string; tools: ChatToolCallDto[] }): void {
    workDomainRunTx(this.db, () => {
      const message = this.message(messageId);
      if (!message) throw new Error("消息不存在");
      const now = Date.now();
      if (requiresWorkRustWrites(this.db)) {
        overlayMutate(this.db, "bot_messages", messageId, () => this.getMessageRaw(messageId),
          cur => cur ? { ...cur, status, text, error: error ?? null, updated_at: now } : cur);
        overlayMutate(this.db, "bot_message_revisions", messageId, () =>
          this.db.prepare("SELECT message_id, revision FROM bot_message_revisions WHERE message_id=?").get(messageId) as Record<string, unknown> | undefined,
        cur => ({ message_id: messageId, revision: Number(cur?.revision ?? 0) + 1 }));
        const segmentsJson = segments !== undefined ? JSON.stringify(z.array(botReplySegmentSchema).parse(segments)) : null;
        if (segmentsJson !== null) overlaySet(this.db, "bot_message_segments", messageId, { message_id: messageId, segments_json: segmentsJson });
        const tools = presentation !== undefined ? { taskId: presentation.taskId, toolsJson: JSON.stringify(presentation.tools) } : null;
        if (tools) overlaySet(this.db, "bot_message_tools", messageId, { message_id: messageId, task_id: tools.taskId, tools_json: tools.toolsJson });
        const activityJson = status === "running" && activity ? JSON.stringify(botActivitySchema.parse(activity)) : null;
        if (activityJson !== null) overlaySet(this.db, "bot_message_activity", messageId, { message_id: messageId, activity_json: activityJson });
        else overlayDelete(this.db, "bot_message_activity", messageId);
        let clearWorkReads: { conversationId: string; requestId: string } | null = null;
        if (message.role === "assistant" && ["completed", "cancelled", "failed"].includes(status)) {
          clearWorkReads = { conversationId: message.conversationId, requestId: message.requestId };
          const readRows = this.db.prepare("SELECT * FROM bot_work_reads WHERE conversation_id=? AND request_id=?")
            .all(message.conversationId, message.requestId) as Array<Record<string, unknown>>;
          for (const r of overlayFindAll(this.db, "bot_work_reads", readRows, row => `${row.conversation_id}\0${row.request_id}\0${row.work_id}`,
            row => row.conversation_id === message.conversationId && row.request_id === message.requestId)) {
            overlayDelete(this.db, "bot_work_reads", `${r.conversation_id}\0${r.request_id}\0${r.work_id}`);
          }
        }
        overlayMutate(this.db, "bot_conversations", message.conversationId, () => this.getConvRaw(message.conversationId),
          cur => cur ? { ...cur, revision: Number(cur.revision ?? 0) + 1, updated_at: now } : cur);
        enqueueWorkOp(this.db, {
          op: "botMsgUpdate", messageId, status, text, error: error ?? null, updatedAt: now,
          segmentsJson, tools, activityJson, clearWorkReads,
        });
        return;
      }
      this.db.prepare("UPDATE bot_messages SET status=?,text=?,error=?,updated_at=? WHERE message_id=?")
        .run(status, text, error ?? null, now, messageId);
      if (segments !== undefined) this.db.prepare("INSERT OR REPLACE INTO bot_message_segments(message_id,segments_json) VALUES (?,?)")
        .run(messageId, JSON.stringify(z.array(botReplySegmentSchema).parse(segments)));
      if (presentation !== undefined) this.db.prepare("INSERT OR REPLACE INTO bot_message_tools(message_id,task_id,tools_json) VALUES (?,?,?)")
        .run(messageId, presentation.taskId, JSON.stringify(presentation.tools));
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
    });
  }

  /** Prune proven terminal requests on recovery; unknown requests can still resume. */
  pruneTerminalWorkReads(userId: string): number {
    if (requiresWorkRustWrites(this.db)) {
      const dbReads = this.db.prepare("SELECT * FROM bot_work_reads").all() as Array<Record<string, unknown>>;
      const allReads = overlayFindAll(this.db, "bot_work_reads", dbReads, r => `${r.conversation_id}\0${r.request_id}\0${r.work_id}`, () => true);
      let count = 0;
      for (const read of allReads) {
        const c = this.getConvRaw(String(read.conversation_id));
        if (!c || c.user_id !== userId) continue;
        const dbReceipts = this.db.prepare("SELECT * FROM bot_send_receipts WHERE user_id=? AND conversation_id=? AND request_id=?")
          .all(userId, read.conversation_id, read.request_id) as Array<Record<string, unknown>>;
        const matching = overlayFindAll(this.db, "bot_send_receipts", dbReceipts,
          r => `${r.user_id}\0${r.bot_id}\0${r.request_id}`,
          r => r.user_id === userId && r.conversation_id === read.conversation_id && r.request_id === read.request_id);
        const isTerminal = matching.some(r => {
          const m = this.getMessageRaw(String(r.assistant_message_id));
          return m && m.conversation_id === r.conversation_id && m.bot_id === r.bot_id && m.request_id === r.request_id
            && m.role === "assistant" && ["completed", "cancelled", "failed"].includes(String(m.status));
        });
        if (isTerminal) {
          overlayDelete(this.db, "bot_work_reads", `${read.conversation_id}\0${read.request_id}\0${read.work_id}`);
          count += 1;
        }
      }
      enqueueWorkOp(this.db, { op: "botWorkReadsPruneTerminal", userId });
      return count;
    }
    return this.db.prepare(`DELETE FROM bot_work_reads WHERE EXISTS (
      SELECT 1 FROM bot_send_receipts r
      JOIN bot_conversations c ON c.conversation_id=r.conversation_id
      JOIN bot_messages m ON m.message_id=r.assistant_message_id
      WHERE r.user_id=? AND c.user_id=r.user_id
        AND r.conversation_id=bot_work_reads.conversation_id AND r.request_id=bot_work_reads.request_id
        AND m.conversation_id=r.conversation_id AND m.bot_id=r.bot_id AND m.request_id=r.request_id
        AND m.role='assistant' AND m.status IN ('completed','cancelled','failed')
    )`).run(userId).changes;
  }

  /** Work-owned request evidence survives removal of the original Bot/chat. */
  validateWorkUserInput(receipt: BotMessageReceipt, sourceMessageIds: readonly string[] = []): void {
    this.workUserInput(receipt, sourceMessageIds);
  }

  private workUserInput(receipt: BotMessageReceipt, sourceMessageIds: readonly string[]) {
    const selectedIds = new Set(z.array(z.string().min(1)).max(32).parse(sourceMessageIds));
    const conversation = this.conversation(receipt.user_id, receipt.bot_id, receipt.conversation_id);
    const current = this.message(receipt.user_message_id);
    if (!conversation || !current || current.role !== "user" || current.botId !== receipt.bot_id
      || current.conversationId !== receipt.conversation_id || current.requestId !== receipt.request_id)
      throw new Error("缺少可核验的原始用户输入");
    selectedIds.delete(current.messageId);
    const run = z.object({ context_json: z.string() }).optional().parse(this.db.prepare(
      "SELECT context_json FROM bot_request_runs WHERE message_id=?").get(receipt.assistant_message_id));
    const frozen = run ? z.object({ delegationSources: z.array(botDelegationSourceSchema).default([]) })
      .parse(JSON.parse(run.context_json)).delegationSources : [];
    const visible = new Map(frozen.map(source => [source.messageId, source]));
    const referenceIds = new Set<string>();
    if (receipt.reference_message_id) {
      referenceIds.add(receipt.reference_message_id);
      const reference = this.message(receipt.reference_message_id);
      if (reference?.role === "assistant") {
        const original = this.receipt(receipt.user_id, reference.botId, reference.requestId);
        if (original) referenceIds.add(original.user_message_id);
      }
    }
    const resolveSource = (messageId: string, explicitReference: boolean): BotDelegationSource => {
      const stored = this.message(messageId);
      if (!stored || stored.ordinal >= current.ordinal || !this.messageBelongsToConversation(receipt.user_id, receipt.conversation_id, messageId))
        throw new Error("委托来源不属于本次请求可见的历史对话");
      const source = visible.get(messageId);
      if (!source && (run || !explicitReference)) throw new Error("委托来源未包含在本轮冻结上下文中");
      const userReceipt = stored.role === "assistant" ? this.receipt(receipt.user_id, stored.botId, stored.requestId) : undefined;
      const pairedUser = userReceipt && this.message(userReceipt.user_message_id);
      const projection = projectBotMemoryHistory(this.db, [...pairedUser ? [pairedUser] : [], stored],
        { botId: receipt.bot_id, conversationId: receipt.conversation_id, teamId: conversation.team_id ?? undefined });
      const projected = projection.messages.find(message => message.messageId === messageId);
      if (!projected || !projection.sourceMessageIds.includes(messageId) || projected.status !== "completed")
        throw new Error("委托来源已撤销或尚未完成，不能作为当前要求");
      const currentSource = botDelegationSourceSchema.parse(projected);
      if (source && JSON.stringify(source) !== JSON.stringify(currentSource)) throw new Error("委托来源在本轮开始后已变化，请重新读取");
      return source ?? currentSource;
    };
    const selected = [...selectedIds].map(id => resolveSource(id, referenceIds.has(id)));
    const references = [...referenceIds].map(id => resolveSource(id, true));
    return { current, selected, references };
  }

  linkWorkUserInput(receipt: BotMessageReceipt, work: WorkDto, sourceMessageIds: readonly string[] = []): void {
    if (!workDomainInTx(this.db)) throw new Error("用户原文必须与委托受理同事务保存");
    if (work.userId !== receipt.user_id || !this.conversation(receipt.user_id, receipt.bot_id, receipt.conversation_id))
      throw new Error("委托与用户原文不属于同一用户和会话");
    const { current, selected, references } = this.workUserInput(receipt, sourceMessageIds);
    const compact = (message: BotDelegationSource | BotMessageDto, selectedRequirement = false) => ({ messageId: message.messageId, conversationId: message.conversationId,
      role: message.role, text: message.text, ordinal: message.ordinal,
      ...(message.peerOrigin ? { peerOrigin: message.peerOrigin } : {}),
      ...(selectedRequirement && message.role === "user" && !message.peerOrigin ? { delegationRole: "requirement" } : {}),
      intentRevision: work.intentRevision, sourceVersion: work.sourceVersion,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}) });
    const dialogue = [...selected.map(message => compact(message, true)), compact(current)]
      .sort((left, right) => left.ordinal - right.ordinal);
    const messagesJson = JSON.stringify(dialogue);
    const referencesJson = JSON.stringify(references.sort((left, right) => left.ordinal - right.ordinal).map(message => compact(message)));
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "bot_work_user_inputs", `${work.workId}\0${current.messageId}`, () =>
        this.db.prepare("SELECT * FROM bot_work_user_inputs WHERE work_id=? AND source_message_id=?").get(work.workId, current.messageId) as Record<string, unknown> | undefined,
      cur => cur ?? {
        work_id: work.workId, source_message_id: current.messageId,
        intent_revision: work.intentRevision, source_version: work.sourceVersion,
        messages_json: messagesJson, references_json: referencesJson,
      });
      enqueueWorkOp(this.db, {
        op: "botWorkUserInputInsert", workId: work.workId, sourceMessageId: current.messageId,
        intentRevision: work.intentRevision, sourceVersion: work.sourceVersion, messagesJson, referencesJson,
      });
      return;
    }
    this.db.prepare(`INSERT OR IGNORE INTO bot_work_user_inputs(work_id,source_message_id,intent_revision,source_version,messages_json,references_json)
      VALUES (?,?,?,?,?,?)`).run(work.workId, current.messageId, work.intentRevision, work.sourceVersion, messagesJson, referencesJson);
  }

  /** Immutable input attachment snapshot, independent of human-readable goal length. */
  linkWorkAttachments(receipt: BotMessageReceipt, workId: string, inputSnapshotId: string, previousSnapshotId?: string): void {
    const snapKey = `${workId}\0${previousSnapshotId ?? inputSnapshotId}`;
    const existing = overlayReadOne<{ attachments_json: string }>(this.db, "bot_work_attachments", snapKey, () =>
      this.db.prepare("SELECT * FROM bot_work_attachments WHERE work_id=? AND input_snapshot_id=?")
        .get(workId, previousSnapshotId ?? inputSnapshotId) as { attachments_json: string } | undefined);
    const current = this.message(receipt.user_message_id);
    const reference = receipt.reference_message_id ? this.message(receipt.reference_message_id) : undefined;
    const referenced = reference && this.messageBelongsToConversation(receipt.user_id, receipt.conversation_id, reference.messageId) ? reference.attachments ?? [] : [];
    const source = overlayReadOne<{ messages_json: string; references_json: string }>(this.db, "bot_work_user_inputs", `${workId}\0${receipt.user_message_id}`, () =>
      this.db.prepare("SELECT messages_json,references_json FROM bot_work_user_inputs WHERE work_id=? AND source_message_id=?")
        .get(workId, receipt.user_message_id) as { messages_json: string; references_json: string } | undefined);
    const contextAttachments = source ? [source.messages_json, source.references_json].flatMap(value =>
      z.array(z.object({ attachments: z.array(botAttachmentSchema).optional() })).parse(JSON.parse(value))
        .flatMap(message => message.attachments ?? [])) : [];
    const inherited = existing ? z.array(botAttachmentSchema).parse(JSON.parse(existing.attachments_json)) : [];
    const attachments = [...new Map([...inherited, ...contextAttachments, ...(current?.attachments ?? []), ...referenced].map(item => [item.path, item])).values()];
    if (!attachments.length) return;
    const attachmentsJson = JSON.stringify(attachments);
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "bot_work_attachments", `${workId}\0${inputSnapshotId}`, () =>
        this.db.prepare("SELECT * FROM bot_work_attachments WHERE work_id=? AND input_snapshot_id=?").get(workId, inputSnapshotId) as Record<string, unknown> | undefined,
      cur => cur ?? { work_id: workId, input_snapshot_id: inputSnapshotId, attachments_json: attachmentsJson });
      enqueueWorkOp(this.db, { op: "botWorkAttachmentsInsert", workId, inputSnapshotId, attachmentsJson });
      return;
    }
    this.db.prepare("INSERT OR IGNORE INTO bot_work_attachments(work_id,input_snapshot_id,attachments_json) VALUES (?,?,?)")
      .run(workId, inputSnapshotId, attachmentsJson);
  }

  linkWork(receipt: BotMessageReceipt, workId: string): void {
    this.linkWorkMessages(receipt, workId, [receipt.user_message_id, receipt.assistant_message_id]);
  }

  /** Exact status reads associate the answer for presentation only. Do not mark
   * the user's input as a delegation or a selected mutation target, or make a
   * query the Work's delivery origin. */
  linkWorkReply(receipt: BotMessageReceipt, workId: string): void {
    this.linkWorkMessages(receipt, workId, [receipt.assistant_message_id]);
  }

  private linkWorkMessages(receipt: BotMessageReceipt, workId: string, messageIds: readonly string[]): void {
    const rust = requiresWorkRustWrites(this.db);
    const storedIds = rust ? undefined : this.db.prepare("SELECT work_ids_json FROM bot_messages WHERE message_id=?").pluck();
    const update = rust ? undefined : this.db.prepare("UPDATE bot_messages SET work_ids_json=? WHERE message_id=?");
    for (const id of messageIds) {
      // Display-only delegated associations must never become stored provenance.
      if (rust) {
        const msg = this.getMessageRaw(id);
        const existing = z.array(z.string()).parse(JSON.parse(z.string().parse(msg?.work_ids_json)));
        const workIdsJson = JSON.stringify([...new Set([...existing, workId])]);
        overlayMutate(this.db, "bot_messages", id, () => msg, cur => cur ? { ...cur, work_ids_json: workIdsJson } : cur);
        enqueueWorkOp(this.db, { op: "botMsgWorkIdsUpdate", messageId: id, workIdsJson });
      } else {
        const existing = z.array(z.string()).parse(JSON.parse(z.string().parse(storedIds!.get(id))));
        update!.run(JSON.stringify([...new Set([...existing, workId])]), id);
      }
    }
    this.touch(receipt.conversation_id);
  }

  /** Resolve the original authenticated send, never the current owner or active chat. */
  workOrigin(userId: string, workId: string): BotConversation | undefined {
    const work = overlayReadOne(this.db, "works", workId, () =>
      this.db.prepare("SELECT work_id, user_id, source_message_id FROM works WHERE work_id=?").get(workId) as Record<string, unknown> | undefined);
    if (!work || work.user_id !== userId) return undefined;
    const dbReceipts = this.db.prepare("SELECT * FROM bot_send_receipts WHERE user_id=?").all(userId) as Array<Record<string, unknown>>;
    const receipts = overlayFindAll(this.db, "bot_send_receipts", dbReceipts,
      r => `${r.user_id}\0${r.bot_id}\0${r.request_id}`, r => r.user_id === userId);
    const candidates: Array<{ conv: BotConversation; ordinal: number }> = [];
    for (const r of receipts) {
      const m = this.getMessageRaw(String(r.user_message_id));
      const c = this.getConvRaw(String(r.conversation_id));
      if (!m || !c || c.user_id !== userId || m.conversation_id !== c.conversation_id || m.bot_id !== r.bot_id || m.request_id !== r.request_id || m.role !== "user") continue;
      const workIds = z.array(z.string()).parse(JSON.parse(String(m.work_ids_json)));
      if (m.message_id === work.source_message_id || workIds.includes(workId)) {
        candidates.push({ conv: conversationRow.parse(c), ordinal: Number(m.ordinal) });
      }
    }
    candidates.sort((a, b) => a.ordinal - b.ordinal);
    return candidates[0]?.conv;
  }

  /** Explicit delivery target first; legacy authenticated origin second. Old
   * unlinked Work is bound to its known team/owner, never the selected UI chat. */
  resolveWorkDelivery(userId: string, workId: string): BotConversation | undefined {
    const collaboration = this.collaborations.byWork(userId, workId);
    if (collaboration) {
      const exact = this.conversation(userId, collaboration.sourceBotId, collaboration.sourceConversationId);
      return exact && !exact.team_id && exact.bot_id === collaboration.sourceBotId ? exact : undefined;
    }
    const work = overlayReadOne(this.db, "works", workId, () =>
      this.db.prepare("SELECT owner_bot_id, user_id FROM works WHERE work_id=? AND user_id=?").get(workId, userId) as Record<string, unknown> | undefined);
    if (!work || work.user_id !== userId) return;
    const dbTargets = this.db.prepare("SELECT * FROM work_conversations WHERE work_id=? AND channel_type='bot-delivery'")
      .all(workId) as Array<Record<string, unknown>>;
    const links = overlayFindAll(this.db, "work_conversations", dbTargets, r => `${r.work_id}\0${r.conversation_id}`,
      r => r.work_id === workId && r.channel_type === "bot-delivery");
    const targets = links.map(l => this.getConvRaw(String(l.conversation_id))).filter((c): c is Record<string, unknown> => Boolean(c && c.user_id === userId));
    if (targets.length === 1 && !conversationRow.parse(targets[0]).conversation_id.startsWith("bot-inbox-")) return conversationRow.parse(targets[0]);
    if (targets.length > 1) return; // Ambiguous persisted provenance is not guessed.
    const origin = this.workOrigin(userId, workId);
    const hasTeams = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_team_ownership'").get();
    const team = hasTeams ? this.db.prepare("SELECT team_id FROM work_team_ownership WHERE work_id=?").get(workId) as { team_id: string } | undefined : undefined;
    const id = origin?.conversation_id ?? (team ? ensureTeamConversation(this.db, userId, String(work.owner_bot_id), team.team_id)
      : ensurePersonalConversation(this.db, userId, String(work.owner_bot_id)));
    if (!id) return;
    // Only replace the retired inbox route. Messages, IDs, original text and
    // Work state remain intact; history projects them through this exact link.
    if (requiresWorkRustWrites(this.db)) {
      const now = Date.now();
      for (const l of links) {
        if (String(l.conversation_id).startsWith("bot-inbox-")) {
          overlayDelete(this.db, "work_conversations", `${workId}\0${l.conversation_id}`);
        }
      }
      overlayMutate(this.db, "work_conversations", `${workId}\0${id}`, () =>
        this.db.prepare("SELECT * FROM work_conversations WHERE work_id=? AND conversation_id=?").get(workId, id) as Record<string, unknown> | undefined,
      cur => cur ? { ...cur, channel_type: "bot-delivery" } : { work_id: workId, conversation_id: id, channel_type: "bot-delivery", last_referenced_at: now });
      overlayMutate(this.db, "bot_conversations", id, () => this.getConvRaw(id),
        cur => cur ? { ...cur, revision: Number(cur.revision ?? 0) + 1, updated_at: now } : cur);
      enqueueWorkOp(this.db, { op: "botWorkConvReplaceDelivery", workId, conversationId: id, now });
      return this.conversation(userId, origin?.bot_id ?? String(work.owner_bot_id), id);
    }
    this.db.prepare("DELETE FROM work_conversations WHERE work_id=? AND channel_type='bot-delivery' AND conversation_id LIKE 'bot-inbox-%'").run(workId);
    this.db.prepare("INSERT OR IGNORE INTO work_conversations(work_id,conversation_id,channel_type,last_referenced_at) VALUES (?,?,'bot-delivery',?) ON CONFLICT(work_id,conversation_id) DO UPDATE SET channel_type='bot-delivery'").run(workId, id, Date.now());
    this.touch(id);
    return this.conversation(userId, origin?.bot_id ?? String(work.owner_bot_id), id);
  }

  appendWorkDelivery(userId: string, workId: string, event: string, version: string, text: string, metadata?: WorkFeedbackDto):
    { delivered: boolean; inserted: boolean; recorded?: boolean; conversationId?: string } {
    return workDomainRunTx(this.db, () => {
      const sourceTarget = this.resolveWorkDelivery(userId, workId);
      let target = sourceTarget;
      const collaboration = this.collaborations.byWork(userId, workId);
      const receiver = collaboration && this.db.prepare(`SELECT m.conversation_id FROM bot_peer_deliveries d
        JOIN bot_messages m ON m.message_id=d.accepted_message_id WHERE d.user_id=?
        AND json_extract(d.origin_json,'$.collaborationId')=? AND json_extract(d.origin_json,'$.kind')='request' ORDER BY d.rowid LIMIT 1`)
        .get(userId, collaboration.collaborationId);
      const peerReceiver = z.object({ conversation_id: z.string() }).optional().parse(receiver || undefined);
      if (peerReceiver && collaboration) target = this.conversation(userId, collaboration.targetBotId, peerReceiver.conversation_id);
      if (collaboration && metadata?.report) {
        const operationId = `work-feedback:${createHash("sha256").update(event).digest("hex")}`;
        const revision = createHash("sha256").update(version).digest("hex");
        this.collaborations.appendMessage(userId, collaboration.collaborationId, { operationId, version: revision,
          senderBotId: collaboration.targetBotId, senderDisplayName: collaboration.targetDisplayName,
          kind: metadata.report.milestone ? "progress" : "result", text, workFeedback: metadata });
        const bindingRaw = metadata.executionId ? overlayReadOne(this.db, "work_execution_bindings", metadata.executionId, () =>
          this.db.prepare("SELECT settled_at, work_id FROM work_execution_bindings WHERE binding_id=? AND work_id=?").get(metadata.executionId, workId) as Record<string, unknown> | undefined) : undefined;
        const binding = bindingRaw && bindingRaw.work_id === workId
          ? z.object({ settled_at: z.number().nullable() }).parse(bindingRaw) : undefined;
        if (binding?.settled_at != null) this.collaborations.event(userId, collaboration.collaborationId,
          { operationId: `execution-end:${metadata.executionId}`, exchangeId: metadata.executionId, kind: "ended", workId, createdAt: binding.settled_at });
        this.collaborations.event(userId, collaboration.collaborationId, { operationId, version: revision, kind: "returning", workId });
        if (!sourceTarget) this.collaborations.event(userId, collaboration.collaborationId,
          { operationId, version: revision, kind: "unknown", workId, detail: "原来源会话已删除，成果保留在协作记录中，未改投其他会话" });
      }
      if (!target || collaboration && !peerReceiver && !metadata)
        return { delivered: false, inserted: false, recorded: Boolean(collaboration && metadata?.report) };
      // Raw execution text remains at the receiver. Without a peer receiver,
      // even the direct source fallback must contain only public host evidence.
      const body = collaboration && !peerReceiver ? delegatedFeedbackText(metadata!) : text;
      const inserted = this.appendWorkFeedback(target, workId, event, version, body, metadata);
      const mirrored = collaboration && peerReceiver && sourceTarget
        ? reconcileDelegatedFeedback(this.db, userId, sourceTarget.conversation_id, value => workFeedbackSchema.parse(value), workId) : 0;
      if (collaboration && metadata?.report && !peerReceiver) this.collaborations.event(userId, collaboration.collaborationId,
        { operationId: `work-feedback:${createHash("sha256").update(event).digest("hex")}`,
          version: createHash("sha256").update(version).digest("hex"), kind: "returned", workId });
      return { delivered: true, inserted: inserted || mirrored > 0,
        conversationId: sourceTarget?.conversation_id ?? target.conversation_id };
    });
  }

  /** The message itself is the delivery receipt: append and revision commit together.
   * Event identity is scoped to this Work, not a mutable owner/intent version. A
   * changed version after a previous delivery gets a new message, including a
   * blocker reopening after its cleared version was delivered.
   */
  appendWorkFeedback(origin: BotConversation, workId: string, event: string, version: string, text: string, metadata?: WorkFeedbackDto): boolean {
    return workDomainRunTx(this.db, () => {
      if (!this.conversation(origin.user_id, origin.bot_id, origin.conversation_id)) return false;
      const rust = requiresWorkRustWrites(this.db);
      const key = createHash("sha256").update(JSON.stringify([workId, event])).digest("hex");
      const prefix = `work-feedback:${key}:`;
      const fingerprint = createHash("sha256").update(version).digest("hex");
      const dbInboxLinks = this.db.prepare("SELECT work_id FROM work_conversations WHERE channel_type='bot-delivery' AND conversation_id=?")
        .all(origin.conversation_id) as Array<{ work_id: string }>;
      const linkedWorks = new Set(overlayFindAll(this.db, "work_conversations",
        dbInboxLinks.map(r => ({ work_id: r.work_id, conversation_id: origin.conversation_id, channel_type: "bot-delivery" })),
        r => `${r.work_id}\0${r.conversation_id}`,
        r => r.channel_type === "bot-delivery" && r.conversation_id === origin.conversation_id).map(r => String(r.work_id)));
      const dbPrevCandidates = this.db.prepare(`SELECT * FROM bot_messages
        WHERE role='assistant' AND message_id LIKE 'work-feedback-%' AND request_id LIKE ? ORDER BY ordinal DESC`)
        .all(`${prefix}%`) as Array<Record<string, unknown>>;
      const matchingFeedbackMsgs = overlayFindAll(this.db, "bot_messages", dbPrevCandidates, r => String(r.message_id), r => {
        if (r.role !== "assistant" || !String(r.message_id).startsWith("work-feedback-") || !String(r.request_id).startsWith(prefix)) return false;
        if (r.conversation_id === origin.conversation_id) return true;
        if (!String(r.conversation_id).startsWith("bot-inbox-")) return false;
        const fb = this.feedbackForMessage(String(r.message_id));
        if (!fb) return false;
        const meta = JSON.parse(fb.metadata_json) as { workId?: string };
        return Boolean(meta.workId && linkedWorks.has(meta.workId));
      }, (a, b) => Number(b.ordinal ?? 0) - Number(a.ordinal ?? 0));
      const previous = matchingFeedbackMsgs[0] ? { message_id: String(matchingFeedbackMsgs[0].message_id), request_id: String(matchingFeedbackMsgs[0].request_id) } : undefined;
      const unchanged = previous?.request_id.endsWith(`:${fingerprint}`);
      let annotated = false;
      if (metadata) {
        // Backfill only authenticated host-generated identities from this exact
        // event. Older versions remain expandable history, never deleted or
        // reinterpreted from their human-written text.
        const legacy = this.listMessagesForConversation(origin.conversation_id)
          .filter(m => m.bot_id === origin.bot_id && m.role === "assistant" && String(m.message_id).startsWith("work-feedback-")
            && String(m.request_id).startsWith(prefix) && !this.feedbackForMessage(String(m.message_id)))
          .map(m => ({ message_id: String(m.message_id) }));
        for (const item of legacy) annotated = this.saveFeedbackMetadata(item.message_id,
          unchanged && item.message_id === previous?.message_id ? metadata : { ...metadata, report: undefined, category: "progress" }) || annotated;
      }
      if (unchanged) {
        // Upgrade only the exact unchanged event version. Never attach today's
        // result body/files to an older report, and never emit another message.
        if (metadata?.report && previous) {
          const saved = this.feedbackForMessage(previous.message_id);
          if (saved) {
            const existing = workFeedbackSchema.parse(JSON.parse(saved.metadata_json));
            // Repair resolved file labels/targets after a re-execution. The event
            // fingerprint is unchanged and resolution is scoped to its binding;
            // preserve the saved report body and never substitute current files.
            const upgraded = !existing.report ? metadata : { ...existing, category: metadata.category,
              report: { ...existing.report, files: metadata.report.files } };
            const json = JSON.stringify(workFeedbackSchema.parse(upgraded));
            if (json !== saved.metadata_json) {
              if (rust) {
                overlaySet(this.db, "bot_work_feedback", previous.message_id, { message_id: previous.message_id, metadata_json: json });
                enqueueWorkOp(this.db, { op: "botWorkFeedbackUpsert", messageId: previous.message_id, metadataJson: json, overwrite: true });
              } else {
                this.db.prepare("UPDATE bot_work_feedback SET metadata_json=? WHERE message_id=?")
                  .run(json, previous.message_id);
              }
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
      const workIdsJson = JSON.stringify([workId]);
      if (rust) {
        overlaySet(this.db, "bot_messages", messageId, {
          message_id: messageId, conversation_id: origin.conversation_id, bot_id: origin.bot_id,
          request_id: requestId, ordinal: this.nextMessageOrdinal(origin.conversation_id), role: "assistant",
          text, status: "completed", work_ids_json: workIdsJson, error: null, created_at: now, updated_at: now,
        });
        enqueueWorkOp(this.db, {
          op: "botMsgInsert", messageId, conversationId: origin.conversation_id, botId: origin.bot_id,
          requestId, role: "assistant", text, status: "completed", workIdsJson,
          createdAt: now, updatedAt: now, orIgnore: false, attachmentsJson: null,
        });
      } else {
        this.db.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,work_ids_json,created_at,updated_at)
          VALUES (?,?,?,?,'assistant',?,'completed',?,?,?)`)
          .run(messageId, origin.conversation_id, origin.bot_id, requestId, text, workIdsJson, now, now);
      }
      if (metadata) this.saveFeedbackMetadata(messageId, metadata);
      this.touch(origin.conversation_id);
      return true;
    });
  }

  archive(userId: string, botId: string, conversationId: string): void {
    const conversation = this.conversation(userId, botId, conversationId);
    if (!conversation) throw new Error("对话不属于当前用户与 Bot");
    const now = Date.now();
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "bot_conversations", conversationId, () => this.getConvRaw(conversationId),
        cur => cur ? { ...cur, archived_at: now, revision: Number(cur.revision ?? 0) + 1, updated_at: now } : cur);
      enqueueWorkOp(this.db, { op: "botConvArchive", conversationId, now });
      return;
    }
    this.db.prepare("UPDATE bot_conversations SET archived_at=? WHERE conversation_id=?").run(now, conversationId);
    this.touch(conversationId);
  }

  private touch(conversationId: string): void {
    const now = Date.now();
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "bot_conversations", conversationId, () => this.getConvRaw(conversationId),
        cur => cur ? { ...cur, revision: Number(cur.revision ?? 0) + 1, updated_at: now } : cur);
      enqueueWorkOp(this.db, { op: "botConvTouch", conversationId, now });
      return;
    }
    this.db.prepare("UPDATE bot_conversations SET revision=revision+1,updated_at=? WHERE conversation_id=?").run(now, conversationId);
  }

  private saveFeedbackMetadata(messageId: string, metadata: WorkFeedbackDto): boolean {
    const json = JSON.stringify(workFeedbackSchema.parse(metadata));
    if (requiresWorkRustWrites(this.db)) {
      if (this.feedbackForMessage(messageId)) return false;
      overlaySet(this.db, "bot_work_feedback", messageId, { message_id: messageId, metadata_json: json });
      enqueueWorkOp(this.db, { op: "botWorkFeedbackUpsert", messageId, metadataJson: json, overwrite: false });
      return true;
    }
    return this.db.prepare("INSERT OR IGNORE INTO bot_work_feedback(message_id,metadata_json) VALUES (?,?)").run(messageId, json).changes > 0;
  }

  private messageFacts(row: MessageRow): RuntimeBotHistoryFacts {
    const conv = this.getConvRaw(row.conversation_id);
    const receipt = conv ? this.receipt(String(conv.user_id), row.bot_id, row.request_id) : undefined;
    const referenceMessageId = receipt && receipt.conversation_id === row.conversation_id && receipt.assistant_message_id === row.message_id
      ? receipt.reference_message_id : null;
    const scope = conv ? { team_id: (conv.team_id as string | null | undefined) ?? null, user_id: String(conv.user_id), reference_message_id: referenceMessageId } : undefined;
    const version = overlayReadOne<{ revision: number }>(this.db, "bot_message_revisions", row.message_id, () =>
      this.db.prepare('SELECT message_id, revision FROM bot_message_revisions WHERE message_id=?').get(row.message_id) as { message_id: string; revision: number } | undefined);
    const attachmentRow = overlayReadOne<{ attachments_json: string }>(this.db, "bot_message_attachments", row.message_id, () =>
      this.db.prepare("SELECT message_id, attachments_json FROM bot_message_attachments WHERE message_id=?").get(row.message_id) as { message_id: string; attachments_json: string } | undefined);
    const metadata = this.feedbackForMessage(row.message_id);
    const activityRow = row.status === "running"
      ? overlayReadOne<{ activity_json: string }>(this.db, "bot_message_activity", row.message_id, () =>
        this.db.prepare("SELECT message_id, activity_json FROM bot_message_activity WHERE message_id=?").get(row.message_id) as { message_id: string; activity_json: string } | undefined)
      : undefined;
    const segmentRow = row.role === "assistant"
      ? overlayReadOne<{ segments_json: string }>(this.db, "bot_message_segments", row.message_id, () =>
        this.db.prepare("SELECT message_id, segments_json FROM bot_message_segments WHERE message_id=?").get(row.message_id) as { message_id: string; segments_json: string } | undefined)
      : undefined;
    const toolRow = row.role === "assistant"
      ? overlayReadOne<{ task_id: string; tools_json: string }>(this.db, "bot_message_tools", row.message_id, () =>
        this.db.prepare("SELECT message_id, task_id, tools_json FROM bot_message_tools WHERE message_id=?").get(row.message_id) as { message_id: string; task_id: string; tools_json: string } | undefined)
      : undefined;
    return {
      team_id: scope?.team_id ?? null, user_id: scope?.user_id ?? null, reference_message_id: scope?.reference_message_id ?? null,
      revision: version?.revision ?? 0, attachments_json: attachmentRow?.attachments_json ?? null,
      metadata_json: metadata?.metadata_json ?? null, activity_json: activityRow?.activity_json ?? null,
      segments_json: segmentRow?.segments_json ?? null, tool_task_id: toolRow?.task_id ?? null, tools_json: toolRow?.tools_json ?? null,
    };
  }

  private mapMessage(value: unknown, storedFacts?: RuntimeBotHistoryFacts): BotMessageDto {
    const row = messageRow.parse(value);
    const facts = storedFacts ?? this.messageFacts(row);
    const attachments = facts.attachments_json !== null ? z.array(botAttachmentSchema).parse(JSON.parse(facts.attachments_json)) : undefined;
    const parsed = facts.metadata_json !== null ? workFeedbackSchema.safeParse(JSON.parse(facts.metadata_json)) : undefined;
    const activity = facts.activity_json !== null ? botActivitySchema.safeParse(JSON.parse(facts.activity_json)) : undefined;
    const segments = facts.segments_json !== null ? z.array(botReplySegmentSchema).parse(JSON.parse(facts.segments_json)) : undefined;
    const tools = facts.tools_json !== null ? settleBotCapabilityTools(JSON.parse(facts.tools_json) as ChatToolCallDto[], row.status) : undefined;
    const organizationUser = row.role === "assistant" ? facts.user_id : undefined;
    const organizations = typeof organizationUser === "string" ? botOrganizationsForMessage(this.db, organizationUser, row.message_id) : [];
    const peerOrigin = this.peers.origin(row.message_id);
    const collaborationResult = peerOrigin && typeof organizationUser === "string"
      ? this.collaborations.feedbackForReturn({ userId: organizationUser, botId: row.bot_id, conversationId: row.conversation_id, origin: peerOrigin }) : undefined;
    const clarificationRows = row.role === "assistant" && row.status === "completed" ? this.db.prepare(`SELECT g.value AS goal FROM bot_request_runs r
      JOIN bot_messages m ON m.message_id=r.message_id, json_each(r.context_json,'$.clarificationState.goals') g
      WHERE m.conversation_id=? AND json_extract(g.value,'$.updatedBy')=?`).all(row.conversation_id,row.message_id) as {goal:string}[] : [];
    // Ordinary history must not depend on the optional team-template service schema.
    // Only live interactive goals need a current-owner check.
    const clarificationGoals = clarificationRows.map(value=>JSON.parse(value.goal)).filter(goal=>goal.options);
    const needsTeamOwner = Boolean(facts.team_id && clarificationGoals.some(goal=>goal.state==="pending"));
    const team = needsTeamOwner ? this.db.prepare("SELECT plan_json,deleted_at FROM work_team_templates WHERE template_id=?").get(facts.team_id) as {plan_json:string;deleted_at:number|null}|undefined : undefined;
    const ownerChanged = Boolean(needsTeamOwner && (!team || team.deleted_at!==null || JSON.parse(team.plan_json).ownerBotId!==row.bot_id));
    const clarifications = clarificationGoals.flatMap(goal=>{
      const answerRow = overlayReadOne<{ answer_message_id: string }>(this.db, "bot_clarification_answers", `${row.message_id}\0${goal.goalId}`, () =>
        this.db.prepare("SELECT * FROM bot_clarification_answers WHERE question_message_id=? AND goal_id=?").get(row.message_id, goal.goalId) as { answer_message_id: string } | undefined);
      const answerMsg = answerRow ? this.getMessageRaw(answerRow.answer_message_id) : undefined;
      const answer = answerMsg ? { text: String(answerMsg.text) } : undefined;
      const answered=goal.state==="pending" && Boolean(answer);
      return goal.options ? [botClarificationSchema.parse({goalId:goal.goalId,question:goal.question,options:goal.options,answerText:answer?.text,status:goal.state==="pending"&&ownerChanged ? "expired" : answered ? "answered" : goal.state})] : [];
    });
    return { clarifications, peerOrigin, collaborationResult, ...(organizations.length ? { organizations } : {}), teamId: facts.team_id ?? undefined, messageRevision: facts.revision, messageId: row.message_id, conversationId: row.conversation_id, botId: row.bot_id, requestId: row.request_id,
      referenceMessageId: row.role === "assistant" ? facts.reference_message_id ?? undefined : undefined,
      segments, tools, toolTaskId: facts.tool_task_id ?? undefined, botCalls: row.role === "assistant" ? this.peerCalls.list(row.message_id) : undefined,
      collaborations: row.role === "assistant" ? this.collaborations.summariesForMessage(
        z.string().parse(facts.user_id), row.message_id) : undefined,
      metrics: this.metrics.read(row.message_id), workFeedback: parsed?.success ? parsed.data : undefined, attachments, activity: activity?.success ? activity.data : undefined,
      ordinal: row.ordinal, role: row.role, text: row.text, status: row.status,
      // A delegation's original answer and each authenticated return/request
      // need the Work even when no result report exists or the anchor is paged
      // out. Project only assistants; do not change user control provenance.
      workIds: [...new Set([...z.array(z.string()).parse(JSON.parse(row.work_ids_json)),
        ...(row.role === "assistant" && typeof organizationUser === "string"
          ? delegatedReplyWorkIds(this.db, organizationUser, row.message_id) : [])])], error: row.error ?? undefined,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
}
