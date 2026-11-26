import {botIncomingMessagesQuerySchema, type BotIncomingMessagesQuery, type BotIncomingMessagesPage} from '../../../shared/bot-collaboration';
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { isSharedBotConversation } from "./BotConversationAudience";
import type { BotPeerOrigin } from "../../../shared/bot-peer-origin";
import type { WorkFeedbackDto } from "../../../shared/bot-work-feedback";
import {
  botCollaborationSchema, botCollaborationMessageSchema, botCollaborationEventSchema,
  botCollaborationPreviewSchema, botCollaborationsQuerySchema, botCollaborationHistoryQuerySchema,
  type BotCollaborationDto, type BotCollaborationMessageDto, type BotCollaborationEventDto,
  type BotCollaborationPreviewDto, type BotCollaborationStatus, type BotCollaborationTimes,
  type BotCollaborationsQuery, type BotCollaborationsPage,
  type BotCollaborationHistoryQuery, type BotCollaborationHistoryPage,
} from "../../../shared/bot-collaboration";
import { enqueueWorkOp, overlayDelete, overlayFindAll, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites, workDomainRunTx } from "./WorkDomainRuntime";

const id = z.string().trim().min(1).max(500);
const timestamp = z.number().int().nonnegative();
const sourceSchema = z.object({
  conversationId: id, requestId: id, userMessageId: id, assistantMessageId: id,
}).strict();
const ensureSchema = z.object({
  userId: id, sourceBotId: id, sourceDisplayName: z.string(), sourceConversationId: id,
  sourceRequestId: id, sourceUserMessageId: id, sourceAssistantMessageId: id,
  targetBotId: id, targetDisplayName: z.string(), operationId: id, now: timestamp.optional(),
}).strict();
export type BotCollaborationInitiation = z.infer<typeof ensureSchema>;
export type BotCollaborationRequestLink = z.infer<typeof sourceSchema>;
const messageInputSchema = botCollaborationMessageSchema.omit({
  messageId: true, collaborationId: true, ordinal: true, createdAt: true,
}).extend({ version: z.string().max(4000).optional(), createdAt: timestamp.optional() }).strict();
export type BotCollaborationMessageInput = z.infer<typeof messageInputSchema>;
const eventInputSchema = botCollaborationEventSchema.omit({
  eventId: true, collaborationId: true, ordinal: true, createdAt: true,
}).extend({ version: z.string().max(4000).optional(), createdAt: timestamp.optional() }).strict();
export type BotCollaborationEventInput = z.infer<typeof eventInputSchema>;
const previewInputSchema = botCollaborationPreviewSchema.omit({ collaborationId: true }).extend({ updatedAt: timestamp.optional() });
const storedSchema = z.object({ value_json: z.string(), payload_hash: z.string() });
const relationRowSchema = z.object({
  value_json: z.string(), initiation_hash: z.string(), work_id: z.string().nullable(),
  created_at: timestamp, updated_at: timestamp, status: z.string(), times_json: z.string(),
});
const listCursorSchema = z.object({ scope: z.string(), createdAt: timestamp, collaborationId: id }).strict();
const historyCursorSchema = z.object({ scope: z.string(), before: z.number().int().positive() }).strict();
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const timeField: Partial<Record<BotCollaborationStatus, keyof BotCollaborationTimes>> = {
  sent: "sentAt", delivered: "deliveredAt", accepted: "acceptedAt", started: "startedAt",
  ended: "endedAt", returning: "returningAt", returned: "returnedAt",
};

/** Owns communication identity and receipts. Work and Durable keep their own state.
 * Source IDs deliberately have no cascading foreign keys: deleting a chat cannot
 * erase accepted responsibility or select another delivery destination. */
