import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryRecordDto, MemorySearchHit } from "@shared/memory-kernel";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { useAppStore } from "@/store/appStore";
import { getWorkspaceBreadcrumb } from "@/lib/workspaceDisplay";
import WorkspaceMemoryEditor, {
  formatMemoryTime,
  KIND_LABEL,
  otherWorkspaceScopes,
} from "./WorkspaceMemoryEditor";
import WorkspaceRowMenu, { type WorkspaceRowAction } from "./WorkspaceRowMenu";
import "./WorkspaceMemorySection.css";

type ScopeFilter = "all" | "direct" | "inherited";

function matchingWorkspaceScope(memory: MemoryRecordDto, visibleIds: string[]): string | null {
  for (let index = visibleIds.length - 1; index >= 0; index -= 1) {
    const id = visibleIds[index];
    if (memory.scopes.some((scope) => scope.scopeType === "workspace" && scope.scopeId === id)) return id;
  }
  return null;
}

function MemoryRow({
  hit,
  workspaceId,
  visibleIds,
  workspaceNames,
  canManage,
  onOpen,
  onDelete,
  onOpenSource,
}: {
  hit: MemorySearchHit;
  workspaceId: string;
  visibleIds: string[];
  workspaceNames: Map<string, string>;
  canManage: boolean;
  onOpen: () => void;
  onDelete?: () => void;
  onOpenSource?: () => void;
}): React.JSX.Element {
  const memory = hit.memory;
  const sourceWorkspaceId = matchingWorkspaceScope(memory, visibleIds);
  const direct = sourceWorkspaceId === workspaceId;
  const sourceName = sourceWorkspaceId ? workspaceNames.get(sourceWorkspaceId) ?? sourceWorkspaceId : "工作空间";
  const actions: WorkspaceRowAction[] = [
    { id: "open", label: canManage ? "编辑" : "查看", onClick: onOpen },
  ];
  if (onOpenSource) actions.push({ id: "source", label: "到来源空间", onClick: onOpenSource });
  if (onDelete) actions.push({ id: "delete", label: "删除", danger: true, separatorBefore: true, onClick: onDelete });

  return (
    <article className="workspace-memory-row">
      <button
        type="button"
        className="workspace-memory-row-main"
        onClick={onOpen}
        aria-label={`查看记忆：${memory.title || "未命名记忆"}`}
      >
        <div className="workspace-memory-row-head">
          <strong title={memory.title}>{memory.title || "未命名记忆"}</strong>
          <span className="workspace-memory-kind">{KIND_LABEL[memory.kind] ?? memory.kind}</span>
          <span className={`workspace-memory-scope-chip ${direct ? "is-direct" : "is-inherited"}`}>
            {direct ? "当前" : `继承 · ${sourceName}`}
          </span>
        </div>
        {memory.content ? <div className="workspace-memory-content" title={memory.content}>{memory.content}</div> : null}
      </button>
      <div className="workspace-memory-row-side">
        <div className="workspace-memory-row-meta">
          <span>重要度 {memory.importance}</span>
          <span>{formatMemoryTime(memory.updatedAt)}</span>
        </div>
        <WorkspaceRowMenu actions={actions} />
      </div>
    </article>
  );
}

