import type { ConversationAdmission } from "./GatewayConversationSession";
import type { GatewayChannelType } from "../../shared/agent-ipc";
import type { ChannelAdapter, ChannelConfig, GatewayInboundDelivery, GatewayInboundHandler, GatewayInboundMessage } from "./channels";
import { gatewayWorkTargetSchema } from "./work-outbound";
import { GatewayDeliveryJournal, type GatewayInboxEntry } from "./GatewayDeliveryJournal";
import { GatewayReplyNotSentError, gatewayReplyRouteSchema } from "./GatewayReply";
import type { GatewayBotOrigin } from "../agent/work/BotTurnOrigins";

import { GATEWAY_CAPABILITIES, type GatewayCapabilities } from "./GatewayCapabilities";
export { GATEWAY_CAPABILITIES, type GatewayCapabilities } from "./GatewayCapabilities";

/** Internal transport envelope. Account is a public-identity digest, never a token.
 * Do not put this envelope or transport metadata in model instructions.
 * Native chat/session semantics intentionally remain owned by GatewayService.
 */
export interface GatewayMessageEvent {
  readonly version: 1;
  readonly platform: GatewayChannelType;
  readonly source: Readonly<{ channelId: string; accountKey: string; chatId: string; threadId?: string }>;
  readonly sender?: Readonly<{ id: string; name?: string }>;
  readonly messageId?: string;
  readonly text: string;
  readonly receivedAt: number;
  readonly capabilities: Readonly<GatewayCapabilities>;
  readonly message: GatewayInboundMessage;
}
/** Runtime mode overrides only transport and whether unsolicited Work delivery is supported. */
export function gatewayCapabilities(adapter: ChannelAdapter, config?: ChannelConfig): Readonly<GatewayCapabilities> {
  const dynamic = (adapter as ChannelAdapter & {
    gatewayCapabilities?: (config?: ChannelConfig) => Pick<GatewayCapabilities, "transport" | "workNotifications"> & Partial<Pick<GatewayCapabilities, "media">>;
  }).gatewayCapabilities?.(config);
  return Object.freeze({ ...GATEWAY_CAPABILITIES[adapter.type],
    ...(dynamic ? { transport: dynamic.transport, workNotifications: dynamic.workNotifications, ...(dynamic.media !== undefined ? { media: dynamic.media } : {}) } : {}) });
}

export interface RegisteredGatewayAdapter extends ChannelAdapter {
  setInboundHandler(handler: GatewayInboundHandler): void;
}

export interface GatewayPlatformRegistryOptions {
  journal?: GatewayDeliveryJournal;
  reserveConversation?(message: GatewayInboundMessage, accountKey: string, messageId: string, admission: ConversationAdmission): void;
  /** Only a handler using stable native submission receipts may replay a running input. */
  replayNativeReceipts?: boolean;
  onStatus?: (channelId: string, text: string) => void;
  now?: () => number;
  maxReplyAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
  /** Current policy is rechecked on every replay and outbox attempt. */
  authorize?: (message: GatewayInboundMessage) => boolean;
  onReplySent?: (deliveryId: string, continuationOperation?: string) => void;
  replyCurrent?: (deliveryId: string, continuationOperation?: string) => boolean;
  coreControlled?: boolean;
  onScheduleRecover?: (channelId: string, delayMs: number) => void;
  onOutboundUnknown?: (info: {
    deliveryId: string;
    attempt: number;
    channelId: string;
    channelType: GatewayChannelType;
    accountKey: string;
    queryable: boolean;
  }) => void;
}

/** Fixed-position tuples preserve the native session's identity. Object key order
 * and delimiter characters in provider IDs cannot split or merge queues. */
export function gatewaySessionQueueKey(adapter: Pick<ChannelAdapter, "id" | "type">, accountKey: string, message: Pick<GatewayInboundMessage, "chatId" | "taskId">): string {
  return JSON.stringify([adapter.id, accountKey, adapter.type === "slack" ? message.taskId ?? message.chatId : message.chatId]);
}

