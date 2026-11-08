import { useEffect, useId, useRef, useState } from "react";
import { criterionNeedsEnvironment, type WorkProjectionDto, type WorkClosureConclusion } from "@shared/bot-work";
import { userInputBlockerSnapshot, type WorkReviewControlRequest } from "@shared/bot-work-review";
import { useAppStore } from "@/store/appStore";

const identity = (work: WorkProjectionDto) => JSON.stringify([work.workId, work.stateVersion,
  work.intentRevision, work.ownerEpoch, work.inputSnapshotId, work.phase3?.artifactSnapshotId]);

/** Explicit user review; native completion never accepts results or verifies criteria. */
export function WorkReviewPanel({ work, includeClosed }: {
  work: WorkProjectionDto; includeClosed: boolean;
}): React.JSX.Element | null {
  const closeHintId = useId();
  const [reviewed, setReviewed] = useState(work);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<WorkReviewControlRequest>();
  const [criterionId, setCriterionId] = useState(work.criteria[0]?.id ?? "");
  const [environment, setEnvironment] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [detail, setDetail] = useState("");
  const [attestation, setAttestation] = useState("");
  const [replies, setReplies] = useState<Record<string, { reply: string; evidenceRef: string }>>({});
  const [legacyConfirmed, setLegacyConfirmed] = useState<Record<string, boolean>>({});
  const [conclusion, setConclusion] = useState<WorkClosureConclusion>("succeeded");
  const [closureSummary, setClosureSummary] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const operations = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const current = useRef({ work, includeClosed });
  current.current = { work, includeClosed };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!dirty && !busy && !uncertain) setReviewed(work);
  }, [work, dirty, busy, uncertain]);
  if (work.lifecycle === "closed" && !uncertain) return null;
  const stale = identity(reviewed) !== identity(work);
  const locked = busy || !!uncertain;
  const disabled = locked || stale;
  const versionGuard = { expectedStateVersion: reviewed.stateVersion,
    expectedIntentRevision: reviewed.intentRevision, expectedOwnerEpoch: reviewed.ownerEpoch };
  const operation = (kind: string, body: unknown) => {
    const key = JSON.stringify([kind, reviewed.workId, versionGuard, body]);
    let id = operations.current.get(key);
    if (!id) { id = `desktop:review:${crypto.randomUUID()}`; operations.current.set(key, id); }
    return id;
  };
  const edit = (fn: () => void) => { setDirty(true); fn(); };
  const reviewLatest = () => { setReviewed(work); setConfirmed(false); setLegacyConfirmed({}); };
  const run = async (request: WorkReviewControlRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setNotice("");
    try {
      const api = window.api;
      if (!api) throw new Error("桌面控制接口不可用");
      const result = await api.botWork.reviewControl(request);
      if (!mounted.current) return;
      setUncertain(undefined);
      setNotice(result.ok ? "决定已保存，正在读取最新状态。" : result.message);
      // Success only acknowledges this command. All retained form contents still
      // belong to the reviewed snapshot, including drafts for other controls.
      // Only the explicit latest-state acknowledgement may rebind those drafts.
      if (result.ok) { setConfirmed(false); setLegacyConfirmed({}); }
      try { await useAppStore.getState().refreshBotWork(current.current.includeClosed); }
      catch { if (mounted.current) setNotice(result.ok ? "决定已保存，但状态刷新失败，请刷新事项。" : result.message); }
    } catch (error) {
      if (mounted.current) {
        setUncertain(request);
        setNotice(`${error instanceof Error ? error.message : "连接中断"}。决定尚未确认，请重试原决定，不会创建新操作。`);
      }
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const accept = (deliverableId: string) => run({ kind: "accept_deliverable", request: {
    operationId: operation("accept", deliverableId), workId: reviewed.workId, deliverableId, versionGuard,
  } });
  const reject = (deliverableId: string) => {
    const reason = window.prompt("请记录拒绝这份成果的原因：")?.trim();
    if (!reason) return;
    return run({ kind: "reject_deliverable", request: {
      operationId: operation("reject", [deliverableId, reason]), workId: reviewed.workId,
      deliverableId, reason, versionGuard,
    } });
  };
  const feedback = (failed: boolean) => {
    const body = { criterionIds: [criterionId], environment: environment.trim(),
      sourceRef: sourceRef.trim(), detail: detail.trim() || undefined, failed,
      inputSnapshotId: reviewed.inputSnapshotId, artifactSnapshotId: reviewed.phase3?.artifactSnapshotId };
    return run({ kind: "feedback", request: { ...body, workId: reviewed.workId,
      operationId: operation("feedback", body), versionGuard } });
  };
  const attest = (status: "met" | "not_met") => {
    const body = { criterionUpdates: [{ criterionId, status, evidence: attestation.trim() }],
      inputSnapshotId: reviewed.inputSnapshotId, artifactSnapshotId: reviewed.phase3?.artifactSnapshotId };
    return run({ kind: "attest_criteria", request: { ...body, workId: reviewed.workId,
      operationId: operation("attest", body), versionGuard } });
  };
  const close = () => run({ kind: "close", request: {
    operationId: operation("close", [conclusion, closureSummary.trim()]), workId: reviewed.workId,
    conclusion, closureSummary: closureSummary.trim(), confirmed: true, versionGuard,
  } });
  const proposed = reviewed.deliverables.filter(item => item.status === "proposed"
    && item.intentRevision === reviewed.intentRevision && item.inputSnapshotId === reviewed.inputSnapshotId);
  const criterion = reviewed.criteria.find(item => item.id === criterionId);
  const closeDisabledReason = busy ? "正在保存决定，请等待结果。"
    : uncertain ? "上次决定尚未确认，请先重试原评审决定。"
    : stale ? "暂不能结束：事项已有更新。请先核对最新成果、要求与负责人，再确认结束结论。"
    : !closureSummary.trim() ? "请先填写结束依据。"
    : !confirmed ? "请勾选确认以上结论和结束依据。" : "";
  const inputBlockers = reviewed.blockers.filter(item => item.status === "open" && (userInputBlockerSnapshot(item) || item.legacyUserInput));
  return <section className="bot-work-review bot-detail-section" aria-label="成果评审与结束">
    <h3>评审与确认</h3>
    <p>依次采纳成果、核对验收条件，再确认结束。执行完成不会自动完成这三步。</p>
    {stale && <div role="alert"><p>事项已有更新，已保留你的填写内容和原评审版本。请核对最新成果、要求与负责人后再提交。</p>
      <button type="button" disabled={locked} onClick={reviewLatest}>已核对最新状态，继续评审</button>
    </div>}
    {proposed.length === 0 && <p>没有当前版本待评审的成果。</p>}
    {proposed.map(item => <article key={item.deliverableId} data-deliverable-id={item.deliverableId}>
      <p>{item.summary}</p>
      {item.hasWriteConflicts && <p role="status">存在写入冲突，请先补齐必要缺口。</p>}
      {item.isSpeculation && <p role="status">这份成果仍是推测，补充实际证据前不能采纳。</p>}
      <button type="button" disabled={disabled || item.hasWriteConflicts || item.isSpeculation}
        onClick={() => { void accept(item.deliverableId); }}>采纳成果</button>
      <button type="button" disabled={disabled} onClick={() => { void reject(item.deliverableId); }}>拒绝成果</button>
    </article>)}
    {reviewed.criteria.length > 0 && <>
      <label>验收项<select aria-label="实测验收项" value={criterionId}
        onChange={event => edit(() => setCriterionId(event.target.value))} disabled={locked}>
        {reviewed.criteria.map(item => <option key={item.id} value={item.id}>{item.text}</option>)}
      </select></label>
      {criterion && !criterionNeedsEnvironment(criterion) && <section aria-label="普通验收确认">
        <label>验收依据<textarea aria-label="普通验收依据" value={attestation} maxLength={2000} disabled={locked}
          onChange={event => edit(() => setAttestation(event.target.value))} /></label>
        <p>请记录你实际核对过的结果和依据。不会将执行完成自动算作验收通过。</p>
        <button type="button" disabled={disabled || !attestation.trim() || !reviewed.inputSnapshotBound}
          onClick={() => { void attest("met"); }}>确认此项通过</button>
        <button type="button" disabled={disabled || !attestation.trim() || !reviewed.inputSnapshotBound}
          onClick={() => { void attest("not_met"); }}>记录此项未通过</button>
      </section>}
      <details>
        <summary>记录当前版本实测</summary>
        {criterion?.requiredEnvironment && <>
          <p>要求环境：{criterion.requiredEnvironment}</p>
          <button type="button" disabled={disabled}
            onClick={() => edit(() => setEnvironment(criterion.requiredEnvironment!))}>带入要求环境</button>
          <p>仅在你确实使用此环境完成验证时带入名称；这不会自动记录实测通过。具体系统和验证过程可填在验证说明中。</p>
        </>}
        <label>验证环境<input aria-label="实测环境" value={environment} maxLength={200}
          onChange={event => edit(() => setEnvironment(event.target.value))} disabled={locked} /></label>
        <label>被测版本或测试记录<input aria-label="实测版本或记录" value={sourceRef} maxLength={2000}
          onChange={event => edit(() => setSourceRef(event.target.value))} disabled={locked} /></label>
        <label>验证说明<textarea aria-label="实测说明" value={detail} maxLength={8000}
          onChange={event => edit(() => setDetail(event.target.value))} disabled={locked} /></label>
        <p>反馈绑定你评审的输入和产物。要求真实环境的验收项必须完成实际验证后提交。</p>
        <button type="button" disabled={disabled || !criterion || !environment.trim() || !sourceRef.trim()}
          onClick={() => { void feedback(false); }}>记录实测通过</button>
        <button type="button" disabled={disabled || !criterion || !environment.trim() || !sourceRef.trim()}
          onClick={() => { void feedback(true); }}>记录实测失败</button>
      </details>
    </>}
    {inputBlockers.map(blocker => {
      const reply = replies[blocker.blockerId] ?? { reply: "", evidenceRef: "" };
      return <section key={blocker.blockerId} aria-label="回复待补充信息">
        <h4>{blocker.reason}</h4>
        {blocker.legacyUserInput && <>
          <p>已找到此问题唯一匹配的原始负责人报告，但旧记录未标明问题类型。请先判断它是否仅需补充信息。</p>
          <label><input type="checkbox" aria-label={`确认仅信息问题 ${blocker.blockerId}`} checked={legacyConfirmed[blocker.blockerId] ?? false} disabled={locked}
            onChange={event => edit(() => setLegacyConfirmed({ ...legacyConfirmed, [blocker.blockerId]: event.target.checked }))} />
            我确认这仅是信息问题，不涉及操作授权、预算、资源、写入冲突或未知效果；回复及依据足以解决这一个问题</label>
        </>}
        <label>回复<textarea aria-label={`问题回复 ${blocker.blockerId}`} value={reply.reply} maxLength={2000} disabled={locked}
          onChange={event => edit(() => setReplies({ ...replies, [blocker.blockerId]: { ...reply, reply: event.target.value } }))} /></label>
        <label>依据或记录<input aria-label={`回复依据 ${blocker.blockerId}`} value={reply.evidenceRef} maxLength={2000} disabled={locked}
          onChange={event => edit(() => setReplies({ ...replies, [blocker.blockerId]: { ...reply, evidenceRef: event.target.value } }))} /></label>
        <p>只保存此问题的回复，不批准操作、不更改预算，也不自动恢复执行。</p>
        <button type="button" disabled={disabled || !reply.reply.trim() || !reply.evidenceRef.trim() || !!blocker.legacyUserInput && !legacyConfirmed[blocker.blockerId]}
          onClick={() => {
            const body = { blockerId: blocker.blockerId, blockerSnapshot: blocker.legacyUserInput?.blockerSnapshot ?? userInputBlockerSnapshot(blocker)!,
              inputSnapshotId: reviewed.inputSnapshotId, reply: reply.reply.trim(), evidenceRef: reply.evidenceRef.trim() };
            if (blocker.legacyUserInput) {
              const legacy = { ...body, reportOperationId: blocker.legacyUserInput.reportOperationId, confirmedInformationOnly: true as const };
              void run({ kind: "reply_legacy_user_input", request: { ...legacy, workId: reviewed.workId,
                operationId: operation("legacy-reply", legacy), versionGuard } });
            } else void run({ kind: "reply_user_input", request: { ...body, workId: reviewed.workId,
              operationId: operation("reply", body), versionGuard } });
          }}>保存回复</button>
      </section>;
    })}
    <details>
      <summary>结束事项</summary>
      <label>结束结论<select aria-label="事项结束结论" value={conclusion} disabled={locked}
        onChange={event => edit(() => { setConclusion(event.target.value as WorkClosureConclusion); setConfirmed(false); })}>
        <option value="succeeded">已完成</option><option value="ended_unsuccessfully">未达成，停止继续</option>
        <option value="cancelled">取消事项</option>
      </select></label>
      <label>结束依据<textarea aria-label="事项结束依据" value={closureSummary} maxLength={2000} disabled={locked}
        onChange={event => edit(() => { setClosureSummary(event.target.value); setConfirmed(false); })} /></label>
      <p>按完成结束会重新核对当前验收、必要缺口、在途效果和持续关注的停止条件。</p>
      <label><input type="checkbox" aria-label="确认事项结束" checked={confirmed} disabled={locked}
        onChange={event => edit(() => setConfirmed(event.target.checked))} />我确认以上结论和结束依据</label>
      {closeDisabledReason && <p id={closeHintId} role="status">{closeDisabledReason}</p>}
      {stale && <button type="button" disabled={locked} onClick={reviewLatest}>已核对最新状态，继续结束</button>}
      <button type="button" disabled={!!closeDisabledReason}
        aria-describedby={closeDisabledReason ? closeHintId : undefined}
        onClick={() => { void close(); }}>确认结束事项</button>
    </details>
    {uncertain && <button type="button" disabled={busy} onClick={() => { void run(uncertain); }}>重试原评审决定</button>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
