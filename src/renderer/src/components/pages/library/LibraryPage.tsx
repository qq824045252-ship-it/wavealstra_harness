import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LIBRARY_NAME_MAX_CHARS,
  LIBRARY_PERSONAL_SPACE_ID,
  LIBRARY_TITLE_MAX_CHARS,
  type LibraryCreateItemRequest,
  type LibraryListRowDto,
  type LibrarySnapshotDto,
} from "../../../../../shared/library-ipc";
import { FileBadge } from "@/components/common/FileBadge";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { collectDroppedLocalFiles, dataTransferHasFiles } from "@/lib/projectWorkspace";
import { relativeTime, useAppStore } from "@/store/appStore";
import {
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconFolder,
  IconHardDrive,
  IconPlus,
  IconSearch,
  IconX,
} from "@/components/common/icons";
import LibraryDocumentView from "./LibraryDocumentView";
import "@/styles/library.css";

type RecentTab = "visited" | "shared-by-me" | "shared-with-me";
type TypeFilter = "all" | "markdown" | "html" | "csv" | "office" | "other";
type ItemKind = LibraryCreateItemRequest["kind"];

type Compose =
  | { type: "item"; spaceId: string; collectionId?: string | null; kind: ItemKind; title: string }
  | { type: "folder"; spaceId: string; parentId?: string | null; name: string }
  | { type: "url"; spaceId: string; collectionId?: string | null; title: string; url: string }
  | { type: "project-space"; name: string; projectId: string }
  | { type: "save-artifact"; artifactId: string; title: string; spaceId: string };

const ITEM_KIND_OPTIONS: Array<{ id: ItemKind; label: string; hint: string }> = [
  { id: "markdown", label: "文档", hint: "Markdown" },
  { id: "csv", label: "表格", hint: "CSV" },
  { id: "html", label: "页面", hint: "HTML" },
];

type Nav =
  | { view: "recent"; tab: RecentTab }
  | { view: "artifacts" }
  | { view: "space"; spaceId: string; folderId: string | null }
  | { view: "item"; itemId: string }
  | { view: "search" };

const TYPE_OPTIONS: Array<{ id: TypeFilter; label: string }> = [
  { id: "all", label: "全部类型" },
  { id: "markdown", label: "文档" },
  { id: "html", label: "页面" },
  { id: "csv", label: "表格" },
  { id: "office", label: "办公" },
  { id: "other", label: "其他" },
];

function matchesType(kind: string, filter: TypeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "other") return !["markdown", "html", "csv", "office", "folder"].includes(kind);
  return kind === filter;
}