export class GatewayPlatformRegistry {
  async continueBotReply(origin: GatewayBotOrigin, operationId: string, text: string): Promise<void> {
    const journal = this.options.journal;
    if (!journal) throw new Error("原渠道持久回复队列不可用");
    const entry = journal.continueReply(origin, operationId, text);
    if ((await journal.readOutbox(entry.delivery_id))?.status === "sent") return;
    const adapter = this.entries.get(origin.channelId);
    if (!adapter || !adapter.isConnected() || adapter.workConnectionKey?.() !== origin.connectionKey)
      throw new Error("原渠道连接暂不可用，协作回传已持久等待恢复");
    await this.dispatchStored(adapter, entry);
    if ((await journal.readOutbox(entry.delivery_id))?.status !== "sent") throw new Error("原渠道协作回传尚无发送回执");
  }
  private readonly entries = new Map<string, RegisteredGatewayAdapter>();
  private readonly handlers = new Map<string, (event: GatewayMessageEvent) => Promise<void>>();
  // Serialize only execution in the existing native session; never create a bot
  // runtime, new task identity or prompt context. Other chats remain concurrent.
  private readonly tails = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string, Promise<void>>();
  private readonly coreRecoveries = new Map<string, { epoch: number; channelEpoch: number; accountKey?: string;
    generation: unknown; ready: Promise<boolean> }>();
  private readonly coreDeliveryCounts = new Map<string, Record<string, number>>();
  private readonly depths = new Map<string, number>();
  private pending = 0;
  private epoch = 0;
  private suspended = false;
  private readonly pausedChannels = new Set<string>();
  private readonly channelEpochs = new Map<string, number>();
  private readonly offlineChecks = new Map<string, number>();
  private readonly activeDeliveries = new Map<string, GatewayInboundDelivery>();
  private readonly liveReplies = new Map<string, { channelId: string; accountKey: string; generation: unknown; reply: (text: string) => Promise<void> }>();
  private readonly recoveryTimers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly now: () => number;
  private readonly maxReplyAttempts: number;

  constructor(private readonly options: GatewayPlatformRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxReplyAttempts = options.maxReplyAttempts ?? 5;
    if (!Number.isSafeInteger(this.maxReplyAttempts) || this.maxReplyAttempts < 1) throw new Error("Gateway 回复重试次数无效");
    options.journal?.recoverInterrupted();
  }

