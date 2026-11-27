import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { GatewayChannelType } from "../../shared/agent-ipc";
import { ensureGatewayDeliveryTables } from "../db/gateway-delivery-schema";
import { getGatewayDir } from "../paths";
import type { GatewayInboundMessage } from "./channels";
import { GATEWAY_MEDIA_LIMITS } from "./GatewayMedia";
import { gatewayReplyRouteSchema, type GatewayReplyRoute } from "./GatewayReply";
import { gatewayWorkTargetSchema, type GatewayWorkTarget } from "./work-outbound";
import type { GatewayBotOrigin } from "../agent/work/BotTurnOrigins";
import { RuntimeAuditUnknownOperationError, type RuntimeAuditReader, type RuntimeGatewayDeliveryCommand,
  type RuntimeGatewayDeliveryReply, type RuntimeGatewayExecutionOutcome, type RuntimeGatewayRecovery, type RuntimeGatewayRecoveryQuery,
  type RuntimeGatewayReplyOutcome } from "../platform/runtime-audit";

type InboxStatus = "pending" | "running" | "reply_pending" | "completed" | "blocked" | "unknown";
type OutboxStatus = "pending" | "sending" | "sent" | "blocked" | "failed" | "unknown";
interface StoredAttachment { name: string; path: string; size: number; sha256: string }
export interface GatewayStoredPayload {
  version: 1;
  channelId: string;
  chatId: string;
  messageId: string;
  text: string;
  sender?: { id: string; name?: string };
  audience?: "private" | "shared";
  attachments?: StoredAttachment[];
  workTarget?: GatewayWorkTarget;
  replyRoute?: GatewayReplyRoute;
}
export interface GatewayInboxEntry {
  delivery_id: string;
  platform: GatewayChannelType;
  channel_id: string;
  account_key: string;
  chat_id: string;
  session_key: string;
  message_id: string;
  payload_json: string;
  payload_hash: string;
  status: InboxStatus;
  retry_count: number;
  receipt_mode: "pi-durable" | "none";
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
export interface GatewayOutboxEntry {
  delivery_id: string;
  reply_text: string;
  reply_hash: string;
  status: OutboxStatus;
  retry_count: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}
export interface GatewayDeliveryJournalOptions {
  now?: () => number;
  mediaDirectory?: string;
  maxPending?: number;
  maxReceipts?: number;
  retentionMs?: number;
  native?: GatewayDeliveryCore;
}
type GatewayAdmissionInput = { platform: GatewayChannelType; accountKey: string; sessionKey: string; message: GatewayInboundMessage;
  replayNativeReceipts: boolean; reserveConversation?(messageId: string, acceptedAt: number): void };
type GatewayDeliveryCore = Pick<RuntimeAuditReader, "batch4aWrite" | "supervised" | "gatewayDeliveryControl" | "readGatewayOutbox"
  | "readGatewayInbox" | "readGatewayAssignment" | "admitGatewayInbound" | "readGatewayRecovery" | "readGatewayContinuation">;
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const nonempty = (value: unknown, limit = 2048): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= limit;

/** Transport inbox and outbox. Accepted inputs retain their original message identity. */
export class GatewayDeliveryJournal {
  private readonly now: () => number;
  private readonly mediaDirectory: string;
  private readonly maxPending: number;
  private readonly maxReceipts: number;
  private readonly retentionMs: number;
  private readonly native?: GatewayDeliveryCore;
  private initialRecovery?: Promise<void>;
  private writeTail = Promise.resolve();
  private pendingWriteCount = 0;
  private readonly pendingInbox = new Map<string, GatewayInboxEntry>();
  private readonly pendingOutbox = new Map<string, GatewayOutboxEntry>();
  private readonly pendingContinuations = new Map<string, string>();

  constructor(private readonly fixture: Database.Database | undefined, options: GatewayDeliveryJournalOptions = {}) {
    this.now = options.now ?? Date.now;
    this.mediaDirectory = resolve(options.mediaDirectory ?? join(getGatewayDir(), "media"));
    this.maxPending = options.maxPending ?? 10_000;
    this.maxReceipts = options.maxReceipts ?? 100_000;
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60_000;
    this.native = options.native;
    if (![this.maxPending, this.maxReceipts, this.retentionMs].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Gateway 持久队列限制无效");
    }
    if (!fixture && !this.native?.supervised) throw new Error("Core Gateway 持久队列未就绪");
    if (fixture && !this.requiresRustWrites) {
      ensureGatewayDeliveryTables(fixture);
      fixture.exec("CREATE TABLE IF NOT EXISTS bot_gateway_continuations(delivery_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE)");
    }
  }

