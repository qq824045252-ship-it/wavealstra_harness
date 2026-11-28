import { createHash } from 'node:crypto';
import type { AppDatabase } from '../../db/AppDatabase';
import type { BotWorkspaceNavigationDto, BotWorkspaceRequestDto } from '../../../shared/bot-workspace-navigation';
import { enqueueWorkOp, overlayReadOne, overlaySet, requiresWorkRustWrites, workDomainRunTx } from './WorkDomainRuntime';

const digest = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 24);
export const botWorkspaceSpaceId = (id: string) => `bot-space-${digest(id)}`;
export const teamWorkspaceSpaceId = (id: string) => `bot-team-space-${digest(id)}`;
/** Navigation-only organization. Never touches cwd, bindings, files or execution state. */
export class BotWorkspaceNavigationService {
  constructor(private readonly db: AppDatabase, private readonly userId: string) {}
  private ensureRegistry(): void {
    const fixture = this.db.fixtureConnection;
    if (fixture && !this.db.readonly && !this.db.coreIdentity) {
      fixture.exec(`CREATE TABLE IF NOT EXISTS bot_workspace_navigation_spaces (space_id TEXT PRIMARY KEY, auto_name TEXT NOT NULL)`);
    }
  }
  private group(kind: 'bot' | 'team'): string {
    const id = `bot-workspace-group-${kind}-${digest(this.userId)}`;
    this.ensure(id, kind === 'bot' ? 'Bot' : 'Bot团队', null);
    return id;
  }
  private ensure(id: string, name: string, parentId: string | null): void {
    this.ensureRegistry();
    const conn = this.db.connection;
    const rust = requiresWorkRustWrites(conn);
    const old = overlayReadOne<{ id: string; name: string; parentId: string | null }>(conn, 'spaces', id, () => {
      const s = this.db.getSpace(id);
      return s ? { id: s.id, name: s.name, parentId: s.parentId ?? null } : undefined;
    });
    const managed = overlayReadOne<{ space_id: string; auto_name: string }>(conn, 'bot_workspace_navigation_spaces', id, () =>
      conn.prepare('SELECT space_id,auto_name FROM bot_workspace_navigation_spaces WHERE space_id=?').get(id) as { space_id: string; auto_name: string } | undefined);
    const peer = conn.prepare('SELECT id FROM spaces WHERE parent_id IS ? AND name=? COLLATE NOCASE AND id<>?').get(parentId, name, id);
    const desiredName = peer ? `${name} · ${digest(id).slice(0, 8)}` : name;
    const now = Date.now();
    if (!old) {
      if (rust) {
        overlaySet(conn, 'spaces', id, { id, name: desiredName, parentId });
        enqueueWorkOp(conn, { op: 'botSpaceCreate', id, name: desiredName, parentId, updatedAt: now });
      } else this.db.upsertSpace({ id, name: desiredName, parentId });
    } else if (!managed) {
      // One-time navigation migration only; user-selected paths and archive state survive.
      const collision = conn.prepare('SELECT id FROM spaces WHERE parent_id IS ? AND name=? COLLATE NOCASE AND id<>?').get(parentId,old.name,id);
      const nextName = collision ? `${old.name} · ${digest(id).slice(0,8)}` : old.name;
      if (rust) {
        overlaySet(conn, 'spaces', id, { id, name: nextName, parentId });
        enqueueWorkOp(conn, { op: 'botSpaceUpdate', id, name: nextName, parentId, updateParent: true, updatedAt: now });
      } else conn.prepare('UPDATE spaces SET parent_id=?,name=?,updated_at=? WHERE id=?').run(parentId, nextName, now, id);
    } else if (old.name === managed.auto_name && old.name !== desiredName) {
      // Follow identity rename, but never undo a manually renamed/moved space.
      const collision = conn.prepare('SELECT id FROM spaces WHERE parent_id IS ? AND name=? COLLATE NOCASE AND id<>?').get(old.parentId ?? null,desiredName,id);
      const nextName = collision ? `${name} · ${digest(id).slice(0,8)}` : desiredName;
      if (rust) {
        overlaySet(conn, 'spaces', id, { id, name: nextName, parentId: old.parentId ?? null });
        enqueueWorkOp(conn, { op: 'botSpaceUpdate', id, name: nextName, parentId: null, updateParent: false, updatedAt: now });
      } else conn.prepare('UPDATE spaces SET name=?,updated_at=? WHERE id=?').run(nextName, now, id);
    }
    if (!managed || managed.auto_name !== desiredName) {
      if (rust) {
        overlaySet(conn, 'bot_workspace_navigation_spaces', id, { space_id: id, auto_name: desiredName });
        enqueueWorkOp(conn, { op: 'botNavSpaceUpsert', spaceId: id, autoName: desiredName });
      } else conn.prepare('INSERT INTO bot_workspace_navigation_spaces VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET auto_name=excluded.auto_name').run(id,desiredName);
    }
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

  async readSpaces(): Promise<BotWorkspaceNavigationDto['spaces']> {
    const data = await this.db.readWorkspaceData({ kind: 'visibleSpaces', userId: this.userId });
    return data?.spaces ?? this.snapshot({ repair: false }).spaces;
  }

  async readNavigation(): Promise<BotWorkspaceNavigationDto> {
    const data = await this.db.readWorkspaceData({ kind: 'navigation', userId: this.userId });
    if (!data?.navigation) return this.snapshot({ repair: false });
    const trimTitle = <T extends { title: string }>(row: T): T => ({ ...row, title: row.title.slice(0, 120) });
    return {
      spaces: data.spaces,
      taskSpaces: [],
      foregroundRequests: data.navigation.foregroundRequests.map(trimTitle),
      conversations: data.navigation.conversations.map(trimTitle),
    };
  }

  // This only omits generated empty folders from the view. It never deletes user data.
  private visibleSpaces(historySpaces: ReadonlySet<string>) {
    const spaces = this.db.listSpaces();
    if (!this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_workspace_navigation_spaces'").get()) return spaces;
    const generated = new Map((this.db.connection.prepare('SELECT space_id,auto_name FROM bot_workspace_navigation_spaces').all() as {space_id:string;auto_name:string}[]).map(row => [row.space_id,row.auto_name]));
    const groupIds = new Set(['bot','team'].map(kind => `bot-workspace-group-${kind}-${digest(this.userId)}`));
    const used = this.db.connection.prepare(`SELECT 1 FROM (
      SELECT space_id AS space FROM tasks UNION ALL SELECT space_id FROM cron_jobs
      UNION ALL SELECT default_space_id FROM projects UNION ALL SELECT workspace_id FROM workspace_notes
      UNION ALL SELECT workspace_id FROM library_spaces UNION ALL SELECT workspace_id FROM workspace_library_links
      UNION ALL SELECT workspace_id FROM workspace_library_collection_links
      UNION ALL SELECT scope_id FROM gadgets WHERE scope_type='workspace'
      UNION ALL SELECT scope_id FROM memory_scopes WHERE scope_type='workspace'
      ) WHERE space=? LIMIT 1`);
    const eligible = (id: string, name: string, path?: string) =>
      !path && generated.get(id) === name && !historySpaces.has(id) && !used.get(id);
    const hidden = new Set(spaces.filter(space => /^(?:bot-space|bot-team-space)-[a-f0-9]{24}$/.test(space.id)
      && !!space.parentId && groupIds.has(space.parentId) && eligible(space.id,space.name,space.path)
      && !spaces.some(child => child.parentId === space.id)).map(space => space.id));
    for (const space of spaces) {
      if (groupIds.has(space.id) && !space.parentId && eligible(space.id,space.name,space.path)
        && !spaces.some(child => child.parentId === space.id && !hidden.has(child.id))) hidden.add(space.id);
    }
    return spaces.filter(space => !hidden.has(space.id));
  }

  snapshot({ repair = true }: {repair?: boolean} = {}): BotWorkspaceNavigationDto {
    const conn = this.db.connection;
    const rust = requiresWorkRustWrites(conn);
    const run = () => {
      const lookupSpace = (botId: string, teamId: string | null) => repair
        ? teamId ? this.ensureTeam(teamId,'历史团队') : this.ensureBot(botId)
        : teamId ? teamWorkspaceSpaceId(teamId) : botWorkspaceSpaceId(botId);
      let taskSpaces: BotWorkspaceNavigationDto['taskSpaces'] = [];
      if (repair) {
        const bots = conn.prepare('SELECT bot_id FROM bots WHERE user_id=?').all(this.userId) as {bot_id:string}[];
        bots.forEach(bot => this.ensureBot(bot.bot_id));
        const teams = conn.prepare('SELECT template_id,name FROM work_team_templates WHERE user_id=? AND deleted_at IS NULL').all(this.userId) as {template_id:string;name:string}[];
        teams.forEach(team => this.ensureTeam(team.template_id,team.name));
        // Repair the display owner only. In-flight and historical native cwd remain untouched.
        const tasks = conn.prepare(`SELECT d.task_id,w.work_id,w.owner_bot_id FROM work_dispatch_requests d JOIN works w ON w.work_id=d.work_id WHERE w.user_id=?
          UNION SELECT e.task_id,w.work_id,w.owner_bot_id FROM work_team_executions e JOIN works w ON w.work_id=e.work_id WHERE w.user_id=?`).all(this.userId,this.userId) as {task_id:string;work_id:string;owner_bot_id:string}[];
        const assign = rust ? undefined : conn.prepare('UPDATE tasks SET space_id=? WHERE id=? AND space_id IS NOT ?');
        taskSpaces = tasks.map(task => {
          const spaceId = this.spaceForWork(task.work_id, task.owner_bot_id);
          if (rust) enqueueWorkOp(conn, { op: 'botTaskAssignSpace', taskId: task.task_id, spaceId });
          else assign!.run(spaceId, task.task_id, spaceId);
          return { taskId: task.task_id, spaceId };
        });
      }
      const rows = conn.prepare(`SELECT r.bot_id,r.request_id,r.conversation_id,r.assistant_message_id AS message_id,c.team_id,c.archived_at,
        u.text AS title,a.status,u.created_at,a.updated_at FROM bot_send_receipts r
        JOIN bot_conversations c ON c.conversation_id=r.conversation_id JOIN bot_messages u ON u.message_id=r.user_message_id
        JOIN bot_messages a ON a.message_id=r.assistant_message_id WHERE r.user_id=? AND c.user_id=? ORDER BY u.created_at DESC,r.request_id`).all(this.userId,this.userId) as Array<{bot_id:string;request_id:string;conversation_id:string;message_id:string;team_id:string|null;archived_at:number|null;title:string;status:BotWorkspaceRequestDto['status'];created_at:number;updated_at:number}>;
      const foregroundRequests = rows.map(row => ({id:`bot-request:${row.bot_id}:${row.request_id}`,spaceId:lookupSpace(row.bot_id,row.team_id),
        botId:row.bot_id,teamId:row.team_id ?? undefined,conversationId:row.conversation_id,requestId:row.request_id,messageId:row.message_id,
        title:row.title.trim().replace(/\s+/g,' ').slice(0,120) || '附件对话',status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,archived:row.archived_at !== null}));
      // Conversation nodes are navigation projections, not extra mutable spaces.
      // Empty persisted chats remain visible; internal result inboxes are not chats.
      const conversationRows = conn.prepare(`SELECT c.conversation_id,c.bot_id,c.team_id,c.created_at,c.updated_at,c.archived_at,
        (SELECT m.text FROM bot_messages m WHERE m.conversation_id=c.conversation_id AND m.role='user' ORDER BY m.ordinal LIMIT 1) AS title
        FROM bot_conversations c WHERE c.user_id=? AND c.conversation_id NOT LIKE 'bot-inbox-%'
        ORDER BY c.created_at DESC,c.conversation_id`).all(this.userId) as Array<{conversation_id:string;bot_id:string;team_id:string|null;created_at:number;updated_at:number;archived_at:number|null;title:string|null}>;
      const conversations = conversationRows.map(row => ({conversationId:row.conversation_id,botId:row.bot_id,teamId:row.team_id ?? undefined,
        spaceId:lookupSpace(row.bot_id,row.team_id),
        title:row.title?.trim().replace(/\s+/g,' ').slice(0,120) || '新对话',createdAt:row.created_at,updatedAt:row.updated_at,archived:row.archived_at !== null}));
      if (repair) return {spaces:this.db.listSpaces(),taskSpaces,foregroundRequests,conversations};
      const spaces = this.visibleSpaces(new Set([...foregroundRequests,...conversations].map(row => row.spaceId)));
      const existing = new Set(spaces.map(space => space.id));
      return {spaces,taskSpaces,foregroundRequests:foregroundRequests.filter(row => existing.has(row.spaceId)),
        conversations:conversations.filter(row => existing.has(row.spaceId))};
    };
    return rust ? workDomainRunTx(conn, run) : this.db.transaction(run);
  }
}
