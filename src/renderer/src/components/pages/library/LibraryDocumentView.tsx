import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LIBRARY_TITLE_MAX_CHARS, type LibraryItemDto } from "@shared/library-ipc";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { IconChevronLeft, IconFolderOpen, IconTrash } from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";
import type { LibraryUnsavedGuard } from "@/lib/scopedLibrary";
import type { ScopedLibraryOperations } from "@/lib/scopedLibraryOperations";
import { useLibraryDocumentEditor } from "./useLibraryDocumentEditor";
import { parseLibraryCsv, serializeLibraryCsv } from "@/lib/libraryCsv";
import ScopedLibraryMarkdown from "./ScopedLibraryMarkdown";

interface Props {
  itemId: string;
  access: ScopedLibraryOperations;
  onBack: () => void;
  onRenamed: (item: LibraryItemDto) => void;
  onDeleted: () => void;
  onToast: (text: string) => void;
  onOpenItem: (id: string) => void;
  onRegisterUnsaved?: (guard: LibraryUnsavedGuard | null) => void;
  actions?: ReactNode;
}

const KIND_LABEL: Record<string, string> = {
  markdown: "文档", html: "页面", csv: "表格", url: "链接", office: "办公文档",
  pdf: "PDF", image: "图片", file: "文件",
};

