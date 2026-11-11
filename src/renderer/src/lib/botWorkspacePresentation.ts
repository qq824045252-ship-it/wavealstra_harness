import { watchEndedByTime } from "@shared/work-watch-expiry";
import { watchPresentation } from "./botWatchPresentation";
import { isWorkArchived } from "@shared/bot-work-archive";
import { getMarkdown } from "stream-markdown-parser";
import type { BotMessageDto } from "@shared/bot-conversation";
import type { WorkProjectionDto } from "@shared/bot-work";

export type BotWorkspaceView = "conversation" | "active" | "completed" | "closed";

/** Execution and acceptance are separate facts. No display state mutates Work. */
export function workExecutionComplete(work: WorkProjectionDto): boolean {
  const bindings = work.executions.filter(item => item.intentRevision === work.intentRevision
    && item.inputSnapshotId === work.inputSnapshotId && !item.invalidatedAt && item.status !== "invalidated");
  return bindings.length > 0 && bindings.every(item => item.status === "completed")
    && !work.phase3?.settlingActions
    && !work.runtimeObservations?.some(item => bindings.some(binding => binding.bindingId === item.bindingId)
      && ["running", "recovering", "waiting"].includes(item.state));
}

export type WorkStatusGroup = "running" | "waiting" | "attention" | "results" | "watching" | "paused"
  | "succeeded" | "cancelled" | "unsuccessful" | "ended";

/** Labels and list filters share one decision, never infer state from report text. */
export function workStatus(work: WorkProjectionDto): { label: string; group: WorkStatusGroup } {
  if (work.listSummary) return work.listSummary.status;
  if (watchEndedByTime({ ...work, watchRule: work.watchPlan })) return { label: "到期结束", group: "ended" };
  if (work.lifecycle === "closed") {
    if (work.closureConclusion === "succeeded") return { label: "已完成", group: "succeeded" };
    if (work.closureConclusion === "cancelled") return { label: "已取消", group: "cancelled" };
    if (work.closureConclusion === "ended_unsuccessfully") return { label: "已结束 · 未完成", group: "unsuccessful" };
    return { label: "已结束", group: "ended" };
  }
  if (work.archive?.archivedAt) return { label: "已归档 · 未完成", group: "unsuccessful" };
  if (work.lifecycle === "paused") return { label: "已暂停", group: "paused" };
  if (work.lifecycle === "closing") return { label: work.watchPlan?.termination ? "已到期 · 正在结算" : "正在结算", group: "running" };
  if (work.mode === "watch") return watchPresentation(work);
  const blockers = work.blockers.filter(item => item.status === "open" && item.kind !== "external_effect" && !item.unknownExternalEffectRef);
  if (blockers.some(item => item.waitingForUserInput)) return { label: "等待补充信息", group: "attention" };
  if (blockers.length) return { label: "需要处理", group: "attention" };
  if (workExecutionComplete(work)) {
    if (work.phase3?.gaps.some(item => item.required) || work.criteria.some(item => item.status === "failed" || item.status === "blocked")) return { label: "执行已结束 · 尚有缺口", group: "attention" };
    return { label: work.inputSnapshotBound && work.criteria.length > 0 && work.criteria.every(item => item.status === "satisfied" || item.status === "waived")
      && !work.uncoveredScope.length ? "正在整理最终结果" : "正在核对结果", group: "results" };
  }
  const current = work.executions.filter(item => item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId && !item.invalidatedAt);
  if (current.some(item => item.status === "running" || item.status === "submitted")) return { label: "正在执行", group: "running" };
  if (current.some(item => item.status === "unknown")) return { label: "执行状态待核对", group: "attention" };
  if (current.some(item => item.status === "pending")) return { label: "等待执行", group: "waiting" };
  if (current.some(item => item.status === "failed" || item.status === "stopped")) return { label: "执行已结束 · 未完成", group: "attention" };
  return { label: "尚未执行", group: "waiting" };
}

export function workStatusLabel(work: WorkProjectionDto): string {
  return workStatus(work).label;
}

/** Index full text, not the shortened list excerpt, so older results stay findable. */
export function workSearchText(work: WorkProjectionDto): string {
  return [work.workId, work.title, work.goalDescription, work.closureSummary, ...work.criteria.map(item => item.text),
    ...work.nextSteps, ...work.blockers.filter(item => item.status === "open").map(item => item.reason),
    ...work.deliverables.map(item => item.summary), ...work.deliverables.flatMap(item => item.artifactRefs),
    ...(work.generatedArtifacts ?? []).flatMap(item => [item.path, item.snapshotPath])]
    .filter(Boolean).join("\n").normalize("NFKC").toLocaleLowerCase();
}

export function workMatchesSearch(text: string, query: string): boolean {
  return query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).every(term => text.includes(term));
}

