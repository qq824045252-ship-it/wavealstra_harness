import { notificationTarget, parseNotificationTarget, type NotificationActivationTarget } from "../../shared/notification";
import type Database from "better-sqlite3";
import type { RuntimeAuditReader } from "../platform/runtime-audit";
import type {
  NotificationDto,
  NotificationLevel,
  NotificationListRequest,
  NotificationSourceType,
  NotificationType,
} from "../../shared/notification";

export interface RuntimeNotificationSqlRow {
  id: string;
  type: string;
  level: string;
  title: string;
  body: string | null;
  source_type: string;
  source_id: string | null;
  task_id: string | null;
  project_id: string | null;
  workspace_id: string | null;
  dedupe_key: string | null;
  created_at: number;
  read_at: number | null;
  dismissed_at: number | null;
  target_json?: string | null;
  group_key?: string;
  group_count?: number;
  unread_count?: number;
  activation_id?: string;
  activation_json?: string | null;
  activation_title?: string;
  activation_body?: string | null;
  activation_created_at?: number;
  activation_task_id?: string | null;
  activation_project_id?: string | null;
  activation_source_type?: NotificationSourceType;
}

export type RuntimeNotificationQuery = { kind: "unreadCount" } | {
  kind: "list";
  limit: number;
  types?: string[];
  query: string;
  unreadOnly: boolean;
  grouped: boolean;
  before?: NotificationListRequest["before"];
};

export type RuntimeNotificationMutation =
  | { kind: "markRead" | "dismiss"; id: string; at: number }
  | { kind: "markReadByDedupeKey"; dedupeKey: string; at: number }
  | { kind: "markAllRead" | "dismissAll"; at: number }
  | { kind: "cleanup"; now: number }
  | { kind: "publish"; record: Omit<NotificationDto, "target" | "group">; targetJson?: string; inApp: boolean; desktop: boolean };

export type RuntimeNotificationWriteReply =
  | { status: "saved"; changed: boolean; unreadCount: number }
  | { status: "rejected"; message: string }
  | { status: "needsHost" };

export function clipNotificationText(input: string, limit: number): string {
  // JavaScript slicing can split an emoji at the limit. SQLite's host string bind
  // replaces lone surrogates; normalize them before sending the same text to Rust.
  return input.trim().slice(0, limit).replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

export function normalizeNotificationList(request: NotificationListRequest): Extract<RuntimeNotificationQuery, { kind: "list" }> {
  const requestedLimit = request.limit ?? 100;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, Math.floor(requestedLimit))) : 100;
  const types = Array.isArray(request.types) && request.types.length
    ? request.types.filter(type => typeof type === "string").slice(0, 32)
    : undefined;
  const query = typeof request.query === "string" ? clipNotificationText(request.query, 160) : "";
  const before = request.before;
  return { kind: "list", limit, types, query, unreadOnly: Boolean(request.unreadOnly), grouped: Boolean(request.grouped),
    before: typeof before?.id === "string" && Number.isFinite(before.createdAt)
      ? { id: before.id, createdAt: before.createdAt }
      : undefined };
}

export function mapNotificationRow(row: RuntimeNotificationSqlRow): NotificationDto {
  let target: NotificationActivationTarget | null = null;
  if (row.target_json) {
    try { target = parseNotificationTarget(JSON.parse(row.target_json)); } catch { /* Invalid persisted target. */ }
  }
  const record: NotificationDto = {
    ...(target ? { target } : {}),
    id: row.id,
    type: row.type as NotificationType,
    level: row.level as NotificationLevel,
    title: row.title,
    body: row.body ?? undefined,
    sourceType: row.source_type as NotificationSourceType,
    sourceId: row.source_id ?? undefined,
    taskId: row.task_id ?? undefined,
    projectId: row.project_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    createdAt: row.created_at,
    readAt: row.read_at ?? undefined,
    dismissedAt: row.dismissed_at ?? undefined,
  };
  if (row.group_key && row.group_count !== undefined && row.unread_count !== undefined && row.activation_id) {
    let activationTarget: NotificationActivationTarget | null = null;
    if (row.activation_json) {
      try { activationTarget = parseNotificationTarget(JSON.parse(row.activation_json)); } catch { /* Invalid persisted target. */ }
    }
    const fallbackTarget = row.activation_source_type ? notificationTarget({
      taskId: row.activation_task_id ?? undefined, projectId: row.activation_project_id ?? undefined,
      sourceType: row.activation_source_type,
    }) : null;
    record.group = { key: row.group_key, count: row.group_count, unreadCount: row.unread_count,
      activationId: row.activation_id, target: activationTarget ?? fallbackTarget ?? undefined,
      preview: { title: row.activation_title ?? row.title, body: row.activation_body ?? undefined,
        createdAt: row.activation_created_at ?? row.created_at } };
  }
  return record;
}

type NotificationNativeClient = Pick<RuntimeAuditReader, "notificationData">
  & Partial<Pick<RuntimeAuditReader, "batch4aWrite" | "supervised">>;

export class NotificationRepository {
  private writeTail = Promise.resolve();

