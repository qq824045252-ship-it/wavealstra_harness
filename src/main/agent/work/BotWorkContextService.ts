import type Database from "better-sqlite3";
import type { BotChannelBindingDto, WorkDto } from "../../../shared/bot-work";
import type { BotRegistry } from "./BotRegistry";
import { enqueueWorkOp, overlayFindAll, overlaySet, requiresWorkRustWrites } from "./WorkDomainRuntime";
import type { WorkService } from "./WorkService";

/** User/channel identity is supplied by the authenticated host, never model arguments. */
export class BotWorkContextService {
  constructor(private readonly db: Database.Database, private readonly bots: BotRegistry, private readonly work: WorkService) {}

  bind(userId: string, channel: BotChannelBindingDto["channelType"], identifier: string, botId: string): void {
    const bot = this.bots.getBot(botId);
    if (!bot || bot.userId !== userId || bot.status !== "active") throw new Error("Bot 不可用或不属于当前用户");
    this.bots.bindChannel({ channelType: channel, channelIdentifier: this.key(userId, identifier), botId, boundAt: Date.now() });
  }

  resolveBot(userId: string, channel: BotChannelBindingDto["channelType"], identifier: string, fallbackBotId: string) {
    const channelIdentifier = this.key(userId, identifier);
    const bindings = overlayFindAll(
      this.db,
      "bot_channel_bindings",
      this.db.prepare("SELECT channel_type,channel_identifier,bot_id FROM bot_channel_bindings WHERE channel_type=? AND channel_identifier=?")
        .all(channel, channelIdentifier) as Array<{ channel_type: string; channel_identifier: string; bot_id: string }>,
      r => `${r.channel_type}\0${r.channel_identifier}`,
      r => r.channel_type === channel && r.channel_identifier === channelIdentifier,
    );
    const binding = bindings[0];
    const bot = binding ? this.bots.getBot(binding.bot_id) : this.bots.getBot(fallbackBotId);
    if (!bot || bot.userId !== userId || bot.status !== "active") throw new Error("当前渠道的 Bot 不可用");
    return bot;
  }

  /** Explicit Work/message references disambiguate many-to-many conversation links. */
  resolveWork(userId: string, conversationId: string, reference: { workId?: string; messageId?: string } = {}): WorkDto | undefined {
    let candidates = this.work.listWorksByConversation(conversationId).filter(work => work.userId === userId);
    if (reference.workId) candidates = candidates.filter(work => work.workId === reference.workId);
    if (reference.messageId) {
      const dbRefs = this.db.prepare("SELECT work_id,conversation_id,message_id FROM work_message_refs WHERE conversation_id=? AND message_id=?")
        .all(conversationId, reference.messageId) as Array<{ work_id: string; conversation_id: string; message_id: string }>;
      const refs = overlayFindAll(
        this.db,
        "work_message_refs",
        dbRefs,
        r => `${r.work_id}\0${r.conversation_id}\0${r.message_id}`,
        r => r.conversation_id === conversationId && r.message_id === reference.messageId,
      );
      candidates = candidates.filter(work => refs.some(ref => ref.work_id === work.workId));
    }
    if (candidates.length > 1) throw new Error("当前对话涉及多个 Work，请明确事项卡片或消息引用");
    if ((reference.workId || reference.messageId) && !candidates.length) throw new Error("引用不属于当前用户与对话");
    return candidates[0];
  }

  linkMessage(userId: string, workId: string, conversationId: string, messageId: string): void {
    if (!messageId.trim()) throw new Error("消息标识不能为空");
    this.resolveWork(userId, conversationId, { workId });
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_message_refs", `${workId}\0${conversationId}\0${messageId}`, { work_id: workId, conversation_id: conversationId, message_id: messageId });
      enqueueWorkOp(this.db, { op: "workMessageRefInsert", workId, conversationId, messageId });
      return;
    }
    this.db.prepare("INSERT OR IGNORE INTO work_message_refs(work_id,conversation_id,message_id) VALUES (?,?,?)")
      .run(workId, conversationId, messageId);
  }

  private key(userId: string, identifier: string): string { return JSON.stringify([userId, identifier]); }
}
