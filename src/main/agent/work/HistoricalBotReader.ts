import type { AppDatabase } from "../../db/AppDatabase";
import type { WorkService } from "./WorkService";
import type { BotRegistry } from "./BotRegistry";
import type { BotReportImageService } from "./BotReportImageService";
import type { MessageHtmlRequest } from "../../../shared/saved-artifact";
import { LOCAL_USER_ID } from "../../../shared/bot-work";
import { botHistorySchema, type BotHistoryRequest } from "../../../shared/bot-conversation";
import { BotConversationRepository } from "./BotConversationRepository";
import { botInboxId } from "./WorkDeliveryTargets";

/** Historical reads have no runner, dispatch, recovery or new-message side effects. */
export class HistoricalBotReader {
  constructor(private readonly db: AppDatabase, private readonly bots: BotRegistry,
    private readonly works: WorkService, private readonly images?: BotReportImageService) {}

  messageForHtmlExport(request: MessageHtmlRequest) {
    const bot = this.bots.getBot(request.botId);
    if (!bot || bot.userId !== LOCAL_USER_ID) throw new Error("Bot 不属于当前用户");
    const messages = new BotConversationRepository(this.db.connection);
    const conversation = messages.conversation(LOCAL_USER_ID, request.botId, request.conversationId);
    const sourceKind = this.db.connection.prepare('SELECT source_kind FROM bot_conversations WHERE conversation_id=? AND user_id=?').pluck().get(request.conversationId, LOCAL_USER_ID);
    if (!conversation || conversation.bot_id !== request.botId || sourceKind !== "user") throw new Error("消息不属于可导出的用户会话");
    if (conversation.team_id && !this.works.teams.foregroundTemplates(LOCAL_USER_ID, request.botId).some(team => team.templateId === conversation.team_id)) throw new Error("团队不存在或负责人已变化");
    const message = messages.message(request.messageId);
    if (!message || message.conversationId !== conversation.conversation_id || message.botId !== request.botId) throw new Error("消息不属于当前会话");
    return message;
  }

  async history(request: unknown) {
    const input = botHistorySchema.parse(request);
    const history = await this.readPage(input);
    return this.images ? this.images.hydrateHistory(history) : history;
  }

  private assertHistoryAccess(input: BotHistoryRequest): void {
    const bot = this.bots.getBot(input.botId);
    if (!bot || bot.userId !== LOCAL_USER_ID) throw new Error("Bot 不属于当前用户");
    if (input.teamId && !this.works.teams.foregroundTemplates(LOCAL_USER_ID, input.botId).some(team => team.templateId === input.teamId)) throw new Error("团队不存在或负责人已变化");
    if (input.teamId && input.inbox) throw new Error("团队历史不能读取个人收件箱");
  }

  private async readPage(input: BotHistoryRequest) {
    const db = this.db.connection;
    const native = this.db.runtimeAuditReader;
    this.assertHistoryAccess(input);
    const conversations = new BotConversationRepository(db);
    const host = () => conversations.history(LOCAL_USER_ID, input, { reconcile: false });
    if (!native || db.inTransaction) return host();

    const totalChanges = db.prepare("SELECT total_changes()").pluck();
    const before = totalChanges.get();
    const version = db.pragma("data_version", { simple: true });
    const { inbox, conversationId, ...page } = input;
    const snapshot = await native.readBotHistoryPage({
      userId: LOCAL_USER_ID, ...page, conversationId: inbox ? botInboxId(LOCAL_USER_ID, input.botId) : conversationId,
    });
    return db.transaction(() => {
      // The Rust page and the host's collaboration/clarification projections
      // must describe the same database state. The authorization read fixes
      // the host snapshot and rejects any ownership changes while Rust ran.
      this.assertHistoryAccess(input);
      if (!snapshot || snapshot.kind === "needsHost" || before !== totalChanges.get()
        || version !== db.pragma("data_version", { simple: true })) {
        return host();
      }
      return conversations.projectHistoryPage(input, snapshot);
    })();
  }
}
