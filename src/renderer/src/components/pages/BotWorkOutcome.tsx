import type { BotDto, WorkProjectionDto } from "@shared/bot-work";
import { publishedWorkReport, workUserQuestions } from "@/lib/botWorkDetailPresentation";
import { WorkFiles, WorkReport, WorkResultText, workFiles } from "./BotWorkResult";

type Deliverable = WorkProjectionDto["deliverables"][number];
const normalized = (text: string) => text.replace(/\r\n/g, "\n").trim();
function rawReport(text: string): boolean {
  const source = text.trim().replace(/^\x60\x60\x60(?:json)?\s*\n([\s\S]*?)\n\x60\x60\x60$/, "$1");
  try {
    const value: unknown = JSON.parse(source);
    return value !== null && typeof value === "object";
  } catch { return false; }
}

export function BotWorkOutcome({ work }: { work: WorkProjectionDto }): React.JSX.Element | null {
  const questions = workUserQuestions(work);
  const saved = publishedWorkReport(work);
  const publication = saved?.report.completion?.nextStep === "ask" && !questions.length && work.lifecycle !== "closed" ? undefined : saved;
  // The question is already actionable above; keep this publication in the evidence view.
  if (publication && questions.length && (publication.report.completion?.nextStep === "ask"
    || questions.some(question => normalized(question.reason) === normalized(publication.report.summary)))) return null;
  if (publication) return <section className="bot-work-outcome" aria-label="当前结果">
    <div className="bot-work-result-heading"><h3>{work.mode === "watch" ? "最近一次汇报" : work.lifecycle === "closed" ? "处理结果" : "最近进展"}</h3>
      <time className="bot-work-detail-meta" dateTime={new Date(publication.createdAt).toISOString()}>{new Date(publication.createdAt).toLocaleString()}</time></div>
    <WorkReport report={publication.report} originalText={publication.report.summary} executionId={publication.executionId}
      work={work} presentation="detail" renderMarkdown={text => <WorkResultText text={text} />} />
  </section>;
  const closure = work.lifecycle === "closed" ? work.closureSummary?.trim() : undefined;
  if (closure && !rawReport(closure)) return <section className="bot-work-outcome" aria-label="当前结果">
    <h3>结束说明</h3><div className="bot-work-conclusion"><WorkResultText text={closure} /></div>
  </section>;
  const current = work.deliverables.filter(item => work.inputSnapshotBound && item.intentRevision === work.intentRevision
    && item.inputSnapshotId === work.inputSnapshotId && (item.status === "accepted" || item.status === "proposed"));
  const files = current.flatMap(item => workFiles(item.artifactRefs, work, item.executionId))
    .filter((file, index, all) => all.findIndex(other => other.ref === file.ref && other.artifact?.bindingId === file.artifact?.bindingId) === index);
  if (!files.length && work.lifecycle !== "closed") return null;
  return <section className="bot-work-outcome" aria-label="当前结果">
    <h3>{files.length ? "已保存的文件" : "处理结果"}</h3>
    <p>{work.lifecycle === "closed" ? "没有保存可直接阅读的正式结论。执行结果可在过程与依据中查看。" : "这些文件已保存，尚未形成整项委托的核对结论。"}</p>
    <WorkFiles files={files} />
  </section>;
}

export function BotWorkEvidence({ work, identities }: { work: WorkProjectionDto; identities: BotDto[] }): React.JSX.Element | null {
  const publication = publishedWorkReport(work);
  if (!work.deliverables.length && !publication) return null;
  const current = (item: Deliverable) => work.inputSnapshotBound && item.intentRevision === work.intentRevision
    && item.inputSnapshotId === work.inputSnapshotId && (item.status === "accepted" || item.status === "proposed");
  const record = (item: Deliverable) => <details className="bot-work-result-record" key={item.deliverableId}>
    <summary>{identities.find(bot => bot.botId === item.producerBotId)?.displayName ?? (item.producerBotId === work.ownerBotId ? "负责人" : "执行成员")}
      {" · "}{{ accepted: "已核验", proposed: "结果已返回", rejected: "未通过核验", superseded: "已被替代" }[item.status]}
      <span className="bot-work-detail-count">{new Date(item.createdAt).toLocaleString()}</span></summary>
    <WorkReport report={{ title: work.title, summary: item.summary, artifactRefs: item.artifactRefs,
      ...item.presentation, reviewStatus: item.status, current: current(item), notices: [...item.uncoveredScope,
        ...(item.isSpeculation ? ["含有尚未验证的推测"] : []), ...(item.hasWriteConflicts ? ["存在写入冲突"] : []),
        ...(item.rejectedReason ? [item.rejectedReason] : [])] }} originalText={item.summary} executionId={item.executionId}
      work={work} presentation="record" renderMarkdown={text => <WorkResultText text={text} />} />
    {!!item.evidenceRefs.length && <details><summary>证据引用 · {item.evidenceRefs.length}</summary><ul>{item.evidenceRefs.map(ref => <li key={ref}>{ref}</li>)}</ul></details>}
  </details>;
  return <section aria-label="成果依据">
    <h3>成果与核对依据</h3>
    {publication && <details><summary>负责人汇报与来源</summary><WorkReport report={publication.report}
      originalText={publication.report.summary} executionId={publication.executionId} work={work} presentation="record"
      renderMarkdown={text => <WorkResultText text={text} />} /></details>}
    {work.deliverables.filter(current).map(record)}
    {work.deliverables.some(item => !current(item)) && <details aria-label="历史成果"><summary>历史与未采纳成果</summary>
      <p>以下记录不代表当前委托已经完成。</p>{work.deliverables.filter(item => !current(item)).map(record)}</details>}
  </section>;
}
