import type { BotMessageDto } from "@shared/bot-conversation";
import type { WorkProjectionDto } from "@shared/bot-work";

export type BotWorkspaceView = "conversation" | "active" | "closed";

export function workStatusLabel(work: WorkProjectionDto): string {
  if (work.lifecycle === "closed") return work.closureConclusion === "succeeded" ? "已完成" : work.closureConclusion === "cancelled" ? "已取消" : work.closureConclusion === "ended_unsuccessfully" ? "已结束 · 未完成" : "已结束";
  if (work.lifecycle === "paused") return "已暂停";
  if (work.lifecycle === "closing") return "正在结算";
  return "进行中";
}

export function workMatchesView(work: WorkProjectionDto, view: BotWorkspaceView): boolean {
  if (view === "closed") return work.lifecycle === "closed";
  return work.lifecycle !== "closed";
}

export function botMessageStatus(message: BotMessageDto): string {
  if (message.status === "completed") return message.role === "user" ? "已发送" : "已回复";
  if (message.status === "running" && message.activity) {
    const { tool, status } = message.activity;
    const labels: Record<string, string> = { web_search: "搜索", fetch_content: "读取来源", work_query_status: "查询事项进展",
      work_create: "创建事项", work_amend: "更新事项", work_pause: "暂停事项", work_resume: "恢复事项", work_cancel: "取消事项", memory_search: "查询记忆" };
    const label = labels[tool] ?? "工具调用";
    if (status === "running") return tool === "web_search" ? "正在搜索实时信息" : `正在${label}`;
    return `${label}${status === "error" ? "未成功" : "已返回"}，正在整理回复`;
  }
  return { queued: "等待回复", running: "正在回复", cancelled: "已停止", unknown: "结果待核对", failed: "回复失败" }[message.status];
}

export function shouldSendBotComposer(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

/** Visibility does not confer owner control authority. The host validates every action. */
export function botParticipatesInWork(work: WorkProjectionDto, botId: string | null | undefined): boolean {
  return Boolean(botId && (work.ownerBotId === botId || work.team?.members.some(member => member.botId === botId)));
}

export type BotTimelineEntry = { key: string; kind: "message"; message: BotMessageDto }
  | { key: string; kind: "progress"; workId: string; messages: BotMessageDto[] };

/** Presentation only. Durable messages and order remain intact inside each fold.
 * Latest decisions/results stay visible; ordinary progress and older versions of
 * the exact same event can be expanded. Never classify by human-written text.
 */
export function botWorkTimeline(messages: BotMessageDto[]): BotTimelineEntry[] {
  const latest = new Map<string, string>();
  const eventKey = (message: BotMessageDto) => JSON.stringify([message.conversationId,
    message.workFeedback?.workId, message.workFeedback?.eventId]);
  for (const message of messages) if (message.role === "assistant" && message.workFeedback)
    latest.set(eventKey(message), message.messageId);
  const rows: BotTimelineEntry[] = [];
  for (const message of messages) {
    const feedback = message.role === "assistant" && message.status === "completed" ? message.workFeedback : undefined;
    const fold = feedback && !message.error && (feedback.category === "progress" || latest.get(eventKey(message)) !== message.messageId);
    const previous = rows.at(-1);
    if (!fold) rows.push({ key: message.messageId, kind: "message", message });
    else if (previous?.kind === "progress" && previous.workId === feedback.workId)
      previous.messages.push(message);
    else rows.push({ key: `progress:${message.messageId}`, kind: "progress", workId: feedback.workId, messages: [message] });
  }
  return rows;
}

/** Stop targets the running reply, not a later message waiting in the send queue. */
export function activeBotReply(messages: BotMessageDto[]): BotMessageDto | undefined {
  return messages.find(message => message.role === "assistant" && message.status === "running")
    ?? messages.find(message => message.role === "assistant" && ["queued", "unknown"].includes(message.status));
}
