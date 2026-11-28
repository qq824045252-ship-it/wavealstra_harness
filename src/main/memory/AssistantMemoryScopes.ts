import type { AppDatabase } from "../db/AppDatabase";
import { hasGatewayDotsMemory } from "../gateway/GatewayDotsBindings";
import { DOTS_TASK_ID } from "../../shared/dots";
import { isGatewayConversation } from "../../shared/gateway-task";
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
    if (request.taskId && isGatewayConversation(request.taskId)) {
      return !request.scopeTypes?.length || request.scopeTypes.includes("task")
        ? [{ scopeType: "task", scopeId: request.taskId, distance: 0 },
          ...(hasGatewayDotsMemory(db.connection, request.taskId) ? [{ scopeType: "task" as const, scopeId: DOTS_TASK_ID, distance: 1 }] : [])] : [];
    }
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

export interface CoreMemoryRecallAuthority {
  scopes: ReturnType<typeof resolveAssistantScopeChain>;
  witness: string;
}

type WorkScopeInfo = { bot_id: string; work_id: string; project_id: string | null; team_id: string | null; is_team: boolean; shared: boolean };
type BotSourceInfo = { conversation_id: string; bot_id: string; team_id: string | null; user_id: string; source_kind: string; status: string; shared: boolean; peer: boolean };
type DirectWorkInfo = { work_id: string; owner_bot_id: string; project_id: string | null; team_id: string | null; is_team: boolean; shared: boolean };

export async function resolveWorkMemoryScopeAsync(db: AppDatabase, taskId: string): Promise<WorkScopeInfo | undefined> {
  if (!db.coreIdentity) return resolveWorkMemoryScope(db, taskId);
  const ctx = await db.runtimeAuditReader?.memoryRecordsData({ kind: "assistantScopeContext", taskId, userId: LOCAL_USER_ID });
  if (!ctx || ctx.kind !== "assistantScopeContext") throw new Error("Core 未确认 Work 记忆作用域");
  return (ctx.workScope as WorkScopeInfo | null) ?? undefined;
}

