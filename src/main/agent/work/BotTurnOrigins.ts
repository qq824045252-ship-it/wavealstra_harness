import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { BotSendReceipt } from "../../../shared/bot-conversation";
import { GatewayWorkTargets } from "../../gateway/GatewayWorkTargets";
import { gatewayWorkTargetSchema } from "../../gateway/work-outbound";
import { ensureBotTurnOriginSchema } from "./BotTurnOriginSchema";
import { enqueueWorkOp, overlayReadOne, overlaySet, requiresWorkRustWrites, resolveWorkDomainWriter, workDomainInTx } from "./WorkDomainRuntime";
import type { RuntimeAuditReader } from "../../platform/runtime-audit";

const identifier = z.string().trim().min(1).max(1000);
export const gatewayBotOriginSchema = z.object({
  channelId: identifier, connectionKey: z.string().regex(/^[a-f0-9]{64}$/),
  chatId: identifier, senderId: identifier, messageId: identifier,
  audience: z.enum(["private", "shared"]), personalMemoryBindingId: z.string().uuid().optional(), workTarget: gatewayWorkTargetSchema.optional(),
}).strict();
export type GatewayBotOrigin = z.infer<typeof gatewayBotOriginSchema>;

/** Provenance only. Execution, revisions and recipient effects remain in Work. */
export class BotTurnOrigins {
  constructor(private readonly db: Database.Database) { ensureBotTurnOriginSchema(db); }

