import { UiIcon } from "@mybuddy/shared/icons";
import { IconStop, IconX } from "@/components/common/icons";
import { TASK_STATUS_LABELS } from "@/utils/taskFilters";
import type { TaskStatus } from "@/types";
import type { ReactNode } from "react";
import "./TaskStatusIndicator.css";

interface Props {
  status: TaskStatus | "unknown";
  label?: string;
  unread?: boolean;
  unreadLabel?: string;
  mark?: ReactNode;
}

const marks = {
  in_progress: <i className="task-status-ring" />,
  completed: <i className="task-status-completed-dot" />,
  pending: <><i /><i /><i /></>,
  planning: <><i /><i /><i /></>,
  failed: <IconX size={13} strokeWidth={2.3} />,
  stopped: <IconStop size={11} strokeWidth={2.3} />,
  unknown: <UiIcon name="help" size={13} className="task-status-question" />,
};

export default function TaskStatusIndicator({
  status, label, unread = false, unreadLabel = status === "completed" ? "未确认" : "未查看", mark = marks[status],
}: Props): React.JSX.Element | null {
  if (status === "completed" && !unread) return null;
  const statusLabel = label ?? (status === "unknown" ? "状态待核实" : TASK_STATUS_LABELS[status]);
  const description = unread ? `${statusLabel} · ${unreadLabel}` : statusLabel;
  return (
    <span className={`task-status-indicator task-status-indicator--${status}`}
      role="img" aria-label={description} title={description}>
      <span className="task-status-mark" aria-hidden="true">{mark}</span>
      {unread && status !== "completed" && <span className="task-status-unread" aria-hidden="true" />}
    </span>
  );
}