  private get db(): Database.Database {
    if (!this.fixture) throw new Error("Gateway 当前操作仍需迁移到 Core");
    return this.fixture;
  }

  private get requiresRustWrites(): boolean {
    return this.fixture?.readonly === true || this.native?.supervised === true;
  }

  get usesCoreAdmission(): boolean { return this.requiresRustWrites; }

  flush(): Promise<void> {
    return this.writeTail;
  }

  private async control(id: string, command: RuntimeGatewayDeliveryCommand): Promise<RuntimeGatewayDeliveryReply> {
    const core = this.native;
    if (!core) throw new Error("Core Gateway 持久队列未就绪");
    await this.flush();
    const operationId = randomUUID();
    const apply = () => core.gatewayDeliveryControl(id, operationId, command);
    const result = await apply().catch(error => {
      if (error instanceof RuntimeAuditUnknownOperationError) return apply();
      throw error;
    });
    if (!result) throw new Error("Core 未确认 Gateway 持久操作");
    return result;
  }

  async readOutbox(id: string): Promise<GatewayOutboxEntry | undefined> {
    if (!this.requiresRustWrites) return this.outbox(id);
    await this.flush();
    const row = await this.native?.readGatewayOutbox(id);
    if (row === undefined) throw new Error("Core 未确认 Gateway 回复读取");
    return row ?? undefined;
  }

  async readRecovery(query: RuntimeGatewayRecoveryQuery): Promise<RuntimeGatewayRecovery> {
    if (!this.usesCoreAdmission) throw new Error("Gateway 恢复需要 Core 队列");
    this.initialRecovery ??= Promise.resolve().then(async () => {
      const confirmation = await this.native?.batch4aWrite<{ ok: boolean }>({
        kind: "gatewayDeliveryOp", op: "recoverInterrupted", now: this.now(),
      });
      if (confirmation?.ok !== true) throw new Error("Core 未确认 Gateway 中断状态恢复");
    }).catch(error => {
      this.initialRecovery = undefined;
      throw error;
    });
    await this.initialRecovery;
    const result = await this.native?.readGatewayRecovery(query);
    if (result?.kind !== "recovery") throw new Error("Core 未确认 Gateway 待处理队列");
    return result;
  }

  async readContinuationOperation(id: string): Promise<string | undefined> {
    if (!this.usesCoreAdmission) return this.continuationOperation(id);
    await this.flush();
    const result = await this.native?.readGatewayContinuation(id);
    if (result?.kind !== "continuation") throw new Error("Core 未确认 Gateway 续回读取");
    return result.operationId ?? undefined;
  }

  async assignmentCurrent(entry: GatewayInboxEntry, senderId?: string): Promise<boolean> {
    if (!this.usesCoreAdmission) return true;
    if (!senderId) return false;
    const assignment = await this.native?.readGatewayAssignment({ channelId: entry.channel_id, connectionKey: entry.account_key,
      chatId: entry.chat_id, senderId, messageId: entry.message_id });
    return assignment?.status === "assigned";
  }

  async rejectUnclaimed(id: string, reason: string): Promise<void> {
    if (this.requiresRustWrites) {
      await this.flush();
      const reply = await this.native?.batch4aWrite<{ ok: boolean }>({
        kind: "gatewayDeliveryOp", op: "blockUnclaimed", deliveryId: id, reason, now: this.now(),
      });
      if (reply?.ok !== true) throw new Error("Core 未确认 Gateway 入站校验状态");
      return;
    }
    this.db.prepare(`UPDATE gateway_inbox SET status='blocked',last_error=?,updated_at=?
      WHERE delivery_id=? AND status IN ('pending','blocked','reply_pending')
        AND NOT EXISTS (SELECT 1 FROM gateway_outbox WHERE delivery_id=gateway_inbox.delivery_id AND status NOT IN ('pending','blocked'))`)
      .run(reason, this.now(), id);
  }

  async claimExecution(id: string): Promise<number | undefined> {
    if (this.requiresRustWrites) {
      const reply = await this.control(id, { action: "claimExecution" });
      return reply.status === "claimed" ? reply.attempt : undefined;
    }
    return this.db.transaction(() => {
      const entry = this.get(id);
      if (!entry || !["pending", "blocked"].includes(entry.status) || this.outbox(id)) return undefined;
      return this.begin(id).retry_count + 1;
    }).immediate();
  }

  async queueOwnedReply(id: string, attempt: number, text: string): Promise<void> {
    if (this.requiresRustWrites) {
      const reply = await this.control(id, { action: "queueReply", attempt, text });
      if (reply.status !== "applied") throw new Error("Gateway 回复未保存，执行认领或正文已改变");
      return;
    }
    this.db.transaction(() => {
      const current = this.get(id);
      if (current?.retry_count !== attempt || (current.status !== "running" && !this.outbox(id))) {
        throw new Error("Gateway 执行认领已改变，未覆盖回复");
      }
      this.queueReply(id, text);
    }).immediate();
  }

