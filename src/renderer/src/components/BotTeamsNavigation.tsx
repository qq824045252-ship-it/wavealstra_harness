import { BotTeamAvatar } from "./common/BotTeamAvatar";
import type { WorkProjectionDto } from "@shared/bot-work";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { IconPlus, IconX } from "@/components/common/icons";
import { BotTeamSettings } from "./pages/BotTeamSettings";
import { BotTeamDialog } from "./pages/BotTeamDialog";
import { workTeamControlSchema, type WorkTeamTemplateDto, type WorkTeamMember, type WorkTeamPlan } from "@shared/bot-work-team";
import { botWorkBadges } from "@/lib/botWorkIndicators";
import { useBotWorkIndicators } from "@/hooks/useBotWorkIndicators";
import "./BotTeamsNavigation.css";

type SavedTeamRequest = { operationId: string; name: string; plan: WorkTeamPlan };
const pendingTeamKey = "mybuddy.pending-team-directory";
function pendingTeam(): SavedTeamRequest | null {
  try { const parsed = workTeamControlSchema.safeParse({ kind: "save_template", request: JSON.parse(localStorage.getItem(pendingTeamKey) ?? "null") });
    return parsed.success && parsed.data.kind === "save_template" ? parsed.data.request : null;
  } catch { return null; }
}
/** Named teams reuse the persisted team service; task membership is an explicit server identity. */
export function BotTeamsNavigation({ onSelect }: { onSelect?: () => void } = {}): React.JSX.Element {
  const activeTeam = useAppStore(state => state.activeTeam);
  const bots = useAppStore(s => s.botIdentities);
  const indicators = useBotWorkIndicators();
  const [teams, setTeams] = useState<WorkTeamTemplateDto[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<WorkTeamTemplateDto | null>(null);
  const [settings, setSettings] = useState(false);
  const [savedNotice, setSavedNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [delegating, setDelegating] = useState<WorkTeamTemplateDto | null>(null);
  const [pending] = useState(pendingTeam);
  const [name, setName] = useState(pending?.name ?? "");
  const [owner, setOwner] = useState(pending?.plan.ownerBotId ?? "");
  const [members, setMembers] = useState<WorkTeamMember[]>(pending?.plan.members ?? []);
  const [saving, setSaving] = useState(false);
  const saveFlight = useRef(false);
  const saveRequest = useRef<SavedTeamRequest | null>(pending);
  const viewEpoch = useRef(0);
  const settingsEpoch = useRef(0);
  const teamRefreshEpoch = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const candidates = bots.filter(bot => bot.status === "active");
  const botName = (id: string) => bots.find(bot => bot.botId === id)?.displayName ?? "已停用 Bot";
  useEffect(() => {
    let live = true;
    const initialEpoch = ++teamRefreshEpoch.current;
    void window.api?.botWork.teamControl({ kind: "list_templates" }).then(result => {
      if (!live || initialEpoch !== teamRefreshEpoch.current) return;
      if (result.ok) {
        const listed = result.templates ?? []; setTeams(listed);
        const state = useAppStore.getState();
        if (state.activeTeam) {
          const current = listed.find(team => team.templateId === state.activeTeam?.templateId);
          if (!current) state.setActiveBotId(state.activeBotId);
          else if (current.ownerBotId !== state.activeTeam.ownerBotId) state.setActiveTeam(current);
          else useAppStore.setState({ activeTeam: current });
        }
        try { const saved = localStorage.getItem("mybuddy.active-team"); const team = listed.find(item => item.templateId === saved); if (team && !useAppStore.getState().activeTeam) useAppStore.getState().setActiveTeam(team); } catch {}
      } else setError(result.message);
    }).catch(() => { if (live && initialEpoch === teamRefreshEpoch.current) setError("团队暂时无法加载。"); });
    const refresh = () => {
      const epoch = ++teamRefreshEpoch.current;
      void window.api?.botWork.teamControl({ kind: "list_templates" }).then(result => {
        if (!live || epoch !== teamRefreshEpoch.current || !result.ok) return;
        const listed = result.templates ?? []; setTeams(listed);
        const state = useAppStore.getState();
        if (!state.activeTeam) return;
        const current = listed.find(team => team.templateId === state.activeTeam?.templateId);
        if (!current) state.setActiveBotId(state.activeBotId);
        else if (current.ownerBotId !== state.activeTeam.ownerBotId) state.setActiveTeam(current);
        else useAppStore.setState({ activeTeam: current });
      }).catch(() => { if (live && epoch === teamRefreshEpoch.current) setError("团队暂时无法刷新。"); });
    };
    window.addEventListener("mybuddy:teams-refresh", refresh);
    let messageTimer: ReturnType<typeof setTimeout> | undefined;
    const messageChanged = () => {
      if (messageTimer) return;
      messageTimer = setTimeout(() => { messageTimer = undefined; refresh(); }, 400);
    };
    const unsubscribe = window.api?.botWork.onMessageChanged?.(messageChanged);
    return () => { live = false; if (messageTimer) clearTimeout(messageTimer); unsubscribe?.(); window.removeEventListener("mybuddy:teams-refresh", refresh); };
  }, []);
  useEffect(() => {
    if (creating || selected) { if (!dialog.current?.open) dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [creating, selected]);
  const close = () => { viewEpoch.current++; setCreating(false); setSelected(null); setSettings(false); };
  const openTeam = (team: WorkTeamTemplateDto) => {
    close(); setError(""); setSavedNotice("");
    useAppStore.getState().setActiveTeam(team); onSelect?.();
    void useAppStore.getState().refreshBotWork(true);
  };
  const openWork = (work: WorkProjectionDto) => {
    close(); onSelect?.();
    useAppStore.getState().setHistoricalTeamWork(work);
  };
  useEffect(() => {
    const listener = (event: Event) => {
      const id = (event as CustomEvent<{ workId?: string }>).detail?.workId;
      if (!id) return;
      const epoch = ++viewEpoch.current;
      const navigationEpoch = useAppStore.getState().botNavigationEpoch;
      void window.api?.botWork.getWork(id).then(work => {
        if (viewEpoch.current !== epoch || useAppStore.getState().botNavigationEpoch !== navigationEpoch) return;
        if (!work?.team) { setError("找不到该团队任务，请刷新后重试。"); return; }
        const team = teams.find(item => item.templateId === work.team?.teamId);
        if (team) { openTeam(team); useAppStore.getState().setSelectedWorkId(id); return; }
        openWork(work);
      }).catch(() => { if (viewEpoch.current === epoch && useAppStore.getState().botNavigationEpoch === navigationEpoch) setError("团队任务详情暂时无法加载，请重试。"); });
    };
    window.addEventListener("mybuddy:open-team-work", listener);
    return () => { viewEpoch.current++; window.removeEventListener("mybuddy:open-team-work", listener); };
  }, [teams]);
  useEffect(() => {
    const update = (event: Event) => { const team = (event as CustomEvent<WorkTeamTemplateDto>).detail; if (team?.templateId) { teamRefreshEpoch.current++; setTeams(current => current.map(item => item.templateId === team.templateId ? team : item)); const state = useAppStore.getState(); if (state.activeTeam?.templateId === team.templateId) { if (state.activeTeam.ownerBotId === team.ownerBotId) useAppStore.setState({ activeTeam: team }); else state.setActiveTeam(team); } } };
    window.addEventListener("mybuddy:team-updated", update);
    return () => window.removeEventListener("mybuddy:team-updated", update);
  }, []);
  const save = async () => {
    if (saveFlight.current) return;
    if (!saveRequest.current) saveRequest.current = {
      operationId: `desktop-team-registry:${crypto.randomUUID()}`, name: name.trim(),
      plan: { ownerBotId: owner, ownerResponsibility: "统筹团队分工、跟进执行，并向用户汇总成果与未完成事项。", members,
        executionPolicy: "parallel", maxConcurrency: Math.min(4, Math.max(1, members.length)) },
    };
    try { localStorage.setItem(pendingTeamKey, JSON.stringify(saveRequest.current)); }
    catch { saveRequest.current = null; setError("本地无法保存创建请求，尚未提交。"); return; }
    const epoch = viewEpoch.current;
    saveFlight.current = true; setSaving(true); setError("");
    try {
      const result = await window.api?.botWork.teamControl({ kind: "save_template", request: saveRequest.current });
      if (!result?.ok || !result.template) {
        if (result && !result.ok) { setError(result.message); saveRequest.current = null; localStorage.removeItem(pendingTeamKey); }
        else setError("保存结果尚未确认，请重试核对原请求。");
        return;
      }
      const team = result.template;
      saveRequest.current = null; localStorage.removeItem(pendingTeamKey);
      setTeams(current => [...current.filter(item => item.templateId !== team.templateId), team]);
      if (viewEpoch.current === epoch) openTeam(team);
    } catch { setError("保存结果尚未确认，请重试核对原请求，不会重复创建。"); }
    finally { saveFlight.current = false; setSaving(false); }
  };
  return <section className="bot-teams-navigation" aria-label="我的 Bot 团队">
    <div className="sidebar-tree-header"><span className="section-title">我的 Bot 团队</span><span className="sidebar-section-count">{teams.length}</span>
      <button type="button" className="sidebar-bot-create" onClick={() => { viewEpoch.current++; setError(""); setCreating(true); if (!saveRequest.current) { setName(""); setOwner(candidates[0]?.botId ?? ""); setMembers([]); } }}><IconPlus size={12} />新建团队</button>
    </div>
    {!teams.length && <p className="sidebar-empty">把常用 Bot 组成团队，统一接收任务和返回成果。</p>}
    {teams.map(team => { const badges = botWorkBadges(indicators.teams[team.templateId]); return <button type="button" className={`sidebar-bot-row sidebar-bot-identity ${activeTeam?.templateId === team.templateId ? "active" : ""}`} aria-pressed={activeTeam?.templateId === team.templateId} key={team.templateId} onClick={() => openTeam(team)}>
      <BotTeamAvatar team={team} bots={bots} className="sidebar-bot-avatar" /><span><strong title={team.name}>{team.name}</strong><small className="bot-team-meta"><span>{team.members.length + 1} 位 Bot · 队长 {botName(team.ownerBotId)}</span>{badges.map(badge => <span key={badge.key} className="sidebar-bot-work" data-tone={badge.key} title={badge.title}>{badge.label} {badge.value}</span>)}</small></span>
    </button>; })}
    {error && !creating && !selected && <p role="status">{error}</p>}
    <dialog ref={dialog} className="bot-team-directory-dialog" aria-label={creating ? "新建 Bot 团队" : "团队工作空间"} onCancel={event => { event.preventDefault(); close(); }} onClose={close}>
      <header><h2>{creating ? "新建 Bot 团队" : settings ? `${selected?.name} · 团队设置` : selected?.name}</h2><button type="button" aria-label="关闭团队面板" onClick={close}><IconX size={18} /></button></header>
      {selected && settings ? <BotTeamSettings key={selected.templateId} team={selected} onCancel={() => { viewEpoch.current++; setSettings(false); }} onSaved={team => { setTeams(current => current.map(item => item.templateId === team.templateId ? team : item)); if (viewEpoch.current !== settingsEpoch.current) return; setSelected(team); setSettings(false); setSavedNotice("团队设置已保存，用于后续新任务。"); }} /> : creating ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <p>先建立团队。之后交给这个团队的任务、进度和成果会归在一起；队长负责协调与汇报。</p>
        <fieldset disabled={saving || Boolean(saveRequest.current)}>
          <label>团队名称<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="例如：产品研发团队" /></label>
          <label>队长<select required value={owner} onChange={e => { setOwner(e.target.value); setMembers(current => current.filter(m => m.botId !== e.target.value)); }}>
            <option value="">选择 Bot</option>{candidates.map(bot => <option key={bot.botId} value={bot.botId}>{bot.displayName}</option>)}
          </select></label>
          <h3>团队成员</h3>
          {candidates.filter(bot => bot.botId !== owner).map(bot => {
            const member = members.find(item => item.botId === bot.botId);
            return <div key={bot.botId} className="bot-team-member-choice"><label><input type="checkbox" checked={Boolean(member)} onChange={e => setMembers(current => e.target.checked ? [...current, { botId: bot.botId, responsibility: "", delegatedScope: bot.authorization.allowedScopes.filter((scope): scope is "workspace:read" | "workspace:write" => scope === "workspace:read" || scope === "workspace:write") }] : current.filter(item => item.botId !== bot.botId))} />{bot.displayName}</label>
              {member && <input aria-label={`${bot.displayName}的职责`} required maxLength={2000} placeholder="这个成员负责什么" value={member.responsibility} onChange={e => setMembers(current => current.map(item => item.botId === bot.botId ? { ...item, responsibility: e.target.value } : item))} />}
            </div>;
          })}
          {candidates.length < 2 && <p>至少需要两位可用 Bot，请先在侧栏新建 Bot。</p>}
        </fieldset>
        <button type="submit" disabled={saving || (!saveRequest.current && (!name.trim() || !owner || !members.length || members.some(m => !m.responsibility.trim())))}>{saving ? "正在保存…" : saveRequest.current ? "核对保存结果" : "创建团队"}</button>
      </form> : selected && <>
        {savedNotice && <p role="status">{savedNotice}</p>}
        <button type="button" onClick={() => { settingsEpoch.current = ++viewEpoch.current; setSettings(true); }}>团队设置</button>
        <p>{selected.members.length + 1} 位 Bot · 队长 {botName(selected.ownerBotId)} 负责统筹汇报</p>
        <div className="bot-team-directory-members">{selected.members.map(member => <p key={member.botId}><strong>{botName(member.botId)}</strong> · {member.responsibility}</p>)}</div>
        <button type="button" onClick={() => { setDelegating(selected); close(); }}>交给团队新任务</button>
        <h3>团队任务与成果</h3>
        <p>任务由「{selected.name}」负责，队长协调成员执行。</p>
        <button type="button" onClick={() => openTeam(selected)}>打开团队事项与成果</button>
      </>}
      {error && <p role="alert">{error}</p>}
    </dialog>
    {delegating && <BotTeamDialog key={delegating.templateId} initialTeam={delegating} open onClose={() => setDelegating(null)} />}
  </section>;
}
