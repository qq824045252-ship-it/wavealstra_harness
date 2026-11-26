import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { enqueueWorkOp, overlayFindAll, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites } from "./WorkDomainRuntime";

export const botInboxId = (userId: string, botId: string): string =>
  `bot-inbox-${createHash("sha256").update(JSON.stringify([userId, botId])).digest("hex")}`;

function botExists(db: Database.Database, userId: string, botId: string): boolean {
  const row = overlayReadOne(db, "bots", botId, () =>
    db.prepare("SELECT bot_id,user_id FROM bots WHERE bot_id=?").get(botId) as Record<string, unknown> | undefined);
  return Boolean(row && row.user_id === userId);
}

/** A separate, read-only message destination. Never select whichever chat is live. */
export function ensureBotInbox(db: Database.Database, userId: string, botId: string): string | undefined {
  if (!botExists(db, userId, botId)) return;
  const id = botInboxId(userId, botId), now = Date.now();
  if (requiresWorkRustWrites(db)) {
    const existing = overlayReadOne(db, "bot_conversations", id, () =>
      db.prepare("SELECT * FROM bot_conversations WHERE conversation_id=?").get(id) as Record<string, unknown> | undefined);
    if (!existing) {
      overlaySet(db, "bot_conversations", id, {
        conversation_id: id, bot_id: botId, user_id: userId, revision: 0,
        current_request_id: null, archived_at: now, created_at: now, updated_at: now,
        team_id: null, ingress_kind: "desktop", source_kind: "user",
      });
      enqueueWorkOp(db, {
        op: "botConvInsert", conversationId: id, botId, userId, teamId: null,
        ingressKind: "desktop", sourceKind: "user", archivedAt: now,
        createdAt: now, updatedAt: now, orIgnore: true,
      });
    }
    return id;
  }
  db.prepare(`INSERT OR IGNORE INTO bot_conversations(conversation_id,bot_id,user_id,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`).run(id, botId, userId, now, now, now);
  return id;
}

/** Personal work binds its owner identity at creation/delivery, not the UI selection. */
export function ensurePersonalConversation(db: Database.Database, userId: string, botId: string): string | undefined {
  if (!botExists(db, userId, botId)) return;
  const dbRows = db.prepare("SELECT * FROM bot_conversations WHERE user_id=? AND bot_id=? AND team_id IS NULL AND ingress_kind='desktop' AND source_kind='user' AND archived_at IS NULL")
    .all(userId, botId) as Array<Record<string, unknown>>;
  const prior = overlayFindAll(db, "bot_conversations", dbRows, r => String(r.conversation_id), r =>
    r.user_id === userId && r.bot_id === botId && (r.team_id ?? null) === null
    && (r.ingress_kind ?? "desktop") === "desktop" && (r.source_kind ?? "user") === "user" && (r.archived_at ?? null) === null)[0];
  if (prior) return String(prior.conversation_id);
  const id = `bot-conversation-${randomUUID()}`, now = Date.now();
  if (requiresWorkRustWrites(db)) {
    overlaySet(db, "bot_conversations", id, {
      conversation_id: id, bot_id: botId, user_id: userId, revision: 0,
      current_request_id: null, archived_at: null, created_at: now, updated_at: now,
      team_id: null, ingress_kind: "desktop", source_kind: "user",
    });
    enqueueWorkOp(db, {
      op: "botConvInsert", conversationId: id, botId, userId, teamId: null,
      ingressKind: "desktop", sourceKind: "user", archivedAt: null,
      createdAt: now, updatedAt: now, orIgnore: false,
    });
    return id;
  }
  db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(id, botId, userId, now, now);
  return id;
}

