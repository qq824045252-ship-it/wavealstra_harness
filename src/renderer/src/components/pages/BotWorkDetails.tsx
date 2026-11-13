import ScopedMemoryPanel from "../settings/ScopedMemoryPanel";
import { WorkExecutionMetrics } from "./WorkExecutionMetrics";
import { BotExecutionDiagnosticsButton } from "./BotExecutionDiagnostics";
import { BotWorkArchiveActions } from "./BotWorkArchiveActions";
import { BotCollaborationLog } from "./BotCollaborationLog";
import { isWorkEffectDiagnostic, WORK_EFFECT_DISPOSITION } from "@shared/work-effect-policy";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import type { WorkCriterionDto, WorkLifecycle, WorkProjectionDto } from "@shared/bot-work";
import type { WorkPhase3ControlRequest } from "@shared/bot-work-phase3-control";
import type { WorkPhase4ControlRequest } from "@shared/bot-work-phase4";
import { useAppStore } from "@/store/appStore";
import { WorkCardsPanel } from "./BotWorkCardsPanel";
import { BotTeamPanel } from "./BotTeamPanel";
import { workDetailStatus } from "@/lib/botWorkDetailPresentation";
import { WorkFiles, WorkResultText, generatedWorkFiles } from "./BotWorkResult";
import { BotWorkEvidence } from "./BotWorkOutcome";
import { BotWorkOverview } from "./BotWorkOverview";
import { BotWorkRuntimeDetails } from "./BotWorkRuntimeDetails";
import "./BotWorkDetails.css";

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

const savedResponseSchema = z.object({ reply: z.string().optional(), evidenceRef: z.string().optional() });

