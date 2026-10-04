import { useMemo, useState } from "react";
import WorkspacePicker from "@/components/chat/WorkspacePicker";
import { useAppStore } from "@/store/appStore";

function descendantIds(spaces: ReturnType<typeof useAppStore.getState>["spaces"], rootId: string): string[] {
  const result = [rootId];
  for (let index = 0; index < result.length; index += 1) {
    for (const space of spaces) if ((space.parentId ?? null) === result[index] && !result.includes(space.id)) result.push(space.id);
  }
  return result;
}

export default function MoveWorkspaceDialog({ workspaceId, workspaceName, onClose, onMoved }: { workspaceId: string; workspaceName: string; onClose: () => void; onMoved: () => void }): React.JSX.Element {
  const spaces = useAppStore((state) => state.spaces);
  const current = spaces.find((space) => space.id === workspaceId);
  const [topLevel, setTopLevel] = useState((current?.parentId ?? null) === null);
  const [parentId, setParentId] = useState<string | null>(current?.parentId ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const excluded = useMemo(() => descendantIds(spaces, workspaceId), [spaces, workspaceId]);

  const move = async (): Promise<void> => {
    if (!topLevel && !parentId) { setError("Choose a parent workspace"); return; }
    setBusy(true); setError(null);
    const result = await useAppStore.getState().moveSpace({ spaceId: workspaceId, targetParentId: topLevel ? null : parentId });
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    onMoved();
  };

  return <div className="workspace-create-overlay" role="presentation">
    <section className="workspace-create-dialog" role="dialog" aria-modal="true" aria-label="Move Workspace">
      <header><div><h2>Move Workspace</h2><p>Choose the parent for “{workspaceName}”.</p></div><button className="icon-btn" onClick={onClose}>×</button></header>
      <div className="workspace-create-options">
        <label className={`workspace-create-option ${topLevel ? "selected" : ""}`}><input type="radio" checked={topLevel} onChange={() => setTopLevel(true)} /><span><strong>Top level</strong><small>Keep this workspace at the root of the workspace tree.</small></span></label>
        <label className={`workspace-create-option ${!topLevel ? "selected" : ""}`}><input type="radio" checked={!topLevel} onChange={() => setTopLevel(false)} /><span><strong>Inside a workspace</strong><small>Select a new parent from the existing tree.</small></span></label>
      </div>
      {!topLevel && <div className="gadget-workspace-picker"><span>Parent workspace</span><WorkspacePicker open={pickerOpen} onToggle={() => setPickerOpen((value) => !value)} onClose={() => setPickerOpen(false)} mode="selection" selectedSpaceId={parentId} onSelectSpace={setParentId} allowIndependent={false} showCreateActions={false} excludedSpaceIds={excluded} /></div>}
      {error && <div className="workspace-create-error">{error}</div>}
      <footer><button className="btn" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn--primary" disabled={busy || (!topLevel && !parentId)} onClick={() => void move()}>{busy ? "Moving…" : "Move"}</button></footer>
    </section>
  </div>;
}
