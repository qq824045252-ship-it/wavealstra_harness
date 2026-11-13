import type { WorkProjectionDto } from "@shared/bot-work";
import { isWorkEffectDiagnostic } from "@shared/work-effect-policy";
import { publishedWorkReport, workActivitySummary, workUserQuestions } from "@/lib/botWorkDetailPresentation";
import { BotWorkOutcome } from "./BotWorkOutcome";
import { WorkReport, WorkResultText } from "./BotWorkResult";

export function BotWorkOverview({ work, onReplyToBlocker }: { work: WorkProjectionDto;
  onReplyToBlocker?: (blocker: WorkProjectionDto["blockers"][number]) => void }): React.JSX.Element {
  const questions = workUserQuestions(work);
  const activity = workActivitySummary(work);
  const publication = publishedWorkReport(work);
  const questionReport = questions.length === 1 && publication?.report.completion?.nextStep === "ask" ? publication : undefined;
  const active = work.lifecycle !== "closed";
  const blockers = work.blockers.filter(item => active && item.status === "open" && !questions.includes(item) && !isWorkEffectDiagnostic(item));
  const gaps = work.phase3?.gaps.filter(item => item.required) ?? [];
  const observations = [...new Set((work.runtimeObservations ?? []).map(item => item.reason.trim()).filter(Boolean))];
  const schedules = work.phase4?.subscriptions.filter(item => item.status !== "stopped") ?? [];
  const next = schedules.flatMap(item => item.nextWakeAt === undefined ? [] : [item.nextWakeAt]).sort((a, b) => a - b)[0];
  const checked = work.phase4?.subscriptions.flatMap(item => item.lastCheckedAt === undefined ? [] : [item.lastCheckedAt]).sort((a, b) => b - a)[0];
  return <>
    {questions.length > 0 && <section className="bot-work-alert" aria-label="需要你补充">
      <h3>需要你补充</h3>
      {questions.map(question => <article key={question.blockerId}>
        {questionReport ? <WorkReport report={questionReport.report} originalText={questionReport.report.summary}
          executionId={questionReport.executionId} work={work} presentation="detail" renderMarkdown={text => <WorkResultText text={text} />} />
          : <WorkResultText text={question.reason} />}
        {onReplyToBlocker && <button type="button" onClick={() => onReplyToBlocker(question)}>回复此问题</button>}</article>)}
      <p className="bot-work-detail-meta">{work.lifecycle === "paused" ? "回复会保存，恢复任务后再继续处理。" : "收到补充后，负责人会结合已有结果继续处理。"}</p>
    </section>}
    {activity && <section className="bot-work-activity" aria-label="处理进展">
      <h3>处理进展</h3><p>{activity}</p>
      {observations.length > 0 && <details><summary>当前执行说明</summary>{observations.map(reason => <p key={reason}>{reason}</p>)}</details>}
      {blockers.length > 0 && <details><summary>查看阻碍原因 · {blockers.length}</summary><ul>{blockers.map(item => <li key={item.blockerId}>{item.reason}</li>)}</ul></details>}
      {gaps.length > 0 && <p>还有 {gaps.length} 项必要工作未完成，已有成果会保留。具体缺项见过程与依据。</p>}
    </section>}
    {!work.inputSnapshotBound && <p className="bot-work-limitation">当前委托尚未关联到执行结果，不能确认已有成果满足这次要求。</p>}
    {active && work.blockers.some(item => item.status === "open" && item.unknownExternalEffectRef) &&
      <p className="bot-work-limitation">有操作的实际结果尚未确认，不能按失败直接重做。相关记录可在诊断中核对。</p>}
    <BotWorkOutcome work={work} />
    {!publication && active && work.uncoveredScope.length > 0 && <section className="bot-work-limitation" aria-label="尚未完成的内容">
      <h3>尚未完成的内容</h3><ul>{[...new Set(work.uncoveredScope)].map(scope => <li key={scope}>{scope}</li>)}</ul>
    </section>}
    {work.mode === "watch" && work.phase4 && active && <section className="bot-work-watch" aria-label="持续跟踪安排">
      <h3>持续跟踪</h3>
      {!work.phase4.host.online && <p className="bot-work-limitation">运行服务离线，当前无法检查。</p>}
      {checked !== undefined && <p>最近检查：<time dateTime={new Date(checked).toISOString()}>{new Date(checked).toLocaleString()}</time></p>}
      <p>{work.lifecycle === "paused" ? "已暂停后续检查。" : next !== undefined ? `下次检查：${new Date(next).toLocaleString()}`
        : schedules.length ? "正在等待下一次触发。" : "已停止后续检查。"}</p>
      {work.watchPlan?.endsAt !== undefined && <p>跟踪至 {new Date(work.watchPlan.endsAt).toLocaleString()}，到期停止检查。</p>}
      {work.phase4.offlineGaps.some(gap => gap.state !== "recovered") && <p className="bot-work-limitation">离线期间有检查尚未补齐或无法回查，结果可能不完整。</p>}
    </section>}
  </>;
}
