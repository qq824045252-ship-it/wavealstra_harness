import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkspaceLibraryBindingInheritedItem,
  WorkspaceLibraryBindingItem,
  WorkspaceLibraryBindingListView,
} from "../../../../shared/workspace-library-binding";
import "./WorkspaceMemorySection.css";
import "./WorkspaceNotesSection.css";
import { useAppStore } from "@/store/appStore";

interface Props {
  currentSpaceId: string | null;
  compact?: boolean;
  className?: string;
}

function kindLabel(kind: "personal" | "team"): string {
  return kind === "personal" ? "个人" : "团队";
}

function bindingKey(item: WorkspaceLibraryBindingItem): string {
  return item.collectionId ? `collection:${item.collectionId}` : `space:${item.librarySpaceId}`;
}

function LibraryRow({
  item,
  actionLabel,
  onAction,
  busy,
  inheritedFrom,
}: {
  item: WorkspaceLibraryBindingItem;
  actionLabel: string;
  onAction: () => void;
  busy?: boolean;
  inheritedFrom?: string;
}): React.JSX.Element {
  const isInherited = inheritedFrom !== undefined;
  const sourceName = inheritedFrom || "父级";
  return (
    <article
      className="workspace-memory-row"
      title={item.collectionId ? `collectionId=${item.collectionId}` : `librarySpaceId=${item.librarySpaceId}`}
    >
      <div className="workspace-memory-row-main">
        <div className="workspace-memory-row-head">
          <strong title={item.path ?? item.name}>{item.name}</strong>
          <span className="workspace-memory-kind">
            {item.targetType === "collection" ? "文件夹" : `${kindLabel(item.kind)}资料库`}
          </span>
          {isInherited && <span className="workspace-memory-scope-chip is-inherited">继承 · {sourceName}</span>}
        </div>
        <div className="workspace-memory-scope-note">位置：{item.path ?? `资料库 / ${item.name}`}</div>
        <div className="workspace-memory-scope-note">范围：{item.targetType === "collection" ? "该文件夹及全部子文件夹" : "整个资料库（包括以后新增的内容）"}</div>
        {isInherited && <div className="workspace-memory-scope-note">↳ 不可在此移除，到「{sourceName}」取消绑定</div>}
      </div>
        <div className="workspace-memory-row-side">
          <button type="button" className="ws-binding-action" onClick={() => useAppStore.getState().requestLibraryNav({ view: "space", spaceId: item.librarySpaceId, folderId: item.collectionId ?? null })}>打开位置</button>
          {actionLabel && (
          <button
            type="button"
            className="ws-binding-action"
            disabled={busy}
            onClick={onAction}
          >
            {busy ? "处理中…" : actionLabel}
          </button>
          )}
        </div>
    </article>
  );
}

function LibraryGroup({
  title,
  count,
  emptyHint,
  children,
}: {
  title: string;
  count: number;
  emptyHint: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="ws-context-group">
      <div className="ws-context-group-head">
        <span className="ws-context-group-title">{title}</span>
        <span>{count}</span>
      </div>
      {count === 0 ? (
        <div className="ws-binding-empty">{emptyHint}</div>
      ) : (
        <div className="workspace-memory-list">{children}</div>
      )}
    </div>
  );
}

