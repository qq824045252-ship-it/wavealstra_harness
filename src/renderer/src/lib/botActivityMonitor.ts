import type { Task } from "@/types";
import type { BotDto, WorkProjectionDto } from "@shared/bot-work";
import type { BotActiveRequestDto, BotHistoryDto } from "@shared/bot-conversation";
import type { SubagentSummaryDto } from "@shared/agent-ipc";
import { activeExecutionLabel, deriveTaskStatus, hasPendingApproval, hasPendingConversationInteraction } from "@/utils/taskFilters";
import { botMessageStatus, workStatus, workCardExcerpt } from "./botWorkspacePresentation";
import { buildRuntimeOverview } from "@/components/artifact/overview/overviewRuntime";

export type ActivityKind = "task" | "subagent" | "bot" | "work";
export interface ActivityRow {
  id: string; kind: ActivityKind; title: string; owner: string; label: string;
  running: boolean; ended: boolean; detail: string; updatedAt: number;
  taskId?: string; subagentId?: string; botId?: string; workId?: string; messageId?: string; sourceRequest?: BotActiveRequestDto; teamWork?: boolean; teamId?: string;
}
export const activityKindLabels: Record<ActivityKind, string> = { task: "普通任务", subagent: "子代理", bot: "Bot 对话", work: "Bot Work" };
function taskText(task: Task): string {
  const last = [...task.messages].reverse().find(message => message.role === "assistant" || message.role === "user");
  return last?.blocks.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("\n") ?? "";
}
/** Read-only projection: Work bindings are represented once, under their Work.
 * No status is inferred from prose, task titles or a successful tool call. */
