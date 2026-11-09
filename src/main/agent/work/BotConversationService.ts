import { createHash } from "node:crypto";
import { BotAttachmentInputError, prepareBotAttachmentInput, type BotVisionFallback } from "./BotAttachmentInput";
import { snapshotBotAttachments } from "./BotAttachmentStorage";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { botHistorySchema, botSendSchema } from "../../../shared/bot-conversation";
import type { WorkDto } from "../../../shared/bot-work";
import { BotConversationRepository, type BotConversation } from "./BotConversationRepository";
import { BOT_FOREGROUND_TOOLS, botForegroundTools } from "./BotForegroundTools";
import { DurableBotRuntime } from "../durable/DurableBotRuntime";
import { resolveBotModel } from "../durable/BotModelCatalog";
import { botForegroundRequest } from "./BotForegroundIdentity";
import { z } from "zod";
import type { BotRegistry } from "./BotRegistry";
import type { WorkService } from "./WorkService";

export interface BotConversationServiceOptions {
  db: Database.Database;
  userId: string;
  bots: BotRegistry;
  works: WorkService;
  models: ModelRuntime;
  directory: string;
  defaultModel: () => string | undefined;
  botModel?: (botId: string) => string | undefined;
  isAuthority: () => boolean;
  memorySearch: (botId: string, query: string) => unknown;
  schedule: (work: WorkDto, operationId: string, retryBlocked?: boolean) => void;
  wake: (workId?: string) => void;
  visionFallback?: BotVisionFallback;
  onMessage?: (event: import("../../../shared/bot-conversation").BotMessageEvent) => void;
}

/** Persistent foreground messages have their own identity and native root, without a Task row. */
export class BotConversationService {
  readonly messages: BotConversationRepository;
  private readonly drains = new Map<string, Promise<void>>();
  private readonly runtimes = new Map<string, DurableBotRuntime>();
  private readonly runtimeModels = new Map<string, unknown>();
  private readonly runtimeInstructions = new Map<string, string>();
  private readonly openings = new Map<string, Promise<DurableBotRuntime>>();
  private readonly stops = new Map<string, Promise<void>>();
  private readonly shutdown = new AbortController();
  private closing = false;
  private readonly streamedAt = new Map<string, number>();
  constructor(private readonly options: BotConversationServiceOptions) {
    this.messages = new BotConversationRepository(options.db);
  }

  send(input: unknown) {
    const request = botSendSchema.parse(input);
    const receipt = this.options.works.transaction(() => {
      this.assertBot(request.botId, false);
      const prior = this.messages.receipt(this.options.userId, request.botId, request.requestId);
      if (!prior) this.assertBot(request.botId, true);
      if (!prior && request.selectedWorkId) this.assertWork(request.botId, request.selectedWorkId);
      if (!prior && request.referenceMessageId) {
        const message = this.messages.message(request.referenceMessageId);
        const conversation = this.messages.conversation(this.options.userId, request.botId, request.conversationId);
        if (!message || message.botId !== request.botId || message.conversationId !== conversation?.conversation_id) throw new Error("消息引用不属于当前对话");
        message.workIds.forEach(workId => this.assertWork(request.botId, workId));
      }
      const key = createHash("sha256").update(JSON.stringify([this.options.userId, request.botId, request.requestId])).digest("hex");
      let attachments;
      try { attachments = prior ? undefined : snapshotBotAttachments(this.options.directory, key, request.attachments ?? []); }
      catch (error) { throw new Error(`BOT_ATTACHMENT_REJECTED: ${error instanceof Error ? error.message : String(error)}`); }
      return this.messages.accept(this.options.userId, request, attachments);
    });
    if (this.options.bots.getBot(receipt.botId)?.status === "active") this.kick(receipt.botId, receipt.conversationId);
    return receipt;
  }

  history(input: unknown) {
    const request = botHistorySchema.parse(input);
    this.assertBot(request.botId, false);
    return this.messages.history(this.options.userId, request);
  }

  async cancel(botId: string, requestId: string): Promise<void> {
    this.assertBot(botId, false);
    const source = this.messages.receipt(this.options.userId, botId, requestId);
    if (!source) throw new Error("找不到发送请求");
    const message = this.messages.message(source.assistant_message_id);
    if (!message || !["queued", "running", "unknown"].includes(message.status)) return;
    this.options.works.transaction(() => {
      if (!this.options.isAuthority()) throw new Error("当前宿主不持有取消权");
      this.messages.update(message.messageId, "cancelled", message.text);
      this.options.db.prepare("INSERT OR IGNORE INTO bot_cancel_intents(conversation_id,request_id) VALUES (?,?)").run(source.conversation_id, requestId);
    });
    this.publish(message.messageId);
    await this.stopPending(botId, source.conversation_id);
    this.options.wake();
  }

