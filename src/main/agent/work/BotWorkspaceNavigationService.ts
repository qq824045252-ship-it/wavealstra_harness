import { createHash } from 'node:crypto';
import type { AppDatabase } from '../../db/AppDatabase';
import type { BotWorkspaceNavigationDto, BotWorkspaceRequestDto } from '../../../shared/bot-workspace-navigation';

const digest = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 24);
export const botWorkspaceSpaceId = (id: string) => `bot-space-${digest(id)}`;
export const teamWorkspaceSpaceId = (id: string) => `bot-team-space-${digest(id)}`;
/** Navigation-only organization. Never touches cwd, bindings, files or execution state. */
export class BotWorkspaceNavigationService {
  constructor(private readonly db: AppDatabase, private readonly userId: string) {
    db.connection.exec(`CREATE TABLE IF NOT EXISTS bot_workspace_navigation_spaces (space_id TEXT PRIMARY KEY, auto_name TEXT NOT NULL)`);
  }
  private group(kind: 'bot' | 'team'): string {
    const id = `bot-workspace-group-${kind}-${digest(this.userId)}`;
    this.ensure(id, kind === 'bot' ? 'Bot' : 'Bot团队', null);
    return id;
  }
  private ensure(id: string, name: string, parentId: string | null): void {
    const old = this.db.getSpace(id);
    const managed = this.db.connection.prepare('SELECT auto_name FROM bot_workspace_navigation_spaces WHERE space_id=?').get(id) as {auto_name:string}|undefined;
    const peer = this.db.connection.prepare('SELECT id FROM spaces WHERE parent_id IS ? AND name=? COLLATE NOCASE AND id<>?').get(parentId, name, id);
    const desiredName = peer ? `${name} · ${digest(id).slice(0, 8)}` : name;
    if (!old) this.db.upsertSpace({ id, name: desiredName, parentId });
    else if (!managed) {
      // One-time navigation migration only; user-selected paths and archive state survive.
      const collision = this.db.connection.prepare('SELECT id FROM spaces WHERE parent_id IS ? AND name=? COLLATE NOCASE AND id<>?').get(parentId,old.name,id);
      this.db.connection.prepare('UPDATE spaces SET parent_id=?,name=?,updated_at=? WHERE id=?')
        .run(parentId,collision ? `${old.name} · ${digest(id).slice(0,8)}` : old.name,Date.now(),id);
    } else if (old.name === managed.auto_name && old.name !== desiredName) {
      // Follow identity rename, but never undo a manually renamed/moved space.
      const collision = this.db.connection.prepare('SELECT id FROM spaces WHERE parent_id IS ? AND name=? COLLATE NOCASE AND id<>?').get(old.parentId ?? null,desiredName,id);
      this.db.connection.prepare('UPDATE spaces SET name=?,updated_at=? WHERE id=?').run(collision ? `${name} · ${digest(id).slice(0,8)}` : desiredName,Date.now(),id);
    }
    if (!managed || managed.auto_name !== desiredName) this.db.connection.prepare('INSERT INTO bot_workspace_navigation_spaces VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET auto_name=excluded.auto_name').run(id,desiredName);
  }
  ensureBot(botId: string): string {
    const bot = this.db.connection.prepare('SELECT display_name FROM bots WHERE bot_id=? AND user_id=?').get(botId, this.userId) as {display_name:string} | undefined;
    if (!bot) throw new Error('Bot 不属于当前用户');
    const id = botWorkspaceSpaceId(botId); this.ensure(id, `${bot.display_name} · 工作空间`, this.group('bot')); return id;
  }
  ensureTeam(teamId: string, fallbackName?: string): string {
    const team = this.db.connection.prepare('SELECT name FROM work_team_templates WHERE template_id=? AND user_id=?').get(teamId, this.userId) as {name:string} | undefined;
    if (!team && !fallbackName) throw new Error('团队不存在');
    const id = teamWorkspaceSpaceId(teamId); this.ensure(id, `${team?.name ?? fallbackName} · 工作空间`, this.group('team')); return id;
  }
  spaceForWork(workId: string, botId: string): string {
    if (!this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_team_ownership'").get()) return this.ensureBot(botId);
    const team = this.db.connection.prepare(`SELECT o.team_id,o.team_name FROM work_team_ownership o JOIN works w ON w.work_id=o.work_id WHERE o.work_id=? AND w.user_id=?`).get(workId,this.userId) as {team_id:string;team_name:string}|undefined;
    return team ? this.ensureTeam(team.team_id,team.team_name) : this.ensureBot(botId);
  }
  snapshot(): BotWorkspaceNavigationDto {
    return this.db.transaction(() => {
      const bots = this.db.connection.prepare('SELECT bot_id FROM bots WHERE user_id=?').all(this.userId) as {bot_id:string}[];
      bots.forEach(bot => this.ensureBot(bot.bot_id));
      const teams = this.db.connection.prepare('SELECT template_id,name FROM work_team_templates WHERE user_id=? AND deleted_at IS NULL').all(this.userId) as {template_id:string;name:string}[];
      teams.forEach(team => this.ensureTeam(team.template_id,team.name));
      // Repair the display owner only. In-flight and historical native cwd remain untouched.
      const tasks = this.db.connection.prepare(`SELECT d.task_id,w.work_id,w.owner_bot_id FROM work_dispatch_requests d JOIN works w ON w.work_id=d.work_id WHERE w.user_id=?
        UNION SELECT e.task_id,w.work_id,w.owner_bot_id FROM work_team_executions e JOIN works w ON w.work_id=e.work_id WHERE w.user_id=?`).all(this.userId,this.userId) as {task_id:string;work_id:string;owner_bot_id:string}[];
      const assign = this.db.connection.prepare('UPDATE tasks SET space_id=? WHERE id=? AND space_id IS NOT ?');
      const taskSpaces = tasks.map(task => { const spaceId=this.spaceForWork(task.work_id,task.owner_bot_id); assign.run(spaceId,task.task_id,spaceId); return {taskId:task.task_id,spaceId}; });
      const rows = this.db.connection.prepare(`SELECT r.bot_id,r.request_id,r.conversation_id,r.assistant_message_id AS message_id,c.team_id,c.archived_at,
        u.text AS title,a.status,u.created_at,a.updated_at FROM bot_send_receipts r
        JOIN bot_conversations c ON c.conversation_id=r.conversation_id JOIN bot_messages u ON u.message_id=r.user_message_id
        JOIN bot_messages a ON a.message_id=r.assistant_message_id WHERE r.user_id=? AND c.user_id=? ORDER BY u.created_at DESC,r.request_id`).all(this.userId,this.userId) as Array<{bot_id:string;request_id:string;conversation_id:string;message_id:string;team_id:string|null;archived_at:number|null;title:string;status:BotWorkspaceRequestDto['status'];created_at:number;updated_at:number}>;
      const foregroundRequests = rows.map(row => ({id:`bot-request:${row.bot_id}:${row.request_id}`,spaceId:row.team_id ? this.ensureTeam(row.team_id,'历史团队') : this.ensureBot(row.bot_id),
        botId:row.bot_id,teamId:row.team_id ?? undefined,conversationId:row.conversation_id,requestId:row.request_id,messageId:row.message_id,
        title:row.title.trim().replace(/\s+/g,' ').slice(0,120) || '附件对话',status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,archived:row.archived_at !== null}));
      return {spaces:this.db.listSpaces(),taskSpaces,foregroundRequests};
    });
  }
}
