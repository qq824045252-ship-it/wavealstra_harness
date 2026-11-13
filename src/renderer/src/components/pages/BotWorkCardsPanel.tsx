import { useEffect, useRef, useState } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import type { WorkDiagnosticsSection, WorkExpandedDiagnosticsDto } from "@shared/bot-work-phase5";
import type { WorkClosureReviewRequest } from "@shared/work-closure-review";
import { useAppStore } from "@/store/appStore";
import { WorkResultText } from "./BotWorkResult";

/**
 * Result cards, their read state, delivery state and the on-demand evidence view.
 *
 * The main inspector stays decision-shaped; everything here is either a card fact or an
 * explicitly requested diagnostics page, so a long ledger never lands in the default view.
 */
export function WorkCardsPanel(props: { work: WorkProjectionDto; includeClosed: boolean }): React.JSX.Element {
  const { work, includeClosed } = props;
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<WorkExpandedDiagnosticsDto | null>(null);
  const closureReview = useRef<WorkClosureReviewRequest | null>(null);
  const reviewingClosure = useRef(false);
  const mounted = useRef(true);
  const currentScope = useRef(includeClosed);
  currentScope.current = includeClosed;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const cards = work.cards ?? [];
  const refresh = () => useAppStore.getState().refreshBotWork(currentScope.current);

  const reassessClosure = async () => {
    if (reviewingClosure.current || !work.closureReview) return;
    reviewingClosure.current = true; setBusy(true); setNotice("");
    const request = closureReview.current ?? {
      requestId: crypto.randomUUID(), workId: work.workId, expectedCloseOperationId: work.closureReview.expectedCloseOperationId,
      versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision,
        expectedOwnerEpoch: work.ownerEpoch },
    };
    closureReview.current = request;
    try {
      if (!window.api) throw Error("桌面接口不可用");
      const result = await window.api.botWork.reassessClosedWork(request);
      if (!mounted.current) return;
      if (!result.ok) closureReview.current = null;
      setNotice(result.ok ? "复核完成，请查看最新结案说明。" : result.message);
      if (result.ok) await refresh();
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : "复核尚未确认，请重试");
    } finally {
      reviewingClosure.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const read = async (semanticCardKey: string) => {
    setBusy(true);
    try {
      const api = window.api;
      if (!api) throw new Error("桌面接口不可用");
      const result = await api.botWork.markCardRead({ workId: work.workId, semanticCardKey });
      if (!mounted.current) return;
      setNotice(result.ok ? "已标记为已读。" : result.message ?? "阅读状态未确认");
      if (result.ok) await refresh();
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : "阅读状态未确认");
    } finally { if (mounted.current) setBusy(false); }
  };

  const resend = async (notificationId: string) => {
    const reason = window.prompt("原投递可能已经送达，重发可能造成重复。请填写重发原因：");
    if (!reason?.trim()) return;
    setBusy(true);
    try {
      const api = window.api;
      if (!api) throw new Error("桌面接口不可用");
      const result = await api.botWork.resendNotification({
        operationId: `desktop:resend:${crypto.randomUUID()}`, workId: work.workId, notificationId,
        reason: reason.trim(), acknowledgedDuplicateRisk: true,
        versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision,
          expectedOwnerEpoch: work.ownerEpoch },
      });
      if (!mounted.current) return;
      setNotice(result.ok ? "重发已受理，等待实际渠道回执。" : result.message);
      if (result.ok) await refresh();
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : "重发未受理");
    } finally { if (mounted.current) setBusy(false); }
  };

  const loadDiagnostics = async () => {
    setBusy(true);
    try {
      const api = window.api;
      if (!api) throw new Error("桌面接口不可用");
      const result = await api.botWork.workDiagnostics({ workId: work.workId, limit: 20 });
      if (!mounted.current) return;
      setDiagnostics(result ?? null);
      if (!result) setNotice("诊断不可读或事项不存在。");
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : "诊断读取失败");
    } finally { if (mounted.current) setBusy(false); }
  };

  return <section className="bot-detail-section bot-result-cards" aria-label="结果卡片与证据">
    {work.closureReview && <div>
        <button type="button" className="btn" disabled={busy} onClick={() => { void reassessClosure(); }}>
          {reviewingClosure.current ? "正在复核…" : "复核结论"}
        </button>
        <p>依据已有成果重新核对结案，保留原结案记录。</p>
      </div>}
    {cards.length > 0 && <h3>结果卡片</h3>}
    {cards.map((card, cardIndex) => <article key={card.cardKey} id={`work-card-${card.cardKey}`} aria-label="结果卡片">
      <p><strong>{card.title}</strong>{card.currency === "current" ? "" : ` · ${card.currency === "superseded" ? "已失效" : "历史"}`}</p>
      {card.kind === "owner_summary" && <p>主负责人汇总{card.previousCardKey
        && <> · <a href={`#work-card-${card.previousCardKey}`}>查看上次汇总</a></>}</p>}
      {work.lifecycle === "closed" && work.closureConclusion === "succeeded"
        && card.currency === "current" && (card.kind === "accepted_result" || card.kind === "closure_succeeded")
        && <p role="status">已完成并关闭</p>}
      <details className="bot-original-report"><summary>{cards.slice(0, cardIndex).some(prior => prior.summary === card.summary)
          ? "正文与前面卡片相同 · 展开本卡记录" : card.currency !== "current" ? "查看历史卡片正文" : "查看卡片正文"}</summary>
          <WorkResultText text={card.summary} />
      </details>
      <p>包含 {card.deliverableIds.length} 项成果</p>
      <details><summary>卡片版本记录</summary><p>要求 r{card.intentRevision} · 阅读版本 {card.readVersion}</p>
        <p>生成时间 {Number.isFinite(card.createdAt) ? <time dateTime={new Date(card.createdAt).toISOString()}>{new Date(card.createdAt).toLocaleString()}</time> : "未记录"}</p></details>
      {card.unverifiedScope.length > 0 && <details className="bot-original-report">
        <summary>生成此卡时尚未验证 · {card.unverifiedScope.length} 条历史记录</summary>
        <p>这是卡片生成时的快照，不代表当前仍有缺口；当前状态见上方进度。</p>
        <DiagnosticTextList items={card.unverifiedScope} />
      </details>}
      {card.readAt
        ? <p role="status">已读 {new Date(card.readAt).toLocaleString()}</p>
        : <button type="button" disabled={busy} onClick={() => { void read(card.semanticCardKey); }}>标记已读</button>}
    </article>)}

    {work.notifications.length > 0 && <h3>外部通知</h3>}
    {work.notifications.map(notification => <article key={notification.notificationId} aria-label="通知投递">
      <p>{notification.title} · {deliveryText(notification.delivery)}</p>
      <p>尝试 {notification.attemptCount} 次{notification.externalReceipt ? ` · 回执 ${notification.externalReceipt}` : ""}</p>
      {notification.delivery === "unknown" && <button type="button" disabled={busy}
        onClick={() => { void resend(notification.notificationId); }}>确认风险后重发</button>}
    </article>)}

    <details className="bot-advanced">
      <summary>高级诊断与证据</summary>
      <button type="button" disabled={busy} onClick={() => { void loadDiagnostics(); }}>
        {diagnostics ? "重新读取" : "读取诊断"}
      </button>
      {diagnostics && <div>
        <p>要求 {diagnostics.requirements.items.length} 条{diagnostics.requirements.truncated ? "（已截断）" : ""}
          · 验收 {diagnostics.acceptance.items.length} 条{diagnostics.acceptance.truncated ? "（已截断）" : ""}
          · 执行 {diagnostics.executions.items.length} 条{diagnostics.executions.truncated ? "（已截断）" : ""}
          · 投递 {diagnostics.delivery.items.length} 条{diagnostics.delivery.truncated ? "（已截断）" : ""}</p>
        <p>产物快照 {diagnostics.artifactSnapshotId ?? "无文件产物"}{diagnostics.nextCursor ? " · 还有更多记录" : ""}</p>
        <Section title="未验证范围" section={{ items: diagnostics.unverifiedScope.map(entry => `${entry.text} · ${entry.reason}`), truncated: false }} />
        <Section title="责任链" section={{ items: diagnostics.responsibility.items.map(item => `代次 ${item.ownerEpoch} · ${item.ownerBotId}${item.reason ? ` · ${item.reason}` : ""}`), truncated: diagnostics.responsibility.truncated, missing: diagnostics.responsibility.missing }} />
        <Section title="执行链" section={{ items: diagnostics.executions.items.map(item => `${item.bindingId} · ${item.status} · r${item.intentRevision}`), truncated: diagnostics.executions.truncated, missing: diagnostics.executions.missing }} />
        <Section title="投递链" section={{ items: diagnostics.delivery.items.map(item => `${item.attemptId} · ${item.status} · ${item.guarantee}`), truncated: diagnostics.delivery.truncated, missing: diagnostics.delivery.missing }} />
      </div>}
    </details>
    {notice && <p role="status">{notice}</p>}
  </section>;
}

