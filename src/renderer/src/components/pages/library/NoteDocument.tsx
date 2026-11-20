import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { LIBRARY_TITLE_MAX_CHARS, type LibraryItemDto, type LibraryVersionDto } from "@shared/library-ipc";
import type { LibraryUnsavedGuard } from "@/lib/scopedLibrary";
import type { ScopedLibraryOperations } from "@/lib/scopedLibraryOperations";
import { useLibraryDocumentEditor } from "./useLibraryDocumentEditor";
import NoteEditor from "./NoteEditor";
import NotesMenu from "./NotesMenu";
import ScopedLibraryMarkdown from "./ScopedLibraryMarkdown";
import OfficeDocumentView from "@/components/artifact/OfficeDocumentView";
import { isOfficeUseFile } from "@/lib/officeUseFile";

const PdfPreview = lazy(() => import("@/components/artifact/PdfViewer"));

interface Props {
  item: LibraryItemDto;
  initialVersion?: number;
  access: ScopedLibraryOperations;
  actions?: ReactNode;
  onSaved: (item: LibraryItemDto) => void;
  onOpenItem: (id: string, version?: number) => void;
  onError: (error: unknown) => void;
  onRegisterUnsaved: (guard: LibraryUnsavedGuard | null) => void;
}

export default function NoteDocument(props: Props): React.JSX.Element {
  const { item, initialVersion, access, onSaved, onError, onOpenItem, onRegisterUnsaved } = props;
  const editor = useLibraryDocumentEditor({ itemId: item.id, access, onSaved, onRegisterUnsaved, autoSave: true });
  const [versions, setVersions] = useState<LibraryVersionDto[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(initialVersion !== undefined);
  const [selectedVersion, setSelectedVersion] = useState(initialVersion);
  const [historyText, setHistoryText] = useState<{ version: number; content: string }>();
  const [historyError, setHistoryError] = useState("");
  const [comparison, setComparison] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);

  useEffect(() => {
    if (!historyOpen) return;
    let active = true;
    void access.note({ type: "versions", id: item.id }).then((versions) => {
      if (!active) return;
      setVersions(versions);
      setSelectedVersion((version) => version ?? versions[0]?.version);
    }, (error: unknown) => { if (active) setHistoryError(message(error)); });
    return () => { active = false; };
  }, [access, historyOpen, item.id, item.contentHash]);

  useEffect(() => {
    if (!historyOpen || selectedVersion === undefined) return;
    let active = true;
    setHistoryText(undefined); setHistoryError("");
    void access.note({ type: "readVersion", id: item.id, version: selectedVersion }).then((content) => {
      if (active) setHistoryText({ version: selectedVersion, content });
    }, (error: unknown) => { if (active) setHistoryError(message(error)); });
    return () => { active = false; };
  }, [access, historyOpen, item.id, selectedVersion]);

  const exportNote = async (format: "markdown" | "html" | "pdf"): Promise<void> => {
    setExporting(true);
    try {
      if (editor.dirty) await editor.save();
      const html = format === "markdown" ? undefined : renderToStaticMarkup(<>
        <h1>{editor.title}</h1>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { output: "mathml" }]]}
          urlTransform={(url) => url.startsWith("mybuddy-library://local/") ? url : defaultUrlTransform(url)}>
          {editor.draft}
        </ReactMarkdown>
      </>);
      await access.note({ type: "export", ids: [item.id], format, html });
    } catch (error) { onError(error); }
    finally { setExporting(false); }
  };

  const restore = async (): Promise<void> => {
    if (!historyText || !editor.payload || restoreBusy) return;
    setRestoreBusy(true);
    try {
      if (editor.dirty) await editor.save();
      // Restore through the same autosave path so undoable history, optimistic concurrency and indexing agree.
      editor.setDraft(historyText.content);
      setHistoryOpen(false);
      await editor.save();
    } catch (error) { onError(error); }
    finally { setRestoreBusy(false); }
  };

  if (editor.loadError) return <div className="note-status" role="alert">{editor.loadError}</div>;
  if (!editor.payload) return <div className="note-status" role="status">正在打开笔记…</div>;
  const status = access.readOnly ? "只读" : editor.saving ? "保存中…" : editor.dirty
    ? editor.draftSaved ? "草稿已保留" : "等待保存" : "已保存";
  return <article className="note-document">
    <header className="note-document-header">
      <input aria-label="文档标题" value={editor.title} readOnly={access.readOnly} placeholder="笔记标题"
        maxLength={access.scope.type === "project" ? undefined : LIBRARY_TITLE_MAX_CHARS} onChange={(event) => editor.setTitle(event.target.value)} />
      <div className="note-document-actions">
        <span className="note-save-status" role="status">{status}</span>
        {!access.readOnly && <button type="button" title="Ctrl+S" disabled={!editor.dirty || editor.saving}
          onClick={() => void editor.save().catch(onError)}>{editor.savePaused ? "重试保存" : "保存"}</button>}
        <button type="button" onClick={() => setHistoryOpen((open) => !open)}>版本历史</button>
        <NotesMenu label="导出">
          {(["markdown", "html", "pdf"] as const).map((format) => <button key={format} disabled={exporting} type="button"
            onClick={() => void exportNote(format)}>{format === "markdown" ? "Markdown" : format.toUpperCase()}</button>)}
        </NotesMenu>
        {props.actions}
      </div>
    </header>
    {editor.notice && editor.notice !== "已保存" && <div className="note-status" role={editor.savePaused ? "alert" : "status"}>{editor.notice}</div>}
    {item.clipSource && <div className="note-source">
      <button type="button" title={item.clipSource.url}
        onClick={() => void access.note({ type: "openLink", url: item.clipSource!.url }).catch(onError)}>{item.clipSource.title} ↗</button>
      <time dateTime={new Date(item.clipSource.capturedAt).toISOString()}>{new Date(item.clipSource.capturedAt).toLocaleString()}</time>
      {Boolean(item.clipSource.failedImages?.length) && <span>{item.clipSource.failedImages!.length} 张图片未保存到本地</span>}
    </div>}
    {historyOpen ? <div className="note-history">
      <div className="note-history-bar">
        <label>版本 <select aria-label="历史版本" value={selectedVersion ?? ""} onChange={(event) => setSelectedVersion(Number(event.target.value))}>
          <option value="" disabled>选择版本</option>
          {selectedVersion !== undefined && !versions?.some((entry) => entry.version === selectedVersion) &&
            <option value={selectedVersion}>版本 {selectedVersion}</option>}
          {versions?.map((entry) => <option key={entry.id} value={entry.version}>{entry.version} · {new Date(entry.createdAt).toLocaleString()}</option>)}
        </select></label>
        <button aria-pressed={comparison} type="button" onClick={() => setComparison((value) => !value)}>与当前比较</button>
        <button type="button" disabled={!historyText} onClick={() =>
          void navigator.clipboard.writeText("mybuddy-library://local/" + item.id + "/?rev=" + selectedVersion).catch(onError)}>复制版本链接</button>
        {!access.readOnly && <button type="button" disabled={!historyText || restoreBusy}
          onClick={() => void restore()}>恢复此版本</button>}
        <button type="button" onClick={() => setHistoryOpen(false)}>返回笔记</button>
      </div>
      {historyError ? <div className="note-status" role="alert">{historyError}</div>
        : historyText?.version === selectedVersion && historyText ? comparison
          ? <VersionComparison oldText={historyText.content} currentText={editor.draft} />
          : <ScopedLibraryMarkdown content={historyText.content} itemId={item.id} access={access}
            onOpenItem={onOpenItem} onError={onError} notes revision={selectedVersion} />
          : <div className="note-status">{versions?.length === 0 ? "已有修改在保存后会显示为版本。" : "正在读取历史版本…"}</div>}
    </div> : <NoteEditor itemId={item.id} access={access} content={editor.draft} onChange={editor.setDraft}
      onOpenItem={onOpenItem} onError={onError} />}
  </article>;
}

