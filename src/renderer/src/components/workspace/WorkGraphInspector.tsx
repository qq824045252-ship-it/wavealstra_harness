/**
 * WorkGraphInspector — Phase 6/9 UI (minimal navigator)
 * ADR-001 + Phase 9: Entity detail panel → Related / Depends on / Produced / …
 * Supports: add / remove / jump; grouped by direction+relation; scope-filtered; not a canvas.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkGraphEdgeDto,
  WorkGraphNodeType,
  WorkGraphRelation,
} from "../../../../shared/work-graph";

const RELATIONS: WorkGraphRelation[] = ["RELATES_TO", "DEPENDS_ON", "PRODUCES", "DERIVED_FROM", "BELONGS_TO", "CONTAINS", "SPAWNED"];
const NODE_TYPES: WorkGraphNodeType[] = ["workspace", "task", "project", "plan", "artifact", "library_item", "agent_run"];

interface Props {
  type: WorkGraphNodeType;
  id: string;
  /** Optional scope filter ids (e.g. current project/workspace); matching relations stay, others dimmed. */
  scopeFilter?: Set<string> | string[];
  onNavigate?: (type: WorkGraphNodeType, id: string) => void;
}

const RELATION_HINT: Record<string, string> = {
  RELATES_TO: "通用关联",
  DEPENDS_ON: "依赖（有向 DAG，禁环）",
  PRODUCES: "产出",
  DERIVED_FROM: "溯源",
  BELONGS_TO: "归属",
  CONTAINS: "包含",
  SPAWNED: "派生执行",
};

function label(edge: WorkGraphEdgeDto, selfType: string, selfId: string): string {
  const isOut = edge.fromType === selfType && edge.fromId === selfId;
  const otherType = isOut ? edge.toType : edge.fromType;
  const otherId = isOut ? edge.toId : edge.fromId;
  const dir = isOut ? "→" : "←";
  return `[${edge.relation}] ${dir} ${otherType}:${otherId}`;
}
function groupKey(e: WorkGraphEdgeDto, selfType: string, selfId: string): string {
  const isOut = e.fromType === selfType && e.fromId === selfId;
  return `${isOut ? "out" : "in"}:${e.relation}`;
}

