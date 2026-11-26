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
import type { RuntimeAuditReader } from "../platform/runtime-audit";

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
  native?: Pick<RuntimeAuditReader, "batch4aWrite" | "supervised">;
}
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const nonempty = (value: unknown, limit = 2048): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= limit;

/** SQLite transport admission and replies. This does not execute tools or replace
 * native receipts. All accepted inputs retain their original message identity. */
export class GatewayDeliveryJournal {
  private readonly now: () => number;
  private readonly mediaDirectory: string;
  private readonly maxPending: number;
  private readonly maxReceipts: number;
  private readonly retentionMs: number;
  private readonly native?: Pick<RuntimeAuditReader, "batch4aWrite" | "supervised">;
  private writeTail = Promise.resolve();
  private pendingWriteCount = 0;
  private readonly pendingInbox = new Map<string, GatewayInboxEntry>();
  private readonly pendingOutbox = new Map<string, GatewayOutboxEntry>();
  private readonly pendingContinuations = new Map<string, string>();

  constructor(private readonly db: Database.Database, options: GatewayDeliveryJournalOptions = {}) {
    this.now = options.now ?? Date.now;
    this.mediaDirectory = resolve(options.mediaDirectory ?? join(getGatewayDir(), "media"));
    this.maxPending = options.maxPending ?? 10_000;
    this.maxReceipts = options.maxReceipts ?? 100_000;
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60_000;
    this.native = options.native;
    if (![this.maxPending, this.maxReceipts, this.retentionMs].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Gateway 持久队列限制无效");
    }
    if (!db.readonly) {
      ensureGatewayDeliveryTables(db);
      db.exec("CREATE TABLE IF NOT EXISTS bot_gateway_continuations(delivery_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE)");
    }
  }

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.native?.supervised);
  }

  flush(): Promise<void> {
    return this.writeTail;
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

  /** Synchronous commit is complete before an early-ACK transport may acknowledge. */
  accept(input: { platform: GatewayChannelType; accountKey: string; sessionKey: string; message: GatewayInboundMessage;
    replayNativeReceipts: boolean; reserveConversation?(messageId: string, acceptedAt: number): void }): { entry: GatewayInboxEntry; duplicate: boolean } {
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
    if (this.requiresRustWrites) {
      const pending = [...this.db.prepare("SELECT delivery_id FROM gateway_inbox WHERE status!='completed'").all() as Array<{ delivery_id: string }>];
      const pendingIds = new Set(pending.map(row => row.delivery_id));
      for (const [deliveryId, entry] of this.pendingInbox) {
        if (entry.status === "completed") pendingIds.delete(deliveryId);
        else pendingIds.add(deliveryId);
      }
      if (pendingIds.size >= this.maxPending) throw new Error("Gateway 持久收件箱已满，消息尚未确认接收");
      const jsonHash = digest(json);
      const receiptMode = input.replayNativeReceipts ? "pi-durable" : "none";
      const entry: GatewayInboxEntry = {
        delivery_id: id,
        platform: input.platform,
        channel_id: payload.channelId,
        account_key: input.accountKey,
        chat_id: payload.chatId,
        session_key: input.sessionKey,
        message_id: messageId,
        payload_json: json,
        payload_hash: jsonHash,
        status: "pending",
        retry_count: 0,
        receipt_mode: receiptMode,
        last_error: null,
        created_at: now,
        updated_at: now,
      };
      this.pendingInbox.set(id, entry);
      this.enqueueOp({
        op: "enqueue",
        deliveryId: id,
        platform: input.platform,
        channelId: payload.channelId,
        accountKey: input.accountKey,
        chatId: payload.chatId,
        sessionKey: input.sessionKey,
        messageId,
        payloadJson: json,
        payloadHash: jsonHash,
        receiptMode,
        now,
        retentionMs: this.retentionMs,
        maxReceipts: this.maxReceipts,
      }, "accept");
      input.reserveConversation?.(messageId, now);
      return { entry, duplicate: false };
    }
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
    if (this.requiresRustWrites) {
      this.pendingInbox.clear();
      this.pendingOutbox.clear();
      this.enqueueOp({ op: "recoverInterrupted", now: this.now() }, "recoverInterrupted");
      return;
    }
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
    const entry = this.get(id);
    if (!entry || entry.status === "completed" || entry.status === "unknown" || this.outbox(id)) throw new Error("Gateway 消息不可重复执行");
    if (entry.retry_count > 0 && entry.receipt_mode !== "pi-durable") {
      this.block(id, "native_recovery_unavailable", "unknown");
      throw new Error("Gateway 缺少原生幂等回执，未重复执行");
    }
    const now = this.now();
    if (this.requiresRustWrites) {
      this.pendingInbox.set(id, { ...entry, status: "running", retry_count: entry.retry_count + 1, last_error: null, updated_at: now });
      this.enqueueOp({ op: "begin", deliveryId: id, now }, "begin");
      return entry;
    }
    this.db.prepare("UPDATE gateway_inbox SET status='running',retry_count=retry_count+1,last_error=NULL,updated_at=? WHERE delivery_id=?").run(now, id);
    return entry;
  }

  complete(id: string): void {
    const outbox = this.outbox(id);
    if (outbox && outbox.status !== "sent") return;
    const now = this.now();
    if (this.requiresRustWrites) {
      const current = this.get(id);
      if (current) this.pendingInbox.set(id, { ...current, status: "completed", last_error: null, updated_at: now });
      this.enqueueOp({ op: "complete", deliveryId: id, now }, "complete");
      return;
    }
    this.db.prepare("UPDATE gateway_inbox SET status='completed',last_error=NULL,updated_at=? WHERE delivery_id=?").run(now, id);
  }

  block(id: string, reason: string, status: "blocked" | "unknown" = "blocked"): void {
    const now = this.now();
    if (this.requiresRustWrites) {
      const current = this.get(id);
      if (current && current.status !== "completed") {
        this.pendingInbox.set(id, { ...current, status, last_error: reason, updated_at: now });
      }
      this.enqueueOp({ op: "block", deliveryId: id, status, reason, now }, "block");
      return;
    }
    this.db.prepare("UPDATE gateway_inbox SET status=?,last_error=?,updated_at=? WHERE delivery_id=? AND status!='completed'").run(status, reason, now, id);
  }

  defer(id: string): void {
    const now = this.now();
    if (this.requiresRustWrites) {
      const current = this.get(id);
      if (current && current.status !== "completed" && current.status !== "unknown" && !this.outbox(id)) {
        const nextStatus = current.receipt_mode === "pi-durable" || current.retry_count === 0 ? "pending" : "unknown";
        this.pendingInbox.set(id, { ...current, status: nextStatus, last_error: "connection_interrupted", updated_at: now });
      }
      this.enqueueOp({ op: "defer", deliveryId: id, now }, "defer");
      return;
    }
    this.db.prepare(`UPDATE gateway_inbox SET status=CASE WHEN receipt_mode='pi-durable' OR retry_count=0 THEN 'pending' ELSE 'unknown' END,
      last_error='connection_interrupted',updated_at=? WHERE delivery_id=? AND status NOT IN ('completed','unknown')
      AND delivery_id NOT IN (SELECT delivery_id FROM gateway_outbox)`).run(now, id);
  }

  queueReply(id: string, text: string): GatewayOutboxEntry {
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 512 * 1024) throw new Error("Gateway 回复为空或超过持久大小限制");
    const hash = digest(text);
    const old = this.outbox(id);
    if (old) {
      if (old.reply_hash !== hash) throw new Error("Gateway 回复与已保存结果不一致，未覆盖");
      return old;
    }
    if (this.requiresRustWrites) {
      const now = this.now();
      const outboxEntry: GatewayOutboxEntry = {
        delivery_id: id,
        reply_text: text,
        reply_hash: hash,
        status: "pending",
        retry_count: 0,
        next_attempt_at: 0,
        last_error: null,
        created_at: now,
        updated_at: now,
        sent_at: null,
      };
      this.pendingOutbox.set(id, outboxEntry);
      const current = this.get(id);
      if (current) this.pendingInbox.set(id, { ...current, status: "reply_pending", last_error: null, updated_at: now });
      this.enqueueOp({ op: "queueReply", deliveryId: id, replyText: text, replyHash: hash, now }, "queueReply");
      return outboxEntry;
    }
    return this.db.transaction(() => {
      const now = this.now();
      this.db.prepare(`INSERT INTO gateway_outbox (delivery_id,reply_text,reply_hash,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)`).run(id, text, hash, now, now);
      this.db.prepare("UPDATE gateway_inbox SET status='reply_pending',last_error=NULL,updated_at=? WHERE delivery_id=?").run(now, id);
      return this.outbox(id)!;
    })();
  }

  beginSend(id: string): GatewayOutboxEntry {
    const old = this.outbox(id);
    if (!old || !["pending", "blocked"].includes(old.status) || digest(old.reply_text) !== old.reply_hash) throw new Error("Gateway 回复不可重发或校验失败");
    const now = this.now();
    if (this.requiresRustWrites) {
      const next: GatewayOutboxEntry = { ...old, status: "sending", retry_count: old.retry_count + 1, last_error: null, updated_at: now };
      this.pendingOutbox.set(id, next);
      this.enqueueOp({ op: "beginSend", deliveryId: id, now }, "beginSend");
      return next;
    }
    this.db.prepare("UPDATE gateway_outbox SET status='sending',retry_count=retry_count+1,last_error=NULL,updated_at=? WHERE delivery_id=?").run(now, id);
    return this.outbox(id)!;
  }

  sent(id: string): void {
    const now = this.now();
    if (this.requiresRustWrites) {
      const out = this.outbox(id);
      if (out && out.status === "sending") {
        this.pendingOutbox.set(id, { ...out, status: "sent", last_error: null, sent_at: now, updated_at: now });
      }
      const entry = this.get(id);
      if (entry && (!out || out.status === "sending" || out.status === "sent")) {
        this.pendingInbox.set(id, { ...entry, status: "completed", last_error: null, updated_at: now });
      }
      this.enqueueOp({ op: "sent", deliveryId: id, now }, "sent");
      return;
    }
    this.db.transaction(() => {
      this.db.prepare("UPDATE gateway_outbox SET status='sent',last_error=NULL,sent_at=?,updated_at=? WHERE delivery_id=? AND status='sending'").run(now, now, id);
      this.complete(id);
    })();
  }

  sendFailed(id: string, input: { status: "pending" | "blocked" | "unknown" | "failed"; reason: string; nextAttemptAt?: number }): void {
    const now = this.now();
    if (this.requiresRustWrites) {
      const out = this.outbox(id);
      if (out && out.status !== "sent") {
        this.pendingOutbox.set(id, { ...out, status: input.status, last_error: input.reason, next_attempt_at: input.nextAttemptAt ?? 0, updated_at: now });
      }
      const entry = this.get(id);
      if (entry && entry.status !== "completed") {
        this.pendingInbox.set(id, { ...entry, status: input.status === "unknown" ? "unknown" : "reply_pending", last_error: input.reason, updated_at: now });
      }
      this.enqueueOp({
        op: "sendFailed",
        deliveryId: id,
        status: input.status,
        reason: input.reason,
        nextAttemptAt: input.nextAttemptAt ?? 0,
        now,
      }, "sendFailed");
      return;
    }
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
