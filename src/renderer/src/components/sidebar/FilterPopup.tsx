import type { TaskFilterStatus, TaskFilterTime } from "@/types";
import { useAppStore } from "@/store/appStore";
import { IconCheck } from "@/components/common/icons";

const STATUS_OPTIONS: Array<{ value: TaskFilterStatus; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "in_progress", label: "进行中" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "pending", label: "待处理" },
  { value: "planning", label: "规划中" },
];

const TIME_OPTIONS: Array<{ value: TaskFilterTime; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
];

interface Props {
  onClose: () => void;
}

export default function FilterPopup({ onClose }: Props): React.JSX.Element {
  const status = useAppStore((s) => s.taskFilterStatus);
  const time = useAppStore((s) => s.taskFilterTime);
  const setStatus = useAppStore((s) => s.setTaskFilterStatus);
  const setTime = useAppStore((s) => s.setTaskFilterTime);
  const reset = useAppStore((s) => s.resetTaskFilters);

  return (
    <div className="filter-popup" onClick={(e) => e.stopPropagation()}>
      <div className="filter-popup-section">
        <div className="filter-popup-title">筛选状态</div>
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`filter-popup-item ${status === opt.value ? "active" : ""}`}
            onClick={() => setStatus(opt.value)}
          >
            <span>{opt.label}</span>
            {status === opt.value && <IconCheck size={14} className="filter-check" />}
          </button>
        ))}
      </div>
      <div className="filter-popup-section">
        <div className="filter-popup-title">筛选时间</div>
        {TIME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`filter-popup-item ${time === opt.value ? "active" : ""}`}
            onClick={() => setTime(opt.value)}
          >
            <span>{opt.label}</span>
            {time === opt.value && <IconCheck size={14} className="filter-check" />}
          </button>
        ))}
      </div>
      <button
        className="filter-popup-reset"
        onClick={() => {
          reset();
          onClose();
        }}
      >
        重置筛选条件
      </button>
    </div>
  );
}