export default function WorkGraphInspector({ type, id, scopeFilter, onNavigate }: Props): React.JSX.Element {
  const [edges, setEdges] = useState<WorkGraphEdgeDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WorkGraphRelation | "">("");
  const [dirFilter, setDirFilter] = useState<"all" | "out" | "in">("all");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ toType: WorkGraphNodeType; toId: string; relation: WorkGraphRelation }>({
    toType: "task",
    toId: "",
    relation: "RELATES_TO",
  });
  const seqRef = useRef(0);
  const scopeSet = scopeFilter ? new Set(Array.isArray(scopeFilter) ? scopeFilter : [...scopeFilter]) : null;

  const fetchEdges = useCallback(async () => {
    const w = window as unknown as {
      api?: {
        workgraph?: {
          listRelated: (req: { type: WorkGraphNodeType; id: string; relation?: WorkGraphRelation }) => Promise<WorkGraphEdgeDto[]>;
        };
      };
    };
    if (!w.api?.workgraph?.listRelated) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await w.api.workgraph.listRelated({ type, id, relation: filter || undefined });
      if (seq !== seqRef.current) return;
      setEdges(list);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [type, id, filter]);

  useEffect(() => { void fetchEdges(); }, [fetchEdges]);

  const handleAdd = useCallback(async () => {
    const w = window as unknown as {
      api?: { workgraph?: { addEdge: (req: unknown) => Promise<{ ok: boolean; error?: string }> } };
    };
    if (!w.api?.workgraph?.addEdge) { setError("workgraph API 未就绪"); return; }
    const toId = form.toId.trim();
    if (!toId) { setError("目标 id 不能为空"); return; }
    setAdding(true);
    setError(null);
    try {
      const res = await w.api.workgraph.addEdge({
        fromType: type,
        fromId: id,
        relation: form.relation,
        toType: form.toType,
        toId,
      });
      if (!res.ok) setError((res as unknown as { error: string }).error ?? "添加失败");
      else await fetchEdges();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setAdding(false); }
  }, [form, type, id, fetchEdges]);

  const handleRemove = useCallback(async (edgeId: string) => {
    const w = window as unknown as {
      api?: { workgraph?: { removeEdge: (edgeId: string) => Promise<{ ok: boolean; error?: string }> } };
    };
    if (!w.api?.workgraph?.removeEdge) return;
    try {
      const res = await w.api.workgraph.removeEdge(edgeId);
      if (!res.ok) setError((res as unknown as { error: string }).error ?? "删除失败");
      else await fetchEdges();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [fetchEdges]);

  const filtered = edges.filter((e) => {
    if (filter && e.relation !== filter) return false;
    if (dirFilter !== "all") {
      const isOut = e.fromType === type && e.fromId === id;
      if (dirFilter === "out" && !isOut) return false;
      if (dirFilter === "in" && isOut) return false;
    }
    // scopeFilter does not hide; handled via dimming below, so keep all here
    return true;
  });
  const groups = (() => {
    const map = new Map<string, WorkGraphEdgeDto[]>();
    for (const e of filtered) {
      const k = groupKey(e, type, id);
      const arr = map.get(k) ?? [];
      arr.push(e);
      map.set(k, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  })();

  return (
    <div className="workgraph-inspector">
      <div className="workgraph-inspector-head">
        <span className="workgraph-inspector-title">关联 · {type}:{id}</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value as WorkGraphRelation | "")} title="按 relation 过滤（刻意可解释）">
          <option value="">全部 relation</option>
          {RELATIONS.map((r) => <option key={r} value={r} title={RELATION_HINT[r]}>{r}</option>)}
        </select>
        <select value={dirFilter} onChange={(e) => setDirFilter(e.target.value as typeof dirFilter)} title="按方向过滤（出/入）">
          <option value="all">全部方向</option>
          <option value="out">发出 →</option>
          <option value="in">收到 ←</option>
        </select>
        <button type="button" onClick={() => void fetchEdges()} disabled={loading}>刷新</button>
      </div>
      {error && <div className="workgraph-inspector-error">{error}</div>}
      <div className="workgraph-inspector-list">
        {loading && edges.length === 0 ? <div className="workgraph-inspector-empty">加载中…</div> : null}
        {!loading && filtered.length === 0 ? <div className="workgraph-inspector-empty">暂无关联（已按过滤条件）</div> : null}
        {groups.map(([gk, list]) => (
          <div key={gk} className="workgraph-inspector-group">
            <div className="workgraph-inspector-group-head">{gk} · {list.length}</div>
            {list.map((e) => {
              const isOut = e.fromType === type && e.fromId === id;
              const targetType = isOut ? e.toType : e.fromType;
              const targetId = isOut ? e.toId : e.fromId;
              const dimmed = Boolean(scopeSet && !scopeSet.has(targetId));
              return (
                <div key={e.id} className={`workgraph-inspector-edge${dimmed ? " dimmed" : ""}`} title={dimmed ? "不在当前作用域，已弱化显示" : undefined}>
                  <span className="workgraph-inspector-edge-label" title={`${e.id} · ${RELATION_HINT[e.relation] ?? ""}`}>{label(e, type, id)}</span>
                  <button type="button" className="workgraph-inspector-jump" onClick={() => onNavigate?.(targetType, targetId)} title={`跳转到 ${targetType}:${targetId}`}>跳转</button>
                  <button type="button" className="workgraph-inspector-remove" onClick={() => void handleRemove(e.id)} title="删除此关联（仅删 relation，不删实体）">删除</button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="workgraph-inspector-add">
        <select value={form.relation} onChange={(e) => setForm((s) => ({ ...s, relation: e.target.value as WorkGraphRelation }))} title={RELATION_HINT[form.relation]}>
          {RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select value={form.toType} onChange={(e) => setForm((s) => ({ ...s, toType: e.target.value as WorkGraphNodeType }))}>
          {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="目标 id" value={form.toId} onChange={(e) => setForm((s) => ({ ...s, toId: e.target.value }))} />
        <button type="button" onClick={() => void handleAdd()} disabled={adding}>{adding ? "添加中…" : "添加关联"}</button>
      </div>
      <div className="workgraph-inspector-hint">关联 ≠ 层级 · 不改变上下文与权限 · DEPENDS_ON/SPAWNED 为 DAG（禁环）· 其它 relation 可环。</div>
    </div>
  );
}