  async finishOwnedExecution(id: string, attempt: number, outcome: RuntimeGatewayExecutionOutcome): Promise<void> {
    if (this.requiresRustWrites) {
      await this.control(id, { action: "finishExecution", attempt, outcome });
      return;
    }
    this.db.transaction(() => {
      const current = this.get(id);
      if (current?.retry_count !== attempt || current.status !== "running") return;
      if (outcome === "completed") this.complete(id);
      else if (outcome === "interrupted") this.defer(id);
      else this.block(id, "execution_failed", current.receipt_mode === "pi-durable" ? "blocked" : "unknown");
    }).immediate();
  }

  async claimReply(id: string, maxAttempts: number): Promise<RuntimeGatewayDeliveryReply> {
    if (this.requiresRustWrites) return this.control(id, { action: "claimReply", maxAttempts });
    return this.db.transaction((): RuntimeGatewayDeliveryReply => {
      const row = this.outbox(id);
      if (row?.status === "sent") return { status: "sent" };
      if (!row || !["pending", "blocked"].includes(row.status)) return { status: "unavailable" };
      if (row.next_attempt_at > this.now()) return { status: "waiting", nextAttemptAt: row.next_attempt_at };
      if (digest(row.reply_text) !== row.reply_hash) {
        this.sendFailed(id, { status: "failed", reason: "reply_integrity_invalid" });
        return { status: "integrity" };
      }
      if (row.retry_count >= maxAttempts) {
        this.sendFailed(id, { status: "failed", reason: "retry_exhausted" });
        return { status: "exhausted" };
      }
      return { status: "sending", entry: this.beginSend(id) };
    }).immediate();
  }

  async finishOwnedReply(id: string, attempt: number, outcome: RuntimeGatewayReplyOutcome, reason?: string, nextAttemptAt?: number): Promise<boolean> {
    if (this.requiresRustWrites) {
      const reply = await this.control(id, { action: "finishReply", attempt, outcome, reason, nextAttemptAt });
      return reply.status === "applied";
    }
    return this.db.transaction(() => {
      const current = this.outbox(id);
      if (current?.retry_count !== attempt || current.status !== "sending") return false;
      if (outcome === "sent") this.sent(id);
      else this.sendFailed(id, { status: outcome, reason: reason ?? "", nextAttemptAt });
      return true;
    }).immediate();
  }

  private enqueueOp(request: Record<string, unknown>, label: string): void {
    const batch4a = this.native?.batch4aWrite;
    if (!batch4a) throw new Error(`只读模式下缺少 Gateway 持久队列 Rust 写入通道: ${label}`);
    this.pendingWriteCount += 1;
    this.writeTail = this.writeTail.then(() => batch4a.call(this.native, { kind: "gatewayDeliveryOp", ...request })).then(() => undefined, error => {
      console.warn(`[GatewayDeliveryJournal] ${label} failed`, error);
    }).finally(() => {
      this.pendingWriteCount -= 1;
      if (this.pendingWriteCount === 0) {
        this.pendingInbox.clear();
        this.pendingOutbox.clear();
        this.pendingContinuations.clear();
      }
    });
  }

  private attachment(file: { name: string; path: string }): StoredAttachment {
    if (!nonempty(file.name, 180) || /[\\/\x00-\x1f\x7f]/.test(file.name) || !isAbsolute(file.path)
      || dirname(resolve(file.path)) !== this.mediaDirectory || !/^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(basename(file.path))) {
      throw new Error("Gateway 附件缓存路径无效，未恢复任务");
    }
    if (lstatSync(this.mediaDirectory).isSymbolicLink() || lstatSync(file.path).isSymbolicLink()) {
      throw new Error("Gateway 附件缓存不能是符号链接");
    }
    const fd = openSync(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !stat.size || stat.size > GATEWAY_MEDIA_LIMITS.file) throw new Error("Gateway 附件缓存大小无效");
      const bytes = readFileSync(fd);
      const sha256 = digest(bytes);
      if (bytes.length !== stat.size || basename(file.path).split(".")[0] !== sha256) throw new Error("Gateway 附件缓存校验失败");
      return { name: file.name, path: file.path, size: stat.size, sha256 };
    } finally { closeSync(fd); }
  }

