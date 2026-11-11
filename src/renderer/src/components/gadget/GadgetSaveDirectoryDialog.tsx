import { useEffect, useMemo, useRef, useState } from "react";
import type { GadgetListItem } from "@shared/gadget-types";
import type { GadgetSaveToTaskDirectoryResult } from "@shared/gadget-ipc";
import { useAppStore } from "@/store/appStore";

interface Props {
  gadget: GadgetListItem;
  onClose(): void;
  onSaved(result: GadgetSaveToTaskDirectoryResult, taskId: string, taskTitle: string): void;
}

/** Global/workspace toolboxes have no implicit destination: choose a visible task explicitly. */
export default function GadgetSaveDirectoryDialog({ gadget, onClose, onSaved }: Props): React.JSX.Element {
  const tasks = useAppStore(state => state.tasks);
  const spaces = useAppStore(state => state.spaces);
  const activeTaskId = useAppStore(state => state.activeTaskId);
  const targets = useMemo(() => tasks.filter(task => {
    if (task.archived) return false;
    if (gadget.scope.type === "global") return true;
    if (gadget.scope.type === "task") return gadget.scope.taskId === task.id;
    let workspaceId = task.spaceId;
    const seen = new Set<string>();
    while (workspaceId && !seen.has(workspaceId)) {
      seen.add(workspaceId);
      const space = spaces.find(item => item.id === workspaceId);
      if (space?.effectiveArchived || space?.archived) return false;
      if (workspaceId === gadget.scope.workspaceId) return true;
      workspaceId = space?.parentId ?? undefined;
    }
    return false;
  }), [tasks, spaces, gadget.scope]);
  const [taskId, setTaskId] = useState(() => targets.some(task => task.id === activeTaskId) ? activeTaskId! : "");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = targets.find(task => task.id === taskId);
  const save = async (): Promise<void> => {
    if (!selected || pending.current) return;
    pending.current = true;
    try {
      setBusy(true);
      setError(null);
      if (!window.api?.gadget) throw new Error("Gadget 能力尚未加载，请重启 MyBuddy");
      const result = await window.api.gadget.saveToTaskDirectory({ gadgetId: gadget.id, taskId: selected.id });
      if (mounted.current) onSaved(result, selected.id, selected.title);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return (
    <div className="gadget-dialog-overlay" role="dialog" aria-modal="true" aria-label="保存到任务工作目录">
      <div className="gadget-dialog">
        <header><div><h2>保存到任务工作目录</h2><p>选择「{gadget.name}」源码副本的目标任务。</p></div>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>关闭</button></header>
        <label className="gadget-save-task-field">目标任务
          <select aria-label="目标任务" value={selected ? taskId : ""} disabled={busy} onChange={event => setTaskId(event.target.value)}>
            <option value="">请选择任务</option>
            {targets.map(task => <option key={task.id} value={task.id}>{task.title || "未命名任务"} · {spaces.find(space => space.id === task.spaceId)?.name ?? "独立任务"}{task.id === activeTaskId ? "（当前任务）" : ""}</option>)}
          </select>
        </label>
        {!targets.length && <p>还没有可保存的任务。请先创建任务，再回来保存。</p>}
        <p>原 Gadget 保持原位置。副本保存到所选任务工作目录下的 gadgets 文件夹，不自动同步，再次保存也不会覆盖已有文件。</p>
        {error && <div className="gadget-error" role="alert">{error}</div>}
        <footer><button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn btn--primary" disabled={busy || !selected} onClick={() => void save()}>{busy ? "保存中…" : "保存副本"}</button></footer>
      </div>
    </div>
  );
}
