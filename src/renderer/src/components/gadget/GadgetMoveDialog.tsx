import { useMemo, useState } from "react";
import type { GadgetListItem, GadgetScope } from "@shared/gadget-types";
import WorkspacePicker from "@/components/chat/WorkspacePicker";
import { useAppStore } from "@/store/appStore";

interface Props {
  gadget: GadgetListItem;
  initialTarget?: "global" | "workspace";
  onClose: () => void;
  onMoved: () => void;
}

export default function GadgetMoveDialog({ gadget, initialTarget, onClose, onMoved }: Props): React.JSX.Element {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = async (): Promise<void> => {
    try {
      if (targetType === "workspace" && !workspaceId) throw new Error("请选择目标工作空间");
      const scope: GadgetScope = targetType === "global"
        ? { type: "global" }
        : { type: "workspace", workspaceId: workspaceId! };
      setBusy(true);
      setError(null);
      const api = window.api?.gadget;
      if (!api) throw new Error("Gadget 能力尚未加载，请重启 MyBuddy");
      await api.moveScope({ gadgetId: gadget.id, scope });
      onMoved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gadget-dialog-overlay" role="dialog" aria-modal="true" aria-label="移动 Gadget">
      <div className="gadget-dialog">
        <header>
          <div><h2>移动 Gadget</h2><p>选择「{gadget.name}」以后长期使用的位置。</p></div>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>关闭</button>
        </header>
        <div className="gadget-move-options">
          <label className={targetType === "global" ? "active" : ""}>
            <input type="radio" name="gadget-target" checked={targetType === "global"} onChange={() => setTargetType("global")} />
            <span><strong>My Gadgets</strong><small>在 MyBuddy 各处重复使用</small></span>
          </label>
          <label className={targetType === "workspace" ? "active" : ""}>
            <input type="radio" name="gadget-target" checked={targetType === "workspace"} onChange={() => setTargetType("workspace")} />
            <span><strong>工作空间</strong><small>作为指定 Workspace 的长期工具</small></span>
          </label>
        </div>
        {targetType === "workspace" && (
          <div className="gadget-workspace-picker">
            <span>目标工作空间</span>
            <WorkspacePicker
              open={pickerOpen}
              onToggle={() => setPickerOpen((value) => !value)}
              onClose={() => setPickerOpen(false)}
              mode="selection"
              selectedSpaceId={workspaceId}
              onSelectSpace={setWorkspaceId}
              allowIndependent={false}
              showCreateActions={false}
            />
          </div>
        )}
        {error && <div className="gadget-error" role="alert">{error}</div>}
        <footer>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn btn--primary" disabled={busy || (targetType === "workspace" && !workspaceId)} onClick={() => void move()}>
            {busy ? "移动中…" : "移动"}
          </button>
        </footer>
      </div>
    </div>
  );
}
