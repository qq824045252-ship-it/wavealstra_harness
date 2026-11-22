import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { gatewayBotOriginSchema, type GatewayBotOrigin } from "../agent/work/BotTurnOrigins";
import type { GatewayInboundMessage } from "./channels";

type PrivateSource = Pick<GatewayBotOrigin, "channelId" | "connectionKey" | "chatId" | "senderId" | "messageId" | "audience">;
type Binding = { id: string; bound_at: number };
type Admission = { binding_id: string | null };
const supported = (id: string) => id === "qq-default" || id === "weixin-default" || id === "feishu-default";

export function gatewayPrivateAdmission(db: Database.Database, channelId: string, connectionKey: string, chatId: string, messageId: string): Admission | undefined {
  if (!supported(channelId) || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gateway_dots_admissions'").get()) return;
  return db.prepare(`SELECT binding_id FROM gateway_dots_admissions
    WHERE channel_id=? AND connection_key=? AND chat_id=? AND message_id=?`).get(channelId, connectionKey, chatId, messageId) as Admission | undefined;
}

export function hasGatewayDotsMemory(db: Database.Database, taskId: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gateway_dots_tasks'").get()) return false;
  return Boolean(db.prepare(`SELECT 1 FROM gateway_dots_tasks t JOIN gateway_dots_bindings b ON b.id=t.binding_id
    WHERE t.task_id=? AND b.active=1`).get(taskId));
}

export function gatewayDotsMemorySource(db: Database.Database, taskId: string, value: unknown, activeOnly: boolean): boolean {
  const source = gatewayBotOriginSchema.safeParse(value);
  if (!source.success || source.data.audience !== "private" || !source.data.personalMemoryBindingId) return false;
  const origin = source.data;
  return gatewayPrivateAdmission(db, origin.channelId, origin.connectionKey, origin.chatId, origin.messageId)?.binding_id === origin.personalMemoryBindingId
    && Boolean(db.prepare("SELECT 1 FROM gateway_dots_tasks WHERE task_id=? AND binding_id=?").get(taskId, origin.personalMemoryBindingId))
    && (!activeOnly || hasGatewayDotsMemory(db, taskId));
}

export function assertGatewayDotsMemoryCurrent(db: Database.Database, taskId: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gateway_dots_tasks'").get()) return;
  if (db.prepare("SELECT 1 FROM gateway_dots_tasks WHERE task_id=?").get(taskId) && !hasGatewayDotsMemory(db, taskId)) {
    throw new Error("该私人记忆绑定已撤销，请从当前入口开启新的对话");
  }
}

/** A QR enrollment explicitly approved on this desktop is the only grant source. */
export class GatewayDotsBindings {
  private readonly isolationInstalledAt: number;
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_memory_isolation (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), installed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_dots_bindings (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, connection_key TEXT NOT NULL, sender_id TEXT NOT NULL,
        active INTEGER NOT NULL, bound_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS gateway_dots_active_binding ON gateway_dots_bindings(channel_id) WHERE active=1;
      CREATE TABLE IF NOT EXISTS gateway_dots_admissions (
        channel_id TEXT NOT NULL, connection_key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
        binding_id TEXT REFERENCES gateway_dots_bindings(id), PRIMARY KEY(channel_id, connection_key, chat_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS gateway_dots_tasks (
        task_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES gateway_dots_bindings(id)
      );
    `);
    db.prepare("INSERT OR IGNORE INTO gateway_memory_isolation VALUES(1,?)").run(Date.now());
    this.isolationInstalledAt = (db.prepare("SELECT installed_at FROM gateway_memory_isolation").get() as { installed_at: number }).installed_at;
  }

  coversDelivery(acceptedAt: number): boolean { return acceptedAt >= this.isolationInstalledAt; }

  replace(channelId: string, connectionKey: string | undefined, senderId: string, consent: boolean) {
    this.db.transaction(() => {
      this.revoke(channelId);
      if (!consent) return;
      if (!supported(channelId) || !connectionKey || !/^[a-f0-9]{64}$/.test(connectionKey) || !senderId.trim()) {
        throw new Error("扫码身份不可验证，无法关联 Dots 个人记忆");
      }
      this.db.prepare("INSERT INTO gateway_dots_bindings VALUES(?,?,?,?,1,?)")
        .run(randomUUID(), channelId, connectionKey, senderId, Date.now());
    })();
  }

  revoke(channelId: string): void {
    if (supported(channelId)) this.db.prepare("UPDATE gateway_dots_bindings SET active=0 WHERE channel_id=? AND active=1").run(channelId);
  }

  admit(source: PrivateSource, route: GatewayInboundMessage["replyRoute"], acceptedAt = Date.now()): string | undefined {
    if (!supported(source.channelId)) return;
    const isPrivate = source.audience === "private"
      && ((source.channelId === "qq-default" && route?.kind === "qq" && !route.group && route.recipient === source.senderId && source.chatId === `c2c:${source.senderId}`)
       || (source.channelId === "weixin-default" && route?.kind === "weixin" && route.peer === source.senderId && source.chatId === source.senderId)
       || (source.channelId === "feishu-default" && route?.kind === "feishu" && !route.inThread && route.chatId === source.chatId));
    const prior = gatewayPrivateAdmission(this.db, source.channelId, source.connectionKey, source.chatId, source.messageId);
    if (prior) {
      if (prior.binding_id && (!isPrivate || !this.replyCurrent(prior))) throw new Error("该条消息的 Dots 个人记忆授权已改变");
      return prior.binding_id ?? undefined;
    }
    const grant = isPrivate ? this.db.prepare(`SELECT id,bound_at FROM gateway_dots_bindings
      WHERE channel_id=? AND connection_key=? AND sender_id=? AND active=1`)
      .get(source.channelId, source.connectionKey, source.senderId) as Binding | undefined : undefined;
    const id = grant && grant.bound_at <= acceptedAt ? grant.id : undefined;
    if (isPrivate) this.db.prepare("INSERT INTO gateway_dots_admissions VALUES(?,?,?,?,?)")
      .run(source.channelId, source.connectionKey, source.chatId, source.messageId, id ?? null);
    return id;
  }

  bindTask(taskId: string, bindingId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO gateway_dots_tasks VALUES(?,?)").run(taskId, bindingId);
    assertGatewayDotsMemoryCurrent(this.db, taskId);
  }

  replyCurrent(admission: Admission | undefined): boolean {
    return !admission?.binding_id || Boolean(this.db.prepare("SELECT 1 FROM gateway_dots_bindings WHERE id=? AND active=1").get(admission.binding_id));
  }
}
