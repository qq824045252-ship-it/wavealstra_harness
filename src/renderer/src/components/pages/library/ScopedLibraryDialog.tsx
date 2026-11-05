import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  LIBRARY_NAME_MAX_CHARS, LIBRARY_TITLE_MAX_CHARS, type LibraryArtifactDto,
  type LibraryCreateItemRequest, type LibraryListRowDto, type LibrarySnapshotDto,
} from "@shared/library-ipc";
import { IconX } from "@/components/common/icons";
import { libraryFolderPath, libraryMoveTargets, type LibraryLocation } from "@/lib/scopedLibrary";

export type ScopedLibraryCompose =
  | { type: "item"; location: LibraryLocation; kind: LibraryCreateItemRequest["kind"]; title: string }
  | { type: "folder"; location: LibraryLocation; title: string }
  | { type: "url"; location: LibraryLocation; title: string; url: string }
  | { type: "artifact"; location: LibraryLocation; artifactId: string; artifacts: LibraryArtifactDto[] }
  | { type: "rename"; row: LibraryListRowDto; title: string }
  | { type: "move"; row: LibraryListRowDto; collectionId: string | null };

interface Props {
  value: ScopedLibraryCompose;
  snapshot: LibrarySnapshotDto;
  unlimitedItemTitle: boolean;
  busy: boolean;
  onChange: (value: ScopedLibraryCompose) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

const TITLES = { item: "新建资料", folder: "新建文件夹", url: "添加链接", artifact: "从任务成果保存", rename: "重命名", move: "移动资料" };

export default function ScopedLibraryDialog({ value, snapshot, unlimitedItemTitle, busy, onChange, onCancel, onSubmit }: Props): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  const disabled = busy || ("title" in value && value.type !== "url" && !value.title.trim())
    || (value.type === "url" && !value.url.trim()) || (value.type === "artifact" && !value.artifactId);
  return createPortal(<div className="modal-overlay" onClick={() => !busy && onCancel()}>
    <form className="new-project-modal library-compose-modal" role="dialog" aria-modal="true" aria-label={TITLES[value.type]}
      onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); if (!disabled) onSubmit(); }}>
      <div className="new-project-modal-head"><h3 className="new-project-modal-title">{TITLES[value.type]}</h3>
        <button type="button" className="icon-btn" disabled={busy} aria-label="关闭" onClick={onCancel}><IconX size={16} /></button>
      </div>
      <div className="new-project-modal-body">
        {value.type === "item" && <div className="new-project-field"><span className="new-project-label">类型</span><div className="library-kind-picks">
          {([{ kind: "markdown", label: "文档", hint: "Markdown" }, { kind: "csv", label: "表格", hint: "CSV" }, { kind: "html", label: "页面", hint: "HTML" }] as const).map((option) =>
            <button type="button" key={option.kind} disabled={busy} className={`library-kind-pick${value.kind === option.kind ? " active" : ""}`}
              onClick={() => onChange({ ...value, kind: option.kind })}><strong>{option.label}</strong><span>{option.hint}</span></button>)}
        </div></div>}
        {value.type === "url" && <label className="new-project-field"><span className="new-project-label">网址</span>
          <input className="new-project-input" aria-label="资料网址" type="url" autoFocus disabled={busy} value={value.url}
            onChange={(event) => onChange({ ...value, url: event.target.value })} placeholder="https://" />
        </label>}
        {"title" in value && <label className="new-project-field"><span className="new-project-label">名称{value.type === "url" ? "（可选）" : ""}</span>
          <input className="new-project-input" aria-label="资料名称" autoFocus={value.type !== "url"} disabled={busy} value={value.title}
            maxLength={value.type === "folder" || (value.type === "rename" && value.row.kind === "folder") ? LIBRARY_NAME_MAX_CHARS : unlimitedItemTitle ? undefined : LIBRARY_TITLE_MAX_CHARS}
            onChange={(event) => onChange({ ...value, title: event.target.value })} placeholder={value.type === "folder" ? "文件夹名称" : "资料名称"} />
        </label>}
        {value.type === "move" && <>
          <p className="library-compose-note">{value.row.title}</p>
          <label className="new-project-field"><span className="new-project-label">移动到</span>
            <select className="new-project-input" aria-label="目标文件夹" autoFocus disabled={busy} value={value.collectionId ?? ""}
              onChange={(event) => onChange({ ...value, collectionId: event.target.value || null })}>
              <option value="">{snapshot.spaces.find((space) => space.id === value.row.spaceId)?.name ?? "当前资料位置"} / 根目录</option>
              {libraryMoveTargets(snapshot, value.row).map((folder) => <option key={folder.id} value={folder.id}>{libraryFolderPath(snapshot, folder.id)}</option>)}
            </select>
          </label>
        </>}
        {value.type === "artifact" && <>
          <label className="new-project-field"><span className="new-project-label">任务成果</span>
            <select className="new-project-input" aria-label="选择任务成果" autoFocus disabled={busy} value={value.artifactId}
              onChange={(event) => onChange({ ...value, artifactId: event.target.value })}>
              <option value="">选择当前范围的任务成果</option>
              {value.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title || "未命名成果"}</option>)}
            </select>
          </label>
          {!value.artifacts.length && <p className="library-compose-note">这里还没有可保存的任务成果。</p>}
        </>}
      </div>
      <div className="new-project-modal-foot"><span className="new-project-foot-hint">
        {value.type === "artifact" ? "保存资料副本，原任务成果保留。" : value.type === "url" ? "只保存链接，不抓取网页正文。" : value.type === "move" ? "在当前资料位置内整理，不复制文件。" : ""}
      </span><div className="new-project-foot-actions">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>取消</button>
        <button type="submit" className="btn primary" disabled={disabled}>{busy ? "处理中…" : value.type === "move" ? "移动" : value.type === "rename" ? "重命名" : value.type === "artifact" ? "保存" : "创建"}</button>
      </div></div>
    </form>
  </div>, document.body);
}