export default function WorkspaceLibraryBindingsSection({
  currentSpaceId,
  compact = false,
  className,
}: Props): React.JSX.Element {
  const [view, setView] = useState<WorkspaceLibraryBindingListView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [destination, setDestination] = useState("");
  const space = useAppStore(state => state.spaces.find(s => s.id === currentSpaceId));
  const fetchSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const noticeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fetchSeqRef.current += 1;
      if (noticeTimerRef.current !== null) {
        try {
          window.clearTimeout(noticeTimerRef.current);
        } catch {}
        noticeTimerRef.current = null;
      }
    };
  }, []);

  const fetchView = useCallback(async () => {
    if (currentSpaceId == null) {
      setView(null);
      setLoading(false);
      setError(null);
      return;
    }
    if (typeof window === "undefined" || !window.api?.workspace?.libraryBindings?.list) return;
    const seq = ++fetchSeqRef.current;
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const v = await window.api.workspace.libraryBindings.list(currentSpaceId);
      if (!mountedRef.current || seq !== fetchSeqRef.current) return;
      setView(v);
    } catch (e) {
      if (!mountedRef.current || seq !== fetchSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!mountedRef.current || seq !== fetchSeqRef.current) return;
      setLoading(false);
    }
  }, [currentSpaceId]);

  useEffect(() => {
    void fetchView();
    return () => {
      fetchSeqRef.current += 1;
    };
  }, [fetchView]);

  const flashNotice = useCallback((message: string) => {
    if (!mountedRef.current) return;
    setNotice(message);
    if (noticeTimerRef.current !== null) {
      try {
        window.clearTimeout(noticeTimerRef.current);
      } catch {}
      noticeTimerRef.current = null;
    }
    noticeTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setNotice(null);
    }, 3000);
  }, []);

  const handleBind = useCallback(
    async (item: WorkspaceLibraryBindingItem) => {
      if (currentSpaceId == null) return;
      if (typeof window === "undefined" || !window.api?.workspace?.libraryBindings?.bind) return;
      if (busyId) return;
      const key = bindingKey(item);
      setBusyId(`bind:${key}`);
      try {
        const res = await window.api.workspace.libraryBindings.bind({
          workspaceId: currentSpaceId,
          librarySpaceId: item.librarySpaceId,
          collectionId: item.collectionId,
        });
        if (res.ok) flashNotice("已绑定到当前空间");
        else flashNotice(res.error);
        await fetchView();
      } catch (e) {
        flashNotice(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, currentSpaceId, fetchView, flashNotice],
  );

  const handleUnbind = useCallback(
    async (item: WorkspaceLibraryBindingItem) => {
      if (currentSpaceId == null) return;
      if (typeof window === "undefined" || !window.api?.workspace?.libraryBindings?.unbind) return;
      if (busyId) return;
      const key = bindingKey(item);
      setBusyId(`unbind:${key}`);
      try {
        const res = await window.api.workspace.libraryBindings.unbind({
          workspaceId: currentSpaceId,
          librarySpaceId: item.librarySpaceId,
          collectionId: item.collectionId,
        });
        if (res.ok) flashNotice("已从当前空间移除绑定");
        else flashNotice(res.error);
        await fetchView();
      } catch (e) {
        flashNotice(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, currentSpaceId, fetchView, flashNotice],
  );

  if (currentSpaceId == null) {
    return (
      <section className={`workspace-memory-section ws-context-section ${className ?? ""} ws-binding-standalone`}>
        <div className="workspace-memory-header">
          <div>
            <h2>资料库绑定</h2>
            <p>未绑定空间 · 不参与工作空间检索</p>
          </div>
        </div>
      </section>
    );
  }

  if (loading && !view) {
    return (
      <section className={`workspace-memory-section ws-context-section ${className ?? ""}`}>
        <div className="workspace-memory-header">
          <div>
            <h2>资料库绑定</h2>
          </div>
        </div>
        <div className="workspace-memory-empty-panel">
          <strong>正在加载…</strong>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={`workspace-memory-section ws-context-section ${className ?? ""}`}>
        <div className="workspace-memory-header">
          <div>
            <h2>资料库绑定</h2>
          </div>
        </div>
        <div className="workspace-memory-error">{error}</div>
      </section>
    );
  }

  if (!view) return <section className={`workspace-memory-section ws-context-section ${className ?? ""}`} />;

  const inherited: WorkspaceLibraryBindingInheritedItem[] = view.inherited;
  const addable: WorkspaceLibraryBindingItem[] = view.addable;

  return (
    <section className={`workspace-memory-section ws-context-section ${className ?? ""} ${compact ? "compact" : ""}`}>
      <div className="workspace-memory-header">
        <div>
          <h2>资料库绑定</h2>
          <p>{view.workspaceName ?? view.workspaceId} · 选择任务可检索的资料位置。绑定后可按需读取正文，不会把整个库自动塞入上下文。</p>
        </div>
        <div className="workspace-memory-counts">
          <span>当前 {view.direct.length}</span>
          <span>继承 {inherited.length}</span>
        </div>
      </div>
      {notice && <div className="ws-context-notice">{notice}</div>}
      <div className="ws-binding-location">
        <strong>空间本地文件夹</strong><code>{space?.path ?? "尚未连接本地文件夹"}</code>
        <button className="ws-binding-action" onClick={() => { if (currentSpaceId) void useAppStore.getState().relocateSpace(currentSpaceId).catch(e => flashNotice(String(e))); }}>选择 / 更换本地文件夹</button>
        <p>本地文件从空间「文件」页访问。下方绑定的是资料库内的文档位置；本地文件不会因绑定而自动导入。</p>
        {view.libraryStoragePath && <code>资料库存储：{view.libraryStoragePath}</code>}
      </div>
      <form className="ws-binding-create" onSubmit={async e => {
        e.preventDefault(); if (busyId || !folderName.trim() || !currentSpaceId) return;
        const librarySpaceId = destination || view.destinations?.[0]?.id;
        if (!librarySpaceId) return;
        setBusyId("create");
        try {
          const result = await window.api!.workspace.libraryBindings.createFolder({ workspaceId: currentSpaceId, librarySpaceId, name: folderName.trim() });
          if (!result.ok) throw new Error(result.error);
          setFolderName(""); flashNotice("已创建资料库文件夹并绑定"); await fetchView();
        } catch (e) { flashNotice(String(e)); } finally { setBusyId(null); }
      }}>
        <select aria-label="新文件夹所属资料库" value={destination || view.destinations?.[0]?.id || ""} onChange={e => setDestination(e.target.value)}>{view.destinations?.map(ls => <option key={ls.id} value={ls.id}>{ls.name}</option>)}</select>
        <input aria-label="资料库文件夹名称" maxLength={100} value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="例如：部署说明" />
        <button type="submit" className="btn" disabled={!!busyId || !folderName.trim() || !view.destinations?.length}>新建文件夹并绑定</button>
        <button type="button" className="btn btn--ghost" onClick={() => useAppStore.getState().requestLibraryNav({ view: "space", spaceId: destination || view.destinations?.[0]?.id || "personal", folderId: null })}>管理资料库</button>
      </form>
      <div className="ws-context-groups">
        <LibraryGroup title="当前空间" count={view.direct.length} emptyHint="当前空间未直接绑定资料库">
          {view.direct.map((item) => (
            <LibraryRow
              key={bindingKey(item)}
              item={item}
              actionLabel="取消绑定"
              busy={busyId === `unbind:${bindingKey(item)}`}
              onAction={() => void handleUnbind(item)}
            />
          ))}
        </LibraryGroup>

        <LibraryGroup title="继承自父级/祖先" count={inherited.length} emptyHint="无继承绑定（父级/祖先未绑定资料库）">
          {inherited.map((item) => (
            <LibraryRow
              key={`${bindingKey(item)}:${item.sourceWorkspaceId}`}
              item={item}
              actionLabel=""
              inheritedFrom={item.sourceWorkspaceName ?? item.sourceWorkspaceId}
              onAction={() => {}}
            />
          ))}
        </LibraryGroup>

        <LibraryGroup title="选择绑定位置" count={addable.length} emptyHint="所有现有位置已覆盖；也可新建文件夹后绑定">
          {addable.map((item) => (
            <LibraryRow
              key={bindingKey(item)}
              item={item}
              actionLabel={item.targetType === "collection" ? "绑定此文件夹" : "绑定整个资料库"}
              busy={busyId === `bind:${bindingKey(item)}`}
              onAction={() => void handleBind(item)}
            />
          ))}
        </LibraryGroup>
      </div>
      <div className="workspace-memory-footer">当前：直接绑定 · 继承：来自上级 · 隔离：未绑定的同级资料库默认不可见。</div>
    </section>
  );
}