export class BotCollaborationRepository {
  constructor(private readonly db: Database.Database) {
    if (db.readonly) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_collaborations (
        collaboration_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        source_bot_id TEXT NOT NULL, source_conversation_id TEXT NOT NULL,
        target_bot_id TEXT NOT NULL, initiation_key TEXT NOT NULL UNIQUE,
        initiation_hash TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        work_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        status TEXT NOT NULL, times_json TEXT NOT NULL CHECK(json_valid(times_json)),
        next_ordinal INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_bot_collaboration_source
        ON bot_collaborations(user_id,source_bot_id,created_at DESC,collaboration_id DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_collaboration_target
        ON bot_collaborations(user_id,target_bot_id,created_at DESC,collaboration_id DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_collaboration_conversation
        ON bot_collaborations(user_id,source_conversation_id,created_at DESC,collaboration_id DESC);
      CREATE TABLE IF NOT EXISTS bot_collaboration_requests (
        collaboration_id TEXT NOT NULL REFERENCES bot_collaborations(collaboration_id) ON DELETE RESTRICT,
        conversation_id TEXT NOT NULL, request_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL,
        PRIMARY KEY(collaboration_id,request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_collaboration_request_user_message ON bot_collaboration_requests(user_message_id);
      CREATE INDEX IF NOT EXISTS idx_bot_collaboration_request_assistant ON bot_collaboration_requests(assistant_message_id);
      CREATE TABLE IF NOT EXISTS bot_collaboration_messages (
        message_id TEXT PRIMARY KEY, collaboration_id TEXT NOT NULL REFERENCES bot_collaborations(collaboration_id) ON DELETE RESTRICT,
        operation_key TEXT NOT NULL, ordinal INTEGER NOT NULL, payload_hash TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK(json_valid(value_json)), UNIQUE(collaboration_id,operation_key),
        UNIQUE(collaboration_id,ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_collaboration_message_page ON bot_collaboration_messages(collaboration_id,ordinal DESC);
      CREATE TABLE IF NOT EXISTS bot_collaboration_events (
        event_id TEXT PRIMARY KEY, collaboration_id TEXT NOT NULL REFERENCES bot_collaborations(collaboration_id) ON DELETE RESTRICT,
        operation_key TEXT NOT NULL, ordinal INTEGER NOT NULL, payload_hash TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK(json_valid(value_json)), UNIQUE(collaboration_id,operation_key),
        UNIQUE(collaboration_id,ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_collaboration_event_page ON bot_collaboration_events(collaboration_id,ordinal DESC);
      CREATE TABLE IF NOT EXISTS bot_collaboration_previews (
        collaboration_id TEXT NOT NULL REFERENCES bot_collaborations(collaboration_id) ON DELETE RESTRICT,
        exchange_id TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        PRIMARY KEY(collaboration_id,exchange_id)
      );
      CREATE TABLE IF NOT EXISTS bot_collaboration_message_order (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE REFERENCES bot_collaboration_messages(message_id) ON DELETE CASCADE
      );
      INSERT INTO bot_collaboration_message_order(message_id)
        SELECT message_id FROM bot_collaboration_messages m
        WHERE NOT EXISTS (SELECT 1 FROM bot_collaboration_message_order o WHERE o.message_id=m.message_id)
        ORDER BY m.rowid;
      CREATE TRIGGER IF NOT EXISTS bot_collaboration_message_order_insert AFTER INSERT ON bot_collaboration_messages BEGIN
        INSERT INTO bot_collaboration_message_order(message_id) VALUES (NEW.message_id);
      END;
      CREATE TRIGGER IF NOT EXISTS bot_collaboration_source_revision AFTER UPDATE OF work_id,updated_at,status,times_json ON bot_collaborations BEGIN
        UPDATE bot_message_revisions SET revision=revision+1 WHERE message_id IN (
          SELECT user_message_id FROM bot_collaboration_requests WHERE collaboration_id=NEW.collaboration_id
          UNION SELECT assistant_message_id FROM bot_collaboration_requests WHERE collaboration_id=NEW.collaboration_id
        );
        UPDATE bot_conversations SET revision=revision+1 WHERE conversation_id IN (
          SELECT conversation_id FROM bot_collaboration_requests WHERE collaboration_id=NEW.collaboration_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS bot_collaboration_link_revision AFTER INSERT ON bot_collaboration_requests BEGIN
        UPDATE bot_message_revisions SET revision=revision+1
          WHERE message_id IN (NEW.user_message_id,NEW.assistant_message_id);
        UPDATE bot_conversations SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
      END;
    `);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='works'").get()) db.exec(`
      CREATE TRIGGER IF NOT EXISTS bot_collaboration_work_revision AFTER UPDATE ON works BEGIN
        UPDATE bot_collaborations SET updated_at=MAX(updated_at,NEW.updated_at) WHERE work_id=NEW.work_id;
      END;
    `);
  }

  private getCollabRow(collaborationId: string): Record<string, unknown> | undefined {
    return overlayReadOne(this.db, "bot_collaborations", collaborationId, () =>
      this.db.prepare("SELECT * FROM bot_collaborations WHERE collaboration_id=?").get(collaborationId) as Record<string, unknown> | undefined);
  }

  private listCollabMessages(collaborationId: string): Array<Record<string, unknown>> {
    const dbRows = this.db.prepare("SELECT * FROM bot_collaboration_messages WHERE collaboration_id=? ORDER BY ordinal ASC")
      .all(collaborationId) as Array<Record<string, unknown>>;
    return overlayFindAll(this.db, "bot_collaboration_messages", dbRows, r => String(r.message_id),
      r => r.collaboration_id === collaborationId, (a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
  }

  private listCollabEvents(collaborationId: string): Array<Record<string, unknown>> {
    const dbRows = this.db.prepare("SELECT * FROM bot_collaboration_events WHERE collaboration_id=? ORDER BY ordinal ASC")
      .all(collaborationId) as Array<Record<string, unknown>>;
    return overlayFindAll(this.db, "bot_collaboration_events", dbRows, r => String(r.event_id),
      r => r.collaboration_id === collaborationId, (a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
  }

  ensure(input: BotCollaborationInitiation): BotCollaborationDto {
    const parsed = ensureSchema.parse(input);
    if (parsed.sourceBotId === parsed.targetBotId) throw new Error("不能向自己发起 Bot 协作");
    const { now: suppliedNow, sourceDisplayName: _sourceName, targetDisplayName: _targetName, ...identity } = parsed;
    const initiationKey = digest([parsed.userId, parsed.sourceAssistantMessageId, parsed.operationId]);
    const payloadHash = digest(identity);
    return workDomainRunTx(this.db, () => {
      const priorRows = this.db.prepare("SELECT * FROM bot_collaborations WHERE initiation_key=?").all(initiationKey) as Array<Record<string, unknown>>;
      const prior = overlayFindAll(this.db, "bot_collaborations", priorRows, r => String(r.collaboration_id), r => r.initiation_key === initiationKey)[0];
      const previous = z.object({ collaboration_id: id, initiation_hash: z.string() }).optional().parse(prior);
      if (previous) {
        if (previous.initiation_hash !== payloadHash) throw new Error("idempotency_conflict: 同一协作操作不能更换目标或来源");
        return this.required(parsed.userId, previous.collaboration_id);
      }
      this.requireReceipt(parsed.userId, parsed.sourceBotId, {
        conversationId: parsed.sourceConversationId, requestId: parsed.sourceRequestId,
        userMessageId: parsed.sourceUserMessageId, assistantMessageId: parsed.sourceAssistantMessageId,
      });
      const targetBot = overlayReadOne(this.db, "bots", parsed.targetBotId, () =>
        this.db.prepare("SELECT bot_id, user_id FROM bots WHERE bot_id=? AND user_id=?").get(parsed.targetBotId, parsed.userId) as Record<string, unknown> | undefined);
      if (!targetBot || targetBot.user_id !== parsed.userId)
        throw new Error("目标 Bot 不属于当前用户");
      const now = suppliedNow ?? Date.now();
      const collaboration = botCollaborationSchema.parse({
        collaborationId: `bot-collaboration-${digest([initiationKey, parsed.targetBotId])}`,
        userId: parsed.userId, sourceBotId: parsed.sourceBotId, sourceDisplayName: parsed.sourceDisplayName,
        sourceConversationId: parsed.sourceConversationId, sourceRequestId: parsed.sourceRequestId,
        sourceUserMessageId: parsed.sourceUserMessageId, sourceAssistantMessageId: parsed.sourceAssistantMessageId,
        targetBotId: parsed.targetBotId, targetDisplayName: parsed.targetDisplayName, workId: null,
        createdAt: now, updatedAt: now, messageCount: 0, status: "sent", originAvailable: true,
        times: { sentAt: now, deliveredAt: null, acceptedAt: null, startedAt: null, endedAt: null, returningAt: null, returnedAt: null },
      });
      const valueJson = JSON.stringify(collaboration);
      const timesJson = JSON.stringify(collaboration.times);
      if (requiresWorkRustWrites(this.db)) {
        overlaySet(this.db, "bot_collaborations", collaboration.collaborationId, {
          collaboration_id: collaboration.collaborationId, user_id: parsed.userId,
          source_bot_id: parsed.sourceBotId, source_conversation_id: parsed.sourceConversationId,
          target_bot_id: parsed.targetBotId, initiation_key: initiationKey, initiation_hash: payloadHash,
          value_json: valueJson, work_id: null, created_at: now, updated_at: now,
          status: collaboration.status, times_json: timesJson, next_ordinal: 0,
        });
        enqueueWorkOp(this.db, {
          op: "botCollabInsert", collaborationId: collaboration.collaborationId, userId: parsed.userId,
          sourceBotId: parsed.sourceBotId, sourceConversationId: parsed.sourceConversationId,
          targetBotId: parsed.targetBotId, initiationKey, initiationHash: payloadHash,
          valueJson, createdAt: now, updatedAt: now, status: collaboration.status, timesJson,
        });
      } else {
        this.db.prepare(`INSERT INTO bot_collaborations(collaboration_id,user_id,source_bot_id,source_conversation_id,target_bot_id,
          initiation_key,initiation_hash,value_json,created_at,updated_at,status,times_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(collaboration.collaborationId, parsed.userId, parsed.sourceBotId, parsed.sourceConversationId,
            parsed.targetBotId, initiationKey, payloadHash, valueJson, now, now, collaboration.status, timesJson);
      }
      this.linkRequest(parsed.userId, collaboration.collaborationId, {
        conversationId: parsed.sourceConversationId, requestId: parsed.sourceRequestId,
        userMessageId: parsed.sourceUserMessageId, assistantMessageId: parsed.sourceAssistantMessageId,
      });
      return this.required(parsed.userId, collaboration.collaborationId);
    });
  }

  get(userId: string, collaborationId: string): BotCollaborationDto | undefined {
    const rawRow = this.getCollabRow(collaborationId);
    const row = rawRow && rawRow.user_id === userId ? relationRowSchema.parse(rawRow) : undefined;
    if (!row) return;
    const base = botCollaborationSchema.parse(JSON.parse(row.value_json));
    const msgs = this.listCollabMessages(collaborationId);
    const count = msgs.length;
    const sourceBot = overlayReadOne(this.db, "bots", base.sourceBotId, () =>
      this.db.prepare("SELECT bot_id, user_id FROM bots WHERE user_id=? AND bot_id=?").get(userId, base.sourceBotId) as Record<string, unknown> | undefined);
    const targetBot = overlayReadOne(this.db, "bots", base.targetBotId, () =>
      this.db.prepare("SELECT bot_id, user_id FROM bots WHERE user_id=? AND bot_id=?").get(userId, base.targetBotId) as Record<string, unknown> | undefined);
    const sourceBotExists = Boolean(sourceBot && sourceBot.user_id === userId);
    const targetBotExists = Boolean(targetBot && targetBot.user_id === userId);
    const sourceConv = overlayReadOne(this.db, "bot_conversations", base.sourceConversationId, () =>
      this.db.prepare("SELECT * FROM bot_conversations WHERE user_id=? AND bot_id=? AND conversation_id=?")
        .get(userId, base.sourceBotId, base.sourceConversationId) as Record<string, unknown> | undefined);
    const originAvailable = sourceBotExists && Boolean(sourceConv && sourceConv.user_id === userId && sourceConv.bot_id === base.sourceBotId);
    const work = row.work_id ? this.workProjection(userId, collaborationId, row.work_id) : undefined;
    const decodedMsgs = msgs.map(m => JSON.parse(String(m.value_json)) as { kind?: string; senderBotId?: string; text?: string });
    const reqMsg = decodedMsgs.find(m => m.kind === "request");
    const replyMsg = [...decodedMsgs].reverse().find(m => m.senderBotId === base.targetBotId && m.kind !== "request");
    const requestPreview = reqMsg?.text !== undefined ? Array.from(reqMsg.text).slice(0, 500).join("") : null;
    const replyPreview = replyMsg?.text !== undefined ? Array.from(replyMsg.text).slice(0, 500).join("") : null;
    return botCollaborationSchema.parse({ ...base, workId: row.work_id, updatedAt: row.updated_at,
      messageCount: count, status: row.status, times: JSON.parse(row.times_json), originAvailable, sourceBotExists, targetBotExists,
      ...(requestPreview !== null ? { requestPreview } : {}),
      ...(replyPreview !== null ? { replyPreview } : {}), ...(work ? { work } : {}) });
  }

  scoped(userId: string, botId: string, collaborationId: string, sourceConversationId?: string): BotCollaborationDto {
    const relation = this.required(userId, collaborationId);
    if (relation.sourceBotId !== botId && relation.targetBotId !== botId)
      throw new Error("协作不属于当前用户与 Bot");
    const reqRows = this.db.prepare("SELECT * FROM bot_collaboration_requests WHERE collaboration_id=? AND conversation_id=?")
      .all(collaborationId, sourceConversationId ?? "") as Array<Record<string, unknown>>;
    const matchingReqs = sourceConversationId === undefined ? [] : overlayFindAll(
      this.db, "bot_collaboration_requests", reqRows, r => `${r.collaboration_id}\0${r.request_id}`,
      r => r.collaboration_id === collaborationId && r.conversation_id === sourceConversationId);
    const linked = matchingReqs.some(q => {
      const r = overlayReadOne(this.db, "bot_send_receipts", `${userId}\0${botId}\0${q.request_id}`, () =>
        this.db.prepare("SELECT * FROM bot_send_receipts WHERE user_id=? AND bot_id=? AND request_id=?")
          .get(userId, botId, String(q.request_id)) as Record<string, unknown> | undefined);
      return Boolean(r && r.conversation_id === q.conversation_id && r.user_message_id === q.user_message_id && r.assistant_message_id === q.assistant_message_id);
    });
    if (sourceConversationId !== undefined && (relation.sourceBotId !== botId
      || relation.sourceConversationId !== sourceConversationId && !linked))
      throw new Error("协作不属于当前来源会话");
    return relation;
  }

  byWork(userId: string, workId: string): BotCollaborationDto | undefined {
    const dbRows = this.db.prepare("SELECT * FROM bot_collaborations WHERE user_id=? AND work_id=?")
      .all(userId, workId) as Array<Record<string, unknown>>;
    const row = overlayFindAll(this.db, "bot_collaborations", dbRows, r => String(r.collaboration_id),
      r => r.user_id === userId && r.work_id === workId)[0];
    return row ? this.get(userId, String(row.collaboration_id)) : undefined;
  }

  linkWork(userId: string, collaborationId: string, workId: string): BotCollaborationDto {
    return workDomainRunTx(this.db, () => {
      const relation = this.required(userId, collaborationId);
      if (relation.workId && relation.workId !== workId) throw new Error("同一协作只能绑定一个 Work，请在原事项修订");
      const work = z.object({ user_id: z.string(), owner_bot_id: z.string() }).optional().parse(
        overlayReadOne(this.db, "works", workId, () =>
          this.db.prepare("SELECT user_id,owner_bot_id FROM works WHERE work_id=?").get(workId) as Record<string, unknown> | undefined));
      if (!work || work.user_id !== userId || work.owner_bot_id !== relation.targetBotId)
        throw new Error("协作只能绑定目标 Bot 负责的当前用户事项");
      const other = this.byWork(userId, workId);
      if (other && other.collaborationId !== collaborationId) throw new Error("Work 已绑定另一协作");
      if (!relation.workId) {
        const peerTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_peer_deliveries'").get();
        const frontend = peerTable && this.db.prepare(`SELECT 1 FROM bot_peer_deliveries WHERE user_id=?
          AND json_extract(origin_json,'$.collaborationId')=? AND json_extract(origin_json,'$.kind')='request'`).get(userId, collaborationId);
        const times: BotCollaborationTimes = frontend ? relation.times : { sentAt: null, deliveredAt: null, acceptedAt: null,
          startedAt: null, endedAt: null, returningAt: null, returnedAt: null };
        const timesJson = JSON.stringify(times);
        const status = frontend ? relation.status : "sent";
        if (requiresWorkRustWrites(this.db)) {
          overlayMutate(this.db, "bot_collaborations", collaborationId, () => this.getCollabRow(collaborationId),
            cur => cur ? { ...cur, work_id: workId, times_json: timesJson, status } : cur);
          enqueueWorkOp(this.db, { op: "botCollabUpdateWork", userId, collaborationId, workId, timesJson, status });
        } else {
          this.db.prepare("UPDATE bot_collaborations SET work_id=?,times_json=?,status=? WHERE user_id=? AND collaboration_id=?")
            .run(workId, timesJson, status, userId, collaborationId);
        }
      }
      return this.required(userId, collaborationId);
    });
  }

  linkRequest(userId: string, collaborationId: string, input: BotCollaborationRequestLink): void {
    const parsed = sourceSchema.parse(input);
    const relation = this.required(userId, collaborationId);
    this.requireReceipt(userId, relation.sourceBotId, parsed);
    if (relation.sourceConversationId !== parsed.conversationId && (isSharedBotConversation(this.db, relation.sourceConversationId)
      || isSharedBotConversation(this.db, parsed.conversationId)))
      throw new Error("共享渠道与私人会话不能混用协作控制身份");
    const priorRaw = overlayReadOne(this.db, "bot_collaboration_requests", `${collaborationId}\0${parsed.requestId}`, () =>
      this.db.prepare(`SELECT conversation_id,request_id,user_message_id,assistant_message_id FROM bot_collaboration_requests
        WHERE collaboration_id=? AND request_id=?`).get(collaborationId, parsed.requestId) as Record<string, unknown> | undefined);
    const prior = priorRaw ? sourceSchema.parse({
      conversationId: priorRaw.conversation_id, requestId: priorRaw.request_id,
      userMessageId: priorRaw.user_message_id, assistantMessageId: priorRaw.assistant_message_id,
    }) : undefined;
    if (prior && JSON.stringify(prior) !== JSON.stringify(parsed)) throw new Error("idempotency_conflict: 协作请求身份已绑定");
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "bot_collaboration_requests", `${collaborationId}\0${parsed.requestId}`, () => priorRaw, cur => cur ?? {
        collaboration_id: collaborationId, conversation_id: parsed.conversationId, request_id: parsed.requestId,
        user_message_id: parsed.userMessageId, assistant_message_id: parsed.assistantMessageId,
      });
      overlayMutate(this.db, "bot_conversations", parsed.conversationId, () =>
        this.db.prepare("SELECT * FROM bot_conversations WHERE conversation_id=?").get(parsed.conversationId) as Record<string, unknown> | undefined,
      cur => cur ? { ...cur, revision: Number(cur.revision ?? 0) + 1 } : cur);
      enqueueWorkOp(this.db, {
        op: "botCollabRequestInsert", collaborationId, conversationId: parsed.conversationId,
        requestId: parsed.requestId, userMessageId: parsed.userMessageId, assistantMessageId: parsed.assistantMessageId,
      });
      return;
    }
    this.db.prepare(`INSERT OR IGNORE INTO bot_collaboration_requests
      (collaboration_id,conversation_id,request_id,user_message_id,assistant_message_id) VALUES (?,?,?,?,?)`)
      .run(collaborationId, parsed.conversationId, parsed.requestId, parsed.userMessageId, parsed.assistantMessageId);
  }

  summariesForMessage(userId: string, messageId: string): BotCollaborationDto[] {
    const dbReqs = this.db.prepare("SELECT * FROM bot_collaboration_requests WHERE user_message_id=? OR assistant_message_id=?")
      .all(messageId, messageId) as Array<Record<string, unknown>>;
    const reqs = overlayFindAll(this.db, "bot_collaboration_requests", dbReqs, r => `${r.collaboration_id}\0${r.request_id}`,
      r => r.user_message_id === messageId || r.assistant_message_id === messageId);
    const seen = new Set<string>();
    const matches: Array<{ dto: BotCollaborationDto; createdAt: number }> = [];
    for (const r of reqs) {
      const cid = String(r.collaboration_id);
      if (seen.has(cid)) continue;
      seen.add(cid);
      const row = this.getCollabRow(cid);
      if (row && row.user_id === userId) matches.push({ dto: this.required(userId, cid), createdAt: Number(row.created_at ?? 0) });
    }
    matches.sort((a, b) => a.createdAt - b.createdAt || a.dto.collaborationId.localeCompare(b.dto.collaborationId));
    return matches.map(m => m.dto);
  }

  feedbackForReturn(input: { userId: string; botId: string; conversationId: string; origin: BotPeerOrigin }): WorkFeedbackDto | undefined {
    const { userId, botId, conversationId, origin } = input;
    if (origin.kind !== "return" || origin.sourceBotId !== botId || origin.sourceConversationId !== conversationId) return;
    const msg = overlayReadOne(this.db, "bot_collaboration_messages", origin.replyMessageId, () =>
      this.db.prepare("SELECT * FROM bot_collaboration_messages WHERE message_id=?").get(origin.replyMessageId) as Record<string, unknown> | undefined);
    const col = this.getCollabRow(origin.collaborationId);
    if (!msg || !col || msg.collaboration_id !== origin.collaborationId || col.user_id !== userId
      || col.source_bot_id !== botId || col.source_conversation_id !== conversationId) return;
    if (col.target_bot_id !== origin.senderBotId) return;
    const message = botCollaborationMessageSchema.parse(JSON.parse(String(msg.value_json)));
    if (message.senderBotId !== origin.senderBotId || message.workFeedback?.workId !== (col.work_id ?? null)) return;
    return message.workFeedback;
  }

  appendMessage(userId: string, collaborationId: string, input: BotCollaborationMessageInput): BotCollaborationMessageDto {
    const parsed = messageInputSchema.parse(input);
    if (!parsed.text.trim()) throw new Error("不能将空文本计为协作消息");
    return workDomainRunTx(this.db, () => {
      const relation = this.required(userId, collaborationId);
      if (parsed.senderBotId !== relation.sourceBotId && parsed.senderBotId !== relation.targetBotId)
        throw new Error("消息发送者不属于此协作");
      if (parsed.workFeedback && parsed.workFeedback.workId !== relation.workId)
        throw new Error("成果消息的 Work 不属于此协作");
      const operationKey = digest([parsed.operationId, parsed.kind, parsed.version ?? null]);
      const { createdAt: _observedAt, ...identity } = parsed;
      const hash = digest(identity);
      const existing = this.listCollabMessages(collaborationId).find(m => m.operation_key === operationKey);
      if (existing) {
        const parsedStored = storedSchema.parse(existing);
        if (parsedStored.payload_hash !== hash) throw new Error("idempotency_conflict: 协作消息标识已用于不同正文");
        return botCollaborationMessageSchema.parse(JSON.parse(parsedStored.value_json));
      }
      const { version: _version, createdAt: suppliedCreatedAt, ...body } = parsed;
      const createdAt = suppliedCreatedAt ?? Date.now();
      const message = botCollaborationMessageSchema.parse({ ...body, collaborationId,
        messageId: `bot-exchange-message-${digest([collaborationId, operationKey])}`,
        ordinal: this.nextOrdinal(collaborationId), createdAt });
      const valueJson = JSON.stringify(message);
      if (requiresWorkRustWrites(this.db)) {
        overlaySet(this.db, "bot_collaboration_messages", message.messageId, {
          message_id: message.messageId, collaboration_id: collaborationId,
          operation_key: operationKey, ordinal: message.ordinal, payload_hash: hash, value_json: valueJson,
        });
        overlayMutate(this.db, "bot_collaborations", collaborationId, () => this.getCollabRow(collaborationId),
          cur => cur ? { ...cur, updated_at: Math.max(Number(cur.updated_at ?? 0), createdAt) } : cur);
        enqueueWorkOp(this.db, {
          op: "botCollabMessageInsert", messageId: message.messageId, collaborationId,
          operationKey, ordinal: message.ordinal, payloadHash: hash, valueJson, createdAt,
        });
      } else {
        this.db.prepare(`INSERT INTO bot_collaboration_messages(message_id,collaboration_id,operation_key,ordinal,payload_hash,value_json)
          VALUES (?,?,?,?,?,?)`).run(message.messageId, collaborationId, operationKey, message.ordinal, hash, valueJson);
        this.touch(collaborationId, createdAt);
      }
      return message;
    });
  }

  event(userId: string, collaborationId: string, input: BotCollaborationEventInput): BotCollaborationEventDto {
    const parsed = eventInputSchema.parse(input);
    return workDomainRunTx(this.db, () => {
      const relation = this.required(userId, collaborationId);
      if (parsed.workId && parsed.workId !== relation.workId) throw new Error("事件 Work 不属于此协作");
      const operationKey = digest([parsed.operationId, parsed.kind, parsed.version ?? null]);
      const { createdAt: _observedAt, ...identity } = parsed;
      const hash = digest(identity);
      const existing = this.listCollabEvents(collaborationId).find(e => e.operation_key === operationKey);
      if (existing) {
        const parsedStored = storedSchema.parse(existing);
        if (parsedStored.payload_hash !== hash) throw new Error("idempotency_conflict: 协作事件标识已用于不同事实");
        return botCollaborationEventSchema.parse(JSON.parse(parsedStored.value_json));
      }
      const { version: _version, createdAt: suppliedCreatedAt, ...body } = parsed;
      const createdAt = suppliedCreatedAt ?? Date.now();
      const event = botCollaborationEventSchema.parse({ ...body, collaborationId,
        eventId: `bot-exchange-event-${digest([collaborationId, operationKey])}`,
        ordinal: this.nextOrdinal(collaborationId), createdAt });
      const field = timeField[event.kind];
      const times = { ...relation.times };
      if (field && (!relation.workId || event.workId === relation.workId)) {
        if (event.kind === "returned" || event.kind === "returning") times[field] = Math.max(times[field] ?? 0, createdAt);
        else if (times[field] === null) times[field] = createdAt;
      }
      const valueJson = JSON.stringify(event);
      const timesJson = JSON.stringify(times);
      if (requiresWorkRustWrites(this.db)) {
        overlaySet(this.db, "bot_collaboration_events", event.eventId, {
          event_id: event.eventId, collaboration_id: collaborationId,
          operation_key: operationKey, ordinal: event.ordinal, payload_hash: hash, value_json: valueJson,
        });
        overlayMutate(this.db, "bot_collaborations", collaborationId, () => this.getCollabRow(collaborationId),
          cur => cur ? { ...cur, status: event.kind, times_json: timesJson, updated_at: Math.max(Number(cur.updated_at ?? 0), createdAt) } : cur);
        enqueueWorkOp(this.db, {
          op: "botCollabEventInsert", eventId: event.eventId, collaborationId, operationKey,
          ordinal: event.ordinal, payloadHash: hash, valueJson, kind: event.kind, timesJson, createdAt,
        });
      } else {
        this.db.prepare(`INSERT INTO bot_collaboration_events(event_id,collaboration_id,operation_key,ordinal,payload_hash,value_json)
          VALUES (?,?,?,?,?,?)`).run(event.eventId, collaborationId, operationKey, event.ordinal, hash, valueJson);
        this.db.prepare(`UPDATE bot_collaborations SET status=?,times_json=?,updated_at=MAX(updated_at,?) WHERE collaboration_id=?`)
          .run(event.kind, timesJson, createdAt, collaborationId);
      }
      return event;
    });
  }

  setPreview(userId: string, collaborationId: string, input: Omit<BotCollaborationPreviewDto, "collaborationId" | "updatedAt"> & { updatedAt?: number }): void {
    const parsed = previewInputSchema.parse(input);
    const relation = this.required(userId, collaborationId);
    if (parsed.senderBotId !== relation.targetBotId) throw new Error("流式预览只能来自协作目标 Bot");
    const preview = botCollaborationPreviewSchema.parse({ ...parsed, updatedAt: parsed.updatedAt ?? Date.now(), collaborationId });
    const valueJson = JSON.stringify(preview);
    if (requiresWorkRustWrites(this.db)) {
      const pk = `${collaborationId}\0${parsed.exchangeId}`;
      const existing = overlayReadOne<{ value_json: string }>(this.db, "bot_collaboration_previews", pk, () =>
        this.db.prepare("SELECT * FROM bot_collaboration_previews WHERE collaboration_id=? AND exchange_id=?")
          .get(collaborationId, parsed.exchangeId) as { value_json: string } | undefined);
      if (existing?.value_json !== valueJson) {
        overlaySet(this.db, "bot_collaboration_previews", pk, { collaboration_id: collaborationId, exchange_id: parsed.exchangeId, value_json: valueJson });
        overlayMutate(this.db, "bot_collaborations", collaborationId, () => this.getCollabRow(collaborationId),
          cur => cur ? { ...cur, updated_at: Math.max(Number(cur.updated_at ?? 0), preview.updatedAt) } : cur);
      }
      enqueueWorkOp(this.db, { op: "botCollabPreviewUpsert", collaborationId, exchangeId: parsed.exchangeId, valueJson, updatedAt: preview.updatedAt });
      return;
    }
    const changed = this.db.prepare(`INSERT INTO bot_collaboration_previews(collaboration_id,exchange_id,value_json) VALUES (?,?,?)
      ON CONFLICT(collaboration_id,exchange_id) DO UPDATE SET value_json=excluded.value_json WHERE value_json<>excluded.value_json`)
      .run(collaborationId, parsed.exchangeId, valueJson);
    if (changed.changes) this.touch(collaborationId, preview.updatedAt);
  }

  clearPreview(userId: string, collaborationId: string, exchangeId: string): void {
    this.required(userId, collaborationId);
    if (requiresWorkRustWrites(this.db)) {
      const now = Date.now();
      const pk = `${collaborationId}\0${exchangeId}`;
      const existing = overlayReadOne(this.db, "bot_collaboration_previews", pk, () =>
        this.db.prepare("SELECT * FROM bot_collaboration_previews WHERE collaboration_id=? AND exchange_id=?")
          .get(collaborationId, exchangeId) as Record<string, unknown> | undefined);
      if (existing) {
        overlayDelete(this.db, "bot_collaboration_previews", pk);
        overlayMutate(this.db, "bot_collaborations", collaborationId, () => this.getCollabRow(collaborationId),
          cur => cur ? { ...cur, updated_at: Math.max(Number(cur.updated_at ?? 0), now) } : cur);
      }
      enqueueWorkOp(this.db, { op: "botCollabPreviewDelete", collaborationId, exchangeId, now });
      return;
    }
    const changed = this.db.prepare("DELETE FROM bot_collaboration_previews WHERE collaboration_id=? AND exchange_id=?").run(collaborationId, exchangeId);
    if (changed.changes) this.touch(collaborationId, Date.now());
  }

  list(userId: string, input: BotCollaborationsQuery): BotCollaborationsPage {
    const query = botCollaborationsQuerySchema.parse(input);
    this.requireBot(userId, query.botId);
    const scope = digest(["relations", userId, query.botId, query.conversationId ?? null, query.otherBotId ?? null, query.direction ?? "all", query.participants ?? "current"]);
    const cursor = query.cursor ? this.cursor(query.cursor, listCursorSchema, scope) : undefined;
    const params: Record<string, string | number> = { userId, botId: query.botId };
    const predicates = ["user_id=@userId", "(source_bot_id=@botId OR target_bot_id=@botId)"];
    if (query.direction === "incoming") predicates.push("target_bot_id=@botId");
    if (query.direction === "outgoing") predicates.push("source_bot_id=@botId");
    if (query.conversationId) {
      predicates.push("source_bot_id=@botId AND source_conversation_id=@conversationId"); params.conversationId = query.conversationId;
    }
    if (query.otherBotId) {
      predicates.push("(source_bot_id=@otherBotId OR target_bot_id=@otherBotId)"); params.otherBotId = query.otherBotId;
    }
    const participantsExist = `(EXISTS (SELECT 1 FROM bots s WHERE s.user_id=bot_collaborations.user_id AND s.bot_id=source_bot_id)
      AND EXISTS (SELECT 1 FROM bots t WHERE t.user_id=bot_collaborations.user_id AND t.bot_id=target_bot_id))`;
    if (query.participants !== "all") predicates.push(query.participants === "deleted" ? `NOT ${participantsExist}` : participantsExist);
    const base = predicates.join(" AND ");
    const total = z.object({ total: z.number() }).parse(this.db.prepare(`SELECT COUNT(*) total FROM bot_collaborations WHERE ${base}`).get(params)).total;
    if (cursor) {
      predicates.push("(created_at<@createdAt OR (created_at=@createdAt AND collaboration_id<@afterId))");
      params.createdAt = cursor.createdAt; params.afterId = cursor.collaborationId;
    }
    const limit = query.limit ?? 30;
    params.take = limit + 1;
    const rows = this.db.prepare(`SELECT collaboration_id FROM bot_collaborations WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC,collaboration_id DESC LIMIT @take`).all(params)
      .map(row => z.object({ collaboration_id: id }).parse(row));
    const items = rows.slice(0, limit).map(row => this.required(userId, row.collaboration_id));
    const last = items.at(-1);
    return { items, total, nextCursor: rows.length > limit && last
      ? this.encode({ scope, createdAt: last.createdAt, collaborationId: last.collaborationId }) : null };
  }

  incomingMessages(userId:string, input:BotIncomingMessagesQuery):BotIncomingMessagesPage {
    const query=botIncomingMessagesQuerySchema.parse(input); this.requireBot(userId,query.botId);
    const scope=digest(['incoming-message-sequence-v1',userId,query.botId]);
    const schema=z.object({scope:z.string(),sequence:z.number().int().positive()}).strict();
    const boundary=query.before ?? query.after; const cursor=boundary ? this.cursor(boundary,schema,scope) : undefined;
    const ascending=Boolean(query.after), op=ascending?'>':'<', direction=ascending?'ASC':'DESC';
    if(query.refreshIds?.length===0)return {items:[],nextCursor:null};
    const refreshParams:Record<string,string>={};query.refreshIds?.forEach((id,i)=>{refreshParams['refresh'+i]=id;});
    const refreshClause=query.refreshIds ? 'AND m.message_id IN ('+query.refreshIds.map((_id,i)=>'@refresh'+i).join(',')+')' : '';
    const rows=this.db.prepare(`SELECT m.message_id,m.collaboration_id,m.value_json,m.operation_key,o.sequence
      FROM bot_collaboration_messages m JOIN bot_collaboration_message_order o ON o.message_id=m.message_id JOIN bot_collaborations c ON c.collaboration_id=m.collaboration_id
      WHERE c.user_id=@user AND c.target_bot_id=@bot
      AND EXISTS (SELECT 1 FROM bots source WHERE source.bot_id=c.source_bot_id AND source.user_id=c.user_id)
      AND EXISTS (SELECT 1 FROM bots target WHERE target.bot_id=c.target_bot_id AND target.user_id=c.user_id)
      ${refreshClause}
      AND (@edge=0 OR o.sequence${op}@sequence)
      ORDER BY o.sequence ${direction} LIMIT @take`)
      .all({user:userId,bot:query.botId,edge:cursor?1:0,sequence:cursor?.sequence??0,take:query.refreshIds?101:(query.limit??30)+1,...refreshParams}) as {message_id:string;collaboration_id:string;value_json:string;operation_key:string;sequence:number}[];
    const selected=rows.slice(0,query.refreshIds?100:query.limit??30); const cache=new Map<string,BotCollaborationDto>();
    const items=selected.map(row=>{ let collaboration=cache.get(row.collaboration_id); if(!collaboration){collaboration=this.required(userId,row.collaboration_id);cache.set(row.collaboration_id,collaboration);}
      const message=botCollaborationMessageSchema.parse(JSON.parse(row.value_json));
      const foregroundMessageIds:string[]=[];
      if(message.workFeedback){
        const linked=this.db.prepare(`SELECT m.message_id,m.request_id FROM bot_messages m
          JOIN bot_work_feedback f ON f.message_id=m.message_id
          JOIN bot_conversations conversation ON conversation.conversation_id=m.conversation_id
          WHERE conversation.user_id=? AND m.bot_id=? AND m.role='assistant'
            AND json_extract(f.metadata_json,'$.workId')=? AND json_extract(f.metadata_json,'$.eventId')=?`)
          .all(userId,query.botId,message.workFeedback.workId,message.workFeedback.eventId) as {message_id:string;request_id:string}[];
        for(const projected of linked){
          const version=projected.request_id.match(/^work-feedback:[a-f0-9]{64}:([a-f0-9]{64})$/)?.[1];
          if(version && digest([message.operationId,message.kind,version])===row.operation_key)foregroundMessageIds.push(projected.message_id);
        }
      }
      const summaryRow=message.kind==='request'?undefined:this.db.prepare(`SELECT m.text,m.status FROM bot_peer_deliveries d
        JOIN bot_messages m ON m.message_id=d.accepted_message_id
        WHERE d.user_id=? AND d.journal_message_id=? AND m.bot_id=? AND m.role='assistant'
          AND json_extract(d.origin_json,'$.kind')='return'
          AND json_extract(d.origin_json,'$.collaborationId')=?
          AND json_extract(d.origin_json,'$.replyMessageId')=? ORDER BY d.rowid DESC LIMIT 1`)
        .get(userId,message.messageId,collaboration.sourceBotId,message.collaborationId,message.messageId) as {text:string;status:string}|undefined;
      const summary=summaryRow ? {...summaryRow,senderBotId:collaboration.sourceBotId,senderDisplayName:collaboration.sourceDisplayName}:undefined;
      return {message,collaboration,foregroundMessageIds,summary,cursor:this.encode({scope,sequence:row.sequence})}; });
    const nextCursor=rows.length>selected.length ? items.at(-1)?.cursor??null : null;
    return {items:ascending?items:items.reverse(),nextCursor};
  }

  history(userId: string, input: BotCollaborationHistoryQuery): BotCollaborationHistoryPage {
    const query = botCollaborationHistoryQuerySchema.parse(input);
    const collaboration = this.scoped(userId, query.botId, query.collaborationId);
    const scope = digest(["history", userId, query.botId, query.collaborationId]);
    const cursor = query.cursor ? this.cursor(query.cursor, historyCursorSchema, scope) : undefined;
    const limit = query.limit ?? 30;
    const before = cursor?.before ?? Number.MAX_SAFE_INTEGER;
    const combined = [
      ...this.listCollabMessages(query.collaborationId).map(r => ({ kind: "message" as const, value_json: String(r.value_json), ordinal: Number(r.ordinal) })),
      ...this.listCollabEvents(query.collaborationId).map(r => ({ kind: "event" as const, value_json: String(r.value_json), ordinal: Number(r.ordinal) })),
    ].filter(r => r.ordinal < before).sort((a, b) => b.ordinal - a.ordinal).slice(0, limit + 1);
    const page = combined.slice(0, limit).reverse();
    const messages: BotCollaborationMessageDto[] = [];
    const events: BotCollaborationEventDto[] = [];
    for (const row of page) {
      if (row.kind === "message") messages.push(botCollaborationMessageSchema.parse(JSON.parse(row.value_json)));
      else events.push(botCollaborationEventSchema.parse(JSON.parse(row.value_json)));
    }
    const dbPreviews = this.db.prepare("SELECT * FROM bot_collaboration_previews WHERE collaboration_id=? ORDER BY exchange_id")
      .all(query.collaborationId) as Array<Record<string, unknown>>;
    const previews = overlayFindAll(this.db, "bot_collaboration_previews", dbPreviews, r => `${r.collaboration_id}\0${r.exchange_id}`,
      r => r.collaboration_id === query.collaborationId, (a, b) => String(a.exchange_id).localeCompare(String(b.exchange_id)))
      .map(row => botCollaborationPreviewSchema.parse(JSON.parse(String(row.value_json))));
    return { collaboration, messages, events, previews, totalMessages: collaboration.messageCount,
      nextCursor: combined.length > limit && page[0] ? this.encode({ scope, before: page[0].ordinal }) : null };
  }

  private required(userId: string, collaborationId: string): BotCollaborationDto {
    const relation = this.get(userId, collaborationId);
    if (!relation) throw new Error("找不到当前用户的协作");
    return relation;
  }

  private workProjection(userId: string, collaborationId: string, workId: string): BotCollaborationDto["work"] {
    const rawWork = overlayReadOne(this.db, "works", workId, () =>
      this.db.prepare("SELECT * FROM works WHERE work_id=?").get(workId) as Record<string, unknown> | undefined);
    const row = rawWork && rawWork.user_id === userId ? z.object({ work_id: id, title: z.string(),
      lifecycle: z.enum(["active", "paused", "closing", "closed"]),
      closure_conclusion: z.enum(["succeeded", "cancelled", "ended_unsuccessfully"]).nullable(),
      progress_summary: z.string().nullable(), closed_at: timestamp.nullable() }).parse(rawWork) : undefined;
    if (!row) return;
    const hasBindings = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_execution_bindings'").get());
    let binding: { binding_id: string; status: "pending" | "submitted" | "running" | "completed" | "failed" | "stopped" | "unknown" | "invalidated"; settled_at: number | null } | undefined;
    if (hasBindings) {
      const fullWork = rawWork as Record<string, unknown>;
      const dbBindings = this.db.prepare("SELECT * FROM work_execution_bindings WHERE work_id=? ORDER BY admitted_at DESC, binding_id DESC")
        .all(workId) as Array<Record<string, unknown>>;
      const matching = overlayFindAll(this.db, "work_execution_bindings", dbBindings, r => String(r.binding_id),
        r => r.work_id === workId && r.intent_revision === fullWork.intent_revision && r.input_snapshot_id === fullWork.input_snapshot_id
          && r.owner_epoch === fullWork.owner_epoch && (r.invalidated_at ?? null) === null,
        (a, b) => Number(b.admitted_at ?? 0) - Number(a.admitted_at ?? 0) || String(b.binding_id).localeCompare(String(a.binding_id)))[0];
      binding = matching ? z.object({ binding_id: id, status: z.enum(["pending", "submitted", "running", "completed", "failed", "stopped", "unknown", "invalidated"]),
        settled_at: timestamp.nullable() }).parse(matching) : undefined;
    }
    const events = this.listCollabEvents(collaborationId)
      .map(e => JSON.parse(String(e.value_json)) as { workId?: string; exchangeId?: string; kind?: string; createdAt?: number })
      .filter(e => e.workId === workId && (!binding || e.exchangeId === binding.binding_id));
    const startedTimes = events.filter(e => e.kind === "started" && typeof e.createdAt === "number").map(e => e.createdAt as number);
    const endedTimes = events.filter(e => e.kind === "ended" && typeof e.createdAt === "number").map(e => e.createdAt as number);
    const times = hasBindings && !binding
      ? { startedAt: null, endedAt: null }
      : { startedAt: startedTimes.length ? Math.min(...startedTimes) : null, endedAt: endedTimes.length ? Math.max(...endedTimes) : null };
    const terminal = binding ? ["completed", "failed", "stopped", "invalidated"].includes(binding.status) : row.lifecycle === "closed";
    return { workId: row.work_id, title: row.title, lifecycle: row.lifecycle,
      ...(binding ? { executionStatus: binding.status } : {}),
      ...(row.closure_conclusion ? { closureConclusion: row.closure_conclusion } : {}),
      ...(row.progress_summary ? { progressSummary: row.progress_summary } : {}),
      startedAt: times.startedAt, endedAt: terminal ? times.endedAt ?? binding?.settled_at ?? null : null, closedAt: row.closed_at };
  }

  private requireBot(userId: string, botId: string): void {
    const bot = overlayReadOne(this.db, "bots", botId, () =>
      this.db.prepare("SELECT bot_id, user_id FROM bots WHERE user_id=? AND bot_id=?").get(userId, botId) as Record<string, unknown> | undefined);
    if (!bot || bot.user_id !== userId)
      throw new Error("Bot 不属于当前用户");
  }

  private requireReceipt(userId: string, botId: string, source: BotCollaborationRequestLink): void {
    const r = overlayReadOne(this.db, "bot_send_receipts", `${userId}\0${botId}\0${source.requestId}`, () =>
      this.db.prepare("SELECT * FROM bot_send_receipts WHERE user_id=? AND bot_id=? AND request_id=?").get(userId, botId, source.requestId) as Record<string, unknown> | undefined);
    const c = r ? overlayReadOne(this.db, "bot_conversations", source.conversationId, () =>
      this.db.prepare("SELECT * FROM bot_conversations WHERE conversation_id=?").get(source.conversationId) as Record<string, unknown> | undefined) : undefined;
    const u = r ? overlayReadOne(this.db, "bot_messages", source.userMessageId, () =>
      this.db.prepare("SELECT * FROM bot_messages WHERE message_id=?").get(source.userMessageId) as Record<string, unknown> | undefined) : undefined;
    const a = r ? overlayReadOne(this.db, "bot_messages", source.assistantMessageId, () =>
      this.db.prepare("SELECT * FROM bot_messages WHERE message_id=?").get(source.assistantMessageId) as Record<string, unknown> | undefined) : undefined;
    if (!r || r.conversation_id !== source.conversationId || r.user_message_id !== source.userMessageId || r.assistant_message_id !== source.assistantMessageId
      || !c || c.user_id !== userId || c.bot_id !== botId || (c.team_id ?? null) !== null
      || !u || u.role !== "user" || u.conversation_id !== source.conversationId || u.bot_id !== botId || u.request_id !== source.requestId
      || !a || a.role !== "assistant" || a.conversation_id !== source.conversationId || a.bot_id !== botId || a.request_id !== source.requestId)
      throw new Error("协作缺少可核对的当前用户私人会话原始回执");
  }

  private nextOrdinal(collaborationId: string): number {
    if (requiresWorkRustWrites(this.db)) {
      const updated = overlayMutate(this.db, "bot_collaborations", collaborationId, () => this.getCollabRow(collaborationId),
        cur => cur ? { ...cur, next_ordinal: Number(cur.next_ordinal ?? 0) + 1 } : cur);
      return z.number().int().positive().parse(updated?.next_ordinal);
    }
    this.db.prepare("UPDATE bot_collaborations SET next_ordinal=next_ordinal+1 WHERE collaboration_id=?").run(collaborationId);
    return z.object({ next_ordinal: z.number().int().positive() }).parse(this.db.prepare("SELECT next_ordinal FROM bot_collaborations WHERE collaboration_id=?").get(collaborationId)).next_ordinal;
  }

  private touch(collaborationId: string, now: number): void {
    this.db.prepare("UPDATE bot_collaborations SET updated_at=MAX(updated_at,?) WHERE collaboration_id=?").run(now, collaborationId);
  }

  private encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
  private cursor<T extends z.ZodType<{ scope: string }>>(encoded: string, schema: T, scope: string): z.infer<T> {
    let parsed: z.infer<T>;
    try { parsed = schema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); }
    catch { throw new Error("协作查询游标无效，请重新查询第一页"); }
    if (parsed.scope !== scope) throw new Error("协作查询游标与当前用户、Bot 或筛选不匹配");
    return parsed;
  }
}
