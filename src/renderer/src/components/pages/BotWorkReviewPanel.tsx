import type { WorkProjectionDto } from "@shared/bot-work";

/** Result judgement belongs to the foreground assistant, not to a manual
 * acceptance form. Corrections and missing information use the conversation. */
export function WorkReviewPanel({ work }: {
  work: WorkProjectionDto; includeClosed: boolean;
}): React.JSX.Element | null {
  if (work.lifecycle === "closed") return null;
  const questions = work.blockers.filter(item => item.status === "open"
    && item.kind === "operational" && item.waitingForUserInput && !item.unknownExternalEffectRef);
  if (questions.length) return <section className="bot-detail-section" aria-label="需要补充的信息">
    <h3>需要补充的信息</h3>
    {questions.map(item => <p key={item.blockerId}>{item.reason}</p>)}
    <p>直接在对话中回复即可，助理会接着处理。</p>
  </section>;
  return null;
}
