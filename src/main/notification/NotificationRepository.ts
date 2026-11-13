import { notificationTarget, parseNotificationTarget, type NotificationActivationTarget } from "../../shared/notification";
import type Database from "better-sqlite3";
import type {
  NotificationDto,
  NotificationLevel,
  NotificationListRequest,
  NotificationSourceType,
  NotificationType,
} from "../../shared/notification";

interface NotificationSqlRow {
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
}

function mapRow(row: NotificationSqlRow): NotificationDto {
  return {
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
}

export class NotificationRepository {
  constructor(private readonly db: Database.Database) {
    // Separate from bell visibility: desktop-only notifications must survive restart.
    this.db.exec(`CREATE TABLE IF NOT EXISTS notification_activation_targets (
      notification_id TEXT PRIMARY KEY, target_json TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
  }

  saveActivation(record: NotificationDto): void {
    const target = notificationTarget(record);
    if (!target) return;
    this.db.prepare(`INSERT OR REPLACE INTO notification_activation_targets VALUES (?, ?, ?)`)
      .run(record.id, JSON.stringify(target), record.createdAt);
  }

  resolveActivation(id: string, now = Date.now()): NotificationActivationTarget | null {
    const row = this.db.prepare(`SELECT target_json FROM notification_activation_targets WHERE notification_id = ? AND created_at >= ?`)
      .get(id, now - 90 * 24 * 60 * 60 * 1000) as { target_json: string } | undefined;
    if (row) { try { return parseNotificationTarget(JSON.parse(row.target_json)); } catch { return null; } }
    const legacy = this.db.prepare(`SELECT * FROM notifications WHERE id = ? AND created_at >= ?`)
      .get(id, now - 90 * 24 * 60 * 60 * 1000) as NotificationSqlRow | undefined;
    return legacy ? notificationTarget(mapRow(legacy)) : null;
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
      .get(dedupeKey) as NotificationSqlRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  list(request: NotificationListRequest = {}): NotificationDto[] {
    const limit = Math.max(1, Math.min(500, Math.floor(request.limit ?? 100)));
    const where = request.unreadOnly
      ? "dismissed_at IS NULL AND read_at IS NULL"
      : "dismissed_at IS NULL";
    const rows = this.db.prepare(`
      SELECT * FROM notifications
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as NotificationSqlRow[];
    return rows.map(mapRow);
  }

  unreadCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM notifications
      WHERE dismissed_at IS NULL AND read_at IS NULL
    `).get() as { count: number };
    return Number(row.count) || 0;
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