  gatewayConversation(userId: string, botId: string, input: GatewayBotOrigin): string {
    const origin = gatewayBotOriginSchema.parse(input);
    const identity = [userId, botId, origin.channelId, origin.connectionKey, origin.chatId, origin.audience];
    const conversationId = `bot-gateway-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
    const now = Date.now();
    if (requiresWorkRustWrites(this.db)) {
      const existingConv = overlayReadOne(this.db, "bot_conversations", conversationId, () =>
        this.db.prepare("SELECT * FROM bot_conversations WHERE conversation_id=?").get(conversationId) as Record<string, unknown> | undefined);
      if (!existingConv) {
        overlaySet(this.db, "bot_conversations", conversationId, {
          conversation_id: conversationId, bot_id: botId, user_id: userId, revision: 0,
          current_request_id: null, archived_at: null, created_at: now, updated_at: now,
          team_id: null, ingress_kind: "gateway", source_kind: "user",
        });
        enqueueWorkOp(this.db, {
          op: "botConvInsert", conversationId, botId, userId, teamId: null,
          ingressKind: "gateway", sourceKind: "user", archivedAt: null,
          createdAt: now, updatedAt: now, orIgnore: true,
        });
      }
      const existingGw = overlayReadOne(this.db, "bot_gateway_conversations", conversationId, () =>
        this.db.prepare("SELECT * FROM bot_gateway_conversations WHERE conversation_id=?").get(conversationId) as Record<string, unknown> | undefined);
      if (!existingGw) {
        overlaySet(this.db, "bot_gateway_conversations", conversationId, {
          conversation_id: conversationId, user_id: userId, bot_id: botId, channel_id: origin.channelId,
          connection_key: origin.connectionKey, chat_id: origin.chatId, audience: origin.audience,
        });
        enqueueWorkOp(this.db, {
          op: "botGatewayConvInsert", conversationId, userId, botId, channelId: origin.channelId,
          connectionKey: origin.connectionKey, chatId: origin.chatId, audience: origin.audience,
        });
      }
      return conversationId;
    }
    this.db.prepare(`INSERT OR IGNORE INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at,ingress_kind)
      VALUES(?,?,?,?,?,'gateway')`).run(conversationId, botId, userId, now, now);
    this.db.prepare(`INSERT OR IGNORE INTO bot_gateway_conversations
      (conversation_id,user_id,bot_id,channel_id,connection_key,chat_id,audience) VALUES(?,?,?,?,?,?,?)`)
      .run(conversationId, userId, botId, origin.channelId, origin.connectionKey, origin.chatId, origin.audience);
    return conversationId;
  }

  recordGateway(userId: string, receipt: BotSendReceipt, input: GatewayBotOrigin): void {
    if (!workDomainInTx(this.db)) throw new Error("渠道来源必须与消息受理同事务保存");
    const origin = gatewayBotOriginSchema.parse(input);
    const convRow = overlayReadOne(this.db, "bot_gateway_conversations", receipt.conversationId, () =>
      this.db.prepare("SELECT * FROM bot_gateway_conversations WHERE conversation_id=?").get(receipt.conversationId) as Record<string, unknown> | undefined);
    const conversation = z.object({ user_id: z.string(), bot_id: z.string(), channel_id: z.string(),
      connection_key: z.string(), chat_id: z.string(), audience: z.string() }).optional().parse(convRow);
    if (!conversation || conversation.user_id !== userId || conversation.bot_id !== receipt.botId
      || conversation.channel_id !== origin.channelId || conversation.connection_key !== origin.connectionKey
      || conversation.chat_id !== origin.chatId || conversation.audience !== origin.audience)
      throw new Error("渠道来源与真实 Bot 对话身份不一致");
    const target = origin.workTarget;
    if (target && (target.channelId !== origin.channelId || target.connectionKey !== origin.connectionKey
      || target.chatId !== origin.chatId || target.senderId !== origin.senderId))
      throw new Error("渠道成果目标与已认证发送者不一致");
    const json = JSON.stringify(origin);
    const prevRow = overlayReadOne(this.db, "bot_turn_origins", receipt.userMessageId, () =>
      this.db.prepare("SELECT origin_json FROM bot_turn_origins WHERE user_message_id=?").get(receipt.userMessageId) as Record<string, unknown> | undefined);
    const previous = z.object({ origin_json: z.string() }).optional().parse(prevRow);
    if (previous && previous.origin_json !== json) throw new Error("idempotency_conflict: 原始渠道来源不能改变");
    if (requiresWorkRustWrites(this.db)) {
      if (!prevRow) {
        overlaySet(this.db, "bot_turn_origins", receipt.userMessageId, {
          user_message_id: receipt.userMessageId, user_id: userId, bot_id: receipt.botId,
          conversation_id: receipt.conversationId, origin_json: json,
        });
        enqueueWorkOp(this.db, {
          op: "botTurnOriginInsert", userMessageId: receipt.userMessageId, userId,
          botId: receipt.botId, conversationId: receipt.conversationId, originJson: json,
        });
      }
      if (target) {
        const native = resolveWorkDomainWriter(this.db) as unknown as RuntimeAuditReader | undefined;
        new GatewayWorkTargets(this.db, native).record({ userId, conversationId: receipt.conversationId,
          sourceMessageId: receipt.userMessageId, target, createdAt: Date.now() });
      }
      return;
    }
    this.db.prepare(`INSERT OR IGNORE INTO bot_turn_origins(user_message_id,user_id,bot_id,conversation_id,origin_json)
      VALUES(?,?,?,?,?)`).run(receipt.userMessageId, userId, receipt.botId, receipt.conversationId, json);
    if (target) new GatewayWorkTargets(this.db).record({ userId, conversationId: receipt.conversationId,
      sourceMessageId: receipt.userMessageId, target, createdAt: Date.now() });
  }

  isShared(conversationId: string): boolean {
    const row = overlayReadOne(this.db, "bot_gateway_conversations", conversationId, () =>
      this.db.prepare("SELECT audience FROM bot_gateway_conversations WHERE conversation_id=?").get(conversationId) as Record<string, unknown> | undefined);
    return row?.audience === "shared";
  }

  mayLinkControl(originalConversationId: string, currentConversationId: string): boolean {
    return originalConversationId === currentConversationId
      || !this.isShared(originalConversationId) && !this.isShared(currentConversationId);
  }

  /** Instructions derived only from the admitted message, never from user text. */
  foregroundContext(userMessageId: string): string {
    const row = z.object({ origin_json: z.string() }).optional().parse(
      overlayReadOne(this.db, "bot_turn_origins", userMessageId, () =>
        this.db.prepare("SELECT origin_json FROM bot_turn_origins WHERE user_message_id=?").get(userMessageId) as Record<string, unknown> | undefined));
    if (!row) return "当前输入来自桌面会话，已由宿主受理。当前入口不代表任何外部服务已登录或可用。";
    const origin = gatewayBotOriginSchema.parse(JSON.parse(row.origin_json));
    const kind = origin.channelId.split("-")[0];
    const names: Record<string, string> = { qq: "QQ", dingtalk: "钉钉", discord: "Discord", telegram: "Telegram",
      slack: "Slack", feishu: "飞书", wecom: "企业微信", wechat: "微信" };
    const name = names[kind] ?? "外部渠道";
    return `当前输入来自 ${name} 的${origin.audience === "private" ? "已配对私人" : "共享群组"}会话，宿主已将本条渠道消息受理到当前 Bot。可以据此确认本条消息已收到。当前回复由宿主返回原始渠道会话；尚无发送回执时不能声称对方已经收到回复。此事实只证明当前入口和消息受理，不证明 Gmail、Google 日历或其他服务已连接。用户询问当前渠道是否连通时依据本条入口说明回答，不应检查无关的服务。`;
  }

}