export default function WorkspaceMemorySection({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const spaces = useAppStore((state) => state.spaces);
  const openWorkspaceDetail = useAppStore((state) => state.openWorkspaceDetail);
  const [hits, setHits] = useState<MemorySearchHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [creating, setCreating] = useState(false);
  const [inspecting, setInspecting] = useState<MemoryRecordDto | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemoryRecordDto | null>(null);
  const [busy, setBusy] = useState(false);

  const breadcrumb = useMemo(() => getWorkspaceBreadcrumb(spaces as any, workspaceId), [spaces, workspaceId]);
  const visibleIds = useMemo(() => breadcrumb.map((segment) => segment.id), [breadcrumb]);
  const workspaceNames = useMemo(() => new Map(spaces.map((space) => [space.id, space.name])), [spaces]);
  const space = useMemo(() => spaces.find((item) => item.id === workspaceId) ?? null, [spaces, workspaceId]);
  const archived = Boolean(space?.archived || space?.effectiveArchived);

  const load = useCallback(async (): Promise<void> => {
    const api = window.api?.memory;
    if (!api) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.search({
        workspaceId,
        scopeTypes: ["workspace"],
        statuses: ["active"],
        includeInherited: true,
        limit: 100,
      });
      setHits(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setHits([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = window.api?.db?.onMemoryChanged?.(() => void load());
    return () => {
      try { unsubscribe?.(); } catch {}
    };
  }, [load]);

  const isDirect = useCallback((memory: MemoryRecordDto): boolean => (
    memory.scopes.some((scope) => scope.scopeType === "workspace" && scope.scopeId === workspaceId)
  ), [workspaceId]);

  const allDirect = useMemo(() => hits.filter(({ memory }) => isDirect(memory)).length, [hits, isDirect]);
  const allInherited = hits.length - allDirect;

  const visibleHits = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return hits.filter(({ memory }) => {
      const direct = isDirect(memory);
      if (scopeFilter === "direct" && !direct) return false;
      if (scopeFilter === "inherited" && direct) return false;
      if (!needle) return true;
      return [memory.title, memory.content, memory.kind]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [hits, isDirect, query, scopeFilter]);

  const noMemoryAtAll = !loading && !error && hits.length === 0;
  const noFilteredResult = !loading && !error && hits.length > 0 && visibleHits.length === 0;
  const editorOpen = creating || inspecting !== null;
  const inspectingDirect = inspecting ? isDirect(inspecting) : false;
  const inspectingSourceId = inspecting ? matchingWorkspaceScope(inspecting, visibleIds) : null;
  const inspectingSourceName = inspectingSourceId && inspectingSourceId !== workspaceId
    ? workspaceNames.get(inspectingSourceId) ?? inspectingSourceId
    : undefined;

  const remove = async (memory: MemoryRecordDto): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await window.api?.memory?.forget(memory.id);
      if (inspecting?.id === memory.id) setInspecting(null);
      setCreating(false);
      setPendingDelete(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  };

  const extraScopeCount = pendingDelete ? otherWorkspaceScopes(pendingDelete, workspaceId).length : 0;

  return (
    <section className="workspace-memory-section">
      <div className="workspace-memory-header">
        <div>
          <h2>工作空间记忆</h2>
          <p>沉淀长期事实、决策、约束、风险与进度；上级工作空间记忆会按层级继承。</p>
        </div>
        <div className="workspace-memory-counts">
          <span>当前 {allDirect}</span>
          <span>继承 {allInherited}</span>
        </div>
      </div>

      <div className="workspace-memory-toolbar">
        <input
          className="workspace-memory-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索此工作空间可见记忆"
          aria-label="搜索工作空间记忆"
        />
        <div className="workspace-memory-filter" role="group" aria-label="记忆范围">
          <button type="button" className={scopeFilter === "all" ? "active" : ""} onClick={() => setScopeFilter("all")}>全部 {hits.length}</button>
          <button type="button" className={scopeFilter === "direct" ? "active" : ""} onClick={() => setScopeFilter("direct")}>当前 {allDirect}</button>
          <button type="button" className={scopeFilter === "inherited" ? "active" : ""} onClick={() => setScopeFilter("inherited")}>继承 {allInherited}</button>
        </div>
        {!archived ? (
          <button type="button" className="workspace-memory-add" onClick={() => { setInspecting(null); setCreating(true); }}>
            添加
          </button>
        ) : null}
      </div>

      {loading ? <div className="workspace-memory-empty-panel"><strong>正在加载记忆…</strong></div> : null}
      {!loading && error ? <div className="workspace-memory-error">{error}</div> : null}

      {noMemoryAtAll ? (
        <div className="workspace-memory-empty-panel">
          <strong>暂无工作空间记忆</strong>
          <span>后续沉淀的事实、决策、约束和进度会集中显示在这里。也可以手动添加一条长期记忆。</span>
        </div>
      ) : null}

      {noFilteredResult ? (
        <div className="workspace-memory-empty-panel">
          <strong>没有匹配的记忆</strong>
          <span>换一个关键词或切换记忆范围。</span>
        </div>
      ) : null}

      {!loading && !error && visibleHits.length > 0 ? (
        <div className="workspace-memory-list">
          {visibleHits.map((hit) => {
            const direct = isDirect(hit.memory);
            const sourceId = matchingWorkspaceScope(hit.memory, visibleIds);
            return (
              <MemoryRow
                key={hit.memory.id}
                hit={hit}
                workspaceId={workspaceId}
                visibleIds={visibleIds}
                workspaceNames={workspaceNames}
                canManage={direct && !archived}
                onOpen={() => { setCreating(false); setInspecting(hit.memory); }}
                onDelete={direct && !archived ? () => setPendingDelete(hit.memory) : undefined}
                onOpenSource={!direct && sourceId ? () => openWorkspaceDetail(sourceId) : undefined}
              />
            );
          })}
        </div>
      ) : null}

      <div className="workspace-memory-footer">记忆是长期认知；“上下文”是当前 Agent 运行时从记忆及其他来源组装出的可用投影。</div>

      <WorkspaceMemoryEditor
        open={editorOpen}
        workspaceId={workspaceId}
        creating={creating}
        memory={inspecting}
        canManage={creating || (inspectingDirect && !archived)}
        archived={archived}
        sourceName={inspectingSourceName}
        onClose={() => { setCreating(false); setInspecting(null); }}
        onSaved={() => void load()}
        onRequestDelete={inspecting && inspectingDirect && !archived ? () => setPendingDelete(inspecting) : undefined}
        onOpenSource={inspectingSourceId && inspectingSourceId !== workspaceId
          ? () => {
              setCreating(false);
              setInspecting(null);
              openWorkspaceDetail(inspectingSourceId);
            }
          : undefined}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这条记忆？"
        body={
          extraScopeCount > 0
            ? `这条记忆还出现在 ${extraScopeCount} 个其他工作空间中（含上级继承）。删除会一并移除，且无法撤销。`
            : "删除后，绑定此工作空间的任务将不再看到这条认知，此操作无法撤销。过时信息也可以先标为「已取代」或「已解决」。"
        }
        confirmLabel="删除"
        danger
        onCancel={() => !busy && setPendingDelete(null)}
        onConfirm={() => pendingDelete && void remove(pendingDelete)}
      />
    </section>
  );
}
