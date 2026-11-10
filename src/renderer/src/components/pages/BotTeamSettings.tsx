import { useState } from "react";
import { useAppStore } from "@/store/appStore";
import { workTeamPlanSchema, type WorkTeamTemplateDto, type WorkTeamMember, type WorkTeamPlan } from "@shared/bot-work-team";

const planOf = (team: WorkTeamTemplateDto): WorkTeamPlan => ({ ownerBotId: team.ownerBotId, ownerResponsibility: team.ownerResponsibility,
  members: team.members, executionPolicy: team.executionPolicy, maxConcurrency: team.maxConcurrency });

/** Edit the persistent team, not the frozen plan of an already running commission. */
export function BotTeamSettings({ team, onSaved, onCancel }: { team: WorkTeamTemplateDto; onSaved: (team: WorkTeamTemplateDto) => void; onCancel: () => void }): React.JSX.Element {
  const bots = useAppStore(s => s.botIdentities);
  const [name, setName] = useState(team.name), [owner, setOwner] = useState(team.ownerBotId);
  const [responsibility, setResponsibility] = useState(team.ownerResponsibility);
  const [members, setMembers] = useState<WorkTeamMember[]>(team.members);
  const [policy, setPolicy] = useState<"sequential" | "parallel">(team.executionPolicy ?? "sequential");
  const [concurrency, setConcurrency] = useState(team.maxConcurrency ?? 2);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const candidates = bots.filter(bot => bot.status === "active");
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return;
    const plan = workTeamPlanSchema.safeParse({ ownerBotId: owner, ownerResponsibility: responsibility, members, executionPolicy: policy, maxConcurrency: policy === "parallel" ? concurrency : 1 });
    if (!plan.success) { setError("请填写负责人职责、至少一位成员及分工，并检查成员依赖。"); return; }
    setBusy(true); setError("");
    try {
      if (!window.api) throw new Error("桌面接口不可用");
      const result = await window.api.botWork.teamControl({ kind: "update_template", templateId: team.templateId, name: name.trim(), plan: plan.data, expected: { name: team.name, plan: planOf(team) } });
      if (!result.ok) setError(result.message);
      else if (result.template) onSaved(result.template);
      else setError("未取得保存结果，请重试核对。");
    } catch { setError("保存结果暂未确认，可以重试核对，不会新建团队或重启任务。"); }
    finally { setBusy(false); }
  };
  const remove = (id: string) => setMembers(current => current.filter(m => m.botId !== id).map(m => ({ ...m, dependsOnBotIds: m.dependsOnBotIds?.filter(dep => dep !== id) })));
  return <form aria-label="团队设置" onSubmit={event => void save(event)}>
    <p>统一管理这个团队。保存后用于新任务；已经开始的任务保留原分工，不会被重启。</p>
    <fieldset disabled={busy}>
      <label>团队名称<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>队长<select value={owner} onChange={e => { setOwner(e.target.value); remove(e.target.value); }}>
        {!candidates.some(bot => bot.botId === owner) && <option value={owner}>原队长已停用，请重新选择</option>}
        {candidates.map(bot => <option key={bot.botId} value={bot.botId}>{bot.displayName}</option>)}
      </select></label>
      <label>队长职责<textarea required maxLength={2000} value={responsibility} onChange={e => setResponsibility(e.target.value)} /></label>
      <h3>成员与分工</h3>
      {members.filter(m => !candidates.some(bot => bot.botId === m.botId)).map(m => <p key={m.botId}>成员已停用：{m.botId} <button type="button" onClick={() => remove(m.botId)}>移除失效成员</button></p>)}
      {candidates.filter(bot => bot.botId !== owner).map(bot => {
        const member = members.find(m => m.botId === bot.botId);
        return <div className="bot-team-member-choice" key={bot.botId}>
          <label><input type="checkbox" checked={Boolean(member)} onChange={e => e.target.checked ? setMembers(current => [...current, { botId: bot.botId, responsibility: "", delegatedScope: bot.authorization.allowedScopes.filter((scope): scope is "workspace:read" | "workspace:write" => scope === "workspace:read" || scope === "workspace:write") }]) : remove(bot.botId)} />{bot.displayName}</label>
          {member && <><label>分工<textarea required maxLength={2000} aria-label={`${bot.displayName}的职责`} value={member.responsibility} onChange={e => setMembers(current => current.map(m => m.botId === bot.botId ? { ...m, responsibility: e.target.value } : m))} /></label>
            {members.indexOf(member) > 0 && <fieldset aria-label={`${bot.displayName}的前置成员`}><legend>需要先完成的成员（可选）</legend>{members.slice(0, members.indexOf(member)).map(prior => <label key={prior.botId}><input type="checkbox" checked={member.dependsOnBotIds?.includes(prior.botId) ?? false} onChange={e => setMembers(current => current.map(m => m.botId !== member.botId ? m : { ...m, dependsOnBotIds: e.target.checked ? [...(m.dependsOnBotIds ?? []), prior.botId] : m.dependsOnBotIds?.filter(id => id !== prior.botId) }))} />{bots.find(b => b.botId === prior.botId)?.displayName ?? "已停用成员"}</label>)}</fieldset>}
          </>}
        </div>;
      })}
      <label>协作方式<select value={policy} onChange={e => setPolicy(e.target.value as "parallel" | "sequential")}><option value="parallel">并行协作</option><option value="sequential">依次执行</option></select></label>
      {policy === "parallel" && <label>最多同时执行的成员<select value={concurrency} onChange={e => setConcurrency(Number(e.target.value))}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} 位</option>)}</select></label>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="bot-team-settings-actions"><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" disabled={busy || !name.trim() || !members.length}>{busy ? "正在保存…" : "保存团队设置"}</button></div>
  </form>;
}
