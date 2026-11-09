import { useEffect, useState, useSyncExternalStore } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import type { WorkActionApprovalDto, WorkActionDecision } from "@shared/bot-work-approval";
import { useAppStore } from "@/store/appStore";

type DecisionState = { request: WorkActionDecision; status: "busy" | "uncertain" | "settled" | "rejected"; error: string };
// A transport error is not proof that the host rejected the decision. Keep its
// exact request across navigation, and share the lock between conversation/details.
const decisions = new Map<string, DecisionState>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(key: string, value: DecisionState) { decisions.set(key, value); listeners.forEach(listener => listener()); }
const identity = (work: WorkProjectionDto, approval: WorkActionApprovalDto) => JSON.stringify([
  work.workId, approval.approvalId, approval.bindingId, approval.version,
]);
export const visibleWorkApproval = (item: WorkActionApprovalDto) => item.status === "pending" || !!item.continuation && item.status !== "denied";
export function BotWorkApprovals({ work }: { work: WorkProjectionDto }): React.JSX.Element | null {
  const approvals = work.approvals?.filter(visibleWorkApproval) ?? [];
  if (!approvals.length) return null;
  const historical = (approval: WorkActionApprovalDto) => approval.continuation?.status === "consumed" || approval.continuation?.status === "invalidated";
  const active = approvals.filter(approval => !historical(approval));
  const history = approvals.filter(historical);
  const cards = (items: WorkActionApprovalDto[]) => items.map(approval => <Approval key={identity(work, approval)} work={work} approval={approval} />);
  return <section className="bot-work-approvals" aria-label="后台操作审批"><h3>{work.title} · 后台动作</h3>
    {cards(active)}
    {!!history.length && <details><summary>已结算或失效的动作（{history.length}）</summary>{cards(history)}</details>}
  </section>;
}

