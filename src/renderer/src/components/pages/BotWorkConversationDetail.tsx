import { useEffect, useRef } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import { IconChevronLeft, IconX } from "@/components/common/icons";
import { workStatusLabel } from "@/lib/botWorkspacePresentation";
import { BotWorkDetails } from "./BotWorkDetails";
import "./BotWorkConversationDetail.css";

/** The same details and artifact actions, presented in the conversation viewport. */
export function BotWorkConversationDetail({ work, conversationName, ownerName, includeClosed, onBack, onReplyToBlocker }: {
  work: WorkProjectionDto | null; conversationName: string; ownerName: string; includeClosed: boolean;
  onBack: () => void; onReplyToBlocker: (blocker: WorkProjectionDto["blockers"][number]) => void;
}): React.JSX.Element {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, [work?.workId]);
  return <section className="bot-work-conversation-detail" aria-label="对话中的事项详情" onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); onBack(); }
  }}>
    <header className="bot-work-conversation-header">
      <div className="bot-work-conversation-breadcrumb">
        <button ref={back} type="button" onClick={onBack} aria-label={`返回${conversationName}的对话`} title={`返回${conversationName}的对话`}>
          <IconChevronLeft size={17} /><span>{conversationName}</span>
        </button>
        <span aria-hidden="true">/</span><strong title={work?.title}>{work?.title ?? "事项详情"}</strong>
      </div>
      {work && <span className="bot-work-conversation-status">{workStatusLabel(work)}</span>}
      <button type="button" className="bot-icon-button" aria-label="关闭事项详情并返回对话" onClick={onBack}><IconX size={18} /></button>
    </header>
    <div className="bot-work-conversation-body">
      {work ? <BotWorkDetails key={work.workId} work={work} ownerName={ownerName} includeClosed={includeClosed} onReplyToBlocker={onReplyToBlocker} />
        : <p role="status">此事项已不在当前列表中。可以返回对话查看原消息。</p>}
    </div>
  </section>;
}