  private payload(message: GatewayInboundMessage, messageId: string): GatewayStoredPayload {
    if (!nonempty(message.channelId) || !nonempty(message.chatId) || !nonempty(messageId)
      || typeof message.text !== "string" || message.text.length > 64_000
      || (message.audience !== undefined && message.audience !== "private" && message.audience !== "shared")
      || (message.sender && (!nonempty(message.sender.id) || (message.sender.name !== undefined && (typeof message.sender.name !== "string" || message.sender.name.length > 2048))))) {
      throw new Error("Gateway 持久消息内容无效或过长");
    }
    if (message.attachments && (!Array.isArray(message.attachments) || message.attachments.length > GATEWAY_MEDIA_LIMITS.count)) {
      throw new Error("Gateway 持久附件数量无效");
    }
    const attachments = message.attachments?.map(file => this.attachment(file));
    if (attachments && attachments.reduce((sum, file) => sum + file.size, 0) > GATEWAY_MEDIA_LIMITS.batch) throw new Error("Gateway 持久附件总大小超过限制");
    const payload: GatewayStoredPayload = { version: 1, channelId: message.channelId, chatId: message.chatId, messageId, text: message.text,
      ...(message.audience ? { audience: message.audience } : {}),
      ...(message.sender ? { sender: { id: message.sender.id, ...(message.sender.name ? { name: message.sender.name } : {}) } } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(message.workTarget ? { workTarget: gatewayWorkTargetSchema.parse(message.workTarget) } : {}),
      ...(message.replyRoute ? { replyRoute: gatewayReplyRouteSchema.parse(message.replyRoute) } : {}) };
    if (Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024) throw new Error("Gateway 持久消息超过大小限制");
    return payload;
  }

  async admit(input: GatewayAdmissionInput): Promise<{ entry: GatewayInboxEntry; duplicate: boolean }> {
    const core = this.native;
    if (!core || !this.usesCoreAdmission) throw new Error("Core Gateway 收件尚未就绪");
    if (!/^[a-f0-9]{64}$/.test(input.accountKey)) throw new Error("Gateway 持久消息缺少账号身份");
    const messageId = input.message.messageId || `local:${randomUUID()}`;
    const id = digest(JSON.stringify(["gateway-delivery-v1", input.platform, input.message.channelId, input.accountKey, input.message.chatId, messageId]));
    const previous = await core.readGatewayInbox(id);
    if (previous === undefined) throw new Error("Core 未确认 Gateway 收件查询");
    let payload: GatewayStoredPayload;
    if (previous) {
      const stored = this.decode(previous, false);
      if (stored.text !== input.message.text || stored.sender?.id !== input.message.sender?.id) {
        throw new Error("Gateway 重投消息内容与已接收记录不一致");
      }
      // Reuse content-addressed attachments only for a known delivery. The current route is still checked for private consent.
      payload = { ...stored, audience: input.message.audience, replyRoute: input.message.replyRoute };
    } else {
      payload = this.payload(input.message, messageId);
    }
    const draft = { platform: input.platform, accountKey: input.accountKey, sessionKey: input.sessionKey,
      payloadJson: JSON.stringify(payload), replayNativeReceipts: input.replayNativeReceipts,
      maxPending: this.maxPending, maxReceipts: this.maxReceipts, retentionMs: this.retentionMs };
    const commit = () => core.admitGatewayInbound(draft);
    const reply = await commit().catch(error => {
      if (error instanceof RuntimeAuditUnknownOperationError) return commit();
      throw error;
    });
    if (reply?.status === "accepted") return reply;
    if (reply?.code === "PAYLOAD_CONFLICT") throw new Error("Gateway 重投消息内容与已接收记录不一致");
    if (reply?.code === "CAPACITY") throw new Error("Gateway 持久收件箱已满，消息尚未确认接收");
    if (reply?.code === "AUTHORIZATION_CHANGED") throw new Error("Gateway 收件授权已变化，消息尚未确认接收");
    throw new Error("Core 未确认 Gateway 收件，消息尚未确认接收");
  }

  accept(input: GatewayAdmissionInput): { entry: GatewayInboxEntry; duplicate: boolean } {
    if (this.usesCoreAdmission) throw new Error("Core Gateway 收件必须等待提交回执");
    if (!/^[a-f0-9]{64}$/.test(input.accountKey)) throw new Error("Gateway 持久消息缺少账号身份");
    const messageId = input.message.messageId || `local:${randomUUID()}`;
    const id = digest(JSON.stringify(["gateway-delivery-v1", input.platform, input.message.channelId, input.accountKey, input.message.chatId, messageId]));
    // A provider retry may no longer have its original media. Existing payloads
    // are authoritative and are never replaced with new text/files/credentials.
    const previous = this.get(id);
    if (previous) {
      const stored = this.decode(previous, false);
      if (stored.text !== input.message.text || stored.sender?.id !== input.message.sender?.id) throw new Error("Gateway 重投消息内容与已接收记录不一致");
      return { entry: previous, duplicate: true };
    }
    const payload = this.payload(input.message, messageId);
    const json = JSON.stringify(payload);
    const now = this.now();
    return this.db.transaction(() => {
      this.prune();
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM gateway_inbox WHERE status!='completed'").get() as { count: number };
      if (pending.count >= this.maxPending) throw new Error("Gateway 持久收件箱已满，消息尚未确认接收");
      this.db.prepare(`INSERT INTO gateway_inbox (delivery_id,platform,channel_id,account_key,chat_id,session_key,message_id,
        payload_json,payload_hash,status,retry_count,receipt_mode,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',0,?,?,?)`).run(id, input.platform, payload.channelId, input.accountKey, payload.chatId,
        input.sessionKey, messageId, json, digest(json), input.replayNativeReceipts ? "pi-durable" : "none", now, now);
      input.reserveConversation?.(messageId, now);
      return { entry: this.get(id)!, duplicate: false };
    })();
  }

  get(id: string): GatewayInboxEntry | undefined {
    return this.pendingInbox.get(id) ?? (this.db.prepare("SELECT * FROM gateway_inbox WHERE delivery_id=?").get(id) as GatewayInboxEntry | undefined);
  }
  /** Response-only continuation. Its outbox commits atomically, so recovery can
   * never treat it as another human input or re-run the original model turn. */
  continueReply(origin: GatewayBotOrigin, operationId: string, text: string): GatewayInboxEntry {
    let saved: GatewayInboxEntry | undefined;
    for (const pending of this.pendingInbox.values()) {
      if (pending.channel_id === origin.channelId && pending.account_key === origin.connectionKey
        && pending.chat_id === origin.chatId && pending.message_id === origin.messageId) {
        saved = pending;
        break;
      }
    }
    saved ??= this.db.prepare(`SELECT * FROM gateway_inbox WHERE channel_id=? AND account_key=? AND chat_id=? AND message_id=?`)
      .get(origin.channelId, origin.connectionKey, origin.chatId, origin.messageId) as GatewayInboxEntry | undefined;
    const target = origin.workTarget ? gatewayWorkTargetSchema.parse(origin.workTarget) : undefined;
    const slack = target?.channelType === "slack" ? target : undefined;
    if (slack && (slack.channelId !== origin.channelId || slack.connectionKey !== origin.connectionKey || slack.chatId !== origin.chatId
      || slack.senderId !== origin.senderId || origin.audience !== "private" || !slack.address.channel.startsWith("D")))
      throw new Error("协作回传来源不是原私人发送者");
    // Slack's original input belongs to its existing Slack journal. This is an
    // outbox-only reply addressed by that input's persisted, authenticated target.
    const original: Pick<GatewayInboxEntry, "delivery_id" | "platform" | "channel_id" | "account_key" | "chat_id" | "session_key"> | undefined = saved ?? (slack ? {
      delivery_id: digest(JSON.stringify(["slack-bot-source", origin.channelId, origin.connectionKey, origin.chatId, origin.senderId, origin.messageId])),
      platform: "slack", channel_id: origin.channelId,
      account_key: origin.connectionKey, chat_id: origin.chatId, session_key: JSON.stringify([origin.channelId, origin.connectionKey, origin.chatId]),
    } : undefined);
    if (!original) throw new Error("原渠道持久回执不可用，协作成果保留，不改投其他会话");
    const payload: GatewayStoredPayload = saved ? this.decode(saved, false) : { version: 1, channelId: origin.channelId,
      chatId: origin.chatId, messageId: origin.messageId, sender: { id: origin.senderId }, audience: "private", text: "", workTarget: slack };
    if (payload.sender?.id !== origin.senderId || payload.audience === "shared") throw new Error("协作回传来源不是原私人发送者");
    const id = digest(JSON.stringify(["bot-continuation", original.delivery_id, operationId]));
    if (this.requiresRustWrites) {
      const previous = this.get(id);
      if (previous) {
        const outbox = this.outbox(id);
        if (!outbox || outbox.reply_text !== text) throw new Error("idempotency_conflict: 协作渠道回传正文已固定");
        return previous;
      }
      if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 512 * 1024) throw new Error("Gateway 回复为空或超过持久大小限制");
      const messageId = `bot-reply:${id}`, now = this.now();
      const json = JSON.stringify({ ...payload, messageId, text: "", attachments: undefined });
      const payloadHash = digest(json);
      const replyHash = digest(text);
      const entry: GatewayInboxEntry = {
        delivery_id: id,
        platform: original.platform,
        channel_id: original.channel_id,
        account_key: original.account_key,
        chat_id: original.chat_id,
        session_key: original.session_key,
        message_id: messageId,
        payload_json: json,
        payload_hash: payloadHash,
        status: "reply_pending",
        retry_count: 0,
        receipt_mode: "none",
        last_error: null,
        created_at: now,
        updated_at: now,
      };
      this.pendingInbox.set(id, entry);
      this.pendingOutbox.set(id, {
        delivery_id: id,
        reply_text: text,
        reply_hash: replyHash,
        status: "pending",
        retry_count: 0,
        next_attempt_at: 0,
        last_error: null,
        created_at: now,
        updated_at: now,
        sent_at: null,
      });
      this.pendingContinuations.set(id, operationId);
      this.enqueueOp({
        op: "continueReply",
        deliveryId: id,
        platform: original.platform,
        channelId: original.channel_id,
        accountKey: original.account_key,
        chatId: original.chat_id,
        sessionKey: original.session_key,
        messageId,
        payloadJson: json,
        payloadHash,
        replyText: text,
        replyHash,
        operationId,
        now,
      }, "continueReply");
      return entry;
    }
    return this.db.transaction(() => {
      const previous = this.get(id);
      if (previous) {
        const outbox = this.outbox(id);
        if (!outbox || outbox.reply_text !== text) throw new Error("idempotency_conflict: 协作渠道回传正文已固定");
        return previous;
      }
      const messageId = `bot-reply:${id}`, now = this.now();
      const json = JSON.stringify({ ...payload, messageId, text: "", attachments: undefined });
      this.db.prepare(`INSERT INTO gateway_inbox(delivery_id,platform,channel_id,account_key,chat_id,session_key,message_id,
        payload_json,payload_hash,status,retry_count,receipt_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'reply_pending',0,'none',?,?)`)
        .run(id, original.platform, original.channel_id, original.account_key, original.chat_id, original.session_key,
          messageId, json, digest(json), now, now);
      this.queueReply(id, text);
      this.db.prepare("INSERT OR IGNORE INTO bot_gateway_continuations VALUES(?,?)").run(id, operationId);
      return this.get(id)!;
    })();
  }
  continuationOperation(deliveryId: string): string | undefined {
    const pending = this.pendingContinuations.get(deliveryId);
    if (pending !== undefined) return pending;
    const row = this.db.prepare("SELECT operation_id FROM bot_gateway_continuations WHERE delivery_id=?").get(deliveryId) as { operation_id: string } | undefined;
    return row?.operation_id;
  }
  outbox(id: string): GatewayOutboxEntry | undefined {
    return this.pendingOutbox.get(id) ?? (this.db.prepare("SELECT * FROM gateway_outbox WHERE delivery_id=?").get(id) as GatewayOutboxEntry | undefined);
  }

