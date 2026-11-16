import { memo, useCallback } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import { botExternalAgentTaskId, botMessageDisplayText, type BotMessageDto } from "@shared/bot-conversation";
import { useAppStore } from "@/store/appStore";
import { rewriteMarkdownImageSources } from "@shared/markdown-images";
import { artifactImageUrl } from "@shared/artifact-ipc";
import { ChatImageScope } from "@/components/chat/ChatImage";
import { ComposerAttachmentChips } from "@/components/chat/ComposerAttachmentChips";
import { BotDelegationReference, BotReplyReference } from "./BotReplyReference";
import { BotAvatar } from "../common/BotAvatar";
import { BotReplyMetrics } from "./BotReplyMetrics";
import { BotCallThread } from "./BotCallThread";
import { BotOrganizationActivity } from "./BotOrganizationActivity";
import { BotMessageActions } from "./BotMessageActions";
import ChatMarkdown from "./BotChatMarkdown";
import { IconBot, IconChevronRight, IconListTodo } from "@/components/common/icons";
import { botMessageStatus, botMessageWorkLinks, type BotTaskReplyGroup } from "@/lib/botWorkspacePresentation";
import { botTaskReplyFeedbackCurrent } from "@/lib/botTaskReplyPresentation";
import { BotResultReport, BotReturnedFiles } from "./BotWorkResult";
import BotMessageHtmlFiles from "./BotMessageHtmlFiles";
import BotToolResults from "./BotToolResults";
import { BotTaskReply } from "./BotTaskReply";
import "./BotWorkspacePage.css";
const TimelineMessage = memo(BotMessage);
export function BotMessage({ message, botName, works, onOpenWork, onOpenCollaboration, onCancel, sourceQuestion, sourceQuestions, workLinkSource, onReply, onSearchFollowup, taskReplies, messageInTask, embedded = false, readOnly = true }: { workLinkSource?: BotMessageDto; sourceQuestion?: BotMessageDto; sourceQuestions?: ReadonlyMap<string, BotMessageDto>; onReply?: (message: BotMessageDto) => void; message: BotMessageDto; botName: string; works: WorkProjectionDto[]; onOpenWork: (id: string) => void; onOpenCollaboration?: (id: string) => void; onCancel: (message: BotMessageDto) => void; onSearchFollowup?: (text: string) => void; taskReplies?: BotTaskReplyGroup[]; messageInTask?: boolean; embedded?: boolean; readOnly?: boolean }): React.JSX.Element {
  const externalTask = useAppStore(state => state.tasks.find(task => task.id === botExternalAgentTaskId(message.messageId)));
  // Replace trusted image destinations before Markdown parsing: raw Windows
  // backslashes (e.g. \.mybuddy) otherwise become Markdown escapes.
  const renderMarkdown = (text: string, streaming = message.status === "running") => <ChatImageScope taskId={message.reportImages?.taskId ?? null} artifacts={message.reportImages?.artifacts ?? []} sources={message.reportImages?.sources ?? {}}><ChatMarkdown resolveTaskFiles={false} text={rewriteMarkdownImageSources(text, source => {
    const id = message.reportImages?.sources[source];
    const image = message.reportImages?.artifacts.find(item => item.id === id);
    return image ? artifactImageUrl(image.id, "full", { version: image.version }) : source;
  })} streaming={streaming} /></ChatImageScope>;
  const linkedWorkIds = embedded ? [] : botMessageWorkLinks(message, workLinkSource ?? sourceQuestion)
    .filter(workId => !taskReplies?.some(task => task.workId === workId));
  const contentInTask = !embedded && (messageInTask ?? Boolean(taskReplies?.some(task => task.messages.includes(message))));
  const renderTaskMessage = useCallback((update: BotMessageDto) => <TimelineMessage message={update} embedded botName={botName}
    works={works} onOpenWork={onOpenWork} onOpenCollaboration={onOpenCollaboration} onReply={onReply}
    sourceQuestion={sourceQuestions?.get(update.requestId) ?? (sourceQuestion?.requestId === update.requestId ? sourceQuestion : undefined)}
    onCancel={onCancel} onSearchFollowup={onSearchFollowup} readOnly={readOnly} />,
  [botName, works, onOpenWork, onOpenCollaboration, onReply, onCancel, onSearchFollowup, sourceQuestions, sourceQuestion, readOnly]);
  const result = message.role === "assistant" && message.status === "completed" && message.workFeedback?.report
    && (embedded || message.workFeedback.kind === "result" || (message.workFeedback.kind === "binding"
      && message.workFeedback.category === "progress" && message.workFeedback.report.milestone));
  const reportMessage = embedded && message.workFeedback?.report
    && !botTaskReplyFeedbackCurrent(message.workFeedback, works.find(work => work.workId === message.workFeedback?.workId))
    ? { ...message, workFeedback: { ...message.workFeedback, report: { ...message.workFeedback.report, current: false } } } : message;
  const running = message.role === "assistant" && ["queued", "running", "unknown"].includes(message.status);
  const nonemptySegments = message.segments?.filter(segment => segment.text.trim()) ?? [];
  const hasModelText = Boolean(message.text.trim()) || nonemptySegments.some(segment => segment.kind !== "receipt");
  const segments = nonemptySegments.filter(segment => segment.kind !== "receipt" || !hasModelText);
  const receiptOnly = segments.length > 0 && !hasModelText;
  const showActivity = running && !(receiptOnly && !message.activity && message.status !== "unknown");
  const hasContent = Boolean(message.text) || segments.length > 0 || Boolean(result);
  // A reply to a delegated request starts with the host-recorded task, so the
  // recipient conversation never shows an answer without the delegated task.
  const delegation = message.role === "assistant" && message.peerOrigin?.kind === "request" ? message.peerOrigin : undefined;
  const delegationWorkId = message.workFeedback?.workId ?? message.workIds[0];
  const delegationTitle = delegation ? works.find(work => work.workId === delegationWorkId)?.title : undefined;
  const author = message.peerOrigin && message.role === "user" ? `来自 ${message.peerOrigin.senderDisplayName} · Bot 协作` : message.role === "user" ? "你" : botName;
  const Container = embedded ? "section" : "article";
  return <Container className={embedded ? "bot-task-reply-record" : `bot-message msg-row ${message.role}`} data-message-id={embedded ? undefined : message.messageId} data-streaming={message.role === "assistant" && message.status === "running" ? "true" : undefined} aria-label={`${author}的消息`}>
    {message.role === "user" && message.peerOrigin && <div className="bot-message-author"><strong>{author}</strong></div>}
    {message.role === "assistant" && !embedded && <div className="bot-message-author"><BotAvatar botId={message.botId} name={botName} /><strong>{botName}</strong></div>}
    {!contentInTask && delegation && <BotDelegationReference senderName={delegation.senderDisplayName} taskTitle={delegationTitle} />}
    {!contentInTask && message.role === "assistant" && sourceQuestion && !sourceQuestion.peerOrigin && !message.workFeedback && <BotReplyReference message={sourceQuestion} />}

    {message.role === "user" ? <div className="user-bubble">{Boolean(message.attachments?.length) && <div className="input-attach-chips"><ComposerAttachmentChips attachments={message.attachments ?? []} /></div>}{message.text && <div className="user-bubble-text">{botMessageDisplayText(message.text)}</div>}</div> : <div className="bot-assistant-content">
      {!contentInTask && <>
      <BotToolResults tools={message.tools} taskId={message.toolTaskId} messageId={message.messageId} onSearchFollowup={onSearchFollowup} />
      {result ? <BotResultReport message={reportMessage} work={works.find(work => work.workId === message.workFeedback?.workId)} renderMarkdown={renderMarkdown} />
        : segments.length > 0 ? segments.map((segment, index) => <div key={segment.id} data-segment-id={segment.id} data-segment-kind={segment.kind} aria-label={segment.kind === "receipt" ? "消息回执" : undefined} className={`bot-reply-segment bot-reply-segment-${segment.kind}`}>
          {renderMarkdown(segment.text, message.status === "running" && segment.kind === "answer" && index === segments.length - 1)}
        </div>) : message.text ? renderMarkdown(message.text) : null}
      {(showActivity || !hasContent) && <p className="bot-reply-placeholder" role={running ? "status" : undefined}>{message.status === "completed" ? "没有文本回复" : botMessageStatus(message)}{running && <span className="bot-typing-dots" aria-hidden="true">···</span>}</p>}
      {message.clarifications?.map(card => <div key={card.goalId}><p>{card.question}</p>{card.answerText && <p>{card.answerText}</p>}</div>)}
      <BotReturnedFiles message={message} />
      <BotMessageHtmlFiles message={message} />
      </>}
      {taskReplies?.map(task => <BotTaskReply key={task.key} task={task} work={works.find(work => work.workId === task.workId)} renderMessage={renderTaskMessage} />)}
    </div>}
    {linkedWorkIds.length > 0 && <div className="bot-message-work-links">{linkedWorkIds.map(workId => <button type="button" key={workId} onClick={() => onOpenWork(workId)}><IconListTodo size={14} /><span>{works.find(work => work.workId === workId)?.title ?? (message.workFeedback?.workId === workId ? message.workFeedback.report?.title : undefined) ?? "查看关联事项"}</span><IconChevronRight size={14} /></button>)}</div>}
    {!contentInTask && <>
    {externalTask && <div className="bot-message-work-links"><button type="button" onClick={() => useAppStore.getState().setActiveTask(externalTask.id)}><IconBot size={14} /><span>打开外部 Agent 任务</span><IconChevronRight size={14} /></button></div>}
    {message.role === "assistant" && <BotOrganizationActivity organizations={message.organizations} onOpenCollaboration={onOpenCollaboration} />}
    {message.role === "assistant" && <BotCallThread calls={message.botCalls} collaborations={message.collaborations} onOpenCollaboration={onOpenCollaboration} renderReply={renderMarkdown} />}
    <BotReplyMetrics message={message} />
    <BotMessageActions readOnly={readOnly} message={message} onReply={onReply ? () => onReply(message) : undefined} onCancel={() => onCancel(message)} statusAlreadyVisible={message.role === "assistant" && (showActivity || !hasContent) && message.status !== "completed"} />
    {message.error && <p className="bot-alert" role="alert">{message.error}</p>}
    </>}
  </Container>;
}