function Section(props: { title: string; section: WorkDiagnosticsSection<string> }): React.JSX.Element {
  return <div>
    <h4>{props.title}</h4>
    {props.section.items.length === 0 && <p>没有记录。</p>}
    <DiagnosticTextList items={props.section.items} />
    {props.section.truncated && <p>记录已截断，可缩小范围后重新读取。</p>}
    {props.section.missing?.map((item, index) => <div role="status" key={index}><p>缺口：</p><WorkResultText text={item} /></div>)}
  </div>;
}

/** Exact repeats only; retain their count and never infer equivalence between reports. */
function DiagnosticTextList({ items }: { items: string[] }): React.JSX.Element {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return <ul>{[...counts].map(([item, count], index) => <li key={index}>
    {count > 1 && <p>相同原文共 {count} 条</p>}
    {item.length > 600 ? <details><summary>展开记录正文</summary><WorkResultText text={item} /></details>
      : <WorkResultText text={item} />}
  </li>)}</ul>;
}

function deliveryText(delivery: WorkProjectionDto["notifications"][number]["delivery"]): string {
  if (delivery === "sent") return "已送达";
  if (delivery === "unknown") return "外部结果未确认（避免重复已停止自动重试）";
  if (delivery === "failed") return "发送失败";
  return "待发送";
}