  register(adapter: RegisteredGatewayAdapter, handler: (event: GatewayMessageEvent) => Promise<void>): void {
    if (this.entries.has(adapter.id)) throw new Error("Gateway 渠道 ID 重复");
    if (!GATEWAY_CAPABILITIES[adapter.type]) throw new Error("Gateway 渠道能力未声明");
    this.entries.set(adapter.id, adapter);
    this.handlers.set(adapter.id, handler);
    // Bind provenance to the actual producer, not an event-controlled channelId.
    adapter.setInboundHandler(message => {
      try {
        if (this.suspended || this.pausedChannels.has(adapter.id)) throw new Error("Gateway 正在关闭，消息尚未接收");
        const event = this.normalize(adapter, message);
        if (!this.isAuthorized(event.message)) return this.delivery(Promise.resolve());
        const key = gatewaySessionQueueKey(adapter, event.source.accountKey, message);
        // Slack already has a pre-ACK journal and chunk-aware outbox. Keep one
        // transport owner, rather than acknowledging two conflicting journals.
        const journal = this.options.journal;
        if (!journal || adapter.type === "slack") {
          return this.delivery(this.enqueue(adapter, event, key, () => handler(event)));
        }
        // Internal socket reconnects do not necessarily call Service.connect().
        // Schedule older accepted inputs before a fresh event can overtake them.
        if (!journal.usesCoreAdmission) this.recover(adapter.id, false);
        this.assertCapacity(key);
        const generation = adapter.gatewayConnectionGeneration?.();
        const dispatch = ({ entry }: { entry: GatewayInboxEntry }) => {
          this.liveReplies.set(entry.delivery_id, { channelId: adapter.id, accountKey: entry.account_key,
            generation, reply: event.message.reply });
          return this.dispatchStored(adapter, entry);
        };
        const draft = { platform: adapter.type, accountKey: event.source.accountKey,
          sessionKey: key, message: event.message, replayNativeReceipts: Boolean(this.options.replayNativeReceipts) };
        if (journal.usesCoreAdmission) {
          const epoch = this.epoch;
          const channelEpoch = this.channelEpochs.get(adapter.id) ?? 0;
          const isCurrent = () => !this.suspended && !this.pausedChannels.has(adapter.id) && this.epoch === epoch
            && (this.channelEpochs.get(adapter.id) ?? 0) === channelEpoch && adapter.isConnected()
            && adapter.workConnectionKey?.() === event.source.accountKey && adapter.gatewayConnectionGeneration?.() === generation
            && this.isAuthorized(event.message);
          const assertCurrent = () => {
            if (!isCurrent()) {
              throw new Error("Gateway 收件时连接或授权已变化");
            }
          };
          const previous = this.admissions.get(key) ?? Promise.resolve();
          const receipt = previous.then(async () => {
            assertCurrent();
            const truncated = await this.recoverCore(adapter.id, false, key);
            assertCurrent();
            if (truncated) throw new Error("Gateway 当前会话仍有待恢复消息，请稍后重试");
            this.assertCapacity(key);
            return journal.admit(draft);
          });
          const admitted = receipt.then(() => undefined, () => undefined);
          this.admissions.set(key, admitted);
          void admitted.then(() => { if (this.admissions.get(key) === admitted) this.admissions.delete(key); });
          return this.delivery(receipt.then(value => isCurrent() ? dispatch(value) : undefined), receipt.then(() => undefined));
        }
        return dispatch(journal.accept({ ...draft,
          reserveConversation: (messageId, acceptedAt) => this.options.reserveConversation?.(event.message, event.source.accountKey, messageId, { acceptedAt }) }));
      } catch (error) {
        return this.delivery(Promise.reject(error), Promise.reject(error));
      }
    });
  }

  /** Keep failures observable by callers/ACK owners while also handling a caller
   * that intentionally detaches the completion. The promise still rejects. */
  private delivery(completion: Promise<void>, accepted: Promise<void> = Promise.resolve()): GatewayInboundDelivery {
    void completion.catch(() => {});
    void accepted.catch(() => {});
    return Object.assign(completion, { accepted });
  }

  private assertCapacity(key: string): void {
    if ((this.depths.get(key) ?? 0) >= 64 || this.pending >= 1024) throw new Error("Gateway 入站队列已满，请稍后重试");
  }

