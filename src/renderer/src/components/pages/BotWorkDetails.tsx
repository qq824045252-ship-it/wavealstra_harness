import { WorkExecutionMetrics } from "./WorkExecutionMetrics";
import { BotWorkArchiveActions } from "./BotWorkArchiveActions";
import { BotCollaborationLog } from "./BotCollaborationLog";
import { userInputBlockerSnapshot } from "@shared/bot-work-review";
import { isWorkEffectDiagnostic, WORK_EFFECT_DISPOSITION } from "@shared/work-effect-policy";
import { useRef, useState } from "react";
import type { WorkCriterionDto, WorkLifecycle, WorkProjectionDto } from "@shared/bot-work";
import type { WorkPhase3ControlRequest } from "@shared/bot-work-phase3-control";
import type { WorkPhase4ControlRequest } from "@shared/bot-work-phase4";
import { useAppStore } from "@/store/appStore";
import { WorkCardsPanel } from "./BotWorkCardsPanel";
import { BotTeamPanel } from "./BotTeamPanel";
import { WorkReviewPanel } from "./BotWorkReviewPanel";
import { workStatusLabel } from "@/lib/botWorkspacePresentation";
import { WorkFiles, WorkReport, WorkResultText, generatedWorkFiles } from "./BotWorkResult";

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
  return "未单独登记检查";
}

