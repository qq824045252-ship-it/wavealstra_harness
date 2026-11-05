import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LibraryItemDto, LibraryListRowDto, LibraryOwnerScope, LibrarySnapshotDto } from "@shared/library-ipc";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { IconChevronRight, IconSearch } from "@/components/common/icons";
import { collectDroppedLocalFiles, dataTransferHasFiles } from "@/lib/projectWorkspace";
import {
  defaultLibraryLocation, isLibraryTaskOwnedBy, libraryFolderRow, libraryItemRow, libraryOwnerKey,
  requireLibraryDestination,
  type LibraryLocation, type LibraryReferenceScope, type LibraryUnsavedGuard,
} from "@/lib/scopedLibrary";
import { ScopedLibraryOperations } from "@/lib/scopedLibraryOperations";
import UnsavedChangesDialog from "../project/UnsavedChangesDialog";
import LibraryDocumentView from "./LibraryDocumentView";
import ScopedLibraryDialog, { type ScopedLibraryCompose } from "./ScopedLibraryDialog";
import ScopedLibraryRows from "./ScopedLibraryRows";
import "@/styles/library.css";

export interface ScopedLibraryManagerProps {
  scope: LibraryOwnerScope;
  name?: string;
  readOnly?: boolean;
  initialSpaceId?: string;
  initialCollectionId?: string | null;
  initialItemId?: string;
  reference?: LibraryReferenceScope;
  onChanged?: () => void;
  searchQuery?: string;
  onSnapshot?: (snapshot: LibrarySnapshotDto) => void;
  renderItemActions?: (item: LibraryItemDto) => ReactNode;
  onRegisterUnsaved?: (guard: LibraryUnsavedGuard | null) => void;
  /** An explicit request from a project pin, with a new token for repeated openings. */
  itemRequest?: { itemId: string; token: number };
}

export function ScopedLibraryManager(props: ScopedLibraryManagerProps): React.JSX.Element {
  const identity = `${libraryOwnerKey(props.scope)}:${props.reference?.spaceId ?? ""}:${props.reference?.collectionId ?? ""}:${props.reference?.itemId ?? ""}`;
  // A new owner never renders metadata or an editor left over from the previous owner.
  return <ScopedLibraryManagerBody key={identity} {...props} />;
}
export default ScopedLibraryManager;

