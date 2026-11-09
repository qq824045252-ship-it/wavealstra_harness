import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { BotDto, WorkProjectionDto } from "@shared/bot-work";
import type { WorkTeamControlRequest, WorkTeamDto, WorkTeamExecution } from "@shared/bot-work-team";
const stateLabels: Record<WorkTeamDto["state"], string> = { closing: "收尾结算中", completed: "已验收完成", ended_unsuccessfully: "已结束，目标未达成", queued: "等待开工", running: "执行中", blocked: "执行受阻", awaiting_review: "汇总已就绪，待验收", paused: "已暂停", cancelled: "已取消", superseded: "原计划已失效，等待重新安排" };
const executionLabels: Record<WorkTeamExecution["status"], string> = { queued: "排队中", pending: "准备中", submitted: "已派发", running: "执行中", recovering: "自动恢复中", recovered: "已自动恢复，待核验", completed: "执行结束，待核验", failed: "执行失败", stopped: "已停止", unknown: "结果未知，待核对", invalidated: "已失效", blocked: "受阻", cancelled: "已取消" };
const messageLabels: Record<string, string> = { delegate: "分工", accepted: "接手", question: "问题", result: "成果", blocked: "阻碍", change: "变更", cancel: "取消", handoff: "交接" };
export function BotTeamPanel({ work, identities }: { work: WorkProjectionDto; identities: BotDto[] }): React.JSX.Element | null {
  const projectionKey = `${work.workId}:${work.intentRevision}:${work.ownerEpoch}:${work.stateVersion}`;
  const view = useRef({ key: projectionKey, epoch: 0 });
  if (view.current.key !== projectionKey) view.current = { key: projectionKey, epoch: view.current.epoch + 1 };
  const planVersion = `${projectionKey}:${view.current.epoch}`;
  const [pendingView, setPendingView] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ view: string; text: string } | null>(null);
  const inFlight = useRef<{ view: string; id: number } | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [confirmedPlan, setConfirmedPlan] = useState<string | null>(null);
  const busy = pendingView === planVersion;
  const notice = feedback?.view === planVersion ? feedback.text : "";
  const runControl = async (request: WorkTeamControlRequest, success: string) => {
    if (inFlight.current?.view === planVersion) return;
    const operation = { view: planVersion, id: ++sequence.current };
    inFlight.current = operation; setPendingView(planVersion); setFeedback(null);
    const stillCurrent = () => mounted.current && `${view.current.key}:${view.current.epoch}` === operation.view;
    try {
      const result = await window.api?.botWork.teamControl(request);
      if (stillCurrent()) setFeedback({ view: operation.view, text: result?.ok ? success : result && !result.ok ? result.message : "桌面接口不可用。" });
      await useAppStore.getState().refreshBotWork(true);
    } catch { if (stillCurrent()) setFeedback({ view: operation.view, text: "操作结果尚未确认，请先核对最新状态。" }); }
    finally {
      if (inFlight.current?.id === operation.id) { inFlight.current = null; if (mounted.current) setPendingView(null); }
    }
  };
  const team = work.team;
  if (!team) return null;
  const replanMembers = team.members.filter(member => member.botId !== work.ownerBotId).map(member => ({ ...member,
    dependsOnBotIds: member.dependsOnBotIds?.filter(id => id !== work.ownerBotId), delegatedScope: ["workspace:read" as const] }));
  const name = (botId: string) => identities.find(bot => bot.botId === botId)?.displayName ?? botId;
  const current = work.phase3?.collaborationMessages.filter(message => message.intentRevision === work.intentRevision && message.inputSnapshotId === work.inputSnapshotId) ?? [];
  return <section className="bot-detail-section bot-team-panel" aria-label="团队分工与协作">
    <div className="bot-team-progress"><h3>团队协作</h3><span className="bot-status-badge">{stateLabels[team.state]}</span></div>
    <p>{team.members.length + 1} 位 Bot · {team.executionPolicy === "parallel" ? `按依赖并行（最多 ${team.maxConcurrency ?? 2} 位成员）` : "成员依次执行"} · 负责人统一汇总</p>
    <p>执行结束不代表目标已经验收。请在成果评审中核对证据和验收条件。</p>
    <article><strong>{name(work.ownerBotId)} · 当前负责人</strong><p>{team.ownerResponsibility}</p><p>负责核对与只读汇总，成员全部返回后开始。</p></article>
    {team.executions.map(execution => <article key={execution.taskId} aria-label={`${name(execution.botId)}的团队任务`}>
      <div className="bot-team-progress"><strong>{name(execution.botId)} · {execution.role === "owner_summary" ? "负责人汇总" : "成员"}</strong><span>{executionLabels[execution.status]}</span></div>
      <p>{execution.responsibility}</p><p>范围：{execution.delegatedScope.includes("workspace:write") ? "指定工作区读写" : "指定工作区只读"}</p>
      {execution.dependsOnBotIds?.length ? <p>前置成员：{execution.dependsOnBotIds.map(name).join("、")}</p> : null}
      {execution.waitingReason && <p role="status">{execution.waitingReason}</p>}
      {execution.status === "recovering" && <p role="status">原成员身份不变，正在自动恢复第 {execution.recoveryGeneration ?? 1} 次；已完成的成果会先读回复用，不重复已确认效果。</p>}
      {execution.status === "recovered" && <p role="status">已自动恢复，原成员身份与依赖保持不变；恢复结果仍需负责人核对与用户验收。</p>}
      {execution.failureReason && <p role="status">原失败：{execution.failureReason}</p>}
      {execution.error && <p role="status" className="bot-create-error">{execution.error}</p>}
      {execution.resultSummary && <details><summary>执行结果</summary><p>{execution.resultSummary}</p></details>}
    </article>)}
    {team.state === "blocked" && work.lifecycle === "active" && team.executions.some(execution => execution.error && !execution.bindingId) && <div>
      <p>确认阻碍已解决后，可重新核对未启动的准备步骤。已启动或结果未知的执行不会因此重复派发。</p>
      <button type="button" disabled={busy} onClick={() => { void runControl({ kind: "retry", workId: work.workId,
        versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch },
        confirmNotStarted: true }, "准备步骤已重新核对，请查看最新执行状态。"); }}>{busy ? "正在核对…" : "重试未启动的准备"}</button>
      {notice && <p role="status">{notice}</p>}
    </div>}
    {team.state === "superseded" && work.lifecycle === "active" && <details><summary>按新要求只读复核</summary>
      <p>沿用以下历史分工，仅按新要求只读核对历史成果，不重做以前的写入或其他效果。历史结果不自动满足新验收条件，当前负责人负责只读汇总。</p>
      <p>本次安排：{team.executionPolicy === "parallel" ? `按依赖并行，最多 ${team.maxConcurrency ?? 2} 位成员` : "成员依次执行"}，负责人等待全部成员结算后汇总。</p>
      <ul>{replanMembers.map(member => <li key={member.botId}>{name(member.botId)}：{member.responsibility}（原范围：{team.members.find(original => original.botId === member.botId)?.delegatedScope.includes("workspace:write") ? "工作区读写" : "工作区只读"}；本次仅只读）{team.executionPolicy === "parallel" && <span> · 本次前置：{member.dependsOnBotIds?.length ? member.dependsOnBotIds.map(name).join("、") : "无"}</span>}</li>)}</ul>
      {team.members.some(member => member.botId === work.ownerBotId) && <p>现负责人从成员执行名单中移除，仅承担汇总职责；其他成员对其旧执行的依赖也从本次计划移除。</p>}
      <label><input type="checkbox" checked={confirmedPlan === planVersion} onChange={event => setConfirmedPlan(event.target.checked ? planVersion : null)} />我已核对旧成果与新要求，同意按以上分工只读复核，不重做旧效果</label>
      <button type="button" disabled={busy || confirmedPlan !== planVersion || !team.members.some(member => member.botId !== work.ownerBotId)} onClick={() => {
        if (confirmedPlan !== planVersion) return;
        void runControl({ kind: "replan", workId: work.workId,
          versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch },
          plan: { executionPolicy: team.executionPolicy, maxConcurrency: team.maxConcurrency, ownerBotId: work.ownerBotId, ownerResponsibility: team.ownerResponsibility,
            members: replanMembers } },
          "只读复核计划已保存，请查看最新执行状态。");
      }}>确认并只读复核</button>
      {notice && <p role="status">{notice}</p>}
    </details>}
    <h3>协作记录</h3>
    {!current.length && <p>暂无当前版本的协作消息，执行状态以以上记录为准。</p>}
    {current.map(message => <div key={message.messageId} className="bot-team-log"><small>{message.senderBotId ? name(message.senderBotId) : "你"} · {messageLabels[message.kind] ?? message.kind} · {new Date(message.createdAt).toLocaleString()}</small><p>{message.body}</p></div>)}
    {(work.phase3?.collaborationMessages.length ?? 0) > current.length && <p>较早版本的记录保留在高级诊断中，不作为当前结论。</p>}
  </section>;
}
