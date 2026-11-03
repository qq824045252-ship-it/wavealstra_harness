import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import type { MemorySkillCandidateDto, MemorySkillHistoryDeleteRequest } from "@shared/memory-kernel";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import MemorySkillHistoryControls, { useSkillHistorySelection } from "./MemorySkillHistoryControls";

const LABEL: Record<string, string> = { draft: "待完善", ready: "待批准", materialized: "已生成", stale: "已过期", rejected: "已拒绝" };
const SCOPE: Record<string, string> = { global: "全局", workspace: "工作空间", project: "项目" };
const PAGE_SIZE = 20;
type Group = "pending" | "materialized" | "history";

export default function MemorySkillCandidateReview({ candidates, busy, loading, onDecide, onDelete, onOpenMemory, onOpenSkills }: {
  candidates: MemorySkillCandidateDto[];
  busy: boolean;
  loading: boolean;
  onDecide: (ids: string[], action: "approve" | "reject") => Promise<void>;
  onDelete: (request: MemorySkillHistoryDeleteRequest, label: string) => void;
  onOpenMemory: (id: string) => void;
  onOpenSkills: () => void;
}): React.JSX.Element {
  const [group, setGroup] = useState<Group>("pending");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [state, setState] = useState("all");
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(0);
  const [focusedId, setFocusedId] = useState<string>();
  const [batch, setBatch] = useState<{ ids: string[]; action: "approve" | "reject" } | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => ({
    pending: candidates.filter((item) => item.status === "draft" || item.status === "ready"),
    materialized: candidates.filter((item) => item.status === "materialized"),
    history: candidates.filter((item) => item.status === "stale" || item.status === "rejected"),
  }), [candidates]);
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return groups[group].filter((item) => (scope === "all" || item.scopeType === scope)
      && (state === "all" || item.status === state)
      && words.every((word) => `${item.title}\n${item.description}\n${item.instructions}`.toLocaleLowerCase().includes(word)))
      .sort((a, b) => sort === "evidence" ? b.distinctTaskCount - a.distinctTaskCount || b.evidenceCount - a.evidenceCount || b.updatedAt - a.updatedAt
        : sort === "ready" ? Number(b.status === "ready") - Number(a.status === "ready") || b.updatedAt - a.updatedAt : b.updatedAt - a.updatedAt);
  }, [groups, group, scope, state, query, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = useMemo(() => filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE), [filtered, currentPage]);
  const selection = useSkillHistorySelection(visible, group !== "materialized");
  const count = selection.selectedIds.length;
  const active = visible.find((item) => item.id === focusedId) ?? visible[0];
  const activeIndex = active ? visible.indexOf(active) : -1;
  const locked = busy || loading;
  useEffect(() => { setPage(0); setFocusedId(undefined); }, [group, query, scope, state, sort]);
  useEffect(() => { if (page !== currentPage) setPage(currentPage); }, [page, currentPage]);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = count > 0 && count < visible.length; }, [count, visible.length]);
  useEffect(() => { detailRef.current?.scrollTo(0, 0); }, [active?.id]);
  const changeGroup = (next: Group): void => { selection.clear(); setGroup(next); setState("all"); setPage(0); };
  const decide = async (ids: string[], action: "approve" | "reject"): Promise<void> => {
    const next = visible.find((item, index) => index > activeIndex && !ids.includes(item.id)) ?? visible.find((item) => !ids.includes(item.id));
    await onDecide(ids, action);
    if (next) setFocusedId(next.id);
  };

  return <section className="skill-review" aria-label="技能候选审核">
    <div className="memory-skill-groups" aria-label="技能候选分组">
      {([["pending", "待处理"], ["materialized", "已生成"], ["history", "历史记录"]] as const).map(([id, label]) =>
        <button key={id} type="button" className={`btn ${group === id ? "active" : ""}`} aria-pressed={group === id} disabled={busy} onClick={() => changeGroup(id)}>{label} {groups[id].length}</button>)}
    </div>
    <div className="skill-review-filters">
      <label className="skill-review-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="搜索技能候选" placeholder="搜索标题、描述或技能内容" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} /></label>
      <select className="input" aria-label="技能适用范围" value={scope} disabled={busy} onChange={(event) => setScope(event.target.value)}><option value="all">全部范围</option>{Object.entries(SCOPE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      {group !== "materialized" && <select className="input" aria-label="技能候选状态" value={state} disabled={busy} onChange={(event) => setState(event.target.value)}><option value="all">全部状态</option>{(group === "pending" ? ["ready", "draft"] : ["stale", "rejected"]).map((key) => <option key={key} value={key}>{LABEL[key]}</option>)}</select>}
      <select className="input" aria-label="技能排序" value={sort} disabled={busy} onChange={(event) => setSort(event.target.value)}><option value="recent">最近更新</option><option value="ready">待批准优先</option><option value="evidence">任务与证据最多</option></select>
    </div>
    {group === "history" && <p className="settings-row-desc memory-history-note">历史快照仅供审核。来源变更或删除后，旧候选不会继续生效。</p>}
    {candidates.length >= 1000 && <p className="settings-row-desc">这里显示最近 1000 条记录。</p>}
    {group === "pending" && <div className="skill-review-selection">
      <label className="memory-select-all"><input ref={allRef} type="checkbox" checked={visible.length > 0 && count === visible.length} disabled={locked || !visible.length} onChange={(event) => selection.selectAll(event.currentTarget.checked)} />全选本页</label>
      <span className="settings-row-desc">已选 {count} 条</span>
      <div className="skill-review-batch-actions">
        {count > 0 && <button type="button" className="btn" disabled={locked} onClick={selection.clear}>清空选择</button>}
        <button type="button" className="btn" disabled={locked || !count} onClick={() => setBatch({ ids: selection.selectedIds, action: "reject" })}>批量拒绝{count > 0 ? `（${count}）` : ""}</button>
        <button type="button" className="btn primary" disabled={locked || !count} onClick={() => setBatch({ ids: selection.selectedIds, action: "approve" })}>批量生成{count > 0 ? `（${count}）` : ""}</button>
      </div>
    </div>}
    {group === "history" && <MemorySkillHistoryControls selection={selection} disabled={locked} kind="candidate"
      onDeleteSelected={() => onDelete({ kind: "candidate", ids: selection.selectedIds }, `选中的 ${count} 条技能历史记录`)}
      onDeleteAll={() => onDelete({ kind: "candidate", all: true }, "全部技能历史记录")} />}
    {!visible.length ? <div className="memory-empty skill-review-empty">
      <strong>{loading ? "正在加载候选…" : groups[group].length ? "没有匹配的技能" : group === "pending" ? "暂无待处理流程" : "当前分组暂无记录"}</strong>
      <p>{groups[group].length ? "试试其他关键词，或清除筛选条件。" : group === "pending" ? "点击「评估可学习流程」检查记忆；可复用的方法会进入这里等待审核。" : "处理后的记录会显示在对应分组中。"}</p>
      {(query || scope !== "all" || state !== "all") && <button type="button" className="btn" disabled={busy} onClick={() => { setQuery(""); setScope("all"); setState("all"); }}>清除筛选</button>}
    </div> : <div className="skill-review-workspace">
      <div className="skill-review-queue" aria-label="候选列表">
        <div className="skill-review-list">
          {visible.map((item) => <div key={item.id} className={`skill-review-row ${active?.id === item.id ? "active" : ""}`}>
            {group !== "materialized" && <label className="memory-projection-select"><input type="checkbox" aria-label={`${group === "history" ? "选择技能历史" : "选择技能候选"}：${item.title}`} checked={selection.has(item.id)} disabled={locked} onChange={() => selection.toggle(item.id)} /></label>}
            <button type="button" className="skill-review-open" aria-pressed={active?.id === item.id} disabled={busy} onClick={() => setFocusedId(item.id)}>
              <strong>{item.title}</strong><span className="skill-review-excerpt">{item.description}</span>
              <span className="skill-review-row-meta"><span className={`skill-review-badge ${item.status}`}>{LABEL[item.status]}</span><span>{SCOPE[item.scopeType]} · {item.distinctTaskCount} 个任务</span></span>
            </button>
            {group === "history" && <button type="button" className="skill-review-delete" aria-label={`删除技能历史：${item.title}`} disabled={locked} onClick={() => onDelete({ kind: "candidate", ids: [item.id] }, `「${item.title}」的历史记录`)}>删除</button>}
          </div>)}
        </div>
        <div className="skill-review-pagination"><span>{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} / {filtered.length} 条</span><div><button type="button" className="btn" aria-label="上一页候选" disabled={locked || currentPage === 0} onClick={() => { selection.clear(); setPage(currentPage - 1); }}><ArrowLeft size={14} /></button><span>{currentPage + 1} / {pages}</span><button type="button" className="btn" aria-label="下一页候选" disabled={locked || currentPage + 1 === pages} onClick={() => { selection.clear(); setPage(currentPage + 1); }}><ArrowRight size={14} /></button></div></div>
      </div>
      {active && <article className="skill-review-detail" aria-label="技能审核详情">
        <div className="skill-review-detail-scroll" ref={detailRef}>
          <div className="skill-review-detail-eyebrow"><span className={`skill-review-badge ${active.status}`}>{LABEL[active.status]}</span><span>{SCOPE[active.scopeType]}</span><span>更新于 {new Date(active.updatedAt).toLocaleDateString("zh-CN")}</span></div>
          <h3>{active.title}</h3><p className="skill-review-description">{active.description}</p>
          <div className="skill-review-evidence"><span><strong>{active.distinctTaskCount}</strong> 支持任务</span><span><strong>{active.completedTaskCount}</strong> 已完成</span><span><strong>{active.evidenceCount}</strong> 证据</span></div>
          <h4>{group === "materialized" ? "生成时的技能内容" : "拟议技能内容"}</h4><pre className="skill-review-instructions">{active.instructions}</pre>
          <h4>来源记忆</h4><div className="skill-review-sources">{active.sourceMemoryIds.map((id, index) => <button type="button" className="btn" key={id} disabled={busy} onClick={() => onOpenMemory(id)}>查看来源记忆{active.sourceMemoryIds.length > 1 ? ` ${index + 1}` : ""}</button>)}</div>
        </div>
        <footer className="skill-review-detail-actions">
          <span>{group === "pending" ? "生成后默认关闭自动调用" : group === "materialized" ? "前往技能中心管理和启用" : "历史快照不会继续生效"}</span>
          <div>{group === "pending" ? <><button type="button" className="btn" disabled={locked} onClick={() => void decide([active.id], "reject")}>拒绝</button><button type="button" className="btn primary" disabled={locked} onClick={() => void decide([active.id], "approve")}>{busy ? "处理中…" : "生成技能并继续"}</button></> : active.installedSkillId ? <button type="button" className="btn primary" onClick={onOpenSkills}>在技能中心管理</button> : null}</div>
        </footer>
      </article>}
    </div>}
    <ConfirmDialog open={batch !== null} title={batch?.action === "approve" ? `生成 ${batch.ids.length} 个技能？` : `拒绝 ${batch?.ids.length ?? 0} 条候选？`}
      body={batch && <><p>仅处理本页选中的 {batch.ids.length} 条候选。{batch.action === "approve" ? "请确认已审核拟议内容；生成的技能默认关闭自动调用。" : "候选会移入历史记录，来源记忆保留。"}</p><ul className="skill-review-confirm-list">{batch.ids.map((id) => <li key={id}>{candidates.find((item) => item.id === id)?.title ?? id}</li>)}</ul></>}
      confirmLabel={batch?.action === "approve" ? "确认批量生成" : "确认批量拒绝"} onCancel={() => setBatch(null)} onConfirm={() => { if (batch) { const request = batch; setBatch(null); void decide(request.ids, request.action); } }} />
  </section>;
}
