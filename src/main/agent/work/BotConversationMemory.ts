import type { AppDatabase } from "../../db/AppDatabase";
import type { MemoryService } from "../../memory/MemoryService";
import type { MemoryPipelineManager } from "../../memory/MemoryPipelineManager";
import { botMemorySource, botMemoryTextEligible } from "../../memory/BotMemorySource";
import { BotConversationRepository } from "./BotConversationRepository";

/** Foreground adapter over the existing L0/L1 store, deletion controls and single writer. */
export class BotConversationMemory {
  private readonly messages: BotConversationRepository;
  constructor(private readonly options: {
    db: AppDatabase; userId: string; memory: MemoryService; pipeline: MemoryPipelineManager;
    enabled: () => boolean;
    extract: (conversationId: string) => Promise<unknown>;
    changed: () => void;
  }) { this.messages = new BotConversationRepository(options.db.connection); }

  enabled(): boolean { return this.options.enabled(); }

  search(botId: string, query: string) {
    if (!this.allowedBot(botId)) return [];
    return this.options.memory.search({ botId, query, scopeTypes: ["bot"], includeInherited: false, statuses: ["active"], limit: 20 });
  }

  context(botId: string, conversationId: string): string {
    if (!this.allowedBot(botId)) return "";
    const conversation = this.messages.conversation(this.options.userId, botId, conversationId);
    if (!conversation) return "";
    // Stable preferences should also influence unrelated requests. Bounded active L1,
    // read afresh at every provider request: no stale in-memory copy after deletion.
    return this.options.memory.resolveContext({ botId, scopeTypes: ["bot"], includeInherited: false,
      statuses: ["active"], budgetChars: 6000, limit: 12 }).text;
  }

  /** Called within the assistant completion transaction; capture failure never changes the reply. */
  capture(botId: string, requestId: string): string | undefined {
    if (!this.allowedBot(botId)) return;
    const receipt = this.messages.receipt(this.options.userId, botId, requestId);
    if (!receipt || botMemorySource(this.options.db, receipt.conversation_id, this.options.userId)?.bot_id !== botId) return;
    const user = this.messages.message(receipt.user_message_id);
    const assistant = this.messages.message(receipt.assistant_message_id);
    if (!user || !assistant || user.role !== "user" || assistant.role !== "assistant"
      || user.status !== "completed" || assistant.status !== "completed"
      || [user, assistant].some(message => message.conversationId !== receipt.conversation_id || message.botId !== botId || message.requestId !== requestId)
      || !botMemoryTextEligible(user.text)) return;
    const decision = this.options.pipeline.capture({ taskId: receipt.conversation_id, sessionId: receipt.conversation_id,
      userMessageId: user.messageId, assistantMessageId: assistant.messageId, userText: "",
      // L0 is a source pointer. Do not duplicate raw conversations (including mixed
      // sensitive content) into long-term memory. Extraction reads the original transiently.
      assistantText: "", metadata: { source: "bot_conversation", botId, userId: this.options.userId } });
    return decision.shouldExtractL1 ? receipt.conversation_id : undefined;
  }

  async extract(conversationId: string): Promise<void> {
    if (!this.options.enabled()) return;
    this.options.changed();
    await this.options.extract(conversationId);
  }

  recover(): void {
    if (!this.options.enabled()) return;
    for (const id of this.options.pipeline.turns.pendingTaskIds()) {
      const source = botMemorySource(this.options.db, id, this.options.userId);
      if (source?.status === "active") void this.extract(id).catch(error => console.warn("[Bot] 记忆恢复未完成", error));
    }
  }

  private allowedBot(botId: string): boolean {
    return this.options.enabled() && Boolean(this.options.db.connection.prepare(
      "SELECT 1 FROM bots WHERE bot_id=? AND user_id=? AND status='active'",
    ).get(botId, this.options.userId));
  }
}
