import { useEffect, useState } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import type { WorkTeamControlRequest, WorkTeamTemplateDto } from "@shared/bot-work-team";

/** Management actions never replay work or silently delete workspace files. */
export function BotTeamManagement({ team, work, onChanged }: {
  team?: WorkTeamTemplateDto; work?: WorkProjectionDto; onChanged: () => void;
}): React.JSX.Element {
  const [teams, setTeams] = useState<WorkTeamTemplateDto[]>([]), [removed, setRemoved] = useState<WorkProjectionDto[]>([]);
  const [target, setTarget] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<"team" | "work" | null>(null);
  const reload = async () => {
    if (!window.api) return;
    const [result, works] = await Promise.all([window.api.botWork.teamControl({ kind: "list_templates", includeDeleted: true }), window.api.botWork.listWorks(true)]);
    if (result.ok) setTeams(result.templates ?? []);
    setRemoved(works.filter(item => item.team?.removedAt));
  };
  useEffect(() => { void reload().catch(() => setNotice("管理记录暂时无法加载，请重新打开。")); }, []);
  useEffect(() => { setConfirm(null); setTarget(""); setNotice(""); }, [team?.templateId, work?.workId]);
  const perform = async (request: WorkTeamControlRequest, success: string) => {
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      if (!window.api) throw new Error("桌面接口不可用。");
      const result = await window.api.botWork.teamControl(request);
      if (!result.ok) { setNotice(result.message); return; }
      setConfirm(null); setNotice(success); await reload(); onChanged();
    } catch (error) { setNotice(error instanceof Error ? error.message : "操作结果未确认，请重新打开核对。"); }
    finally { setBusy(false); }
  };
  return <section className="bot-team-management" aria-label="团队与事项管理">
    {work && <section>
      <h3>管理事项：{work.title}</h3>
      <p>当前归属：{work.team?.teamName ?? "临时团队"}。移动只改变归属位置，原成员、已执行步骤、成果和工作目录不变，不会重新执行。</p>
      <label>移到团队<select aria-label="事项目标团队" value={target} disabled={busy} onChange={e => setTarget(e.target.value)}>
        <option value="">选择目标团队</option>{teams.filter(item => !item.deletedAt && item.templateId !== work.team?.teamId).map(item => <option key={item.templateId} value={item.templateId}>{item.name}</option>)}
      </select></label>
      <button type="button" disabled={busy || !target} onClick={() => void perform({ kind: "set_work_team", workId: work.workId, templateId: target }, "事项已移动，未重新执行。")}>移动此事项</button>
      {work.team?.removedAt ? <button type="button" disabled={busy} onClick={() => void perform({ kind: "restore_work", workId: work.workId }, "事项已恢复。")}>恢复此事项</button>
        : <><button type="button" disabled={busy || !!work.team?.removalRequestedAt} onClick={() => setConfirm("work")}>{work.team?.removalRequestedAt ? "正在停止并移到回收站…" : work.lifecycle === "closed" ? "删除此事项" : "停止并删除此事项"}</button>
          {work.lifecycle !== "closed" && <p>{work.team?.removalRequestedAt ? "已请求停止此事项；执行停止后自动移到回收站，不影响其他事项。" : "可直接停止此事项并移到回收站，不必先到详情结束；保留已有成果文件。"}</p>}</>}
    </section>}
    {team && <section>
      <h3>管理团队：{team.name}</h3>
      <p>删除团队只将团队入口移到回收站。成员 Bot 不删除，已创建事项继续保留在“临时与历史团队事项”，不会停止或重跑。</p>
      <button type="button" disabled={busy} onClick={() => setConfirm("team")}>删除此团队</button>
    </section>}
    {confirm && <div role="alert" className="bot-team-management-confirm">
      <p>{confirm === "team" ? `将团队“${team?.name}”移到回收站？不删除成员、事项或文件。` : `${work?.lifecycle === "closed" ? "将" : "停止且仅停止此事项，然后将"}事项“${work?.title}”移到回收站？可恢复；不会删除磁盘成果文件。`}</p>
      <button type="button" disabled={busy} onClick={() => setConfirm(null)}>取消</button>
      <button type="button" disabled={busy} onClick={() => {
        if (confirm === "team" && team) void perform({ kind: "delete_template", templateId: team.templateId }, "团队已移到回收站，历史事项保留。");
        if (confirm === "work" && work) void perform({ kind: work.lifecycle === "closed" ? "remove_work" : "stop_and_remove_work", workId: work.workId }, work.lifecycle === "closed" ? "事项已移到回收站，成果文件未删除。" : "已受理停止并删除；执行停止后自动移到回收站。");
      }}>确认移到回收站</button>
    </div>}
    <details className="bot-team-recycle"><summary>回收站（团队 {teams.filter(item => item.deletedAt).length} · 事项 {removed.length}）</summary>
      <p>这里能恢复删除的团队与已结束事项。恢复不重新执行任务。</p>
      {teams.filter(item => item.deletedAt).map(item => <p key={item.templateId}>团队：{item.name} <button type="button" disabled={busy} onClick={() => void perform({ kind: "restore_template", templateId: item.templateId }, "团队已恢复。")}>恢复团队</button></p>)}
      {removed.map(item => <p key={item.workId}>事项：{item.title} <button type="button" disabled={busy} onClick={() => void perform({ kind: "restore_work", workId: item.workId }, "事项已恢复。")}>恢复事项</button></p>)}
    </details>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