export function buildActivityRows(input: {
  tasks: Task[]; works: WorkProjectionDto[]; bots: BotDto[];
  histories: Record<string, BotHistoryDto>; subagents: Record<string, SubagentSummaryDto[]>;
  now: number; activeRequests?: BotActiveRequestDto[]; scopeBotId?: string | null; scopeTeamId?: string;
}): ActivityRow[] {
  // Default UI scope is one Bot. Team work never belongs to a member's
  // personal inbox; unbound ordinary tasks appear only in explicit global view.
  if (input.scopeTeamId) {
    const teamId = input.scopeTeamId;
    const works = input.works.filter(work => work.team?.teamId === teamId);
    const taskIds = new Set(works.flatMap(work => work.executions.map(binding => binding.taskId)));
    input = { ...input, works, tasks: input.tasks.filter(task => taskIds.has(task.id)),
      histories: Object.fromEntries(Object.entries(input.histories).filter(([, history]) => history.teamId === teamId)),
      activeRequests: input.activeRequests?.filter(request => request.message.teamId === teamId) };
  } else if (input.scopeBotId !== undefined && input.scopeBotId !== null) {
    const botId = input.scopeBotId;
    const works = input.works.filter(work => work.ownerBotId === botId && !work.team);
    const taskIds = new Set(works.flatMap(work => work.executions.map(binding => binding.taskId)));
    input = { ...input, works, tasks: input.tasks.filter(task => taskIds.has(task.id)),
      bots: input.bots.filter(bot => bot.botId === botId),
      histories: Object.fromEntries(Object.entries(input.histories).filter(([, history]) => history.botId === botId && !history.teamId)),
      activeRequests: input.activeRequests?.filter(request => request.message.botId === botId && !request.message.teamId) };
  }
  const rows: ActivityRow[] = [];
  // A current stream may have advanced after the active-request query.
  // Prefer its newer terminal observation rather than reviving a finished reply.
  const activeRequests = (input.activeRequests ?? []).filter(request => {
    const newer = input.histories[request.message.teamId ? `team:${request.message.teamId}` : request.message.botId]?.messages.find(item => item.messageId === request.message.messageId);
    return !(newer && newer.updatedAt >= request.message.updatedAt && ["completed", "failed", "cancelled"].includes(newer.status));
  });
  const activeMessageIds = new Set(activeRequests.map(request => request.message.messageId));
  const names = new Map(input.bots.map(bot => [bot.botId, bot.displayName]));
  const workTasks = new Set(input.works.flatMap(work => work.executions.map(binding => binding.taskId)));
  for (const task of input.tasks) {
    if (task.archived) continue;
    const status = deriveTaskStatus(task);
    const pending = hasPendingApproval(task) || hasPendingConversationInteraction(task) || task.durable?.status === "waiting_input";
    const terminal = task.durable && !task.durable.busy && ["failed", "stopped", "completed"].includes(task.durable.status ?? "");
    const running = !pending && !terminal && (task.durable?.busy === true || (!task.durable && status === "in_progress" && task.messages.some(message => message.streaming)));
    const ended = !pending && !running && (Boolean(terminal) || status === "completed" || status === "failed");
    if (!workTasks.has(task.id)) rows.push({
      id: "task:" + task.id, kind: "task", title: task.title, owner: "普通模式",
      label: pending ? "等待回复" : running ? "执行中" : (status === "failed" && !task.durable?.status) || task.durable?.status === "failed" ? "执行失败" : task.durable?.status === "stopped" ? "已停止" : ended ? "已结束" : status === "in_progress" ? "运行状态待核实" : "尚未执行",
      running, ended, detail: [task.progressSteps?.length ? task.progressSteps.filter(step => step.status === "done").length + "/" + task.progressSteps.length + " 步已完成" : "", activeExecutionLabel(task) ?? taskText(task)].filter(Boolean).join(" · "), updatedAt: task.updatedAt, taskId: task.id,
    });
    const overview = buildRuntimeOverview({ taskId: task.id, messages: task.messages, activeSubagents: input.subagents[task.id] ?? [], terminalSessions: {}, now: input.now });
    for (const row of overview.runningSubagents) {
      const executing = input.subagents[task.id]?.find(item => item.subagentId === row.id)?.status === "running";
      rows.push({ id: "sub:" + task.id + ":" + row.id, kind: "subagent", title: row.name,
      owner: task.title, label: executing ? "执行中" : "等待工具调用", running: executing, ended: false, detail: row.work, updatedAt: task.updatedAt, taskId: task.id, subagentId: row.id });
    }
    // Queue facts belong to a currently executing dispatch, not old plan text.
    if (running) for (const row of overview.queuedSubagents) rows.push({ id: "queue:" + task.id + ":" + row.id, kind: "subagent", title: row.name,
      owner: task.title, label: "排队中", running: false, ended: false, detail: row.task, updatedAt: task.updatedAt, taskId: task.id });
  }
  for (const history of Object.values(input.histories)) {
    if (history.archived) continue;
    for (const message of history.messages) {
      if (message.role !== "assistant" || message.workFeedback || activeMessageIds.has(message.messageId)) continue;
      const prompt = history.messages.find(item => item.requestId === message.requestId && item.role === "user");
      rows.push({ id: "bot:" + message.messageId, kind: "bot", title: prompt?.text || "Bot 对话",
        owner: message.teamId ? input.works.find(work => work.team?.teamId === message.teamId)?.team?.teamName ?? "团队对话" : names.get(message.botId) ?? "Bot", label: botMessageStatus(message),
        running: message.status === "running", ended: !["queued", "running", "unknown"].includes(message.status),
        detail: message.text || message.error || botMessageStatus(message), updatedAt: message.updatedAt, botId: message.botId, teamId: message.teamId, messageId: message.messageId });
    }
  }
  for (const request of activeRequests) {
    const message = request.message;
    if (!["queued", "running", "unknown"].includes(message.status)) continue;
    const inCurrentWindow = input.histories[message.teamId ? `team:${message.teamId}` : message.botId]?.messages.some(item => item.messageId === message.messageId)
      && !input.histories[message.teamId ? `team:${message.teamId}` : message.botId]?.archived;
    rows.push({ id: "bot:" + message.messageId, kind: "bot", title: request.prompt?.text || "Bot 对话",
      owner: message.teamId ? input.works.find(work => work.team?.teamId === message.teamId)?.team?.teamName ?? "团队对话" : names.get(message.botId) ?? "Bot", label: botMessageStatus(message), running: message.status === "running",
      ended: false, detail: message.text || message.error || botMessageStatus(message), updatedAt: message.updatedAt,
      botId: message.botId, teamId: message.teamId, messageId: message.messageId, sourceRequest: inCurrentWindow ? undefined : request });
  }
  for (const work of input.works) {
    if (work.team?.removedAt || work.archive?.archivedAt) continue;
    const status = workStatus(work);
    const latest = [...work.deliverables].reverse().find(item => item.status === "accepted" || item.status === "proposed");
    const completed = work.criteria.filter(item => item.status === "satisfied" || item.status === "waived").length;
    const currentBindings = work.executions.filter(item => item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId && !item.invalidatedAt);
    const executing = work.lifecycle === "closing" || (work.lifecycle === "active" && currentBindings.some(item => item.status === "running"));
    const submittedOnly = status.group === "running" && !executing;
    rows.push({ id: "work:" + work.workId, kind: "work", title: work.title, owner: work.team?.teamName ? work.team.teamName + " · " + (names.get(work.ownerBotId) ?? "Bot") : names.get(work.ownerBotId) ?? "Bot",
      label: submittedOnly ? "已提交，等待执行" : status.label, running: executing, ended: work.lifecycle === "closed",
      detail: [work.criteria.length ? completed + "/" + work.criteria.length + " 项目标已核验" : "",
        work.blockers.find(item => item.status === "open")?.reason || latest?.summary || work.nextSteps[0]].filter(Boolean).join(" · "),
      updatedAt: work.updatedAt, botId: work.ownerBotId, workId: work.workId, teamWork: Boolean(work.team) });
  }
  return rows.map(row => ({ ...row, title: workCardExcerpt(row.title) || "未命名任务", detail: workCardExcerpt(row.detail) }))
    .sort((a, b) => Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
