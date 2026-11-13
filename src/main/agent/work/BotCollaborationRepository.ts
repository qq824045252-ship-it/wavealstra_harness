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

  ensure(input: BotCollaborationInitiation): BotCollaborationDto {
    const parsed = ensureSchema.parse(input);
    if (parsed.sourceBotId === parsed.targetBotId) throw new Error("不能向自己发起 Bot 协作");
    const { now: suppliedNow, sourceDisplayName: _sourceName, targetDisplayName: _targetName, ...identity } = parsed;
    const initiationKey = digest([parsed.userId, parsed.sourceAssistantMessageId, parsed.operationId]);
    const payloadHash = digest(identity);
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT collaboration_id,initiation_hash FROM bot_collaborations WHERE initiation_key=?")
        .get(initiationKey);
      const previous = z.object({ collaboration_id: id, initiation_hash: z.string() }).optional().parse(prior);
      if (previous) {
        if (previous.initiation_hash !== payloadHash) throw new Error("idempotency_conflict: 同一协作操作不能更换目标或来源");
        return this.required(parsed.userId, previous.collaboration_id);
      }
      this.requireReceipt(parsed.userId, parsed.sourceBotId, {
        conversationId: parsed.sourceConversationId, requestId: parsed.sourceRequestId,
        userMessageId: parsed.sourceUserMessageId, assistantMessageId: parsed.sourceAssistantMessageId,
      });
      if (!this.db.prepare("SELECT 1 FROM bots WHERE bot_id=? AND user_id=?").get(parsed.targetBotId, parsed.userId))
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
      this.db.prepare(`INSERT INTO bot_collaborations(collaboration_id,user_id,source_bot_id,source_conversation_id,target_bot_id,
        initiation_key,initiation_hash,value_json,created_at,updated_at,status,times_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(collaboration.collaborationId, parsed.userId, parsed.sourceBotId, parsed.sourceConversationId,
          parsed.targetBotId, initiationKey, payloadHash, JSON.stringify(collaboration), now, now, collaboration.status, JSON.stringify(collaboration.times));
      this.linkRequest(parsed.userId, collaboration.collaborationId, {
        conversationId: parsed.sourceConversationId, requestId: parsed.sourceRequestId,
        userMessageId: parsed.sourceUserMessageId, assistantMessageId: parsed.sourceAssistantMessageId,
      });
      return this.required(parsed.userId, collaboration.collaborationId);
    })();
  }

  get(userId: string, collaborationId: string): BotCollaborationDto | undefined {
    const row = relationRowSchema.optional().parse(this.db.prepare(`SELECT * FROM bot_collaborations
      WHERE user_id=? AND collaboration_id=?`).get(userId, collaborationId));
    if (!row) return;
    const base = botCollaborationSchema.parse(JSON.parse(row.value_json));
    const count = z.object({ total: z.number() }).parse(this.db.prepare(`SELECT COUNT(*) total FROM bot_collaboration_messages
      WHERE collaboration_id=?`).get(collaborationId)).total;
    const sourceBotExists = Boolean(this.db.prepare("SELECT 1 FROM bots WHERE user_id=? AND bot_id=?").get(userId, base.sourceBotId));
    const targetBotExists = Boolean(this.db.prepare("SELECT 1 FROM bots WHERE user_id=? AND bot_id=?").get(userId, base.targetBotId));
    const originAvailable = sourceBotExists && Boolean(this.db.prepare(`SELECT 1 FROM bot_conversations
      WHERE user_id=? AND bot_id=? AND conversation_id=?`).get(userId, base.sourceBotId, base.sourceConversationId));
    const work = row.work_id ? this.workProjection(userId, collaborationId, row.work_id) : undefined;
    const excerpts = z.object({ requestPreview: z.string().nullable(), replyPreview: z.string().nullable() }).parse(this.db.prepare(`SELECT
      (SELECT substr(json_extract(value_json,'$.text'),1,500) FROM bot_collaboration_messages
        WHERE collaboration_id=@relation AND json_extract(value_json,'$.kind')='request' ORDER BY ordinal ASC LIMIT 1) requestPreview,
      (SELECT substr(json_extract(value_json,'$.text'),1,500) FROM bot_collaboration_messages
        WHERE collaboration_id=@relation AND json_extract(value_json,'$.senderBotId')=@target
          AND json_extract(value_json,'$.kind')<>'request' ORDER BY ordinal DESC LIMIT 1) replyPreview`)
      .get({ relation: collaborationId, target: base.targetBotId }));
    return botCollaborationSchema.parse({ ...base, workId: row.work_id, updatedAt: row.updated_at,
      messageCount: count, status: row.status, times: JSON.parse(row.times_json), originAvailable, sourceBotExists, targetBotExists,
      ...(excerpts.requestPreview !== null ? { requestPreview: excerpts.requestPreview } : {}),
      ...(excerpts.replyPreview !== null ? { replyPreview: excerpts.replyPreview } : {}), ...(work ? { work } : {}) });
  }

  scoped(userId: string, botId: string, collaborationId: string, sourceConversationId?: string): BotCollaborationDto {
    const relation = this.required(userId, collaborationId);
    if (relation.sourceBotId !== botId && relation.targetBotId !== botId)
      throw new Error("协作不属于当前用户与 Bot");
    const linked = sourceConversationId !== undefined && this.db.prepare(`SELECT 1 FROM bot_collaboration_requests q
      JOIN bot_send_receipts r ON r.user_id=? AND r.bot_id=? AND r.conversation_id=q.conversation_id
        AND r.request_id=q.request_id AND r.user_message_id=q.user_message_id AND r.assistant_message_id=q.assistant_message_id
      WHERE q.collaboration_id=? AND q.conversation_id=?`).get(userId, botId, collaborationId, sourceConversationId);
    if (sourceConversationId !== undefined && (relation.sourceBotId !== botId
      || relation.sourceConversationId !== sourceConversationId && !linked))
      throw new Error("协作不属于当前来源会话");
    return relation;
  }

  byWork(userId: string, workId: string): BotCollaborationDto | undefined {
    const row = z.object({ collaboration_id: id }).optional().parse(this.db.prepare(`SELECT collaboration_id FROM bot_collaborations
      WHERE user_id=? AND work_id=?`).get(userId, workId));
    return row && this.get(userId, row.collaboration_id);
  }

  linkWork(userId: string, collaborationId: string, workId: string): BotCollaborationDto {
    return this.db.transaction(() => {
      const relation = this.required(userId, collaborationId);
      if (relation.workId && relation.workId !== workId) throw new Error("同一协作只能绑定一个 Work，请在原事项修订");
      const work = z.object({ user_id: z.string(), owner_bot_id: z.string() }).optional().parse(
        this.db.prepare("SELECT user_id,owner_bot_id FROM works WHERE work_id=?").get(workId));
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
        this.db.prepare("UPDATE bot_collaborations SET work_id=?,times_json=?,status=? WHERE user_id=? AND collaboration_id=?")
          .run(workId, JSON.stringify(times), frontend ? relation.status : "sent", userId, collaborationId);
      }
      return this.required(userId, collaborationId);
    })();
  }

  linkRequest(userId: string, collaborationId: string, input: BotCollaborationRequestLink): void {
    const parsed = sourceSchema.parse(input);
    const relation = this.required(userId, collaborationId);
    this.requireReceipt(userId, relation.sourceBotId, parsed);
    if (relation.sourceConversationId !== parsed.conversationId && (isSharedBotConversation(this.db, relation.sourceConversationId)
      || isSharedBotConversation(this.db, parsed.conversationId)))
      throw new Error("共享渠道与私人会话不能混用协作控制身份");
    const prior = sourceSchema.optional().parse(this.db.prepare(`SELECT conversation_id conversationId,request_id requestId,
      user_message_id userMessageId,assistant_message_id assistantMessageId FROM bot_collaboration_requests
      WHERE collaboration_id=? AND request_id=?`).get(collaborationId, parsed.requestId));
    if (prior && JSON.stringify(prior) !== JSON.stringify(parsed)) throw new Error("idempotency_conflict: 协作请求身份已绑定");
    this.db.prepare(`INSERT OR IGNORE INTO bot_collaboration_requests
      (collaboration_id,conversation_id,request_id,user_message_id,assistant_message_id) VALUES (?,?,?,?,?)`)
      .run(collaborationId, parsed.conversationId, parsed.requestId, parsed.userMessageId, parsed.assistantMessageId);
  }

  summariesForMessage(userId: string, messageId: string): BotCollaborationDto[] {
    return this.db.prepare(`SELECT c.collaboration_id FROM bot_collaborations c JOIN bot_collaboration_requests r
      ON r.collaboration_id=c.collaboration_id WHERE c.user_id=? AND (r.user_message_id=? OR r.assistant_message_id=?)
      ORDER BY c.created_at,c.collaboration_id`).all(userId, messageId, messageId)
      .map(row => this.required(userId, z.object({ collaboration_id: id }).parse(row).collaboration_id));
  }

  feedbackForReturn(input: { userId: string; botId: string; conversationId: string; origin: BotPeerOrigin }): WorkFeedbackDto | undefined {
    const { userId, botId, conversationId, origin } = input;
    if (origin.kind !== "return" || origin.sourceBotId !== botId || origin.sourceConversationId !== conversationId) return;
    const row = z.object({ value_json: z.string(), work_id: z.string().nullable(), target_bot_id: z.string() }).optional().parse(
      this.db.prepare(`SELECT m.value_json,c.work_id,c.target_bot_id FROM bot_collaboration_messages m
        JOIN bot_collaborations c ON c.collaboration_id=m.collaboration_id
        WHERE c.user_id=? AND c.source_bot_id=? AND c.source_conversation_id=? AND c.collaboration_id=? AND m.message_id=?`)
        .get(userId, botId, conversationId, origin.collaborationId, origin.replyMessageId));
    if (!row || row.target_bot_id !== origin.senderBotId) return;
    const message = botCollaborationMessageSchema.parse(JSON.parse(row.value_json));
    if (message.senderBotId !== origin.senderBotId || message.workFeedback?.workId !== row.work_id) return;
    return message.workFeedback;
  }

  appendMessage(userId: string, collaborationId: string, input: BotCollaborationMessageInput): BotCollaborationMessageDto {
    const parsed = messageInputSchema.parse(input);
    if (!parsed.text.trim()) throw new Error("不能将空文本计为协作消息");
    return this.db.transaction(() => {
      const relation = this.required(userId, collaborationId);
      if (parsed.senderBotId !== relation.sourceBotId && parsed.senderBotId !== relation.targetBotId)
        throw new Error("消息发送者不属于此协作");
      if (parsed.workFeedback && parsed.workFeedback.workId !== relation.workId)
        throw new Error("成果消息的 Work 不属于此协作");
      const operationKey = digest([parsed.operationId, parsed.kind, parsed.version ?? null]);
      const { createdAt: _observedAt, ...identity } = parsed;
      const hash = digest(identity);
      const existing = storedSchema.optional().parse(this.db.prepare(`SELECT value_json,payload_hash FROM bot_collaboration_messages
        WHERE collaboration_id=? AND operation_key=?`).get(collaborationId, operationKey));
      if (existing) {
        if (existing.payload_hash !== hash) throw new Error("idempotency_conflict: 协作消息标识已用于不同正文");
        return botCollaborationMessageSchema.parse(JSON.parse(existing.value_json));
      }
      const { version: _version, createdAt: suppliedCreatedAt, ...body } = parsed;
      const createdAt = suppliedCreatedAt ?? Date.now();
      const message = botCollaborationMessageSchema.parse({ ...body, collaborationId,
        messageId: `bot-exchange-message-${digest([collaborationId, operationKey])}`,
        ordinal: this.nextOrdinal(collaborationId), createdAt });
      this.db.prepare(`INSERT INTO bot_collaboration_messages(message_id,collaboration_id,operation_key,ordinal,payload_hash,value_json)
        VALUES (?,?,?,?,?,?)`).run(message.messageId, collaborationId, operationKey, message.ordinal, hash, JSON.stringify(message));
      this.touch(collaborationId, createdAt);
      return message;
    })();
  }

  event(userId: string, collaborationId: string, input: BotCollaborationEventInput): BotCollaborationEventDto {
    const parsed = eventInputSchema.parse(input);
    return this.db.transaction(() => {
      const relation = this.required(userId, collaborationId);
      if (parsed.workId && parsed.workId !== relation.workId) throw new Error("事件 Work 不属于此协作");
      const operationKey = digest([parsed.operationId, parsed.kind, parsed.version ?? null]);
      const { createdAt: _observedAt, ...identity } = parsed;
      const hash = digest(identity);
      const existing = storedSchema.optional().parse(this.db.prepare(`SELECT value_json,payload_hash FROM bot_collaboration_events
        WHERE collaboration_id=? AND operation_key=?`).get(collaborationId, operationKey));
      if (existing) {
        if (existing.payload_hash !== hash) throw new Error("idempotency_conflict: 协作事件标识已用于不同事实");
        return botCollaborationEventSchema.parse(JSON.parse(existing.value_json));
      }
      const { version: _version, createdAt: suppliedCreatedAt, ...body } = parsed;
      const createdAt = suppliedCreatedAt ?? Date.now();
      const event = botCollaborationEventSchema.parse({ ...body, collaborationId,
        eventId: `bot-exchange-event-${digest([collaborationId, operationKey])}`,
        ordinal: this.nextOrdinal(collaborationId), createdAt });
      this.db.prepare(`INSERT INTO bot_collaboration_events(event_id,collaboration_id,operation_key,ordinal,payload_hash,value_json)
        VALUES (?,?,?,?,?,?)`).run(event.eventId, collaborationId, operationKey, event.ordinal, hash, JSON.stringify(event));
      const field = timeField[event.kind];
      const times = { ...relation.times };
      if (field && (!relation.workId || event.workId === relation.workId)) {
        if (event.kind === "returned" || event.kind === "returning") times[field] = Math.max(times[field] ?? 0, createdAt);
        else if (times[field] === null) times[field] = createdAt;
      }
      this.db.prepare(`UPDATE bot_collaborations SET status=?,times_json=?,updated_at=MAX(updated_at,?) WHERE collaboration_id=?`)
        .run(event.kind, JSON.stringify(times), createdAt, collaborationId);
      return event;
    })();
  }

  setPreview(userId: string, collaborationId: string, input: Omit<BotCollaborationPreviewDto, "collaborationId" | "updatedAt"> & { updatedAt?: number }): void {
    const parsed = previewInputSchema.parse(input);
    const relation = this.required(userId, collaborationId);
    if (parsed.senderBotId !== relation.targetBotId) throw new Error("流式预览只能来自协作目标 Bot");
    const preview = botCollaborationPreviewSchema.parse({ ...parsed, updatedAt: parsed.updatedAt ?? Date.now(), collaborationId });
    const changed = this.db.prepare(`INSERT INTO bot_collaboration_previews(collaboration_id,exchange_id,value_json) VALUES (?,?,?)
      ON CONFLICT(collaboration_id,exchange_id) DO UPDATE SET value_json=excluded.value_json WHERE value_json<>excluded.value_json`)
      .run(collaborationId, parsed.exchangeId, JSON.stringify(preview));
    if (changed.changes) this.touch(collaborationId, preview.updatedAt);
  }

  clearPreview(userId: string, collaborationId: string, exchangeId: string): void {
    this.required(userId, collaborationId);
    const changed = this.db.prepare("DELETE FROM bot_collaboration_previews WHERE collaboration_id=? AND exchange_id=?").run(collaborationId, exchangeId);
    if (changed.changes) this.touch(collaborationId, Date.now());
  }

  list(userId: string, input: BotCollaborationsQuery): BotCollaborationsPage {
    const query = botCollaborationsQuerySchema.parse(input);
    this.requireBot(userId, query.botId);
    const scope = digest(["relations", userId, query.botId, query.conversationId ?? null, query.otherBotId ?? null, query.direction ?? "all"]);
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

  history(userId: string, input: BotCollaborationHistoryQuery): BotCollaborationHistoryPage {
    const query = botCollaborationHistoryQuerySchema.parse(input);
    const collaboration = this.scoped(userId, query.botId, query.collaborationId);
    const scope = digest(["history", userId, query.botId, query.collaborationId]);
    const cursor = query.cursor ? this.cursor(query.cursor, historyCursorSchema, scope) : undefined;
    const limit = query.limit ?? 30;
    const rows = this.db.prepare(`SELECT kind,value_json,ordinal FROM (
      SELECT 'message' kind,value_json,ordinal FROM bot_collaboration_messages WHERE collaboration_id=@id
      UNION ALL SELECT 'event' kind,value_json,ordinal FROM bot_collaboration_events WHERE collaboration_id=@id
    ) WHERE ordinal<@before ORDER BY ordinal DESC LIMIT @take`)
      .all({ id: query.collaborationId, before: cursor?.before ?? Number.MAX_SAFE_INTEGER, take: limit + 1 })
      .map(row => z.object({ kind: z.enum(["message", "event"]), value_json: z.string(), ordinal: z.number() }).parse(row));
    const page = rows.slice(0, limit).reverse();
    const messages: BotCollaborationMessageDto[] = [];
    const events: BotCollaborationEventDto[] = [];
    for (const row of page) {
      if (row.kind === "message") messages.push(botCollaborationMessageSchema.parse(JSON.parse(row.value_json)));
      else events.push(botCollaborationEventSchema.parse(JSON.parse(row.value_json)));
    }
    const previews = this.db.prepare("SELECT value_json FROM bot_collaboration_previews WHERE collaboration_id=? ORDER BY exchange_id")
      .all(query.collaborationId).map(row => botCollaborationPreviewSchema.parse(JSON.parse(z.object({ value_json: z.string() }).parse(row).value_json)));
    return { collaboration, messages, events, previews, totalMessages: collaboration.messageCount,
      nextCursor: rows.length > limit && page[0] ? this.encode({ scope, before: page[0].ordinal }) : null };
  }

  private required(userId: string, collaborationId: string): BotCollaborationDto {
    const relation = this.get(userId, collaborationId);
    if (!relation) throw new Error("找不到当前用户的协作");
    return relation;
  }

  private workProjection(userId: string, collaborationId: string, workId: string): BotCollaborationDto["work"] {
    const row = z.object({ work_id: id, title: z.string(), lifecycle: z.enum(["active", "paused", "closing", "closed"]),
      closure_conclusion: z.enum(["succeeded", "cancelled", "ended_unsuccessfully"]).nullable(),
      progress_summary: z.string().nullable(), closed_at: timestamp.nullable() }).optional().parse(this.db.prepare(`SELECT work_id,title,lifecycle,
      closure_conclusion,progress_summary,closed_at FROM works WHERE user_id=? AND work_id=?`).get(userId, workId));
    if (!row) return;
    const hasBindings = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_execution_bindings'").get());
    const binding = hasBindings ? z.object({ binding_id: id, status: z.enum(["pending", "submitted", "running", "completed", "failed", "stopped", "unknown", "invalidated"]),
      settled_at: timestamp.nullable() }).optional().parse(this.db.prepare(`SELECT b.binding_id,b.status,b.settled_at FROM work_execution_bindings b
      JOIN works w ON w.work_id=b.work_id WHERE b.work_id=? AND b.intent_revision=w.intent_revision
      AND b.input_snapshot_id=w.input_snapshot_id AND b.owner_epoch=w.owner_epoch AND b.invalidated_at IS NULL
      ORDER BY b.admitted_at DESC,b.binding_id DESC LIMIT 1`).get(workId)) : undefined;
    const times = hasBindings && !binding ? { startedAt: null, endedAt: null }
      : z.object({ startedAt: timestamp.nullable(), endedAt: timestamp.nullable() }).parse(this.db.prepare(`SELECT
      MIN(CASE WHEN json_extract(value_json,'$.kind')='started' THEN json_extract(value_json,'$.createdAt') END) startedAt,
      MAX(CASE WHEN json_extract(value_json,'$.kind')='ended' THEN json_extract(value_json,'$.createdAt') END) endedAt
      FROM bot_collaboration_events WHERE collaboration_id=? AND json_extract(value_json,'$.workId')=?
      AND (? IS NULL OR json_extract(value_json,'$.exchangeId')=?)`).get(collaborationId, workId, binding?.binding_id ?? null, binding?.binding_id ?? null));
    const terminal = binding ? ["completed", "failed", "stopped", "invalidated"].includes(binding.status) : row.lifecycle === "closed";
    return { workId: row.work_id, title: row.title, lifecycle: row.lifecycle,
      ...(binding ? { executionStatus: binding.status } : {}),
      ...(row.closure_conclusion ? { closureConclusion: row.closure_conclusion } : {}),
      ...(row.progress_summary ? { progressSummary: row.progress_summary } : {}),
      startedAt: times.startedAt, endedAt: terminal ? times.endedAt ?? binding?.settled_at ?? null : null, closedAt: row.closed_at };
  }

  private requireBot(userId: string, botId: string): void {
    if (!this.db.prepare("SELECT 1 FROM bots WHERE user_id=? AND bot_id=?").get(userId, botId))
      throw new Error("Bot 不属于当前用户");
  }

  private requireReceipt(userId: string, botId: string, source: BotCollaborationRequestLink): void {
    if (!this.db.prepare(`SELECT 1 FROM bot_send_receipts r
      JOIN bot_conversations c ON c.conversation_id=r.conversation_id AND c.user_id=r.user_id AND c.bot_id=r.bot_id
      JOIN bot_messages u ON u.message_id=r.user_message_id AND u.role='user' AND u.conversation_id=r.conversation_id AND u.bot_id=r.bot_id AND u.request_id=r.request_id
      JOIN bot_messages a ON a.message_id=r.assistant_message_id AND a.role='assistant' AND a.conversation_id=r.conversation_id AND a.bot_id=r.bot_id AND a.request_id=r.request_id
      WHERE r.user_id=? AND r.bot_id=? AND r.conversation_id=? AND r.request_id=? AND r.user_message_id=? AND r.assistant_message_id=? AND c.team_id IS NULL`)
      .get(userId, botId, source.conversationId, source.requestId, source.userMessageId, source.assistantMessageId))
      throw new Error("协作缺少可核对的当前用户私人会话原始回执");
  }

  private nextOrdinal(collaborationId: string): number {
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
