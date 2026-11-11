import { useEffect, useMemo, useRef, useState } from "react";
import type { GadgetListItem, GadgetScope } from "@shared/gadget-types";
import WorkspacePicker from "@/components/chat/WorkspacePicker";
import { useAppStore } from "@/store/appStore";

interface Props {
  gadget: GadgetListItem;
  mode: "copy" | "move";
  initialTarget?: "global" | "workspace";
  onClose: () => void;
  onMoved: () => void;
}

export default function GadgetMoveDialog({ gadget, mode, initialTarget, onClose, onMoved }: Props): React.JSX.Element {
  const tasks = useAppStore((state) => state.tasks);
  const sourceTaskId = gadget.scope.type === "task" ? gadget.scope.taskId : null;
  const taskWorkspaceId = useMemo(
    () => sourceTaskId ? tasks.find((task) => task.id === sourceTaskId)?.spaceId ?? null : null,
    [sourceTaskId, tasks],
  );
  const [targetType, setTargetType] = useState<"global" | "workspace">(
    initialTarget ?? (gadget.scope.type === "global" ? "global" : "workspace"),
  );
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    gadget.scope.type === "workspace" ? gadget.scope.workspaceId : taskWorkspaceId,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    try {
      if (targetType === "workspace" && !workspaceId) throw new Error("请选择目标工作空间");
      const scope: GadgetScope = targetType === "global"
        ? { type: "global" }
        : { type: "workspace", workspaceId: workspaceId! };
      setBusy(true);
      setError(null);
      const api = window.api?.gadget;
      if (!api) throw new Error("Gadget 能力尚未加载，请重启 MyBuddy");
      await api[mode === "copy" ? "copyScope" : "moveScope"]({ gadgetId: gadget.id, scope });
      if (mounted.current) onMoved();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="gadget-dialog-overlay" role="dialog" aria-modal="true" aria-label={mode === "copy" ? "保存 Gadget 副本" : "移动 Gadget"}>
      <div className="gadget-dialog">
        <header>
          <div><h2>{mode === "copy" ? "保存 Gadget 副本" : "移动 Gadget"}</h2><p>{mode === "copy" ? `为「${gadget.name}」保存独立副本，原工具保留且不会自动同步。` : `移动「${gadget.name}」会改变原工具的位置，不保留副本。`}</p></div>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>关闭</button>
        </header>
        <div className="gadget-move-options">
          <label className={targetType === "global" ? "active" : ""}>
            <input type="radio" name="gadget-target" disabled={busy} checked={targetType === "global"} onChange={() => setTargetType("global")} />
            <span><strong>我的工作台</strong><small>在 MyBuddy 各处重复使用</small></span>
          </label>
          <label className={targetType === "workspace" ? "active" : ""}>
            <input type="radio" name="gadget-target" disabled={busy} checked={targetType === "workspace"} onChange={() => setTargetType("workspace")} />
            <span><strong>工作空间</strong><small>作为指定 Workspace 的长期工具</small></span>
          </label>
        </div>
        {targetType === "workspace" && (
          <div className="gadget-workspace-picker">
            <span>目标工作空间</span>
            <WorkspacePicker
              open={pickerOpen}
              onToggle={() => { if (!pending.current) setPickerOpen((value) => !value); }}
              onClose={() => setPickerOpen(false)}
              mode="selection"
              selectedSpaceId={workspaceId}
              onSelectSpace={(id) => { if (!pending.current) setWorkspaceId(id); }}
              allowIndependent={false}
              showCreateActions={false}
            />
          </div>
        )}
        {mode === "copy" && <p>副本保存在软件内的工作空间或我的工作台，可直接打开使用。</p>}
        {error && <div className="gadget-error" role="alert">{error}</div>}
        <footer>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn btn--primary" disabled={busy || (targetType === "workspace" && !workspaceId)} onClick={() => void move()}>
            {mode === "copy" ? (busy ? "保存中…" : "保存副本") : (busy ? "移动中…" : "移动")}
          </button>
        </footer>
      </div>
    </div>
  );
}