  decode(entry: GatewayInboxEntry, verifyAttachments = true): GatewayStoredPayload {
    if (digest(entry.payload_json) !== entry.payload_hash) throw new Error("Gateway 持久消息摘要校验失败");
    const value = JSON.parse(entry.payload_json) as GatewayStoredPayload;
    if (!value || value.version !== 1 || value.channelId !== entry.channel_id || value.chatId !== entry.chat_id
      || value.messageId !== entry.message_id || !nonempty(value.messageId) || typeof value.text !== "string" || value.text.length > 64_000
      || (value.audience !== undefined && value.audience !== "private" && value.audience !== "shared")
      || (value.sender && (!nonempty(value.sender.id) || (value.sender.name !== undefined && !nonempty(value.sender.name))))) {
      throw new Error("Gateway 持久消息格式无效");
    }
    if (value.replyRoute) gatewayReplyRouteSchema.parse(value.replyRoute);
    if (value.workTarget) gatewayWorkTargetSchema.parse(value.workTarget);
    if (value.attachments !== undefined) {
      if (!Array.isArray(value.attachments) || value.attachments.length > GATEWAY_MEDIA_LIMITS.count) throw new Error("Gateway 持久附件格式无效");
      let total = 0;
      for (const file of value.attachments) {
        if (!file || typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
          || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > GATEWAY_MEDIA_LIMITS.file) throw new Error("Gateway 持久附件校验信息无效");
        total += file.size;
        if (verifyAttachments) {
          const actual = this.attachment(file);
          if (actual.sha256 !== file.sha256 || actual.size !== file.size) throw new Error("Gateway 持久附件已被修改，未恢复任务");
        }
      }
      if (total > GATEWAY_MEDIA_LIMITS.batch) throw new Error("Gateway 持久附件总大小超过限制");
    }
    return value;
  }

