import type { AppDatabase } from "../db/AppDatabase";
import { LOCAL_USER_ID } from "../../shared/bot-work";
import type { MemoryScopeType, MemorySearchRequest } from "../../shared/memory-kernel";
import { botMemorySource, botWorkHasSharedOrigin } from "./BotMemorySource";

/** Authoritative assistant ownership graph; model hints never override persisted bindings. */
export function resolveWorkMemoryScope(db: AppDatabase, taskId: string): { bot_id: string; work_id: string; project_id: string | null; team_id: string | null; is_team: boolean; shared: boolean } | undefined {
    // Executing collaborators/subagents do not change the owner of personal Work memory.
    const row = db.connection.prepare(`SELECT w.owner_bot_id AS bot_id,b.work_id,w.project_id FROM work_execution_bindings b
      JOIN works w ON w.work_id=b.work_id WHERE b.task_id=? AND w.user_id=? ORDER BY b.admitted_at DESC, b.rowid DESC LIMIT 1`)
      .get(taskId, LOCAL_USER_ID) as { bot_id: string; work_id: string; project_id: string | null } | undefined;
    if (!row) return undefined;
    const has = (table: string) => Boolean(db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const ownership = has("work_team_ownership") ? db.connection.prepare("SELECT team_id FROM work_team_ownership WHERE work_id=?").get(row.work_id) as { team_id: string } | undefined : undefined;
    const isTeam = has("work_teams") && Boolean(db.connection.prepare("SELECT 1 FROM work_teams WHERE work_id=?").get(row.work_id));
    return { ...row, team_id: ownership?.team_id ?? null, is_team: isTeam, shared: botWorkHasSharedOrigin(db, row.work_id) };
  }


export function resolveAssistantScopeChain(db: AppDatabase, request: MemorySearchRequest, channelBotId: (taskId: string) => string | undefined): Array<{ scopeType: MemoryScopeType; scopeId?: string; distance: number }> {
    const task = request.taskId ? db.getTask(request.taskId) : undefined;
    const work = request.taskId ? resolveWorkMemoryScope(db, request.taskId) : undefined;
    const conversationId = request.taskId ? (!work ? request.taskId : undefined) : request.conversationId;
    const conversation = conversationId ? botMemorySource(db, conversationId) : undefined;
    const taskId = request.taskId ?? task?.id;
    // Execution/conversation identities are authoritative: request hints cannot add another owner's scope.
    const directWork = !taskId && !conversation && request.workId
      ? db.connection.prepare("SELECT work_id,owner_bot_id,project_id FROM works WHERE work_id=? AND user_id=?").get(request.workId, LOCAL_USER_ID) as { work_id: string; owner_bot_id: string; project_id: string | null } | undefined : undefined;
    const projectId = work ? work.project_id ?? undefined : directWork ? directWork.project_id ?? undefined
      : conversation ? undefined : task ? task.projectId ?? undefined : request.taskId ? undefined : request.projectId;
    const workspaceId = work || conversation || directWork ? undefined
      : task ? task.spaceId ?? undefined : request.taskId ? undefined : request.workspaceId;
    const out: Array<{ scopeType: MemoryScopeType; scopeId?: string; distance: number }> = [];
    let teamId = work?.team_id ?? conversation?.team_id ?? (!taskId && !conversation && !directWork ? request.teamId : undefined);
    if (directWork && db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_team_ownership'").get()) {
      const row = db.connection.prepare("SELECT team_id FROM work_team_ownership WHERE work_id=?").get(directWork.work_id) as { team_id: string } | undefined;
      teamId = row?.team_id;
    }
    const directIsTeam = Boolean(directWork
      && db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_teams'").get()
      && db.connection.prepare("SELECT 1 FROM work_teams WHERE work_id=?").get(directWork.work_id));
    const isTeam = Boolean(teamId || work?.is_team || directIsTeam);
    const shared = conversation?.shared || work?.shared || Boolean(directWork && botWorkHasSharedOrigin(db, directWork.work_id));
    const botId = isTeam || shared ? undefined : work?.bot_id ?? conversation?.bot_id ?? directWork?.owner_bot_id ?? (taskId ? channelBotId(taskId) : request.botId);
    if (conversation) out.push({ scopeType: "conversation", scopeId: conversation.conversation_id, distance: 0 });
    if (work || directWork) out.push({ scopeType: "work", scopeId: work?.work_id ?? directWork!.work_id, distance: 0 });
    if (teamId) out.push({ scopeType: "team", scopeId: teamId, distance: 1 });
    if (botId) out.push({ scopeType: "bot", scopeId: botId, distance: 1 });
    if (taskId && !conversation) out.push({ scopeType: "task", scopeId: taskId, distance: 0 });
    if (projectId) out.push({ scopeType: "project", scopeId: projectId, distance: 1 });
    if (workspaceId) {
      out.push({ scopeType: "workspace", scopeId: workspaceId, distance: 2 });
      if (request.includeInherited !== false) db.getSpaceAncestors(workspaceId).forEach((space, index) => {
        if (!space.effectiveArchived) out.push({ scopeType: "workspace", scopeId: space.id, distance: 3 + index });
      });
    }
    if (!shared) out.push({ scopeType: "global", distance: 10 });
    const allowed = request.scopeTypes?.length ? new Set(request.scopeTypes) : null;
    const seen = new Set<string>();
    return out.filter(scope => {
      if (shared && !["work", "task", "conversation"].includes(scope.scopeType)) return false;
      if (allowed && !allowed.has(scope.scopeType)) return false;
      const key = `${scope.scopeType}:${scope.scopeId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
