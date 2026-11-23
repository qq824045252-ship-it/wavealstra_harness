import { useEffect, useState } from "react";
import {
  boardLanes,
  type BoardAction,
  type BoardPage,
  type BoardQuery,
  type TaskBoardLane,
  type TaskBoardRow,
  type TaskBoardView,
} from "@shared/task-board";
import { computeEffectiveArchived } from "@shared/workspace-tree";
import {
  DesktopSectionRow,
  DesktopSectionSidebar,
  useDesktopSectionState,
} from "@/components/desktop/DesktopSection";
import { IconAlert, IconClock, IconFolder, IconKanban, IconPlus, IconSearch } from "@/components/common/icons";
import WorkspaceIcon from "@/components/workspace/WorkspaceIcon";
import { openWorkspaceRequest } from "@/hooks/useBotWorkspaceNavigation";
import { addLocalDays, formatDayLabel, startOfLocalDay } from "@/lib/projectPlanSchedule";
import { focusRows, focusSections } from "@/lib/taskBoardFocus";
import { recordBoardVisit } from "@/lib/taskBoardVisits";
import { useAppStore } from "@/store/appStore";
import { TaskBoardCard } from "./TaskBoardCard";
import { TaskBoardDates, boardRange, type BoardDates } from "./TaskBoardDates";
import TaskBoardDueDate from "./TaskBoardDueDate";
import { TaskBoardSavedDates } from "./TaskBoardSavedDates";
import { useTaskBoardPages } from "./useTaskBoardPage";
import "./TaskBoardPage.css";

type View = TaskBoardView | "focus";
type PageChannel = TaskBoardLane | "list";
type Cursor = NonNullable<BoardQuery["cursor"]>;
const laneTitles: Record<TaskBoardLane, string> = {
  attention: "需跟进",
  pending: "待处理",
  running: "进行中",
  finished: "已结束",
};
const labels: Record<View, string> = {
  focus: "我的焦点",
  attention: "等我处理",
  recent: "最近在做",
  frequent: "经常关注",
  dates: "按日期查",
  today: "今日关注",
  review: "待审查的改动",
  running: "正在执行",
  week: "本周到期",
  results: "新结果",
  automation: "后台动态",
  all: "全部",
  pinned: "已置顶",
  unread: "未读结果",
  later: "稍后再看",
};
const tabs: View[] = ["focus", "recent", "frequent", "dates", "all"];
const empty: Partial<Record<View, string>> = {
  focus: "目前没有需要跟进的事项。",
  recent: "近 14 天还没有主动跟进记录。",
  frequent: "近 14 天内，跨两个或更多日期主动查看或跟进的任务会出现在这里。",
  dates: "所选日期内没有匹配的任务。",
};

