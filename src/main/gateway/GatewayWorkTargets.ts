import { ensureBotTurnOriginSchema } from "../agent/work/BotTurnOriginSchema";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { RuntimeAuditReader } from "../platform/runtime-audit";
import { gatewayWorkTargetSchema, type GatewayWorkTarget } from "./work-outbound";

const rowSchema = z.object({ target_key: z.string(), user_id: z.string(), conversation_id: z.string(),
  source_message_id: z.string(), channel_id: z.string(), channel_type: z.string(), connection_key: z.string(),
  chat_id: z.string(), sender_id: z.string(), target_json: z.string(), created_at: z.number() });
export interface GatewayWorkRoute {
  targetKey: string; userId: string; conversationId: string; sourceMessageId: string;
  target: GatewayWorkTarget; createdAt: number;
}

type GatewayTargetNative = Pick<RuntimeAuditReader, "batch4aWrite" | "supervised">;

/** Authenticated input provenance only; the Work tables remain the sole send ledger. */
export class GatewayWorkTargets {
  private writeTail = Promise.resolve();
  private readonly pendingByRouteKey = new Map<string, GatewayWorkRoute>();

  constructor(private readonly db: Database.Database, private readonly native?: GatewayTargetNative) {
    if (!db.readonly) ensureBotTurnOriginSchema(db);
  }

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.native?.supervised);
  }

  flush(): Promise<void> {
    return this.writeTail;
  }

  record(input: Omit<GatewayWorkRoute, "targetKey">): GatewayWorkRoute {
    if (!input.userId.trim() || !input.conversationId.trim() || !input.sourceMessageId.trim()) {
      throw new Error("Gateway 通知目标缺少可信输入身份");
    }
    const target = gatewayWorkTargetSchema.parse(input.target);
    const targetKey = gatewayWorkRouteKey({ ...input, target });
    if (this.requiresRustWrites) {
      const batch4a = this.native?.batch4aWrite;
      if (!batch4a) throw new Error("只读模式下缺少 Gateway 目标 Rust 写入通道");
      const compositeKey = JSON.stringify([input.userId, input.conversationId, input.sourceMessageId]);
      const cached = this.pendingByRouteKey.get(compositeKey);
      if (cached) {
        if (cached.targetKey !== targetKey) throw new Error("Gateway 原始输入的通知目标已固定，不能更换账号或接收人");
        return cached;
      }
      const existing = this.db.prepare(`SELECT * FROM gateway_work_targets WHERE user_id=? AND conversation_id=? AND source_message_id=?`)
        .get(input.userId, input.conversationId, input.sourceMessageId);
      if (existing) {
        const stored = parseGatewayWorkRoute(existing);
        if (stored.targetKey !== targetKey) throw new Error("Gateway 原始输入的通知目标已固定，不能更换账号或接收人");
        return stored;
      }
      const created: GatewayWorkRoute = { targetKey, userId: input.userId, conversationId: input.conversationId, sourceMessageId: input.sourceMessageId, target, createdAt: input.createdAt };
      this.pendingByRouteKey.set(compositeKey, created);
      const targetJson = JSON.stringify(target);
      this.writeTail = this.writeTail.then(() => batch4a.call(this.native, {
        kind: "gatewayRecordWorkTarget",
        targetKey,
        userId: input.userId,
        conversationId: input.conversationId,
        sourceMessageId: input.sourceMessageId,
        channelId: target.channelId,
        channelType: target.channelType,
        connectionKey: target.connectionKey,
        chatId: target.chatId,
        senderId: target.senderId,
        targetJson,
        createdAt: input.createdAt,
      })).then(() => undefined, error => {
        console.warn("[GatewayWorkTargets] record failed", error);
      });
      return created;
    }
    return this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO gateway_work_targets
        (target_key,user_id,conversation_id,source_message_id,channel_id,channel_type,connection_key,chat_id,sender_id,target_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(targetKey, input.userId, input.conversationId, input.sourceMessageId,
        target.channelId, target.channelType, target.connectionKey, target.chatId, target.senderId, JSON.stringify(target), input.createdAt);
      const row = this.db.prepare(`SELECT * FROM gateway_work_targets WHERE user_id=? AND conversation_id=? AND source_message_id=?`)
        .get(input.userId, input.conversationId, input.sourceMessageId);
      const stored = parseGatewayWorkRoute(row);
      if (stored.targetKey !== targetKey) throw new Error("Gateway 原始输入的通知目标已固定，不能更换账号或接收人");
      return stored;
    }).immediate();
  }

  get(targetKey: string): GatewayWorkRoute | undefined {
    for (const pending of this.pendingByRouteKey.values()) {
      if (pending.targetKey === targetKey) return pending;
    }
    const row = this.db.prepare("SELECT * FROM gateway_work_targets WHERE target_key=?").get(targetKey);
    return row ? parseGatewayWorkRoute(row) : undefined;
  }

  forWork(workId: string, userId: string): GatewayWorkRoute[] {
    return readGatewayWorkRoutes(this.db, workId, userId);
  }
}

/** Read-only original-route projection; does not initialize or mutate schema. */
export function readGatewayWorkRoutes(db: Database.Database, workId: string, userId: string): GatewayWorkRoute[] {
    // A conversation's latest sender/config is not provenance. Only the source message
    // admitted by the native host can select the immutable original route, even closed.
    return db.prepare(`SELECT DISTINCT t.* FROM gateway_work_targets t
      JOIN work_conversations c ON c.conversation_id=t.conversation_id
      JOIN works w ON w.work_id=c.work_id AND w.user_id=t.user_id
      WHERE w.work_id=? AND w.user_id=? AND t.source_message_id=w.source_message_id
      ORDER BY t.target_key`).all(workId, userId).map(row => parseGatewayWorkRoute(row));
}

function parseGatewayWorkRoute(value: unknown): GatewayWorkRoute {
    const row = rowSchema.parse(value);
    const target = gatewayWorkTargetSchema.parse(JSON.parse(row.target_json));
    const route = { targetKey: row.target_key, userId: row.user_id, conversationId: row.conversation_id,
      sourceMessageId: row.source_message_id, target, createdAt: row.created_at };
    if (target.channelId !== row.channel_id || target.channelType !== row.channel_type
      || target.connectionKey !== row.connection_key || target.chatId !== row.chat_id || target.senderId !== row.sender_id
      || gatewayWorkRouteKey(route) !== row.target_key) throw new Error("Gateway 通知目标身份与持久来源不一致");
    return route;
  }

function gatewayWorkRouteKey(input: Omit<GatewayWorkRoute, "targetKey">): string {
    return "gateway-target:" + createHash("sha256").update(JSON.stringify([
      "gateway-work-target-v1", input.userId, input.conversationId, input.sourceMessageId, input.target,
    ])).digest("hex");
  }
