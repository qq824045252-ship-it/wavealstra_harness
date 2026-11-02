import { useEffect, useState } from "react";
import type { GadgetListItem, GadgetSourceSnapshot } from "@shared/gadget-types";

export default function GadgetSourceDialog({ gadget, onClose }: { gadget: GadgetListItem; onClose(): void }): React.JSX.Element {
  const [source, setSource] = useState<GadgetSourceSnapshot | null>(null);
  const [path, setPath] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    const api = window.api?.gadget;
    if (!api) { setError("Gadget 能力尚未加载，请重启 MyBuddy"); return; }
    void api.readSource(gadget.id).then((snapshot) => {
      if (!active) return;
      setSource(snapshot);
      setPath(snapshot.manifest.entry);
    }).catch((cause) => { if (active) setError(String(cause instanceof Error ? cause.message : cause)); });
    return () => { active = false; };
  }, [gadget.id]);
  const files = source?.files.filter((file) => file.encoding !== "base64") ?? [];
  const selected = files.find((file) => file.path === path);
  const changes = files.filter((file) => drafts[file.path] !== undefined && drafts[file.path] !== file.content)
    .map((file) => ({ ...file, content: drafts[file.path] }));
  const save = async (): Promise<void> => {
    if (!source || !changes.length) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const api = window.api?.gadget;
      if (!api) throw new Error("Gadget 能力尚未加载，请重启 MyBuddy");
      const next = await api.updateSource({ gadgetId: gadget.id, expectedRevision: source.revision, files: changes });
      setSource(next); setDrafts({}); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="gadget-dialog-overlay">
    <section className="gadget-dialog" role="dialog" aria-modal="true" aria-label={`编辑源码：${gadget.name}`}>
      <header><div><h2>编辑源码：{gadget.name}</h2><p>{gadget.scope.type === "task" ? "保存后更新当前工具。" : "这是共享工具，保存后对所有使用它的任务生效。"}</p></div></header>
      <div className="gadget-create-form">
        <label className="gadget-create-field"><span>文件</span><select aria-label="源码文件" value={path} disabled={busy || !source} onChange={(event) => setPath(event.target.value)}>
          {files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
        </select></label>
        <label className="gadget-create-field"><span>源码</span><textarea aria-label="Gadget 源码" rows={18} spellCheck={false} disabled={busy || !selected}
          value={selected ? drafts[path] ?? selected.content : ""} onChange={(event) => { setDrafts({ ...drafts, [path]: event.target.value }); setSaved(false); }} /></label>
      </div>
      {!source && !error && <p>正在读取源码…</p>}
      {error && <div className="gadget-error" role="alert">{error}</div>}
      {saved && <div className="gadget-notice" role="status">已保存，打开的工具已刷新。</div>}
      <footer><button className="btn" disabled={busy} onClick={onClose}>{changes.length ? "放弃修改并关闭" : "关闭"}</button>
        <button className="btn btn--primary" disabled={busy || !changes.length} onClick={() => void save()}>{busy ? "保存中…" : "保存修改"}</button></footer>
    </section>
  </div>;
}
