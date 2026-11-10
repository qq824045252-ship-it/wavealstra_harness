import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { WorkProjectionDto } from "@shared/bot-work";
import type { BotActiveRequestDto } from "@shared/bot-conversation";
import type { SubagentSummaryDto } from "@shared/agent-ipc";
import { activityKindLabels, buildActivityRows, type ActivityKind, type ActivityRow } from "@/lib/botActivityMonitor";
import { botMessageStatus } from "@/lib/botWorkspacePresentation";
import { IconX } from "@/components/common/icons";
import "./BotActivityMonitor.css";

const PAGE_SIZE = 40;
/** Mounted only while open: no background polling or global mutation of execution state. */
export function BotActivityMonitor({ onOpenBotMessage, onOpenWork }: { onOpenBotMessage: (messageId: string) => void; onOpenWork?: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const activeBotId = useAppStore(s => s.activeBotId);
  const activeTeam = useAppStore(s => s.activeTeam);
  const [globalBotId, setGlobalBotId] = useState<string | null>(null);
  const contextKey = activeTeam ? "team:" + activeTeam.templateId : activeBotId;
  const globalScope = globalBotId !== null && globalBotId === contextKey;
  const setGlobalScope = (global: boolean) => setGlobalBotId(global ? contextKey : null);
  return <><button type="button" ref={anchor} className="bot-quiet-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setGlobalScope(false); setOpen(value => !value); }}>所有消息</button>
    {open && <ActivityWindow anchor={anchor.current} key={(activeTeam?.templateId ?? activeBotId ?? "") + ":" + globalScope} scopeTeamId={globalScope ? undefined : activeTeam?.templateId} scopeBotId={globalScope ? null : activeBotId ?? ""} onScopeChange={setGlobalScope} onClose={() => setOpen(false)} onOpenBotMessage={onOpenBotMessage} onOpenWork={onOpenWork} />}</>;
}
export function ActivityWindow({ anchor, scopeTeamId, scopeBotId, onScopeChange, onClose, onOpenBotMessage, onOpenWork }: { anchor: HTMLButtonElement | null; scopeTeamId?: string; scopeBotId: string | null; onScopeChange: (global: boolean) => void; onClose: () => void; onOpenBotMessage: (messageId: string) => void; onOpenWork?: () => void }): React.JSX.Element {
  const tasks = useAppStore(s => s.tasks);
  const works = useAppStore(s => s.botWorks);
  const [monitorWorks, setMonitorWorks] = useState<WorkProjectionDto[]>(works);
  const allBots = useAppStore(s => s.botIdentities);
  const bots = useMemo(() => scopeBotId === null ? allBots : allBots.filter(bot => bot.botId === scopeBotId), [allBots, scopeBotId]);
  const histories = useAppStore(s => s.botHistories);
  const errors = useAppStore(s => s.botConversationErrors);
  const workError = useAppStore(s => s.botWorkError);
  const [activeRequests, setActiveRequests] = useState<BotActiveRequestDto[]>([]);
  const [inspected, setInspected] = useState<ActivityRow | null>(null);
  const [inspectError, setInspectError] = useState("");
  const [subagents, setSubagents] = useState<Record<string, SubagentSummaryDto[]>>({});
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState(0);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ActivityKind | "all">("all");
  const [includeEnded, setIncludeEnded] = useState(true);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const dialog = useRef<HTMLDialogElement>(null);
  const refreshing = useRef(false);
  const scope = String(scopeTeamId) + ":" + String(scopeBotId) + ":" + bots.map(bot => bot.userId + ":" + bot.botId).sort().join("|");
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !anchor) return;
    const position = () => {
      const button = anchor.getBoundingClientRect();
      const width = Math.min(560, window.innerWidth - 24);
      const below = window.innerHeight - button.bottom - 16;
      const above = button.top - 16;
      const openBelow = below >= 240 || below >= above;
      const height = Math.max(100, Math.min(640, openBelow ? below : above));
      element.style.width = width + "px";
      element.style.maxHeight = height + "px";
      element.style.left = Math.max(12, Math.min(button.right - width, window.innerWidth - width - 12)) + "px";
      element.style.top = (openBelow ? Math.max(12, button.bottom + 8) : Math.max(12, button.top - element.getBoundingClientRect().height - 8)) + "px";
    };
    element.showPopover();
    position();
    const resize = new ResizeObserver(position);
    resize.observe(anchor); resize.observe(element);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const dismiss = (event: PointerEvent) => { if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); anchor.focus(); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      resize.disconnect(); element.hidePopover();
      window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true);
      document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape);
    };
  }, [anchor]);
  useEffect(() => {
    setSubagents({}); setActiveRequests([]); setLoading(true);
    let live = true;
    const scanned = new Set<string>();
    let activeTasks = new Set<string>();
    const refresh = async () => {
      if (refreshing.current) return;
      refreshing.current = true;
      try {
        const state = useAppStore.getState();
        const requestRead = window.api?.botWork.activeRequests();
        if (!requestRead) throw new Error("Bot 活跃请求接口不可用，请更新并重启应用");
        const requests = await requestRead;
        if (live) setActiveRequests(scopeBotId === null ? requests : requests.filter(request => scopeTeamId ? request.message.teamId === scopeTeamId : request.message.botId === scopeBotId && !request.message.teamId));
        const [workSnapshot] = await Promise.all([window.api!.botWork.listWorks(true),
          ...state.botIdentities.filter(bot => scopeBotId === null || bot.botId === scopeBotId).map(bot => state.refreshBotHistory(bot.botId, scopeTeamId))]);
        if (live) setMonitorWorks(workSnapshot);
        // Keep this all-Work view local: the main page may independently sync
        // an open-only cursor and must not erase closed rows in this reader.
        // Task-scoped API preserves existing access checks. Bound concurrency prevents
        // a large history from flooding IPC; snapshots never open/restart a task.
        const boundTasks = new Set(workSnapshot.filter(work => (scopeTeamId ? work.team?.teamId === scopeTeamId : work.ownerBotId === scopeBotId && !work.team)).flatMap(work => work.executions.map(binding => binding.taskId)));
        const candidates = state.tasks.filter(task => (scopeBotId === null || boundTasks.has(task.id)) && !task.archived && (!scanned.has(task.id) || activeTasks.has(task.id) || task.status === "in_progress" || task.durable?.busy));
        const next: Record<string, SubagentSummaryDto[]> = {};
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
          while (cursor < candidates.length && live) {
            const task = candidates[cursor++];
            const api = window.api?.subagent;
            if (!api) throw new Error("子代理状态接口不可用");
            next[task.id] = await api.active(task.id);
            scanned.add(task.id);
          }
        }));
        if (live) { activeTasks = new Set(Object.entries(next).filter(([, items]) => items.length > 0).map(([id]) => id)); setSubagents(current => ({ ...current, ...next })); setCheckedAt(Date.now()); setLoadError(""); }
      } catch (error) {
        if (live) { setLoadError(error instanceof Error ? error.message : String(error)); }
      } finally { refreshing.current = false; if (live) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const unsubscribe = window.api?.subagent?.onEvent?.(() => void refresh());
    return () => { live = false; clearInterval(timer); unsubscribe?.(); };
  }, [scope]);
  const rows = useMemo(() => buildActivityRows({ tasks, works: monitorWorks, bots, histories, subagents, now: checkedAt, activeRequests, scopeBotId, scopeTeamId }), [tasks, monitorWorks, bots, histories, subagents, checkedAt, activeRequests, scopeBotId, scopeTeamId]);
  // Keep rows in their original positions while open. Status still updates in place;
  // newly discovered rows append instead of moving the user's click target.
  const rowOrder = useRef(new Map<string, number>());
  const stableRows = useMemo(() => {
    for (const row of rows) if (!rowOrder.current.has(row.id)) rowOrder.current.set(row.id, rowOrder.current.size);
    return [...rows].sort((a, b) => rowOrder.current.get(a.id)! - rowOrder.current.get(b.id)!);
  }, [rows]);
  const filtered = stableRows.filter(row => (includeEnded || !row.ended) && (kind === "all" || row.kind === kind)
    && [row.title, row.owner, row.label, row.detail].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    const source = inspected?.sourceRequest;
    if (!source) return;
    let live = true;
    const latest = activeRequests.find(item => item.message.messageId === source.message.messageId);
    if (latest) {
      setInspected(current => current ? { ...current, sourceRequest: latest, label: botMessageStatus(latest.message) } : null);
      setInspectError("");
      return;
    }
    // A request can finish while this reader is open. Fetch its exact original
    // history window, never replace the active Bot's store with archived history.
    void (async () => {
      if (!window.api) throw new Error("主机离线");
      const listed = source.message.teamId ? await window.api.botWork.teamControl({ kind: "list_templates" }) : undefined;
      const owner = listed?.ok ? listed.templates?.find(team => team.templateId === source.message.teamId)?.ownerBotId : undefined;
      return window.api.botWork.history({ botId: owner ?? source.message.botId, teamId: source.message.teamId, conversationId: source.message.conversationId, before: source.message.ordinal + 1 });
    })().then(history => {
      if (!live) return;
      const message = history.messages.find(item => item.messageId === source.message.messageId);
      if (!message) { setInspectError("原请求的最终状态暂时无法读取，下面保留上次记录。"); return; }
      setInspected(current => current ? { ...current, label: botMessageStatus(message), sourceRequest: { ...source, message } } : null);
      setInspectError("");
    }).catch(() => { if (live) setInspectError("原请求的最终状态暂时无法读取，下面保留上次记录。"); });
    return () => { live = false; };
  }, [inspected?.id, activeRequests]);
  const openRow = (row: ActivityRow) => {
    if (row.sourceRequest) { setInspectError(""); setInspected(row); return; }
    const state = useAppStore.getState();
    if (row.teamWork && row.workId) {
      onClose();
      window.dispatchEvent(new CustomEvent("mybuddy:open-team-work", { detail: { workId: row.workId } }));
      return;
    }
    if (row.workId && row.botId) { state.setActiveBotId(row.botId); state.setSelectedWorkId(row.workId); state.setPage("bot"); onOpenWork?.(); }
    else if (row.teamId && row.botId) {
      void window.api?.botWork.teamControl({ kind: "list_templates" }).then(result => {
        const team = result?.ok && result.templates?.find(item => item.templateId === row.teamId);
        if (team) { state.setActiveTeam(team); if (row.messageId) onOpenBotMessage(row.messageId); }
      });
    }
    else if (row.botId) { state.setActiveBotId(row.botId); state.setSelectedWorkId(null); state.setPage("bot"); if (row.messageId) onOpenBotMessage(row.messageId); }
    else if (row.taskId) {
      state.setActiveTask(row.taskId);
      if (row.subagentId) state.openSubagentView(row.taskId, row.subagentId);
    }
    onClose();
  };
  const failedSources = Object.keys(errors).filter(id => scopeBotId === null || id === scopeBotId).length;
  return <dialog ref={dialog} popover="manual" className="bot-activity-window" aria-label="所有消息与任务进度" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2>{scopeBotId === null ? "全部任务与消息" : (scopeTeamId ? useAppStore.getState().activeTeam?.name ?? "当前团队" : bots[0]?.displayName ?? "当前 Bot") + " · 所有消息"}</h2>
      <button type="button" aria-label="关闭所有消息" onClick={onClose}><IconX size={20} /></button></header>
    <div className="bot-activity-controls">
      <select aria-label="消息范围" value={scopeBotId === null ? "all" : "bot"} onChange={event => onScopeChange(event.target.value === "all")}><option value="bot">{useAppStore.getState().activeTeam ? "当前团队" : "当前 Bot"}</option><option value="all">全局总览</option></select>
      <input autoFocus type="search" aria-label="搜索所有任务与消息" placeholder="搜索任务或消息" value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} />
      <select aria-label="任务类型" value={kind} onChange={event => { setKind(event.target.value as ActivityKind | "all"); setLimit(PAGE_SIZE); }}><option value="all">所有类型</option>{Object.entries(activityKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <label><input type="checkbox" checked={includeEnded} onChange={event => { setIncludeEnded(event.target.checked); setLimit(PAGE_SIZE); }} />包含已结束</label>
    </div>
    <p className="bot-activity-summary" role="status">{loading ? "正在核对最新进度…" : `执行中 ${rows.filter(row => row.running).length} · 未结束 ${rows.filter(row => !row.ended).length} · ${filtered.length} 条`}</p>
    {(loadError || workError || failedSources > 0) && <p role="alert" className="bot-activity-error">部分状态暂时无法刷新，已显示内容可能不是最新：{loadError || workError || `${failedSources} 个 Bot 对话读取失败`}。不会把读取失败当作任务完成。</p>}
    {inspected?.sourceRequest ? <div className="bot-activity-list bot-activity-request">
      <button type="button" onClick={() => setInspected(null)}>← 返回任务列表</button>
      <h3>{inspected.owner} · {inspected.label}</h3>
      {inspectError && <p role="alert">{inspectError}</p>}
      <p>{inspected.sourceRequest.archived ? "原对话已归档，以下为该请求的真实消息，不会切换或覆盖当前对话。" : "该请求不在当前消息窗口，以下直接展示原请求与回复。"}</p>
      <h4>你的原始请求</h4><div>{inspected.sourceRequest.prompt?.text || "原请求正文不可用"}</div>
      <h4>回复与进展</h4><div>{inspected.sourceRequest.message.text || inspected.sourceRequest.message.error || inspected.label}</div>
    </div> : <div className="bot-activity-list">
      {!loading && !filtered.length && <p className="bot-activity-empty">{query || kind !== "all" ? "没有匹配的任务或消息。" : "当前没有任务或消息。"}</p>}
      {filtered.slice(0, limit).map(row => <button type="button" className="bot-activity-row" key={row.id} data-activity-id={row.id} title={row.owner + " · " + activityKindLabels[row.kind]} onClick={() => openRow(row)}>
        <strong className="bot-activity-title" title={row.title}>{row.title}</strong>
        <span className={`bot-activity-status${row.running ? " is-running" : ""}`} title={row.label}>{row.label}</span>
      </button>)}
      {filtered.length > limit && <button type="button" className="bot-activity-load" onClick={() => setLimit(value => value + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, filtered.length - limit)} 条（还有 {filtered.length - limit} 条）</button>}
    </div>}
  </dialog>;
}
