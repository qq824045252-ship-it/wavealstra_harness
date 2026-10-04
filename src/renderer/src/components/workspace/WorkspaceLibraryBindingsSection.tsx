import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkspaceLibraryBindingInheritedItem,
  WorkspaceLibraryBindingItem,
  WorkspaceLibraryBindingListView,
} from "../../../../shared/workspace-library-binding";
import "./WorkspaceMemorySection.css";

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
        {item.targetType === "collection" && item.path && (
          <div className="workspace-memory-scope-note">{item.path}</div>
        )}
        {isInherited && <div className="workspace-memory-scope-note">↳ 不可在此移除，到「{sourceName}」取消绑定</div>}
      </div>
      {actionLabel && (
        <div className="workspace-memory-row-side">
          <button
            type="button"
            className="ws-binding-action"
            disabled={busy}
            onClick={onAction}
          >
            {busy ? "处理中…" : actionLabel}
          </button>
        </div>
      )}
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
          <p>{view.workspaceName ?? view.workspaceId} · 可绑定整个资料库或单独文件夹；文件夹作用域包含其子文件夹。</p>
        </div>
        <div className="workspace-memory-counts">
          <span>当前 {view.direct.length}</span>
          <span>继承 {inherited.length}</span>
        </div>
      </div>
      {notice && <div className="ws-context-notice">{notice}</div>}
      <div className="ws-context-groups">
        <LibraryGroup title="当前空间" count={view.direct.length} emptyHint="当前空间未直接绑定资料库">
          {view.direct.map((item) => (
            <LibraryRow
              key={bindingKey(item)}
              item={item}
              actionLabel="移除"
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

        <LibraryGroup title="可添加" count={addable.length} emptyHint="没有可添加的资料库或文件夹">
          {addable.map((item) => (
            <LibraryRow
              key={bindingKey(item)}
              item={item}
              actionLabel="添加"
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
