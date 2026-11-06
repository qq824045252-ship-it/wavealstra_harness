import { useEffect, useState } from "react";
import type { BotDto, WorkCriterionDto, WorkLifecycle, WorkProjectionDto } from "@shared/bot-work";
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
          {notice && <p role="status">这次只保留了草稿，没有创建事项，也没有派发执行。</p>}
          <label htmlFor="bot-draft">Bot 对话草稿</label>
          <textarea id="bot-draft" value={botDraft} onChange={(event) => setBotDraft(event.target.value)} placeholder="输入草稿" rows={3} />
          <button type="submit" disabled={!botDraft.trim()}>发送</button>
        </form>
      </section>
      {inspectorOpen && <aside className="bot-inspector" id="bot-work-inspector" aria-label="Work 详情">
        <button type="button" onClick={() => setInspectorOpen(false)}>关闭详情</button>
        {selected ? <WorkFacts work={selected} ownerName={activeBot?.displayName ?? selected.ownerBotId} /> : (
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
