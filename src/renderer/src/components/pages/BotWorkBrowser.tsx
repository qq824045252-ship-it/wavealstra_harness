import { nextWatchCheckAt } from "@/lib/botWatchPresentation";
import { BotWorkArchiveActions } from "./BotWorkArchiveActions";
import { isWorkArchived } from "@shared/bot-work-archive";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import { IconChevronRight, IconListTodo, IconSearch, IconX } from "@/components/common/icons";
import { workCardExcerpt, workMatchesSearch, workMatchesView, workSearchText, workStatus, type WorkStatusGroup } from "@/lib/botWorkspacePresentation";

const PAGE_SIZE = 24;
const activeFilters: Array<{ id: WorkStatusGroup; label: string }> = [
  { id: "running", label: "执行中" }, { id: "attention", label: "需处理" },
  { id: "results", label: "核对结果" }, { id: "waiting", label: "等待执行 / 恢复" },
  { id: "watching", label: "持续关注" }, { id: "paused", label: "已暂停" },
];
const closedFilters: Array<{ id: WorkStatusGroup; label: string }> = [
  { id: "succeeded", label: "已完成" },
  { id: "cancelled", label: "已取消" },
  { id: "unsuccessful", label: "未达成" }, { id: "ended", label: "其他结束记录" },
];

/** Bounded rendering only: every loaded Work remains searchable and reachable. */
export function BotWorkBrowser({ works, view, loading, selectedWorkId, onOpenWork, onConversation, hidden, scrollRef }: {
  hidden?: boolean;
  scrollRef?: RefObject<HTMLElement | null>;
  works: WorkProjectionDto[];
  view: "active" | "completed" | "closed";
  loading: boolean;
  selectedWorkId?: string | null;
  onOpenWork: (id: string) => void;
  onConversation: () => void;
}): React.JSX.Element {
  const [showDeleted, setShowDeleted] = useState(false);
  const deletedCount = works.filter(work => work.archive?.deletedAt).length;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorkStatusGroup | "all">("all");
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);
  const internalRef = useRef<HTMLElement>(null);
  const browserRef = scrollRef ?? internalRef;
  const index = useMemo(() => works.filter(work => view === "closed" && showDeleted ? Boolean(work.archive?.deletedAt) && isWorkArchived(work) : workMatchesView(work, view))
    .map(work => ({ work, status: workStatus(work), text: workSearchText(work) })), [works, view, showDeleted]);
  const searched = useMemo(() => index.filter(item => workMatchesSearch(item.text, query)), [index, query]);
  const filtered = useMemo(() => searched.filter(item => filter === "all" || item.status.group === filter)
    .sort((a, b) => (sort === "oldest" ? a.work.updatedAt - b.work.updatedAt : b.work.updatedAt - a.work.updatedAt)
      || a.work.workId.localeCompare(b.work.workId)), [searched, filter, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  useEffect(() => { setPage(previous => Math.min(previous, pages)); }, [pages]);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const filters = view === "active" ? activeFilters : view === "completed" ? [] : closedFilters;
  const heading = view === "active" ? "进行中" : view === "completed" ? "已完成" : "归档";
  const description = view === "active" ? "执行、等待和结果核对中的委托。完成后自动归入已完成。" : view === "completed" ? "已确认完成的委托，随时查看结果和交付文件。" : "已收起的完成与失败记录。删除记录可恢复，不删除成果文件。";
  const isFiltered = Boolean(query.trim() || filter !== "all");
  const restartPage = () => { setPage(1); browserRef.current?.scrollTo({ top: 0 }); };
  const reset = () => { setQuery(""); setFilter("all"); restartPage(); };
  const goToPage = (next: number) => { setPage(next); browserRef.current?.scrollTo({ top: 0 }); };
  return <section className="bot-work-browser" hidden={hidden} ref={browserRef} tabIndex={-1} aria-label={`${heading}事项`}>
    <header className="bot-list-heading"><div><h2>{heading}<span className="bot-list-total">{loading ? "…" : index.length}</span></h2><p>{description}</p></div>{view === "closed" && (deletedCount > 0 || showDeleted) && <label className="bot-archive-deleted"><input type="checkbox" checked={showDeleted} onChange={event => { setShowDeleted(event.target.checked); setFilter("all"); setPage(1); }} />已删除记录（{deletedCount}）</label>}</header>
    <div className="bot-work-toolbar">
      <div className="bot-work-search-row"><label className="bot-work-search"><IconSearch size={16} /><span className="bot-sr-only">搜索事项</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); restartPage(); }} placeholder="搜索标题、目标、结果或文件" /></label>{query && <button type="button" className="bot-icon-button" aria-label="清除搜索" onClick={() => { setQuery(""); restartPage(); }}><IconX size={16} /></button>}<label className="bot-work-sort"><span className="bot-sr-only">事项排序</span><select aria-label="事项排序" value={sort} onChange={event => { setSort(event.target.value); restartPage(); }}><option value="recent">最近更新优先</option><option value="oldest">最久未更新优先</option></select></label></div>
      {filters.length > 0 && <div className="bot-work-filters" role="group" aria-label="按事项状态筛选">{[{ id: "all" as const, label: "全部" }, ...filters.filter(item => index.some(entry => entry.status.group === item.id) || filter === item.id)].map(item => {
        const count = item.id === "all" ? searched.length : searched.filter(entry => entry.status.group === item.id).length;
        return <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); restartPage(); }}><span>{item.label}</span><span className="bot-tab-count">{loading ? "…" : count}</span></button>;
      })}</div>}
      <div className="bot-work-list-summary"><p role="status">{loading ? "正在读取记录…" : `共 ${index.length} 件${isFiltered ? ` · 匹配 ${filtered.length} 件` : ""}${filtered.length ? ` · 当前 ${start + 1}–${start + visible.length} 件` : ""}`}</p>{isFiltered && <button type="button" className="bot-quiet-button" onClick={reset}>重置筛选</button>}</div>
    </div>
    {!loading && (visible.length ? <><div className="bot-work-grid">{visible.map(({ work, status }) => <WorkCard key={work.workId} work={work} status={status} selected={work.workId === selectedWorkId} onSelect={() => onOpenWork(work.workId)} />)}</div>{pages > 1 && <nav className="bot-work-pagination" aria-label="事项分页"><button type="button" disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)}>上一页</button><span>第 {currentPage} / {pages} 页</span><button type="button" disabled={currentPage === pages} onClick={() => goToPage(currentPage + 1)}>下一页</button></nav>}</> : <div className="bot-list-empty"><IconListTodo size={30} /><h3>{isFiltered ? "没有找到匹配的事项" : view === "completed" ? "还没有已完成的委托" : view === "closed" ? showDeleted ? "没有已删除记录" : "归档为空" : "当前没有进行中的委托"}</h3><p>{isFiltered ? "换个关键词或状态，也可以重置筛选查看全部。" : "回到对话，说说你想交给我的事。"}</p>{isFiltered ? <button type="button" onClick={reset}>查看全部事项</button> : <button type="button" onClick={onConversation}>回到对话</button>}</div>)}
  </section>;
}