export function workMatchesView(work: WorkProjectionDto, view: BotWorkspaceView): boolean {
  if (work.archive?.deletedAt) return false;
  if (view === "closed") return isWorkArchived(work);
  if (isWorkArchived(work)) return false;
  if (view === "completed") return work.lifecycle === "closed" && work.closureConclusion === "succeeded";
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

/** A request links both durable records for provenance. Show shared navigation
 * on its input once; retain reply-only Work and independent background feedback.
 * No text/title matching or cross-turn deduplication: associations are not messages.
 */
export function botMessageWorkLinks(message: BotMessageDto, sourceQuestion?: BotMessageDto): string[] {
  const workIds = [...new Set(message.workIds)];
  if (message.role !== "assistant" || message.workFeedback || sourceQuestion?.role !== "user"
    || message.requestId !== sourceQuestion.requestId || message.conversationId !== sourceQuestion.conversationId
    || message.botId !== sourceQuestion.botId || message.teamId !== sourceQuestion.teamId) return workIds;
  const inputWorkIds = new Set(sourceQuestion.workIds);
  return workIds.filter(workId => !inputWorkIds.has(workId));
}

export function shouldSendBotComposer(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

/** Visibility does not confer owner control authority. The host validates every action. */
export function botParticipatesInWork(work: WorkProjectionDto, botId: string | null | undefined): boolean {
  return Boolean(botId && (work.ownerBotId === botId || work.team?.members.some(member => member.botId === botId)));
}

/** Team commissions belong to their team, not each member's personal inbox/count. */
export function personalBotWork(work: WorkProjectionDto, botId: string | null | undefined): boolean {
  return !work.team && botParticipatesInWork(work, botId);
}

/** A source conversation may inspect its linked team result without adding it
 * to personal lists/counts. Never infer an association from text or an ID alone. */
export function linkedConversationWork(work: WorkProjectionDto, messages: BotMessageDto[], botId: string | null | undefined,
  teamId: string | undefined, conversationId: string | undefined): boolean {
  return Boolean(conversationId && work.team && !work.team.removedAt && !work.archive?.deletedAt
    && botParticipatesInWork(work, botId)
    && messages.some(message => message.role === "assistant" && message.botId === botId
      && message.teamId === teamId && message.conversationId === conversationId && message.workIds.includes(work.workId)));
}

export type BotTimelineEntry = { key: string; kind: "message"; message: BotMessageDto }
  | { key: string; kind: "progress"; workId: string; workIds: string[]; messages: BotMessageDto[] };

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
    else if (previous?.kind === "progress" && previous.messages[0].conversationId === message.conversationId) {
      previous.messages.push(message);
      if (!previous.workIds.includes(feedback.workId)) previous.workIds.push(feedback.workId);
    } else rows.push({ key: `progress:${message.messageId}`, kind: "progress", workId: feedback.workId, workIds: [feedback.workId], messages: [message] });
  }
  return rows;
}

/** Stop targets the running reply, not a later message waiting in the send queue. */
export function activeBotReply(messages: BotMessageDto[]): BotMessageDto | undefined {
  return messages.find(message => message.role === "assistant" && message.status === "running")
    ?? messages.find(message => message.role === "assistant" && ["queued", "unknown"].includes(message.status));
}


const excerptMarkdown = getMarkdown("bot-work-card-excerpt");
type ExcerptToken = { type: string; content: string; children?: ExcerptToken[] | null };

/** A bounded, plain-text excerpt, not a generated summary or a new outcome.
 * Only the list preview is shortened. Reports, paths and evidence remain intact
 * in the work details and original conversation message.
 */
export function workCardExcerpt(markdown: string, title?: string): string {
  const parts: string[] = [];
  let heading = false;
  let table = false;
  const shortPath = (path: string): string => {
    const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
    return !name || /^[a-f\d]{24,}(?:\.|$)/i.test(name) ? "成果文件" : name;
  };
  const inlineText = (tokens: ExcerptToken[]): string => tokens.map(token => {
    if (token.type === "softbreak" || token.type === "hardbreak") return " ";
    if (token.type === "code_inline" && /^(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))/.test(token.content)) return shortPath(token.content);
    if (token.type === "text" || token.type === "code_inline" || token.type === "math_inline") return token.content;
    // Do not render HTML, images, link destinations or fenced source code in a card.
    return token.children && token.type !== "image" ? inlineText(token.children) : "";
  }).join("");
  for (const token of excerptMarkdown.parse(markdown, {})) {
    if (token.type === "heading_open") heading = true;
    if (token.type === "heading_close") heading = false;
    if (token.type === "table_open") table = true;
    if (token.type === "table_close") table = false;
    if (token.type !== "inline" || table) continue;
    const text = inlineText(token.children ?? []).replace(/\s+/g, " ").trim();
    // A heading can carry a failure or caveat. Only omit an exact duplicate of
    // the title already shown on this card; preserve every other heading in order.
    if (text && !(heading && text === title)) parts.push(text);
  }
  const text = parts.join(" ")
    .replace(/(?<![\w:/])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s`<>|，。；、）)]+/g, shortPath)
    .replace(/\b[a-f\d]{32,}\b/gi, "（校验值见原文）");
  if (!text) return "打开查看完整内容与附件。";
  const points = Array.from(text);
  return points.length > 120 ? `${points.slice(0, 119).join("").trimEnd()}…` : text;
}
