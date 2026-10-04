import { useEffect, useRef, useState } from "react";
import type { MemoryRecordDto, MemoryTurnDto, MemoryTurnExtractionState, MemoryTurnTaskDto } from "@shared/memory-kernel";
import ConfirmDialog from "@/components/common/ConfirmDialog";

const STATE_LABEL: Record<MemoryTurnExtractionState, string> = {
  pending: "待提炼", processing: "提炼中", completed: "已提炼", failed: "失败", skipped: "已跳过",
};
function fmt(ts?: number): string {
  return ts ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ts) : "—";
}
const title = (turn: MemoryTurnDto): string => (turn.taskTitle || "原任务已删除") + (turn.taskTrashed ? "（回收区）" : "");

export default function MemoryL0Explorer({ focusTurnId, refreshVersion = 0, busy = false, onDeleteTurns, onOpenMemory }: {
  focusTurnId?: string | null;
  refreshVersion?: number;
  busy?: boolean;
  onDeleteTurns: (ids: string[]) => Promise<boolean>;
  onOpenMemory: (id: string) => void;
}): React.JSX.Element {
  const [turns, setTurns] = useState<MemoryTurnDto[]>([]);
  const [tasks, setTasks] = useState<MemoryTurnTaskDto[]>([]);
  const [query, setQuery] = useState("");
  const [taskId, setTaskId] = useState("");
  const [state, setState] = useState<"" | MemoryTurnExtractionState>("");
  const [selectedId, setSelectedId] = useState<string | null>(focusTurnId ?? null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const deletingRef = useRef(false);
  const [detail, setDetail] = useState<MemoryTurnDto | null>(null);
  const [derived, setDerived] = useState<MemoryRecordDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");

  useEffect(() => { if (focusTurnId) setSelectedId(focusTurnId); }, [focusTurnId]);
  useEffect(() => {
    const api = window.api?.memory;
    if (!api) return;
    let cancelled = false;
    void api.turnTasks().then((items) => {
      if (cancelled) return;
      setTasks(items);
      setTaskId((id) => !id || items.some((item) => item.id === id) ? id : "");
    })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [refreshVersion]);

  // Parent owns refresh notifications; filters and refresh share one cancellable request.
  useEffect(() => {
    const api = window.api?.memory;
    if (!api) { setLoading(false); setError("记忆服务暂不可用。"); return; }
    let cancelled = false;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api.turns({ query: query.trim() || undefined, taskId: taskId || undefined, extractionState: state || undefined, limit: 500 })
        .then((items) => {
          if (cancelled) return;
          setTurns(items);
          setCheckedIds((ids) => new Set(items.filter((item) => ids.has(item.id)).map((item) => item.id)));
          setSelectedId((id) => id === focusTurnId || items.some((item) => item.id === id) ? id : null);
        })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, query ? 220 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, taskId, state, refreshVersion, focusTurnId]);

  useEffect(() => {
    const api = window.api?.memory;
    let cancelled = false;
    setDetail(null);
    setDerived([]);
    setDetailError("");
    if (!selectedId || !api) { setDetailLoading(false); return; }
    setDetailLoading(true);
    void Promise.all([api.getTurn(selectedId), api.memoriesForTurn(selectedId)])
      .then(([turn, memories]) => {
        if (cancelled) return;
        setDetail(turn ?? null);
        setDerived(memories);
        if (!turn) setDetailError("这条对话来源已删除；关联记忆中的证据摘录仍可用于核对。");
      })
      .catch((e) => { if (!cancelled) setDetailError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, refreshVersion]);
  const selected = detail?.id === selectedId ? detail : null;
  const allChecked = turns.length > 0 && checkedIds.size === turns.length;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = checkedIds.size > 0 && !allChecked;
  }, [checkedIds, allChecked]);

  const clearChecked = (): void => { setCheckedIds(new Set()); setPendingDeleteIds(null); };
  const deleteChecked = async (): Promise<void> => {
    if (!pendingDeleteIds?.length || busy || deletingRef.current) return;
    const ids = pendingDeleteIds;
    deletingRef.current = true;
    setPendingDeleteIds(null);
    try {
      if (await onDeleteTurns(ids)) {
        setCheckedIds((current) => new Set([...current].filter((id) => !ids.includes(id))));
        setTurns((current) => current.filter((turn) => !ids.includes(turn.id)));
        setSelectedId((id) => id && ids.includes(id) ? null : id);
      }
    } finally {
      deletingRef.current = false;
    }
  };

  return <div className="memory-l0">
    <p className="settings-row-desc">这里保留记忆开启时捕获的对话来源。每轮成功结束后会自动提炼；已提炼不代表一定产生长期记忆。回收区任务仅供查看，不会补提炼。</p>
    <div className="memory-filters">
      <input className="new-project-input" aria-label="搜索对话原文" value={query} placeholder="搜索用户或助手原文" disabled={busy} onChange={(e) => { clearChecked(); setQuery(e.target.value); }} />
      <select className="new-project-input" aria-label="筛选来源任务" value={taskId} disabled={busy} onChange={(e) => { clearChecked(); setTaskId(e.target.value); }}>
        <option value="">全部任务</option>
        {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}{task.trashed ? "（回收区）" : ""}</option>)}
      </select>
      <select className="new-project-input" aria-label="筛选提炼状态" value={state} disabled={busy} onChange={(e) => { clearChecked(); setState(e.target.value as typeof state); }}>
        <option value="">全部状态</option>
        {Object.entries(STATE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
    {error && <div className="memory-status" role="alert">{error}</div>}
    <div className="memory-toolbar memory-turn-selection">
      <label className="memory-select-all">
        <input ref={selectAllRef} type="checkbox" checked={allChecked} disabled={busy || loading || !turns.length} onChange={(e) => setCheckedIds(e.target.checked ? new Set(turns.map((turn) => turn.id)) : new Set())} />
        全选当前列表
      </label>
      <span className="settings-row-desc" aria-live="polite">已选 {checkedIds.size} 条</span>
      <div className="memory-toolbar-actions">
        {checkedIds.size > 0 && <button type="button" className="btn" disabled={busy || loading} onClick={clearChecked}>清空选择</button>}
        <button type="button" className="btn danger" disabled={busy || loading || !checkedIds.size} onClick={() => setPendingDeleteIds([...checkedIds])}>删除选中（{checkedIds.size}）</button>
      </div>
    </div>
    <div className="memory-split">
      <div className="memory-turn-list" aria-label="对话来源列表" aria-busy={loading}>
        {loading ? <div className="memory-empty">正在加载对话…</div> : turns.length === 0 ? <div className="memory-empty">没有符合筛选条件的对话。</div> : turns.map((turn) => <div
          key={turn.id} className={"memory-turn-row" + (selectedId === turn.id ? " active" : "")}>
          <label className="memory-turn-select">
            <input type="checkbox" aria-label={`选择对话来源：${turn.userText.trim().slice(0, 60) || title(turn)}（${fmt(turn.capturedAt)}）`} checked={checkedIds.has(turn.id)} disabled={busy} onChange={(e) => {
              const checked = e.target.checked;
              setCheckedIds((current) => { const next = new Set(current); if (checked) next.add(turn.id); else next.delete(turn.id); return next; });
            }} />
          </label>
          <button type="button" className="memory-turn-open" aria-pressed={selectedId === turn.id} onClick={() => setSelectedId(turn.id)}>
            <span className="memory-turn-heading"><strong>{turn.userText.replace(/\s+/g, " ").trim() || "（无用户原文）"}</strong><span className="memory-source">{STATE_LABEL[turn.extractionState]}</span></span>
            <span className="settings-row-desc memory-turn-title" title={title(turn)}>{title(turn)}</span>
            <span className="settings-row-desc">{fmt(turn.capturedAt)} · 尝试 {turn.attemptCount} 次</span>
          </button>
        </div>)}
        {!loading && turns.length >= 500 && <p className="settings-row-desc">当前显示前 500 条，可用搜索或任务筛选查看更早的记录。</p>}
      </div>
      <div className="memory-turn-detail" aria-busy={detailLoading}>
        {detailError ? <div role="alert">{detailError}</div> : detailLoading ? <div className="memory-empty">正在读取原文和关联记忆…</div> : !selected ? <div className="memory-empty">选择左侧对话，查看原文及其产生的记忆。</div> : <>
          <div className="memory-toolbar"><strong>{title(selected)}</strong><span className="memory-source">{STATE_LABEL[selected.extractionState]}</span></div>
          <div className="settings-row-desc">{fmt(selected.capturedAt)} · 尝试 {selected.attemptCount} 次 · 提炼完成 {fmt(selected.extractedAt)}</div>
          {selected.lastError && <p className="memory-status" role="alert">{selected.lastError}</p>}
          <h4>用户原文</h4><div className="memory-original">{selected.userText || "（空）"}</div>
          <h4>助手原文</h4><div className="memory-original">{selected.assistantText || "（空）"}</div>
          <h4>关联记忆 · {derived.length}</h4>
          {derived.length === 0 ? <p className="settings-row-desc">暂无关联记忆。已提炼的对话可能没有需要长期保存的内容，或相关记忆已被删除。</p>
            : derived.map((memory) => <button key={memory.id} type="button" className="btn memory-source-link" onClick={() => onOpenMemory(memory.id)}>{memory.title}</button>)}
        </>}
      </div>
    </div>
    <ConfirmDialog
      open={pendingDeleteIds !== null}
      title={`删除选中的 ${pendingDeleteIds?.length ?? 0} 条对话来源？`}
      body={<>将永久删除这 {pendingDeleteIds?.length ?? 0} 条来源原文，此操作不可恢复。未勾选的来源、任务聊天记录、已生成的记忆及其证据摘录、技能和审核快照仍保留。<br />包含这些来源的提炼结果会被丢弃，未删除的来源会继续处理。</>}
      confirmLabel="确认删除选中来源"
      danger
      onCancel={() => setPendingDeleteIds(null)}
      onConfirm={() => void deleteChecked()}
    />
  </div>;
}
