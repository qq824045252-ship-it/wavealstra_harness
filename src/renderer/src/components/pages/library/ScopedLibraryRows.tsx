import type { LibraryListRowDto } from "@shared/library-ipc";
import { LIBRARY_KIND_LABEL } from "@shared/library-ipc";
import { FileBadge } from "@/components/common/FileBadge";
import { IconFolder } from "@/components/common/icons";
import type { LibraryLocation } from "@/lib/scopedLibrary";

interface Props {
  rows: LibraryListRowDto[];
  busy: boolean;
  readOnly: boolean;
  onOpen: (row: LibraryListRowDto) => void;
  onRename: (row: LibraryListRowDto) => void;
  onMove: (row: LibraryListRowDto) => void;
  onDelete: (row: LibraryListRowDto) => void;
  onFavorite: (row: LibraryListRowDto) => void;
  onDrop: (event: React.DragEvent<HTMLElement>, location: LibraryLocation) => void;
}

export default function ScopedLibraryRows({ rows, busy, readOnly, onOpen, onRename, onMove, onDelete, onFavorite, onDrop }: Props): React.JSX.Element {
  return <div className="scoped-library-table" role="table" aria-label="资料列表">
    <div className="scoped-library-row scoped-library-row--head" role="row"><span>名称</span><span>类型</span><span>更新</span><span>操作</span></div>
    {rows.map((row) => <div className="scoped-library-row" role="row" key={row.id}
      onDragOver={row.kind === "folder" && !readOnly ? (event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; } : undefined}
      onDrop={row.kind === "folder" && !readOnly ? (event) => onDrop(event, { spaceId: row.spaceId ?? null, collectionId: row.id }) : undefined}>
      <div className="scoped-library-name" role="cell">
        {row.kind === "folder" ? <IconFolder size={17} /> : <FileBadge name={row.filename ?? row.title} size={18} />}
        <div><button type="button" disabled={busy} onClick={() => onOpen(row)} title={row.title}>{row.title}{row.favorite ? " ★" : ""}</button>
          <small title={row.location}>{row.location}</small></div>
      </div>
      <span role="cell" className="scoped-library-kind">{LIBRARY_KIND_LABEL[row.kind] ?? row.kind}</span>
      <span role="cell" className="scoped-library-date">{Number.isFinite(row.updatedAt) ? new Date(row.updatedAt).toLocaleDateString("zh-CN") : "—"}</span>
      <div role="cell" className="scoped-library-actions"><button type="button" className="btn btn--ghost" disabled={busy} onClick={() => onOpen(row)}>{row.kind === "folder" ? "打开" : "查看"}</button>
        {!readOnly && <details className="scoped-library-row-menu"><summary aria-label={`更多操作：${row.title}`}>更多</summary><div className="library-menu">
          <button type="button" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onRename(row); }}>重命名</button>
          <button type="button" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onMove(row); }}>移动</button>
          {row.kind !== "folder" && <button type="button" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onFavorite(row); }}>{row.favorite ? "取消收藏" : "收藏"}</button>}
          <button type="button" className="is-danger" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onDelete(row); }}>删除原资料</button>
        </div></details>}
      </div>
    </div>)}
  </div>;
}
