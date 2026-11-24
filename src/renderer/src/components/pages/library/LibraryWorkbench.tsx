import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { LibraryCollectionDto, LibraryItemDto, LibrarySnapshotDto } from "@shared/library-ipc";
import { hiddenLibraryCollectionIds, isVisibleLibraryFile } from "@shared/library-visibility";
import { isLibraryTaskOwnedBy, defaultLibraryLocation, libraryCollectionSubtree, libraryFolderRow, libraryItemRow,
  libraryMoveTargets, libraryOwnerKey, requireLibraryDestination,
  type LibraryLocation, type LibraryUnsavedGuard } from "@/lib/scopedLibrary";
import { ScopedLibraryOperations } from "@/lib/scopedLibraryOperations";
import { useAppStore } from "@/store/appStore";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { DesktopSectionRow, DesktopSectionSidebar, useDesktopLeaveGuard, useDesktopSectionState } from "@/components/desktop/DesktopSection";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { IconChevronLeft, IconChevronRight, IconFile, IconFolder, IconPlus, IconSearch, IconTrash } from "@/components/common/icons";
import NoteDocument, { NoteAttachmentPreview } from "./NoteDocument";
import NotesMenu, { closeNotesMenu } from "./NotesMenu";
import LibraryDocumentView from "./LibraryDocumentView";
import LargeLibraryFileView from "./LargeLibraryFileView";
import { LIBRARY_INLINE_FILE_MAX_BYTES } from "@shared/library-ipc";
import { isOfficeUseFile } from "@/lib/officeUseFile";
import ScopedLibraryDialog, { type ScopedLibraryCompose } from "./ScopedLibraryDialog";
import type { ScopedLibraryManagerProps } from "./ScopedLibraryManager";
import "./notes-workbench.css";
import { MaterialDeepSearch, MaterialRetrievalRow } from "./MaterialRetrievalControls";

type View = "all" | "folder" | "favorites" | "trash" | "tag";
type Sort = "updated" | "created" | "title";
type NotesLayout = "two-column" | "three-column";
type Selection = { id: string; version?: number };
interface NotesBrowseState {
  location: LibraryLocation;
  selected: Selection | null;
  view: View;
  tag: string;
  query: string;
  sort: Sort;
  closedFolders: Set<string>;
}

const dragNotes = "application/x-mybuddy-library-items";
const dragFolder = "application/x-mybuddy-library-folder";
const listScrollByScope = new Map<string, number>();
const desktopLayoutKey = "notes-desktop-layout";

