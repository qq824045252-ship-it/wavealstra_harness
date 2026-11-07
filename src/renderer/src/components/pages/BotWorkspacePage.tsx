import { useEffect, useRef, useState } from "react";
import type { BotDto, WorkCriterionDto, WorkLifecycle, WorkProjectionDto } from "@shared/bot-work";
import type { WorkPhase3ControlRequest } from "@shared/bot-work-phase3-control";
import type { BotWorkHostStatusDto } from "@shared/bot-work-ipc";
import { useAppStore } from "@/store/appStore";
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
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    typeof window === "undefined" || !window.matchMedia?.("(max-width: 900px)").matches,
  );

  useEffect(() => {
    void useAppStore.getState().refreshBotWork();
  }, []);
  useEffect(() => {
    if (!activeBotId) return;
    const refresh = () => { void useAppStore.getState().refreshBotHistory(activeBotId); void useAppStore.getState().refreshBotWork(); };
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [activeBotId]);

  const activeBot = identities.find((bot) => bot.botId === activeBotId) ?? null;
  const openWorks = works.filter((work) => work.ownerBotId === activeBot?.botId && work.lifecycle !== "closed");
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
              <p>这个 Bot 还没有未结束的事项。普通消息不会自动创建事项。</p>
            ) : openWorks.map((work) => (
              <WorkCard key={work.workId} work={work} selected={work.workId === selected?.workId} ownerName={activeBot.displayName} onSelect={() => setSelectedWorkId(work.workId)} />
            ))}
            <h3>待决事项</h3>
            {decisions.length === 0 ? <p>暂无可显示的待决事项。</p> : (
              <ul>{decisions.map((work) => <li key={work.workId}>{work.title}：{work.nextSteps[0] ?? "需要处理"}</li>)}</ul>
            )}
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
        {selected ? <WorkFacts key={selected.workId} work={selected} ownerName={activeBot?.displayName ?? selected.ownerBotId} /> : (
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

function WorkFacts(props: { work: WorkProjectionDto; ownerName: string }): React.JSX.Element {
  const { work, ownerName } = props;
  const openBlockers = work.blockers.filter((blocker) => blocker.status === "open");
  const identities = useAppStore(s => s.botIdentities);
  const [targetBotId, setTargetBotId] = useState("");
  const [question, setQuestion] = useState("");
  const [controlNotice, setControlNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [safeRecovery, setSafeRecovery] = useState<string | null>(null);
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
      await useAppStore.getState().refreshBotWork();
      return response;
    } catch (error) { setControlNotice(error instanceof Error ? error.message : "操作尚未确认，请核对最新状态后重试。"); }
    finally { setBusy(false); }
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
      <h3>成果与证据</h3>
      {work.deliverables.length === 0 ? <p>尚无保存的成果。</p> : work.deliverables.map(deliverable => <article key={deliverable.deliverableId}>
        <strong>{{ proposed: "待验收", accepted: "已采纳", rejected: "已拒绝", superseded: "历史成果" }[deliverable.status]}</strong>
        <p style={{ whiteSpace: "pre-wrap" }}>{deliverable.summary}</p>
        {deliverable.artifactRefs.length > 0 && <ul>{deliverable.artifactRefs.map(ref => <li key={ref}>{ref}</li>)}</ul>}
        <p>已保存 {deliverable.evidenceRefs.length} 条证据</p>
      </article>)}
      <h3>验收</h3>
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
