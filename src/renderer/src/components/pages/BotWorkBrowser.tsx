import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import { IconChevronRight, IconListTodo, IconSearch, IconX } from "@/components/common/icons";
import { workCardExcerpt, workMatchesSearch, workMatchesView, workSearchText, workStatus, type WorkStatusGroup } from "@/lib/botWorkspacePresentation";

const PAGE_SIZE = 24;
const activeFilters: Array<{ id: WorkStatusGroup; label: string }> = [
  { id: "running", label: "执行中" }, { id: "attention", label: "需处理" },
  { id: "results", label: "执行完成" }, { id: "waiting", label: "等待执行 / 恢复" },
  { id: "watching", label: "持续关注" }, { id: "paused", label: "已暂停" },
];
const closedFilters: Array<{ id: WorkStatusGroup; label: string }> = [
  { id: "succeeded", label: "已完成" }, { id: "cancelled", label: "已取消" },
  { id: "unsuccessful", label: "未完成" }, { id: "ended", label: "其他结束记录" },
];

/** Bounded rendering only: every loaded Work remains searchable and reachable. */
export function BotWorkBrowser({ works, view, loading, selectedWorkId, onOpenWork, onConversation }: {
  works: WorkProjectionDto[];
  view: "active" | "closed";
  loading: boolean;
  selectedWorkId?: string | null;
  onOpenWork: (id: string) => void;
  onConversation: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorkStatusGroup | "all">("all");
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);
  const browserRef = useRef<HTMLElement>(null);
  const index = useMemo(() => works.filter(work => workMatchesView(work, view))
    .map(work => ({ work, status: workStatus(work), text: workSearchText(work) })), [works, view]);
  const searched = useMemo(() => index.filter(item => workMatchesSearch(item.text, query)), [index, query]);
  const filtered = useMemo(() => searched.filter(item => filter === "all" || item.status.group === filter)
    .sort((a, b) => (sort === "oldest" ? a.work.updatedAt - b.work.updatedAt : b.work.updatedAt - a.work.updatedAt)
      || a.work.workId.localeCompare(b.work.workId)), [searched, filter, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  useEffect(() => { setPage(previous => Math.min(previous, pages)); }, [pages]);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const filters = view === "active" ? activeFilters : closedFilters;
  const isFiltered = Boolean(query.trim() || filter !== "all");
  const restartPage = () => { setPage(1); browserRef.current?.scrollTo({ top: 0 }); };
  const reset = () => { setQuery(""); setFilter("all"); restartPage(); };
  const goToPage = (next: number) => { setPage(next); browserRef.current?.scrollTo({ top: 0 }); };
  return <section className="bot-work-browser" ref={browserRef} aria-label={`${view === "active" ? "未结束" : "已结束"}事项`}>
    <header className="bot-list-heading"><div><h2>{view === "active" ? "尚未结束的事项" : "每一件事，都有记录"}</h2><p>{view === "active" ? "按执行状态整理。执行完成与事项验收分开显示。" : "保留已完成、已取消与未完成的结束记录。"}</p></div></header>
    <div className="bot-work-toolbar">
      <div className="bot-work-search-row"><label className="bot-work-search"><IconSearch size={16} /><span className="bot-sr-only">搜索事项</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); restartPage(); }} placeholder="搜索标题、目标、结果或文件" /></label>{query && <button type="button" className="bot-icon-button" aria-label="清除搜索" onClick={() => { setQuery(""); restartPage(); }}><IconX size={16} /></button>}<label className="bot-work-sort"><span className="bot-sr-only">事项排序</span><select aria-label="事项排序" value={sort} onChange={event => { setSort(event.target.value); restartPage(); }}><option value="recent">最近更新优先</option><option value="oldest">最久未更新优先</option></select></label></div>
      <div className="bot-work-filters" role="group" aria-label="按事项状态筛选">{[{ id: "all" as const, label: "全部" }, ...filters].map(item => {
        const count = item.id === "all" ? searched.length : searched.filter(entry => entry.status.group === item.id).length;
        return <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); restartPage(); }}><span>{item.label}</span><span className="bot-tab-count">{loading ? "…" : count}</span></button>;
      })}</div>
      <div className="bot-work-list-summary"><p role="status">{loading ? "正在读取已结束事项…" : `共 ${index.length} 件${isFiltered ? ` · 匹配 ${filtered.length} 件` : ""}${filtered.length ? ` · 当前 ${start + 1}–${start + visible.length} 件` : ""}`}</p>{isFiltered && <button type="button" className="bot-quiet-button" onClick={reset}>重置筛选</button>}</div>
    </div>
    {!loading && (visible.length ? <><div className="bot-work-grid">{visible.map(({ work, status }) => <WorkCard key={work.workId} work={work} status={status} selected={work.workId === selectedWorkId} onSelect={() => onOpenWork(work.workId)} />)}</div>{pages > 1 && <nav className="bot-work-pagination" aria-label="事项分页"><button type="button" disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)}>上一页</button><span>第 {currentPage} / {pages} 页</span><button type="button" disabled={currentPage === pages} onClick={() => goToPage(currentPage + 1)}>下一页</button></nav>}</> : <div className="bot-list-empty"><IconListTodo size={30} /><h3>{isFiltered ? "没有找到匹配的事项" : view === "closed" ? "还没有结束的事项" : "没有尚未结束的事项"}</h3><p>{isFiltered ? "换个关键词或状态，也可以重置筛选查看全部。" : "回到对话，说说你想交给我的事。"}</p>{isFiltered ? <button type="button" onClick={reset}>查看全部事项</button> : <button type="button" onClick={onConversation}>回到对话</button>}</div>)}
  </section>;
}

function WorkCard({ work, status, selected, onSelect }: { work: WorkProjectionDto; status: ReturnType<typeof workStatus>; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const latest = [...work.deliverables].reverse().find(item => item.status === "accepted" || item.status === "proposed");
  return <button type="button" className="bot-work-card" data-work-id={work.workId} aria-pressed={selected} onClick={onSelect}>
    <div className="bot-work-card-top"><span className={`bot-status-badge ${status.group === "succeeded" ? "success" : status.group}`}>{status.label}</span><span>{work.team ? `${work.team.members.length + 1} 位 Bot 组队` : work.mode === "watch" ? "持续关注" : "单次委托"}</span></div>
    <strong>{work.title}</strong><p className="bot-work-excerpt"><span>{latest ? "成果摘录：" : "下一步："}</span>{workCardExcerpt(latest?.summary ?? work.nextSteps[0] ?? "打开查看目标、进展与成果。", work.title)}</p>
    <div className="bot-work-card-bottom"><span>{work.deliverables.length ? `${work.deliverables.length} 项成果` : "等待成果"} · {new Date(work.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span><span className="bot-work-card-open">查看完整内容<IconChevronRight size={16} /></span></div>
  </button>;
}