function VersionComparison({ oldText, currentText }: { oldText: string; currentText: string }): React.JSX.Element {
  const before = oldText.split("\n"), after = currentText.split("\n");
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return <div className="note-diff">{[{ label: "历史正文", lines: before }, { label: "当前正文", lines: after }].map(({ label, lines }) =>
    <section key={label}><h4>{label}</h4><pre>{lines.map((line, index) => index >= prefix && index < lines.length - suffix
      ? <mark key={index}>{line + "\n"}</mark> : line + "\n")}</pre></section>)}</div>;
}

export function NoteAttachmentPreview({ item, access }: { item: LibraryItemDto; access: ScopedLibraryOperations }): React.JSX.Element {
  const pdf = /\.pdf$/i.test(item.filename);
  const source = useMemo(() => ({ type: "library" as const, id: item.id, readOnly: access.readOnly,
    owner: access.scope, reference: access.reference }), [access, item.id]);
  const [data, setData] = useState<{ content?: string; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (pdf) void access.note({ type: "attachment", id: item.id })
      .then((content) => { if (active) setData({ content }); }, (error: unknown) => { if (active) setData({ error: message(error) }); });
    return () => { active = false; };
  }, [pdf, access, item.id]);
  if (item.kind === "image") return <img className="note-attachment-image" alt={item.title}
    src={"mybuddy-library://local/" + encodeURIComponent(item.id) + "/"} />;
  if (isOfficeUseFile(item.filename)) return <OfficeDocumentView source={source} name={item.filename} />;
  if (!pdf) return <p>请从「打开位置」查看此文件。</p>;
  if (data?.error) return <p role="alert">{data.error}</p>;
  if (!data?.content) return <p role="status">正在打开附件…</p>;
  return <Suspense fallback={<p>正在加载预览…</p>}><PdfPreview content={data.content} name={item.filename} /></Suspense>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