  private enqueue(adapter: RegisteredGatewayAdapter, event: GatewayMessageEvent, key: string, operation: () => Promise<void>): Promise<void> {
    this.assertCapacity(key);
    const generation = adapter.gatewayConnectionGeneration?.();
    const epoch = this.epoch;
    const channelEpoch = this.channelEpochs.get(adapter.id);
    this.depths.set(key, (this.depths.get(key) ?? 0) + 1);
    this.pending++;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      if (this.suspended || this.pausedChannels.has(adapter.id) || epoch !== this.epoch || channelEpoch !== this.channelEpochs.get(adapter.id)
        || !adapter.isConnected() || adapter.workConnectionKey?.() !== event.source.accountKey
        || adapter.gatewayConnectionGeneration?.() !== generation) throw new GatewayReplyNotSentError("Gateway 排队消息连接账号已改变，未执行");
      await operation();
    });
    const settled = run.finally(() => {
      this.pending--;
      const remaining = (this.depths.get(key) ?? 1) - 1;
      if (remaining) this.depths.set(key, remaining); else this.depths.delete(key);
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    const tail = settled.then(() => {}, () => {});
    this.tails.set(key, tail);
    return settled;
  }

  private dispatchStored(adapter: RegisteredGatewayAdapter, entry: GatewayInboxEntry): GatewayInboundDelivery {
    const journal = this.options.journal!;
    const active = this.activeDeliveries.get(entry.delivery_id);
    if (active) return active;
    if (entry.status === "completed") { this.liveReplies.delete(entry.delivery_id); return this.delivery(Promise.resolve()); }
    if (entry.status === "unknown") {
      this.liveReplies.delete(entry.delivery_id);
      return this.delivery(Promise.reject(new Error("Gateway 上次结果未确认，已保留记录并停止自动重发")));
    }
    let event: GatewayMessageEvent;
    try {
      // Outbox-only retry never reloads files or invokes a model. An already
      // saved answer remains deliverable if its old input cache was removed.
      const payload = journal.decode(entry, !journal.usesCoreAdmission && !journal.outbox(entry.delivery_id));
      const live = this.liveReplies.get(entry.delivery_id);
      const reply = live?.accountKey === entry.account_key && live.generation === adapter.gatewayConnectionGeneration?.()
        ? live.reply : async (text: string) => {
          const restored = adapter.restoreGatewayReply?.({ deliveryId: entry.delivery_id, chatId: payload.chatId,
            messageId: payload.messageId, sender: payload.sender, route: payload.replyRoute });
          if (!restored) throw new GatewayReplyNotSentError("Gateway 回复地址不可恢复，等待原渠道重新投递或重新授权");
          await restored(text);
        };
      event = this.normalize(adapter, { ...payload,
        ...(payload.attachments ? { attachments: payload.attachments.map(({ name, path }) => ({ name, path })) } : {}),
        reply });
      if (event.source.accountKey !== entry.account_key || entry.platform !== adapter.type
        || gatewaySessionQueueKey(adapter, entry.account_key, event.message) !== entry.session_key) throw new Error("Gateway 恢复消息的账号或会话身份已改变");
      if (!journal.usesCoreAdmission && this.isAuthorized(event.message) && !journal.outbox(entry.delivery_id))
        this.options.reserveConversation?.(event.message, entry.account_key, entry.message_id, { acceptedAt: entry.created_at, recovered: true });
    } catch {
      this.liveReplies.delete(entry.delivery_id);
      return this.delivery(journal.rejectUnclaimed(entry.delivery_id, "payload_or_route_invalid").then(() => {
        this.report(adapter.id, "Gateway 恢复消息校验失败，已保留记录；未执行缺失或改变的输入");
        throw new Error("Gateway 恢复消息或附件校验失败，未执行");
      }));
    }
    const run = this.enqueue(adapter, event, entry.session_key, async () => {
      const outbox = await journal.readOutbox(entry.delivery_id);
      if (outbox) { await this.sendStoredReply(adapter, entry, event.message); return; }
      if (!this.isAuthorized(event.message) || !await journal.assignmentCurrent(entry, event.message.sender?.id)) {
        await journal.rejectUnclaimed(entry.delivery_id, "authorization_revoked");
        throw new Error("Gateway 恢复消息的授权已撤回，未执行");
      }
      if (journal.usesCoreAdmission) {
        try { journal.decode(entry, true); }
        catch (error) {
          await journal.rejectUnclaimed(entry.delivery_id, "payload_or_route_invalid");
          throw error;
        }
      }
      const attempt = await journal.claimExecution(entry.delivery_id);
      if (attempt === undefined) throw new Error("Gateway 消息已被认领或不可再次执行");
      const connected = () => !this.suspended && !this.pausedChannels.has(adapter.id)
        && adapter.isConnected() && adapter.workConnectionKey?.() === entry.account_key;
      const message: GatewayInboundMessage = { ...event.message,
        gatewayDelivery: { id: entry.delivery_id, replay: attempt > 1 },
        reply: async text => {
          await journal.queueOwnedReply(entry.delivery_id, attempt, text);
          await this.sendStoredReply(adapter, entry, event.message);
        } };
      try {
        if (!connected() || !this.isAuthorized(message)) throw new Error("Gateway 执行连接或授权在认领后改变");
        await this.handlers.get(adapter.id)!({ ...event, message,
          capabilities: Object.freeze({ ...event.capabilities, durableInbound: true }) });
      } catch (error) {
        await journal.finishOwnedExecution(entry.delivery_id, attempt, connected() ? "failed" : "interrupted");
        throw error;
      }
      await journal.finishOwnedExecution(entry.delivery_id, attempt, "completed");
    });
    const completion = this.delivery(run.finally(async () => {
      const outbox = await journal.readOutbox(entry.delivery_id).catch(() => undefined);
      this.activeDeliveries.delete(entry.delivery_id);
      if (!outbox || outbox.status !== "pending") this.liveReplies.delete(entry.delivery_id);
      if (!this.suspended) this.scheduleResume(adapter.id, 0);
    }));
    this.activeDeliveries.set(entry.delivery_id, completion);
    return completion;
  }

  private async sendStoredReply(adapter: RegisteredGatewayAdapter, entry: GatewayInboxEntry, message: GatewayInboundMessage): Promise<void> {
    const journal = this.options.journal!;
    const claim = await journal.claimReply(entry.delivery_id, this.maxReplyAttempts);
    if (claim.status === "sent") return;
    if (claim.status === "waiting") {
      this.scheduleResume(adapter.id, claim.nextAttemptAt - this.now());
      throw new Error("Gateway 回复等待已安排的重试");
    }
    if (claim.status === "exhausted") {
      throw new Error("Gateway 回复达到重试上限，已保留未送达结果");
    }
    if (claim.status === "integrity") {
      this.report(adapter.id, "Gateway 已保存回复校验失败，未发送；请检查原始任务结果");
      throw new Error("Gateway 回复校验失败，已停止重试");
    }
    if (claim.status !== "sending") throw new Error("Gateway 回复结果未确认或已被认领，未再次发送");
    const sending = claim.entry;
    let continuation: string | undefined;
    try {
      if (this.suspended || this.pausedChannels.has(adapter.id) || !adapter.isConnected() || adapter.workConnectionKey?.() !== entry.account_key) {
        throw new GatewayReplyNotSentError("Gateway 回复连接不可用，未发送");
      }
      continuation = entry.message_id.startsWith("bot-reply:") ? await journal.readContinuationOperation(entry.delivery_id) : undefined;
      if (!this.isAuthorized(message) || (!continuation && !await journal.assignmentCurrent(entry, message.sender?.id))) {
        throw new GatewayReplyNotSentError("Gateway 回复授权已撤回，未发送");
      }
      if (this.suspended || this.pausedChannels.has(adapter.id) || !adapter.isConnected() || adapter.workConnectionKey?.() !== entry.account_key) {
        throw new GatewayReplyNotSentError("Gateway 回复授权复核后连接已变化，未发送");
      }
      if (this.options.replyCurrent?.(entry.delivery_id, continuation) === false) throw new GatewayReplyNotSentError("原协作回传已取消，未发送");
      // A native turn may outlive a same-account reconnect. Rebuild only from
      // the original accepted route and current verified credentials, so an old
      // closure is never the reason a recoverable answer remains stranded.
      const payload = journal.decode(entry, false);
      const restored = payload.replyRoute ? adapter.restoreGatewayReply?.({ deliveryId: entry.delivery_id, chatId: payload.chatId,
        messageId: payload.messageId, sender: payload.sender, route: payload.replyRoute }) : undefined;
      const live = this.liveReplies.get(entry.delivery_id);
      const currentReply = live?.accountKey === entry.account_key && live.generation === adapter.gatewayConnectionGeneration?.() ? live.reply : undefined;
      if (adapter.type === "slack" && continuation) {
        if (!payload.workTarget || payload.workTarget.channelType !== "slack" || !adapter.sendWorkNotification)
          throw new GatewayReplyNotSentError("原 Slack 私人回传目标不可用");
        const result = await adapter.sendWorkNotification({ target: payload.workTarget, text: sending.reply_text, effectKey: entry.delivery_id,
           assertCurrent: () => { if (!this.isAuthorized(message) || this.options.replyCurrent?.(entry.delivery_id, continuation) === false)
            throw new GatewayReplyNotSentError("原协作回传已取消或失去授权"); } });
        if (!result.ok) {
          if (result.responseLost) throw new Error("Slack 协作回传回执未知");
          throw new GatewayReplyNotSentError(result.error, result.retryable);
        }
      } else await (restored ?? currentReply ?? message.reply)(sending.reply_text);
    } catch (error) {
      if (error instanceof GatewayReplyNotSentError) {
        const retryable = error.retryable && sending.retry_count < this.maxReplyAttempts;
        const delay = Math.max(1, Math.min(5 * 60_000, error.retryAfterMs ?? this.options.retryDelayMs?.(sending.retry_count)
          ?? [1_000, 5_000, 15_000, 60_000][Math.min(sending.retry_count - 1, 3)]));
        const recorded = await journal.finishOwnedReply(entry.delivery_id, sending.retry_count,
          retryable ? "pending" : error.retryable ? "failed" : "blocked",
          retryable ? "provider_not_sent" : error.retryable ? "retry_exhausted" : "reply_unavailable",
          retryable ? this.now() + delay : 0);
        if (recorded) {
          this.report(adapter.id, retryable ? "Gateway 回复尚未发送，已安排有限重试" : "Gateway 回复未送达，已保留待处理结果");
          if (retryable) this.scheduleResume(adapter.id, delay);
        }
      } else {
        const recorded = await journal.finishOwnedReply(entry.delivery_id, sending.retry_count, "unknown", "provider_receipt_unknown");
        if (recorded) {
          this.report(adapter.id, "Gateway 回复回执未确认，已保留记录；为避免重复发送已停止自动重试");
          const queryable = typeof (adapter as RegisteredGatewayAdapter & { lookupOutboundDelivery?: unknown }).lookupOutboundDelivery === "function";
          this.options.onOutboundUnknown?.({
            deliveryId: entry.delivery_id,
            attempt: sending.retry_count,
            channelId: adapter.id,
            channelType: adapter.type,
            accountKey: entry.account_key,
            queryable,
          });
        }
      }
      throw new Error(error instanceof GatewayReplyNotSentError ? "Gateway 回复尚未发送，结果已保存" : "Gateway 回复回执未确认，未自动重发");
    }
    if (!await journal.finishOwnedReply(entry.delivery_id, sending.retry_count, "sent")) {
      throw new Error("Gateway 发送结果等待 Core 确认");
    }
    try { this.options.onReplySent?.(entry.delivery_id, continuation); }
    catch (error) { console.warn("[Gateway] 回复回执投影等待恢复", error); }
  }

  /** Enqueue recovery without making connect() wait for long-running Agent turns. */
  resume(channelId: string, retryBlocked = true): void {
    this.suspended = false;
    this.pausedChannels.delete(channelId);
    this.offlineChecks.delete(channelId);
    this.startRecovery(channelId, retryBlocked);
  }

  recoverScheduled(channelId: string): void {
    this.startRecovery(channelId, false);
  }

  private startRecovery(channelId: string, retryBlocked: boolean): void {
    if (!this.options.journal?.usesCoreAdmission) {
      this.recover(channelId, retryBlocked);
      return;
    }
    void this.recoverCore(channelId, retryBlocked).catch(() => {
      if (this.suspended || this.pausedChannels.has(channelId)) return;
      this.report(channelId, "Gateway 恢复暂时不可用，已保留待处理记录");
      this.scheduleResume(channelId, 1_000);
    });
  }

  private recoverCore(channelId: string, retryBlocked: boolean, sessionKey?: string): Promise<boolean> {
    const adapter = this.entries.get(channelId), journal = this.options.journal;
    if (!adapter || !journal || this.suspended || this.pausedChannels.has(channelId)) return Promise.resolve(false);
    const epoch = this.epoch, channelEpoch = this.channelEpochs.get(channelId) ?? 0;
    const accountKey = adapter.isConnected() ? adapter.workConnectionKey?.() : undefined;
    const generation = adapter.gatewayConnectionGeneration?.();
    const recoveryKey = JSON.stringify([channelId, sessionKey, retryBlocked]);
    const pending = this.coreRecoveries.get(recoveryKey);
    if (pending?.epoch === epoch && pending.channelEpoch === channelEpoch && pending.accountKey === accountKey
        && pending.generation === generation) return pending.ready;
    const current = () => !this.suspended && !this.pausedChannels.has(channelId) && this.epoch === epoch
      && (this.channelEpochs.get(channelId) ?? 0) === channelEpoch && this.entries.get(channelId) === adapter
      && (adapter.isConnected() ? adapter.workConnectionKey?.() : undefined) === accountKey
      && adapter.gatewayConnectionGeneration?.() === generation;
    const cutoff = this.now();
    const ready = journal.readRecovery({ channelId, accountKey, sessionKey, retryBlocked, cutoff,
      limit: sessionKey === undefined ? 1024 : 64, continuationsOnly: adapter.type === "slack" }).then(state => {
      if (!current()) return false;
      this.coreDeliveryCounts.set(channelId, state.counts);
      if (!accountKey) {
        this.scheduleOfflineRecovery(channelId, state.counts);
        return false;
      }
      this.offlineChecks.delete(channelId);
      this.scheduleStored(adapter, state.pending);
      if (state.nextRetryAt !== null) this.scheduleResume(channelId, Math.max(1, state.nextRetryAt - this.now()));
      return state.truncated;
    }).catch(error => {
      if (!current()) return false;
      throw error;
    }).finally(() => {
      if (this.coreRecoveries.get(recoveryKey)?.ready === ready) this.coreRecoveries.delete(recoveryKey);
    });
    this.coreRecoveries.set(recoveryKey, { epoch, channelEpoch, accountKey, generation, ready });
    return ready;
  }

  private recover(channelId: string, retryBlocked: boolean): void {
    if (this.suspended || this.pausedChannels.has(channelId)) return;
    const adapter = this.entries.get(channelId), journal = this.options.journal;
    const key = adapter?.workConnectionKey?.();
    if (!adapter || !journal) return;
    if (!adapter.isConnected() || !key) {
      this.scheduleOfflineRecovery(channelId, journal.counts(channelId));
      return;
    }
    this.offlineChecks.delete(channelId);
    // Partition due and future retries at one instant. A deadline crossed between
    // the two queries must still schedule a wake, not fall into neither result.
    const cutoff = this.now();
    const entries = journal.recoverable(channelId, key, 1024, retryBlocked, cutoff);
    this.scheduleStored(adapter, adapter.type === "slack" ? entries.filter(entry =>
      journal.continuationOperation(entry.delivery_id) && journal.outbox(entry.delivery_id)) : entries);
    const next = journal.nextRetryAt(channelId, key, cutoff);
    if (next !== undefined) this.scheduleResume(channelId, Math.max(1, next - this.now()));
  }

  private scheduleStored(adapter: RegisteredGatewayAdapter, entries: GatewayInboxEntry[]): void {
    for (const entry of entries) {
      if (this.activeDeliveries.has(entry.delivery_id)) continue;
      if (this.pending >= 1024) break;
      if ((this.depths.get(entry.session_key) ?? 0) >= 64) continue;
      try { void this.dispatchStored(adapter, entry).catch(() => {}); }
      catch { this.report(adapter.id, "Gateway 恢复暂时不可用，已保留待处理记录"); }
    }
  }

  private scheduleOfflineRecovery(channelId: string, counts: Record<string, number>): void {
    if (!counts.pending && !counts.reply_pending) return;
    const attempts = this.offlineChecks.get(channelId) ?? 0;
    this.offlineChecks.set(channelId, Math.min(attempts + 1, 4));
    this.scheduleResume(channelId, [1_000, 2_000, 5_000, 10_000, 30_000][Math.min(attempts, 4)]);
  }

  /** User disconnect pauses only this channel; queued data remains durable. */
  pause(channelId: string): void {
    this.pausedChannels.add(channelId);
    this.channelEpochs.set(channelId, (this.channelEpochs.get(channelId) ?? 0) + 1);
    const recovery = this.recoveryTimers.get(channelId);
    if (recovery) clearTimeout(recovery.timer);
    this.recoveryTimers.delete(channelId);
    this.offlineChecks.delete(channelId);
    for (const [id, reply] of this.liveReplies) if (reply.channelId === channelId) this.liveReplies.delete(id);
  }

  suspend(): void {
    this.suspended = true;
    this.epoch++;
    for (const { timer } of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    this.offlineChecks.clear();
    this.liveReplies.clear();
  }

  deliveryStatus(channelId: string): Record<string, number> {
    return (this.options.journal?.usesCoreAdmission ? this.coreDeliveryCounts.get(channelId) : this.options.journal?.counts(channelId)) ?? {};
  }

  private scheduleResume(channelId: string, delay: number): void {
    if (this.suspended || this.pausedChannels.has(channelId)) return;
    if (this.options.coreControlled && this.options.onScheduleRecover) {
      this.options.onScheduleRecover(channelId, delay);
      return;
    }
    const at = this.now() + delay;
    const old = this.recoveryTimers.get(channelId);
    if (old && old.at <= at) return;
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(channelId);
      if (!this.suspended && !this.pausedChannels.has(channelId)) {
        try { this.startRecovery(channelId, false); }
        catch { this.report(channelId, "Gateway 恢复暂时不可用，未删除待处理记录"); }
      }
    }, delay);
    timer.unref?.();
    this.recoveryTimers.set(channelId, { at, timer });
  }

  private report(channelId: string, text: string): void {
    try { this.options.onStatus?.(channelId, text); } catch { /* Diagnostics cannot change an ACK or a saved receipt. */ }
  }

  private isAuthorized(message: GatewayInboundMessage): boolean {
    try { return this.options.authorize?.(message) !== false; } catch { return false; }
  }

  private normalize(adapter: RegisteredGatewayAdapter, message: GatewayInboundMessage): GatewayMessageEvent {
    const accountKey = adapter.workConnectionKey?.();
    if (message.channelId !== adapter.id || this.entries.get(adapter.id) !== adapter
      || !adapter.isConnected() || !accountKey || !/^[a-f0-9]{64}$/.test(accountKey)) {
      throw new Error("Gateway 入站渠道或连接身份无效，未执行");
    }
    if (typeof message.chatId !== "string" || !message.chatId.trim() || typeof message.text !== "string"
      || typeof message.reply !== "function") throw new Error("Gateway 入站消息无效，未执行");
    if (message.replyRoute && (!gatewayReplyRouteSchema.safeParse(message.replyRoute).success || message.replyRoute.kind !== adapter.type)) {
      throw new Error("Gateway 回复地址与来源不一致，未执行");
    }
    const target = message.workTarget;
    if (target && (!gatewayWorkTargetSchema.safeParse(target).success || target.channelId !== adapter.id
      || target.channelType !== adapter.type || target.connectionKey !== accountKey
      || target.chatId !== message.chatId || target.senderId !== message.sender?.id)) {
      throw new Error("Gateway 入站通知地址与来源不一致，未执行");
    }
    const threadId = target?.channelType === "feishu" ? target.address.threadId
      : target?.channelType === "slack" ? target.address.threadTs
      : target?.channelType === "telegram" && target.address.messageThreadId !== undefined
        ? String(target.address.messageThreadId) : undefined;
    const reply = message.reply;
    const generation = adapter.gatewayConnectionGeneration?.();
    const epoch = this.epoch;
    const channelEpoch = this.channelEpochs.get(adapter.id);
    const boundMessage = { ...message, reply: async (text: string) => {
      if (this.suspended || this.pausedChannels.has(adapter.id) || epoch !== this.epoch || channelEpoch !== this.channelEpochs.get(adapter.id)
        || !adapter.isConnected() || adapter.workConnectionKey?.() !== accountKey
        || adapter.gatewayConnectionGeneration?.() !== generation) {
        throw new GatewayReplyNotSentError("Gateway 回复连接账号已改变，未发送");
      }
      await reply(text);
    } };
    return Object.freeze({ version: 1, platform: adapter.type,
      source: Object.freeze({ channelId: adapter.id, accountKey, chatId: message.chatId, ...(threadId ? { threadId } : {}) }),
      ...(message.sender ? { sender: Object.freeze({ ...message.sender }) } : {}),
      messageId: message.messageId, text: message.text, receivedAt: Date.now(),
      capabilities: gatewayCapabilities(adapter), message: boundMessage });
  }
}