export function BotWorkDetails(props: { work: WorkProjectionDto; ownerName: string; includeClosed: boolean;
  onReplyToBlocker?: (blocker: WorkProjectionDto["blockers"][number]) => void }): React.JSX.Element {
  const { work, ownerName, includeClosed } = props;
  const openBlockers = work.blockers.filter((blocker) => blocker.status === "open" && !isWorkEffectDiagnostic(blocker));
  const effectDiagnostics = work.blockers.filter(blocker => isWorkEffectDiagnostic(blocker)
    && (blocker.status === "open" || blocker.details?.effectDisposition === WORK_EFFECT_DISPOSITION));
  const identities = useAppStore(s => s.botIdentities);
  const [targetBotId, setTargetBotId] = useState("");
  const [question, setQuestion] = useState("");
  const [controlNotice, setControlNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase4Notice, setPhase4Notice] = useState("");
  const [watchSource, setWatchSource] = useState("hook");
  const [watchPolicy, setWatchPolicy] = useState<"latest" | "each" | "skip">("latest");
  const [deadlineInput, setDeadlineInput] = useState("");
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
    const requestId = request.kind === "continue" || request.kind === "handoff" ? request.request.operationId
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

  const requiredCriteria = work.criteria.filter(item => item.origin !== "assistant_proposal");
  const suggestedCriteria = work.criteria.filter(item => item.origin === "assistant_proposal");

  return (
    <div className="bot-work-details">
      <header className="bot-work-detail-heading">
        <span className="bot-work-status" data-state={work.lifecycle}>{workStatusLabel(work)}</span>
        <h2>{work.title}</h2>
        <p>{ownerName} · {work.mode === "watch" ? "持续关注" : "一次性事项"}</p>
      </header>
      <BotWorkArchiveActions key={work.workId} work={work} />
      <WorkExecutionMetrics work={work} />
      <section className="bot-detail-section" aria-label="目标与进度">
        <h3>目标</h3>
        <p>{work.title}</p>
        <h3>进度</h3>
        <p>{workStatusLabel(work)}。{work.archive?.archivedAt ? "此事项已归档，不会自动重试；记录与已有成果保留。" : work.lifecycle === "closed" ? "处理结论已返回对话，原始结果保留在下方。" : "助理会对照原委托核对实际结果，自动补缺并返回结论。"}</p>
        {work.closureSummary && <details className="bot-original-report"><summary>结束说明原文</summary><WorkResultText text={work.closureSummary} /></details>}
      </section>
      {work.mode === "watch" && work.phase4 && <section className="bot-detail-section" aria-label="持续跟踪安排">
        <h3>持续跟踪</h3>
        {work.watchPlan?.scheduleBasis === "recommended" && <p>建议安排，可随时更改。{work.watchPlan.scheduleRationale}</p>}
        {work.phase4.subscriptions.filter(item => item.status !== "stopped").map(item => <p key={item.subscriptionId}>
          {item.nextWakeAt !== undefined ? `下次检查 ${new Date(item.nextWakeAt).toLocaleString(undefined, { timeZone: item.timezone })}` : "本次安排没有后续检查"}
          {item.timezone ? `（${item.timezone}）` : ""}
          {item.cronExpression ? ` · 时间表 ${item.cronExpression}` : " · 一次性检查"}
          {work.lifecycle === "paused" ? " · 已暂停" : ""}
        </p>)}
        {!work.phase4.subscriptions.some(item => item.status !== "stopped") && <p>已停止后续检查。</p>}
        <p>按约定时间检查。应用退出或电脑休眠时不运行，恢复后按补查策略处理。</p>
      </section>}
      <BotTeamPanel work={work} identities={identities} />
      {work.lifecycle !== "closed" && <section className="bot-detail-section bot-work-next" aria-label="下一步">
        <h3>下一步</h3>
        {work.nextSteps.length === 0 ? <p>暂无已记录的下一步。</p>
          : <ul>{work.nextSteps.map(step => <li key={step}>{step}</li>)}</ul>}
      </section>}
      {(openBlockers.length > 0 || !work.inputSnapshotBound || work.uncoveredScope.length > 0) && <section className="bot-work-alert" aria-label="需要关注的阻碍">
        <h3>需要关注</h3>
        {!work.inputSnapshotBound && <p role="status">输入版本尚未绑定，不能据此确认成果已验证。</p>}
        {openBlockers.map(blocker => <article key={blocker.blockerId}>
          <p>{blocker.waitingForUserInput ? "需要处理：" : "阻碍："}{blocker.reason}</p>
          {userInputBlockerSnapshot(blocker) || blocker.legacyUserInput ? <p>请在下方「回复待补充信息」中填写回复和依据。</p>
            : blocker.blockerId.startsWith("continuation:") ? <p>已有成果保留，恢复时只处理必要缺口，不会重跑整个事项。</p>
                  : <p>执行问题保留在此处，普通回复不会解除阻碍。</p>}
          {blocker.waitingForUserInput && blocker.kind === "operational" && !blocker.unknownExternalEffectRef
            && (!blocker.reasonCode || blocker.reasonCode === "user-input") && !blocker.blockerId.startsWith("continuation:")
            && !userInputBlockerSnapshot(blocker) && !blocker.legacyUserInput && props.onReplyToBlocker && work.lifecycle !== "closed" && <>
            <button type="button" onClick={() => props.onReplyToBlocker?.(blocker)}>向负责人回复此问题</button>
            <p>打开关联事项的对话草稿，由你填写并发送。回复供负责人核对，原阻碍暂保留；权限和未知效果仍需单独核对。</p>
          </>}
        </article>)}
        {work.uncoveredScope.length > 0 && <p>尚未覆盖：{work.uncoveredScope.join("、")}</p>}
      </section>}
      {effectDiagnostics.length > 0 && <details className="bot-detail-section" aria-label="非阻塞执行记录">
        <summary>非阻塞执行记录（{effectDiagnostics.length}）</summary>
        <p>执行记录已保留，不阻止其他步骤。失败不会被视为成功，未知结果不会自动重放。</p>
        <ul>{effectDiagnostics.map(item => <li key={item.blockerId}>{item.reason}</li>)}</ul>
      </details>}
      {work.phase4 && (!work.phase4.host.online || work.phase4.offlineGaps.some(gap => gap.state !== "recovered")) && <section className="bot-work-alert" aria-label="运行提醒">
        <h3>运行提醒</h3>
        {!work.phase4.host.online && <p role="status">运行服务离线，持续关注当前不可用。</p>}
        {work.phase4.offlineGaps.some(gap => gap.state !== "recovered") && <p>存在尚未恢复或无法回查的离线记录，请在高级设置中核对。</p>}
      </section>}
      {work.phase3 && (work.lifecycle === "paused" || work.phase3.settlingActions > 0 || work.phase3.gaps.length > 0
        || work.phase3.subitems.some(item => item.outcome === "completed") || work.phase3.continuations.length > 0)
        && <section className="bot-detail-section" aria-label="事项执行情况">
        <h3>执行情况</h3>
        {work.lifecycle !== "paused" && work.phase3.settlingActions > 0 && <p role="status">仍有 {work.phase3.settlingActions} 项在途操作等待结算。</p>}
        {work.lifecycle === "paused" && <p>{work.phase3.settlingActions ? "已暂停，正在结算在途操作" : "已暂停"}，积压 {work.phase3.pausedEventCount} 条事件。</p>}
        <p>已保留 {work.phase3.subitems.filter(item => item.outcome === "completed").length} 项子项成果，必要缺口 {work.phase3.gaps.length} 项。</p>
        {work.phase3.gaps.map(gap => <details key={gap.factId}>
          <summary>{(gap.task || gap.itemId).slice(0, 110)}{(gap.task || gap.itemId).length > 110 ? "…" : ""} · {gap.outcome}</summary>
          <p>{gap.task || gap.summary} · {{ completed: "已完成", blocked: "受阻", rejected: "未获准启动", failed: "失败", stopped: "已停止", unknown: "效果待核对", not_started: "尚未启动" }[gap.outcome]}</p>
          {gap.coverageEligible && <p>若已用后续成果完成同一目标，可在下方“结束事项”中关联证据覆盖此未执行动作，无需重跑。</p>}
          {gap.writeConflicts.length > 0 && <p>{gap.writeConflicts.join("；")}</p>}
          <button type="button" disabled={busy || work.lifecycle !== "active" || gap.outcome === "unknown"}
            onClick={() => { void control({ kind: "continue", request: { operationId: operation(`continue:${gap.factId}`), workId: work.workId,
              sourceBindingId: gap.bindingId, gapItemIds: [gap.itemId], reason: "用户在事项详情中选择仅补齐此必要缺口", versionGuard } }); }}>仅补跑此项</button>
        </details>)}
        {work.phase3.continuations.length > 0 && <p>已受理 {work.phase3.continuations.length} 个定向补跑计划，已有成果继续保留。</p>}
      </section>}
      {work.blockers.some(blocker => blocker.details?.response) && <details>
        <summary>已保存的问题回复</summary>
        {work.blockers.filter(blocker => blocker.details?.response).map(blocker => {
          const response = blocker.details!.response as { reply?: string; evidenceRef?: string };
          return <article key={blocker.blockerId}><p>{blocker.reason}</p><p>{response.reply}</p><p>依据：{response.evidenceRef}</p></article>;
        })}
      </details>}
      {!!work.runtimeObservations?.length && <section aria-label="当前执行状态">
        <h3>当前执行状态</h3>
        {work.runtimeObservations.map(observation => <p key={observation.bindingId} role="status">
          <strong>{{ recovering: "恢复中", running: "正在执行", waiting: "等待执行器", interrupted: "执行已中断" }[observation.state]}</strong>：{observation.reason}
        </p>)}
      </section>}
      <h3>成果与证据</h3>
      {work.deliverables.length === 0 ? <p>尚无保存的成果。</p> : work.deliverables.map(deliverable => <article key={deliverable.deliverableId}>
        <WorkReport report={{ title: work.title, summary: deliverable.summary, artifactRefs: deliverable.artifactRefs,
          ...deliverable.presentation, reviewStatus: deliverable.status,
          current: deliverable.intentRevision === work.intentRevision && deliverable.inputSnapshotId === work.inputSnapshotId,
          notices: [...deliverable.uncoveredScope.map(scope => `尚未覆盖：${scope}`),
            ...(deliverable.isSpeculation ? ["该成果包含推测，仍需验证。"] : []),
            ...(deliverable.hasWriteConflicts ? ["存在写入冲突，仍需处理。"] : []),
            ...(deliverable.rejectedReason ? [`未通过核验：${deliverable.rejectedReason}`] : [])],
        }} originalText={deliverable.summary} executionId={deliverable.executionId} work={work}
          renderMarkdown={text => <WorkResultText text={text} />} />
        <p>已保存 {deliverable.evidenceRefs.length} 条证据</p>
      </article>)}
      {!!work.generatedArtifacts?.length && <details className="bot-advanced" aria-label="全部生成文件">
        <summary>全部生成文件 · {work.generatedArtifacts.length}</summary>
        <p>保存版本与原始路径均保留；是否完成由助理结合原委托与实际结果判断。</p>
        <WorkFiles files={generatedWorkFiles(work)} />
      </details>}
      <h3>原始执行记录</h3>
      {/* Review drafts retain their reviewed snapshot across background updates. */}
      <WorkReviewPanel key={`review:${work.workId}`} work={work} includeClosed={includeClosed} />
      <details className="bot-advanced"><summary>投递与版本记录</summary>
        <WorkCardsPanel key={JSON.stringify(["cards", work.workId, work.intentRevision, work.inputSnapshotId,
          work.ownerEpoch, work.stateVersion, work.phase3?.artifactSnapshotId])} work={work} includeClosed={includeClosed} />
      </details>
      {(requiredCriteria.length > 0 || suggestedCriteria.length > 0) && <details className="bot-advanced">
        <summary>历史检查记录</summary>
        <p>保留执行时的检查记录，不要求你逐项验收；最终结论见助理回复。</p>
        <ul>{work.criteria.map(criterion => <li key={criterion.id}>{criterion.text} · {criterionLabel(criterion)}</li>)}</ul>
      </details>}
      <details className="bot-advanced">
        <summary>高级设置与诊断</summary>
        <p>交接、关注规则与版本记录。这里的操作可能影响后续运行。</p>
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
        <h3>{work.team ? "历史版本协作记录" : "协作记录"}</h3>
        {work.team && <p>当前版本的协作内容见上方团队协作，此处仅保留较早版本，不重复展开。</p>}
        <BotCollaborationLog messages={work.phase3.collaborationMessages.filter(message => !work.team
          || message.intentRevision !== work.intentRevision || message.inputSnapshotId !== work.inputSnapshotId)} identities={identities} />
        <label>向负责人提问<input aria-label="协作问题" value={question} onChange={event => setQuestion(event.target.value)} maxLength={8000} /></label>
        <button type="button" disabled={busy || !question.trim()} onClick={() => { void control({ kind: "collaborate", request: { messageId: operation(`question:${question}`),
          workId: work.workId, kind: "question", recipientBotIds: [work.ownerBotId], body: question, versionGuard } }); }}>保存问题</button>
      </section>}
      {work.phase4 && <section className="bot-detail-section" aria-label="关注与离线">
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
