import { useAppStore } from "@/store/appStore";
import { useWorkQueryPage } from "@/hooks/useWorkQueryPage";
import { useEffect, useState } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import type { WorkTeamControlRequest, WorkTeamTemplateDto } from "@shared/bot-work-team";

/** Management actions never replay work or silently delete workspace files. */
export function BotTeamManagement({ team, work, onChanged, onOpenWork }: {
  team?: WorkTeamTemplateDto; work?: WorkProjectionDto; onChanged: () => void; onOpenWork?: (work: WorkProjectionDto) => void;
}): React.JSX.Element {
  const bots = useAppStore(state => state.botIdentities);
  const ownerName = bots.find(bot => bot.botId === work?.ownerBotId)?.displayName;
  const [teams, setTeams] = useState<WorkTeamTemplateDto[]>([]);
  const [recycleOpen, setRecycleOpen] = useState(false), [recyclePage, setRecyclePage] = useState(1);
  const recycle = useWorkQueryPage({ scope: { kind: "removed_teams" }, view: "all", page: recyclePage, pageSize: 24 }, recycleOpen);
  const removed = recycle.result?.works ?? [];
  const [deletedTeamId, setDeletedTeamId] = useState(""), [deletedTeamPage, setDeletedTeamPage] = useState(1);
  const deletedTeamWorks = useWorkQueryPage({ scope: { kind: "team", teamId: deletedTeamId }, view: "all", page: deletedTeamPage, pageSize: 24 }, recycleOpen && !!deletedTeamId);
  const [target, setTarget] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<"team" | "work" | null>(null);
  const reload = async () => {
    if (!window.api) return;
    const result = await window.api.botWork.teamControl({ kind: "list_templates", includeDeleted: true });
    if (result.ok) setTeams(result.templates ?? []);

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
      setConfirm(null); setNotice(success); await reload(); recycle.retry(); onChanged();
    } catch (error) { setNotice(error instanceof Error ? error.message : "操作结果未确认，请重新打开核对。"); }
    finally { setBusy(false); }
  };
  return <section className="bot-team-management" aria-label="团队与事项管理">
    {work && <section>
      <h3>管理事项：{work.title}</h3>
      <p>当前归属：{work.team?.teamName ?? (ownerName ? `个人 Bot · ${ownerName}` : "原归属 Bot 不可用，记录保留待核对")}。移动只改变归属位置，原成员、已执行步骤、成果和工作目录不变，不会重新执行。</p>
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
      <p>删除团队只将团队入口移到回收站。成员 Bot 不删除，已创建事项继续保留在该团队的回收管理中，不会停止或重跑。</p>
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
    <details className="bot-team-recycle" onToggle={event => setRecycleOpen(event.currentTarget.open)}><summary>回收站（团队 {teams.filter(item => item.deletedAt).length}{recycle.result ? ` · 事项 ${recycle.result.filtered}` : ""}）</summary>
      <p>这里能恢复删除的团队与已结束事项。恢复不重新执行任务。</p>
      {teams.filter(item => item.deletedAt).map(item => <p key={item.templateId}>团队：{item.name} <button type="button" onClick={() => { setDeletedTeamId(item.templateId); setDeletedTeamPage(1); }}>查看事项</button> <button type="button" disabled={busy} onClick={() => void perform({ kind: "restore_template", templateId: item.templateId }, "团队已恢复。")}>恢复团队</button></p>)}
      {deletedTeamId && <section aria-label="已删除团队的事项">{deletedTeamWorks.loading && <p role="status">读取团队事项…</p>}{deletedTeamWorks.error && <p role="alert">{deletedTeamWorks.error}</p>}{deletedTeamWorks.result?.works.map(item => <button type="button" key={item.workId} onClick={() => onOpenWork ? onOpenWork(item) : useAppStore.getState().setHistoricalTeamWork(item)}>{item.title}</button>)}{deletedTeamWorks.result && deletedTeamWorks.result.pages > 1 && <nav aria-label="已删除团队事项分页"><button disabled={deletedTeamPage <= 1} onClick={() => setDeletedTeamPage(page => page - 1)}>上一页</button><span>第 {deletedTeamPage} / {deletedTeamWorks.result.pages} 页</span><button disabled={deletedTeamPage >= deletedTeamWorks.result.pages} onClick={() => setDeletedTeamPage(page => page + 1)}>下一页</button></nav>}</section>}
      {recycle.loading && <p role="status">正在读取事项回收站…</p>}
      {recycle.error && <p role="alert">{recycle.error}<button type="button" onClick={recycle.retry}>重试</button></p>}
      {removed.map(item => <p key={item.workId}>事项：{item.title} <button type="button" disabled={busy} onClick={() => void perform({ kind: "restore_work", workId: item.workId }, "事项已恢复。")}>恢复事项</button></p>)}
      {recycle.result && recycle.result.pages > 1 && <nav aria-label="回收站事项分页"><button type="button" disabled={recycle.result.page <= 1} onClick={() => setRecyclePage(recycle.result!.page - 1)}>上一页</button><span>第 {recycle.result.page} / {recycle.result.pages} 页</span><button type="button" disabled={recycle.result.page >= recycle.result.pages} onClick={() => setRecyclePage(recycle.result!.page + 1)}>下一页</button></nav>}
    </details>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
