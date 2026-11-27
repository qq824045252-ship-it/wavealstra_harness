import type Database from "better-sqlite3";
import { discoveryUrl, type DiscoveryItem } from "../../shared/dots-discovery";
import { DOTS_TASK_ID } from "../../shared/dots";
import type { DotsProactiveOutcome } from "../agent/durable/DurableDotsProactive";
import { RuntimeAuditUnknownOperationError, type RuntimeAuditReader } from "../platform/runtime-audit";
import { saveDotsBrief, type DotsResidentSource } from "./DotsWorkspace";

export interface DotsProactiveNotice {
  key: string;
  source: DotsResidentSource;
  title: string;
  body: string;
  items?: DiscoveryItem[];
  intro?: string;
}

const escapeMarkdown = (text: string) => text.replace(/[\\`*_{}\[\]<>()#+.!|~]/g, "\\$&");

function noticeText(notice: DotsProactiveNotice) {
  const title = "**" + escapeMarkdown(notice.title.replace(/\s+/g, " ")) + "**";
  const links = notice.items?.flatMap(item => {
    const url = discoveryUrl(item.url);
    if (!url) return [];
    const label = escapeMarkdown(item.title.replace(/\s+/g, " "));
    return ["- [" + label + "](<" + url + ">)"
      + (item.summary ? " — " + escapeMarkdown(item.summary.replace(/\s+/g, " ")) : "")];
  }) ?? [];
  const sections = links.length ? [notice.intro && escapeMarkdown(notice.intro), links.join("\n")] : [escapeMarkdown(notice.body)];
  return [title, ...sections].filter(Boolean).join("\n\n");
}

interface TaskNoticeRow {
  dedupe_key: string;
  source_id: "dots-google" | "dots-discovery";
  title: string;
  body: string | null;
  created_at: number;
}

type CoreReader = Pick<RuntimeAuditReader, "batch4aWrite" | "supervised" | "readDotsProactiveData" | "writeDotsProactiveData">;
type QueuedNotice = { deliveryKey: string; source: DotsResidentSource; text: string; queuedAt: number };
type PendingDelivery = Pick<QueuedNotice, "deliveryKey" | "text">;
type PendingArchive = QueuedNotice & { messageId: string; workspace: string };
type CoreNotification = {
  dedupeKey: string;
  sourceId: TaskNoticeRow["source_id"];
  title: string;
  body: string | null;
  createdAt: number;
};

function recoveredNotice(row: CoreNotification, findLinks: (key: string) => DiscoveryItem[] | undefined): QueuedNotice {
  const source = row.sourceId === "dots-google" ? "Google" : row.dedupeKey.startsWith("dream:") ? "Dream" : "RSS";
  const text = noticeText({ key: row.dedupeKey, source, title: row.title, body: row.body ?? "", items: findLinks(row.dedupeKey) });
  return { deliveryKey: row.dedupeKey, source, text, queuedAt: row.createdAt };
}

export class DotsProactiveDelivery {
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private flight?: Promise<void>;
  private writeTail = Promise.resolve();
  private pendingWriteCount = 0;
  private readonly pendingRows = new Map<string, { delivery_key: string; source: DotsResidentSource; text: string; queued_at: number; message_id: string | null; workspace: string | null; archived_at: number | null; archive_retry_at: number | null }>();

  constructor(private readonly fixture: Database.Database | undefined, private readonly paused: () => boolean,
    private readonly append: (key: string, text: string, isCurrent: () => boolean) => Promise<DotsProactiveOutcome>,
    private readonly native?: CoreReader) {
    if (!fixture && !native?.supervised) throw new Error("Dots 主动投递需要 Core");
    if (fixture && !fixture.readonly) {
      fixture.exec(`CREATE TABLE IF NOT EXISTS dots_proactive_delivery (
        delivery_key TEXT PRIMARY KEY, source TEXT NOT NULL, text TEXT NOT NULL, queued_at INTEGER NOT NULL,
        message_id TEXT, workspace TEXT, archived_at INTEGER, archive_retry_at INTEGER
      )`);
    }
  }

  private get db(): Database.Database {
    if (!this.fixture) throw new Error("Dots 主动投递的 SQLite 仓储仅用于夹具");
    return this.fixture;
  }

  private get core(): CoreReader | undefined {
    return this.fixture ? undefined : this.native;
  }

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.native?.supervised);
  }

  flushWrites(): Promise<void> {
    return this.writeTail;
  }

  private enqueueWrite(request: Record<string, unknown>, label: string): void {
    const batch4a = this.native?.batch4aWrite;
    if (!batch4a) throw new Error(`只读模式下缺少 Dots 主动投递 Rust 写入通道: ${label}`);
    this.pendingWriteCount += 1;
    this.writeTail = this.writeTail.then(() => batch4a.call(this.native, request)).then(() => undefined, error => {
      console.warn(`[DotsProactiveDelivery] ${label} failed`, error);
    }).finally(() => {
      this.pendingWriteCount -= 1;
      if (this.pendingWriteCount === 0) this.pendingRows.clear();
    });
  }

  private enqueue(notice: DotsProactiveNotice, timestamp: number) {
    const text = noticeText(notice);
    if (this.requiresRustWrites) {
      if (!this.pendingRows.has(notice.key)) {
        this.pendingRows.set(notice.key, {
          delivery_key: notice.key, source: notice.source, text, queued_at: timestamp,
          message_id: null, workspace: null, archived_at: null, archive_retry_at: null,
        });
      }
      this.enqueueWrite({
        kind: "dotsProactiveEnqueueMany",
        items: [{ deliveryKey: notice.key, source: notice.source, text, queuedAt: timestamp }],
      }, "enqueue");
      return;
    }
    this.db.prepare("INSERT OR IGNORE INTO dots_proactive_delivery(delivery_key,source,text,queued_at) VALUES (?,?,?,?)")
      .run(notice.key, notice.source, text, timestamp);
  }

  private async writeCore<T>(command: Record<string, unknown>): Promise<T> {
    const write = () => this.core!.writeDotsProactiveData<T>(command);
    const reply = await write().catch(error => {
      if (error instanceof RuntimeAuditUnknownOperationError) return write();
      throw error;
    });
    if (reply === undefined) throw new Error("Core 未确认 Dots 主动投递写入");
    return reply;
  }

  private enqueueCore(items: QueuedNotice[]) {
    if (!items.length) return Promise.resolve();
    const next = this.writeTail.then(async () => {
      const result = await this.writeCore<{ status: string }>({ kind: "enqueue", items });
      if (result.status !== "saved") throw new Error("Core 未确认 Dots 主动消息入队");
    });
    this.writeTail = next.catch(error => console.warn("[Dots] 主动消息入队失败", error));
    return next;
  }

  post(notice: DotsProactiveNotice) {
    if (this.core) return this.enqueueCore([{ deliveryKey: notice.key, source: notice.source, text: noticeText(notice), queuedAt: Date.now() }]);
    this.enqueue(notice, Date.now());
    void this.refresh();
  }

  /** Recover only notices already issued to the same Dots conversation. */
  async restoreNotifications(findLinks: (key: string) => DiscoveryItem[] | undefined, now = Date.now()) {
    const since = now - 24 * 60 * 60_000;
    const core = this.core;
    if (core) {
      const rows = await core.readDotsProactiveData<CoreNotification[]>({ kind: "notifications", since });
      if (!rows) throw new Error("Core 未确认需恢复的 Dots 通知");
      await this.enqueueCore(rows.map(row => recoveredNotice(row, findLinks)));
      return;
    }
    const rows = this.db.prepare(`SELECT dedupe_key,source_id,title,body,created_at FROM (
      SELECT dedupe_key,source_id,title,body,created_at FROM notifications
      WHERE task_id=? AND source_id IN ('dots-discovery','dots-google') AND dedupe_key IS NOT NULL
        AND dismissed_at IS NULL AND read_at IS NULL AND created_at>=?
      ORDER BY created_at DESC LIMIT 30
    ) ORDER BY created_at, dedupe_key`).all(DOTS_TASK_ID, since) as TaskNoticeRow[];
    if (this.requiresRustWrites) {
      const items = rows.map(row => {
        const source: DotsResidentSource = row.source_id === "dots-google" ? "Google" : row.dedupe_key.startsWith("dream:") ? "Dream" : "RSS";
        const text = noticeText({ key: row.dedupe_key, source, title: row.title, body: row.body ?? "", items: findLinks(row.dedupe_key) });
        if (!this.pendingRows.has(row.dedupe_key)) {
          this.pendingRows.set(row.dedupe_key, {
            delivery_key: row.dedupe_key, source, text, queued_at: row.created_at,
            message_id: null, workspace: null, archived_at: null, archive_retry_at: null,
          });
        }
        return { deliveryKey: row.dedupe_key, source, text, queuedAt: row.created_at };
      });
      if (items.length) this.enqueueWrite({ kind: "dotsProactiveEnqueueMany", items }, "restoreNotifications");
      void this.refresh();
      return;
    }
    this.db.transaction(() => {
      for (const row of rows) this.enqueue({
        key: row.dedupe_key, source: row.source_id === "dots-google" ? "Google" : row.dedupe_key.startsWith("dream:") ? "Dream" : "RSS",
        title: row.title, body: row.body ?? "", items: findLinks(row.dedupe_key),
      }, row.created_at);
    })();
    void this.refresh();
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (this.core) return;
    if (!this.native?.supervised && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), 5_000);
      this.timer.unref();
    }
    void this.refresh();
  }

  refresh() {
    if (!this.started || this.paused()) return Promise.resolve();
    if (this.flight) return this.flight;
    const current = () => this.started && !this.paused();
    const core = this.core;
    if (core) {
      this.flight = this.drainCore(core, current).finally(() => { this.flight = undefined; });
      return this.flight;
    }
    const drain = async () => {
      const dbRows = this.db.prepare("SELECT delivery_key,text FROM dots_proactive_delivery WHERE message_id IS NULL ORDER BY queued_at,rowid LIMIT 30")
        .all() as { delivery_key: string; text: string }[];
      const rowMap = new Map(dbRows.map(r => [r.delivery_key, r]));
      for (const pending of this.pendingRows.values()) {
        if (pending.message_id === null && !rowMap.has(pending.delivery_key)) {
          rowMap.set(pending.delivery_key, { delivery_key: pending.delivery_key, text: pending.text });
        } else if (pending.message_id !== null) {
          rowMap.delete(pending.delivery_key);
        }
      }
      const rows = [...rowMap.values()].slice(0, 30);
      for (const row of rows) {
        if (!current()) return;
        const result = await this.append(row.delivery_key, row.text, current);
        if (result.status === "pending") break;
        if (this.requiresRustWrites) {
          const prev = this.pendingRows.get(row.delivery_key);
          if (prev) this.pendingRows.set(row.delivery_key, { ...prev, message_id: result.messageId, workspace: result.workspace ?? null });
          this.enqueueWrite({
            kind: "dotsProactiveSetDelivered",
            deliveryKey: row.delivery_key,
            messageId: result.messageId,
            workspace: result.workspace ?? null,
          }, "setDelivered");
        } else {
          this.db.prepare("UPDATE dots_proactive_delivery SET message_id=?,workspace=? WHERE delivery_key=?")
            .run(result.messageId, result.workspace ?? null, row.delivery_key);
        }
      }
      const dbArchives = this.db.prepare(`SELECT delivery_key,source,text,workspace,queued_at FROM dots_proactive_delivery
        WHERE workspace IS NOT NULL AND archived_at IS NULL AND coalesce(archive_retry_at,0)<=? ORDER BY queued_at,rowid LIMIT 30`)
        .all(Date.now()) as { delivery_key: string; source: DotsResidentSource; text: string; workspace: string; queued_at: number }[];
      const archiveMap = new Map(dbArchives.map(r => [r.delivery_key, r]));
      const nowMs = Date.now();
      for (const pending of this.pendingRows.values()) {
        if (pending.workspace && pending.archived_at === null && (pending.archive_retry_at ?? 0) <= nowMs && !archiveMap.has(pending.delivery_key)) {
          archiveMap.set(pending.delivery_key, { delivery_key: pending.delivery_key, source: pending.source, text: pending.text, workspace: pending.workspace, queued_at: pending.queued_at });
        } else if (pending.archived_at !== null || (pending.archive_retry_at ?? 0) > nowMs) {
          archiveMap.delete(pending.delivery_key);
        }
      }
      const archives = [...archiveMap.values()].slice(0, 30);
      for (const row of archives) {
        if (!current()) return;
        try { saveDotsBrief(row.workspace, row.source, row.delivery_key, row.text, row.queued_at); }
        catch {
          const retryAt = Date.now() + 60_000;
          if (this.requiresRustWrites) {
            const prev = this.pendingRows.get(row.delivery_key);
            if (prev) this.pendingRows.set(row.delivery_key, { ...prev, archive_retry_at: retryAt });
            this.enqueueWrite({ kind: "dotsProactiveSetArchive", deliveryKey: row.delivery_key, archivedAt: null, retryAt }, "setArchiveRetry");
          } else {
            this.db.prepare("UPDATE dots_proactive_delivery SET archive_retry_at=? WHERE delivery_key=?")
              .run(retryAt, row.delivery_key);
          }
          continue;
        }
        const archivedAt = Date.now();
        if (this.requiresRustWrites) {
          const prev = this.pendingRows.get(row.delivery_key);
          if (prev) this.pendingRows.set(row.delivery_key, { ...prev, archived_at: archivedAt });
          this.enqueueWrite({ kind: "dotsProactiveSetArchive", deliveryKey: row.delivery_key, archivedAt, retryAt: null }, "setArchived");
        } else {
          this.db.prepare("UPDATE dots_proactive_delivery SET archived_at=? WHERE delivery_key=?").run(archivedAt, row.delivery_key);
        }
      }
    };
    this.flight = drain().catch(error => console.warn("[Dots] 主动消息尚未写入对话，将稍后重试。", error))
      .finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private async drainCore(core: CoreReader, current: () => boolean) {
    await this.writeTail;
    if (!current()) return;
    const pending = await core.readDotsProactiveData<PendingDelivery[]>({ kind: "pending" });
    if (!pending) throw new Error("Core 未确认 Dots 主动消息队列");
    for (const row of pending) {
      if (!current()) return;
      const result = await this.append(row.deliveryKey, row.text, current);
      if (result.status === "pending") break;
      const confirmed = await this.writeCore<{ status: string }>({
        kind: "confirm", deliveryKey: row.deliveryKey, messageId: result.messageId,
      });
      if (confirmed.status !== "delivered") throw new Error("Core 未确认 Dots 对话中的主动消息回执");
    }
    if (!current()) return;
    const archives = await core.readDotsProactiveData<PendingArchive[]>({ kind: "archives", now: Date.now() });
    if (!archives) throw new Error("Core 未确认 Dots 简报归档队列");
    for (const row of archives) {
      if (!current()) return;
      let archivedAt: number | null = null;
      let retryAt: number | null = null;
      try {
        saveDotsBrief(row.workspace, row.source, row.deliveryKey, row.text, row.queuedAt);
        archivedAt = Date.now();
      } catch {
        retryAt = Date.now() + 60_000;
      }
      const saved = await this.writeCore<{ status: string }>({
        kind: "archive", deliveryKey: row.deliveryKey, messageId: row.messageId, workspace: row.workspace, archivedAt, retryAt,
      });
      if (saved.status !== "saved") throw new Error("Core 未确认 Dots 简报归档结果");
    }
  }

  async close() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flight;
    await this.writeTail;
  }
}