function Approval({ work, approval }: { work: WorkProjectionDto; approval: WorkActionApprovalDto }) {
  const key = identity(work, approval);
  const pending = useSyncExternalStore(subscribe, () => decisions.get(key));
  const [confirmed, setConfirmed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const refreshProjection = async () => {
    setRefreshing(true); setRefreshError("");
    try { await useAppStore.getState().refreshBotWork(true); }
    catch { setRefreshError("刷新审批状态失败，请重试；没有授权或执行任何动作。"); }
    finally { setRefreshing(false); }
  };
  useEffect(() => { setConfirmed(false); }, [work.stateVersion, work.intentRevision, work.ownerEpoch]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (approval.expiresAt <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(approval.expiresAt - Date.now(), 0), 2147483647));
    return () => clearTimeout(timer);
  }, [approval.expiresAt, now]);
  const expired = approval.expiresAt <= now;
  const continuation = approval.continuation;
  const canRefresh = !!continuation && continuation.status === "deferred" && (approval.status === "expired" || approval.status === "ignored");
  const actionable = approval.status === "pending" && (!continuation || continuation.status === "deferred");
  const continuationText = continuation && {
    deferred: "这个动作尚未执行；其它可执行步骤不受影响。",
    queued: "已批准，等待补跑原动作。尚未执行完成，不会重跑已完成步骤。",
    running: "正在补跑原动作，请勿重复提交。",
    consumed: "原动作已结算；这不代表整个事项已验收完成。",
    unknown: "原动作效果尚未核实，不会自动重放。请核对执行回执与资源状态。",
    invalidated: "原动作已失效，不会继续执行。请查看变更原因后重新规划。",
  }[continuation.status];
  const requestMode = (request: WorkActionDecision) => request.decision ?? (request.approved ? "allow" : "deny");
  const staleRejection = pending?.status === "rejected" && pending.request.expectedStateVersion === work.stateVersion
    && pending.request.expectedIntentRevision === work.intentRevision && pending.request.expectedOwnerEpoch === work.ownerEpoch;
  const locked = pending?.status === "busy" || pending?.status === "settled" || staleRejection;
  const retry = pending?.status === "uncertain" ? pending.request : undefined;
  const decide = async (mode: "allow" | "deny" | "ignore" | "refresh", saveRule?: "project" | "repo" | "workspace") => {
    const approved = mode === "allow";
    const current = decisions.get(key);
    if (current?.status !== "uncertain" && (mode === "refresh" ? !canRefresh : !actionable || expired || approval.expiresAt <= Date.now()) || current?.status === "busy" || current?.status === "settled"
      || current?.status === "rejected" && current.request.expectedStateVersion === work.stateVersion
        && current.request.expectedIntentRevision === work.intentRevision && current.request.expectedOwnerEpoch === work.ownerEpoch) return;
    if (current?.status === "uncertain" && requestMode(current.request) !== mode) return;
    if (current?.status !== "uncertain" && approved && approval.scopeMissing && !confirmed) return;
    const request = current?.status === "uncertain" ? current.request : {
      approvalId: approval.approvalId, workId: work.workId, bindingId: approval.bindingId,
      expectedVersion: approval.version, expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision,
      expectedOwnerEpoch: work.ownerEpoch, approved, grantScopeOnce: approved && approval.scopeMissing && confirmed,
      ...(mode === "ignore" || mode === "refresh" ? { decision: mode } : {}),
      ...(saveRule && approved ? { saveRule } : {}),
    };
    publish(key, { request, status: "busy", error: "" });
    let result;
    try {
      if (!window.api) throw new Error("应用连接不可用");
      result = await window.api.botWork.decideAction(request);
    } catch {
      publish(key, { request, status: "uncertain", error: "审批结果尚未确认，请重试原决定。不会创建新动作。" });
      return;
    }
    publish(key, { request, status: result.ok ? "settled" : "rejected", error: result.ok ? "" : result.message });
    try { await useAppStore.getState().refreshBotWork(true); }
    catch { publish(key, { request, status: result.ok ? "settled" : "rejected",
      error: result.ok ? "决定已保存，刷新失败。请刷新事项查看最新状态。" : `${result.message}。刷新失败，请刷新事项后重试。` }); }
  };
  return <article className="bot-approval-card" data-approval-id={approval.approvalId}>
    <strong>{approval.summary}</strong>
    <p>工具：{approval.toolName} · 所需范围：{approval.requiredScope}</p>
    {approval.descriptor && <p>动作：{approval.descriptor.effect} / {approval.descriptor.operation}
      {approval.descriptor.provider ? ` · ${approval.descriptor.provider}` : ""}
      {approval.descriptor.target ? ` · 目标 ${approval.descriptor.target}` : ""}
      {` · 环境 ${approval.descriptor.environment}`}
      {approval.descriptor.hardGate ? " · 高风险（每次都需你确认）" : " · 普通动作"}</p>}
    {approval.question && <p>{actionable || canRefresh ? "为什么需要你" : "原审批原因"}：{approval.question}</p>}
    {approval.detail && <pre>{approval.detail}</pre>}
    {continuationText && <p role="status" data-continuation-status={continuation?.status}>{continuationText}</p>}
    {continuation?.reason && <p>原因：{continuation.reason}</p>}
    {approval.decision && <details><summary>决定来源</summary><p>{approval.decision.source} · {approval.decision.decisionId}</p></details>}
    {(actionable || canRefresh || pending) && <p>仅处理这次尚未执行的动作，保留已完成步骤。{pending?.status === "uncertain" || pending?.status === "busy" ? "原决定结果待核对。" : pending?.status === "settled" ? "决定已保存。" : expired ? "审批已到期，默认拒绝。" : `截止 ${new Date(approval.expiresAt).toLocaleTimeString("zh-CN")}，超时默认拒绝。`}</p>}
    {actionable && approval.scopeMissing && <label><input type="checkbox" checked={retry ? retry.grantScopeOnce : confirmed} disabled={locked || !!retry || expired} onChange={event => setConfirmed(event.target.checked)} />我授权本次动作所需的 {approval.requiredScope}，不扩大其他动作或今后的权限</label>}
    {pending?.error && <p role="alert">{pending.error}</p>}
    {refreshError && <p role="alert">{refreshError}</p>}
    <div className="bot-approval-actions">{actionable && <><button type="button" disabled={locked || expired && !retry || !!retry && requestMode(retry) !== "allow" || !retry && approval.scopeMissing && !confirmed} onClick={() => { void decide("allow"); }}>{retry?.approved ? "重试原批准" : "允许本次"}</button>
      <button type="button" disabled={locked || expired && !retry || !!retry && requestMode(retry) !== "deny"} onClick={() => { void decide("deny"); }}>{retry && requestMode(retry) === "deny" ? "重试原拒绝" : "拒绝"}</button>
      <button type="button" disabled={locked || expired && !retry || !!retry && requestMode(retry) !== "ignore"} onClick={() => { void decide("ignore"); }}>{retry && requestMode(retry) === "ignore" ? "重试原暂不处理" : "暂不处理"}</button>
      {!approval.descriptor?.hardGate && (approval.ruleScope?.projectId || approval.ruleScope?.workspaceId)
        && <button type="button" disabled={locked || expired || !!retry || approval.scopeMissing && !confirmed} onClick={() => {
          const scope = approval.ruleScope?.projectId ? "project" as const : "workspace" as const;
          void decide("allow", scope);
        }}>{approval.ruleScope?.projectId ? "此项目以后这样处理" : "此工作区以后这样处理"}</button>}</>}
      {(canRefresh || retry && requestMode(retry) === "refresh") && <button type="button" disabled={locked || !!retry && requestMode(retry) !== "refresh"} onClick={() => { void decide("refresh"); }}>{retry ? "重试原刷新请求" : "重新打开原动作审批"}</button>}
      {actionable && expired && continuation && !retry && <button type="button" disabled={locked || refreshing} onClick={() => { void refreshProjection(); }}>{refreshing ? "正在刷新审批状态…" : "刷新审批状态"}</button>}
    </div>
    {canRefresh && <p>刷新只恢复同一份动作的审批入口，不授予权限，也不会立即执行。请查看新卡片后再决定。</p>}
    {(actionable || canRefresh) && <p>暂不处理不会执行这个动作，也不会取消整个事项；其它步骤会继续，同一动作不会重复询问。</p>}
  </article>;
}