export async function resolveAssistantScopeChainAsync(
  db: AppDatabase,
  request: MemorySearchRequest,
  channelBotIdAsync: (taskId: string) => Promise<string | undefined> | string | undefined,
): Promise<Array<{ scopeType: MemoryScopeType; scopeId?: string; distance: number }>> {
  if (!db.coreIdentity) return resolveAssistantScopeChain(db, request, taskId => {
    const res = channelBotIdAsync(taskId);
    return typeof res === "string" || res === undefined ? res : undefined;
  });
  const task = request.taskId ? await db.readTask(request.taskId, { includeExpertBinding: false }) : undefined;
  const ctx = await db.runtimeAuditReader?.memoryRecordsData({
    kind: "assistantScopeContext",
    taskId: request.taskId,
    workId: request.workId,
    conversationId: request.conversationId ?? request.taskId,
    userId: LOCAL_USER_ID,
  });
  if (!ctx || ctx.kind !== "assistantScopeContext") throw new Error("Core 未确认助手记忆作用域");
  if (request.taskId && isGatewayConversation(request.taskId)) {
    return !request.scopeTypes?.length || request.scopeTypes.includes("task")
      ? [{ scopeType: "task", scopeId: request.taskId, distance: 0 },
        ...(ctx.hasGatewayDotsMemory ? [{ scopeType: "task" as const, scopeId: DOTS_TASK_ID, distance: 1 }] : [])] : [];
  }
  const work = (request.taskId ? ctx.workScope : null) as WorkScopeInfo | null;
  const conversation = (!work && (request.taskId || request.conversationId) ? ctx.botSource : null) as BotSourceInfo | null;
  const taskId = request.taskId ?? task?.id;
  const directWork = (!taskId && !conversation && request.workId ? ctx.directWork : null) as DirectWorkInfo | null;
  const projectId = work ? work.project_id ?? undefined : directWork ? directWork.project_id ?? undefined
    : conversation ? undefined : task ? task.projectId ?? undefined : request.taskId ? undefined : request.projectId;
  const workspaceId = work || conversation || directWork ? undefined
    : task ? task.spaceId ?? undefined : request.taskId ? undefined : request.workspaceId;
  const out: Array<{ scopeType: MemoryScopeType; scopeId?: string; distance: number }> = [];
  const teamId = work?.team_id ?? conversation?.team_id ?? directWork?.team_id ?? (!taskId && !conversation && !directWork ? request.teamId : undefined);
  const isTeam = Boolean(teamId || work?.is_team || directWork?.is_team);
  const shared = conversation?.shared || work?.shared || directWork?.shared || false;
  const botId = isTeam || shared ? undefined : work?.bot_id ?? conversation?.bot_id ?? directWork?.owner_bot_id ?? (taskId ? await channelBotIdAsync(taskId) : request.botId);
  if (conversation) out.push({ scopeType: "conversation", scopeId: conversation.conversation_id, distance: 0 });
  if (work || directWork) out.push({ scopeType: "work", scopeId: work?.work_id ?? directWork!.work_id, distance: 0 });
  if (teamId) out.push({ scopeType: "team", scopeId: teamId, distance: 1 });
  if (botId) out.push({ scopeType: "bot", scopeId: botId, distance: 1 });
  if (taskId && !conversation) out.push({ scopeType: "task", scopeId: taskId, distance: 0 });
  if (projectId) out.push({ scopeType: "project", scopeId: projectId, distance: 1 });
  if (workspaceId) {
    out.push({ scopeType: "workspace", scopeId: workspaceId, distance: 2 });
    if (request.includeInherited !== false) {
      const spaces = await db.readSpaces();
      const byId = new Map(spaces.map(s => [s.id, s]));
      const visited = new Set([workspaceId]);
      let parent = byId.get(workspaceId)?.parentId;
      let idx = 0;
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        const anc = byId.get(parent);
        if (!anc) break;
        if (!anc.effectiveArchived) out.push({ scopeType: "workspace", scopeId: anc.id, distance: 3 + idx });
        idx += 1;
        parent = anc.parentId;
      }
    }
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

/** Ordinary desktop recall derives scope from Core. Other conversation owners need their own authority. */
export async function readCoreRecallAuthority(db: AppDatabase, request: MemorySearchRequest): Promise<CoreMemoryRecallAuthority | undefined> {
  const native = db.runtimeAuditReader;
  if (!native || !db.isOpen || request.botId || request.teamId || request.workId || request.conversationId) return;
  const taskId = request.taskId;
  const allowed = request.scopeTypes?.length ? new Set(request.scopeTypes) : undefined;
  const filter = (scopes: CoreMemoryRecallAuthority["scopes"]) => scopes.filter(scope => !allowed || allowed.has(scope.scopeType));
  if (!taskId) {
    if (request.projectId || request.workspaceId) return;
    const scopes = filter([{ scopeType: "global", distance: 10 }]);
    return { scopes, witness: JSON.stringify(["local-global", scopes]) };
  }
  if (taskId === DOTS_TASK_ID || isGatewayConversation(taskId) || /^(?:gw-|bot-(?:inbox|gateway|conversation)-)/.test(taskId)) return;
  const [task, work, channelBot, workspace, durable] = await Promise.all([
    db.readTask(taskId, { includeExpertBinding: false }),
    native.readWorkTaskAccess(taskId),
    native.readBotRegistry({ kind: "channel", userId: LOCAL_USER_ID, channelType: "desktop", channelIdentifier: JSON.stringify([LOCAL_USER_ID, taskId]) }),
    db.readWorkspaceData({ kind: "navigation", userId: LOCAL_USER_ID }),
    native.readDurableOpenState(taskId),
  ]);
  if (!db.isOpen || !task || task.gatewaySidebarChannelId || !work?.taskExists || work.hasWorkBinding || channelBot !== null || !workspace?.navigation || !durable || durable.trashed
    || workspace.navigation.conversations.some(conversation => conversation.conversationId === taskId)) return;

  const scopes: CoreMemoryRecallAuthority["scopes"] = [{ scopeType: "task", scopeId: taskId, distance: 0 }];
  if (task.projectId) scopes.push({ scopeType: "project", scopeId: task.projectId, distance: 1 });
  if (task.spaceId) {
    const byId = new Map(workspace.spaces.map(space => [space.id, space]));
    if (!byId.has(task.spaceId)) return;
    scopes.push({ scopeType: "workspace", scopeId: task.spaceId, distance: 2 });
    const visited = new Set([task.spaceId]);
    let parent = byId.get(task.spaceId)?.parentId;
    while (parent && request.includeInherited !== false) {
      if (visited.has(parent)) return;
      const ancestor = byId.get(parent);
      if (!ancestor) return;
      if (!ancestor.effectiveArchived) scopes.push({ scopeType: "workspace", scopeId: parent, distance: visited.size + 2 });
      visited.add(parent);
      parent = ancestor.parentId;
    }
  }
  scopes.push({ scopeType: "global", distance: 10 });
  const visible = filter(scopes);
  return { scopes: visible, witness: JSON.stringify([task.id, task.projectId, task.spaceId, task.archived, scopes, visible]) };
}
