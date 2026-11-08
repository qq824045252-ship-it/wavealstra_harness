import { userInputBlockerSnapshot } from "@shared/bot-work-review";
import { useEffect, useRef, useState } from "react";
import type { WorkBudgetReservationDto, WorkCriterionDto, WorkLifecycle, WorkProjectionDto } from "@shared/bot-work";
import type { WorkPhase3ControlRequest } from "@shared/bot-work-phase3-control";
import type { WorkPhase4ControlRequest, WorkPhase4ControlResult } from "@shared/bot-work-phase4";
import { useAppStore } from "@/store/appStore";
import { BotWorkApprovals } from "./BotWorkApprovals";
import { WorkCardsPanel } from "./BotWorkCardsPanel";
import { BotTeamPanel } from "./BotTeamPanel";
import { WorkReviewPanel } from "./BotWorkReviewPanel";

export function lifecycleLabel(lifecycle: WorkLifecycle): string {
  if (lifecycle === "active") return "进行中";
  if (lifecycle === "paused") return "已暂停";
  if (lifecycle === "closing") return "结算中";
  return "已结束";
}

function criterionLabel(criterion: WorkCriterionDto): string {
  if (criterion.status === "satisfied") return "已满足";
  if (criterion.status === "failed") return "未满足";
  if (criterion.status === "waived") return "已豁免";
  if (criterion.status === "blocked") return "受阻";
  return "待验收";
}

function UnknownBudgetReconciliation(props: {
  work: WorkProjectionDto;
  reservation: Pick<WorkBudgetReservationDto, "reservationId" | "windowId" | "tokens" | "requestKind" | "createdAt">;
  busy: boolean;
  submit: (request: WorkPhase4ControlRequest) => Promise<WorkPhase4ControlResult | undefined>;
}): React.JSX.Element {
  const { work, reservation, busy, submit } = props;
  const [resolution, setResolution] = useState<"committed" | "released">("committed");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const pending = useRef<{ signature: string; request: WorkPhase4ControlRequest } | null>(null);
  const tokens = Number(amount);
  const valid = amount.trim() !== "" && Number.isSafeInteger(tokens) && tokens >= 0
    && (resolution !== "released" || tokens === 0) && reason.trim() !== "" && evidenceRef.trim() !== "" && confirmed;
  const reconcile = async () => {
    if (!valid || busy) return;
    const payload = { kind: "reconcile-budget-reservation" as const, workId: work.workId,
      reservationId: reservation.reservationId, windowId: reservation.windowId, resolution,
      reportedTokens: tokens, reason: reason.trim(), evidenceRef: evidenceRef.trim() };
    const signature = JSON.stringify(payload);
    // Keep the exact original command after an unknown transport outcome. A fresh
    // projection must not turn a retry into a different accounting operation.
    if (pending.current?.signature !== signature) pending.current = { signature, request: {
      ...payload, operationId: `desktop:${crypto.randomUUID()}`,
      versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch },
    } };
    const response = await submit(pending.current.request);
    if (response) pending.current = null;
  };
  return <details className="budget-reconciliation">
    <summary>核对未知用量：预留 {reservation.tokens} tokens</summary>
    <p>请求 {reservation.reservationId} · 原窗口 {reservation.windowId} · {new Date(reservation.createdAt).toLocaleString()}</p>
    <p>核对供应商账单或请求凭据后填写实际用量。确认未产生消耗时，填写 0 并选择释放。</p>
    <label>处理方式<select aria-label="未知用量处理方式" value={resolution}
      onChange={event => { setResolution(event.target.value as typeof resolution); setConfirmed(false); }}>
      <option value="committed">按已核实用量结算</option><option value="released">确认未消耗，释放预留</option>
    </select></label>
    <label>已核实 tokens<input aria-label="已核实 tokens" type="number" min={0} step={1} value={amount}
      onChange={event => { setAmount(event.target.value); setConfirmed(false); }} /></label>
    <label>核对说明<input aria-label="预算核对说明" maxLength={1000} value={reason}
      onChange={event => { setReason(event.target.value); setConfirmed(false); }} /></label>
    <label>账单或请求凭据<input aria-label="预算核对凭据" maxLength={1000} value={evidenceRef}
      onChange={event => { setEvidenceRef(event.target.value); setConfirmed(false); }} /></label>
    <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核实这笔请求的实际消耗</label>
    <button type="button" disabled={busy || !valid} onClick={() => { void reconcile(); }}>保存预算核对结果</button>
  </details>;
}

