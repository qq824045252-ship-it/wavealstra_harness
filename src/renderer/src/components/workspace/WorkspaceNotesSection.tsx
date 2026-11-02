import { useEffect, useState } from "react";
import Markdown from "@/components/common/Markdown";
import { WORKSPACE_NOTE_MAX_CHARS, type WorkspaceNoteDto } from "@shared/workspace-notes";
import "./WorkspaceNotesSection.css";

export default function WorkspaceNotesSection({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [note, setNote] = useState<WorkspaceNoteDto | null>(null);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const draftKey = `workspace-note-draft:${workspaceId}`;
  const dirty = note !== null && draft !== note.content;

  useEffect(() => {
    let cancelled = false;
    void window.api!.workspace.notes.read(workspaceId).then(value => {
      if (cancelled) return;
      setNote(value);
      setDraft(sessionStorage.getItem(draftKey) ?? value.content);
    }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [workspaceId, draftKey]);

  async function save(): Promise<void> {
    if (!note || busy) return;
    setBusy(true); setError("");
    try {
      const value = await window.api!.workspace.notes.save({ workspaceId, content: draft, expectedRevision: note.revision });
      setNote(value);
      sessionStorage.removeItem(draftKey);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <section className="workspace-notes" aria-label="空间便签">
    <div className="workspace-notes-heading"><div><h2>空间便签</h2><p>记录手动补充的背景、清单和说明，支持 Markdown。</p></div>
      <button className="btn btn--primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存便签"}</button></div>
    <p className="workspace-notes-hint">已保存内容供本空间及下级空间的任务、子代理读取，下一轮任务或下一次派发时加载；长内容会按上下文预算截断。</p>
    <div className="workspace-notes-toolbar"><button className={`btn ${!preview ? "btn--primary" : ""}`} onClick={() => setPreview(false)}>编辑</button><button className={`btn ${preview ? "btn--primary" : ""}`} onClick={() => setPreview(true)}>预览</button>
      <span role="status">{!note ? "正在加载…" : dirty ? "未保存 · 草稿已保留在当前窗口" : note.updatedAt ? `已保存 · ${new Date(note.updatedAt).toLocaleString()}` : "尚无便签"}</span></div>
    {error && <div className="workspace-memory-error" role="alert">{error}<button className="btn" disabled={busy} onClick={async () => {
      try { setNote(await window.api!.workspace.notes.read(workspaceId)); setError(""); } catch (e) { setError(String(e)); }
    }}>重新加载版本（保留草稿）</button></div>}
    {preview ? <div className="workspace-notes-preview"><Markdown variant="document">{draft || "暂无内容，切换到编辑开始记录。"}</Markdown></div>
      : <textarea aria-label="Markdown 便签内容" disabled={!note || busy} maxLength={WORKSPACE_NOTE_MAX_CHARS} value={draft} placeholder={"# 工作记录\n\n- 待办事项\n- 背景说明\n\n保存后，空间内的任务和子代理即可读取。"} onChange={e => {
        setDraft(e.target.value); sessionStorage.setItem(draftKey, e.target.value);
      }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); void save(); } }} />}
    <div className="workspace-notes-footer"><span>{draft.length} / {WORKSPACE_NOTE_MAX_CHARS} 字符 · Ctrl/Cmd + S 保存</span><button className="btn btn--ghost" disabled={!dirty || busy} onClick={() => { setDraft(note?.content ?? ""); sessionStorage.removeItem(draftKey); }}>撤销未保存修改</button></div>
  </section>;
}
