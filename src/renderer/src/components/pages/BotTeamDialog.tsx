import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { IconBot, IconX } from "@/components/common/icons";
import { createTeamWorkSchema, workTeamControlSchema, type WorkTeamControlRequest, type CreateTeamWorkRequest, type WorkTeamTemplateDto } from "@shared/bot-work-team";

const pendingKey = "mybuddy.pending-team-creation";
type PendingTeamCreation = { request: CreateTeamWorkRequest; needsLookup: boolean };
function readPending(): PendingTeamCreation | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
    const request = { ...stored } as Record<string, unknown>;
    // Old uncertain creations must resolve their original operation before the
    // retired field can be removed from a request. Never silently start a new team.
    const needsLookup = Object.prototype.hasOwnProperty.call(request, "budgetTokens");
    delete request.budgetTokens;
    const parsed = createTeamWorkSchema.safeParse(request);
    return parsed.success ? { request: parsed.data, needsLookup } : null;
  } catch { return null; }
}
function clearPending(operationId: string) {
  try { if (readPending()?.request.operationId === operationId) localStorage.removeItem(pendingKey); } catch { /* The original request remains replayable. */ }
}
const pendingTemplateKey = "mybuddy.pending-team-template";
type TemplateRequest = Extract<WorkTeamControlRequest, { kind: "save_template" }>["request"];
function readPendingTemplate(): TemplateRequest | null {
  try { const parsed = workTeamControlSchema.safeParse({ kind: "save_template", request: JSON.parse(localStorage.getItem(pendingTemplateKey) ?? "null") }); return parsed.success && parsed.data.kind === "save_template" ? parsed.data.request : null; }
  catch { return null; }
}
function clearPendingTemplate(operationId: string) {
  try { if (readPendingTemplate()?.operationId === operationId) localStorage.removeItem(pendingTemplateKey); } catch { /* Retaining a request permits safe replay. */ }
}
type MemberDraft = { botId: string; responsibility: string; delegatedScope: Array<"workspace:read" | "workspace:write">; dependsOnBotIds?: string[] };