function WorkCard({ work, status, selected, onSelect }: { work: WorkProjectionDto; status: ReturnType<typeof workStatus>; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const nextCheck = nextWatchCheckAt(work);
  const latest = [...work.deliverables].reverse().find(item => item.status === "accepted" || item.status === "proposed");
  const ended = work.lifecycle === "closed" || isWorkArchived(work);
  const excerpt = ended ? work.closureSummary || latest?.summary || (work.archive?.archivedAt && work.lifecycle !== "closed" ? "执行未完成，已归档，不再自动重试。打开可查看已有记录。" : work.closureConclusion === "succeeded" ? "委托已完成，打开查看最终记录。" : work.closureConclusion === "cancelled" ? "此委托已取消，已有记录仍可查看。" : "打开查看结束原因与已有记录。") : latest?.summary ?? work.nextSteps[0] ?? "打开查看目标、进展与成果。";
  return <article className="bot-work-card-container"><button type="button" className="bot-work-card" data-work-id={work.workId} aria-pressed={selected} onClick={onSelect}>
    <div className="bot-work-card-top"><span className={`bot-status-badge ${status.group === "succeeded" ? "success" : status.group}`}>{status.label}</span><span>{work.team ? `${work.team.members.length + 1} 位 Bot 组队` : work.mode === "watch" ? "持续关注" : "单次委托"}</span></div>
    <strong>{work.title}</strong><p className="bot-work-excerpt"><span>{ended ? "结果：" : latest ? "成果摘录：" : "下一步："}</span>{workCardExcerpt(excerpt, work.title)}</p>
    {nextCheck !== undefined && <p className="bot-work-excerpt"><span>下次计划检查：</span><time dateTime={new Date(nextCheck).toISOString()}>{new Date(nextCheck).toLocaleString("zh-CN")}</time> · 应用需保持运行</p>}
    <div className="bot-work-card-bottom"><span>{work.deliverables.length ? `${work.deliverables.length} 项成果` : ended ? "查看结束记录" : "等待成果"} · {new Date(work.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span><span className="bot-work-card-open">查看完整内容<IconChevronRight size={16} /></span></div>
  </button><BotWorkArchiveActions work={work} /></article>;
}
