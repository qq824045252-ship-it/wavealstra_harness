import type Database from "better-sqlite3";
import type { BotChannelBindingDto, WorkDto } from "../../../shared/bot-work";
import type { BotRegistry } from "./BotRegistry";
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
    const bot = this.bots.resolveBotByChannel(channel, this.key(userId, identifier)) ?? this.bots.getBot(fallbackBotId);
    if (!bot || bot.userId !== userId || bot.status !== "active") throw new Error("当前渠道的 Bot 不可用");
    return bot;
  }

  /** Explicit Work/message references disambiguate many-to-many conversation links. */
  resolveWork(userId: string, conversationId: string, reference: { workId?: string; messageId?: string } = {}): WorkDto | undefined {
    let candidates = this.work.listWorksByConversation(conversationId).filter(work => work.userId === userId);
    if (reference.workId) candidates = candidates.filter(work => work.workId === reference.workId);
    if (reference.messageId) {
      const refs = this.db.prepare("SELECT work_id FROM work_message_refs WHERE conversation_id=? AND message_id=?")
        .all(conversationId, reference.messageId) as Array<{ work_id: string }>;
      candidates = candidates.filter(work => refs.some(ref => ref.work_id === work.workId));
    }
    if (candidates.length > 1) throw new Error("当前对话涉及多个 Work，请明确事项卡片或消息引用");
    if ((reference.workId || reference.messageId) && !candidates.length) throw new Error("引用不属于当前用户与对话");
    return candidates[0];
  }

  linkMessage(userId: string, workId: string, conversationId: string, messageId: string): void {
    if (!messageId.trim()) throw new Error("消息标识不能为空");
    this.resolveWork(userId, conversationId, { workId });
    this.db.prepare("INSERT OR IGNORE INTO work_message_refs(work_id,conversation_id,message_id) VALUES (?,?,?)")
      .run(workId, conversationId, messageId);
  }

  private key(userId: string, identifier: string): string { return JSON.stringify([userId, identifier]); }
}
