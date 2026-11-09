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
export function BotWorkApprovals({ work }: { work: WorkProjectionDto }): React.JSX.Element | null {
  const approvals = work.approvals?.filter(item => item.status === "pending") ?? [];
  if (!approvals.length) return null;
  return <section className="bot-work-approvals" aria-label="后台操作审批"><h3>{work.title} · 需要你的确认</h3>
    {approvals.map(approval => <Approval key={identity(work, approval)} work={work} approval={approval} />)}
  </section>;
}
function Approval({ work, approval }: { work: WorkProjectionDto; approval: WorkActionApprovalDto }) {
  const key = identity(work, approval);
  const pending = useSyncExternalStore(subscribe, () => decisions.get(key));
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setConfirmed(false); }, [work.stateVersion, work.intentRevision, work.ownerEpoch]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (approval.expiresAt <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(approval.expiresAt - Date.now(), 0), 2147483647));
    return () => clearTimeout(timer);
  }, [approval.expiresAt, now]);
  const expired = approval.expiresAt <= now;
  const staleRejection = pending?.status === "rejected" && pending.request.expectedStateVersion === work.stateVersion
    && pending.request.expectedIntentRevision === work.intentRevision && pending.request.expectedOwnerEpoch === work.ownerEpoch;
  const locked = pending?.status === "busy" || pending?.status === "settled" || staleRejection;
  const retry = pending?.status === "uncertain" ? pending.request : undefined;
  const decide = async (mode: "allow" | "deny" | "ignore", saveRule?: "project" | "repo" | "workspace") => {
    const approved = mode === "allow";
    const current = decisions.get(key);
    if (current?.status !== "uncertain" && (expired || approval.expiresAt <= Date.now()) || current?.status === "busy" || current?.status === "settled"
      || current?.status === "rejected" && current.request.expectedStateVersion === work.stateVersion
        && current.request.expectedIntentRevision === work.intentRevision && current.request.expectedOwnerEpoch === work.ownerEpoch) return;
    if (current?.status === "uncertain" && current.request.approved !== approved) return;
    if (current?.status !== "uncertain" && approved && approval.scopeMissing && !confirmed) return;
    const request = current?.status === "uncertain" ? current.request : {
      approvalId: approval.approvalId, workId: work.workId, bindingId: approval.bindingId,
      expectedVersion: approval.version, expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision,
      expectedOwnerEpoch: work.ownerEpoch, approved, grantScopeOnce: approved && approval.scopeMissing && confirmed,
      ...(mode === "ignore" ? { decision: "ignore" as const } : {}),
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
    {approval.question && <p>为什么需要你：{approval.question}</p>}
    {approval.detail && <pre>{approval.detail}</pre>}
    <p>仅处理这次尚未执行的动作，保留已完成步骤。{pending?.status === "uncertain" || pending?.status === "busy" ? "原决定结果待核对。" : pending?.status === "settled" ? "决定已保存。" : expired ? "审批已到期，默认拒绝。" : `截止 ${new Date(approval.expiresAt).toLocaleTimeString("zh-CN")}，超时默认拒绝。`}</p>
    {approval.scopeMissing && <label><input type="checkbox" checked={retry ? retry.grantScopeOnce : confirmed} disabled={locked || !!retry || expired} onChange={event => setConfirmed(event.target.checked)} />我授权本次动作所需的 {approval.requiredScope}，不扩大其他动作或今后的权限</label>}
    {pending?.error && <p role="alert">{pending.error}</p>}
    <div className="bot-approval-actions"><button type="button" disabled={locked || expired && !retry || !!retry && !retry.approved || !retry && approval.scopeMissing && !confirmed} onClick={() => { void decide("allow"); }}>{retry?.approved ? "重试原批准" : "允许本次"}</button>
      <button type="button" disabled={locked || expired && !retry || !!retry && retry.approved} onClick={() => { void decide("deny"); }}>{retry && !retry.approved ? "重试原拒绝" : "拒绝"}</button>
      <button type="button" disabled={locked || expired && !retry} onClick={() => { void decide("ignore"); }}>暂不处理</button>
      {!approval.descriptor?.hardGate && (approval.ruleScope?.projectId || approval.ruleScope?.workspaceId)
        && <button type="button" disabled={locked || expired && !retry} onClick={() => {
          const scope = approval.ruleScope?.projectId ? "project" as const : "workspace" as const;
          void decide("allow", scope);
        }}>{approval.ruleScope?.projectId ? "此项目以后这样处理" : "此工作区以后这样处理"}</button>}</div>
    <p>暂不处理不会执行这个动作，也不会取消整个事项；其它步骤会继续，同一动作不会重复询问。</p>
  </article>;
}
