import { useEffect, useRef, useState } from "react";
import type { WorkProjectionDto, WorkClosureConclusion } from "@shared/bot-work";
import type { WorkReviewControlRequest } from "@shared/bot-work-review";
import { useAppStore } from "@/store/appStore";

/** Explicit user review; neither a native completion nor this form auto-accepts evidence. */
export function WorkReviewPanel({ work, includeClosed }: {
  work: WorkProjectionDto; includeClosed: boolean;
}): React.JSX.Element | null {
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [criterionId, setCriterionId] = useState(work.criteria[0]?.id ?? "");
  const [environment, setEnvironment] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [detail, setDetail] = useState("");
  const [conclusion, setConclusion] = useState<WorkClosureConclusion>("succeeded");
  const [closureSummary, setClosureSummary] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const operations = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const currentScope = useRef(includeClosed);
  currentScope.current = includeClosed;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (work.lifecycle === "closed") return null;
  const versionGuard = { expectedStateVersion: work.stateVersion,
    expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch };
  const operation = (kind: string, body: unknown) => {
    const key = JSON.stringify([kind, work.workId, versionGuard, body]);
    let id = operations.current.get(key);
    if (!id) { id = `desktop:review:${crypto.randomUUID()}`; operations.current.set(key, id); }
    return id;
  };
  const run = async (request: WorkReviewControlRequest) => {
    setBusy(true); setNotice("");
    try {
      const api = window.api;
      if (!api) throw new Error("桌面控制接口不可用");
      const result = await api.botWork.reviewControl(request);
      if (!mounted.current) return;
      setNotice(result.ok ? "决定已保存，正在读取最新状态。" : result.message);
      await useAppStore.getState().refreshBotWork(currentScope.current);
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : "决定尚未确认，请核对后重试原操作。");
    } finally { if (mounted.current) setBusy(false); }
  };
  const accept = (deliverableId: string) => run({ kind: "accept_deliverable", request: {
    operationId: operation("accept", deliverableId), workId: work.workId, deliverableId, versionGuard,
  } });
  const reject = (deliverableId: string) => {
    const reason = window.prompt("请记录拒绝这份成果的原因：")?.trim();
    if (!reason) return;
    return run({ kind: "reject_deliverable", request: {
      operationId: operation("reject", [deliverableId, reason]), workId: work.workId,
      deliverableId, reason, versionGuard,
    } });
  };
  const feedback = (failed: boolean) => {
    const body = { criterionIds: [criterionId], environment: environment.trim(),
      sourceRef: sourceRef.trim(), detail: detail.trim() || undefined, failed,
      inputSnapshotId: work.inputSnapshotId, artifactSnapshotId: work.phase3?.artifactSnapshotId };
    return run({ kind: "feedback", request: { ...body, workId: work.workId,
      operationId: operation("feedback", body), versionGuard } });
  };
  const close = () => run({ kind: "close", request: {
    operationId: operation("close", [conclusion, closureSummary.trim()]), workId: work.workId,
    conclusion, closureSummary: closureSummary.trim(), confirmed: true, versionGuard,
  } });
  const proposed = work.deliverables.filter(item => item.status === "proposed"
    && item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId);
  const criterion = work.criteria.find(item => item.id === criterionId);
  return <section className="bot-work-review bot-detail-section" aria-label="成果评审与结束">
    <h3>评审与确认</h3>
    <p>请确认成果是否符合你的要求。采纳成果后，仍需按证据核对验收条件。</p>
    {proposed.length === 0 && <p>没有当前版本待评审的成果。</p>}
    {proposed.map(item => <article key={item.deliverableId} data-deliverable-id={item.deliverableId}>
      <p>{item.summary}</p>
      {item.hasWriteConflicts && <p role="status">存在写入冲突，请先补齐必要缺口。</p>}
      {item.isSpeculation && <p role="status">这份成果仍是推测，补充实际证据前不能采纳。</p>}
      <button type="button" disabled={busy || item.hasWriteConflicts || item.isSpeculation}
        onClick={() => { void accept(item.deliverableId); }}>采纳成果</button>
      <button type="button" disabled={busy} onClick={() => { void reject(item.deliverableId); }}>拒绝成果</button>
    </article>)}
    {work.criteria.length > 0 && <details>
      <summary>记录当前版本实测</summary>
      <label>验收项<select aria-label="实测验收项" value={criterionId}
        onChange={event => setCriterionId(event.target.value)} disabled={busy}>
        {work.criteria.map(item => <option key={item.id} value={item.id}>{item.text}</option>)}
      </select></label>
      {criterion?.requiredEnvironment && <p>要求环境：{criterion.requiredEnvironment}</p>}
      <label>验证环境<input aria-label="实测环境" value={environment} maxLength={200}
        onChange={event => setEnvironment(event.target.value)} disabled={busy} /></label>
      <label>被测版本或测试记录<input aria-label="实测版本或记录" value={sourceRef} maxLength={2000}
        onChange={event => setSourceRef(event.target.value)} disabled={busy} /></label>
      <label>验证说明<textarea aria-label="实测说明" value={detail} maxLength={8000}
        onChange={event => setDetail(event.target.value)} disabled={busy} /></label>
      <p>反馈绑定你当前查看的输入和产物。请完成实际验证后提交。</p>
      <button type="button" disabled={busy || !criterion || !environment.trim() || !sourceRef.trim()}
        onClick={() => { void feedback(false); }}>记录实测通过</button>
      <button type="button" disabled={busy || !criterion || !environment.trim() || !sourceRef.trim()}
        onClick={() => { void feedback(true); }}>记录实测失败</button>
    </details>}
    <details>
      <summary>结束事项</summary>
      <label>结束结论<select aria-label="事项结束结论" value={conclusion} disabled={busy}
        onChange={event => { setConclusion(event.target.value as WorkClosureConclusion); setConfirmed(false); }}>
        <option value="succeeded">已完成</option><option value="ended_unsuccessfully">未达成，停止继续</option>
        <option value="cancelled">取消事项</option>
      </select></label>
      <label>结束依据<textarea aria-label="事项结束依据" value={closureSummary} maxLength={2000} disabled={busy}
        onChange={event => { setClosureSummary(event.target.value); setConfirmed(false); }} /></label>
      <p>按完成结束会重新核对当前验收、必要缺口、在途效果和持续关注的停止条件。</p>
      <label><input type="checkbox" aria-label="确认事项结束" checked={confirmed} disabled={busy}
        onChange={event => setConfirmed(event.target.checked)} />我确认以上结论和结束依据</label>
      <button type="button" disabled={busy || !confirmed || !closureSummary.trim()}
        onClick={() => { void close(); }}>确认结束事项</button>
    </details>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
