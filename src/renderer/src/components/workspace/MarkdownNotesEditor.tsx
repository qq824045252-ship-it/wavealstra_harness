import { useEffect, useState } from "react";
import Markdown from "@/components/common/Markdown";
import "./WorkspaceNotesSection.css";

interface Note { content: string; revision: number; updatedAt: number }
interface Props {
  draftKey: string;
  title: string;
  hint: string;
  maxChars: number;
  read: () => Promise<Note>;
  saveNote: (content: string, expectedRevision: number) => Promise<Note>;
  readOnly?: boolean;
}

export default function MarkdownNotesEditor({ draftKey, title, hint, maxChars, read, saveNote, readOnly = false }: Props): React.JSX.Element {
  const [note, setNote] = useState<Note | null>(null);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [baseRevision, setBaseRevision] = useState(0);
  const [mergeContent, setMergeContent] = useState<string | null>(null);
  const dirty = note !== null && draft !== note.content;

  useEffect(() => {
    let cancelled = false;
    void read().then(value => {
      if (cancelled) return;
      setNote(value);
      const raw = sessionStorage.getItem(draftKey);
      let restored: { content: string; revision: number } | null = null;
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed.content === "string" && Number.isSafeInteger(parsed.revision)) restored = parsed;
        } catch { /* Old plain-text drafts require an explicit reload before saving. */ }
        restored ??= { content: raw, revision: -1 };
      }
      setDraft(restored?.content ?? value.content);
      setBaseRevision(restored?.revision ?? value.revision);
      if (restored && restored.revision !== value.revision) {
        setError("已保存版本发生变化，请重新加载版本并合并草稿后保存");
        setMergeContent(value.content);
      }
    }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [read, draftKey]);

  async function save(): Promise<void> {
    if (!note || busy || readOnly) return;
    setBusy(true); setError("");
    try {
      const value = await saveNote(draft, baseRevision);
      setNote(value);
      setBaseRevision(value.revision);
      setMergeContent(null);
      sessionStorage.removeItem(draftKey);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <section className="workspace-notes" aria-label={title}>
    <div className="workspace-notes-heading"><div><h2>{title}</h2><p>记录手动补充的背景、清单和说明，支持 Markdown。</p></div>
      <button className="btn btn--primary" disabled={!dirty || busy || readOnly} onClick={() => void save()}>{busy ? "保存中…" : "保存便签"}</button></div>
    <p className="workspace-notes-hint">{readOnly ? "已归档项目的便签仅供查看。" : hint}</p>
    <div className="workspace-notes-toolbar"><button className={`btn ${!preview ? "btn--primary" : ""}`} onClick={() => setPreview(false)}>编辑</button><button className={`btn ${preview ? "btn--primary" : ""}`} onClick={() => setPreview(true)}>预览</button>
      <span role="status">{!note ? "正在加载…" : dirty ? "未保存 · 草稿已保留在当前窗口" : note.updatedAt ? `已保存 · ${new Date(note.updatedAt).toLocaleString()}` : "尚无便签"}</span></div>
    {error && <div className="workspace-memory-error" role="alert">{error}<button className="btn" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const value = await read();
        setNote(value); setBaseRevision(value.revision); setMergeContent(value.content); setError("");
        if (!note) { setDraft(value.content); sessionStorage.removeItem(draftKey); }
        else sessionStorage.setItem(draftKey, JSON.stringify({ content: draft, revision: value.revision }));
      } catch (e) { setError(String(e)); }
      finally { setBusy(false); }
    }}>重新加载版本（保留草稿）</button></div>}
    {mergeContent !== null && <details open><summary>最新已保存内容（供合并参考，编辑区保留你的草稿）</summary><div className="workspace-notes-preview"><Markdown variant="document">{mergeContent || "（空便签）"}</Markdown></div></details>}
    {preview ? <div className="workspace-notes-preview"><Markdown variant="document">{draft || "暂无内容，切换到编辑开始记录。"}</Markdown></div>
      : <textarea aria-label="Markdown 便签内容" disabled={!note || busy || readOnly} maxLength={maxChars} value={draft} placeholder={"# 工作记录\n\n- 待办事项\n- 背景说明\n\n保存后，所属任务即可读取。"} onChange={e => {
        setDraft(e.target.value); sessionStorage.setItem(draftKey, JSON.stringify({ content: e.target.value, revision: baseRevision }));
      }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); void save(); } }} />}
    <div className="workspace-notes-footer"><span>{draft.length} / {maxChars} 字符 · Ctrl/Cmd + S 保存</span><button className="btn btn--ghost" disabled={!dirty || busy || readOnly} onClick={() => { setDraft(note?.content ?? ""); setBaseRevision(note?.revision ?? 0); setMergeContent(null); setError(""); sessionStorage.removeItem(draftKey); }}>撤销未保存修改</button></div>
  </section>;
}