export default function LibraryWorkbench(props: ScopedLibraryManagerProps): React.JSX.Element {
  const { scope, reference, readOnly, initialItemId, initialCollectionId, initialSpaceId } = props;
  const desktop = Boolean(props.desktop);
  const scopeKey = libraryOwnerKey(scope);
  const scopeIdentity = scopeKey + ":" + (reference?.spaceId ?? "") + ":" + (reference?.collectionId ?? "") + ":" + (reference?.itemId ?? "");
  const access = useMemo(() => new ScopedLibraryOperations(() => {
    if (!window.api?.library) throw new Error("资料服务不可用");
    return window.api.library;
  }, scope, reference, readOnly, async () => {
    const tasks = await window.api?.db.listTasks() ?? [];
    return new Set(tasks.filter((task) => isLibraryTaskOwnedBy(task, scope)).map((task) => task.id));
  }), [scopeIdentity, readOnly]);
  const [remembered, remember] = useDesktopSectionState<NotesBrowseState | null>(desktop ? "notes.browse:" + scopeIdentity : null, null);
  const hasInitialLocation = Boolean(initialSpaceId || initialItemId || initialCollectionId);
  const restored = !hasInitialLocation ? remembered : null;
  const [snapshot, setSnapshot] = useState<LibrarySnapshotDto | null>(null);
  const [location, setLocation] = useState<LibraryLocation>(restored?.location ?? { spaceId: initialSpaceId ?? null, collectionId: initialCollectionId ?? null });
  const [selected, setSelected] = useState<Selection | null>(initialItemId ? { id: initialItemId } : restored?.selected ?? null);
  const [view, setView] = useState<View>(restored?.view ?? (initialCollectionId ? "folder" : "all"));
  const [tag, setTag] = useState(restored?.tag ?? "");
  const [query, setQuery] = useState(restored?.query ?? "");
  const [searchResults, setSearchResults] = useState<{ key: string; ids?: Set<string>; error?: string }>();
  const [trash, setTrash] = useState<LibraryItemDto[]>([]);
  const [sort, setSort] = useState<Sort>(restored?.sort ?? "updated");
  const [multi, setMulti] = useState(false);
  const [checked, setChecked] = useState(new Set<string>());
  const [compose, setCompose] = useState<ScopedLibraryCompose | null>(null);
  const [editingTags, setEditingTags] = useState<{ ids: string[]; value: string }>();
  const [moveIds, setMoveIds] = useState<string[]>();
  const [confirmTrash, setConfirmTrash] = useState<string[]>();
  const [confirmFolder, setConfirmFolder] = useState<LibraryCollectionDto>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(() => storedWidth("notes-left", 214, 160, 330));
  const [center, setCenter] = useState(() => storedWidth("notes-center", 288, 200, 445));
  const [layout, setLayout] = useState<NotesLayout>(() =>
    localStorage.getItem(desktopLayoutKey) === "two-column" ? "two-column" : "three-column");
  const [collapsed, setCollapsed] = useState(false);
  const [narrowView, setNarrowView] = useState<"folders" | "list">("list");
  const [focus, setFocus] = useState(false);
  const [compact, setCompact] = useState(() => (localStorage.getItem("notes-list-density") ?? (desktop ? "compact" : "normal")) === "compact");
  const [closedFolders, setClosedFolders] = useState(restored?.closedFolders ?? new Set<string>());
  const workbench = useRef<HTMLElement>(null);
  const desktopFolders = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listTop = useRef(desktop && !hasInitialLocation ? listScrollByScope.get(scopeIdentity) ?? 0 : 0);
  const openMenu = useMemo(() => ({
    get current() {
      return workbench.current?.querySelector<HTMLDetailsElement>(".notes-menu[open]")
        ?? desktopFolders.current?.querySelector<HTMLDetailsElement>(".notes-menu[open]") ?? null;
    },
  }), []);
  useDismissOnClickOutside(true, () => closeNotesMenu(openMenu.current), openMenu);
  const input = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);
  const op = useRef(false);
  const alive = useRef(true);
  const loadId = useRef(0);
  const editor = useRef<LibraryUnsavedGuard | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const activeTaskId = useAppStore((state) => state.activeTaskId);
  const theme = useAppStore((state) => state.theme);
  const isReadOnly = access.readOnly;
  const hiddenFolders = useMemo(() => hiddenLibraryCollectionIds(snapshot?.collections ?? []), [snapshot?.collections]);
  const shownSnapshot = useMemo(() => snapshot && ({ ...snapshot,
    collections: snapshot.collections.filter((folder) => !hiddenFolders.has(folder.id)),
    items: snapshot.items.filter((item) => isVisibleLibraryFile(item, hiddenFolders)),
  }), [snapshot, hiddenFolders]);
  const effectiveQuery = (query || (view === "trash" ? "" : props.searchQuery) || "").trim();
  const folderIds = useMemo(() => view === "folder" && location.collectionId && shownSnapshot
    ? libraryCollectionSubtree(shownSnapshot.collections, location.collectionId) : null, [view, location.collectionId, shownSnapshot]);
  const searchFilter = useMemo(() => ({
    spaceId: location.spaceId ?? undefined, collectionIds: folderIds ? [...folderIds] : undefined,
    tag: view === "tag" ? tag : undefined, favorite: view === "favorites", hideDotfiles: true,
  }), [location.spaceId, folderIds, tag, view]);
  const deepRequest = { query: effectiveQuery, owner: scope, reference, filter: searchFilter };
  const searchKey = JSON.stringify(deepRequest);
  const current = shownSnapshot?.items.find((item) => item.id === selected?.id);
  const showDocument = desktop && Boolean(selected && (current || !snapshot));
  const threeColumns = desktop && layout === "three-column";
  const documentOnly = showDocument && !threeColumns;
  const showList = !focus && !documentOnly;
  const listReady = Boolean(snapshot && (!effectiveQuery || view === "trash" || searchResults?.key === searchKey));
  const captureListScroll = (element = list.current): void => {
    if (!desktop || !listReady || !element) return;
    listTop.current = element.scrollTop;
    listScrollByScope.set(scopeIdentity, listTop.current);
  };
  const report = useCallback((cause: unknown) => {
    if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  useLayoutEffect(() => {
    if (desktop && snapshot) remember({ location, selected, view, tag, query, sort, closedFolders });
  }, [desktop, snapshot, location, selected, view, tag, query, sort, closedFolders, remember]);
  useLayoutEffect(() => {
    if (desktop && showList && listReady && list.current) list.current.scrollTop = listTop.current;
  }, [desktop, showList, listReady]);

  const reload = useCallback(async () => {
    const ticket = ++loadId.current;
    const next = await access.snapshot();
    if (!alive.current || ticket !== loadId.current) return;
    const hidden = hiddenLibraryCollectionIds(next.collections);
    setSnapshot(next);
    setLocation((previous) => {
      const requested = previous.spaceId ? previous : defaultLibraryLocation(next, reference);
      if (!requested.spaceId && !next.spaces.length) return requested;
      if (requested.collectionId && hidden.has(requested.collectionId)) return { ...requested, collectionId: null };
      try { requireLibraryDestination(next, requested); return requested; }
      catch { return defaultLibraryLocation(next, reference); }
    });
    if (!initialized.current) {
      initialized.current = true;
      if (initialItemId) {
        const item = next.items.find((item) => item.id === initialItemId);
        if (item && isVisibleLibraryFile(item, hidden)) setLocation({ spaceId: item.spaceId, collectionId: item.collectionId });
        else if (item) report(new Error("这篇笔记是隐藏文件"));
        else report(new Error("此资料已不属于当前范围或已移入回收站"));
      }
    }
    setSelected((selection) => selection && next.items.some((item) => item.id === selection.id && isVisibleLibraryFile(item, hidden)) ? selection : null);
    callbacks.current.onSnapshot?.(next);
  }, [access, initialItemId, scopeIdentity, report]);

  useEffect(() => {
    alive.current = true;
    void reload().catch(report);
    return () => { alive.current = false; loadId.current++; callbacks.current.onRegisterUnsaved?.(null); };
  }, [reload, report]);

  useEffect(() => {
    if (desktop && snapshot && view === "folder" && !location.collectionId) setView("all");
  }, [desktop, snapshot, view, location.collectionId]);

  useEffect(() => {
    if (!effectiveQuery || view === "trash") return;
    let active = true;
    const timer = window.setTimeout(() => void access.search(effectiveQuery, searchFilter).then(({ rows }) => {
      if (active) setSearchResults({ key: searchKey, ids: new Set(rows.map((row) => row.id)) });
    }, (cause: unknown) => {
      if (active) setSearchResults({ key: searchKey, error: cause instanceof Error ? cause.message : "搜索失败，请重试。" });
    }), 150);
    return () => { active = false; window.clearTimeout(timer); };
  }, [access, effectiveQuery, searchFilter, searchKey, view]);

  const reloadTrash = useCallback(async () => {
    const next = await access.note({ type: "trashList", owner: access.scope });
    if (alive.current) setTrash(next);
  }, [access]);
  useEffect(() => {
    if (view === "trash" && !isReadOnly) void reloadTrash().catch(report);
  }, [isReadOnly, reloadTrash, report, view]);

  const register = useCallback((guard: LibraryUnsavedGuard | null) => {
    editor.current = guard;
    callbacks.current.onRegisterUnsaved?.(guard);
  }, []);
  const flush = useCallback(async (): Promise<void> => {
    if (editor.current?.dirty) await editor.current.save();
  }, []);
  useDesktopLeaveGuard(desktop ? async () => {
    if (op.current) {
      report("笔记操作完成后即可切换页面");
      return false;
    }
    captureListScroll();
    try {
      await flush();
      return true;
    } catch (cause) {
      report(cause);
      return false;
    }
  } : undefined);
  const run = async (work: () => Promise<void>, refresh = true): Promise<void> => {
    if (op.current) return;
    captureListScroll();
    op.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await work();
      if (refresh && alive.current) {
        await reload();
        if (view === "trash") await reloadTrash();
        callbacks.current.onChanged?.();
      }
    } catch (cause) { report(cause); }
    finally { op.current = false; if (alive.current) setBusy(false); }
  };
  const openItem = (id: string, version?: number): void => {
    void run(async () => {
      await flush();
      if (!shownSnapshot?.items.some((item) => item.id === id)) throw new Error("这篇笔记在当前视图中不可见");
      setSelected({ id, version });
    }, false);
  };
  const openEvidenceItem = (id: string): void => {
    void run(async () => {
      await flush();
      const fresh = await access.snapshot();
      if (!alive.current) return;
      const hidden = hiddenLibraryCollectionIds(fresh.collections);
      if (!fresh.items.some((item) => item.id === id && isVisibleLibraryFile(item, hidden))) throw new Error("这篇笔记在当前视图中不可见");
      setSnapshot(fresh);
      setSelected({ id });
    }, false);
  };
  const handledRequest = useRef("");
  useEffect(() => {
    const request = props.itemRequest;
    if (!snapshot || !request || handledRequest.current === request.itemId + ":" + request.token) return;
    handledRequest.current = request.itemId + ":" + request.token;
    openItem(request.itemId);
  }, [props.itemRequest, snapshot]);

  const go = (nextView: View, nextLocation = location, nextTag = ""): void => {
    void run(async () => {
      await flush();
      setView(nextView); setTag(nextTag); setLocation(nextLocation); setSelected(null);
      if (desktop) {
        listTop.current = 0;
        listScrollByScope.delete(scopeIdentity);
        if (list.current) list.current.scrollTop = 0;
      }
      setNarrowView("list");
      if (nextView === "trash") setQuery("");
      setMulti(false); setChecked(new Set());
    }, false);
  };
  const backToList = (focusList = false): void => {
    void run(async () => {
      await flush();
      setSelected(null);
      if (focusList) requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    }, false);
  };
  const createNote = (): void => {
    void run(async () => {
      await flush();
      const target = await access.destination(location);
      const item = await access.createItem(target, "markdown", "未命名笔记", "");
      setLocation(target); setSelected({ id: item.id }); setView(target.collectionId ? "folder" : "all");
      setQuery(""); setMulti(false); setChecked(new Set());
    });
  };
  const importNotes = (paths?: string[]): void => {
    void run(async () => {
      await flush();
      const imported = await access.importFiles(location, paths);
      if (!imported.length) return;
      setSelected({ id: imported[0].id }); setView("all"); setQuery("");
      setLocation({ spaceId: imported[0].spaceId, collectionId: imported[0].collectionId });
      setNotice("已导入 " + imported.length + " 份资料");
    });
  };
  const importDirectory = (target: LibraryLocation): void => {
    void run(async () => {
      await flush();
      setNotice("正在导入文件夹…");
      const imported = await access.importFolder(target);
      if (!imported) { setNotice(""); return; }
      setLocation({ spaceId: imported.folder.spaceId, collectionId: imported.folder.id });
      setView("folder"); setSelected(null); setQuery(""); setMulti(false); setChecked(new Set());
      setNotice("已导入「" + imported.folder.name + "」和 " + imported.fileCount + " 个文件"
        + (imported.skippedEntries ? "，跳过 " + imported.skippedEntries + " 个链接或特殊项目" : ""));
    });
  };

  const chooseFolder = (folder: LibraryCollectionDto): void => go("folder", { spaceId: folder.spaceId, collectionId: folder.id });
  const saved = useCallback(() => { void reload().catch(report); callbacks.current.onChanged?.(); }, [reload, report]);
  const batch = (task: (ids: string[]) => Promise<void>, ids = [...checked]): void => {
    void run(async () => {
      await flush();
      await task(ids);
      setChecked(new Set()); setMulti(false);
    });
  };
  const toggleCheck = (id: string): void => setChecked((existing) => {
    const next = new Set(existing);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const drop = (event: React.DragEvent, target: LibraryLocation): void => {
    if (isReadOnly) return;
    const ids = event.dataTransfer.getData(dragNotes);
    const folder = event.dataTransfer.getData(dragFolder);
    if (ids || folder) {
      event.preventDefault(); event.stopPropagation();
      if (folder) void run(async () => {
        await flush();
        await access.move({ id: folder, kind: "folder" }, target.collectionId);
      });
      else {
        try {
          const items = JSON.parse(ids) as string[];
          if (!Array.isArray(items) || !items.every((id) => typeof id === "string")) throw new Error("无效的拖动内容");
          batch(async (ids) => { await access.note({ type: "move", owner: scope, ids, collectionId: target.collectionId }); }, items);
        } catch (error) { report(error); }
      }
    } else if (event.dataTransfer.files.length) {
      event.preventDefault(); event.stopPropagation();
      const paths = Array.from(event.dataTransfer.files).flatMap((file) => {
        const path = window.api?.getPathForFile(file);
        return path ? [path] : [];
      });
      if (paths.length) void run(async () => { await access.importFiles(target, paths); });
    }
  };
  const dragOver = (event: React.DragEvent): void => {
    if (!isReadOnly && event.dataTransfer.types.some((type) => [dragNotes, dragFolder, "Files"].includes(type))) event.preventDefault();
  };

  const submit = (): void => {
    if (!compose) return;
    void run(async () => {
      await flush();
      const form = compose;
      if (form.type === "folder") {
        const folder = await access.createFolder(form.location, form.title.trim());
        setLocation({ spaceId: folder.spaceId, collectionId: folder.id }); setView("folder");
      } else if (form.type === "rename") {
        if (form.row.kind === "folder") await access.renameFolder(form.row.id, form.title.trim());
        else await access.renameItem(form.row.id, form.title.trim());
      } else if (form.type === "move") await access.move(form.row, form.collectionId);
      else if (form.type === "artifact") {
        const item = await access.saveArtifact(form.location, form.artifactId);
        setSelected({ id: item.id });
      } else if (form.type === "url") {
        const item = await access.createUrl(form.location, form.url, form.title);
        setSelected({ id: item.id });
      } else {
        const item = await access.createItem(form.location, form.kind, form.title);
        setSelected({ id: item.id });
      }
      setCompose(null);
    });
  };

  const visible = (view === "trash" ? trash.filter((item) => isVisibleLibraryFile(item, hiddenFolders)) : shownSnapshot?.items ?? []).filter((item) => {
    if (view === "trash") return !effectiveQuery || item.title.toLowerCase().includes(effectiveQuery.toLowerCase());
    if (location.spaceId && item.spaceId !== location.spaceId) return false;
    if (view === "favorites" && !item.favorite) return false;
    if (view === "tag" && !item.tags?.includes(tag)) return false;
    if (view === "folder" && item.collectionId !== location.collectionId
      && !(effectiveQuery && item.collectionId && folderIds?.has(item.collectionId))) return false;
    return !effectiveQuery || (searchResults?.key === searchKey && searchResults.ids?.has(item.id));
  }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    || (sort === "title" ? a.title.localeCompare(b.title, "zh-CN") : sort === "created" ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt));
  const spaceItems = shownSnapshot?.items.filter((item) => !location.spaceId || item.spaceId === location.spaceId) ?? [];
  const tags = [...new Set(spaceItems.flatMap((item) => item.tags ?? []))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const folders = shownSnapshot?.collections.filter((folder) => folder.spaceId === location.spaceId) ?? [];
  const dialogOpen = Boolean(compose || confirmTrash || confirmFolder || editingTags || moveIds);
  useBlockNativeSurfaces(dialogOpen);

  function renderFolders(parentId: string | null, depth = 0): React.ReactNode {
    return folders.filter((folder) => folder.parentId === parentId).map((folder) => {
      const children = folders.some((entry) => entry.parentId === folder.id);
      const open = !closedFolders.has(folder.id);
      const indent = { paddingInlineStart: Math.min(10 + depth * 13, 70) };
      return <div key={folder.id}>
        <div className="notes-tree-row" style={indent} data-selected={view === "folder" && location.collectionId === folder.id}
          draggable={!isReadOnly} onDragStart={(event) => event.dataTransfer.setData(dragFolder, folder.id)}
          onDragOver={dragOver} onDrop={(event) => drop(event, { spaceId: folder.spaceId, collectionId: folder.id })}>
          {children && <button type="button" className={"notes-caret" + (open ? " expanded" : "")} aria-expanded={open}
            onClick={() => setClosedFolders((previous) => {
              const next = new Set(previous); if (open) next.add(folder.id); else next.delete(folder.id); return next;
            })}><IconChevronRight size={12} /></button>}
          <button className="notes-tree-label" type="button" onClick={() => chooseFolder(folder)} title={folder.name}><IconFolder size={15} />{folder.name}</button>
          {!isReadOnly && <NotesMenu tree label="⋯" ariaLabel="文件夹菜单">
            <button type="button" onClick={() => setCompose({ type: "folder", title: "", location: { spaceId: folder.spaceId, collectionId: folder.id } })}>新建子文件夹</button>
            <button type="button" onClick={() => snapshot && setCompose({ type: "rename", row: libraryFolderRow(snapshot, folder), title: folder.name })}>重命名</button>
            <button type="button" onClick={() => snapshot && setCompose({ type: "move", row: libraryFolderRow(snapshot, folder), collectionId: folder.parentId })}>移动文件夹</button>
            <button type="button" onClick={() => setConfirmFolder(folder)}>删除空文件夹</button>
          </NotesMenu>}
        </div>
        {open && renderFolders(folder.id, depth + 1)}
      </div>;
    });
  }
  const resize = (pane: "left" | "center") => <div className="notes-resize" tabIndex={0} role="separator" aria-orientation="vertical"
    aria-label={pane === "left" ? "调整文件夹栏宽度" : "调整笔记列表宽度"}
    onPointerDown={(event) => {
      const target = event.currentTarget;
      const start = event.clientX, original = pane === "left" ? left : center;
      target.setPointerCapture(event.pointerId);
      target.onpointermove = (move) => resizeTo(pane, original + move.clientX - start);
      target.onlostpointercapture = () => { target.onpointermove = null; };
    }}
    onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault(); resizeTo(pane, (pane === "left" ? left : center) + (event.key === "ArrowLeft" ? -10 : 10));
    }} />;
  function resizeTo(pane: "left" | "center", value: number): void {
    const width = pane === "left" ? Math.min(330, Math.max(160, value)) : Math.min(445, Math.max(200, value));
    (pane === "left" ? setLeft : setCenter)(width);
    localStorage.setItem("notes-" + pane, String(width));
  }

  const changeTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    useAppStore.setState({ theme: next });
  };
  const policyScope = reference ? null : scope.type === "workspace" ? { kind: "space" as const, id: scope.workspaceId }
    : scope.type === "project" ? { kind: "project" as const, id: scope.projectId } : null;
  const selectedFolder = folders.find((folder) => folder.id === location.collectionId);
  const currentName = view === "folder" ? selectedFolder?.name ?? "文件夹" : view === "favorites" ? "收藏" : view === "trash" ? "回收站" : view === "tag" ? tag : "全部笔记";
  const widths = { "--notes-left": left + "px", "--notes-center": center + "px" } as CSSProperties;
  const changeDesktopLayout = (next: NotesLayout): void => {
    captureListScroll();
    setLayout(next);
    localStorage.setItem(desktopLayoutKey, next);
    const state = useAppStore.getState();
    if (next === "three-column" && state.sidebarCollapsed) state.toggleSidebar();
  };
  const activeActions = current && !isReadOnly ? <>
    {props.renderItemActions?.(current)}
    <NotesMenu label="⋯" ariaLabel="笔记操作">
      <button type="button" onClick={() => editingTagsFor([current.id])}>编辑标签</button>
      <button type="button" onClick={() => void run(async () => { await access.note({ type: "metadata", owner: scope, id: current.id, pinned: !current.pinned }); })}>
        {current.pinned ? "取消置顶" : "置顶"}</button>
      <button type="button" onClick={() => void run(async () => { await access.favorite(current.id, !current.favorite); })}>{current.favorite ? "取消收藏" : "收藏"}</button>
      <button type="button" onClick={() => setMoveIds([current.id])}>移动到文件夹</button>
      {activeTaskId && <button type="button" onClick={() => void run(async () => { await access.attach(current.id, activeTaskId, false); setNotice("已附加到当前任务"); })}>附加到任务</button>}
      <button type="button" onClick={() => setConfirmTrash([current.id])}>移入回收站</button>
    </NotesMenu>
  </> : props.renderItemActions && current && props.renderItemActions(current);
  function editingTagsFor(ids: string[]): void {
    const existing = ids.length === 1 ? snapshot?.items.find((item) => item.id === ids[0])?.tags ?? [] : [];
    setEditingTags({ ids, value: existing.join(", ") });
  }

  const fileMenu = <NotesMenu label="文件">
    {!isReadOnly && <>
      <button type="button" onClick={() => importNotes()}>导入文档</button>
      {!desktop && <>
        <button type="button" disabled={busy} onClick={() => importDirectory(location)}>导入文件夹</button>
        <button type="button" onClick={() => setCompose({ type: "folder", title: "", location })}>新建文件夹</button>
      </>}
      <button type="button" onClick={() => setCompose({ type: "url", title: "", location, url: "" })}>添加网页链接</button>
      <button type="button" onClick={() => void run(async () => {
        await flush();
        if (await access.note({ type: "backup", owner: scope })) setNotice("备份已保存");
      }, false)}>本地备份</button>
      <button type="button" onClick={() => void run(async () => {
        await flush();
        const result = await access.note({ type: "restoreBackup", owner: scope });
        if (result) setNotice("已恢复 " + result.restored + " 份资料，保留已有资料 " + result.skipped + " 份");
      })}>从本地备份恢复</button>
      {scope.type !== "personal" && <button type="button" onClick={() => void run(async () =>
        setCompose({ type: "artifact", location, artifactId: "", artifacts: await access.artifacts() }), false)}>从任务成果保存</button>}
    </>}
    <button type="button" onClick={() => void reload().catch(report)}>刷新</button>
  </NotesMenu>;
  const allNotesDrop = (event: React.DragEvent): void => drop(event, { ...location, collectionId: null });
  const allNotes = (): void => go("all", { ...location, collectionId: null });
  const foldersAndTags = <>
    {snapshot && snapshot.spaces.length > 1 && <select aria-label="资料位置" value={location.spaceId ?? ""}
      onChange={(event) => go("all", { spaceId: event.target.value, collectionId: null })}>
      {snapshot.spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
    </select>}
    {desktop ? <>
      <DesktopSectionRow active={view === "all"} icon={<IconFile size={15} />} onClick={allNotes}
        onDragOver={dragOver} onDrop={allNotesDrop}>全部笔记</DesktopSectionRow>
      <DesktopSectionRow active={view === "favorites"} onClick={() => go("favorites")}>收藏</DesktopSectionRow>
    </> : <>
      <button type="button" data-selected={view === "all"} onClick={allNotes} onDragOver={dragOver} onDrop={allNotesDrop}>
        <IconFile size={15} />全部笔记
      </button>
      <button type="button" data-selected={view === "favorites"} onClick={() => go("favorites")}>☆ 收藏</button>
      {!isReadOnly && <button type="button" data-selected={view === "trash"} onClick={() => go("trash")}><IconTrash size={15} />回收站</button>}
    </>}
    <div className="notes-tree-heading"><span>文件夹</span>{!isReadOnly && <span className="notes-folder-actions">
      <button type="button" aria-label="导入文件夹" title="导入本地文件夹" disabled={busy}
        onClick={() => importDirectory({ ...location, collectionId: null })}>导入</button>
      <button type="button" aria-label="新建文件夹" title="新建文件夹"
        onClick={() => setCompose({ type: "folder", title: "", location: { ...location, collectionId: null } })}><IconPlus size={14} /></button>
    </span>}</div>
    {renderFolders(reference?.collectionId ? folders.find((folder) => folder.id === reference.collectionId)?.parentId ?? null : null)}
    {tags.length > 0 && <div className="notes-tree-heading">标签</div>}
    {tags.map((entry) => desktop
      ? <DesktopSectionRow active={view === "tag" && tag === entry} key={entry} onClick={() => go("tag", location, entry)}># {entry}</DesktopSectionRow>
      : <button type="button" data-selected={view === "tag" && tag === entry} key={entry} onClick={() => go("tag", location, entry)}># {entry}</button>)}
    {desktop && !isReadOnly && <DesktopSectionRow className="notes-desktop-trash" active={view === "trash"} icon={<IconTrash size={15} />}
      onClick={() => go("trash")}>回收站</DesktopSectionRow>}
  </>;

  return <section ref={workbench} className={"scoped-library-manager notes-workbench" + (desktop ? " notes-workbench--desktop" : "")}
    style={widths} aria-label={props.name ?? "笔记"} data-layout={desktop ? layout : undefined}
    data-selected={Boolean(current)} data-focus={focus} data-collapsed={collapsed} data-narrow-view={narrowView}
    onKeyDown={(event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key.toLowerCase() === "n" && !isReadOnly) { event.preventDefault(); createNote(); }
      if (event.key === "/") {
        event.preventDefault();
        if (documentOnly) backToList(true);
        else { setFocus(false); requestAnimationFrame(() => input.current?.focus()); }
      }
      if (!desktop && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); setFocus((previous) => !previous); }
    }}>
    {desktop && <DesktopSectionSidebar title="笔记" scrollKey={snapshot ? "notes.folders:" + scopeIdentity : undefined}>
      <div ref={desktopFolders} className="notes-desktop-folders" aria-label="文件夹和标签">
        {!isReadOnly && <DesktopSectionRow className="notes-desktop-create" disabled={busy || !snapshot} onClick={createNote}
          icon={<IconPlus size={15} />}>新建笔记</DesktopSectionRow>}
        {props.desktop?.scopePicker}
        {foldersAndTags}
      </div>
    </DesktopSectionSidebar>}
    <header className="notes-top">
      {documentOnly && <button className="notes-desktop-back" type="button" disabled={busy} onClick={() => backToList(true)}>
        <IconChevronLeft size={15} />返回列表
      </button>}
      <strong>{documentOnly ? currentName : props.name ?? "笔记"}</strong>
      {isReadOnly && <span className="notes-muted">{reference ? "引用 · 只读" : "已归档 · 只读"}</span>}
      <div className="notes-top-actions">
        {!desktop && !current && !focus && <button type="button" className="notes-narrow-folder-toggle"
          aria-expanded={narrowView === "folders"}
          onClick={() => { setCollapsed(false); setNarrowView(narrowView === "folders" ? "list" : "folders"); }}>
          {narrowView === "folders" ? "返回笔记列表" : "查看文件夹"}
        </button>}
        {!desktop && !isReadOnly && <button type="button" className="notes-primary" disabled={busy} onClick={createNote} title="Ctrl+N"><IconPlus size={14} />新建笔记</button>}
        {fileMenu}
        <NotesMenu label="视图">
          {desktop && <>
            <button type="button" aria-pressed={threeColumns} onClick={() => changeDesktopLayout("three-column")}>三列视图</button>
            <button type="button" aria-pressed={!threeColumns} onClick={() => changeDesktopLayout("two-column")}>两列视图</button>
          </>}
          {!desktop && <>
            <button type="button" onClick={() => setCollapsed((previous) => !previous)}>{collapsed ? "展开文件夹栏" : "收起文件夹栏"}</button>
            <button type="button" onClick={() => setFocus((previous) => !previous)}>{focus ? "退出专注" : "专注编辑"}</button>
          </>}
          <button type="button" onClick={() => {
            setCompact((previous) => { localStorage.setItem("notes-list-density", previous ? "normal" : "compact"); return !previous; });
          }}>{compact ? "舒展列表" : "紧凑列表"}</button>
          {!desktop && <button type="button" onClick={changeTheme}>{theme === "dark" ? "浅色主题" : "深色主题"}</button>}
        </NotesMenu>
        {focus && <button type="button" onClick={() => setFocus(false)}>退出专注</button>}
        {!desktop && current && <button type="button" className="notes-mobile-back" onClick={() => backToList()}>返回列表</button>}
      </div>
    </header>
    {(error || notice) && <div className="note-status" role={error ? "alert" : "status"}>{error || notice}
      <button type="button" onClick={() => { setError(""); setNotice(""); }} aria-label="关闭提示">×</button></div>}
    {showList && policyScope && <MaterialRetrievalRow key={policyScope.id} scope={policyScope} readOnly={isReadOnly} />}
    <div className="notes-panes">
      {!desktop && !collapsed && !focus && <>
        <aside className="notes-folders" aria-label="文件夹和标签">
          {foldersAndTags}
        </aside>{resize("left")}
      </>}
      {showList && <>
        <section className="notes-list" aria-label="笔记列表" data-compact={compact} onDragOver={dragOver} onDrop={(event) => drop(event, location)}>
          <label className="notes-search"><IconSearch size={15} /><input ref={input} aria-label="搜索当前资料" placeholder="搜索标题和正文"
            value={query || (view === "trash" ? "" : props.searchQuery) || ""}
            onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}>×</button>}</label>
          {snapshot && scope.type !== "personal" && view !== "trash" && <MaterialDeepSearch key={searchKey} request={deepRequest} onOpen={openEvidenceItem} />}
          <header className="notes-list-header">
            <div><strong>{effectiveQuery ? "常规检索结果" : currentName}</strong> <span className="notes-muted">{visible.length}</span></div>
            <select aria-label="列表排序" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
              <option value="updated">最近编辑</option><option value="created">创建时间</option><option value="title">标题</option></select>
            {!isReadOnly && view !== "trash" && <button type="button" aria-pressed={multi} onClick={() => { setMulti(!multi); setChecked(new Set()); }}>多选</button>}
          </header>
          {multi && <div className="notes-batch">
            <button type="button" onClick={() => setChecked(new Set(visible.map((item) => item.id)))}>全选</button>
            <button type="button" disabled={!checked.size} onClick={() => setMoveIds([...checked])}>移动</button>
            <button type="button" disabled={!checked.size} onClick={() => editingTagsFor([...checked])}>标签</button>
            <button type="button" disabled={checked.size < 2} onClick={() => batch(async (ids) => {
              const item = await access.note({ type: "merge", owner: scope, ids });
              setSelected({ id: item.id }); setNotice("已生成合并笔记，原笔记仍可打开");
            })}>合并</button>
            <button type="button" disabled={!checked.size} onClick={() => batch(async (ids) => { await access.note({ type: "export", ids, format: "markdown" }); })}>导出</button>
            <button type="button" disabled={!checked.size} onClick={() => setConfirmTrash([...checked])}>删除</button>
          </div>}
          <div className="notes-list-scroll thin-scrollbar" ref={list} onScroll={desktop ? (event) => captureListScroll(event.currentTarget) : undefined}>
            {!snapshot && <div className="notes-empty">{error ? "资料加载失败" : "正在加载笔记…"}</div>}
            {snapshot && !visible.length && <div className="notes-empty">{effectiveQuery
              ? searchResults?.key === searchKey ? searchResults.error ?? "常规检索未找到匹配的笔记" : "正在常规检索…"
              : view === "trash" ? "回收站为空" : "这里还没有笔记"}</div>}
            {visible.map((item) => <div className="notes-list-row" key={item.id} data-selected={item.id === current?.id}
              draggable={!isReadOnly && view !== "trash"} onDragStart={(event) => {
                event.dataTransfer.setData(dragNotes, JSON.stringify(checked.has(item.id) ? [...checked] : [item.id]));
                event.dataTransfer.effectAllowed = "move";
              }}>
              {multi && <input type="checkbox" aria-label={"选中 " + item.title} checked={checked.has(item.id)} onChange={() => toggleCheck(item.id)} />}
              <button type="button" className="notes-list-item" onClick={() => view === "trash" ? undefined : multi ? toggleCheck(item.id) : openItem(item.id)}>
                <span title={item.title}>{item.pinned && <span title="置顶">⌃ </span>}{item.favorite && <span title="收藏">★ </span>}{item.title}</span>
                <small>{new Date(view === "trash" ? item.trashedAt ?? item.updatedAt : item.updatedAt).toLocaleDateString()}
                  {item.kind !== "markdown" ? " · " + item.filename.split(".").at(-1)?.toUpperCase() : ""}
                  {item.tags?.length ? " · " + item.tags.join(" · ") : ""}</small>
              </button>
              {view === "trash" && <button type="button" disabled={busy}
                onClick={() => batch(async (ids) => { await access.note({ type: "restore", owner: scope, ids }); setNotice("已恢复"); }, [item.id])}>恢复</button>}
            </div>)}
          </div>
        </section>{(!desktop || threeColumns) && resize("center")}
      </>}
      {(!desktop || threeColumns || showDocument) && <main className="notes-canvas" aria-label="笔记编辑区">
        {current ? current.sizeBytes > LIBRARY_INLINE_FILE_MAX_BYTES && !isOfficeUseFile(current.filename)
          ? <LargeLibraryFileView key={current.id} item={current} access={access} onError={report} actions={activeActions} />
          : current.kind === "markdown" ? <NoteDocument key={current.id + ":" + (selected?.version ?? "")} item={current} initialVersion={selected?.version}
          access={access} onSaved={saved} onOpenItem={openItem} onError={report} actions={activeActions} onRegisterUnsaved={register} />
          : (isOfficeUseFile(current.filename) || ["image", "office", "pdf", "file"].includes(current.kind)) ? <article className="notes-attachment">
            <header><h2>{current.title}</h2><button type="button" onClick={() => void access.showInFolder(current.id).catch(report)}>打开位置</button>{activeActions}</header>
            <NoteAttachmentPreview key={current.id} item={current} access={access} />
          </article>
          : <LibraryDocumentView key={current.id} itemId={current.id} access={access}
            onBack={() => backToList(desktop)} onRenamed={saved}
            onDeleted={() => { setSelected(null); saved(); }} onOpenItem={openItem} onToast={setNotice} onRegisterUnsaved={register}
            actions={activeActions} />
          : <div className="notes-empty notes-empty-canvas">{showDocument ? "正在打开笔记…" : <>选择一篇笔记{!isReadOnly && "，或新建笔记"}</>}</div>}
      </main>}
    </div>
    {compose && shownSnapshot && <ScopedLibraryDialog value={compose} snapshot={shownSnapshot} busy={busy} unlimitedItemTitle={scope.type === "project"}
      onChange={setCompose} onCancel={() => setCompose(null)} onSubmit={submit} />}
    {editingTags && <div className="notes-modal-backdrop"><form className="notes-modal" onSubmit={(event) => {
      event.preventDefault();
      const { ids, value } = editingTags;
      const tags = value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
      batch(async () => {
        const items = await access.snapshot();
        for (const id of ids) {
          const existing = ids.length > 1 ? items.items.find((entry) => entry.id === id)?.tags ?? [] : [];
          await access.note({ type: "metadata", owner: scope, id, tags: [...existing, ...tags] });
        }
        setEditingTags(undefined);
      }, ids);
    }}>
      <h3>{editingTags.ids.length === 1 ? "编辑标签" : "批量添加标签"}</h3>
      <input autoFocus aria-label="笔记标签" placeholder="用逗号分隔标签" value={editingTags.value}
        onChange={(event) => setEditingTags({ ...editingTags, value: event.target.value })} />
      <div><button type="button" onClick={() => setEditingTags(undefined)}>取消</button><button disabled={busy}>保存标签</button></div>
    </form></div>}
    {moveIds && <div className="notes-modal-backdrop"><form className="notes-modal" onSubmit={(event) => {
      event.preventDefault();
      const target = new FormData(event.currentTarget).get("folder")?.toString() || null;
      batch(async (ids) => { await access.note({ type: "move", owner: scope, ids, collectionId: target }); setMoveIds(undefined); }, moveIds);
    }}>
      <h3>移动到文件夹</h3>
      <select name="folder" aria-label="目标文件夹" autoFocus><option value="">根目录</option>{shownSnapshot && moveIds[0] && (() => {
        const item = shownSnapshot.items.find((entry) => entry.id === moveIds[0]);
        return item && libraryMoveTargets(shownSnapshot, libraryItemRow(shownSnapshot, item)).map((folder) =>
          <option value={folder.id} key={folder.id}>{folder.name}</option>);
      })()}</select>
      <div><button type="button" onClick={() => setMoveIds(undefined)}>取消</button><button disabled={busy}>移动</button></div>
    </form></div>}
    <ConfirmDialog open={Boolean(confirmTrash)} title="将选中的笔记移入回收站？" body="恢复后可继续使用原笔记和引用。"
      confirmLabel="移入回收站" danger onCancel={() => setConfirmTrash(undefined)} onConfirm={() => {
        if (confirmTrash) batch(async (ids) => { await access.note({ type: "trash", owner: scope, ids }); setConfirmTrash(undefined); }, confirmTrash);
      }} />
    <ConfirmDialog open={Boolean(confirmFolder)} title="删除文件夹？" body="先将文件夹中的资料移出，再删除空文件夹。"
      confirmLabel="删除" danger onCancel={() => setConfirmFolder(undefined)} onConfirm={() => {
        if (confirmFolder) void run(async () => {
          const fresh = await access.snapshot();
          const branch = libraryCollectionSubtree(fresh.collections, confirmFolder.id);
          const trashed = await access.note({ type: "trashList", owner: scope });
          if (branch.size > 1 || [...fresh.items, ...trashed].some((item) => item.collectionId && branch.has(item.collectionId))) {
            throw new Error("此文件夹仍包含资料或子文件夹");
          }
          await access.deleteFolder(confirmFolder.id);
          setConfirmFolder(undefined); setView("all"); setLocation({ spaceId: confirmFolder.spaceId, collectionId: null });
        });
      }} />
  </section>;
}

function storedWidth(key: string, fallback: number, low: number, high: number): number {
  const raw = localStorage.getItem(key);
  return raw && Number.isFinite(Number(raw)) ? Math.max(low, Math.min(high, Number(raw))) : fallback;
}
