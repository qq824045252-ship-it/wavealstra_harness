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

  constructor(private readonly db: Database.Database, options: GatewayDeliveryJournalOptions = {}) {
    this.now = options.now ?? Date.now;
    this.mediaDirectory = resolve(options.mediaDirectory ?? join(getGatewayDir(), "media"));
    this.maxPending = options.maxPending ?? 10_000;
    this.maxReceipts = options.maxReceipts ?? 100_000;
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60_000;
    if (![this.maxPending, this.maxReceipts, this.retentionMs].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Gateway 持久队列限制无效");
    }
    ensureGatewayDeliveryTables(db);
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
      || (message.sender && (!nonempty(message.sender.id) || (message.sender.name !== undefined && (typeof message.sender.name !== "string" || message.sender.name.length > 2048))))) {
      throw new Error("Gateway 持久消息内容无效或过长");
    }
    if (message.attachments && (!Array.isArray(message.attachments) || message.attachments.length > GATEWAY_MEDIA_LIMITS.count)) {
      throw new Error("Gateway 持久附件数量无效");
    }
    const attachments = message.attachments?.map(file => this.attachment(file));
    if (attachments && attachments.reduce((sum, file) => sum + file.size, 0) > GATEWAY_MEDIA_LIMITS.batch) throw new Error("Gateway 持久附件总大小超过限制");
    const payload: GatewayStoredPayload = { version: 1, channelId: message.channelId, chatId: message.chatId, messageId, text: message.text,
      ...(message.sender ? { sender: { id: message.sender.id, ...(message.sender.name ? { name: message.sender.name } : {}) } } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(message.workTarget ? { workTarget: gatewayWorkTargetSchema.parse(message.workTarget) } : {}),
      ...(message.replyRoute ? { replyRoute: gatewayReplyRouteSchema.parse(message.replyRoute) } : {}) };
    if (Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024) throw new Error("Gateway 持久消息超过大小限制");
    return payload;
  }

  /** Synchronous commit is complete before an early-ACK transport may acknowledge. */
  accept(input: { platform: GatewayChannelType; accountKey: string; sessionKey: string; message: GatewayInboundMessage;
    replayNativeReceipts: boolean }): { entry: GatewayInboxEntry; duplicate: boolean } {
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
      return { entry: this.get(id)!, duplicate: false };
    })();
  }

  get(id: string): GatewayInboxEntry | undefined {
    return this.db.prepare("SELECT * FROM gateway_inbox WHERE delivery_id=?").get(id) as GatewayInboxEntry | undefined;
  }
  outbox(id: string): GatewayOutboxEntry | undefined {
    return this.db.prepare("SELECT * FROM gateway_outbox WHERE delivery_id=?").get(id) as GatewayOutboxEntry | undefined;
  }

  decode(entry: GatewayInboxEntry, verifyAttachments = true): GatewayStoredPayload {
    if (digest(entry.payload_json) !== entry.payload_hash) throw new Error("Gateway 持久消息摘要校验失败");
    const value = JSON.parse(entry.payload_json) as GatewayStoredPayload;
    if (!value || value.version !== 1 || value.channelId !== entry.channel_id || value.chatId !== entry.chat_id
      || value.messageId !== entry.message_id || !nonempty(value.messageId) || typeof value.text !== "string" || value.text.length > 64_000
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
    return this.db.prepare(`SELECT i.* FROM gateway_inbox i LEFT JOIN gateway_outbox o ON o.delivery_id=i.delivery_id
      WHERE i.channel_id=? AND i.account_key=? AND i.status IN ('pending','reply_pending')
      AND (o.delivery_id IS NULL OR (o.status='pending' AND o.next_attempt_at<=?) OR (o.status='blocked' AND ?=1))
      ORDER BY i.created_at,i.rowid LIMIT ?`).all(channelId, accountKey, cutoff, retryBlocked ? 1 : 0, limit) as GatewayInboxEntry[];
  }

  begin(id: string): GatewayInboxEntry {
    const entry = this.get(id);
    if (!entry || entry.status === "completed" || entry.status === "unknown" || this.outbox(id)) throw new Error("Gateway 消息不可重复执行");
    if (entry.retry_count > 0 && entry.receipt_mode !== "pi-durable") {
      this.block(id, "native_recovery_unavailable", "unknown");
      throw new Error("Gateway 缺少原生幂等回执，未重复执行");
    }
    this.db.prepare("UPDATE gateway_inbox SET status='running',retry_count=retry_count+1,last_error=NULL,updated_at=? WHERE delivery_id=?").run(this.now(), id);
    return entry;
  }

  complete(id: string): void {
    const outbox = this.outbox(id);
    if (outbox && outbox.status !== "sent") return;
    this.db.prepare("UPDATE gateway_inbox SET status='completed',last_error=NULL,updated_at=? WHERE delivery_id=?").run(this.now(), id);
  }

  block(id: string, reason: string, status: "blocked" | "unknown" = "blocked"): void {
    this.db.prepare("UPDATE gateway_inbox SET status=?,last_error=?,updated_at=? WHERE delivery_id=? AND status!='completed'").run(status, reason, this.now(), id);
  }

  defer(id: string): void {
    this.db.prepare(`UPDATE gateway_inbox SET status=CASE WHEN receipt_mode='pi-durable' OR retry_count=0 THEN 'pending' ELSE 'unknown' END,
      last_error='connection_interrupted',updated_at=? WHERE delivery_id=? AND status NOT IN ('completed','unknown')
      AND delivery_id NOT IN (SELECT delivery_id FROM gateway_outbox)`).run(this.now(), id);
  }

  queueReply(id: string, text: string): GatewayOutboxEntry {
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
    const old = this.outbox(id);
    if (!old || !["pending", "blocked"].includes(old.status) || digest(old.reply_text) !== old.reply_hash) throw new Error("Gateway 回复不可重发或校验失败");
    this.db.prepare("UPDATE gateway_outbox SET status='sending',retry_count=retry_count+1,last_error=NULL,updated_at=? WHERE delivery_id=?").run(this.now(), id);
    return this.outbox(id)!;
  }

  sent(id: string): void {
    this.db.transaction(() => {
      const now = this.now();
      this.db.prepare("UPDATE gateway_outbox SET status='sent',last_error=NULL,sent_at=?,updated_at=? WHERE delivery_id=? AND status='sending'").run(now, now, id);
      this.complete(id);
    })();
  }

  sendFailed(id: string, input: { status: "pending" | "blocked" | "unknown" | "failed"; reason: string; nextAttemptAt?: number }): void {
    this.db.transaction(() => {
      const now = this.now();
      this.db.prepare("UPDATE gateway_outbox SET status=?,last_error=?,next_attempt_at=?,updated_at=? WHERE delivery_id=? AND status!='sent'")
        .run(input.status, input.reason, input.nextAttemptAt ?? 0, now, id);
      this.db.prepare("UPDATE gateway_inbox SET status=?,last_error=?,updated_at=? WHERE delivery_id=? AND status!='completed'")
        .run(input.status === "unknown" ? "unknown" : "reply_pending", input.reason, now, id);
    })();
  }

  counts(channelId: string): Record<string, number> {
    return Object.fromEntries((this.db.prepare("SELECT status,COUNT(*) AS count FROM gateway_inbox WHERE channel_id=? AND status!='completed' GROUP BY status")
      .all(channelId) as Array<{ status: string; count: number }>).map(row => [row.status, row.count]));
  }

  nextRetryAt(channelId: string, accountKey: string, cutoff = this.now()): number | undefined {
    const row = this.db.prepare(`SELECT MIN(o.next_attempt_at) AS at FROM gateway_outbox o
      JOIN gateway_inbox i ON i.delivery_id=o.delivery_id
      WHERE i.channel_id=? AND i.account_key=? AND o.status='pending' AND o.next_attempt_at>?`).get(channelId, accountKey, cutoff) as { at: number | null };
    return row.at ?? undefined;
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
