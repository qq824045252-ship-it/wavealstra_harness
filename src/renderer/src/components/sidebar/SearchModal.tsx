import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { computeEffectiveArchived } from "../../../../shared/workspace-tree";
import { getTaskDisplayStatus } from "@/utils/taskFilters";
import type { Task } from "@/types";
import { IconFolder, IconSearch, IconX } from "@/components/common/icons";

function formatTaskStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}...`;
}

function TaskStatusMark({ task }: { task: Task }): React.JSX.Element | null {
  const status = getTaskDisplayStatus(task);
  if (status === "pending") {
    return <span className="search-status-badge">待确认</span>;
  }
  if (status === "running") {
    return (
      <span className="search-status-running">
        <span className="task-status-dot" />
      </span>
    );
  }
  return null;
}

export default function SearchModal(): React.JSX.Element | null {
  const open = useAppStore((s) => s.searchOpen);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const tasks = useAppStore((s) => s.tasks);
  const spaces = useAppStore((s) => s.spaces);
  const setActiveTask = useAppStore((s) => s.setActiveTask);
  const activeTaskId = useAppStore((s) => s.activeTaskId);

  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const spaceName = (spaceId?: string): string | null => {
    if (!spaceId) return null;
    return spaces.find((s) => s.id === spaceId)?.name ?? null;
  };

  // P2-1：effectiveArchived 以 shared compute 为唯一口径（纯计算，不 overlay DTO），与 Sidebar/Store 同源
  const effectiveSpaceIds = useMemo(() => {
    return computeEffectiveArchived(
      spaces.map((s) => ({ id: s.id, parentId: s.parentId ?? null, archived: Boolean(s.archived) })),
    );
  }, [spaces]);

  // P1-2：Search 的排序语义独立于 workspace tree mixed order —— 搜索按 recency（updatedAt DESC）排序，
  // 属于搜索相关性/时间语义，不是 workspace tree 的结构排序；故有意不使用 shared compareMixed / buildWorkspaceTree。
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = tasks.filter((t) => {
      if (t.archived) return false;
      if (t.spaceId && effectiveSpaceIds.get(t.spaceId)) return false;
      return true;
    });
    const list = [...visible].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!q) return list;
    return list.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        spaceName(t.spaceId)?.toLowerCase().includes(q),
    );
  }, [tasks, query, spaces, effectiveSpaceIds]);

  if (!open) return null;

  const pick = (task: Task): void => {
    setActiveTask(task.id);
    setSearchOpen(false);
  };

  return (
    <div className="search-modal-overlay" onClick={() => setSearchOpen(false)}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-modal-head">
          <div className="search-modal-input-wrap">
            <IconSearch size={16} />
            <input
              ref={inputRef}
              className="search-modal-input"
              placeholder="搜索任务"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setSearchOpen(false)}
            />
          </div>
          <button className="icon-btn" title="关闭" onClick={() => setSearchOpen(false)}>
            <IconX size={16} />
          </button>
        </div>

        <div className="search-modal-section">最近任务</div>

        <div className="search-modal-list">
          {results.length === 0 ? (
            <div className="search-modal-empty">没有匹配的任务</div>
          ) : (
            results.map((task) => {
              const space = spaceName(task.spaceId);
              const active = task.id === activeTaskId;
              return (
                <button
                  key={task.id}
                  className={`search-modal-item ${active ? "active" : ""}`}
                  onClick={() => pick(task)}
                >
                  <span className="search-modal-item-main">
                    <TaskStatusMark task={task} />
                    <span className="search-modal-item-title">{task.title}</span>
                  </span>
                  <span className="search-modal-item-meta">
                    {space ? (
                      <>
                        <IconFolder size={13} />
                        <span>{space}</span>
                      </>
                    ) : (
                      formatTaskStamp(task.updatedAt)
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
