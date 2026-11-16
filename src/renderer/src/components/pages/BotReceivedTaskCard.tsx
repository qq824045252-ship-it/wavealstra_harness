import { useId, useRef, useState, type ReactNode } from "react";
import type { BotMessageDto, WorkFeedbackDto } from "@shared/bot-conversation";
import type { WorkProjectionDto } from "@shared/bot-work";
import type { BotReceivedTask } from "@/lib/botReceivedTasks";
import { botTaskReplyFeedbackCurrent, botTaskReplyMessageFeedback } from "@/lib/botTaskReplyPresentation";
import { IconMessageDashed, IconRefresh } from "@/components/common/icons";
import ChatMarkdown from "./BotChatMarkdown";
import { WorkReport } from "./BotWorkResult";
import { collaborationDisplayStatus, collaborationWorkStatus } from "./BotCallThread";
import "./BotTaskReply.css";

const stages = [{ id: "request", label: "接单" }, { id: "execution", label: "执行" },
  { id: "delivery", label: "交付" }, { id: "feedback", label: "反馈" }] as const;
type Stage = typeof stages[number]["id"];
type Entry = { key: string; stage: Stage; at: number; messageId?: string; feedbackMessageId?: string; content: ReactNode };

/** Recipient view of the public collaboration journal. Private peer prompts are
 * deliberately excluded: only durable public requests and assistant replies render. */