/** Stable team scope survives changes to the executing leader. */
export function ensureTeamConversation(db: Database.Database, userId: string, botId: string, teamId: string): string {
  const dbRows = db.prepare("SELECT * FROM bot_conversations WHERE user_id=? AND team_id=? AND archived_at IS NULL")
    .all(userId, teamId) as Array<Record<string, unknown>>;
  const prior = overlayFindAll(db, "bot_conversations", dbRows, r => String(r.conversation_id), r =>
    r.user_id === userId && r.team_id === teamId && (r.archived_at ?? null) === null)[0];
  if (prior) return String(prior.conversation_id);
  const id = `bot-conversation-${randomUUID()}`, now = Date.now();
  if (requiresWorkRustWrites(db)) {
    overlaySet(db, "bot_conversations", id, {
      conversation_id: id, bot_id: botId, user_id: userId, revision: 0,
      current_request_id: null, archived_at: null, created_at: now, updated_at: now,
      team_id: teamId, ingress_kind: "desktop", source_kind: "user",
    });
    enqueueWorkOp(db, {
      op: "botConvInsert", conversationId: id, botId, userId, teamId,
      ingressKind: "desktop", sourceKind: "user", archivedAt: null,
      createdAt: now, updatedAt: now, orIgnore: false,
    });
    return id;
  }
  db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id,team_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, botId, userId, teamId, now, now);
  return id;
}

/** Called inside Work creation: UI/native/Gateway Work without a Bot chat gets
 * an explicit owner conversation. This does not replace Gateway delivery targets. */
export function recordWorkDelivery(db: Database.Database, work: { workId: string; userId: string; ownerBotId: string },
  input: { conversationId?: string; sourceMessageId?: string }): void {
  const source = input.sourceMessageId ? db.prepare(`SELECT c.conversation_id FROM bot_messages m
    JOIN bot_conversations c ON c.conversation_id=m.conversation_id
    JOIN bot_send_receipts r ON r.user_message_id=m.message_id AND r.conversation_id=c.conversation_id AND r.user_id=c.user_id AND r.bot_id=m.bot_id
    WHERE m.message_id=? AND m.role='user' AND c.user_id=?`)
    .get(input.sourceMessageId, work.userId) as { conversation_id: string } | undefined : undefined;
  const sourceFromOverlay = !source && input.sourceMessageId
    ? (() => {
      const msg = overlayReadOne<{ conversation_id: string; role: string }>(db, "bot_messages", input.sourceMessageId!, () => undefined);
      if (!msg || msg.role !== "user") return undefined;
      const conv = overlayReadOne<{ conversation_id: string; user_id: string }>(db, "bot_conversations", msg.conversation_id, () => undefined);
      return conv?.user_id === work.userId ? { conversation_id: conv.conversation_id } : undefined;
    })()
    : undefined;
  const explicitRow = input.conversationId
    ? overlayReadOne<Record<string, unknown>>(db, "bot_conversations", input.conversationId, () =>
      db.prepare("SELECT * FROM bot_conversations WHERE conversation_id=?").get(input.conversationId) as Record<string, unknown> | undefined)
    : undefined;
  const explicit = explicitRow && explicitRow.user_id === work.userId && (explicitRow.bot_id === work.ownerBotId || explicitRow.team_id != null)
    ? { conversation_id: String(explicitRow.conversation_id) } : undefined;
  const target = (source ?? sourceFromOverlay)?.conversation_id ?? explicit?.conversation_id ?? ensurePersonalConversation(db, work.userId, work.ownerBotId);
  if (target) {
    const now = Date.now();
    if (requiresWorkRustWrites(db)) {
      overlayMutate(db, "work_conversations", `${work.workId}\0${target}`, () =>
        db.prepare("SELECT * FROM work_conversations WHERE work_id=? AND conversation_id=?").get(work.workId, target) as Record<string, unknown> | undefined,
      cur => cur ? { ...cur, channel_type: "bot-delivery" } : { work_id: work.workId, conversation_id: target, channel_type: "bot-delivery", last_referenced_at: now });
      enqueueWorkOp(db, { op: "workConversationLink", workId: work.workId, conversationId: target, channelType: "bot-delivery", lastReferencedAt: now });
      return;
    }
    db.prepare(`INSERT OR IGNORE INTO work_conversations(work_id,conversation_id,channel_type,last_referenced_at)
      VALUES (?,?,'bot-delivery',?) ON CONFLICT(work_id,conversation_id) DO UPDATE SET channel_type='bot-delivery'`).run(work.workId, target, now);
  }
}
