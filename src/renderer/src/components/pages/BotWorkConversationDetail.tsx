import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import { IconChevronLeft, IconX } from "@/components/common/icons";
import { BotWorkDetails } from "./BotWorkDetails";
import "./BotWorkConversationDetail.css";

/** The same details and artifact actions, presented in the conversation viewport. */
export function BotWorkConversationDetail({ work, workId, loading = false, error, conversationName, ownerName, includeClosed, returnLabel = "对话", onBack, onReplyToBlocker, children }: {
  work: WorkProjectionDto | null; conversationName: string; ownerName: string; includeClosed: boolean;
  returnLabel?: string; workId?: string; loading?: boolean; error?: string;
  children?: ReactNode;
  onBack: () => void; onReplyToBlocker?: (blocker: WorkProjectionDto["blockers"][number]) => void;
}): React.JSX.Element {
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = back.current;
    button?.focus({ preventScroll: true });
    // A compact navigation drawer may still be closing in its passive effect.
    // Retry focus after that commit only when the native inert layer blocked it.
    const frame = document.activeElement !== button ? requestAnimationFrame(() => button?.focus({ preventScroll: true })) : 0;
    return () => { if (frame) cancelAnimationFrame(frame); };
  }, [workId ?? work?.workId]);
  return <section className="bot-work-conversation-detail" aria-label="对话中的事项详情" onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); onBack(); }
  }}>
    <header className="bot-work-conversation-header">
      <div className="bot-work-conversation-breadcrumb">
        <button ref={back} type="button" onClick={onBack} aria-label={`返回${conversationName}的${returnLabel}`} title={`返回${conversationName}的${returnLabel}`}>
          <IconChevronLeft size={17} /><span>{conversationName}{returnLabel === "对话" ? "" : ` · ${returnLabel}`}</span>
        </button>
        <span aria-hidden="true">/</span><span>事项详情</span>
      </div>
      <button type="button" className="bot-icon-button" aria-label={`关闭事项详情并返回${returnLabel}`} onClick={onBack}><IconX size={18} /></button>
    </header>
    <div className="bot-work-conversation-body" tabIndex={-1}>
      {!loading && work && children}
      {work ? <BotWorkDetails key={`detail:${work.workId}`} work={work} ownerName={ownerName} includeClosed={includeClosed} onReplyToBlocker={onReplyToBlocker} />
        : <p role="status">{loading ? "正在读取事项详情…" : error ?? `此事项已不可用，可能已删除或无权访问。可以返回${returnLabel}查看原记录。`}</p>}
    </div>
  </section>;
}
