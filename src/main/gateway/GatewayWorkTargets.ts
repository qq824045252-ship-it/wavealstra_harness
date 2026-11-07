import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { gatewayWorkTargetSchema, type GatewayWorkTarget } from "./work-outbound";

const rowSchema = z.object({ target_key: z.string(), user_id: z.string(), conversation_id: z.string(),
  source_message_id: z.string(), channel_id: z.string(), channel_type: z.string(), connection_key: z.string(),
  chat_id: z.string(), sender_id: z.string(), target_json: z.string(), created_at: z.number() });
export interface GatewayWorkRoute {
  targetKey: string; userId: string; conversationId: string; sourceMessageId: string;
  target: GatewayWorkTarget; createdAt: number;
}

/** Authenticated input provenance only; the Work tables remain the sole send ledger. */
export class GatewayWorkTargets {
  constructor(private readonly db: Database.Database) {}

  record(input: Omit<GatewayWorkRoute, "targetKey">): GatewayWorkRoute {
    if (!input.userId.trim() || !input.conversationId.trim() || !input.sourceMessageId.trim()) {
      throw new Error("Gateway 通知目标缺少可信输入身份");
    }
    const target = gatewayWorkTargetSchema.parse(input.target);
    const targetKey = this.key({ ...input, target });
    return this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO gateway_work_targets
        (target_key,user_id,conversation_id,source_message_id,channel_id,channel_type,connection_key,chat_id,sender_id,target_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(targetKey, input.userId, input.conversationId, input.sourceMessageId,
        target.channelId, target.channelType, target.connectionKey, target.chatId, target.senderId, JSON.stringify(target), input.createdAt);
      const row = this.db.prepare(`SELECT * FROM gateway_work_targets WHERE user_id=? AND conversation_id=? AND source_message_id=?`)
        .get(input.userId, input.conversationId, input.sourceMessageId);
      const stored = this.parse(row);
      if (stored.targetKey !== targetKey) throw new Error("Gateway 原始输入的通知目标已固定，不能更换账号或接收人");
      return stored;
    }).immediate();
  }

  get(targetKey: string): GatewayWorkRoute | undefined {
    const row = this.db.prepare("SELECT * FROM gateway_work_targets WHERE target_key=?").get(targetKey);
    return row ? this.parse(row) : undefined;
  }

  forWork(workId: string, userId: string): GatewayWorkRoute[] {
    // A conversation's latest sender/config is not provenance. Only the source message
    // admitted by the native host can select the immutable original route, even closed.
    return this.db.prepare(`SELECT DISTINCT t.* FROM gateway_work_targets t
      JOIN work_conversations c ON c.conversation_id=t.conversation_id
      JOIN works w ON w.work_id=c.work_id AND w.user_id=t.user_id AND w.source_message_id=t.source_message_id
      WHERE w.work_id=? AND w.user_id=? ORDER BY t.target_key`).all(workId, userId).map(row => this.parse(row));
  }

  private parse(value: unknown): GatewayWorkRoute {
    const row = rowSchema.parse(value);
    const target = gatewayWorkTargetSchema.parse(JSON.parse(row.target_json));
    const route = { targetKey: row.target_key, userId: row.user_id, conversationId: row.conversation_id,
      sourceMessageId: row.source_message_id, target, createdAt: row.created_at };
    if (target.channelId !== row.channel_id || target.channelType !== row.channel_type
      || target.connectionKey !== row.connection_key || target.chatId !== row.chat_id || target.senderId !== row.sender_id
      || this.key(route) !== row.target_key) throw new Error("Gateway 通知目标身份与持久来源不一致");
    return route;
  }

  private key(input: Omit<GatewayWorkRoute, "targetKey">): string {
    return "gateway-target:" + createHash("sha256").update(JSON.stringify([
      "gateway-work-target-v1", input.userId, input.conversationId, input.sourceMessageId, input.target,
    ])).digest("hex");
  }
}