  /** Must run once when constructing the owner, not on each reconnect. A send
   * interrupted after I/O is ambiguous; native receipt replay and send replay
   * deliberately have different rules. */
  recoverInterrupted(): void {
    if (this.requiresRustWrites) return; // readRecovery awaits the Core reconciliation before exposing work.
    this.db.transaction(() => {
      const now = this.now();
      this.db.prepare("UPDATE gateway_outbox SET status='unknown',last_error='send_interrupted',updated_at=? WHERE status='sending'").run(now);
      this.db.prepare(`UPDATE gateway_inbox SET status='unknown',last_error='send_interrupted',updated_at=?
        WHERE delivery_id IN (SELECT delivery_id FROM gateway_outbox WHERE status='unknown')`).run(now);
      this.db.prepare(`UPDATE gateway_inbox SET status='pending',last_error='native_receipt_recovery',updated_at=?
        WHERE status='running' AND receipt_mode='pi-durable' AND delivery_id NOT IN (SELECT delivery_id FROM gateway_outbox)`).run(now);
      this.db.prepare(`UPDATE gateway_inbox SET status='unknown',last_error='native_recovery_unavailable',updated_at=? WHERE status='running'`).run(now);
    })();
  }

  recoverable(channelId: string, accountKey: string, limit = 1024, retryBlocked = false, cutoff = this.now()): GatewayInboxEntry[] {
    const dbRows = this.db.prepare(`SELECT i.* FROM gateway_inbox i LEFT JOIN gateway_outbox o ON o.delivery_id=i.delivery_id
      WHERE i.channel_id=? AND i.account_key=? AND i.status IN ('pending','reply_pending')
      AND (o.delivery_id IS NULL OR (o.status='pending' AND o.next_attempt_at<=?) OR (o.status='blocked' AND ?=1))
      ORDER BY i.created_at,i.rowid LIMIT ?`).all(channelId, accountKey, cutoff, retryBlocked ? 1 : 0, limit) as GatewayInboxEntry[];
    if (!this.pendingInbox.size && !this.pendingOutbox.size) return dbRows;
    const byId = new Map<string, GatewayInboxEntry>(dbRows.map(row => [row.delivery_id, row]));
    for (const [id, pending] of this.pendingInbox) {
      if (pending.channel_id !== channelId || pending.account_key !== accountKey) continue;
      const out = this.outbox(id);
      const isRecoverable = (pending.status === "pending" || pending.status === "reply_pending")
        && (!out || (out.status === "pending" && out.next_attempt_at <= cutoff) || (out.status === "blocked" && retryBlocked));
      if (isRecoverable) byId.set(id, pending);
      else byId.delete(id);
    }
    return [...byId.values()].sort((a, b) => a.created_at - b.created_at).slice(0, limit);
  }