export function BotWorkDetails(props: { work: WorkProjectionDto; ownerName: string; includeClosed: boolean;
  onReplyToBlocker?: (blocker: WorkProjectionDto["blockers"][number]) => void }): React.JSX.Element {
  const { work, ownerName, includeClosed } = props;
  const [goalExpanded, setGoalExpanded] = useState(false);
  const goalId = useId();
  const goal = work.goalDescription?.trim() || work.title;
  const effectDiagnostics = work.blockers.filter(blocker => isWorkEffectDiagnostic(blocker)
    && (blocker.status === "open" || blocker.details?.effectDisposition === WORK_EFFECT_DISPOSITION));
  const identities = useAppStore(s => s.botIdentities);
  const [originalOpen, setOriginalOpen] = useState(false);
  const originalKey = `${work.workId}:${work.intentRevision}:${work.sourceVersion}`;
  const [originalResult, setOriginal] = useState<{ key: string; value: WorkProjectionDto["originalDelegation"] }>();
  const original = originalResult?.key === originalKey ? originalResult.value : undefined;
  const [originalError, setOriginalError] = useState(false);
  const [originalRetry, setOriginalRetry] = useState(0);
  useEffect(() => {
    setOriginal(undefined); setOriginalError(false);
    if (!originalOpen) return;
    let current = true;
    const api = window.api?.botWork;
    if (!api?.getWork) { setOriginalError(true); return; }
    void api.getWork(work.workId).then(detail => {
      if (!current) return;
      if (!detail || detail.workId !== work.workId || detail.intentRevision !== work.intentRevision
        || detail.sourceVersion !== work.sourceVersion || !detail.originalDelegation) setOriginalError(true);
      else setOriginal({ key: originalKey, value: detail.originalDelegation });
    }).catch(() => { if (current) setOriginalError(true); });
    return () => { current = false; };
  }, [originalOpen, originalRetry, originalKey, work.workId, work.intentRevision, work.sourceVersion]);
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

  const historicalCollaboration = work.phase3?.collaborationMessages.filter(message => !work.team
    || message.intentRevision !== work.intentRevision || message.inputSnapshotId !== work.inputSnapshotId) ?? [];

  return (
    <div className="bot-work-details">
      <header className="bot-work-detail-heading">
        <h2>{work.title}</h2>
        <div className="bot-work-detail-byline"><span className="bot-work-status" data-state={work.lifecycle}>{workDetailStatus(work)}</span>
          <span>{ownerName}</span><span>{work.mode === "watch" ? "持续关注" : "单次委托"}</span>
          {work.archive?.archivedAt && <span>已归档</span>}
        </div>
        {goal !== work.title && <div className="bot-work-goal-preview"><p id={goalId}>{goalExpanded || goal.length <= 160 ? goal : `${goal.slice(0, 160)}…`}</p>
          {goal.length > 160 && <button type="button" aria-expanded={goalExpanded} aria-controls={goalId} onClick={() => setGoalExpanded(value => !value)}>{goalExpanded ? "收起目标" : "展开完整目标"}</button>}</div>}
      </header>
      <BotWorkOverview work={work} onReplyToBlocker={props.onReplyToBlocker} />
      <details className="bot-work-disclosure" aria-label="过程与依据">
        <summary>查看过程与依据</summary>
        <BotWorkEvidence work={work} identities={identities} />
      <details aria-label="任务目标与原委托">
        <summary>任务目标与原委托</summary>
        <h3>任务目标</h3>
        <p className="bot-work-goal">{work.goalDescription?.trim() ? work.goalDescription : work.title}</p>
        <details className="bot-work-original-delegation" onToggle={event => setOriginalOpen(event.currentTarget.open)}>
          <summary>原委托（用户原文）</summary>
          {originalOpen && (originalError ? <p role="status">暂时无法读取原委托。<button type="button" onClick={() => setOriginalRetry(value => value + 1)}>重试</button></p>
            : !original ? <p role="status">正在读取原委托…</p>
            : original.unavailable ? <p>原委托来源暂不可核验；上方目标不代表用户逐字原文。</p>
            : original.messages.length ? <>{original.descriptionOrigin === "assistant" && <p>上方目标由助理整理，以下为此事项保存的用户原文；后续修改优先。</p>}{original.messages.map(message => <div key={message.messageId}><h4>委托修订 {message.intentRevision}</h4><p className="bot-work-goal">{message.text}</p></div>)}{Boolean(original.context?.length) && <details><summary>相关对话与引用（保留角色，仅作上下文）</summary>{original.context?.map(message => <div key={message.messageId}><h4>{message.peerOrigin ? `来自 ${message.peerOrigin.senderDisplayName} 的 Bot 协作` : message.role === "user" ? "用户" : "助理"}</h4><p className="bot-work-goal">{message.text}</p></div>)}</details>}</>
            : <p>此事项没有关联的对话原文；请以上方目标及验收要求为准。</p>)}
        </details>
      </details>
      <section aria-label="执行过程">
        <BotTeamPanel work={work} identities={identities} />

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
          {gap.coverageEligible && <p>若后续成果已覆盖此项，请在对话中说明依据，由助理核对是否仍需补跑。</p>}
          {gap.writeConflicts.length > 0 && <p>{gap.writeConflicts.join("；")}</p>}
          <button type="button" disabled={busy || work.lifecycle !== "active" || gap.outcome === "unknown"}
            onClick={() => { void control({ kind: "continue", request: { operationId: operation(`continue:${gap.factId}`), workId: work.workId,
              sourceBindingId: gap.bindingId, gapItemIds: [gap.itemId], reason: "用户在事项详情中选择仅补齐此必要缺口", versionGuard } }); }}>仅补跑此项</button>
        </details>)}
        {work.phase3.continuations.length > 0 && <p>已受理 {work.phase3.continuations.length} 个定向补跑计划，已有成果继续保留。</p>}
      </section>}
      {work.blockers.length > 0 && <details>
        <summary>问题与阻碍记录</summary>
        {work.blockers.map(blocker => {
          const parsed = savedResponseSchema.safeParse(blocker.details?.response);
          const response = parsed.success ? parsed.data : undefined;
          return <article key={blocker.blockerId}><p>{blocker.reason}</p><p>{blocker.status === "open" ? "尚未解除" : "已解除"}</p>
            {response?.reply && <p>{response.reply}</p>}{response?.evidenceRef && <p>依据：{response.evidenceRef}</p>}</article>;
        })}
      </details>}
      {!!work.generatedArtifacts?.length && <details className="bot-advanced" aria-label="全部生成文件">
        <summary>全部生成文件 · {work.generatedArtifacts.length}</summary>
        <p>保存版本与原始路径均保留；是否完成由助理结合原委托与实际结果判断。</p>
        <WorkFiles files={generatedWorkFiles(work)} />
      </details>}
      {work.criteria.length > 0 && <details className="bot-advanced">
        <summary>历史检查记录</summary>
        <p>保留执行时的检查记录，不要求你逐项验收；最终结论见助理回复。</p>
        <ul>{work.criteria.map(criterion => <li key={criterion.id}>{criterion.text} · {criterionLabel(criterion)}</li>)}</ul>
      </details>}
        {historicalCollaboration.length > 0 && <section aria-label="协作记录">
          <h3>{work.team ? "历史版本协作记录" : "协作记录"}</h3>
          <BotCollaborationLog messages={historicalCollaboration} identities={identities} />
        </section>}
        {!!work.phase3?.handoffs.length && <details><summary>负责人交接记录</summary>
          {work.phase3.handoffs.map(message => <p key={message.messageId}>{message.body}</p>)}
        </details>}
        {work.closureSummary && <details className="bot-original-report"><summary>结束说明原文</summary><WorkResultText text={work.closureSummary} /></details>}
      </section>
      </details>
      <details className="bot-work-disclosure" aria-label="任务管理">
        <summary>管理任务</summary>
        <BotWorkArchiveActions key={work.workId} work={work} />

        <ScopedMemoryPanel key={"memory:work:" + work.workId} scopeType="work" scopeId={work.workId} title="事项记忆" />
        {work.projectId && <ScopedMemoryPanel key={"project:" + work.projectId} scopeType="project" scopeId={work.projectId} title="项目记忆" />}
      {work.phase3 && ["active", "paused"].includes(work.lifecycle) && <section className="bot-detail-section" aria-label="交接与协作">
        <h3>负责人交接</h3>
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
        <label>向负责人提问<input aria-label="协作问题" value={question} onChange={event => setQuestion(event.target.value)} maxLength={8000} /></label>
        <button type="button" disabled={busy || !question.trim()} onClick={() => { void control({ kind: "collaborate", request: { messageId: operation(`question:${question}`),
          workId: work.workId, kind: "question", recipientBotIds: [work.ownerBotId], body: question, versionGuard } }); }}>保存问题</button>
      </section>}
      {work.phase4 && work.mode === "watch" && ["active", "paused"].includes(work.lifecycle) && <section className="bot-detail-section" aria-label="跟踪管理">
        <h3>跟踪安排</h3>
        <p>承诺期限 {work.phase4.deadlineAt ? new Date(work.phase4.deadlineAt).toLocaleString() : "未设置"}（第 {work.phase4.deadlineRevision} 版）</p>
        {work.phase4.subscriptions.length === 0 ? <p>尚无关注规则。</p> : work.phase4.subscriptions.map(subscription => <article key={subscription.subscriptionId} aria-label="关注规则">
          <strong>{subscription.source} · {subscription.targetKey ?? "默认目标"}</strong>
          <p>策略 {{ latest: "合并为最新一次", each: "逐条处理", skip: "跳过积压" }[subscription.catchUpPolicy]} · 时区 {subscription.timezone ?? "默认"}</p>
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

      </section>}
      </details>
      <details className="bot-work-disclosure" aria-label="诊断信息">
        <summary>查看诊断信息</summary>
        <BotExecutionDiagnosticsButton request={{kind:"work",workId:work.workId}} />
        <WorkExecutionMetrics work={work} />
        <BotWorkRuntimeDetails work={work} />
        <dl>
          <dt>负责人代次</dt><dd>{ownerName} · {work.ownerEpoch}</dd>
          <dt>版本</dt><dd>要求 r{work.intentRevision} · 来源 v{work.sourceVersion} · 状态 v{work.stateVersion}</dd>
        </dl>
      {effectDiagnostics.length > 0 && <details className="bot-detail-section" aria-label="非阻塞执行记录">
        <summary>非阻塞执行记录（{effectDiagnostics.length}）</summary>
        <p>执行记录已保留，不阻止其他步骤。失败不会被视为成功，未知结果不会自动重放。</p>
        <ul>{effectDiagnostics.map(item => <li key={item.blockerId}>{item.reason}</li>)}</ul>
      </details>}
      <details className="bot-advanced"><summary>投递与版本记录</summary>
        <WorkCardsPanel key={JSON.stringify(["cards", work.workId, work.intentRevision, work.inputSnapshotId,
          work.ownerEpoch, work.stateVersion, work.phase3?.artifactSnapshotId])} work={work} includeClosed={includeClosed} />
      </details>
      </details>
      {controlNotice && <p role="status">{controlNotice}</p>}
      {phase4Notice && <p role="status">{phase4Notice}</p>}
    </div>
  );
}
