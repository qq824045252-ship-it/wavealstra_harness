import type Database from 'better-sqlite3';
import type { BotDirectoryActivityDto, BotDirectoryActivitySnapshotDto } from '../../../shared/bot-work-ipc';

const zero = (): BotDirectoryActivityDto => ({ activeWorks: 0, completedWorks: 0, activeReplies: 0 });
const exists = (db: Database.Database, table: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

/** Directory presence only: no pages, no search, no projection bodies. Work counters
 * follow that Bot's own personal tabs and team counters follow the team's tabs, so a
 * badge always equals the number the user sees after opening that row. Foreground
 * replies are counted separately: a queued or streaming answer is output too, even
 * when it carries no Work. Archived and deleted Works stay out of both counters. */
export function readBotDirectoryActivity(db: Database.Database, userId: string): BotDirectoryActivitySnapshotDto {
  return db.transaction(() => {
    const archive = exists(db, 'work_record_archive');
    const archiveJoin = archive ? 'LEFT JOIN work_record_archive a ON a.work_id=w.work_id' : '';
    const kept = archive ? 'a.deleted_at IS NULL' : '1';
    const open = archive ? 'a.archived_at IS NULL' : '1';
    const column = (kind: 'active' | 'completed'): string => kind === 'active'
      ? `sum(CASE WHEN w.lifecycle!='closed' AND ${open} THEN 1 ELSE 0 END) AS active`
      : `sum(CASE WHEN w.lifecycle='closed' AND w.closure_conclusion='succeeded' AND ${open} THEN 1 ELSE 0 END) AS completed`;
    const readWorks = (sql: string): Record<string, BotDirectoryActivityDto> =>
      Object.fromEntries((db.prepare(sql).all(userId) as Array<{ id: string; active: number; completed: number }>)
        .filter(row => row.active > 0 || row.completed > 0)
        .map(row => [row.id, { ...zero(), activeWorks: row.active, completedWorks: row.completed }]));
    const teams = exists(db, 'work_team_ownership') && exists(db, 'work_teams');
    const visibility = teams && exists(db, 'work_team_record_visibility')
      ? 'LEFT JOIN work_team_record_visibility v ON v.work_id=w.work_id' : '';
    const removed = visibility ? 'v.removed_at IS NULL' : '1';
    const bots = readWorks(`SELECT w.owner_bot_id AS id, ${column('active')}, ${column('completed')}
      FROM works w ${archiveJoin}
      ${teams ? 'LEFT JOIN work_teams t ON t.work_id=w.work_id AND t.user_id=w.user_id' : ''}
      WHERE w.user_id=? AND ${kept} ${teams ? 'AND t.work_id IS NULL' : ''}
      GROUP BY w.owner_bot_id`);
    const teamActivity = teams ? readWorks(`SELECT o.team_id AS id, ${column('active')}, ${column('completed')}
      FROM works w ${archiveJoin}
      JOIN work_teams t ON t.work_id=w.work_id AND t.user_id=w.user_id
      JOIN work_team_ownership o ON o.work_id=w.work_id
      ${visibility}
      WHERE w.user_id=? AND ${kept} AND ${removed}
      GROUP BY o.team_id`) : {};
    // The Bot itself is answering: count it on its own row even inside a team
    // conversation, and on the team row the conversation belongs to.
    for (const row of db.prepare(`SELECT m.bot_id AS bot_id, c.team_id AS team_id, count(*) AS n
      FROM bot_messages m JOIN bot_conversations c ON c.conversation_id=m.conversation_id
      WHERE c.user_id=? AND m.role='assistant' AND m.status IN ('queued','running')
      GROUP BY m.bot_id, c.team_id`).all(userId) as Array<{ bot_id: string; team_id: string | null; n: number }>) {
      (bots[row.bot_id] ?? (bots[row.bot_id] = zero())).activeReplies += row.n;
      if (row.team_id) (teamActivity[row.team_id] ?? (teamActivity[row.team_id] = zero())).activeReplies += row.n;
    }
    return { bots, teams: teamActivity };
  }).deferred();
}