function ScopedLibraryManagerBody(props: ScopedLibraryManagerProps): React.JSX.Element {
  const { scope, name, reference, initialSpaceId, initialCollectionId, initialItemId } = props;
  const ownerKey = libraryOwnerKey(scope);
  const access = useMemo(() => new ScopedLibraryOperations(() => {
    if (!window.api?.library) throw new Error("资料服务不可用，请重试");
    return window.api.library;
  }, scope, reference, props.readOnly, async () => {
    if (!window.api?.db) throw new Error("任务服务不可用，请重试");
    const tasks = await window.api.db.listTasks();
    return new Set(tasks.filter((task) => isLibraryTaskOwnedBy(task, scope)).map((task) => task.id));
  }),
  // Scope/reference identity is stable even when callers create fresh prop objects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [ownerKey, reference?.spaceId, reference?.collectionId, reference?.itemId, props.readOnly]);
  const [loadedSnapshot, setSnapshot] = useState<LibrarySnapshotDto | null>(null);
  const [location, setLocation] = useState<LibraryLocation>({ spaceId: null, collectionId: null });
  const [itemId, setItemId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{
    query: string; rows: LibraryListRowDto[]; status: "loading" | "ready" | "failed";
    source: LibrarySnapshotDto | null; snapshot: LibrarySnapshotDto | null;
  }>({ query: "", rows: [], status: "ready", source: null, snapshot: null });
  // A completed search supplies the current metadata, including newly found files.
  // Only an explicit reload changes loadedSnapshot, so accepting results cannot
  // trigger another search. Clearing the query keeps the refreshed browsing data.
  const snapshot = hits.source === loadedSnapshot ? hits.snapshot ?? loadedSnapshot : loadedSnapshot;
  const [typeFilter, setTypeFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [compose, setCompose] = useState<ScopedLibraryCompose | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LibraryListRowDto | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [guardBusy, setGuardBusy] = useState(false);
  const mounted = useRef(true);
  const loadSequence = useRef(0);
  const initialized = useRef(false);
  const operation = useRef(false);
  const editorGuard = useRef<LibraryUnsavedGuard | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const effectiveQuery = (props.searchQuery ?? query).trim();
  const readOnly = access.readOnly;
  const report = (error: unknown): void => { if (mounted.current) setNotice({ text: error instanceof Error ? error.message : "操作失败", error: true }); };

  const reload = useCallback(async (): Promise<void> => {
    const ticket = ++loadSequence.current;
    setLoading(true);
    try {
      const next = await access.snapshot();
      if (!mounted.current || ticket !== loadSequence.current) return;
      setSnapshot(next);
      if (!initialized.current) {
        initialized.current = true;
        let target = defaultLibraryLocation(next, reference);
        if (initialSpaceId || initialCollectionId) {
          const requested = { spaceId: initialSpaceId ?? target.spaceId, collectionId: initialCollectionId ?? target.collectionId };
          try { requireLibraryDestination(next, requested); target = requested; }
          catch (error) { report(error); }
        }
        if (initialItemId) {
          const item = next.items.find((entry) => entry.id === initialItemId);
          if (item) { setItemId(item.id); target = { spaceId: item.spaceId, collectionId: item.collectionId ?? null }; }
          else report(new Error("资料不存在，或已不属于当前资料范围"));
        }
        setLocation(target);
      } else {
        setLocation((current) => {
          try { requireLibraryDestination(next, current); return current; }
          catch { return defaultLibraryLocation(next, reference); }
        });
        setItemId((current) => current && next.items.some((item) => item.id === current) ? current : null);
      }
      callbacks.current.onSnapshot?.(next);
    } catch (error) { if (mounted.current && ticket === loadSequence.current) report(error); }
    finally { if (mounted.current && ticket === loadSequence.current) setLoading(false); }
  // Initial navigation is consumed once for each mounted owner/reference view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; loadSequence.current += 1; callbacks.current.onRegisterUnsaved?.(null); };
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    if (!effectiveQuery) { setHits((current) => ({ ...current, query: "", rows: [], status: "ready" })); return; }
    setHits((current) => ({ ...current, query: effectiveQuery, rows: [], status: "loading" }));
    if (!loadedSnapshot) return;
    const timeout = window.setTimeout(() => {
      void access.search(effectiveQuery).then(({ snapshot: next, rows }) => {
        if (cancelled) return;
        setHits({ query: effectiveQuery, rows, status: "ready", source: loadedSnapshot, snapshot: next });
        setLocation((current) => {
          try { requireLibraryDestination(next, current); return current; }
          catch { return defaultLibraryLocation(next, reference); }
        });
        setItemId((current) => current && next.items.some((item) => item.id === current) ? current : null);
        callbacks.current.onSnapshot?.(next);
      }, (error: unknown) => {
        if (cancelled) return;
        setHits((current) => ({ query: effectiveQuery, rows: [], status: "failed", source: loadedSnapshot,
          snapshot: current.source === loadedSnapshot ? current.snapshot : loadedSnapshot }));
        report(error);
      });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  // The reference identity is part of access and the keyed manager lifecycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access, effectiveQuery, loadedSnapshot]);

  const registerEditor = useCallback((guard: LibraryUnsavedGuard | null): void => {
    editorGuard.current = guard;
    callbacks.current.onRegisterUnsaved?.(guard);
  }, []);
  const navigate = useCallback((action: () => void): void => {
    if (editorGuard.current?.dirty) setPendingNavigation(() => action);
    else action();
  }, []);
  const handledRequest = useRef("");
  useEffect(() => {
    const request = props.itemRequest;
    if (!request || !snapshot) return;
    const key = `${request.itemId}:${request.token}`;
    if (handledRequest.current === key) return;
    handledRequest.current = key;
    const item = snapshot.items.find((entry) => entry.id === request.itemId);
    if (!item) { report(new Error("这份常用资料不属于当前项目资料，请从其所属位置阅读")); return; }
    navigate(() => { setLocation({ spaceId: item.spaceId, collectionId: item.collectionId ?? null }); setItemId(item.id); });
  }, [props.itemRequest, snapshot, navigate]);

  const run = async (work: () => Promise<void>, mutation = true): Promise<void> => {
    if (operation.current || (mutation && readOnly)) return;
    operation.current = true; setBusy(true); setNotice(null);
    try {
      await work();
      if (!mounted.current) return;
      if (mutation) { await reload(); callbacks.current.onChanged?.(); }
    } catch (error) { report(error); if (mutation && mounted.current) await reload(); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  const changed = (): void => { void reload(); callbacks.current.onChanged?.(); };
  const open = (row: LibraryListRowDto): void => navigate(() => {
    setLocation({ spaceId: row.spaceId ?? null, collectionId: row.kind === "folder" ? row.id : row.collectionId ?? null });
    setItemId(row.kind === "folder" ? null : row.id);
    if (row.kind === "folder" && props.searchQuery === undefined) setQuery("");
  });
  const importFiles = (target: LibraryLocation, paths?: string[]): void => {
    void run(async () => {
      const imported = await access.importFiles(target, paths);
      if (imported[0]) setLocation({ spaceId: imported[0].spaceId, collectionId: imported[0].collectionId ?? null });
      setNotice({ text: imported.length ? `已导入 ${imported.length} 个文档` : "已取消导入" });
    });
  };
  const drop = (event: React.DragEvent<HTMLElement>, target: LibraryLocation): void => {
    event.preventDefault(); event.stopPropagation(); setDragging(false);
    if (readOnly || busy) return;
    const files = collectDroppedLocalFiles(event.dataTransfer.files, (file) => window.api?.getPathForFile?.(file as File) ?? "");
    if (!files.length) { report(new Error("无法读取文件路径，请使用「导入文档」")); return; }
    importFiles(target, files.map((file) => file.path));
  };
  const submit = (): void => {
    if (!compose) return;
    const current = compose;
    void run(async () => {
      if (current.type === "item" || current.type === "url" || current.type === "artifact") {
        const item = current.type === "item" ? await access.createItem(current.location, current.kind, current.title.trim())
          : current.type === "url" ? await access.createUrl(current.location, current.url.trim(), current.title)
            : await access.saveArtifact(current.location, current.artifactId);
        setLocation({ spaceId: item.spaceId, collectionId: item.collectionId ?? null }); setItemId(item.id);
      } else if (current.type === "folder") {
        const folder = await access.createFolder(current.location, current.title.trim());
        setLocation({ spaceId: folder.spaceId, collectionId: folder.id });
      } else if (current.type === "rename") {
        if (current.row.kind === "folder") await access.renameFolder(current.row.id, current.title.trim());
        else await access.renameItem(current.row.id, current.title.trim());
      } else await access.move(current.row, current.collectionId);
      setCompose(null); setNotice({ text: current.type === "artifact" ? "已保存为资料，原任务成果保留" : "已保存" });
    });
  };

  const space = snapshot?.spaces.find((entry) => entry.id === location.spaceId);
  const rootCollectionId = reference?.collectionId ?? null;
  const breadcrumbs: Array<{ id: string | null; name: string }> = [];
  let folder = snapshot?.collections.find((entry) => entry.id === location.collectionId);
  const seen = new Set<string>();
  while (folder && folder.id !== rootCollectionId && !seen.has(folder.id)) {
    seen.add(folder.id); breadcrumbs.unshift({ id: folder.id, name: folder.name });
    folder = snapshot?.collections.find((entry) => entry.id === folder?.parentId);
  }
  breadcrumbs.unshift({ id: rootCollectionId, name: (rootCollectionId ? snapshot?.collections.find((entry) => entry.id === rootCollectionId)?.name : space?.name) ?? name ?? "资料" });
  const searching = Boolean(effectiveQuery && (hits.query !== effectiveQuery || hits.source !== loadedSnapshot || hits.status === "loading"));
  const searchFailed = Boolean(effectiveQuery && !searching && hits.status === "failed");
  const rows = !snapshot ? [] : effectiveQuery ? searching || searchFailed ? [] : hits.rows
    : [...snapshot.collections.filter((entry) => entry.spaceId === location.spaceId && (entry.parentId ?? null) === location.collectionId).map((entry) => libraryFolderRow(snapshot, entry)),
      ...snapshot.items.filter((entry) => entry.spaceId === location.spaceId && (Boolean(reference?.itemId) || (entry.collectionId ?? null) === location.collectionId)).map((entry) => libraryItemRow(snapshot, entry))];
  const visible = rows.filter((row) => typeFilter === "all" || row.kind === "folder" || (typeFilter === "other"
    ? !["markdown", "csv", "html", "office"].includes(row.kind) : row.kind === typeFilter));
  const currentItem = snapshot?.items.find((item) => item.id === itemId);
  const emptyName = scope.type === "project" ? "项目资料" : "资料";

  return <section className={`scoped-library-manager${readOnly ? " is-readonly" : ""}${dragging ? " drag-over" : ""}`} aria-label={name ?? "资料管理"}
    onDragOver={!readOnly && !itemId ? (event) => { if (dataTransferHasFiles(event.dataTransfer.types)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); } } : undefined}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
    onDrop={!readOnly && !itemId ? (event) => drop(event, location) : undefined}>
    <div className="scoped-library-heading"><div><h3>{name ?? "资料"} <span>{snapshot?.items.length ?? "…"}</span></h3>
      <p>{reference ? "引用资料 · 在所属位置维护原文档" : readOnly ? "已归档，只能阅读资料" : "在此管理长期资料，任务按需检索和读取。"}</p></div>
      <button type="button" className="btn" disabled={loading || busy} onClick={() => { setNotice(null); void reload(); }}>刷新</button>
    </div>
    {notice && <div className={`scoped-library-notice${notice.error ? " is-error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.text}</div>}
    {loading && !snapshot ? <div className="library-empty">正在加载资料…</div> : !snapshot ? <div className="library-empty">资料暂时不可用，请刷新重试。</div>
      : itemId && currentItem ? <LibraryDocumentView key={itemId} itemId={itemId} access={access} onBack={() => navigate(() => setItemId(null))}
        onRenamed={changed} onDeleted={() => { setItemId(null); setNotice({ text: "已删除原资料" }); changed(); }}
        onOpenItem={(nextId) => { void access.snapshot().then((next) => { if (!mounted.current) return; const item = next.items.find((entry) => entry.id === nextId); if (!item) throw new Error("链接目标已不属于当前资料范围"); setSnapshot(next); open(libraryItemRow(next, item)); }).catch(report); }}
        onToast={(text) => setNotice({ text })} onRegisterUnsaved={registerEditor} actions={props.renderItemActions?.(currentItem)} />
      : <>
        <div className="scoped-library-controls">
          {snapshot.spaces.length > 1 && !reference && <label className="scoped-library-location">资料位置
            <select aria-label="资料位置" value={location.spaceId ?? ""} disabled={busy} onChange={(event) => setLocation({ spaceId: event.target.value, collectionId: null })}>
              {snapshot.spaces.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{scope.type === "personal" && entry.kind === "team" ? "（历史资料）" : ""}</option>)}
            </select></label>}
          {props.searchQuery === undefined && <label className="scoped-library-search"><IconSearch size={14} /><input aria-label="搜索当前资料" placeholder="搜索当前资料" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
          <select className="scoped-library-type" aria-label="资料类型" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            {[['all', '全部类型'], ['markdown', '文档'], ['csv', '表格'], ['html', '页面'], ['office', '办公'], ['other', '其他']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <nav className="scoped-library-breadcrumbs" aria-label="当前资料位置">{breadcrumbs.map((crumb, index) => <span key={crumb.id ?? "root"}>
          {index > 0 && <IconChevronRight size={12} />}<button type="button" disabled={busy} onClick={() => { setLocation({ spaceId: location.spaceId, collectionId: crumb.id }); if (props.searchQuery === undefined) setQuery(""); }}>{crumb.name}</button>
        </span>)}</nav>
        {!readOnly && <div className="library-toolbar-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => setCompose({ type: "item", location, kind: "markdown", title: "" })}>新建资料</button>
          <button type="button" className="btn" disabled={busy} onClick={() => importFiles(location)}>导入文档</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setCompose({ type: "folder", location, title: "" })}>新建文件夹</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setCompose({ type: "url", location, title: "", url: "https://" })}>添加链接</button>
          <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => setCompose({ type: "artifact", location, artifactId: "", artifacts: await access.artifacts() }), false)}>从任务成果保存</button>
        </div>}
        {searching ? <div className="library-empty" role="status">正在搜索资料…</div>
          : searchFailed ? <div className="library-empty">搜索失败，请刷新后重试。</div>
          : !visible.length ? <div className="library-empty"><strong>{effectiveQuery ? `没有匹配的${emptyName}` : rows.length ? "没有此类型的资料" : `还没有${emptyName}`}</strong>
          {!readOnly && !effectiveQuery && <span>新建资料、导入文档，或把文件拖到这里。</span>}
        </div> : <ScopedLibraryRows rows={visible} busy={busy} readOnly={readOnly} onOpen={open} onDrop={drop}
          onRename={(row) => setCompose({ type: "rename", row, title: row.title })}
          onMove={(row) => setCompose({ type: "move", row, collectionId: row.kind === "folder" ? row.parentId ?? null : row.collectionId ?? null })}
          onDelete={setPendingDelete} onFavorite={(row) => void run(async () => { await access.favorite(row.id, !row.favorite); })} />}
      </>}
    {dragging && <div className="library-drop-overlay" aria-hidden>松开以导入到当前位置</div>}
    {compose && snapshot && !readOnly && <ScopedLibraryDialog value={compose} snapshot={snapshot} unlimitedItemTitle={access.scope.type === "project"} busy={busy} onChange={setCompose} onCancel={() => setCompose(null)} onSubmit={submit} />}
    <ConfirmDialog open={Boolean(pendingDelete) && !readOnly} title={pendingDelete?.kind === "folder" ? `删除文件夹「${pendingDelete.title}」及全部内容？` : `删除资料「${pendingDelete?.title ?? ""}」？`}
      body="这会删除原资料，使用它的引用也将失效。取消引用请在引用位置操作。" confirmLabel="删除" danger onCancel={() => !busy && setPendingDelete(null)}
      onConfirm={() => { if (pendingDelete) void run(async () => { if (pendingDelete.kind === "folder") await access.deleteFolder(pendingDelete.id); else await access.deleteItem(pendingDelete.id); setPendingDelete(null); setNotice({ text: "已删除原资料" }); }); }} />
    <UnsavedChangesDialog open={Boolean(pendingNavigation)} busy={guardBusy} onCancel={() => setPendingNavigation(null)}
      onDiscard={() => { editorGuard.current?.discard(); const next = pendingNavigation; setPendingNavigation(null); next?.(); }}
      onSave={() => { setGuardBusy(true); void (async () => { try { await editorGuard.current?.save(); const next = pendingNavigation; setPendingNavigation(null); next?.(); } catch (error) { report(error); } finally { setGuardBusy(false); } })(); }} />
  </section>;
}