  begin(id: string): GatewayInboxEntry {
    if (this.requiresRustWrites) throw new Error("Core Gateway 执行必须等待认领回执");
    const entry = this.get(id);
    if (!entry || !["pending", "blocked"].includes(entry.status) || this.outbox(id)) throw new Error("Gateway 消息不可重复执行");
    if (entry.retry_count > 0 && entry.receipt_mode !== "pi-durable") {
      this.block(id, "native_recovery_unavailable", "unknown");
      throw new Error("Gateway 缺少原生幂等回执，未重复执行");
    }
    const now = this.now();
    this.db.prepare("UPDATE gateway_inbox SET status='running',retry_count=retry_count+1,last_error=NULL,updated_at=? WHERE delivery_id=?").run(now, id);
    return entry;
  }

  complete(id: string): void {
    if (this.requiresRustWrites) throw new Error("Core Gateway 结算需要已认领的执行代次");
    const outbox = this.outbox(id);
    if (outbox && outbox.status !== "sent") return;
    const now = this.now();
    this.db.prepare("UPDATE gateway_inbox SET status='completed',last_error=NULL,updated_at=? WHERE delivery_id=?").run(now, id);
  }

  private block(id: string, reason: string, status: "blocked" | "unknown"): void {
    const now = this.now();
    this.db.prepare("UPDATE gateway_inbox SET status=?,last_error=?,updated_at=? WHERE delivery_id=? AND status!='completed'").run(status, reason, now, id);
  }

  private defer(id: string): void {
    const now = this.now();
    this.db.prepare(`UPDATE gateway_inbox SET status=CASE WHEN receipt_mode='pi-durable' OR retry_count=0 THEN 'pending' ELSE 'unknown' END,
      last_error='connection_interrupted',updated_at=? WHERE delivery_id=? AND status NOT IN ('completed','unknown')
      AND delivery_id NOT IN (SELECT delivery_id FROM gateway_outbox)`).run(now, id);
  }

