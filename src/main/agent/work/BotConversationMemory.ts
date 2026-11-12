import type { AppDatabase } from "../../db/AppDatabase";
import type { MemoryCreateRequest, MemoryScopeType } from "../../../shared/memory-kernel";
import type { MemoryService } from "../../memory/MemoryService";
import type { MemoryPipelineManager } from "../../memory/MemoryPipelineManager";
import { botMemorySource, botMemoryTextEligible, botMemoryWriteEvidenceAllowed, botMemoryConversationOnly } from "../../memory/BotMemorySource";
import { BotConversationRepository } from "./BotConversationRepository";
import { botHistoryContext } from "./BotHistoryContext";

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

  /** Foreground recall uses the shared hybrid path (lexical + semantic when available);
   * the kernel re-reads scopes and statuses after every async boundary. */
  async search(botId: string, query: string, conversationId?: string) {
    const context = this.scopeContext(botId, conversationId);
    if (!context) return [];
    const hits = await this.options.memory.searchHybrid({ ...context, query, statuses: ["active"], limit: 20 });
    // Memory may have been switched off while the hybrid runtime was working.
    return this.options.enabled() ? hits : [];
  }

  /** Read-only recall for an isolated peer consultation: the receiving Bot's own scope only. */
  async recall(botId: string, query: string) {
    const context = this.scopeContext(botId);
    if (!context) return [];
    const hits = await this.options.memory.searchHybrid({ ...context, query, statuses: ["active"], limit: 20 });
    return this.options.enabled() ? hits : [];
  }

  /** Peer evidence is recomputed per request. A prefetched hit is re-authorized for
   * the receiving Bot: deletion, scope detach, expiry and status all withdraw it.
   * "still active" alone never means "this Bot may still read it". */
  activeFact(botId: string, id: string) {
    if (!this.options.enabled()) return;
    const context = this.scopeContext(botId);
    if (!context) return;
    const record = this.options.memory.get(id);
    if (!record || record.status !== "active") return;
    const now = Date.now();
    if ((record.validFrom !== undefined && record.validFrom > now)
      || (record.validUntil !== undefined && record.validUntil <= now)) return;
    return this.options.memory.canAccess(id, context) ? record : undefined;
  }

  /** A user-owned scope is selected from the real conversation, never from a model-supplied entity ID. */
  private scopeContext(botId: string, conversationId?: string): { botId: string; conversationId?: string; teamId?: string; scopeTypes: MemoryScopeType[]; includeInherited: boolean } | undefined {
    if (!this.allowedBot(botId)) return;
    if (!conversationId) return { botId, scopeTypes: ["bot"] as MemoryScopeType[], includeInherited: false };
    const conversation = this.messages.conversation(this.options.userId, botId, conversationId);
    if (!conversation) return;
    return { botId, conversationId, teamId: conversation.team_id ?? undefined,
      scopeTypes: ["global", "conversation", conversation.team_id ? "team" : "bot"] as MemoryScopeType[], includeInherited: true };
  }

  remember(botId: string, conversationId: string, input: {
    scope: "current" | "conversation" | "public"; kind: "identity" | "preference" | "fact" | "decision" | "constraint";
    title: string; content: string; userEvidence: string;
  }, userText: string) {
    const context = this.scopeContext(botId, conversationId);
    if (!context) throw new Error("当前 Bot 记忆未启用或不可用，不能保存记忆；不要反复改写证据重试");
    if (!input.userEvidence.trim() || !userText.includes(input.userEvidence)) throw new Error("记忆证据必须逐字引用本次用户原话，不能使用历史消息或模型推测");
    if (!botMemoryWriteEvidenceAllowed(userText, input.userEvidence)) throw new Error("本次是遗忘请求，不能把已删除内容换成否定形式重新保存。若同时要求记住新事实，只引用明确的新记住子句");
    if (!botMemoryTextEligible(`${userText} ${input.title} ${input.content}`)) throw new Error("记忆内容含敏感秘密或用户明确要求不保存，本次未写入");
    if (input.scope === "public" && !publicScopeRequested(userText)) throw new Error("公共记忆需要用户明确要求所有 Bot 共享；否则使用 current 范围");
    const temporary = botMemoryConversationOnly(userText);
    const scopeType: MemoryScopeType = temporary || input.scope === "conversation" ? "conversation"
      : publicScopeRequested(userText) ? "global" : context.teamId ? "team" : "bot";
    const scopeId = scopeType === "global" ? undefined : scopeType === "conversation" ? conversationId : scopeType === "team" ? context.teamId : botId;
    const record = this.options.db.connection.transaction(() => {
      const prior = this.options.memory.listExactScope(scopeType, scopeId).find(item => item.status === "active"
        && item.kind === input.kind && item.title === input.title && item.content === input.content
        && (scopeType !== "global" || item.metadata.publicShared === true));
      if (prior) return prior;
      const request: MemoryCreateRequest = { kind: input.kind, title: input.title, content: input.content,
        scopeType, scopeId, sourceType: "user", sourceId: conversationId, explicit: true, confidence: 1,
        metadata: { ...(scopeType === "global" ? { publicShared: true } : {}), foregroundConversationId: conversationId },
        evidence: [{ evidenceKind: "conversation", refId: conversationId, excerpt: input.userEvidence }] };
      return this.options.memory.create(request);
    })();
    this.options.changed();
    return { memoryId: record.id, scopeType, scopeId, title: record.title, saved: true };
  }

  /** Exact records selected by the foreground model, anchored to the current user's request. */
  forget(botId: string, ids: string[], userText: string, evidence: string, conversationId?: string, source?: { createdAt: number; messageId: string }) {
    if (!this.allowedBot(botId)) throw new Error("当前 Bot 记忆未启用或不可用");
    if (!evidence.trim() || !userText.includes(evidence)
      || !/(?:忘记|删除.*记忆|forget|delete.*memor|(?:更正|修正|纠正|替换).{0,24}(?:偏好|记忆|长期|回复格式)|(?:correct|update|replace).{0,32}(?:preference|memory))/i.test(evidence)
      || /(?:不要|别|不必|不能|勿).{0,4}(?:忘记|删除|更正|修正|纠正|替换)|(?:don['’]?t|do not|never)\s+(?:forget|delete|correct|update|replace)/i.test(userText)) {
      throw new Error("仅在当前用户明确要求忘记或更正记忆偏好时移除旧记忆，不能用历史消息或模型推测替代");
    }
    const result = this.options.db.connection.transaction(() => {
      const records = [...new Set(ids)].map(id => this.options.memory.get(id));
      const context = this.scopeContext(botId, conversationId);
      if (!context) throw new Error("当前对话记忆范围不可用");
      const allowPublic = publicScopeRequested(userText);
      const scopeMatches = (scope: { scopeType: MemoryScopeType; scopeId?: string }) =>
        scope.scopeType === (context.teamId ? "team" : "bot") && scope.scopeId === (context.teamId ?? botId)
        || scope.scopeType === "conversation" && Boolean(conversationId) && scope.scopeId === conversationId
        || scope.scopeType === "global" && allowPublic;
      if (records.some(record => record && !record.scopes.some(scope => scopeMatches(scope)
        && (scope.scopeType !== "global" || record.metadata.publicShared === true)))) {
        throw new Error("只能移除当前 Bot、团队或本次对话的记忆；其他范围或公共记忆需要相应明确要求");
      }
      const present = records.filter(record => record !== undefined);
      for (const record of present) {
        for (const scope of record.scopes.filter(scope => scopeMatches(scope) && (scope.scopeType !== "global" || record.metadata.publicShared === true))) this.options.memory.detachScope(record.id, scope.scopeType, scope.scopeId, source);
      }
      return { forgottenCount: present.length, alreadyAbsentCount: records.length - present.length, titles: present.map(record => record.title) };
    })();
    this.options.changed();
    return result;
  }

  context(botId: string, conversationId: string, sourceMessageId?: string): string {
    const context = this.scopeContext(botId, conversationId);
    if (!context) return "";
    // Stable preferences should also influence unrelated requests. Bounded active L1,
    // read afresh at every provider request: no stale in-memory copy after deletion.
    const stable = this.options.memory.resolveContext({ ...context,
      statuses: ["active"], budgetChars: 6000, limit: 12 }).text;
    const source = sourceMessageId && this.messages.message(sourceMessageId);
    if (!source || source.role !== "user" || source.botId !== botId || source.conversationId !== conversationId) return stable;
    const historical = botHistoryContext(this.options.db.connection, { userId: this.options.userId, botId,
      excludeConversationId: conversationId, teamId: context.teamId, query: source.text, before: source.createdAt });
    return [stable, historical].filter(Boolean).join("\n\n");
  }

  /** Called within the assistant completion transaction; capture failure never changes the reply. */
  capture(botId: string, requestId: string): string | undefined {
    if (!this.allowedBot(botId)) return;
    const receipt = this.messages.receipt(this.options.userId, botId, requestId);
    const source = receipt && botMemorySource(this.options.db, receipt.conversation_id, this.options.userId);
    if (!receipt || !source || (!source.team_id && source.bot_id !== botId)) return;
    const user = this.messages.message(receipt.user_message_id);
    const assistant = this.messages.message(receipt.assistant_message_id);
    if (!user || !assistant || user.role !== "user" || assistant.role !== "assistant"
      || user.status !== "completed" || assistant.status !== "completed"
      || [user, assistant].some(message => message.conversationId !== receipt.conversation_id || message.botId !== botId || message.requestId !== requestId)
      || !botMemoryTextEligible(user.text)) return;
    // A pure forget can precede the old request's completion, so no L1 record may
    // exist yet. Record its source time, not this delayed completion time.
    if (/(?:忘记|删除.{0,24}记忆|清除.{0,24}记忆|\bforget\b|\bdelete\b.{0,32}\bmemor)/i.test(user.text)
      && !user.text.split(/[，,、。；;！!？?\n]/).some(clause => botMemoryWriteEvidenceAllowed(user.text, clause))) {
      const temporary = botMemoryConversationOnly(user.text);
      const scopeType = temporary ? "conversation" : publicScopeRequested(user.text) ? "global" : source.team_id ? "team" : "bot";
      const scopeId = scopeType === "conversation" ? receipt.conversation_id : scopeType === "global" ? undefined : source.team_id ?? botId;
      this.options.memory.recordForgetBoundary(scopeType, scopeId, user.createdAt);
    }
    const decision = this.options.pipeline.capture({ taskId: receipt.conversation_id, sessionId: receipt.conversation_id,
      userMessageId: user.messageId, assistantMessageId: assistant.messageId, userText: "",
      // L0 is a source pointer. Do not duplicate raw conversations (including mixed
      // sensitive content) into long-term memory. Extraction reads the original transiently.
      assistantText: "", metadata: { source: "bot_conversation", botId, teamId: source.team_id ?? undefined, userId: this.options.userId } });
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

/** Only the user's explicit sharing/removal wording grants public scope, not a model-selected ID. */
function publicScopeRequested(text: string): boolean {
  return /(?:所有|全部|每个).{0,12}(?:bot|助理)|(?:公共|共享)记忆|(?:all|every)\s+(?:bots?|assistants?)|public\s+memor/i.test(text)
    && !/(?:不要|别|不必|不能|勿).{0,8}(?:共享|公开|所有|全部)|(?:do not|don['’]?t|never).{0,12}(?:share|public|all bots)/i.test(text);
}