/** An explicit human delegation: nothing is dispatched until the form is submitted. */
export function BotTeamDialog({ open, onClose, initialTeam }: { open: boolean; onClose: () => void; initialTeam?: WorkTeamTemplateDto }): React.JSX.Element {
  const bots = useAppStore(s => s.botIdentities);
  const activeBotId = useAppStore(s => s.activeBotId);
  const [pendingCreation, setPendingCreation] = useState(readPending);
  const pending = pendingCreation?.request;
  const [creationNotFound, setCreationNotFound] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState(pending?.templateId ?? initialTeam?.templateId ?? "");
  const [title, setTitle] = useState(pending?.title ?? "");
  const [goal, setGoal] = useState(pending?.goalDescription ?? "");
  const [pickingFolder, setPickingFolder] = useState(false);
  const folderFlight = useRef(false);
  const workspaceEditVersion = useRef(0), resolvedWorkspaceFor = useRef("");
  const [resolvingWorkspace, setResolvingWorkspace] = useState(false);
  const [workspace, setWorkspace] = useState(pending?.workspacePath ?? initialTeam?.workspacePath ?? "");
  const [owner, setOwner] = useState(pending?.ownerBotId ?? initialTeam?.ownerBotId ?? activeBotId ?? "");
  const [ownerResponsibility, setOwnerResponsibility] = useState(pending?.ownerResponsibility ?? initialTeam?.ownerResponsibility ?? "核对各成员成果、整理结论与证据，明确待验收项和阻碍。");
  const [members, setMembers] = useState<MemberDraft[]>((pending?.members ?? initialTeam?.members ?? []).map(member => ({ ...member, delegatedScope: member.delegatedScope ?? [] })));
  const [executionPolicy, setExecutionPolicy] = useState<"sequential" | "parallel">(pending?.executionPolicy ?? initialTeam?.executionPolicy ?? "sequential");
  const [maxConcurrency, setMaxConcurrency] = useState(pending?.maxConcurrency ?? initialTeam?.maxConcurrency ?? 2);
  const [criteria, setCriteria] = useState(pending?.criteria.join("\n") ?? "");
  const [templates, setTemplates] = useState<WorkTeamTemplateDto[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState(readPendingTemplate);
  const templateInFlight = useRef(false);
  const [templateNotice, setTemplateNotice] = useState("");
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ workId: string; ownerBotId: string; title: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true), inFlight = useRef(false), epoch = useRef(0), openRef = useRef(open), previousOpen = useRef(open);
  if (open !== previousOpen.current) { epoch.current++; previousOpen.current = open; }
  openRef.current = open;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useEffect(() => useAppStore.subscribe((state, previous) => {
    if (state.page !== previous.page || state.activeBotId !== previous.activeBotId || state.selectedWorkId !== previous.selectedWorkId || state.activeTaskId !== previous.activeTaskId) epoch.current++;
  }), []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void window.api?.botWork.teamControl({ kind: "list_templates" }).then(result => {
      if (live && result.ok) setTemplates(result.templates ?? []);
    }).catch(() => { if (live) setTemplateNotice("暂时无法读取团队模板，可直接填写本次分工。"); });
    return () => { live = false; };
  }, [open]);
  const close = () => { epoch.current++; openRef.current = false; onClose(); };
  const selectedTeam = templates.find(team => team.templateId === selectedTeamId) ?? (initialTeam?.templateId === selectedTeamId ? initialTeam : undefined);
  useEffect(() => {
    if (!open || pending || !selectedTeam) return;
    const key = JSON.stringify([selectedTeam.templateId, selectedTeam.workspacePath]);
    if (resolvedWorkspaceFor.current === key) return;
    resolvedWorkspaceFor.current = key;
    const startedEpoch = epoch.current, editVersion = ++workspaceEditVersion.current;
    setWorkspace(selectedTeam.workspacePath ?? "");
    if (selectedTeam.workspacePath) { setResolvingWorkspace(false); return; }
    setResolvingWorkspace(true);
    if (!window.api) { setResolvingWorkspace(false); setError("本地目录接口不可用，请选择文件夹或稍后重试。"); resolvedWorkspaceFor.current = ""; return; }
    void window.api?.botWork.teamControl({ kind: "resolve_workspace", templateId: selectedTeam.templateId }).then(result => {
      if (!mounted.current || !openRef.current || epoch.current !== startedEpoch || workspaceEditVersion.current !== editVersion) return;
      if (result?.ok && result.workspacePath) setWorkspace(result.workspacePath);
      else { resolvedWorkspaceFor.current = ""; setError(result && !result.ok ? result.message : "未能准备团队目录，请选择本地文件夹。"); }
    }).catch(() => {
      if (mounted.current && openRef.current && epoch.current === startedEpoch && workspaceEditVersion.current === editVersion) { resolvedWorkspaceFor.current = ""; setError("无法准备团队默认目录，请选择文件夹或稍后重试。"); }
    }).finally(() => { if (mounted.current && workspaceEditVersion.current === editVersion) setResolvingWorkspace(false); });
  }, [open, pending, selectedTeam]);
  const candidates = bots.filter(bot => bot.status === "active" && (!selectedTeam || bot.botId === selectedTeam.ownerBotId || selectedTeam.members.some(member => member.botId === bot.botId)));
  const candidate = (id: string) => candidates.find(bot => bot.botId === id);
  const valid = title.trim() && goal.trim() && workspace.trim() && ownerResponsibility.trim()
    && candidate(owner) && members.length > 0
    && members.every(member => member.botId !== owner && member.responsibility.trim() && candidate(member.botId))
    && criteria.split("\n").some(line => line.trim());
  const openWork = (result: { workId: string; ownerBotId: string }) => {
    const state = useAppStore.getState();
    state.setPage("bot"); close(); window.dispatchEvent(new CustomEvent("mybuddy:open-team-work", { detail: { workId: result.workId } }));
  };
  const chooseWorkspace = async () => {
    if (folderFlight.current || pending || busy) return;
    const startedEpoch = epoch.current;
    folderFlight.current = true; setPickingFolder(true); setError("");
    try {
      if (!window.api) throw new Error("本地文件夹选择不可用。");
      const folder = await window.api.pickLocalFolder();
      if (mounted.current && openRef.current && epoch.current === startedEpoch && folder) { workspaceEditVersion.current++; setResolvingWorkspace(false); setWorkspace(folder.path); }
    } catch (cause) {
      if (mounted.current && openRef.current && epoch.current === startedEpoch) setError(cause instanceof Error ? cause.message : "无法打开文件夹选择，请重试或粘贴目录路径。");
    } finally { folderFlight.current = false; if (mounted.current) setPickingFolder(false); }
  };
  const submit = async () => {
    if (inFlight.current || (!pending && !valid)) return;
    const request = pending ?? { operationId: `desktop-team:${crypto.randomUUID()}`, title: title.trim(), goalDescription: goal.trim(),
      workspacePath: workspace.trim(), ...(selectedTeamId ? { templateId: selectedTeamId } : {}), executionPolicy, maxConcurrency: executionPolicy === "parallel" ? maxConcurrency : 1, ownerBotId: owner, ownerResponsibility: ownerResponsibility.trim(),
      members: members.map(member => ({ ...member, responsibility: member.responsibility.trim() })),
      criteria: criteria.split("\n").map(line => line.trim()).filter(Boolean) };
    const parsed = createTeamWorkSchema.safeParse(request);
    if (!parsed.success) { setError("请核对团队目标、工作区、分工、验收条件是否完整有效。"); return; }
    const needsLookup = pendingCreation?.needsLookup ?? false;
    if (!needsLookup) {
      try { localStorage.setItem(pendingKey, JSON.stringify(parsed.data)); }
      catch { setError("无法保存请求，尚未派发。请检查本地存储后重试。"); return; }
    }
    setPendingCreation({ request: parsed.data, needsLookup }); setError(""); setBusy(true); inFlight.current = true;
    const submittedEpoch = epoch.current;
    try {
      const api = window.api?.botWork;
      if (!api) throw new Error("桌面组队接口不可用。");
      let result = needsLookup ? await api.teamControl({ kind: "get_by_operation", operationId: parsed.data.operationId }) : undefined;
      if (result && !result.ok) {
        if (result.code === "not_found") {
          try { localStorage.setItem(pendingKey, JSON.stringify(parsed.data)); }
          catch { if (mounted.current) setError("无法保存请求，尚未派发。请检查本地存储后重试。"); return; }
          if (mounted.current) {
            setPendingCreation({ request: parsed.data, needsLookup: false }); setCreationNotFound(true);
            setError("未找到已创建的事项，原请求已保留。请再次点击「创建并开工」后启动。");
          }
        } else if (mounted.current) setError(result.message);
        return;
      }
      if (!result) result = await api.teamControl({ kind: "create", request: parsed.data });
      if (!result.ok) {
        const rejected = ["invalid_request", "unauthorized_actor", "invalid_team", "not_found", "scope_denied", "invalid_workspace"].includes(result.code);
        if (rejected) clearPending(parsed.data.operationId);
        if (mounted.current) { if (rejected) setPendingCreation(null); setError(result.message); }
        return;
      }
      if (result.operationId !== parsed.data.operationId || !result.work?.workId || !result.team || result.team.workId !== result.work.workId) throw new Error("组队回执与原请求不符，请保留原请求核对。");
      clearPending(parsed.data.operationId);
      if (!mounted.current) return;
      setPendingCreation(null); setCreated(result.work);
      await useAppStore.getState().refreshBotWork(true);
      if (mounted.current && openRef.current && epoch.current === submittedEpoch) openWork(result.work);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "组队结果尚未确认，请按原请求核对。"); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const saveTemplate = async () => {
    if (templateInFlight.current || (!pendingTemplate && (!templateName.trim() || !owner || members.length === 0 || !ownerResponsibility.trim() || members.some(member => !member.responsibility.trim())))) return;
    const request = pendingTemplate ?? { name: templateName.trim(), plan: { executionPolicy, maxConcurrency: executionPolicy === "parallel" ? maxConcurrency : 1, ownerBotId: owner, ownerResponsibility: ownerResponsibility.trim(), members: members.map(member => ({ ...member, responsibility: member.responsibility.trim() })) }, operationId: `desktop-template:${crypto.randomUUID()}` };
    try { localStorage.setItem(pendingTemplateKey, JSON.stringify(request)); }
    catch { setTemplateNotice("无法保存模板请求，尚未提交。"); return; }
    setPendingTemplate(request); templateInFlight.current = true; setTemplateBusy(true); setTemplateNotice("");
    try {
      const result = await window.api?.botWork.teamControl({ kind: "save_template", request });
      if (!mounted.current) return;
      if (!result?.ok) {
        if (result && !result.ok && ["invalid_request", "unauthorized_actor", "name_conflict", "not_found"].includes(result.code)) { clearPendingTemplate(request.operationId); setPendingTemplate(null); }
        setTemplateNotice(result && !result.ok ? result.message : "模板接口不可用。"); return;
      }
      if (!result.template || result.template.name !== request.name) throw new Error("模板回执不匹配");
      clearPendingTemplate(request.operationId); setPendingTemplate(null);
      setTemplates(current => [...current.filter(item => item.templateId !== result.template!.templateId), result.template!]);
      setTemplateNotice("团队模板已保存。仅保存成员和分工，使用时仍会核对成员是否可用。");
    } catch { if (mounted.current) setTemplateNotice("模板保存结果尚未确认，核对原请求不会重复保存。"); }
    finally { templateInFlight.current = false; if (mounted.current) setTemplateBusy(false); }
  };
  const deleteTemplate = async (templateId: string) => {
    if (templateBusy) return;
    setTemplateBusy(true);
    try {
      const result = await window.api?.botWork.teamControl({ kind: "delete_template", templateId });
      if (!mounted.current) return;
      if (!result?.ok) { setTemplateNotice(result && !result.ok ? result.message : "模板接口不可用。"); return; }
      setTemplates(current => current.filter(item => item.templateId !== templateId)); setDeleteTemplateId(null);
      setTemplateNotice("模板已删除；既有团队事项和 Bot 不受影响。");
    } catch { if (mounted.current) setTemplateNotice("删除结果未确认，请刷新模板列表后核对。"); }
    finally { if (mounted.current) setTemplateBusy(false); }
  };
  const toggleMember = (botId: string) => setMembers(current => current.some(member => member.botId === botId)
    ? current.filter(member => member.botId !== botId).map(member => ({ ...member, dependsOnBotIds: member.dependsOnBotIds?.filter(id => id !== botId) })) : [...current, { botId, responsibility: "", delegatedScope: ["workspace:read", "workspace:write"] }]);
  return <dialog ref={dialog} className="bot-create-dialog bot-team-dialog" aria-labelledby="bot-team-title"
    onCancel={event => { event.preventDefault(); close(); }} onKeyDownCapture={event => {
      if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") close();
    }}>
    <header className="bot-create-header"><span className="bot-avatar" aria-hidden="true"><IconBot size={20} /></span>
      <div><h2 id="bot-team-title">组队开工</h2><p>一个目标，明确分工，由负责人统一汇总</p></div>
      <button type="button" className="icon-btn" aria-label="关闭组队开工" onClick={close}><IconX size={18} /></button></header>
    {created ? <section className="bot-create-success"><h3>已建立团队事项</h3><p>{created.title} 已受理。成员按计划在各自范围内执行，负责人随后核对和汇总。结果会随团队事项返回，也可在负责人的任务收件箱查看，无需留在此窗口等待。</p><div className="bot-create-actions"><button type="button" onClick={() => { setCreated(null); setTitle(""); setGoal(""); setCriteria(""); setError(""); }}>再建一队</button><button type="button" onClick={() => openWork(created)}>查看团队事项</button></div></section>
      : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <p>选择负责人和至少一位成员。每位成员使用自己的身份和配置，不共享私人记忆。</p>
        <fieldset disabled={Boolean(pending)}>
          {templates.length > 0 && <><label htmlFor="team-template">使用团队模板</label><select id="team-template" value={selectedTeamId} onChange={event => {
            setSelectedTeamId(event.target.value);
            const template = templates.find(item => item.templateId === event.target.value); if (!template) return;
            setOwner(template.ownerBotId); setOwnerResponsibility(template.ownerResponsibility);

            setExecutionPolicy(template.executionPolicy ?? "sequential"); setMaxConcurrency(template.maxConcurrency ?? 2);
            setMembers(template.members.map(member => ({ ...member, delegatedScope: ["workspace:read", "workspace:write"] })));
            setTemplateNotice("已填入模板。请核对成员与分工，再填写本次目标和工作区。");
          }}><option value="">选择模板（可选）</option>{templates.map(template => <option key={template.templateId} value={template.templateId}>{template.name}</option>)}</select></>}

          {templates.length > 0 && <details className="bot-team-template"><summary>管理团队模板</summary>{templates.map(template => <div className="bot-team-template-row" key={template.templateId}><span>{template.name}</span>{deleteTemplateId === template.templateId ? <><span>仅删除模板？</span><button type="button" disabled={templateBusy} onClick={() => { void deleteTemplate(template.templateId); }}>确认删除</button><button type="button" disabled={templateBusy} onClick={() => setDeleteTemplateId(null)}>保留</button></> : <button type="button" disabled={templateBusy} onClick={() => setDeleteTemplateId(template.templateId)}>删除模板</button>}</div>)}</details>}
          <label htmlFor="team-title">事项名称</label><input id="team-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required placeholder="例如：梳理项目现状与改进建议" />
          <label htmlFor="team-goal">共同目标</label><textarea id="team-goal" value={goal} onChange={event => setGoal(event.target.value)} maxLength={2000} rows={3} required placeholder="说明希望得到什么，以及不需要做什么。" />
          <label htmlFor="team-workspace">工作文件夹</label><div className="bot-team-workspace-picker"><input id="team-workspace" value={workspace} onChange={event => { workspaceEditVersion.current++; setResolvingWorkspace(false); setWorkspace(event.target.value); }} maxLength={2000} required placeholder="选择现有文件夹，或粘贴本机目录路径" /><button type="button" disabled={busy || pickingFolder || Boolean(pending)} onClick={() => void chooseWorkspace()}>{pickingFolder ? "正在选择…" : "选择文件夹"}</button></div><p className="bot-team-scope">{resolvingWorkspace ? "正在准备团队自己的工作文件夹…" : "使用本机已有文件夹，选中后自动填入路径；无需导入，不会上传或移动文件。"}</p>
          <label htmlFor="team-owner">主负责人</label><select id="team-owner" disabled={Boolean(selectedTeamId)} value={owner} onChange={event => { setOwner(event.target.value); setMembers(current => current.filter(member => member.botId !== event.target.value).map(member => ({ ...member, dependsOnBotIds: member.dependsOnBotIds?.filter(id => id !== event.target.value) }))); }} required>
            <option value="">选择负责人</option>{candidates.map(bot => <option key={bot.botId} value={bot.botId}>{bot.displayName}</option>)}</select>
          <label htmlFor="team-owner-role">负责人的汇总职责</label><textarea id="team-owner-role" value={ownerResponsibility} onChange={event => setOwnerResponsibility(event.target.value)} maxLength={2000} rows={2} required />
          <label htmlFor="team-execution-policy">执行方式</label><select id="team-execution-policy" value={executionPolicy} onChange={event => setExecutionPolicy(event.target.value as "sequential" | "parallel")}>
            <option value="sequential">依次执行</option><option value="parallel">按依赖并行</option></select>
          {executionPolicy === "parallel" && <><label htmlFor="team-concurrency">最多同时执行的成员数</label><select id="team-concurrency" value={maxConcurrency} onChange={event => setMaxConcurrency(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}</select><p>无依赖的成员可同时开始；共享文件仍受资源互斥保护。需要使用他人成果时请明确选择前置成员。</p></>}
          <h3 className="bot-team-members-heading">团队成员与分工</h3>
          {owner && !candidate(owner) && <p role="alert">模板负责人已停用或不存在，请重新选择。</p>}
          {members.filter(member => !candidate(member.botId)).map(member => <p key={member.botId} role="alert">成员 {bots.find(bot => bot.botId === member.botId)?.displayName ?? member.botId} 已不可用。<button type="button" onClick={() => toggleMember(member.botId)}>移除此成员</button></p>)}
          {candidates.filter(bot => bot.botId !== owner).length === 0 && <p>至少需要两个 Bot。请先关闭此窗口，通过「新建 Bot」添加成员。</p>}
          {candidates.filter(bot => bot.botId !== owner).map(bot => {
            const member = members.find(item => item.botId === bot.botId);
            return <section key={bot.botId} className={`bot-team-member ${member ? "is-selected" : ""}`}>
              <label className="bot-team-member-toggle"><input type="checkbox" checked={Boolean(member)} onChange={() => toggleMember(bot.botId)} /><span><strong>{bot.displayName}</strong><small>{bot.responsibilitySummary || "尚未设置长期职责"}</small></span></label>
              {member && <><label htmlFor={`team-role-${bot.botId}`}>这次负责什么</label><textarea id={`team-role-${bot.botId}`} value={member.responsibility} required rows={2} maxLength={2000} placeholder="限定任务与产出，避免成员重复处理同一工作。"
                onChange={event => setMembers(current => current.map(item => item.botId === bot.botId ? { ...item, responsibility: event.target.value } : item))} />
                {executionPolicy === "parallel" && <fieldset aria-label={`${bot.displayName}的前置成员`}><legend>等待哪些成员先结束</legend>
                  {members.slice(0, members.findIndex(item => item.botId === bot.botId)).map(prior => <label key={prior.botId}><input type="checkbox" checked={member.dependsOnBotIds?.includes(prior.botId) ?? false} onChange={event => setMembers(current => current.map(item => item.botId === bot.botId ? { ...item, dependsOnBotIds: event.target.checked ? [...(item.dependsOnBotIds ?? []), prior.botId] : (item.dependsOnBotIds ?? []).filter(id => id !== prior.botId) } : item))} />{candidate(prior.botId)?.displayName ?? prior.botId}</label>)}
                  {members.findIndex(item => item.botId === bot.botId) === 0 && <p>没有前置成员，可先开始。</p>}
                </fieldset>}
                </>}
            </section>;
          })}
          <label htmlFor="team-criteria">验收条件 <span>每行一项</span></label><textarea id="team-criteria" value={criteria} onChange={event => setCriteria(event.target.value)} maxLength={12000} rows={3} required placeholder="例如：结论注明来源，未验证事项明确列出" />
          <details className="bot-team-template"><summary>将成员与分工保存为可复用模板</summary>{pendingTemplate && <p role="status">模板「{pendingTemplate.name}」的原保存请求尚待核对。当前分工修改不会改变原请求。</p>}<label htmlFor="team-template-name">模板名称</label><input id="team-template-name" value={templateName} maxLength={120} onChange={event => setTemplateName(event.target.value)} /><button type="button" disabled={templateBusy || (!pendingTemplate && (!templateName.trim() || !owner || members.length === 0 || members.some(member => !member.responsibility.trim())))} onClick={() => { void saveTemplate(); }}>{templateBusy ? "正在保存…" : pendingTemplate ? "核对原模板" : "保存团队模板"}</button><p className="bot-team-scope">模板只保存成员与分工，不会启动工作。</p></details>
        </fieldset>
        {templateNotice && <p role="status">{templateNotice}</p>}
        <p className="bot-create-boundary">成员按所选执行方式与依赖安排，负责人汇总结果。关闭窗口不会停止已提交的工作，请在事项中暂停或取消。</p>
        {error && <p role="alert" className="bot-create-error">{error}</p>}
        {pending && <p role="status" className="bot-create-pending">{busy ? "正在提交团队事项…" : "保留上次请求，重试只核对同一事项，不会重新建队。"}</p>}
        <footer className="bot-create-actions"><button type="button" onClick={close}>关闭</button><button type="submit" className="bot-create-primary" disabled={busy || (!pending && !valid)}>{busy ? "正在提交…" : pending && !creationNotFound ? "核对原请求" : "创建并开工"}</button></footer>
      </form>}
  </dialog>;
}
