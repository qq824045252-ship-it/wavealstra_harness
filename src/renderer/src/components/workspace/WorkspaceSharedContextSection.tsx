import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryRecordDto } from "@shared/memory-kernel";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { useAppStore } from "@/store/appStore";
import type {
  WorkspaceSharedContextView,
  WorkspaceSharedContextViewItem,
} from "../../../../shared/workspace-shared-context";
import WorkspaceMemoryEditor from "./WorkspaceMemoryEditor";
import WorkspaceRowMenu, { type WorkspaceRowAction } from "./WorkspaceRowMenu";
import "./WorkspaceMemorySection.css";

interface Props {
  currentSpaceId: string | null;
  taskId?: string | null;
  compact?: boolean;
  className?: string;
}

function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return String(ts);
  }
}

function ContextItemRow({
  item,
  onOpen,
  onPromote,
  onDelete,
  onOpenSource,
  promoting,
}: {
  item: WorkspaceSharedContextViewItem;
  onOpen: (item: WorkspaceSharedContextViewItem) => void;
  onPromote?: (item: WorkspaceSharedContextViewItem) => void;
  onDelete?: (item: WorkspaceSharedContextViewItem) => void;
  onOpenSource?: (item: WorkspaceSharedContextViewItem) => void;
  promoting?: boolean;
}): React.JSX.Element {
  const canManage = item.scope === "local";
  const actions: WorkspaceRowAction[] = [
    { id: "open", label: canManage ? "编辑" : "查看", onClick: () => onOpen(item) },
  ];
  if (canManage && onPromote) {
    actions.push({
      id: "promote",
      label: promoting ? "提升中…" : "提升到父空间",
      disabled: !item.canPromote || Boolean(promoting),
      title: item.promoteDisabledReason,
      onClick: () => onPromote(item),
    });
  }
  if (!canManage && onOpenSource && item.spaceId) {
    actions.push({ id: "source", label: "到来源空间", onClick: () => onOpenSource(item) });
  }
  if (canManage && onDelete) {
    actions.push({ id: "delete", label: "删除", danger: true, separatorBefore: true, onClick: () => onDelete(item) });
  }

  return (
    <article className="workspace-memory-row">
      <button
        type="button"
        className="workspace-memory-row-main"
        onClick={() => onOpen(item)}
        aria-label={`查看上下文：${item.preview || "空内容"}`}
        title={item.content}
      >
        <div className="workspace-memory-row-head">
          <strong title={item.content}>{item.preview || "(空内容)"}</strong>
          <span className={`workspace-memory-scope-chip ${item.scope === "inherited" ? "is-inherited" : "is-direct"}`}>
            {item.scope === "local" ? "当前" : item.scope === "promoted" ? "已提升" : `继承 · ${item.spaceName}`}
          </span>
        </div>
        {item.promotedFrom ? (
          <div className="workspace-memory-scope-note">↳ 提升自 {item.promotedFrom.spaceName ?? item.promotedFrom.spaceId}</div>
        ) : null}
      </button>
      <div className="workspace-memory-row-side">
        <div className="workspace-memory-row-meta">
          <span>来源 {item.spaceName}</span>
          <span>{formatTime(item.updatedAt)}</span>
        </div>
        <WorkspaceRowMenu actions={actions} />
      </div>
    </article>
  );
}

