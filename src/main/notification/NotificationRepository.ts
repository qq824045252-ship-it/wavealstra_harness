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
  constructor(private readonly db: Database.Database) {}

  insert(record: NotificationDto): { record: NotificationDto; inserted: boolean } {
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
    if (result.changes > 0) return { record, inserted: true };
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
