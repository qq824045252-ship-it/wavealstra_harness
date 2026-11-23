import { useEffect, useId, useRef, useState } from "react";
import { DOTS_TASK_ID, type DotsActivityItem } from "@shared/dots";
import { IconChevronRight, IconListTodo } from "@/components/common/icons";
import { refreshDotsActivity, useDotsActivity } from "@/lib/dotsActivityFeed";
import { openDotsActivityTarget } from "@/lib/taskBoardVisits";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import "./DotsActivity.css";

const INITIAL_LIMIT = 8;
const MORE_LIMIT = 20;
const states = {
  waiting: "等待你回复", running: "运行中", blocked: "遇到阻碍", failed: "执行失败",
  paused: "已暂停", stopped: "已停止", delivered: "已交付", undelivered: "尚未交付", superseded: "已改向",
};
const priority = Object.keys(states) as DotsActivityItem["state"][];
const phases = { queued: "排队中", working: "执行中", following: "等待 Dots 跟进" };
const date = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function openActivityItem(item: DotsActivityItem, signal: AbortSignal): Promise<void> {
  if (item.state === "waiting") {
    const { taskId, messageId, interactionId } = item.target;
    return openDotsActivityTarget(taskId, { messageId, interactionId }, signal);
  }
  if (item.state === "delivered") return openDotsActivityTarget(DOTS_TASK_ID, { messageId: item.deliveryKey }, signal);
  return openDotsActivityTarget(item.taskId, undefined, signal);
}

export function DotsAllTasks() {
  const { items, loading, error } = useDotsActivity();
  const id = useId();
  const popover = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const navigation = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState<number | undefined>(INITIAL_LIMIT);
  const [actionError, setActionError] = useState("");
  useBlockNativeSurfaces(open);
  useEffect(() => () => navigation.current?.abort(), []);
  const waiting = items.filter(item => item.state === "waiting").length;
  const label = waiting ? `所有任务，${waiting} 项等待回复` : "所有任务";
  const shown = open ? items.toSorted((a, b) => priority.indexOf(a.state) - priority.indexOf(b.state)).slice(0, limit) : [];

  const visit = async (item: DotsActivityItem) => {
    navigation.current?.abort();
    const controller = new AbortController();
    navigation.current = controller;
    setActionError("");
    try {
      await openActivityItem(item, controller.signal);
      if (!controller.signal.aborted && popover.current?.matches(":popover-open")) popover.current.hidePopover();
    } catch (error) {
      if (!controller.signal.aborted) setActionError(String(error));
    }
  };

  return <>
    <button type="button" className="dots-activity-entry" aria-label={label} title={label}
      popoverTarget={id} aria-expanded={open}>
      <IconListTodo size={18} />
      {waiting > 0 && <span className="dots-activity-badge" aria-hidden="true">{waiting > 99 ? "99+" : waiting}</span>}
    </button>
    <div id={id} ref={popover} className="dots-all-tasks" popover="auto" role="region" aria-labelledby={`${id}-title`}
      onToggle={event => {
        const next = event.newState === "open";
        setOpen(next);
        if (next) { setActionError(""); refreshDotsActivity(); }
        else { navigation.current?.abort(); setLimit(INITIAL_LIMIT); }
      }}>
      <header><h2 id={`${id}-title`}>所有任务</h2><span>{items.length} 项</span></header>
      {error && <p role="alert">任务加载失败。<button type="button" onClick={refreshDotsActivity}>重试</button></p>}
      {actionError && <p role="alert">{actionError}</p>}
      {!error && items.length === 0 && <p role="status">{loading ? "正在读取任务…" : "暂无委派任务"}</p>}
      {shown.length > 0 && <ul ref={list} aria-label="Dots 委派任务">
        {shown.map(item => {
          const state = item.state === "running" ? phases[item.phase] : states[item.state];
          const lastActivity = item.state === "running" ? item.lastActivityAt ?? item.updatedAt : item.updatedAt;
          const action = item.state === "waiting" ? "去回复" : item.state === "delivered" ? "查看交付" : "打开任务";
          return <li key={item.taskId} data-state={item.state}>
            <button type="button" className="dots-all-tasks-row" aria-label={`${item.title}，${state}，${action}`} onClick={() => void visit(item)}>
              <span className="dots-all-tasks-detail">
                <span className="dots-all-tasks-heading"><strong>{item.title}</strong><span className="dots-all-tasks-state">{state}</span></span>
                <small>{item.space}{item.state === "delivered" && item.fileCount > 0 ? ` · ${item.fileCount} 个文件` : ""}
                  <time dateTime={new Date(lastActivity).toISOString()}>{date.format(lastActivity)}</time>
                </small>
                {item.summary && <span className="dots-all-tasks-summary">{item.summary}</span>}
              </span>
              <IconChevronRight size={14} />
            </button>
          </li>;
        })}
      </ul>}
      {items.length > INITIAL_LIMIT && <footer>
        <span aria-live="polite">已显示 {shown.length} / {items.length} 项</span>
        {limit !== INITIAL_LIMIT && <button type="button" onClick={() => { list.current?.scrollTo(0, 0); setLimit(INITIAL_LIMIT); }}>收起</button>}
        {limit !== undefined && shown.length < items.length && <button type="button" className="dots-all-tasks-more"
          onClick={() => setLimit(limit === INITIAL_LIMIT ? MORE_LIMIT : undefined)}>
          {limit === INITIAL_LIMIT ? `查看更多（${Math.min(MORE_LIMIT, items.length)} 项）` : `展开全部（${items.length} 项）`}
        </button>}
      </footer>}
    </div>
  </>;
}