function GroupSection({
  title,
  items,
  emptyHint,
  onOpen,
  onPromote,
  onDelete,
  onOpenSource,
  promotingId,
}: {
  title: string;
  items: WorkspaceSharedContextViewItem[];
  emptyHint: string;
  onOpen: (item: WorkspaceSharedContextViewItem) => void;
  onPromote?: (item: WorkspaceSharedContextViewItem) => void;
  onDelete?: (item: WorkspaceSharedContextViewItem) => void;
  onOpenSource?: (item: WorkspaceSharedContextViewItem) => void;
  promotingId?: string | null;
}): React.JSX.Element {
  return (
    <div className="ws-context-group">
      <div className="ws-context-group-head">
        <span className="ws-context-group-title">{title}</span>
        <span>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="workspace-memory-empty-panel workspace-memory-empty-panel--compact">
          <span>{emptyHint}</span>
        </div>
      ) : (
        <div className="workspace-memory-list">
          {items.map((it) => (
            <ContextItemRow
              key={it.id}
              item={it}
              onOpen={onOpen}
              onPromote={onPromote}
              onDelete={onDelete}
              onOpenSource={onOpenSource}
              promoting={promotingId === it.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function WorkspaceSharedContextSection({
  currentSpaceId,
  taskId,
  compact = false,
  className,
}: Props): React.JSX.Element {
  const openWorkspaceDetail = useAppStore((state) => state.openWorkspaceDetail);
  const [view, setView] = useState<WorkspaceSharedContextView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [inspecting, setInspecting] = useState<{
    item: WorkspaceSharedContextViewItem;
    memory: MemoryRecordDto | null;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSharedContextViewItem | null>(null);
  const [busy, setBusy] = useState(false);
  const fetchSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const promotingRef = useRef(false);
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
    if (typeof window === "undefined" || !window.api?.workspace?.getSharedContextView) {
      return;
    }
    const seq = ++fetchSeqRef.current;
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const v = await window.api.workspace.getSharedContextView({
        currentSpaceId: currentSpaceId ?? null,
        taskId: taskId ?? null,
      });
      if (!mountedRef.current || seq !== fetchSeqRef.current) return;
      setView(v);
    } catch (e) {
      if (!mountedRef.current || seq !== fetchSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!mountedRef.current || seq !== fetchSeqRef.current) return;
      setLoading(false);
    }
  }, [currentSpaceId, taskId]);

  useEffect(() => {
    void fetchView();
    return () => {
      fetchSeqRef.current += 1;
    };
  }, [fetchView]);

  // Refresh on memory changes (promote persistence) and when spaces change (parent rename)
  useEffect(() => {
    const unsub = window.api?.db?.onMemoryChanged?.(() => void fetchView());
    // Poll subtle: if currentSpaceId null, we hide; no need to listen to task changes.
    return () => {
      try {
        unsub?.();
      } catch {}
    };
  }, [fetchView]);

  const handlePromote = useCallback(
    async (item: WorkspaceSharedContextViewItem) => {
      if (!item.canPromote) return;
      if (typeof window === "undefined" || !window.api?.workspace?.promoteSharedContextItem) return;
      if (promotingRef.current) return;
      promotingRef.current = true;
      setPromotingId(item.id);
      setNotice(null);
      if (noticeTimerRef.current !== null) {
        try {
          window.clearTimeout(noticeTimerRef.current);
        } catch {}
        noticeTimerRef.current = null;
      }
      try {
        const res = await window.api.workspace.promoteSharedContextItem({
          itemId: item.id,
          fromSpaceId: item.spaceId,
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          setNotice(res.error);
        } else if (res.alreadyExisted) {
          setNotice(`已存在于父空间「${view?.parentName ?? res.targetParentId}」`);
        } else {
          setNotice(`已提升到父空间「${view?.parentName ?? res.targetParentId}」`);
        }
        await fetchView();
      } catch (e) {
        if (!mountedRef.current) return;
        setNotice(e instanceof Error ? e.message : String(e));
      } finally {
        promotingRef.current = false;
        if (mountedRef.current) setPromotingId(null);
        if (noticeTimerRef.current !== null) {
          try {
            window.clearTimeout(noticeTimerRef.current);
          } catch {}
          noticeTimerRef.current = null;
        }
        if (mountedRef.current) {
          noticeTimerRef.current = window.setTimeout(() => {
            if (!mountedRef.current) return;
            setNotice((cur) => (cur ? null : cur));
          }, 3000);
        }
      }
    },
    [fetchView, view?.parentName],
  );

  const handleOpen = useCallback(async (item: WorkspaceSharedContextViewItem) => {
    try {
      const memory = (await window.api?.memory?.get(item.id)) ?? null;
      if (!mountedRef.current) return;
      setInspecting({ item, memory });
    } catch {
      if (!mountedRef.current) return;
      setInspecting({ item, memory: null });
    }
  }, []);

  const handleDelete = useCallback(async (item: WorkspaceSharedContextViewItem) => {
    if (busy) return;
    setBusy(true);
    try {
      await window.api?.memory?.forget(item.id);
      if (!mountedRef.current) return;
      if (inspecting?.item.id === item.id) setInspecting(null);
      setPendingDelete(null);
      await fetchView();
    } catch (e) {
      if (!mountedRef.current) return;
      setNotice(e instanceof Error ? e.message : String(e));
      setPendingDelete(null);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, fetchView, inspecting?.item.id]);

  // Standalone / no currentSpace: not show pseudo context (product semantics)
  if (currentSpaceId == null) {
    return (
      <div className={`ws-context-section ${className ?? ""} ws-context-standalone`}>
        <div className="ws-context-header">
          <span className="ws-context-title">共享上下文</span>
          <span className="ws-context-subtitle">未绑定空间</span>
        </div>
        <div className="ws-context-empty">未绑定空间 · 仅任务级（当前无）</div>
      </div>
    );
  }

  if (loading && !view) {
    return (
      <div className={`ws-context-section ${className ?? ""}`}>
        <div className="ws-context-header">
          <span className="ws-context-title">共享上下文</span>
        </div>
        <div className="ws-context-empty">正在加载…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`ws-context-section ${className ?? ""}`}>
        <div className="ws-context-header">
          <span className="ws-context-title">共享上下文</span>
        </div>
        <div className="ws-context-error">{error}</div>
      </div>
    );
  }

  if (!view) return <div className={`ws-context-section ${className ?? ""}`} />;

  // Memory disabled: explicit message, hide content (dual-gate consistency)
  if (!view.memoryEnabled) {
    return (
      <div className={`ws-context-section ${className ?? ""} ws-context-disabled`}>
        <div className="ws-context-header">
          <span className="ws-context-title">共享上下文</span>
          <span className="ws-context-subtitle">未启用</span>
        </div>
        <div className="ws-context-empty">记忆已关闭，共享上下文未启用</div>
        <div className="ws-context-hint">在设置中开启“记忆”以启用分层上下文。</div>
      </div>
    );
  }

  // Effective archived: show disabled feedback
  if (view.effectiveArchived) {
    return (
      <div className={`ws-context-section ${className ?? ""} ws-context-archived`}>
        <div className="ws-context-header">
          <span className="ws-context-title">共享上下文</span>
          <span className="ws-context-subtitle">{view.currentSpaceName ?? view.currentSpaceId}</span>
          <span className="ws-context-badge-archived">已归档</span>
        </div>
        <div className="ws-context-empty">当前空间已归档，继承与提升已禁用</div>
      </div>
    );
  }

  const total = view.totalCount;
  const subtitle = view.isRoot
    ? "根空间 · 无父级"
    : view.parentName
      ? `父级：${view.parentName}`
      : "无父级";

  const needle = query.trim().toLowerCase();
  const matchesQuery = (item: WorkspaceSharedContextViewItem): boolean => {
    if (!needle) return true;
    return [item.content, item.preview, item.spaceName, item.scope]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  };
  const filteredGroups = {
    local: view.grouped.local.filter(matchesQuery),
    inherited: view.grouped.inherited.filter(matchesQuery),
    promoted: view.grouped.promoted.filter(matchesQuery),
  };
  const matchedCount = filteredGroups.local.length + filteredGroups.inherited.length + filteredGroups.promoted.length;

  return (
    <section className={`workspace-memory-section ws-context-section ${className ?? ""} ${compact ? "compact" : ""}`}>
      <div className="workspace-memory-header">
        <div>
          <h2>共享上下文</h2>
          <p>{view.currentSpaceName ?? view.currentSpaceId} · {subtitle}。当前空间条目可提升到父级；继承条目只读。</p>
        </div>
        <div className="workspace-memory-counts">
          <span>{total} 条</span>
        </div>
      </div>
      <div className="workspace-memory-toolbar">
        <input
          className="workspace-memory-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索当前可见上下文"
          aria-label="搜索工作空间上下文"
        />
        {needle ? <span className="workspace-memory-search-count">匹配 {matchedCount} / {total}</span> : null}
      </div>
      {notice ? <div className="ws-context-notice">{notice}</div> : null}
      <div className="ws-context-groups">
        <GroupSection
          title="当前空间"
          items={filteredGroups.local}
          emptyHint="当前空间暂无本地条目"
          onOpen={handleOpen}
          onPromote={handlePromote}
          onDelete={(item) => setPendingDelete(item)}
          promotingId={promotingId}
        />
        <GroupSection
          title="继承自父级/祖先"
          items={filteredGroups.inherited}
          emptyHint="无继承条目（父级/祖先为空或已排除归档）"
          onOpen={handleOpen}
          onOpenSource={(item) => openWorkspaceDetail(item.spaceId)}
        />
        <GroupSection
          title="已提升"
          items={filteredGroups.promoted}
          emptyHint="暂无已提升条目"
          onOpen={handleOpen}
          onOpenSource={(item) => openWorkspaceDetail(item.promotedFrom?.spaceId ?? item.spaceId)}
        />
      </div>
      <div className="workspace-memory-footer">当前：可用 · 继承：来自上级 · 隔离：其他同级工作空间默认不可见。右侧 ⋯ 可查看、提升或删除。</div>

      <WorkspaceMemoryEditor
        open={inspecting !== null}
        workspaceId={currentSpaceId}
        creating={false}
        memory={inspecting?.memory ?? null}
        fallbackContent={inspecting?.item.content}
        canManage={inspecting?.item.scope === "local"}
        archived={false}
        sourceName={inspecting && inspecting.item.spaceId !== currentSpaceId ? inspecting.item.spaceName : undefined}
        onClose={() => setInspecting(null)}
        onSaved={() => void fetchView()}
        onRequestDelete={inspecting?.item.scope === "local" ? () => setPendingDelete(inspecting.item) : undefined}
        onOpenSource={inspecting && inspecting.item.spaceId !== currentSpaceId
          ? () => {
              const sourceId = inspecting.item.spaceId;
              setInspecting(null);
              openWorkspaceDetail(sourceId);
            }
          : undefined}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这条上下文？"
        body="删除会同时从「记忆」中移除对应条目。如果它还绑定了上级或其他工作空间，那些空间也会一并失去这条记忆。此操作无法撤销。"
        confirmLabel="删除"
        danger
        onCancel={() => !busy && setPendingDelete(null)}
        onConfirm={() => pendingDelete && void handleDelete(pendingDelete)}
      />
    </section>
  );
}
