import { useEffect, useMemo, useRef, useState } from "react";
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
  return <><button type="button" className="bot-quiet-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>所有消息</button>
    {open && <ActivityWindow onClose={() => setOpen(false)} onOpenBotMessage={onOpenBotMessage} onOpenWork={onOpenWork} />}</>;
}
export function ActivityWindow({ onClose, onOpenBotMessage, onOpenWork }: { onClose: () => void; onOpenBotMessage: (messageId: string) => void; onOpenWork?: () => void }): React.JSX.Element {
  const tasks = useAppStore(s => s.tasks);
  const works = useAppStore(s => s.botWorks);
  const [monitorWorks, setMonitorWorks] = useState<WorkProjectionDto[]>(works);
  const bots = useAppStore(s => s.botIdentities);
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
  const [includeEnded, setIncludeEnded] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const dialog = useRef<HTMLDialogElement>(null);
  const refreshing = useRef(false);
  const scope = bots.map(bot => bot.userId + ":" + bot.botId).sort().join("|");
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
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
        if (live) setActiveRequests(requests);
        const [workSnapshot] = await Promise.all([window.api!.botWork.listWorks(true),
          ...state.botIdentities.map(bot => state.refreshBotHistory(bot.botId))]);
        if (live) setMonitorWorks(workSnapshot);
        // Keep this all-Work view local: the main page may independently sync
        // an open-only cursor and must not erase closed rows in this reader.
        // Task-scoped API preserves existing access checks. Bound concurrency prevents
        // a large history from flooding IPC; snapshots never open/restart a task.
        const candidates = state.tasks.filter(task => !task.archived && (!scanned.has(task.id) || activeTasks.has(task.id) || task.status === "in_progress" || task.durable?.busy));
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
        if (live) { setSubagents({}); setLoadError(error instanceof Error ? error.message : String(error)); }
      } finally { refreshing.current = false; if (live) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const unsubscribe = window.api?.subagent?.onEvent?.(() => void refresh());
    return () => { live = false; clearInterval(timer); unsubscribe?.(); };
  }, [scope]);
  const rows = useMemo(() => buildActivityRows({ tasks, works: monitorWorks, bots, histories, subagents, now: checkedAt, activeRequests }), [tasks, monitorWorks, bots, histories, subagents, checkedAt, activeRequests]);
  const filtered = rows.filter(row => (includeEnded || !row.ended) && (kind === "all" || row.kind === kind)
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
    void window.api?.botWork.history({ botId: source.message.botId, conversationId: source.message.conversationId, before: source.message.ordinal + 1 }).then(history => {
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
    else if (row.botId) { state.setActiveBotId(row.botId); state.setSelectedWorkId(null); state.setPage("bot"); if (row.messageId) onOpenBotMessage(row.messageId); }
    else if (row.taskId) {
      state.setActiveTask(row.taskId);
      if (row.subagentId) state.openSubagentView(row.taskId, row.subagentId);
    }
    onClose();
  };
  const failedSources = Object.keys(errors).length;
  return <dialog ref={dialog} className="bot-activity-window" aria-label="所有消息与任务进度" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><h2>所有消息与任务</h2><p>查看当前 Bot 对话、普通任务、子代理和 Bot Work 的进度；完整记录可打开来源查看。</p></div>
      <button type="button" aria-label="关闭所有消息" onClick={onClose}><IconX size={20} /></button></header>
    <div className="bot-activity-controls">
      <input autoFocus type="search" aria-label="搜索所有任务与消息" placeholder="搜索问题、任务、Bot 或进展" value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} />
      <select aria-label="任务类型" value={kind} onChange={event => { setKind(event.target.value as ActivityKind | "all"); setLimit(PAGE_SIZE); }}><option value="all">所有类型</option>{Object.entries(activityKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <label><input type="checkbox" checked={includeEnded} onChange={event => { setIncludeEnded(event.target.checked); setLimit(PAGE_SIZE); }} />包含已结束</label>
    </div>
    <p className="bot-activity-summary" role="status">{loading ? "正在核对最新进度…" : `执行中 ${rows.filter(row => row.running).length} · 未结束 ${rows.filter(row => !row.ended).length} · 当前显示 ${filtered.length} 条`}{checkedAt > 0 && <span>更新于 {new Date(checkedAt).toLocaleTimeString("zh-CN", { hour12: false })} · 每 5 秒刷新</span>}</p>
    {(loadError || workError || failedSources > 0) && <p role="alert" className="bot-activity-error">部分状态暂时无法刷新，已显示内容可能不是最新：{loadError || workError || `${failedSources} 个 Bot 对话读取失败`}。不会把读取失败当作任务完成。</p>}
    {inspected?.sourceRequest ? <div className="bot-activity-list bot-activity-request">
      <button type="button" onClick={() => setInspected(null)}>← 返回任务列表</button>
      <h3>{inspected.owner} · {inspected.label}</h3>
      {inspectError && <p role="alert">{inspectError}</p>}
      <p>{inspected.sourceRequest.archived ? "原对话已归档，以下为该请求的真实消息，不会切换或覆盖当前对话。" : "该请求不在当前消息窗口，以下直接展示原请求与回复。"}</p>
      <h4>你的原始请求</h4><div>{inspected.sourceRequest.prompt?.text || "原请求正文不可用"}</div>
      <h4>回复与进展</h4><div>{inspected.sourceRequest.message.text || inspected.sourceRequest.message.error || inspected.label}</div>
    </div> : <div className="bot-activity-list">
      {!loading && !filtered.length && <p className="bot-activity-empty">{query || kind !== "all" ? "没有匹配的任务或消息。" : "当前没有未结束的任务。勾选「包含已结束」查看已有消息与结果。"}</p>}
      {filtered.slice(0, limit).map(row => <button type="button" className="bot-activity-row" key={row.id} data-activity-id={row.id} onClick={() => openRow(row)}>
        <div className="bot-activity-meta"><span>{activityKindLabels[row.kind]} · {row.owner}</span><span className={row.running ? "is-running" : ""}>{row.label}</span></div>
        <strong>{row.title}</strong><p>{row.detail || "尚无新的进展记录，打开来源查看详情。"}</p>
        <small>{new Date(row.updatedAt).toLocaleString("zh-CN", { hour12: false })} · {row.sourceRequest ? "查看原请求" : "打开原对话 / 事项"} →</small>
      </button>)}
      {filtered.length > limit && <button type="button" className="bot-activity-load" onClick={() => setLimit(value => value + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, filtered.length - limit)} 条（还有 {filtered.length - limit} 条）</button>}
    </div>}
  </dialog>;
}
