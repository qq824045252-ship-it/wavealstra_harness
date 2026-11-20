import { IconStop, IconX } from "@/components/common/icons";
import { TASK_STATUS_LABELS } from "@/utils/taskFilters";
import type { TaskStatus } from "@/types";
import "./TaskStatusIndicator.css";

interface Props {
  status: TaskStatus | "unknown";
  label?: string;
  unread?: boolean;
}

const marks = {
  in_progress: <i className="task-status-ring" />,
  pending: <><i /><i /><i /></>,
  planning: <><i /><i /><i /></>,
  failed: <IconX size={13} strokeWidth={2.3} />,
  stopped: <IconStop size={11} strokeWidth={2.3} />,
  unknown: <span className="task-status-question">?</span>,
};

export default function TaskStatusIndicator({ status, label, unread = false }: Props): React.JSX.Element | null {
  if (status === "completed") return null;
  const statusLabel = label ?? (status === "unknown" ? "状态待核实" : TASK_STATUS_LABELS[status]);
  const description = unread ? `${statusLabel} · 未查看` : statusLabel;
  return (
    <span className={`task-status-indicator task-status-indicator--${status}`}
      role="img" aria-label={description} title={description}>
      <span className="task-status-mark" aria-hidden="true">{marks[status]}</span>
      {unread && <span className="task-status-unread" aria-hidden="true" />}
    </span>
  );
}
