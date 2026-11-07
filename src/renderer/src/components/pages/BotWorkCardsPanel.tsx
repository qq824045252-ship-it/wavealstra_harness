import { useState } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import type { WorkDiagnosticsSection, WorkExpandedDiagnosticsDto } from "@shared/bot-work-phase5";
import { useAppStore } from "@/store/appStore";

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
  const cards = work.cards ?? [];
  const refresh = () => useAppStore.getState().refreshBotWork(includeClosed);

  const read = async (semanticCardKey: string) => {
    setBusy(true);
    try {
      const api = window.api;
      if (!api) throw new Error("桌面接口不可用");
      const result = await api.botWork.markCardRead({ workId: work.workId, semanticCardKey });
      setNotice(result.ok ? "已标记为已读。" : result.message ?? "阅读状态未确认");
      if (result.ok) await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "阅读状态未确认");
    } finally { setBusy(false); }
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
      setNotice(result.ok ? "重发已受理，等待实际渠道回执。" : result.message);
      if (result.ok) await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重发未受理");
    } finally { setBusy(false); }
  };

  const loadDiagnostics = async () => {
    setBusy(true);
    try {
      const api = window.api;
      if (!api) throw new Error("桌面接口不可用");
      const result = await api.botWork.workDiagnostics({ workId: work.workId, limit: 20 });
      setDiagnostics(result ?? null);
      if (!result) setNotice("诊断不可读或事项不存在。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "诊断读取失败");
    } finally { setBusy(false); }
  };

  return <section aria-label="结果卡片与证据">
    <h3>结果卡片</h3>
    {cards.length === 0 && <p>还没有验收成果。</p>}
    {cards.map(card => <article key={card.cardKey} aria-label="结果卡片">
      <p><strong>{card.title}</strong>{card.currency === "current" ? "" : ` · ${card.currency === "superseded" ? "已失效" : "历史"}`}</p>
      <p>{card.summary}</p>
      <p>要求 r{card.intentRevision} · 成果 {card.deliverableIds.length} 项 · 阅读版本 {card.readVersion}</p>
      {card.unverifiedScope.length > 0 && <p>未验证：{card.unverifiedScope.join("、")}</p>}
      {card.readAt
        ? <p role="status">已读 {new Date(card.readAt).toLocaleString()}</p>
        : <button type="button" disabled={busy} onClick={() => { void read(card.semanticCardKey); }}>标记已读</button>}
    </article>)}

    <h3>外部通知</h3>
    {work.notifications.length === 0 && <p>还没有通知意图。</p>}
    {work.notifications.map(notification => <article key={notification.notificationId} aria-label="通知投递">
      <p>{notification.title} · {deliveryText(notification.delivery)}</p>
      <p>尝试 {notification.attemptCount} 次{notification.externalReceipt ? ` · 回执 ${notification.externalReceipt}` : ""}</p>
      {notification.delivery === "unknown" && <button type="button" disabled={busy}
        onClick={() => { void resend(notification.notificationId); }}>确认风险后重发</button>}
    </article>)}

    <details>
      <summary>展开诊断证据</summary>
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
    <ul>{props.section.items.map(item => <li key={item}>{item}</li>)}</ul>
    {props.section.truncated && <p>记录已截断，可缩小范围后重新读取。</p>}
    {props.section.missing?.map(item => <p role="status" key={item}>缺口：{item}</p>)}
  </div>;
}

function deliveryText(delivery: WorkProjectionDto["notifications"][number]["delivery"]): string {
  if (delivery === "sent") return "已送达";
  if (delivery === "unknown") return "外部结果未确认（避免重复已停止自动重试）";
  if (delivery === "failed") return "发送失败";
  return "待发送";
}