export function BotWorkDetails(props: { work: WorkProjectionDto; ownerName: string; includeClosed: boolean;
  onReplyToBlocker?: (blocker: WorkProjectionDto["blockers"][number]) => void }): React.JSX.Element {
  const { work, ownerName, includeClosed } = props;
  const openBlockers = work.blockers.filter((blocker) => blocker.status === "open");
  const identities = useAppStore(s => s.botIdentities);
  const [targetBotId, setTargetBotId] = useState("");
  const [question, setQuestion] = useState("");
  const [controlNotice, setControlNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [safeRecovery, setSafeRecovery] = useState<string | null>(null);
  const [phase4Notice, setPhase4Notice] = useState("");
  const [watchSource, setWatchSource] = useState("hook");
  const [watchPolicy, setWatchPolicy] = useState<"latest" | "each" | "skip">("latest");
  const [deadlineInput, setDeadlineInput] = useState("");
  const remoteBudgetLimit = work.phase4?.budget.limitTokens ?? 500000;
  // A draft belongs to the policy it was edited against. A remote policy change
  // invalidates it, while unrelated Work refreshes must retain local edits.
  const [budgetDraft, setBudgetDraft] = useState<{ base: number; value: string } | null>(null);
  const budgetLimit = budgetDraft?.base === remoteBudgetLimit ? budgetDraft.value : String(remoteBudgetLimit);
  useEffect(() => { setBudgetDraft(null); }, [remoteBudgetLimit]);
  const budgetDirty = budgetLimit.trim() !== "" && Number.isSafeInteger(Number(budgetLimit))
    && Number(budgetLimit) >= 0 && Number(budgetLimit) !== remoteBudgetLimit;
  const operations = useRef(new Map<string, string>());
  const controlRequests = useRef(new Map<string, WorkPhase3ControlRequest>());
  const operation = (key: string) => {
    const prior = operations.current.get(key);
    if (prior) return prior;
    const id = `desktop:${crypto.randomUUID()}`;
    operations.current.set(key, id); return id;
  };
  const versionGuard = { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch };
  const control = async (request: WorkPhase3ControlRequest) => {
    setBusy(true);
    const requestId = request.kind === "continue" || request.kind === "handoff" || request.kind === "retry_resource_recovery" ? request.request.operationId
      : request.kind === "collaborate" ? request.request.messageId : undefined;
    const original = requestId ? controlRequests.current.get(requestId) ?? request : request;
    if (requestId) controlRequests.current.set(requestId, original);
    try {
      const api = window.api;
      if (!api) throw new Error("桌面控制接口不可用");
      const response = await api.botWork.phase3Control(original);
      if (!response.ok && requestId) {
        controlRequests.current.delete(requestId);
        for (const [key, value] of operations.current) if (value === requestId) operations.current.delete(key);
      }
      setControlNotice(response.ok ? "操作已受理，正在读取最新状态。" : response.message);
      await useAppStore.getState().refreshBotWork(includeClosed);
      return response;
    } catch (error) { setControlNotice(error instanceof Error ? error.message : "操作尚未确认，请核对最新状态后重试。"); }
    finally { setBusy(false); }
  };

  const runPhase4 = async (request: WorkPhase4ControlRequest) => {
    setBusy(true);
    try {
      const api = window.api;
      if (!api) throw new Error("桌面控制接口不可用");
      const response = await api.botWork.phase4Control(request);
      setPhase4Notice(response.ok ? "操作已保存，正在读取最新状态。" : response.message);
      await useAppStore.getState().refreshBotWork(includeClosed);
      return response;
    } catch (error) {
      setPhase4Notice(error instanceof Error ? error.message : "操作尚未确认，请核对最新状态后重试。");
    } finally { setBusy(false); }
  };

  const satisfied = work.criteria.filter(item => item.status === "satisfied").length;
  const needsDecision = openBlockers.filter(item => item.waitingForUserInput);
  const currentProposals = work.deliverables.filter(item => item.status === "proposed"
    && item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId);
  const conclusionText = work.closureConclusion ? {
    succeeded: "已完成", ended_unsuccessfully: "未达成，已结束", cancelled: "已取消",
  }[work.closureConclusion] : undefined;

  return (
    <div className="bot-work-details">
      <header className="bot-work-detail-heading">
        <span className="bot-work-status" data-state={work.lifecycle}>{conclusionText ?? lifecycleLabel(work.lifecycle)}</span>
        <h2>{work.title}</h2>
        <p>{ownerName} · {work.mode === "watch" ? "持续关注" : "一次性事项"}</p>
      </header>
      <section className="bot-detail-section" aria-label="目标与进度">
        <h3>目标</h3>
        <p>{work.title}</p>
        {work.criteria.length > 0 && <p className="bot-work-goal-note">以以下验收条件确认目标是否达成。</p>}
        <h3>进度</h3>
        {work.criteria.length > 0 ? <>
          <p>已通过 {satisfied} / {work.criteria.length} 项验收{work.criteria.some(item => item.status === "waived") ? "（另有已豁免项）" : ""}</p>
          <progress value={satisfied} max={work.criteria.length} aria-label="已通过的验收项" />
        </> : <p>尚未设置验收条件，暂不能确认完成进度。</p>}
        {work.closureSummary && <p>{work.closureSummary}</p>}
      </section>
      <BotTeamPanel work={work} identities={identities} />
      <section className="bot-detail-section bot-work-next" aria-label="下一步">
        <h3>下一步</h3>
        {work.nextSteps.length === 0 ? <p>{work.lifecycle === "closed" ? "事项已结束。" : "暂无已记录的下一步。"}</p>
          : <ul>{work.nextSteps.map(step => <li key={step}>{step}</li>)}</ul>}
        {work.lifecycle !== "closed" && (needsDecision.length > 0 || currentProposals.length > 0) && <p className="bot-work-decision-hint">需要你决定：{currentProposals.length > 0 ? `${currentProposals.length} 份成果待评审` : "有问题等待你的回复"}，请查看下方评审与阻碍。</p>}
      </section>
      {(openBlockers.length > 0 || !work.inputSnapshotBound || work.uncoveredScope.length > 0) && <section className="bot-work-alert" aria-label="需要关注的阻碍">
        <h3>需要关注</h3>
        {!work.inputSnapshotBound && <p role="status">输入版本尚未绑定，不能据此确认成果已验证。</p>}
        {openBlockers.map(blocker => <article key={blocker.blockerId}>
          <p>{blocker.waitingForUserInput ? "需要处理：" : "阻碍："}{blocker.reason}</p>
          {userInputBlockerSnapshot(blocker) || blocker.legacyUserInput ? <p>请在下方「回复待补充信息」中填写回复和依据。</p>
            : work.approvals?.some(item => item.approvalId === blocker.blockerId && item.status === "pending") ? <p>请在下方「后台操作审批」中决定本次操作。</p>
              : blocker.reasonCode?.startsWith("budget-") || blocker.windowId ? <p>请在运行提醒或高级设置中核对预算与实际用量，普通回复不能解除。</p>
                : blocker.unknownExternalEffectRef || blocker.kind === "external_effect" ? <p>先核对原操作效果；未确认前不能解除或重做。</p>
                  : work.approvals?.some(item => item.approvalId === blocker.blockerId) || blocker.blockerId.startsWith("continuation:") ? <p>原操作不会自动重跑。请在执行情况中核对并仅补跑必要缺口；新动作仍需通过授权检查。</p>
                    : <p>请核对执行情况或高级设置中的对应控制。此阻碍不能用普通回复强制解除。</p>}
          {!userInputBlockerSnapshot(blocker) && props.onReplyToBlocker && work.lifecycle !== "closed" && <>
            <button type="button" onClick={() => props.onReplyToBlocker?.(blocker)}>向负责人回复此问题</button>
            <p>打开关联事项的对话草稿，由你填写并发送。回复供负责人核对，原阻碍暂保留；权限、预算和未知效果仍走专门入口。</p>
          </>}
        </article>)}
        {work.uncoveredScope.length > 0 && <p>尚未覆盖：{work.uncoveredScope.join("、")}</p>}
      </section>}
      {work.phase4 && (!work.phase4.host.online || work.phase4.budget.unknownUsageCount > 0 || work.phase4.budget.availableTokens <= 0
        || work.phase4.offlineGaps.some(gap => gap.state !== "recovered")) && <section className="bot-work-alert" aria-label="运行与用量提醒">
        <h3>运行提醒</h3>
        {!work.phase4.host.online && <p role="status">运行服务离线，持续关注当前不可用。</p>}
        {work.phase4.offlineGaps.some(gap => gap.state !== "recovered") && <p>存在尚未恢复或无法回查的离线记录，请在高级设置中核对。</p>}
        {work.phase4.budget.availableTokens <= 0 && <p>可用预算已耗尽。继续运行前，请在高级设置中核对预算。</p>}
        {work.phase4.budget.unknownUsageCount > 0 && <p>有 {work.phase4.budget.unknownUsageCount} 笔用量尚未确认。核对实际消耗后才能准确结算。</p>}
        {(work.phase4.budget.unknownReservations ?? []).map(reservation => <UnknownBudgetReconciliation
          key={reservation.reservationId} work={work} reservation={reservation} busy={busy} submit={runPhase4} />)}
      </section>}
      {work.phase3 && (work.lifecycle === "paused" || work.phase3.settlingActions > 0 || work.phase3.resourceWaits.length > 0
        || work.phase3.resourceRecoveries.length > 0 || work.phase3.gaps.length > 0
        || work.phase3.subitems.some(item => item.outcome === "completed") || work.phase3.continuations.length > 0)
        && <section className="bot-detail-section" aria-label="事项执行情况">
        <h3>执行情况</h3>
        {work.lifecycle !== "paused" && work.phase3.settlingActions > 0 && <p role="status">仍有 {work.phase3.settlingActions} 项在途操作等待结算。</p>}
        {work.lifecycle === "paused" && <p>{work.phase3.settlingActions ? "已暂停，正在结算在途操作" : "已暂停"}，积压 {work.phase3.pausedEventCount} 条事件。</p>}
        {work.phase3.resourceWaits.map(reason => <p role="status" key={reason}>{reason}</p>)}
        {work.phase3.resourceRecoveries.map(recovery => {
          const confirmationKey = `${recovery.token}:${recovery.attempts}:${recovery.exhaustedAt}:${work.stateVersion}`;
          const resourceLabel = recovery.resourceKinds.some(kind => kind === "desktop" || kind === "browser") ? "桌面或浏览器输入" : "共享资源";
          return <article key={recovery.token} aria-label="资源隔离恢复">
            <p role="status">{resourceLabel}仍被隔离。{recovery.reason}</p>
            {recovery.pendingProbe && <p>恢复核对仍有在途步骤，资源继续隔离。</p>}
            {recovery.exhaustedAt !== undefined && !recovery.pendingProbe && <>
              <p>自动核对已停止。请先收起遮挡面板并确认旧操作已经停止，再重新核对。只有执行、输入清理和原操作效果均得到确认后，资源才会释放。</p>
              <label><input type="checkbox" checked={safeRecovery === confirmationKey} disabled={busy}
                onChange={event => setSafeRecovery(event.target.checked ? confirmationKey : null)} />我已确认环境安全，可以重新核对</label>
              <button type="button" disabled={busy || safeRecovery !== confirmationKey}
                onClick={() => { void control({ kind: "retry_resource_recovery", request: {
                  operationId: operation(`recovery:${confirmationKey}`), workId: work.workId, token: recovery.token,
                  expectedAttempts: recovery.attempts, expectedExhaustedAt: recovery.exhaustedAt!, confirmEnvironmentSafe: true, versionGuard,
                } }); }}>重新核对隔离资源</button>
            </>}
          </article>;
        })}
        <p>已保留 {work.phase3.subitems.filter(item => item.outcome === "completed").length} 项子项成果，必要缺口 {work.phase3.gaps.length} 项。</p>
        {work.phase3.gaps.map(gap => <article key={gap.factId}>
          <p>{gap.task || gap.summary} · {{ completed: "已完成", blocked: "受阻", rejected: "未获准启动", failed: "失败", stopped: "已停止", unknown: "效果待核对", not_started: "尚未启动" }[gap.outcome]}</p>
          {gap.writeConflicts.length > 0 && <p>{gap.writeConflicts.join("；")}</p>}
          <button type="button" disabled={busy || work.lifecycle !== "active" || gap.outcome === "unknown"}
            onClick={() => { void control({ kind: "continue", request: { operationId: operation(`continue:${gap.factId}`), workId: work.workId,
              sourceBindingId: gap.bindingId, gapItemIds: [gap.itemId], reason: "用户在事项详情中选择仅补齐此必要缺口", versionGuard } }); }}>仅补跑此项</button>
        </article>)}
        {work.phase3.continuations.length > 0 && <p>已受理 {work.phase3.continuations.length} 个定向补跑计划，已有成果继续保留。</p>}
      </section>}
      {work.blockers.some(blocker => blocker.details?.response) && <details>
        <summary>已保存的问题回复</summary>
        {work.blockers.filter(blocker => blocker.details?.response).map(blocker => {
          const response = blocker.details!.response as { reply?: string; evidenceRef?: string };
          return <article key={blocker.blockerId}><p>{blocker.reason}</p><p>{response.reply}</p><p>依据：{response.evidenceRef}</p></article>;
        })}
      </details>}
      <h3>成果与证据</h3>
      {work.deliverables.length === 0 ? <p>尚无保存的成果。</p> : work.deliverables.map(deliverable => <article key={deliverable.deliverableId}>
        <strong>{{ proposed: work.lifecycle === "closed" ? "未采纳（已结束）" : "待评审", accepted: "已采纳", rejected: "已拒绝", superseded: "历史成果" }[deliverable.status]}</strong>
        <p style={{ whiteSpace: "pre-wrap" }}>{deliverable.summary}</p>
        {deliverable.artifactRefs.length > 0 && <ul>{deliverable.artifactRefs.map(ref => <li key={ref}>{ref}</li>)}</ul>}
        <p>已保存 {deliverable.evidenceRefs.length} 条证据</p>
      </article>)}
      <h3>{work.lifecycle === "closed" ? "成果记录与验收" : "需要你决定"}</h3>
      {/* Review drafts retain their reviewed snapshot across background updates. */}
      <WorkReviewPanel key={`review:${work.workId}`} work={work} includeClosed={includeClosed} />
      <BotWorkApprovals work={work} /><WorkCardsPanel key={JSON.stringify(["cards", work.workId, work.intentRevision, work.inputSnapshotId,
        work.ownerEpoch, work.stateVersion, work.phase3?.artifactSnapshotId])} work={work} includeClosed={includeClosed} />
      {work.criteria.length === 0 ? <p>没有验收条件。</p> : (
        <ul>{work.criteria.map((criterion) => <li key={criterion.id}>{criterion.text} · {criterionLabel(criterion)}</li>)}</ul>
      )}
      <details className="bot-advanced">
        <summary>高级设置与诊断</summary>
        <p>交接、关注规则、预算与版本记录。这里的操作可能影响后续运行。</p>
        <dl>
          <dt>负责人代次</dt><dd>{ownerName} · {work.ownerEpoch}</dd>
          <dt>版本</dt><dd>要求 r{work.intentRevision} · 来源 v{work.sourceVersion} · 状态 v{work.stateVersion}</dd>
        </dl>
      {work.phase3 && <section className="bot-detail-section" aria-label="交接与协作">
        <details><summary>当前实测版本</summary><p>输入 {work.inputSnapshotId}</p><p>产物 {work.phase3.artifactSnapshotId ?? "无文件产物"}</p></details>
        <h3>负责人交接</h3>
        {work.phase3.handoffs.length === 0 ? <p>尚无交接记录。</p> : work.phase3.handoffs.map(message => <p key={message.messageId}>{message.body}</p>)}
        <label>交给<select aria-label="新负责人" value={targetBotId} onChange={event => setTargetBotId(event.target.value)}>
          <option value="">选择 Bot</option>
          {identities.filter(bot => bot.botId !== work.ownerBotId && bot.status === "active").map(bot => <option key={bot.botId} value={bot.botId}>{bot.displayName}</option>)}
        </select></label>
        <button type="button" disabled={busy || !targetBotId || !["active", "paused"].includes(work.lifecycle)} onClick={() => { void (async () => {
          const prepared = await control({ kind: "prepare_handoff", workId: work.workId, targetBotId });
          if (!prepared?.ok || !("preparation" in prepared)) return;
          const snapshot = prepared.preparation.work;
          await control({ kind: "handoff", request: { operationId: operation(`handoff:${targetBotId}:${snapshot.ownerEpoch}`), workId: work.workId,
            targetBotId, preparationId: prepared.preparation.preparationId, versionGuard: { expectedStateVersion: snapshot.stateVersion,
              expectedIntentRevision: snapshot.intentRevision, expectedOwnerEpoch: snapshot.ownerEpoch } } });
        })(); }}>核对并交接</button>
        <h3>协作记录</h3>
        {work.phase3.collaborationMessages.map(message => <p key={message.messageId}>{message.body}</p>)}
        <label>向负责人提问<input aria-label="协作问题" value={question} onChange={event => setQuestion(event.target.value)} maxLength={8000} /></label>
        <button type="button" disabled={busy || !question.trim()} onClick={() => { void control({ kind: "collaborate", request: { messageId: operation(`question:${question}`),
          workId: work.workId, kind: "question", recipientBotIds: [work.ownerBotId], body: question, versionGuard } }); }}>保存问题</button>
      </section>}
      {work.phase4 && <section className="bot-detail-section" aria-label="关注、离线与预算">
        <h3>关注与运行</h3>
        <p>{work.phase4.host.online ? "运行服务在线" : "运行服务离线，持续关注当前不可用"}
          {work.phase4.host.lastScanAt ? ` · 最近实际检查 ${new Date(work.phase4.host.lastScanAt).toLocaleString()}` : " · 尚无实际检查记录"}
          {work.phase4.host.suspendEvidence ? ` · 休眠证据 ${work.phase4.host.suspendEvidence}` : ""}</p>
        <p>承诺期限 {work.phase4.deadlineAt ? new Date(work.phase4.deadlineAt).toLocaleString() : "未设置"}（第 {work.phase4.deadlineRevision} 版）</p>
        {work.phase4.subscriptions.length === 0 ? <p>尚无关注规则。</p> : work.phase4.subscriptions.map(subscription => <article key={subscription.subscriptionId} aria-label="关注规则">
          <strong>{subscription.source} · {subscription.targetKey ?? "默认目标"} · {{ online: "在线", paused: "暂停积压", offline: "宿主离线", stopped: "已停止", closing: "结算中" }[subscription.status]}</strong>
          <p>策略 {{ latest: "合并为最新一次", each: "逐条处理", skip: "跳过积压" }[subscription.catchUpPolicy]} · 时区 {subscription.timezone ?? "默认"} · 规则 r{subscription.scheduleRevision} · 配置 r{subscription.configRevision}</p>
          <p>下一唤醒 {subscription.nextWakeAt ? new Date(subscription.nextWakeAt).toLocaleString() : "无"} · 最近检查 {subscription.lastCheckedAt ? new Date(subscription.lastCheckedAt).toLocaleString() : "无"}</p>
          <p>队列待处理 {subscription.queue.ready} · 已冻结 {subscription.queue.frozen} · 受阻 {subscription.queue.blocked} / 上限 {subscription.queue.maxEvents} 条 · {subscription.queue.bytes}/{subscription.queue.maxBytes} 字节
            {subscription.queue.mergeDeadlineAt ? ` · 固定合并截止 ${new Date(subscription.queue.mergeDeadlineAt).toLocaleString()}` : ""}
            {subscription.queue.waitReason ? ` · ${subscription.queue.waitReason}` : ""}</p>
          {subscription.cursors.map(cursor => <p key={`${cursor.source}:${cursor.targetKey}`}>目标 {cursor.targetKey} · 已接纳 {cursor.highestAcceptedVersion ?? "无"} · 已消费 {cursor.highestConsumedVersion ?? "无"} · 已冻结 {cursor.highestFrozenVersion ?? "无"}</p>)}
          <button type="button" disabled={busy || subscription.status === "stopped" || work.lifecycle === "closed"}
            onClick={() => { void runPhase4({ kind: "stop-subscription", operationId: operation(`stop-sub:${subscription.subscriptionId}`),
              workId: work.workId, subscriptionId: subscription.subscriptionId, reason: "用户在事项详情中停止关注", versionGuard }); }}>停止此关注</button>
          <button type="button" disabled={busy || subscription.status === "stopped"} onClick={() => { void runPhase4({ kind: "retry-backlog",
            operationId: operation(`retry-backlog:${subscription.subscriptionId}:${work.stateVersion}`), workId: work.workId,
            subscriptionId: subscription.subscriptionId, versionGuard }); }}>重试积压与拒收路由</button>
        </article>)}
        <label>来源<input aria-label="关注来源" value={watchSource} onChange={event => setWatchSource(event.target.value)} maxLength={100} /></label>
        <label>合并策略<select aria-label="合并策略" value={watchPolicy} onChange={event => setWatchPolicy(event.target.value as typeof watchPolicy)}>
          <option value="latest">合并为最新一次</option><option value="each">逐条处理</option><option value="skip">跳过积压</option>
        </select></label>
        <button type="button" disabled={busy || !watchSource.trim() || !["active", "paused"].includes(work.lifecycle)}
          onClick={() => { void runPhase4({ kind: "configure-subscription", operationId: operation(`subscribe:${watchSource}:${watchPolicy}:${work.stateVersion}`),
            workId: work.workId, source: watchSource.trim(), catchUpPolicy: watchPolicy, versionGuard }); }}>保存关注规则</button>
        <label>承诺期限<input aria-label="承诺期限" type="datetime-local" value={deadlineInput} onChange={event => setDeadlineInput(event.target.value)} /></label>
        <button type="button" disabled={busy || !deadlineInput || work.lifecycle === "closed"}
          onClick={() => { void runPhase4({ kind: "set-deadline", operationId: operation(`deadline:${deadlineInput}:${work.stateVersion}`),
            workId: work.workId, deadlineAt: new Date(deadlineInput).getTime(), versionGuard }); }}>保存期限</button>
        <button type="button" disabled={busy || work.phase4.deadlineAt === undefined || work.lifecycle === "closed"}
          onClick={() => { void runPhase4({ kind: "set-deadline", operationId: operation(`deadline-clear:${work.stateVersion}`),
            workId: work.workId, deadlineAt: null, versionGuard }); }}>取消期限</button>

        <h3>离线补处理</h3>
        {work.phase4.offlineGaps.length === 0 ? <p>没有记录的离线缺口。</p> : work.phase4.offlineGaps.map(gap => <article key={gap.gapId}>
          <p>{new Date(gap.offlineGapFrom).toLocaleString()} ~ {new Date(gap.offlineGapTo).toLocaleString()} · 依据 {gap.detectedBy} / {gap.confidence === "evidence" ? "有证据" : "推断"}
            · 策略 {{ latest: "合并为最新一次", each: "逐条处理", skip: "跳过积压" }[gap.policy]} · {{ open: "待恢复", recovering: "恢复中", recovered: "已恢复", unqueryable: "不可回查" }[gap.state]}</p>
          <p>已补 {gap.recoveredCount} · 已合并 {gap.mergedCount} · 已跳过 {gap.skippedCount} · 未知 {gap.unknownCount ?? "未统计"}{gap.gapReason ? ` · ${gap.gapReason}` : ""}</p>
        </article>)}

        <h3>共享预算</h3>
        <p>窗口 {work.phase4.budget.windowId} · {new Date(work.phase4.budget.periodStartAt).toLocaleString()} ~ {work.phase4.budget.periodEndAt ? new Date(work.phase4.budget.periodEndAt).toLocaleString() : "无期限"}
          · {work.phase4.budget.timezone ?? "默认时区"} · 策略 r{work.phase4.budget.policyRevision} · {work.phase4.budget.autoRollover ? "允许续期" : "不自动续期"}</p>
        <p>上限 {work.phase4.budget.limitTokens} · 已结算 {work.phase4.budget.committedTokens} · 在途预留 {work.phase4.budget.reservedTokens} · 未知 {work.phase4.budget.unknownTokens}（{work.phase4.budget.unknownUsageCount} 笔）· 可用 {work.phase4.budget.availableTokens}</p>
        {work.phase4.budget.pendingRollover && <p role="status">{work.phase4.budget.pendingRollover}</p>}
        <label>预算上限<input aria-label="预算上限" type="number" min={0} step={1} disabled={busy} value={budgetLimit}
          onChange={event => setBudgetDraft({ base: remoteBudgetLimit, value: event.target.value })} /></label>
        <button type="button" disabled={busy || !["active", "paused"].includes(work.lifecycle) || !budgetDirty}
          onClick={() => { if (!budgetDirty || busy) return; void runPhase4({ kind: "set-budget-policy", operationId: operation(`budget:${budgetLimit}:${work.stateVersion}`),
            workId: work.workId, maxTokens: Number(budgetLimit), versionGuard }); }}>保存预算政策</button>

        <h3>因果准入</h3>
        {work.phase4.causal.length === 0 ? <p>尚无因果准入记录。</p> : <details><summary>最近 {work.phase4.causal.length} 次准入</summary>
          {work.phase4.causal.map(item => <p key={item.chainId}>{item.decision === "admitted" ? "已准入" : "已拦截"} · 深度 {item.depth} · 互调 {item.hops} 跳 · 派发 {item.dispatchCount} · {item.reasonCode ?? item.rootEventId}</p>)}
        </details>}
      </section>}
      </details>
      {controlNotice && <p role="status">{controlNotice}</p>}
      {phase4Notice && <p role="status">{phase4Notice}</p>}
    </div>
  );
}
