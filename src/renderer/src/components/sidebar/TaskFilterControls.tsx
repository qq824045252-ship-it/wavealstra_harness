import type { TaskFilterStatus, TaskFilterTime } from "@/types";
import { useAppStore } from "@/store/appStore";
import { TASK_STATUS_LABELS } from "@/utils/taskFilters";
import { IconRotate, IconSearch, IconX } from "@/components/common/icons";
import { useRef } from "react";

const TIME_OPTIONS: Array<{ value: TaskFilterTime; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
];

interface Props {
  onClose: () => void;
  query: string;
  onQueryChange: (value: string) => void;
}

export default function TaskFilterControls({ onClose, query, onQueryChange }: Props): React.JSX.Element {
  const status = useAppStore((s) => s.taskFilterStatus);
  const time = useAppStore((s) => s.taskFilterTime);
  const setStatus = useAppStore((s) => s.setTaskFilterStatus);
  const setTime = useAppStore((s) => s.setTaskFilterTime);
  const reset = useAppStore((s) => s.resetTaskFilters);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <div id="task-sidebar-filters" className="task-filter-controls" role="group" aria-label="任务筛选"
      onKeyDown={(e) => { if (e.key === "Escape" && !e.nativeEvent.isComposing) onClose(); }}>
      <div className="task-filter-search-row">
        <div className="task-filter-search">
          <IconSearch size={14} />
          <input ref={searchRef} type="search" aria-label="搜索任务" placeholder="搜索任务标题"
            autoFocus value={query} onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); onClose(); } }} />
          {query && <button type="button" className="icon-btn" aria-label="清除搜索" title="清除搜索"
            onClick={() => { onQueryChange(""); searchRef.current?.focus(); }}><IconX size={13} /></button>}
        </div>
        {(status !== "all" || time !== "all") && (
          <button type="button" className="icon-btn" title="重置筛选条件" aria-label="重置筛选条件"
            onClick={() => { onQueryChange(""); reset(); searchRef.current?.focus(); }}><IconRotate size={14} /></button>
        )}
      </div>
      <div className="task-filter-selects">
        <select aria-label="筛选状态" value={status} onChange={(e) => setStatus(e.target.value as TaskFilterStatus)}>
          <option value="all">全部状态</option>
          {Object.entries(TASK_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="筛选时间" value={time} onChange={(e) => setTime(e.target.value as TaskFilterTime)}>
          {TIME_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
      </div>
    </div>
  );
}
