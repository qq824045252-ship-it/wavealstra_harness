import type { WorkProjectionDto } from "@shared/bot-work";
import type { WorkVerificationDto } from "@shared/bot-work-verification";
import { workVerificationMatches } from "@shared/bot-work-verification";
import "./BotWorkVerification.css";

const labels: Record<WorkVerificationDto["checks"][number]["state"], string> = {
  verified: "已登记核对", unverified: "尚未核实", failed: "记录未通过", waived: "记录已豁免",
  read: "已读取保存版本", empty: "文本为空", changed: "版本不一致", unavailable: "未能核对内容",
};

export function isWorkVerificationHistorical(verification: WorkVerificationDto, executionId?: string, work?: WorkProjectionDto): boolean {
  if (!executionId || verification.executionId !== executionId || verification.historicalExecution) return true;
  if (!work) return false;
  const binding = work.executions.find(item => item.bindingId === executionId);
  return !workVerificationMatches(verification, { ...work, executionId })
    || work.inputSnapshotBound === false || binding?.invalidatedAt !== undefined || binding?.status === "invalidated";
}

/** Read the saved projection only. Expanding this record never invokes a tool,
 * refreshes evidence, changes task state, or asks the user to approve anything. */
export function BotWorkVerification({ verification, executionId, current, work }: {
  verification: WorkVerificationDto; executionId?: string; current: boolean; work?: WorkProjectionDto;
}): React.JSX.Element {
  if (!executionId || verification.executionId !== executionId)
    return <p className="bot-work-verification-unavailable">核对记录与本条执行结果未能对应，未展示为本次依据。</p>;
  const historical = !current || isWorkVerificationHistorical(verification, executionId, work);
  return <details className="bot-work-verification" aria-label="核对记录" data-historical={historical}>
    <summary>{historical ? "历史核对记录" : "核对记录"} · {verification.checks.length} 项</summary>
    <p>{historical ? "以下是历史核对时保存的记录，不代表当前要求已完成，也没有重新检查当前环境。"
      : "以下是该次结果核对时保存的记录，不会随文件或任务的后续变化自动更新。"}</p>
    {verification.reviewedAt && <p className="bot-work-verification-meta">记录时间：<time dateTime={verification.reviewedAt}>
      {new Date(verification.reviewedAt).toLocaleString("zh-CN")}</time></p>}
    {verification.checks.length ? <ul className="bot-work-verification-checks">{verification.checks.map(check => <li key={check.id} data-state={check.state}>
      <div className="bot-work-verification-heading"><strong>{check.label}</strong><span>{labels[check.state]}</span></div>
      <small>{check.kind === "artifact" ? "文件读取与版本核对" : check.origin === "assistant_proposal" ? "助理建议的检查项" : "任务检查项"}</small>
      <p>{check.summary}</p>
      {check.limitations.length > 0 && <ul className="bot-work-verification-limits">{check.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>}
      {(check.evidenceRefs.length > 0 || check.omittedEvidenceRefs > 0) && <details><summary>证据引用 · {check.evidenceRefs.length}</summary>
        {check.evidenceRefs.map(ref => <p key={ref}><code>{ref}</code></p>)}
        {check.omittedEvidenceRefs > 0 && <p>另有 {check.omittedEvidenceRefs} 条引用未在此快照展开。</p>}
      </details>}
    </li>)}</ul> : <p>这次记录没有可逐项展示的检查依据，不能由此推断任务已完成。</p>}
    {verification.omittedCount > 0 && <p className="bot-work-verification-omitted">另有 {verification.omittedCount} 项未纳入本次展示；未展示或未读取的内容不作为已核对。</p>}
  </details>;
}