export function BotReceivedTaskCard({ board, work, renderMessage, onOpen, onRetrySummary, onInspect, loading, initialStage }: {
  board: BotReceivedTask; work?: WorkProjectionDto; renderMessage: (message: BotMessageDto) => ReactNode;
  onOpen: (collaborationId: string) => void; onRetrySummary: (messageId: string) => void;
  onInspect?: () => void; loading?: boolean; initialStage?: Stage;
}): React.JSX.Element {
  const id = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ key: string; stage: Stage } | undefined>(() => initialStage ? { key: board.key, stage: initialStage } : undefined);
  const [visited, setVisited] = useState<ReadonlySet<Stage>>(() => new Set(initialStage ? [initialStage] : []));
  const collaboration = board.collaboration;
  const workTitle = work?.title?.trim() || collaboration.work?.title?.trim();
  const title = workTitle || "受托任务";
  const markdown = (text: string) => <ChatMarkdown text={text} streaming={false} resolveTaskFiles={false} />;
  const historical = (feedback?: WorkFeedbackDto) => feedback && !botTaskReplyFeedbackCurrent(feedback, work)
    ? <p className="bot-task-reply-historical">历史版本记录 · 不代表当前任务已完成或已反馈</p> : null;
  const entries: Entry[] = [];
  const embedded = board.messages.filter(message => message.role === "assistant");
  const embeddedIds = new Set(embedded.map(message => message.messageId));
  const embeddedReplyIds = new Set(embedded.flatMap(message => message.peerOrigin?.kind === "request"
    && message.peerOrigin.collaborationId === collaboration.collaborationId ? [`${message.peerOrigin.exchangeId}:reply`] : []));
  for (const message of embedded) {
    const feedback = botTaskReplyMessageFeedback(message);
    const stage = feedback && !feedback.report?.milestone && (feedback.kind === "result" || feedback.kind === "closure")
      ? "delivery" : "execution";
    entries.push({ key: `message:${message.messageId}`, stage, at: message.createdAt, messageId: message.messageId,
      feedbackMessageId: message.workFeedback ? message.messageId : undefined,
      content: <>{historical(feedback)}{renderMessage(message)}</> });
  }
  for (const row of board.rows) {
    const { message, summary } = row;
    const fromSource = message.senderBotId === collaboration.sourceBotId;
    const stage: Stage = message.kind === "request" ? "request" : fromSource ? "feedback"
      : message.kind === "result" || message.kind === "reply" ? "delivery" : "execution";
    // Exact foreground receipt identity suppresses only that journal projection.
    // The independent source summary below is never suppressed with it.
    const represented = message.kind !== "request" && (row.foregroundMessageIds?.some(messageId => embeddedIds.has(messageId))
      || (!fromSource && embeddedReplyIds.has(message.operationId)));
    const report = message.workFeedback?.report;
    const displayReport = report && !botTaskReplyFeedbackCurrent(message.workFeedback!, work) ? { ...report, current: false } : report;
    if (!represented) entries.push({ key: `journal:${message.messageId}`, stage, at: message.createdAt,
      content: <>{historical(message.workFeedback)}<small>{message.senderDisplayName}</small>
        {displayReport ? <WorkReport report={displayReport} originalText={message.text}
          executionId={message.workFeedback?.executionId} work={work} renderMarkdown={markdown} /> : markdown(message.text)}</> });
    if (summary) entries.push({ key: `summary:${message.messageId}`, stage: "feedback", at: message.createdAt,
      content: <>{historical(message.workFeedback)}<small>{summary.generated ? "记录摘要" : `${summary.senderDisplayName} 整理`}</small>
        {summary.text.trim() ? markdown(summary.text) : <p className="bot-task-reply-empty">
          {summary.status === "running" || summary.status === "queued" ? "正在整理，原文已保留。" : "整理未完成，原文已保留。"}</p>}
        {summary.generated && summary.status === "failed" && <button type="button" className="bot-icon-button"
          aria-label="重试整理" title={summary.error ? `重试整理：${summary.error}` : "重试整理"} disabled={loading}
          onClick={() => onRetrySummary(message.messageId)}><IconRefresh size={18} /></button>}</> });
  }
  entries.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const defaultStage: Stage = entries.some(entry => entry.stage === "delivery") ? "delivery"
    : entries.some(entry => entry.stage === "execution") ? "execution" : "request";
  const selected = selection?.key === board.key ? selection.stage : defaultStage;
  const select = (stage: Stage) => {
    onInspect?.();
    setVisited(previous => new Set([...previous, selected, stage]));
    setSelection({ key: board.key, stage });
  };
  const status = work ? work.lifecycle === "closed"
    ? work.closureConclusion === "succeeded" ? "任务已完成" : work.closureConclusion === "cancelled" ? "任务已取消" : "任务已结束，未确认成功"
    : work.lifecycle === "paused" ? "任务已暂停" : work.lifecycle === "closing" ? "任务正在收尾" : "任务进行中"
    : collaboration.work ? collaborationWorkStatus(collaboration.work) : "尚未绑定正式任务";
  return <section className="bot-task-reply bot-received-task-card" data-received-task={collaboration.collaborationId}
    data-work-id={work?.workId ?? collaboration.workId ?? undefined} aria-label={`受托任务：${title}`}>
    <header className="bot-task-reply-heading"><h3>{workTitle ? `受托任务 · ${workTitle}` : title}</h3>
      <span className="bot-task-reply-status">{status}</span>
      <button type="button" className="bot-icon-button" aria-label="打开协作记录" title="打开协作记录"
        onClick={() => onOpen(collaboration.collaborationId)}><IconMessageDashed size={18} /></button>
    </header>
    <div className="bot-task-reply-progress"><span>来源：{collaboration.sourceDisplayName}</span>
      <span>负责人：{collaboration.targetDisplayName}</span><span>协作：{collaborationDisplayStatus(collaboration)}</span></div>
    <div ref={tabs} className="bot-task-reply-tabs" role="tablist" aria-label={`${title}的受托阶段`}>
      {stages.map((stage, index) => <button key={stage.id} type="button" role="tab" data-stage-id={stage.id}
        id={`${id}-tab-${stage.id}`} aria-controls={`${id}-panel-${stage.id}`} aria-selected={selected === stage.id}
        tabIndex={selected === stage.id ? 0 : -1} onClick={() => select(stage.id)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % stages.length : event.key === "ArrowLeft" ? (index + stages.length - 1) % stages.length
            : event.key === "Home" ? 0 : event.key === "End" ? stages.length - 1 : undefined;
          if (next === undefined) return;
          event.preventDefault(); select(stages[next].id); tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}>{stage.label}<span className="bot-task-stage-count">{entries.filter(entry => entry.stage === stage.id).length}</span></button>)}
    </div>
    {stages.map(stage => <div key={stage.id} role="tabpanel" data-stage-id={stage.id} className="bot-task-reply-panel" id={`${id}-panel-${stage.id}`}
      aria-labelledby={`${id}-tab-${stage.id}`} hidden={selected !== stage.id} tabIndex={0}>
      {entries.some(entry => entry.stage === stage.id) ? entries.filter(entry => entry.stage === stage.id).map(entry =>
        <div key={entry.key} className="bot-task-reply-update" data-record-id={entry.key}
          data-message-id={entry.messageId} data-feedback-message-id={entry.feedbackMessageId}>{(selected === stage.id || visited.has(stage.id)) && entry.content}</div>)
        : <p className="bot-task-reply-empty">{stage.id === "request" ? collaboration.requestPreview ?? "尚未加载公开委托原文。"
          : stage.id === "delivery" ? "尚无已加载交付记录，不代表任务已完成。" : stage.id === "feedback" ? "尚无已加载的委托方反馈。" : "尚无已加载执行记录。"}</p>}
    </div>)}
  </section>;
}