  archive(botId: string, conversationId: string): void {
    this.assertBot(botId, false);
    this.options.works.transaction(() => this.messages.archive(this.options.userId, botId, conversationId));
  }

  recover(): void {
    if (!this.options.isAuthority()) return;
    this.options.works.transaction(() => this.messages.pruneTerminalWorkReads(this.options.userId));
    const cancelled = this.options.db.prepare(`SELECT DISTINCT c.bot_id,c.conversation_id FROM bot_conversations c
      JOIN bot_cancel_intents i ON i.conversation_id=c.conversation_id WHERE c.user_id=? AND i.confirmed_at IS NULL`).all(this.options.userId);
    for (const value of cancelled) {
      const row = z.object({ bot_id: z.string(), conversation_id: z.string() }).parse(value);
      void this.stopPending(row.bot_id, row.conversation_id).catch(error => console.warn("[Bot] 取消回执待恢复", error));
    }
    for (const conversation of this.messages.pending(this.options.userId)) this.kick(conversation.bot_id, conversation.conversation_id);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.shutdown.abort();
    await Promise.allSettled(this.openings.values());
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.close()));
    await Promise.allSettled([...this.stops.values(), ...this.drains.values()]);
    await Promise.allSettled(this.openings.values());
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.close()));
    this.runtimes.clear();
  }

  private kick(botId: string, conversationId: string): void {
    if (this.closing || this.drains.has(conversationId)) return;
    const drain = this.drain(botId, conversationId).finally(() => {
      this.drains.delete(conversationId);
      if (!this.closing && this.options.isAuthority() && this.messages.next(conversationId)?.status === "queued") this.kick(botId, conversationId);
    });
    this.drains.set(conversationId, drain);
    void drain.catch(error => console.warn("[Bot] 前台对话恢复失败", conversationId, error));
  }

  private async drain(botId: string, conversationId: string): Promise<void> {
    while (!this.closing && this.options.isAuthority()) {
      await this.stops.get(conversationId);
      const next = this.messages.next(conversationId);
      if (!next) return;
      try {
        const conversation = this.options.works.transaction(() => {
          this.assertBot(botId, true);
          this.options.db.prepare("UPDATE bot_conversations SET current_request_id=? WHERE conversation_id=?")
            .run(next.requestId, conversationId);
          this.messages.update(next.messageId, "running", next.text);
          const value = this.messages.conversation(this.options.userId, botId, conversationId);
          if (!value) throw new Error("对话不存在");
          return value;
        });
        const source = this.messages.receipt(this.options.userId, botId, next.requestId);
        const user = source && this.messages.message(source.user_message_id);
        if (!user) throw new Error("持久发送请求缺少用户消息");
        const runtime = await this.runtime(conversation);
        if (this.messages.message(next.messageId)?.status === "cancelled") continue;
        runtime.resume();
        const prior = await runtime.conversation.commit(tx => tx.submissionByRequest(runtime.conversation.id, next.requestId), context);
        let submission = prior && await runtime.harness.submission(prior.id, context);
        if (!submission) {
          const preferred = this.options.botModel?.(botId);
          const model = await resolveBotModel(this.options.models, preferred, this.options.defaultModel());
          if (preferred && model.repairedFrom) throw new Error(`Bot 模型 ${preferred} 不可用，请在 Bot 设置中选择可用模型`);
          this.runtimeInstructions.set(conversationId, this.options.bots.activeSnapshot(botId)?.configuration?.instructions ?? "");
          await runtime.configure(model.target, "native");
          this.runtimeModels.set(conversationId, this.options.models.getModel(model.target.provider, model.target.modelId));
          const input = await prepareBotAttachmentInput({ text: user.text, attachments: user.attachments ?? [],
            model: this.runtimeModels.get(conversationId), directory: join(this.options.directory, conversationId),
            requestId: next.requestId, visionFallback: this.options.visionFallback });
          submission = await runtime.submit(input, next.requestId, "followUp",
            { text: user.text, displayText: user.text, attachments: user.attachments ?? [], botRequestId: next.requestId });
        }
        const reply = await this.untilClose(runtime.reply(submission));
        await runtime.conversation.waitForIdle(context);
        if (this.messages.message(next.messageId)?.status !== "cancelled") {
          this.options.works.transaction(() => this.messages.update(next.messageId, "completed", reply));
        }
      } catch (error) {
        if (this.messages.message(next.messageId)?.status !== "cancelled") {
          this.options.works.transaction(() => this.messages.update(next.messageId, error instanceof BotAttachmentInputError ? "failed" : "unknown", this.messages.message(next.messageId)?.text ?? next.text, error instanceof Error ? error.message : String(error)));
        }
        const runtime = this.runtimes.get(conversationId);
        if (runtime?.isSessionFailed()) { this.runtimes.delete(conversationId); await runtime.close(); }
        return;
      } finally { this.streamedAt.delete(next.messageId); this.publish(next.messageId); this.options.wake(); }
    }
  }

  private runtime(conversation: BotConversation): Promise<DurableBotRuntime> {
    const existing = this.runtimes.get(conversation.conversation_id);
    if (existing) return Promise.resolve(existing);
    const opening = this.openings.get(conversation.conversation_id);
    if (opening) return opening;
    const pending = this.openRuntime(conversation).then(runtime => { this.runtimes.set(conversation.conversation_id, runtime); return runtime; })
      .finally(() => { this.openings.delete(conversation.conversation_id); });
    this.openings.set(conversation.conversation_id, pending);
    return pending;
  }

  private async openRuntime(conversation: BotConversation): Promise<DurableBotRuntime> {
    const bot = this.assertBot(conversation.bot_id, false);
    const directory = join(this.options.directory, conversation.conversation_id);
    mkdirSync(directory, { recursive: true });
    const model = await resolveBotModel(this.options.models, this.options.botModel?.(bot.botId), this.options.defaultModel());
    this.runtimeModels.set(conversation.conversation_id, this.options.models.getModel(model.target.provider, model.target.modelId));
    this.runtimeInstructions.set(conversation.conversation_id, this.options.bots.activeSnapshot(bot.botId)?.configuration?.instructions ?? "");
    const allowed = (name: string) => BOT_FOREGROUND_TOOLS.has(name) && (this.options.bots.getBot(bot.botId)?.foregroundAllowedTools.includes(name) ?? false);
    const runtime = await DurableBotRuntime.open({ directory, cwd: directory, models: this.options.models, model: model.target,
      toolMode: "native", toolAllowed: allowed,
      instructions: () => `${this.runtimeInstructions.get(conversation.conversation_id) ?? ""}\n你是独立前台 Bot。普通交流直接答复，不强制创建 Work。用户明确委托业务才创建 Work，后台异步受理后立即回复。联网、文件、代码、桌面等实际业务只能委托后台。查询用已知事实工具；修改前查询并使用返回的 versionGuard，冲突重新判断。多个 Work 含糊不清时先澄清。你不能扩大授权、续权或代替验收。用户明确要求写文件时，不要仅因当前 workspace:read 就停在口头索要授权；用现有授权创建或继续对应 Work，所需 workspace:write 由后台针对具体工具动作生成单次审批卡，用户可在 Bot 页批准或拒绝。不得把聊天中的同意伪装成已授予权限；如果无法派发，查询并报告真实 blocker 和可操作的入口。`,
      tools: botForegroundTools({ ...this.options, botId: bot.botId, conversationId: conversation.conversation_id, messages: this.messages,
        memorySearch: query => this.options.memorySearch(bot.botId, query) }),
      toolHooks: { beforeTool: async (call, api, ctx) => {
        if (!allowed(call.name) || !this.options.isAuthority() || this.options.bots.getBot(bot.botId)?.status !== "active") return { block: "前台工具未授权或 Bot/宿主不可用" };
        const requestId = await botForegroundRequest(api, call.id, ctx);
        const receipt = this.messages.receipt(this.options.userId, bot.botId, requestId);
        const message = receipt && this.messages.message(receipt.assistant_message_id);
        if (!receipt || receipt.conversation_id !== conversation.conversation_id || !message ||
          message.role !== "assistant" || message.conversationId !== receipt.conversation_id ||
          message.botId !== receipt.bot_id || message.requestId !== requestId ||
          !["queued", "running", "unknown"].includes(message.status)) return { block: "原始消息已结束或身份不可核对" };
      } },
      onSnapshot: snapshot => this.stream(conversation, snapshot),
    });
    return runtime;
  }

  private stream(conversation: BotConversation, snapshot: import("../../../shared/durable-bot").DurableBotSnapshot): void {
    if (this.closing || !this.options.isAuthority()) return;
    const current = this.messages.conversation(this.options.userId, conversation.bot_id, conversation.conversation_id);
    if (!current || current.archived_at !== null || !current.current_request_id) return;
    // Match the persisted native input identity, never a timestamp or repeated user text.
    let lastUser = snapshot.messages.length - 1;
    while (lastUser >= 0 && snapshot.messages[lastUser].role !== "user") lastUser--;
    if (lastUser < 0 || snapshot.messages[lastUser].botRequestId !== current.current_request_id) return;
    const source = this.messages.receipt(this.options.userId, conversation.bot_id, current.current_request_id);
    const message = source && this.messages.message(source.assistant_message_id);
    if (!message || message.status !== "running") return;
    const row = snapshot.messages.slice(lastUser + 1).reverse().find(item => item.role === "assistant");
    if (!row?.text || row.text === message.text) return;
    const now = Date.now();
    if (now - (this.streamedAt.get(message.messageId) ?? 0) < 80) return;
    this.streamedAt.set(message.messageId, now);
    // Persist at a bounded cadence: a reconnect reads the same revision, not a blank placeholder.
    this.messages.update(message.messageId, "running", row.text);
    this.publish(message.messageId);
  }

  private publish(messageId: string): void {
    const message = this.messages.message(messageId);
    if (!message) return;
    const conversation = this.messages.conversation(this.options.userId, message.botId, message.conversationId);
    if (!conversation || conversation.archived_at !== null) return;
    this.options.onMessage?.({ botId: message.botId, conversationId: message.conversationId,
      revision: conversation.revision, message });
  }

  private stopPending(botId: string, conversationId: string): Promise<void> {
    const prior = this.stops.get(conversationId) ?? Promise.resolve();
    const stopping = prior.catch(() => {}).then(async () => {
      if (this.closing) return; // The persisted cancellation is recovered before the next input on reopen.
      const conversation = this.messages.conversation(this.options.userId, botId, conversationId);
      if (!conversation) throw new Error("找不到原始对话");
      const requests = this.options.db.prepare("SELECT request_id FROM bot_cancel_intents WHERE conversation_id=? AND confirmed_at IS NULL")
        .all(conversationId).map(row => z.object({ request_id: z.string() }).parse(row));
      if (!requests.length || !this.options.isAuthority()) return;
      const runtime = await this.runtime(conversation);
      for (const request of requests) {
        const record = await runtime.conversation.commit(tx => tx.submissionByRequest(runtime.conversation.id, request.request_id), context);
        if (record?.status === "queued" || record?.status === "placed") {
          // The drain cannot admit another input while this cancellation is pending.
          // Recovered tools independently check the immutable cancelled source.
          runtime.resume();
          await runtime.abort();
        }
        this.options.works.transaction(() => {
          if (!this.options.isAuthority()) throw new Error("取消回执前宿主租约已变化");
          this.options.db.prepare("UPDATE bot_cancel_intents SET confirmed_at=? WHERE conversation_id=? AND request_id=?")
            .run(Date.now(), conversationId, request.request_id);
        });
      }
    }).finally(() => { if (this.stops.get(conversationId) === stopping) this.stops.delete(conversationId); });
    this.stops.set(conversationId, stopping);
    return stopping;
  }

  private assertBot(botId: string, active: boolean) {
    const bot = this.options.bots.getBot(botId);
    if (!bot || bot.userId !== this.options.userId || active && (this.closing || !this.options.isAuthority() || bot.status !== "active")) throw new Error("Bot 不属于当前用户或暂不可受理消息");
    return bot;
  }

  private async untilClose<T>(operation: Promise<T>): Promise<T> {
    let stop: () => void = () => {};
    const closed = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new Error("主机已关闭，原生请求等待恢复"));
      this.shutdown.signal.addEventListener("abort", stop, { once: true });
      if (this.shutdown.signal.aborted) stop();
    });
    try { return await Promise.race([operation, closed]); }
    finally { this.shutdown.signal.removeEventListener("abort", stop); }
  }
  private assertWork(botId: string, workId: string) {
    const work = this.options.works.getWork(workId);
    if (!work || work.userId !== this.options.userId
      || work.ownerBotId !== botId && !work.participants.some(member => member.botId === botId)) {
      throw new Error("Work 不属于当前用户与 Bot");
    }
  }
}