  queueReply(id: string, text: string): GatewayOutboxEntry {
    if (this.requiresRustWrites) throw new Error("Core Gateway 回复需要已认领的执行代次");
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 512 * 1024) throw new Error("Gateway 回复为空或超过持久大小限制");
    const hash = digest(text);
    const old = this.outbox(id);
    if (old) {
      if (old.reply_hash !== hash) throw new Error("Gateway 回复与已保存结果不一致，未覆盖");
      return old;
    }
    return this.db.transaction(() => {
      const now = this.now();
      this.db.prepare(`INSERT INTO gateway_outbox (delivery_id,reply_text,reply_hash,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)`).run(id, text, hash, now, now);
      this.db.prepare("UPDATE gateway_inbox SET status='reply_pending',last_error=NULL,updated_at=? WHERE delivery_id=?").run(now, id);
      return this.outbox(id)!;
    })();
  }

  beginSend(id: string): GatewayOutboxEntry {
    if (this.requiresRustWrites) throw new Error("Core Gateway 回复必须等待发送认领回执");
    const old = this.outbox(id);
    if (!old || !["pending", "blocked"].includes(old.status) || digest(old.reply_text) !== old.reply_hash) throw new Error("Gateway 回复不可重发或校验失败");
    const now = this.now();
    this.db.prepare("UPDATE gateway_outbox SET status='sending',retry_count=retry_count+1,last_error=NULL,updated_at=? WHERE delivery_id=?").run(now, id);
    return this.outbox(id)!;
  }

  private sent(id: string): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE gateway_outbox SET status='sent',last_error=NULL,sent_at=?,updated_at=? WHERE delivery_id=? AND status='sending'").run(now, now, id);
      this.complete(id);
    })();
  }

  sendFailed(id: string, input: { status: "pending" | "blocked" | "unknown" | "failed"; reason: string; nextAttemptAt?: number }): void {
    if (this.requiresRustWrites) throw new Error("Core Gateway 发送结算需要已认领的发送代次");
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE gateway_outbox SET status=?,last_error=?,next_attempt_at=?,updated_at=? WHERE delivery_id=? AND status!='sent'")
        .run(input.status, input.reason, input.nextAttemptAt ?? 0, now, id);
      this.db.prepare("UPDATE gateway_inbox SET status=?,last_error=?,updated_at=? WHERE delivery_id=? AND status!='completed'")
        .run(input.status === "unknown" ? "unknown" : "reply_pending", input.reason, now, id);
    })();
  }

  counts(channelId: string): Record<string, number> {
    if (!this.pendingInbox.size) {
      return Object.fromEntries((this.db.prepare("SELECT status,COUNT(*) AS count FROM gateway_inbox WHERE channel_id=? AND status!='completed' GROUP BY status")
        .all(channelId) as Array<{ status: string; count: number }>).map(row => [row.status, row.count]));
    }
    const entries = new Map((this.db.prepare("SELECT * FROM gateway_inbox WHERE channel_id=?").all(channelId) as GatewayInboxEntry[]).map(e => [e.delivery_id, e]));
    for (const [id, pending] of this.pendingInbox) {
      if (pending.channel_id === channelId) entries.set(id, pending);
    }
    const counts: Record<string, number> = {};
    for (const entry of entries.values()) {
      if (entry.status !== "completed") counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    }
    return counts;
  }

  nextRetryAt(channelId: string, accountKey: string, cutoff = this.now()): number | undefined {
    const row = this.db.prepare(`SELECT MIN(o.next_attempt_at) AS at FROM gateway_outbox o
      JOIN gateway_inbox i ON i.delivery_id=o.delivery_id
      WHERE i.channel_id=? AND i.account_key=? AND o.status='pending' AND o.next_attempt_at>?`).get(channelId, accountKey, cutoff) as { at: number | null };
    let earliest = row.at ?? undefined;
    for (const [id, out] of this.pendingOutbox) {
      const entry = this.get(id);
      if (entry?.channel_id === channelId && entry.account_key === accountKey && out.status === "pending" && out.next_attempt_at > cutoff) {
        earliest = earliest === undefined ? out.next_attempt_at : Math.min(earliest, out.next_attempt_at);
      }
    }
    return earliest;
  }

  private prune(): void {
    this.db.prepare("DELETE FROM gateway_inbox WHERE status='completed' AND updated_at<?").run(this.now() - this.retentionMs);
    // Only terminal receipts may be evicted. Unresolved inputs/replies remain
    // visible and backpressure, rather than silently disappearing on disk.
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM gateway_inbox WHERE status='completed'").get() as { count: number };
    if (count.count >= this.maxReceipts) this.db.prepare(`DELETE FROM gateway_inbox WHERE delivery_id IN
      (SELECT delivery_id FROM gateway_inbox WHERE status='completed' ORDER BY updated_at,delivery_id LIMIT ?)`)
      .run(count.count - this.maxReceipts + 1);
  }
}