  constructor(private readonly db: Database.Database, private readonly native?: NotificationNativeClient) {
    // Separate from bell visibility: desktop-only notifications must survive restart.
    if (!this.db.readonly) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS notification_activation_targets (
        notification_id TEXT PRIMARY KEY, target_json TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
    }
  }

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.native?.supervised);
  }

  flush(): Promise<void> {
    return this.writeTail;
  }

  private enqueueBatch4a(request: Record<string, unknown>, label: string): void {
    const batch4a = this.native?.batch4aWrite;
    if (!batch4a) throw new Error(`只读模式下缺少通知 Rust 写入通道: ${label}`);
    this.writeTail = this.writeTail.then(() => batch4a.call(this.native, request)).then(() => undefined, error => {
      console.warn(`[NotificationRepository] ${label} failed`, error);
    });
  }

  saveActivation(record: NotificationDto): void {
    const target = notificationTarget(record);
    if (!target) return;
    if (this.requiresRustWrites) {
      this.enqueueBatch4a({
        kind: "notificationSaveActivation",
        id: record.id,
        targetJson: JSON.stringify(target),
        createdAt: record.createdAt,
      }, "saveActivation");
      return;
    }
    this.db.prepare(`INSERT OR REPLACE INTO notification_activation_targets VALUES (?, ?, ?)`)
      .run(record.id, JSON.stringify(target), record.createdAt);
  }

  resolveActivation(id: string, now = Date.now()): NotificationActivationTarget | null {
    const row = this.db.prepare(`SELECT target_json FROM notification_activation_targets WHERE notification_id = ? AND created_at >= ?`)
      .get(id, now - 90 * 24 * 60 * 60 * 1000) as { target_json: string } | undefined;
    if (row) { try { return parseNotificationTarget(JSON.parse(row.target_json)); } catch { return null; } }
    const legacy = this.db.prepare(`SELECT * FROM notifications WHERE id = ? AND created_at >= ?`)
      .get(id, now - 90 * 24 * 60 * 60 * 1000) as RuntimeNotificationSqlRow | undefined;
    return legacy ? notificationTarget(mapNotificationRow(legacy)) : null;
  }

  insert(record: NotificationDto): { record: NotificationDto; inserted: boolean } {
    return this.db.transaction(() => this.insertRecord(record))();
  }

  private insertRecord(record: NotificationDto): { record: NotificationDto; inserted: boolean } {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO notifications (
        id, type, level, title, body, source_type, source_id,
        task_id, project_id, workspace_id, dedupe_key,
        created_at, read_at, dismissed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.type,
      record.level,
      record.title,
      record.body ?? null,
      record.sourceType,
      record.sourceId ?? null,
      record.taskId ?? null,
      record.projectId ?? null,
      record.workspaceId ?? null,
      record.dedupeKey ?? null,
      record.createdAt,
      record.readAt ?? null,
      record.dismissedAt ?? null,
    );
    if (result.changes > 0) { this.saveActivation(record); return { record, inserted: true }; }
    if (record.dedupeKey) {
      const existing = this.findByDedupeKey(record.dedupeKey);
      if (existing) return { record: existing, inserted: false };
    }
    return { record, inserted: false };
  }

  findByDedupeKey(dedupeKey: string): NotificationDto | undefined {
    const row = this.db.prepare(`SELECT * FROM notifications WHERE dedupe_key = ? LIMIT 1`)
      .get(dedupeKey) as RuntimeNotificationSqlRow | undefined;
    return row ? mapNotificationRow(row) : undefined;
  }

  list(request: NotificationListRequest = {}): NotificationDto[] {
    return this.listOnHost(normalizeNotificationList(request));
  }

  async readList(request: NotificationListRequest = {}): Promise<NotificationDto[]> {
    const query = normalizeNotificationList(request);
    const result = await this.native?.notificationData(query);
    return Array.isArray(result) ? result.map(mapNotificationRow) : this.listOnHost(query);
  }

  private listOnHost(request: Extract<RuntimeNotificationQuery, { kind: "list" }>): NotificationDto[] {
    const { limit, types, query, before, unreadOnly, grouped } = request;
    const where = ["dismissed_at IS NULL"];
    const bindings: Array<string | number> = [];
    if (unreadOnly) where.push("read_at IS NULL");
    if (types) {
      if (!types.length) return [];
      where.push(`type IN (${types.map(() => "?").join(", ")})`);
      bindings.push(...types);
    }
    if (query) {
      where.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0)");
      bindings.push(query, query);
    }
    if (grouped) return this.listGrouped(where, bindings, limit, before);
    if (before) {
      where.push("(created_at, id) < (?, ?)");
      bindings.push(before.createdAt, before.id);
    }
    const rows = this.db.prepare(`
      SELECT n.*, (SELECT a.target_json FROM notification_activation_targets a WHERE a.notification_id = n.id) AS target_json
      FROM notifications n
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...bindings, limit) as RuntimeNotificationSqlRow[];
    return rows.map(mapNotificationRow);
  }

  private listGrouped(where: string[], bindings: Array<string | number>, limit: number,
    before: NotificationListRequest["before"]): NotificationDto[] {
    const rows = this.db.prepare(`
      WITH visible AS (
        SELECT n.*, CASE WHEN json_valid(a.target_json) THEN a.target_json END AS target_json
        FROM notifications n
        LEFT JOIN notification_activation_targets a ON a.notification_id = n.id
        WHERE ${where.join(" AND ")}
      ), grouped AS (
        SELECT *, CASE
          WHEN json_extract(target_json, '$.kind') = 'work'
            THEN json_array('work', json_extract(target_json, '$.workId'))
          WHEN json_extract(target_json, '$.kind') = 'botConversation'
            THEN json_array('conversation', json_extract(target_json, '$.botId'),
              json_extract(target_json, '$.teamId'), json_extract(target_json, '$.conversationId'))
          WHEN COALESCE(json_extract(target_json, '$.taskId'), task_id) IS NOT NULL
            THEN json_array('task', COALESCE(json_extract(target_json, '$.taskId'), task_id), json_extract(target_json, '$.workId'))
          ELSE json_array('notification', id)
        END AS group_key
        FROM visible
      ), ranked AS (
        SELECT *, count(*) OVER members AS group_count, sum(read_at IS NULL) OVER members AS unread_count,
          row_number() OVER (PARTITION BY group_key ORDER BY created_at DESC, id DESC) AS position,
          first_value(id) OVER focus AS activation_id
        FROM grouped
        WINDOW members AS (PARTITION BY group_key),
          focus AS (PARTITION BY group_key ORDER BY read_at IS NOT NULL,
            CASE WHEN read_at IS NULL THEN created_at END ASC,
            CASE WHEN read_at IS NULL THEN id END ASC, created_at DESC, id DESC)
      ), page AS (
        SELECT * FROM ranked WHERE position = 1 ${before ? "AND (created_at, id) < (?, ?)" : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?
      )
      SELECT p.*, a.target_json AS activation_json, a.title AS activation_title,
        a.body AS activation_body, a.created_at AS activation_created_at, a.task_id AS activation_task_id,
        a.project_id AS activation_project_id, a.source_type AS activation_source_type
      FROM page p JOIN visible a ON a.id = p.activation_id
      ORDER BY p.created_at DESC, p.id DESC
    `).all(...bindings, ...(before ? [before.createdAt, before.id] : []), limit) as RuntimeNotificationSqlRow[];
    return rows.map(mapNotificationRow);
  }

  unreadCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM notifications
      WHERE dismissed_at IS NULL AND read_at IS NULL
    `).get() as { count: number };
    return Number(row.count) || 0;
  }

  async readUnreadCount(): Promise<number> {
    const result = await this.native?.notificationData({ kind: "unreadCount" });
    return typeof result === "number" ? result : this.unreadCount();
  }

  markRead(id: string, at = Date.now()): boolean {
    return this.db.prepare(`
      UPDATE notifications
      SET read_at = COALESCE(read_at, ?)
      WHERE id = ? AND dismissed_at IS NULL AND read_at IS NULL
    `).run(at, id).changes > 0;
  }

  markReadByDedupeKey(dedupeKey: string, at = Date.now()): boolean {
    return this.db.prepare(`
      UPDATE notifications
      SET read_at = COALESCE(read_at, ?)
      WHERE dedupe_key = ? AND dismissed_at IS NULL AND read_at IS NULL
    `).run(at, dedupeKey).changes > 0;
  }

  markAllRead(at = Date.now()): number {
    return this.db.prepare(`
      UPDATE notifications
      SET read_at = ?
      WHERE dismissed_at IS NULL AND read_at IS NULL
    `).run(at).changes;
  }

  dismiss(id: string, at = Date.now()): boolean {
    return this.db.prepare(`
      UPDATE notifications
      SET dismissed_at = ?, read_at = COALESCE(read_at, ?)
      WHERE id = ? AND dismissed_at IS NULL
    `).run(at, at, id).changes > 0;
  }

  dismissAll(at = Date.now()): number {
    return this.db.prepare(`
      UPDATE notifications
      SET dismissed_at = ?, read_at = COALESCE(read_at, ?)
      WHERE dismissed_at IS NULL
    `).run(at, at).changes;
  }

  cleanup(now = Date.now(), maxAgeMs = 90 * 24 * 60 * 60 * 1000, maxRows = 1000): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch4a({
        kind: "notificationCleanup",
        cutoffAt: now - maxAgeMs,
        maxRows,
      }, "cleanup");
      return;
    }
    this.db.prepare(`DELETE FROM notification_activation_targets WHERE created_at < ?`).run(now - maxAgeMs);
    this.db.prepare(`DELETE FROM notification_activation_targets WHERE notification_id IN (
      SELECT notification_id FROM notification_activation_targets ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )`).run(maxRows);
    this.db.prepare(`DELETE FROM notifications WHERE created_at < ?`).run(now - maxAgeMs);
    this.db.prepare(`
      DELETE FROM notifications
      WHERE id IN (
        SELECT id FROM notifications
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(maxRows);
  }
}
