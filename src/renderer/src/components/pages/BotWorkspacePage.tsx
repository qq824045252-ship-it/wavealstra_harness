import { useEffect, useRef, useState } from "react";
import type { BotDto, WorkBudgetReservationDto, WorkCriterionDto, WorkLifecycle, WorkProjectionDto } from "@shared/bot-work";
import type { WorkPhase3ControlRequest } from "@shared/bot-work-phase3-control";
import type { WorkPhase4ControlRequest, WorkPhase4ControlResult } from "@shared/bot-work-phase4";
import type { BotWorkHostStatusDto } from "@shared/bot-work-ipc";
import { useAppStore } from "@/store/appStore";
import { WorkCardsPanel } from "./BotWorkCardsPanel";
import { WorkReviewPanel } from "./BotWorkReviewPanel";
import { BotExpertReview } from "./BotExpertReview";
import "./BotWorkspacePage.css";

function presenceLabel(bot: BotDto, host: BotWorkHostStatusDto | null): string {
  if (bot.status === "disabled") return "已停用";
  if (bot.status === "paused") return "已暂停";
  if (!host) return "未核实";
  return host.online ? "在线" : "离线";
}

function lifecycleLabel(lifecycle: WorkLifecycle): string {
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

export default function BotWorkspacePage(): React.JSX.Element {
  const setPage = useAppStore((s) => s.setPage);
  const botDraft = useAppStore((s) => s.botDraft);
  const setBotDraft = useAppStore((s) => s.setBotDraft);
  const submitBotDraft = useAppStore((s) => s.submitBotDraft);
  const notice = useAppStore((s) => s.botSubmissionNotice);
  const histories = useAppStore((s) => s.botHistories);
  const sendErrors = useAppStore((s) => s.botConversationErrors);
  const pendingSends = useAppStore((s) => s.botPendingSends);
  const identities = useAppStore((s) => s.botIdentities);
  const works = useAppStore((s) => s.botWorks);
  const activeBotId = useAppStore((s) => s.activeBotId);
  const selectedWorkId = useAppStore((s) => s.selectedWorkId);
  const setSelectedWorkId = useAppStore((s) => s.setSelectedWorkId);
  const hostStatus = useAppStore((s) => s.botHostStatus);
  const workError = useAppStore((s) => s.botWorkError);
  const allWorksLoaded = useAppStore((s) => s.botWorkCursor?.scope === "all");
  const [includeClosed, setIncludeClosed] = useState(allWorksLoaded);
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    typeof window === "undefined" || !window.matchMedia?.("(max-width: 900px)").matches,
  );

  useEffect(() => {
    void useAppStore.getState().refreshBotWork(includeClosed);
  }, [includeClosed]);
  useEffect(() => {
    if (!activeBotId) return;
    const refresh = () => { void useAppStore.getState().refreshBotHistory(activeBotId); void useAppStore.getState().refreshBotWork(includeClosed); };
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [activeBotId, includeClosed]);

  const activeBot = identities.find((bot) => bot.botId === activeBotId) ?? null;
  const openWorks = works.filter((work) => work.ownerBotId === activeBot?.botId && (includeClosed || work.lifecycle !== "closed"));
  const selected = openWorks.find((work) => work.workId === selectedWorkId) ?? null;
  const decisions = openWorks.filter((work) =>
    work.nextSteps.some((step) => step.startsWith("需要你的决定") || step.startsWith("等待实测"))
    || work.blockers.some((blocker) => blocker.status === "open" && blocker.waitingForUserInput),
  );

  return (
    <div className="bot-workspace">
      <section className="bot-conversation" aria-label="Bot 对话">
        <header className="bot-workspace-header">
          <div>
            <h1>Bot 模式</h1>
            <p>{activeBot ? `${activeBot.displayName} · ${presenceLabel(activeBot, hostStatus)}` : "长期对话与 Work"}</p>
          </div>
          <div className="bot-workspace-actions">
            <button type="button" onClick={() => setPage("chat")}>返回普通模式</button>
            <button type="button" aria-pressed={includeClosed} onClick={() => setIncludeClosed(value => !value)}>{includeClosed ? "隐藏已结束事项" : "查看已结束事项"}</button>
            <button type="button" aria-expanded={inspectorOpen} aria-controls="bot-work-inspector" onClick={() => setInspectorOpen((open) => !open)}>{inspectorOpen ? "收起详情" : "Work 详情"}</button>
          </div>
        </header>
        {activeBot ? (
          <div className="bot-thread">
            <button type="button" onClick={() => { void useAppStore.getState().archiveBotConversation(activeBot.botId); }}>归档对话</button>
            {sendErrors[activeBot.botId] && <p role="alert">{sendErrors[activeBot.botId]}</p>}
            {(histories[activeBot.botId]?.messages ?? []).map(message => <article key={message.messageId} data-message-id={message.messageId}>
              <strong>{message.role === "user" ? "你" : activeBot.displayName}</strong>
              <p style={{ whiteSpace: "pre-wrap" }}>{message.text || (message.status === "queued" ? "等待回复" : "处理中")}</p>
              <small>{message.status === "completed" ? message.role === "user" ? "已发送" : "已回复"
                : { queued: "等待回复", running: "正在回复", cancelled: "已停止", unknown: "结果待核对", failed: "回复失败" }[message.status]}</small>
              {message.error && <p role="alert">{message.error}</p>}
              {message.workIds.map(workId => <button type="button" key={workId} onClick={() => setSelectedWorkId(workId)}>{works.find(work => work.workId === workId)?.title ?? workId}</button>)}
              {message.role === "assistant" && ["queued", "running", "unknown"].includes(message.status) && <button type="button" onClick={() => { void useAppStore.getState().cancelBotSend(activeBot.botId, message.requestId); }}>停止回复</button>}
            </article>)}
            {workError && <p role="alert">{workError}</p>}
            {openWorks.length === 0 ? (
              <p>{includeClosed ? "这个 Bot 还没有可显示的事项。" : "这个 Bot 还没有未结束的事项。"}普通消息不会自动创建事项。</p>
            ) : openWorks.map((work) => (
              <WorkCard key={work.workId} work={work} selected={work.workId === selected?.workId} ownerName={activeBot.displayName} onSelect={() => setSelectedWorkId(work.workId)} />
            ))}
            <h3>待决事项</h3>
            {decisions.length === 0 ? <p>暂无可显示的待决事项。</p> : (
              <ul>{decisions.map((work) => <li key={work.workId}>{work.title}：{work.nextSteps[0] ?? "需要处理"}</li>)}</ul>
            )}
            {activeBot && <details className="bot-expert-config">
              <summary>专家配置审阅</summary>
              <BotExpertReview botId={activeBot.botId} />
            </details>}
          </div>
        ) : (
          <div className="bot-conversation-empty">
            <h2>还没有 Bot</h2>
            <p>{workError ?? "受理服务尚未接线，暂时无法开始对话或受理事项。"}</p>
            <p>待决事项：暂无可显示的事项。</p>
          </div>
        )}
        <form className="bot-composer" onSubmit={(event) => { event.preventDefault(); submitBotDraft(); }}>
          {notice && <p role="status">消息已持久受理。</p>}
          <label htmlFor="bot-draft">Bot 对话草稿</label>
          <textarea id="bot-draft" value={botDraft} onChange={(event) => setBotDraft(event.target.value)} placeholder="输入草稿" rows={3} />
          <button type="submit" disabled={!activeBotId || !botDraft.trim() || pendingSends[activeBotId]?.sending}>{activeBotId && pendingSends[activeBotId]?.error ? "重试原请求" : "发送"}</button>
        </form>
      </section>
      {inspectorOpen && <aside className="bot-inspector" id="bot-work-inspector" aria-label="Work 详情">
        <button type="button" onClick={() => setInspectorOpen(false)}>关闭详情</button>
        {selected ? <WorkFacts key={selected.workId} work={selected} ownerName={activeBot?.displayName ?? selected.ownerBotId} includeClosed={includeClosed} /> : (
          <>
            <h2>Work 详情</h2>
            <p>{activeBot ? `${activeBot.displayName} 还没有选中的事项。` : "还没有 Work。受理服务尚未接线。"}</p>
            <h3>待决事项</h3>
            <p>暂无可显示的待决事项。</p>
          </>
        )}
      </aside>}
    </div>
  );
}

function WorkCard(props: { work: WorkProjectionDto; selected: boolean; ownerName: string; onSelect: () => void }): React.JSX.Element {
  const { work, selected, ownerName, onSelect } = props;
  return (
    <button type="button" className="bot-work-card" aria-pressed={selected} onClick={onSelect}>
      <strong>{work.title}</strong>
      <span>{lifecycleLabel(work.lifecycle)} · {work.mode === "watch" ? "持续" : "一次"}</span>
      <span>负责人 {ownerName}</span>
      {work.nextSteps[0] && <span>{work.nextSteps[0]}</span>}
    </button>
  );
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

function WorkFacts(props: { work: WorkProjectionDto; ownerName: string; includeClosed: boolean }): React.JSX.Element {
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
  const [budgetLimit, setBudgetLimit] = useState(String(work.phase4?.budget.limitTokens ?? 500000));
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

  return (
    <>
      <h2>{work.title}</h2>
      <dl>
        <dt>状态</dt>
        <dd>{lifecycleLabel(work.lifecycle)}{work.closureConclusion ? ` · ${work.closureConclusion}` : ""}</dd>
        <dt>负责人</dt>
        <dd>{ownerName} · 代次 {work.ownerEpoch}</dd>
        <dt>版本</dt>
        <dd>要求 r{work.intentRevision} · 来源 v{work.sourceVersion} · 状态 v{work.stateVersion}</dd>
        <dt>目标</dt>
        <dd>{work.mode === "watch" ? "持续查看" : "一次完成"}{work.inputSnapshotBound ? "" : " · 输入快照未绑定"}</dd>
      </dl>
      {work.phase3 && <section aria-label="事项执行情况">
        <h3>执行情况</h3>
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
        {controlNotice && <p role="status">{controlNotice}</p>}
      </section>}
      {work.phase4 && <section aria-label="关注、离线与预算">
        <h3>关注与运行</h3>
        <p>{work.phase4.host.online ? "权威宿主在线" : "权威宿主离线，不能宣称持续运行"}
          {work.phase4.host.lastScanAt ? ` · 最近实际检查 ${new Date(work.phase4.host.lastScanAt).toLocaleString()}` : " · 尚无实际检查记录"}
          {work.phase4.host.suspendEvidence ? ` · 休眠证据 ${work.phase4.host.suspendEvidence}` : ""}</p>
        <p>承诺期限 {work.phase4.deadlineAt ? new Date(work.phase4.deadlineAt).toLocaleString() : "未设置"}（revision {work.phase4.deadlineRevision}）</p>
        {work.phase4.subscriptions.length === 0 ? <p>尚无关注规则。</p> : work.phase4.subscriptions.map(subscription => <article key={subscription.subscriptionId} aria-label="关注规则">
          <strong>{subscription.source} · {subscription.targetKey ?? "默认目标"} · {{ online: "在线", paused: "暂停积压", offline: "宿主离线", stopped: "已停止", closing: "结算中" }[subscription.status]}</strong>
          <p>策略 {subscription.catchUpPolicy} · 时区 {subscription.timezone ?? "默认"} · 规则 r{subscription.scheduleRevision} · 配置 r{subscription.configRevision}</p>
          <p>下一唤醒 {subscription.nextWakeAt ? new Date(subscription.nextWakeAt).toLocaleString() : "无"} · 最近检查 {subscription.lastCheckedAt ? new Date(subscription.lastCheckedAt).toLocaleString() : "无"}</p>
          <p>队列 ready {subscription.queue.ready} · frozen {subscription.queue.frozen} · blocked {subscription.queue.blocked} / 上限 {subscription.queue.maxEvents} 条 · {subscription.queue.bytes}/{subscription.queue.maxBytes} 字节
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
          <option value="latest">latest</option><option value="each">each</option><option value="skip">skip</option>
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
            · 策略 {gap.policy} · {{ open: "待恢复", recovering: "恢复中", recovered: "已恢复", unqueryable: "不可回查" }[gap.state]}</p>
          <p>已补 {gap.recoveredCount} · 已合并 {gap.mergedCount} · 已跳过 {gap.skippedCount} · 未知 {gap.unknownCount ?? "未统计"}{gap.gapReason ? ` · ${gap.gapReason}` : ""}</p>
        </article>)}

        <h3>共享预算</h3>
        <p>窗口 {work.phase4.budget.windowId} · {new Date(work.phase4.budget.periodStartAt).toLocaleString()} ~ {work.phase4.budget.periodEndAt ? new Date(work.phase4.budget.periodEndAt).toLocaleString() : "无期限"}
          · {work.phase4.budget.timezone ?? "默认时区"} · 策略 r{work.phase4.budget.policyRevision} · {work.phase4.budget.autoRollover ? "允许续期" : "不自动续期"}</p>
        <p>上限 {work.phase4.budget.limitTokens} · 已结算 {work.phase4.budget.committedTokens} · 在途预留 {work.phase4.budget.reservedTokens} · 未知 {work.phase4.budget.unknownTokens}（{work.phase4.budget.unknownUsageCount} 笔）· 可用 {work.phase4.budget.availableTokens}</p>
        {work.phase4.budget.pendingRollover && <p role="status">{work.phase4.budget.pendingRollover}</p>}
        {(work.phase4.budget.unknownReservations ?? []).map(reservation => <UnknownBudgetReconciliation
          key={reservation.reservationId} work={work} reservation={reservation} busy={busy} submit={runPhase4} />)}
        <label>预算上限<input aria-label="预算上限" type="number" min={0} value={budgetLimit} onChange={event => setBudgetLimit(event.target.value)} /></label>
        <button type="button" disabled={busy || !["active", "paused"].includes(work.lifecycle) || !Number.isSafeInteger(Number(budgetLimit)) || Number(budgetLimit) < 0}
          onClick={() => { void runPhase4({ kind: "set-budget-policy", operationId: operation(`budget:${budgetLimit}:${work.stateVersion}`),
            workId: work.workId, maxTokens: Number(budgetLimit), versionGuard }); }}>保存预算政策</button>

        <h3>因果准入</h3>
        {work.phase4.causal.length === 0 ? <p>尚无因果准入记录。</p> : <details><summary>最近 {work.phase4.causal.length} 次准入</summary>
          {work.phase4.causal.map(item => <p key={item.chainId}>{item.decision === "admitted" ? "已准入" : "已拦截"} · 深度 {item.depth} · 互调 {item.hops} 跳 · 派发 {item.dispatchCount} · {item.reasonCode ?? item.rootEventId}</p>)}
        </details>}
        {phase4Notice && <p role="status">{phase4Notice}</p>}
      </section>}
      <h3>成果与证据</h3>
      {work.deliverables.length === 0 ? <p>尚无保存的成果。</p> : work.deliverables.map(deliverable => <article key={deliverable.deliverableId}>
        <strong>{{ proposed: "待验收", accepted: "已采纳", rejected: "已拒绝", superseded: "历史成果" }[deliverable.status]}</strong>
        <p style={{ whiteSpace: "pre-wrap" }}>{deliverable.summary}</p>
        {deliverable.artifactRefs.length > 0 && <ul>{deliverable.artifactRefs.map(ref => <li key={ref}>{ref}</li>)}</ul>}
        <p>已保存 {deliverable.evidenceRefs.length} 条证据</p>
      </article>)}
      <h3>验收</h3>
      <WorkCardsPanel key={JSON.stringify([work.workId, work.intentRevision, work.inputSnapshotId,
        work.ownerEpoch, work.stateVersion, work.phase3?.artifactSnapshotId])} work={work} includeClosed={includeClosed} />
      <WorkReviewPanel key={JSON.stringify([work.workId, work.intentRevision, work.inputSnapshotId,
        work.ownerEpoch, work.stateVersion, work.phase3?.artifactSnapshotId])} work={work} includeClosed={includeClosed} />
      {work.criteria.length === 0 ? <p>没有验收条件。</p> : (
        <ul>{work.criteria.map((criterion) => <li key={criterion.id}>{criterion.text} · {criterionLabel(criterion)}</li>)}</ul>
      )}
      <h3>下一步</h3>
      {work.nextSteps.length === 0 ? <p>没有未完成的下一步。</p> : (
        <ul>{work.nextSteps.map((step) => <li key={step}>{step}</li>)}</ul>
      )}
      <h3>阻碍</h3>
      {openBlockers.length === 0 ? <p>没有未解除的阻碍。</p> : (
        <ul>{openBlockers.map((blocker) => <li key={blocker.blockerId}>{blocker.reason}</li>)}</ul>
      )}
    </>
  );
}