export default function LibraryDocumentView({
  itemId, access, onBack, onRenamed, onDeleted, onToast, onOpenItem, onRegisterUnsaved, actions,
}: Props): React.JSX.Element {
  const editor = useLibraryDocumentEditor({ itemId, access, onSaved: onRenamed, onRegisterUnsaved });
  const { payload, title, draft, dirty, saving, save, discard, setTitle, setDraft } = editor;
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [attachedTaskId, setAttachedTaskId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeTaskId = useAppStore((state) => state.activeTaskId);
  const readOnly = access.readOnly;

  useEffect(() => {
    if (!payload) return;
    const seed = !payload.content.trim() || payload.content.trim() === `# ${payload.item.title}`;
    setMode(!readOnly && (seed || dirty) ? "edit" : "preview");
    // Choose the initial mode once; saving metadata must not switch a user's editor view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.item.id, readOnly]);

  useEffect(() => {
    let cancelled = false;
    setAttachedTaskId(null);
    if (!activeTaskId || readOnly) return;
    void window.api?.library.listTaskReferences(activeTaskId).then((result) => {
      if (!cancelled && result.ok) setAttachedTaskId(result.value.items.some((row) => row.id === itemId) ? activeTaskId : null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [itemId, activeTaskId, readOnly]);

  const csvRows = useMemo(() => payload?.item.kind === "csv" ? parseLibraryCsv(draft) : [], [payload?.item.kind, draft]);
  const report = (error: unknown): void => onToast(error instanceof Error ? error.message : "操作失败");
  const remove = async (): Promise<void> => {
    if (busy || readOnly) return;
    setBusy(true);
    try { await access.deleteItem(itemId); discard(); onDeleted(); }
    catch (error) { report(error); }
    finally { setBusy(false); setPendingDelete(false); }
  };
  const attach = async (): Promise<void> => {
    if (busy || readOnly || !activeTaskId) return;
    setBusy(true);
    try {
      await access.attach(itemId, attachedTaskId ?? activeTaskId, Boolean(attachedTaskId));
      setAttachedTaskId(attachedTaskId ? null : activeTaskId);
      onToast(attachedTaskId ? "已从任务移除引用，原资料保留" : "已附加到当前任务");
    } catch (error) { report(error); }
    finally { setBusy(false); }
  };

  if (editor.loadError) return <div className="library-doc"><button className="btn" onClick={onBack}>返回文档列表</button><div className="library-empty" role="alert">{editor.loadError}</div></div>;
  if (!payload) return <div className="library-empty" role="status">正在打开…</div>;
  const kind = payload.item.kind;
  const kindLabel = KIND_LABEL[kind] ?? kind;

  return <div className="library-doc">
    <header className="library-doc-bar">
      <div className="library-doc-bar-left">
        <button type="button" className="btn library-doc-back" onClick={onBack}><IconChevronLeft size={15} />返回文档列表</button>
        <div className="library-doc-identity">
          <input className="library-doc-title" maxLength={LIBRARY_TITLE_MAX_CHARS} value={title}
            readOnly={readOnly} disabled={saving} placeholder="文档标题" aria-label="文档标题"
            onChange={(event) => setTitle(event.target.value)} />
          <div className="library-doc-meta"><span>{kindLabel}</span><span className="library-doc-dot" aria-hidden />
            <span className={dirty ? "is-dirty" : ""}>{readOnly ? "只读资料" : saving ? "保存中…" : dirty ? editor.draftSaved ? "未保存 · 草稿已保留" : "未保存" : "已保存"}</span>
          </div>
        </div>
      </div>
      <div className="library-doc-bar-right">
        {!readOnly && (kind === "markdown" || kind === "html") && <div className="library-seg" role="tablist" aria-label="预览或编辑">
          <button type="button" className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>预览</button>
          <button type="button" className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>编辑</button>
        </div>}
        {!readOnly && <button type="button" className="btn" disabled={saving || !dirty || busy} onClick={() => void save().catch(report)}>{saving ? "保存中" : "保存"}</button>}
        {kind !== "url" && <button type="button" className="btn" title="在文件管理器中显示"
          onClick={() => void access.showInFolder(itemId).catch(report)}><IconFolderOpen size={14} />打开位置</button>}
        {!readOnly && <>
          {actions}
          <button type="button" className="btn" disabled={!activeTaskId || busy} title={activeTaskId ? "引用到当前任务" : "请先打开一个任务"}
            onClick={() => void attach()}>{attachedTaskId ? "解除附加" : "附加到任务"}</button>
          <button type="button" className="icon-btn library-doc-delete" title="删除资料" aria-label="删除资料"
            disabled={busy || saving} onClick={() => setPendingDelete(true)}><IconTrash size={15} /></button>
        </>}
      </div>
    </header>
    {editor.notice && <div className="scoped-library-notice" role="status">{editor.notice}</div>}
    {kind === "html" && mode === "preview" && dirty && <div className="scoped-library-notice">预览显示已保存的版本，保存后将更新。</div>}
    <div className={`library-doc-body${!readOnly && mode === "edit" && (kind === "markdown" || kind === "html") ? " is-editing" : ""}`}>
      {payload.requiresFileAccess ? <div className="library-empty">
        <strong>{kindLabel}</strong><p className="library-url-line">{payload.managedPath ?? "（无受管路径）"}</p>
        <p className="library-save-hint">{payload.item.sizeBytes} 字节。此文件需要对应应用查看，可通过「打开位置」访问。</p>
      </div> : kind === "url" && payload.item.url ? <div className="library-empty">
        <strong>链接资料</strong><p className="library-url-line">{payload.item.url}</p>
        <button type="button" className="btn" onClick={() => { if (/^https?:\/\//i.test(payload.item.url!)) void window.api?.browser.openExternal(payload.item.url); }}>在浏览器打开</button>
      </div> : kind === "markdown" && (readOnly || mode === "preview") ? <div className="library-md-preview">
        <ScopedLibraryMarkdown content={draft} itemId={itemId} access={access} onOpenItem={onOpenItem} onError={onToast} />
      </div>
      : kind === "html" && (readOnly || mode === "preview") && payload.previewUrl
        ? <iframe key={`${itemId}:${payload.item.updatedAt}`} className="library-html-frame" title={payload.item.title}
            src={`${payload.previewUrl}?version=${payload.item.updatedAt}`} sandbox="allow-scripts allow-same-origin" />
      : kind === "csv" ? <div className="library-csv"><table><tbody>
        {csvRows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} className={ri === 0 ? "is-head" : undefined}>
          <input value={cell} readOnly={readOnly} disabled={saving} aria-label={`第 ${ri + 1} 行第 ${ci + 1} 列`}
            onChange={(event) => setDraft(serializeLibraryCsv(csvRows.map((values, r) => values.map((value, c) => r === ri && c === ci ? event.target.value : value))))} />
        </td>)}</tr>)}
      </tbody></table>{!readOnly && <div className="library-csv-actions">
        <button type="button" className="btn" disabled={saving} onClick={() => setDraft(serializeLibraryCsv([...csvRows, Array.from({ length: Math.max(...csvRows.map((row) => row.length), 1) }, () => "")]))}>添加行</button>
        <button type="button" className="btn" disabled={saving} onClick={() => setDraft(serializeLibraryCsv(csvRows.length ? csvRows.map((row) => [...row, ""]) : [["", ""]]))}>添加列</button>
      </div>}</div>
      : kind === "markdown" || kind === "html" ? <textarea value={draft} aria-label="文档正文" readOnly={readOnly} disabled={saving}
        onChange={(event) => setDraft(event.target.value)} spellCheck={false} placeholder={kind === "markdown" ? "用 Markdown 写正文…" : "写入 HTML…"} />
      : <pre className="scoped-library-text">{draft || "此类型请通过「打开位置」查看。"}</pre>}
    </div>
    <ConfirmDialog open={pendingDelete} title="删除这份资料？" body="这会删除原资料，引用它的项目、工作区和任务将无法再使用它。" confirmLabel="删除" danger
      onCancel={() => !busy && setPendingDelete(false)} onConfirm={() => void remove()} />
  </div>;
}