function filenameFor(item: { filename?: string; title: string; kind: string }): string {
  if (item.filename) return item.filename;
  const ext =
    item.kind === "markdown" ? ".md" : item.kind === "html" ? ".html" : item.kind === "csv" ? ".csv" : "";
  return `${item.title}${ext}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function LibraryPage(): React.JSX.Element {
  const [snap, setSnap] = useState<LibrarySnapshotDto | null>(null);
  const [nav, setNav] = useState<Nav>(() => {
    const initial = useAppStore.getState().libraryNav;
    if (initial?.view === "space") return { view: "space", spaceId: initial.spaceId, folderId: initial.folderId };
    if (initial?.view === "item") return { view: "item", itemId: initial.itemId };
    return { view: "recent", tab: "visited" };
  });
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<LibraryListRowDto[]>([]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [docsOpen, setDocsOpen] = useState(true);
  const [teamsOpen, setTeamsOpen] = useState(true);
  const [menu, setMenu] = useState<"docs" | "type" | null>(null);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const projects = useAppStore((s) => s.projects);

  useDismissOnClickOutside(menu !== null, () => setMenu(null), menuRef);

  const reload = useCallback(async () => {
    try {
      const next = await window.api?.library.snapshot();
      if (next) setSnap(next);
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "资料库加载失败");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    setDropTarget(null);
  }, [nav]);

  useEffect(() => {
    if (!compose) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setCompose(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compose]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchHits([]);
      return;
    }
    const handle = setTimeout(() => {
      void window.api?.library.search({ query: q }).then(
        (rows) => {
          setSearchHits(rows ?? []);
          setNav({ view: "search" });
        },
        (cause: unknown) => {
          setToast(cause instanceof Error ? cause.message : "搜索失败");
        },
      );
    }, 180);
    return () => clearTimeout(handle);
  }, [query]);

  const personal = snap?.spaces.find((s) => s.kind === "personal");
  const teams = snap?.spaces.filter((s) => s.kind === "team") ?? [];
  const personalSpaceId = personal?.id ?? LIBRARY_PERSONAL_SPACE_ID;
  const personalFolders = (snap?.collections ?? []).filter(
    (c) => c.spaceId === personalSpaceId && !c.parentId,
  );
  const personalFiles = (snap?.items ?? []).filter(
    (i) => i.spaceId === personalSpaceId && !i.collectionId && i.kind !== "url",
  );
  const currentFolderItems = useMemo(() => {
    if (nav.view !== "space" || !snap) return [];
    return snap.items.filter(
      (i) => i.spaceId === nav.spaceId && (i.collectionId ?? null) === nav.folderId,
    );
  }, [nav, snap]);
  const currentFolderCollections = useMemo(() => {
    if (nav.view !== "space" || !snap) return [];
    return (snap.collections ?? []).filter(
      (c) => c.spaceId === nav.spaceId && (c.parentId ?? null) === nav.folderId,
    );
  }, [nav, snap]);

  const currentSpace = nav.view === "space" ? snap?.spaces.find((s) => s.id === nav.spaceId) : undefined;
  const currentFolder =
    nav.view === "space" && nav.folderId
      ? (snap?.collections ?? []).find((c) => c.id === nav.folderId)
      : undefined;

  const title =
    nav.view === "recent"
      ? "最近"
      : nav.view === "artifacts"
        ? "本地产物"
        : nav.view === "search"
          ? "搜索"
          : nav.view === "item"
            ? "文档"
            : currentFolder?.name ?? currentSpace?.name ?? "资料库";

  const rows: LibraryListRowDto[] = useMemo(() => {
    if (!snap) return [];
    if (nav.view === "search") return searchHits;
    if (nav.view === "recent") {
      return snap.recent;
    }
    if (nav.view === "artifacts") {
      return snap.artifacts.map((a) => ({
        id: a.id,
        source: "artifact" as const,
        kind: a.kind,
        title: a.title,
        owner: a.owner,
        location: a.location,
        taskId: a.taskId,
        spaceId: a.spaceId,
        updatedAt: a.updatedAt,
      }));
    }
    if (nav.view === "space") {
      const loc = currentSpace?.name ?? "资料库";
      const collectionRows: LibraryListRowDto[] = currentFolderCollections.map((c) => ({
        id: c.id,
        source: "library" as const,
        kind: "folder",
        title: c.name,
        owner: c.owner,
        location: loc,
        spaceId: c.spaceId,
        parentId: c.parentId,
        updatedAt: c.updatedAt,
      }));
      const itemRows: LibraryListRowDto[] = currentFolderItems.map((item) => ({
        id: item.id,
        source: "library" as const,
        kind: item.kind,
        title: item.title,
        owner: item.owner,
        location: loc,
        spaceId: item.spaceId,
        collectionId: item.collectionId,
        lastVisitedAt: item.lastVisitedAt,
        updatedAt: item.updatedAt,
        filename: item.filename,
        favorite: item.favorite,
      }));
      return [...collectionRows, ...itemRows];
    }
    return [];
  }, [snap, nav, searchHits, currentFolderItems, currentFolderCollections, currentSpace]);

  const visible = rows.filter((r) => matchesType(r.kind, typeFilter));

  const createCollectionIn = async (spaceId: string, parentId: string | null | undefined, name: string): Promise<void> => {
    const res = await window.api?.library.createCollection({ spaceId, parentId, name: name.trim() || undefined });
    if (!res?.ok) {
      setToast(res && "error" in res ? res.error : "创建失败");
      return;
    }
    await reload();
    setNav({ view: "space", spaceId, folderId: res.value.id });
  };

  const createIn = async (
    kind: LibraryCreateItemRequest["kind"],
    spaceId: string,
    collectionId: string | null | undefined,
    title?: string,
  ): Promise<void> => {
    const res = await window.api?.library.createItem({
      spaceId,
      collectionId,
      kind,
      title: title?.trim() || undefined,
    });
    if (!res?.ok) {
      setToast(res && "error" in res ? res.error : "创建失败");
      return;
    }
    await reload();
    setNav({ view: "item", itemId: res.value.id });
  };

  const openCreateItem = (kind: ItemKind, spaceId: string, collectionId?: string | null): void => {
    setCompose({ type: "item", spaceId, collectionId, kind, title: "" });
  };

  const openRow = (row: LibraryListRowDto): void => {
    if (row.source === "artifact" && row.taskId) {
      useAppStore.getState().setActiveTask(row.taskId);
      useAppStore.getState().openArtifact(row.id);
      useAppStore.getState().setPage("chat");
      return;
    }
    if (row.kind === "folder" && row.spaceId) {
      setNav({ view: "space", spaceId: row.spaceId, folderId: row.id });
      return;
    }
    setNav({ view: "item", itemId: row.id });
  };

  const createProjectSpace = (): void => {
    if (projects.length === 0) {
      setToast("还没有项目，请先创建项目");
      return;
    }
    setCompose({ type: "project-space", name: projects[0]!.name, projectId: projects[0]!.id });
  };

  const createUrlIn = (spaceId: string, collectionId?: string | null): void => {
    setCompose({ type: "url", spaceId, collectionId, title: "", url: "https://" });
  };

  const saveArtifact = async (artifactId: string, spaceId: string, collectionId?: string | null): Promise<void> => {
    const res = await window.api?.library.saveArtifact({ artifactId, spaceId, collectionId });
    setCompose(null);
    if (!res?.ok) {
      setToast(res && "error" in res ? res.error : "保存失败");
      return;
    }
    await reload();
    setToast(`已保存到资料库：${res.value.title}`);
  };

  const submitCompose = async (): Promise<void> => {
    if (!compose) return;
    if (compose.type === "item") {
      if (!compose.title.trim()) return;
      const target = compose;
      setCompose(null);
      await createIn(target.kind, target.spaceId, target.collectionId, target.title);
      return;
    }
    if (compose.type === "folder") {
      if (!compose.name.trim()) return;
      const target = compose;
      setCompose(null);
      await createCollectionIn(target.spaceId, target.parentId, target.name);
      return;
    }
    if (compose.type === "url") {
      if (!compose.url.trim()) return;
      const target = compose;
      setCompose(null);
      const res = await window.api?.library.createUrl({
        spaceId: target.spaceId,
        collectionId: target.collectionId,
        url: target.url.trim(),
        title: target.title.trim() || undefined,
      });
      if (!res?.ok) {
        setToast(res && "error" in res ? res.error : "添加失败");
        return;
      }
      await reload();
      setNav({ view: "item", itemId: res.value.id });
      return;
    }
    if (compose.type === "project-space") {
      if (!compose.projectId) {
        setToast("请选择项目");
        return;
      }
      const target = compose;
      setCompose(null);
      const res = await window.api?.library.createSpace({
        name: target.name.trim() || projects.find((p) => p.id === target.projectId)?.name || "项目资料",
        projectId: target.projectId,
      });
      if (!res?.ok) {
        setToast(res && "error" in res ? res.error : "创建失败");
        return;
      }
      await reload();
      setTeamsOpen(true);
      setNav({ view: "space", spaceId: res.value.id, folderId: null });
      return;
    }
    await saveArtifact(compose.artifactId, compose.spaceId, activeFolderId);
  };

  const importInto = async (spaceId: string, collectionId?: string | null): Promise<void> => {
    const res = await window.api?.library.pickAndImport({ spaceId, collectionId });
    if (!res?.ok) {
      setToast(res && "error" in res ? res.error : "导入失败");
      return;
    }
    await reload();
    if (res.value.length) setToast(`已导入 ${res.value.length} 个文件`);
  };

  const dropKey = (spaceId: string, folderId: string | null): string => `${spaceId}:${folderId ?? ""}`;

  const mainDrop =
    nav.view === "space"
      ? { spaceId: nav.spaceId, folderId: nav.folderId, key: dropKey(nav.spaceId, nav.folderId) }
      : nav.view === "recent" || nav.view === "search"
        ? {
            spaceId: personal?.id ?? LIBRARY_PERSONAL_SPACE_ID,
            folderId: null,
            key: dropKey(personal?.id ?? LIBRARY_PERSONAL_SPACE_ID, null),
          }
        : null;

  const importDropped = async (spaceId: string, collectionId: string | null, files: FileList): Promise<void> => {
    if (importing) return;
    const paths = collectDroppedLocalFiles(files, (file) => window.api?.getPathForFile?.(file as File) || "");
    if (!paths.length) {
      setToast("无法读取拖入的文件路径，请改用「上传」");
      return;
    }
    setImporting(true);
    try {
      let ok = 0;
      const errors: string[] = [];
      for (const file of paths) {
        const res = await window.api?.library.importFile({
          spaceId,
          collectionId,
          sourcePath: file.path,
        });
        if (res?.ok) ok += 1;
        else errors.push(res && "error" in res ? res.error : `${file.name} 导入失败`);
      }
      await reload();
      if (ok && errors.length === 0) setToast(`已导入 ${ok} 个文件`);
      else if (ok) setToast(`已导入 ${ok} 个，${errors.length} 个失败：${errors[0]}`);
      else setToast(errors[0] ?? "导入失败");
    } finally {
      setImporting(false);
    }
  };

  const acceptFileDrop = (event: React.DragEvent<HTMLElement>, target: string): boolean => {
    if (importing || !dataTransferHasFiles(event.dataTransfer.types)) return false;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(target);
    return true;
  };

  const clearFileDrop = (event: React.DragEvent<HTMLElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setDropTarget(null);
  };

  const handleFileDrop = (
    event: React.DragEvent<HTMLElement>,
    spaceId: string,
    folderId: string | null,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    if (importing || !event.dataTransfer.files?.length) return;
    void importDropped(spaceId, folderId, event.dataTransfer.files);
  };

  const activeSpaceId = nav.view === "space" ? nav.spaceId : personal?.id ?? LIBRARY_PERSONAL_SPACE_ID;
  const activeFolderId = nav.view === "space" ? nav.folderId : null;
  const personalDropKey = dropKey(personal?.id ?? LIBRARY_PERSONAL_SPACE_ID, null);

  return (
    <div className="library-page">
      <aside className="library-rail">
        <div className="library-rail-head">
          <div className="library-rail-title">资料库</div>
        </div>
        <label className="library-rail-search">
          <IconSearch size={14} />
          <input
            placeholder="搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="library-rail-nav">
          <button
            className={`library-rail-item ${nav.view === "recent" ? "active" : ""}`}
            onClick={() => {
              setQuery("");
              setNav({ view: "recent", tab: "visited" });
            }}
          >
            <span className="rail-ico">
              <IconClock size={15} />
            </span>
            最近
          </button>
          <button
            className={`library-rail-item ${nav.view === "artifacts" ? "active" : ""}`}
            onClick={() => {
              setQuery("");
              setNav({ view: "artifacts" });
            }}
          >
            <span className="rail-ico">
              <IconFolder size={15} />
            </span>
            本地产物
          </button>

          <div className="library-rail-section">
            <div className="library-rail-section-row">
              <button
                className={`library-rail-section-btn ${nav.view === "space" && nav.spaceId === (personal?.id ?? LIBRARY_PERSONAL_SPACE_ID) && !nav.folderId ? "active" : ""} ${dropTarget === personalDropKey ? "drop-target" : ""}`}
                onClick={() => {
                  setDocsOpen(true);
                  setQuery("");
                  setNav({ view: "space", spaceId: personal?.id ?? LIBRARY_PERSONAL_SPACE_ID, folderId: null });
                }}
                onDragEnter={(e) => {
                  acceptFileDrop(e, personalDropKey);
                }}
                onDragOver={(e) => {
                  acceptFileDrop(e, personalDropKey);
                }}
                onDragLeave={clearFileDrop}
                onDrop={(e) => handleFileDrop(e, personal?.id ?? LIBRARY_PERSONAL_SPACE_ID, null)}
              >
                <span
                  className="rail-ico"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDocsOpen((v) => !v);
                  }}
                >
                  {docsOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                </span>
                <span className="label">我的文档</span>
              </button>
              <div className="library-type-filter" ref={menu === "docs" ? menuRef : undefined}>
                <button
                  className="library-plus"
                  title="新建"
                  onClick={() => setMenu(menu === "docs" ? null : "docs")}
                >
                  <IconPlus size={14} />
                </button>
                {menu === "docs" && (
                  <div className="library-menu">
                    <button
                      onClick={() => {
                        setMenu(null);
                        openCreateItem("markdown", personal?.id ?? LIBRARY_PERSONAL_SPACE_ID);
                      }}
                    >
                      文档
                    </button>
                    <button
                      onClick={() => {
                        setMenu(null);
                        openCreateItem("csv", personal?.id ?? LIBRARY_PERSONAL_SPACE_ID);
                      }}
                    >
                      表格
                    </button>
                    <button
                      onClick={() => {
                        setMenu(null);
                        openCreateItem("html", personal?.id ?? LIBRARY_PERSONAL_SPACE_ID);
                      }}
                    >
                      页面
                    </button>
                    <button
                      onClick={() => {
                        setMenu(null);
                        setCompose({
                          type: "folder",
                          spaceId: personal?.id ?? LIBRARY_PERSONAL_SPACE_ID,
                          parentId: null,
                          name: "",
                        });
                      }}
                    >
                      文件夹
                    </button>
                    <button
                      onClick={() => {
                        setMenu(null);
                        void importInto(personal?.id ?? LIBRARY_PERSONAL_SPACE_ID);
                      }}
                    >
                      上传文件
                    </button>
                    <button
                      onClick={() => {
                        setMenu(null);
                        void createUrlIn(personal?.id ?? LIBRARY_PERSONAL_SPACE_ID);
                      }}
                    >
                      添加链接
                    </button>
                  </div>
                )}
              </div>
            </div>
            {docsOpen &&
              personalFolders.map((folder) => (
                <div key={folder.id} className="library-children">
                  <button
                    className={`library-child ${
                      nav.view === "space" && nav.spaceId === personalSpaceId && nav.folderId === folder.id ? "active" : ""
                    }`}
                    onClick={() => setNav({ view: "space", spaceId: personalSpaceId, folderId: folder.id })}
                  >
                    <IconFolder size={15} />
                    <span className="name">{folder.name}</span>
                  </button>
                </div>
              ))}
            {docsOpen &&
              personalFiles.map((item) => (
                <div key={item.id} className="library-children">
                  <button
                    className={`library-child ${nav.view === "item" && nav.itemId === item.id ? "active" : ""}`}
                    onClick={() => setNav({ view: "item", itemId: item.id })}
                  >
                    <FileBadge name={filenameFor(item)} size={16} />
                    <span className="name">{item.title}</span>
                  </button>
                </div>
              ))}
          </div>

          <div className="library-rail-section">
            <div className="library-rail-section-row">
              <button className="library-rail-section-btn" onClick={() => setTeamsOpen((v) => !v)}>
                {teamsOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                <span className="label">项目资料</span>
              </button>
              <button className="library-plus" title="新建项目资料" onClick={createProjectSpace}>
                <IconPlus size={14} />
              </button>
            </div>
            {teamsOpen &&
              teams.map((space) => (
                <div key={space.id} className="library-children">
                  <button
                    className={`library-child ${nav.view === "space" && nav.spaceId === space.id ? "active" : ""} ${dropTarget === dropKey(space.id, null) ? "drop-target" : ""}`}
                    onClick={() => setNav({ view: "space", spaceId: space.id, folderId: null })}
                    onDragEnter={(e) => {
                      acceptFileDrop(e, dropKey(space.id, null));
                    }}
                    onDragOver={(e) => {
                      acceptFileDrop(e, dropKey(space.id, null));
                    }}
                    onDragLeave={clearFileDrop}
                    onDrop={(e) => handleFileDrop(e, space.id, null)}
                  >
                    <IconFolder size={15} />
                    <span className="name">{space.projectName ?? space.name}</span>
                  </button>
                </div>
              ))}
          </div>
        </div>
        <div className="library-rail-foot">
          <IconHardDrive size={14} />
          存储空间
          <span>{formatBytes(snap?.storage.usedBytes ?? 0)}</span>
        </div>
      </aside>

      <section
        className={`library-main ${mainDrop && dropTarget === mainDrop.key ? "drag-over" : ""}`}
        onDragEnter={mainDrop ? (e) => { acceptFileDrop(e, mainDrop.key); } : undefined}
        onDragOver={mainDrop ? (e) => { acceptFileDrop(e, mainDrop.key); } : undefined}
        onDragLeave={mainDrop ? clearFileDrop : undefined}
        onDrop={mainDrop ? (e) => handleFileDrop(e, mainDrop.spaceId, mainDrop.folderId) : undefined}
      >
        {mainDrop && dropTarget === mainDrop.key && (
          <div className="library-drop-overlay" aria-hidden>
            松开以上传到「{title === "最近" || title === "搜索" ? "我的文档" : title}」
          </div>
        )}
        {nav.view === "item" ? (
          <LibraryDocumentView
            itemId={nav.itemId}
            onBack={() => setNav({ view: "recent", tab: "visited" })}
            onRenamed={() => void reload()}
            onDeleted={() => {
              void reload();
              setNav({ view: "recent", tab: "visited" });
              setToast("已删除");
            }}
            onToast={setToast}
          />
        ) : (
          <>
            <div className="library-main-head">
              <div className="library-crumb">
                {nav.view === "space" && nav.folderId && (
                  <button
                    className="library-back"
                    onClick={() => setNav({ view: "space", spaceId: nav.spaceId, folderId: null })}
                  >
                    <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} />
                  </button>
                )}
                <div className="library-main-title">{title}</div>
              </div>
              <div className="library-type-filter" ref={menu === "type" ? menuRef : undefined}>
                <button className="library-type-btn" onClick={() => setMenu(menu === "type" ? null : "type")}>
                  {TYPE_OPTIONS.find((o) => o.id === typeFilter)?.label}
                  <IconChevronDown size={12} />
                </button>
                {menu === "type" && (
                  <div className="library-menu">
                    {TYPE_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => {
                          setTypeFilter(opt.id);
                          setMenu(null);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {nav.view === "recent" && (
              <div className="library-tabs" style={{ marginBottom: 14 }}>
                <button
                  className={`library-tab ${nav.tab === "visited" ? "active" : ""}`}
                  onClick={() => setNav({ view: "recent", tab: "visited" })}
                >
                  最近访问
                </button>
                <button
                  className={`library-tab ${nav.tab === "shared-by-me" ? "active" : ""}`}
                  onClick={() => setNav({ view: "recent", tab: "shared-by-me" })}
                >
                  我分享的
                </button>
                <button
                  className={`library-tab ${nav.tab === "shared-with-me" ? "active" : ""}`}
                  onClick={() => setNav({ view: "recent", tab: "shared-with-me" })}
                >
                  与我共享
                </button>
              </div>
            )}

            {nav.view === "space" && (
              <div className="library-toolbar-actions">
                <button type="button" className="btn" onClick={() => openCreateItem("markdown", activeSpaceId, activeFolderId)}>
                  <IconPlus size={13} /> 文档
                </button>
                <button type="button" className="btn" onClick={() => openCreateItem("csv", activeSpaceId, activeFolderId)}>
                  <IconPlus size={13} /> 表格
                </button>
                <button type="button" className="btn" onClick={() => openCreateItem("html", activeSpaceId, activeFolderId)}>
                  <IconPlus size={13} /> 页面
                </button>
                <button type="button" className="btn" onClick={() => createUrlIn(activeSpaceId, activeFolderId)}>
                  添加链接
                </button>
                <button
                  type="button"
                  className="btn"
                  title="选择或拖入本地文件"
                  onClick={() => void importInto(activeSpaceId, activeFolderId)}
                >
                  上传
                </button>
              </div>
            )}

            {nav.view === "recent" && nav.tab !== "visited" ? (
              <div className="library-empty">
                <strong>本地资料库暂不支持云端分享</strong>
                当前版本资料保存在本机。把文档放进「我的文档」或「项目资料」即可给 Agent 检索引用。
              </div>
            ) : visible.length === 0 ? (
              <div className="library-empty">
                <strong>{nav.view === "artifacts" ? "还没有任务产物" : "这里还是空的"}</strong>
                {nav.view === "artifacts"
                  ? "完成任务后生成的 MD / HTML / 表格会出现在这里。"
                  : "点击左栏「+」新建 Markdown、CSV 或 HTML，上传已有文件，或把文件拖到这里。"}
              </div>
            ) : (
              <div className="library-table">
                <div className="library-head">
                  <span>名称</span>
                  <span>所有者</span>
                  <span>位置</span>
                  <span>{nav.view === "recent" ? "最近访问" : "更新"}</span>
                </div>
                {visible.map((row) => (
                  <div
                    key={`${row.source}-${row.id}`}
                    className={`library-row${row.kind === "folder" && dropTarget === dropKey(row.spaceId ?? "", row.id) ? " drop-target" : ""}`}
                    onClick={() => openRow(row)}
                    onDragEnter={
                      row.kind === "folder" && row.spaceId
                        ? (e) => {
                            acceptFileDrop(e, dropKey(row.spaceId!, row.id));
                          }
                        : undefined
                    }
                    onDragOver={
                      row.kind === "folder" && row.spaceId
                        ? (e) => {
                            acceptFileDrop(e, dropKey(row.spaceId!, row.id));
                          }
                        : undefined
                    }
                    onDragLeave={row.kind === "folder" ? clearFileDrop : undefined}
                    onDrop={
                      row.kind === "folder" && row.spaceId
                        ? (e) => handleFileDrop(e, row.spaceId!, row.id)
                        : undefined
                    }
                  >
                    <span className="library-name">
                      {row.kind === "folder" ? <IconFolder size={16} /> : <FileBadge name={filenameFor(row)} size={18} />}
                      <span className="label">{row.title}</span>
                    </span>
                    <span className="library-cell">{row.owner}</span>
                    <span className="library-cell">{row.location}</span>
                    <span className="library-cell">
                      {relativeTime(row.lastVisitedAt ?? row.updatedAt)}
                    </span>
                    <span className="library-row-actions">
                      {row.source === "artifact" && (
                        <span
                          className="library-action"
                          title="保存到资料库"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCompose({
                              type: "save-artifact",
                              artifactId: row.id,
                              title: row.title,
                              spaceId: personal?.id ?? LIBRARY_PERSONAL_SPACE_ID,
                            });
                          }}
                        >
                          保存
                        </span>
                      )}
                      {row.source === "library" && row.kind !== "folder" && (
                        <span
                          className={`library-action ${row.favorite ? "fav-on" : ""}`}
                          title={row.favorite ? "取消收藏" : "收藏"}
                          onClick={(e) => {
                            e.stopPropagation();
                            void window.api?.library.favorite({ id: row.id, favorite: !row.favorite }).then((res) => {
                              if (res?.ok) void reload();
                              else if (res && "error" in res) setToast(res.error);
                            });
                          }}
                        >
                          {row.favorite ? "★" : "☆"}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {compose && (
        <div className="modal-overlay" onClick={() => setCompose(null)}>
          <form
            className="new-project-modal library-compose-modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void submitCompose();
            }}
          >
            <div className="new-project-modal-head">
              <div className="new-project-modal-title">
                {compose.type === "item"
                  ? "新建资料"
                  : compose.type === "folder"
                    ? "新建文件夹"
                    : compose.type === "url"
                      ? "添加链接"
                      : compose.type === "project-space"
                        ? "新建项目资料"
                        : "保存到资料库"}
              </div>
              <button type="button" className="icon-btn" title="关闭" onClick={() => setCompose(null)}>
                <IconX size={16} />
              </button>
            </div>
            <div className="new-project-modal-body">
              {compose.type === "item" && (
                <>
                  <div className="new-project-field">
                    <span className="new-project-label">类型</span>
                    <div className="library-kind-picks">
                      {ITEM_KIND_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`library-kind-pick${compose.kind === opt.id ? " active" : ""}`}
                          onClick={() => setCompose({ ...compose, kind: opt.id })}
                        >
                          <strong>{opt.label}</strong>
                          <span>{opt.hint}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="new-project-field">
                    <span className="new-project-label">名称</span>
                    <input
                      className="new-project-input"
                      value={compose.title}
                      autoFocus
                      placeholder="例如：06批次精制记录"
                      maxLength={LIBRARY_TITLE_MAX_CHARS}
                      onChange={(event) => setCompose({ ...compose, title: event.target.value })}
                    />
                  </label>
                </>
              )}
              {compose.type === "folder" && (
                <label className="new-project-field">
                  <span className="new-project-label">名称</span>
                  <input
                    className="new-project-input"
                    value={compose.name}
                    autoFocus
                    placeholder="文件夹名称"
                    maxLength={LIBRARY_NAME_MAX_CHARS}
                    onChange={(event) => setCompose({ ...compose, name: event.target.value })}
                  />
                </label>
              )}
              {compose.type === "url" && (
                <>
                  <label className="new-project-field">
                    <span className="new-project-label">网址</span>
                    <input
                      className="new-project-input"
                      value={compose.url}
                      autoFocus
                      placeholder="https://"
                      onChange={(event) => setCompose({ ...compose, url: event.target.value })}
                    />
                  </label>
                  <label className="new-project-field">
                    <span className="new-project-label">名称（可选）</span>
                    <input
                      className="new-project-input"
                      value={compose.title}
                      placeholder="不填则用网址"
                      maxLength={LIBRARY_TITLE_MAX_CHARS}
                      onChange={(event) => setCompose({ ...compose, title: event.target.value })}
                    />
                  </label>
                </>
              )}
              {compose.type === "project-space" && (
                <>
                  <label className="new-project-field">
                    <span className="new-project-label">项目</span>
                    <select
                      className="new-project-input"
                      value={compose.projectId}
                      onChange={(event) => {
                        const projectId = event.target.value;
                        const project = projects.find((item) => item.id === projectId);
                        setCompose({
                          ...compose,
                          projectId,
                          name: compose.name.trim() ? compose.name : (project?.name ?? ""),
                        });
                      }}
                    >
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="new-project-field">
                    <span className="new-project-label">资料空间名称</span>
                    <input
                      className="new-project-input"
                      value={compose.name}
                      autoFocus
                      placeholder="默认用项目名"
                      maxLength={LIBRARY_NAME_MAX_CHARS}
                      onChange={(event) => setCompose({ ...compose, name: event.target.value })}
                    />
                  </label>
                </>
              )}
              {compose.type === "save-artifact" && (
                <>
                  <div className="new-project-field">
                    <span className="new-project-label">产物</span>
                    <div className="library-compose-note">{compose.title}</div>
                  </div>
                  <label className="new-project-field">
                    <span className="new-project-label">保存到</span>
                    <select
                      className="new-project-input"
                      value={compose.spaceId}
                      onChange={(event) => setCompose({ ...compose, spaceId: event.target.value })}
                    >
                      {snap?.spaces.map((space) => (
                        <option key={space.id} value={space.id}>
                          {space.kind === "personal" ? "我的文档" : (space.projectName ?? space.name)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
            <div className="new-project-modal-foot">
              <span className="new-project-foot-hint">
                {compose.type === "item"
                  ? "创建后可继续写正文，Agent 能检索这份资料。"
                  : compose.type === "url"
                    ? "只保存链接，不会抓取网页正文。"
                    : compose.type === "save-artifact"
                      ? "保存后由资料库管理，不再依赖任务产物。"
                      : ""}
              </span>
              <div className="new-project-foot-actions">
                <button type="button" className="btn" onClick={() => setCompose(null)}>
                  取消
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  disabled={
                    (compose.type === "item" && !compose.title.trim()) ||
                    (compose.type === "folder" && !compose.name.trim()) ||
                    (compose.type === "url" && !compose.url.trim()) ||
                    (compose.type === "project-space" && !compose.projectId)
                  }
                >
                  {compose.type === "save-artifact" ? "保存" : "创建"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="library-toast">{toast}</div>}
    </div>
  );
}

