import type Database from 'better-sqlite3';
import type { BotWorkIndicatorsDto } from '../../../shared/bot-work-ipc';

type Row = { id: string; active: number; completed: number };
const exists = (db: Database.Database, table: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

/** Directory counters only: no pages, no search, no projection bodies. Bot rows
 * follow that Bot's own personal tabs and team rows follow the team's tabs, so a
 * badge always equals the number the user sees after opening that row. Archived
 * and deleted Works stay out of both counters, exactly like the tab totals. */
export function readBotWorkIndicators(db: Database.Database, userId: string): BotWorkIndicatorsDto {
  return db.transaction(() => {
    const archive = exists(db, 'work_record_archive');
    const archiveJoin = archive ? 'LEFT JOIN work_record_archive a ON a.work_id=w.work_id' : '';
    const kept = archive ? 'a.deleted_at IS NULL' : '1';
    const open = archive ? 'a.archived_at IS NULL' : '1';
    const column = (kind: 'active' | 'completed'): string => kind === 'active'
      ? `sum(CASE WHEN w.lifecycle!='closed' AND ${open} THEN 1 ELSE 0 END) AS active`
      : `sum(CASE WHEN w.lifecycle='closed' AND w.closure_conclusion='succeeded' AND ${open} THEN 1 ELSE 0 END) AS completed`;
    const read = (sql: string): Record<string, { active: number; completed: number }> =>
      Object.fromEntries((db.prepare(sql).all(userId) as Row[])
        .filter(row => row.active > 0 || row.completed > 0)
        .map(row => [row.id, { active: row.active, completed: row.completed }]));
    const teams = exists(db, 'work_team_ownership') && exists(db, 'work_teams');
    const visibility = teams && exists(db, 'work_team_record_visibility')
      ? 'LEFT JOIN work_team_record_visibility v ON v.work_id=w.work_id' : '';
    const removed = visibility ? 'v.removed_at IS NULL' : '1';
    return {
      bots: read(`SELECT w.owner_bot_id AS id, ${column('active')}, ${column('completed')}
        FROM works w ${archiveJoin}
        ${teams ? 'LEFT JOIN work_teams t ON t.work_id=w.work_id AND t.user_id=w.user_id' : ''}
        WHERE w.user_id=? AND ${kept} ${teams ? 'AND t.work_id IS NULL' : ''}
        GROUP BY w.owner_bot_id`),
      teams: teams ? read(`SELECT o.team_id AS id, ${column('active')}, ${column('completed')}
        FROM works w ${archiveJoin}
        JOIN work_teams t ON t.work_id=w.work_id AND t.user_id=w.user_id
        JOIN work_team_ownership o ON o.work_id=w.work_id
        ${visibility}
        WHERE w.user_id=? AND ${kept} AND ${removed}
        GROUP BY o.team_id`) : {},
    };
  }).deferred();
}