export default function TaskBoardPage(): React.JSX.Element {
  const allSpaces = useAppStore((s) => s.spaces);
  const projects = useAppStore((s) => s.projects);
  const hidden = computeEffectiveArchived(
    allSpaces.map((s) => ({
      id: s.id,
      parentId: s.parentId ?? null,
      archived: !!(s.archived || s.effectiveArchived),
    })),
  );
  const spaces = allSpaces.filter((s) => !hidden.get(s.id));
  const names = new Map(spaces.map((s) => [s.id, s.name]));
  const [scope, setScope] = useDesktopSectionState<string | null | undefined>("task-board:scope", undefined);
  const [search, setSearch] = useDesktopSectionState("task-board:search", "");
  const [view, setView] = useDesktopSectionState<View>("task-board:focus-view", "focus");
  const [dates, setDates] = useDesktopSectionState<BoardDates>("task-board:dates", {
    kind: "follow",
    range: "week",
    start: "",
    end: "",
  });
  const [job, setJob] = useDesktopSectionState<string | undefined>("task-board:job", undefined);
  const [today, setToday] = useState(() => startOfLocalDay());
  const [revision, update] = useState(0);
  const [editing, setEditing] = useState<TaskBoardRow | null>(null);
  const [actions, setActions] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useDesktopSectionState<{
    key: string;
    cursors: Partial<Record<PageChannel, Cursor[]>>;
  }>("task-board:pages-by-lane", { key: "", cursors: {} });
  useEffect(() => {
    const check = () => setToday(startOfLocalDay());
    const timer = setTimeout(check, Math.max(1, addLocalDays(today, 1) - Date.now()));
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
    };
  }, [today]);
  const scopeId = scope;
  const scopeName =
    scopeId === null ? "独立任务" : scopeId ? (names.get(scopeId) ?? "已移除的工作空间") : "全部任务";
  const actual = view === "focus" && search.trim() ? "all" : view;
  const dateRange = boardRange(dates, today);
  const valid = actual !== "dates" || !!dateRange;
  const pageKey = JSON.stringify([
    actual,
    scopeId === undefined ? "*" : scopeId,
    search,
    actual === "dates" ? dates : null,
    job,
    today,
  ]);
  const cursors = history.key === pageKey ? history.cursors : {};
  const classic = ["all", "today", "unread", "pinned"].includes(actual);
  const panels: Array<Pick<BoardQuery, "view" | "lane">> = actual === "focus"
    ? focusSections.map(({ view }) => ({ view }))
    : classic ? boardLanes.map((lane) => ({ view: actual, lane })) : [{ view: actual }];
  const queries = panels.map(({ view, lane }) => ({
    view,
    lane,
    scope: scopeId,
    search,
    preview: actual === "focus",
    cursor: actual === "focus" ? undefined : cursors[lane ?? "list"]?.at(-1),
    jobId: view === "automation" ? job : undefined,
    ...(view === "dates" ? { dateKind: dates.kind, projectId: dates.projectId, ...dateRange } : {}),
  }));
  const { pages, changed, refresh, error: loadError } = useTaskBoardPages(queries, valid, revision);
  const go = (next: View, jobId?: string) => {
    setActions(null);
    setHistory({ key: "", cursors: {} });
    if (next === "focus") setSearch("");
    setJob(jobId);
    setView(next);
  };
  const reload = () => update((n) => n + 1);
  async function act(row: TaskBoardRow, action: BoardAction | "pin") {
    setActions(null);
    setError("");
    try {
      if (action === "pin") await useAppStore.getState().togglePinTask(row.id);
      else if (window.api) await window.api.db.taskBoardAction(row.id, action);
      else throw new Error("桌面数据库未就绪");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    }
  }
  function open(row: TaskBoardRow) {
    if (row.jobId) {
      go("automation", row.jobId);
      return;
    }
    const countVisit = actual !== "focus";
    if (!countVisit) void window.api?.db.taskBoardAction(row.id, "read").catch(console.warn);
    if (row.request) {
      openWorkspaceRequest({ ...row.request, focusMessageId: row.request.messageId }, countVisit);
      return;
    }
    if (countVisit) recordBoardVisit(row.id);
    const store = useAppStore.getState();
    if (row.unread) void store.ackTaskDone(row.id, { knownUnread: true });
    store.setActiveTask(
      row.id,
      row.messageId
        ? { messageId: row.messageId, interactionId: row.interactionId, toolCallId: row.toolCallId }
        : undefined,
    );
  }
  function card(row: TaskBoardRow, group: TaskBoardView) {
    return (
      <TaskBoardCard
        key={row.id}
        row={row}
        group={group}
        today={today}
        spaceName={names.get(row.spaceId ?? "") ?? "独立任务"}
        expanded={actions === row.id}
        onOpen={() => open(row)}
        onReview={() => {
          open(row);
          const store = useAppStore.getState();
          if (store.activeTaskId === row.id) store.showChanges();
        }}
        onEdit={() => setEditing(row)}
        onAction={(action) => void act(row, action)}
        onToggle={() => setActions(actions === row.id ? null : row.id)}
      />
    );
  }
  function pagination(page: BoardPage | undefined, channel: PageChannel) {
    const trail = cursors[channel] ?? [];
    if (!trail.length && !page?.next) return null;
    const setTrail = (next: Cursor[]) => {
      setActions(null);
      setHistory({ key: pageKey, cursors: { ...cursors, [channel]: next } });
    };
    return (
      <footer className="task-board-pagination" aria-label={channel === "list" ? "任务分页" : `${laneTitles[channel]}分页`}>
        <button className="btn" disabled={!trail.length} onClick={() => setTrail(trail.slice(0, -1))}>
          上一页
        </button>
        <span>第 {trail.length + 1} 页</span>
        <button className="btn" disabled={!page?.next} onClick={() => page?.next && setTrail([...trail, page.next])}>
          下一页
        </button>
      </footer>
    );
  }
  const preview = actual === "focus" && pages ? focusRows(pages) : [];
  const rows = pages?.[0]?.rows ?? [];
  const noResults = !Object.values(cursors).some((trail) => trail.length) && pages?.every((p) => p?.rows.length === 0);
  return (
    <>
      <DesktopSectionSidebar title="任务范围" scrollKey="task-board:spaces">
        <DesktopSectionRow
          icon={<IconKanban size={15} />}
          active={scopeId === undefined}
          onClick={() => setScope(undefined)}
        >
          全部任务
        </DesktopSectionRow>
        <DesktopSectionRow
          icon={<IconFolder size={15} />}
          active={scopeId === null}
          onClick={() => setScope(null)}
        >
          独立任务
        </DesktopSectionRow>
        {spaces.length > 0 && <p className="desktop-section-group">工作空间</p>}
        {spaces.map((s) => (
          <DesktopSectionRow
            key={s.id}
            title={s.name}
            icon={<WorkspaceIcon size={15} icon={s.icon} />}
            active={s.id === scopeId}
            onClick={() => setScope(s.id)}
          >
            {s.name}
          </DesktopSectionRow>
        ))}
      </DesktopSectionSidebar>
      <main className="task-board" aria-label="任务看板">
        <header className="task-board-header">
          <div>
            <h1>任务看板</h1>
            <p>
              {scopeName} · {formatDayLabel(today)}
            </p>
          </div>
          <div className="task-board-tools">
            <label className="task-board-search">
              <IconSearch size={15} />
              <input
                type="search"
                maxLength={500}
                aria-label="搜索任务标题"
                placeholder="搜索任务标题"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button
              className="btn primary"
              onClick={() => useAppStore.getState().newTask(scopeId ?? undefined)}
            >
              <IconPlus size={15} />
              新建任务
            </button>
          </div>
        </header>
        <nav className="task-board-views" aria-label="看板视图">
          {tabs.map((v) => (
            <button key={v} aria-pressed={v === actual} onClick={() => go(v)}>
              {labels[v]}
            </button>
          ))}
          <select
            aria-label="更多视图"
            value={tabs.includes(actual) ? "" : actual}
            onChange={(e) => go(e.target.value as View)}
          >
            <option value="" disabled>
              更多视图
            </option>
            {Object.entries(labels)
              .filter(([v]) => !tabs.includes(v as View))
              .map(([v, label]) => (
                <option value={v} key={v}>
                  {label}
                </option>
              ))}
          </select>
        </nav>
        {actual === "dates" && (
          <TaskBoardDates value={dates} change={setDates} today={today}>
            <TaskBoardSavedDates
              dates={dates}
              scope={scopeId}
              search={search}
              scopeName={scopeName}
              valid={valid}
              projectName={projects.find((p) => p.id === dates.projectId)?.name}
              restore={(saved) => {
                setDates(saved.dates);
                setScope(saved.scope);
                setSearch(saved.search);
              }}
            />
          </TaskBoardDates>
        )}
        {changed && (
          <button className="task-board-refresh" onClick={refresh}>
            有新变化，刷新看板
          </button>
        )}
        {(error || loadError) && (
          <p role="alert" className="task-board-error">
            {error || loadError} <button onClick={refresh}>重试</button>
          </p>
        )}
        {!valid ? (
          <p className="task-board-empty">请选择完整的日期范围，结束日期需晚于或等于开始日期。</p>
        ) : !pages && !loadError ? (
          <p className="task-board-empty" role="status">
            正在读取任务…
          </p>
        ) : noResults ? (
          <div className="task-board-no-results" role="status">
            <IconSearch size={24} />
            <p>{search ? "没有匹配的任务" : (empty[actual] ?? "当前范围暂无任务")}</p>
            <button className="btn" onClick={() => (search ? setSearch("") : go("all"))}>
              {search ? "清除搜索" : "查看全部任务"}
            </button>
          </div>
        ) : actual === "focus" ? (
          <div className="task-board-focus">
            {focusSections.map(({ view: group }, i) => {
              const p = pages?.[i];
              if (!p?.rows.length) return null;
              const { rows: items, folded, exact, duplicated } = preview[i];
              if (!items.length) return null;
              return (
                <section className="task-board-lane" key={group} data-section={group}>
                  <header className="task-board-lane-header">
                    <span className="task-board-lane-icon">
                      {group === "attention" ? <IconAlert size={16} /> : <IconClock size={16} />}
                    </span>
                    <h2>{labels[group]}</h2>
                    {p.total != null && <span className="task-board-count">{p.total}</span>}
                    <button className="task-board-drill" onClick={() => go(group)}>
                      {items.length < p.rows.length || p.next || folded > 0 ? "查看全部" : "打开列表"}
                    </button>
                  </header>
                  <div className="task-board-lane-body">{items.map((r) => card(r, group))}</div>
                  {(folded > 0 || duplicated > 0) && (
                    <footer className="task-board-lane-more">
                      {folded > 0 && (
                        <button type="button" className="task-board-folded" onClick={() => go(group)}>
                          {exact ? `还有 ${folded} 个被折叠` : "还有更多被折叠"} · 查看全部
                        </button>
                      )}
                      {duplicated > 0 && (
                        <span className="task-board-elsewhere">另有 {duplicated} 个已在上方分栏显示</span>
                      )}
                    </footer>
                  )}
                </section>
              );
            })}
          </div>
        ) : classic ? (
          <div className="task-board-columns">
            {boardLanes.map((lane, i) => {
              const page = pages?.[i];
              return (
                <section className="task-board-lane" key={lane} data-lane={lane}>
                  <header className="task-board-lane-header">
                    <h2>{laneTitles[lane]}</h2>
                    {page?.total != null && <span className="task-board-count">{page.total}</span>}
                  </header>
                  <div className="task-board-lane-body" key={cursors[lane]?.length ?? 0}>
                    {page?.rows.map((r) => card(r, actual))}
                    {page?.rows.length === 0 && <p className="task-board-empty">{page.total ? "本页暂无任务" : "暂无任务"}</p>}
                    {!page && !loadError && <p className="task-board-empty" role="status">正在读取任务…</p>}
                  </div>
                  {pagination(page, lane)}
                </section>
              );
            })}
          </div>
        ) : (
          <section className="task-board-list">
            <header>
              <h2>{job ? "运行记录" : labels[actual]}</h2>
              {job && (
                <button className="btn" onClick={() => go("automation")}>
                  返回后台动态
                </button>
              )}
            </header>
            <div>{rows.map((r) => card(r, actual))}</div>
          </section>
        )}
        {actual !== "focus" && !classic && pagination(pages?.[0], "list")}
        {editing && (
          <TaskBoardDueDate
            card={editing}
            onClose={() => {
              setEditing(null);
              reload();
            }}
          />
        )}
      </main>
    </>
  );
}
