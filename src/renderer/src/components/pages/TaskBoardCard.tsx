import type { BoardAction, TaskBoardRow, TaskBoardView } from "@shared/task-board";
import { IconCalendar, IconFolder, IconPin } from "@/components/common/icons";
import { formatDayLabel, msToDateInput, startOfLocalDay } from "@/lib/projectPlanSchedule";
import { TASK_STATUS_LABELS } from "@/utils/taskFilters";

const statuses: Record<string, string> = { ...TASK_STATUS_LABELS, unknown: "状态待核实" };
const format = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
function dueLabel(row: TaskBoardRow, today: number) {
  if (row.dueAt == null) return;
  const day = startOfLocalDay(row.dueAt);
  if (row.status !== "completed" && row.status !== "stopped") {
    if (day < today) return "已逾期 · " + formatDayLabel(day);
    if (day === today) return "今天截止";
  }
  return formatDayLabel(day) + " 截止";
}

export function TaskBoardCard({
  row,
  group,
  today,
  spaceName,
  expanded,
  onOpen,
  onEdit,
  onToggle,
  onAction,
}: {
  row: TaskBoardRow;
  group: TaskBoardView;
  today: number;
  spaceName: string;
  expanded: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onAction: (action: BoardAction | "pin") => void;
}) {
  const date = dueLabel(row, today);
  const when =
    group === "recent" || group === "frequent" || group === "dates" || group === "results"
      ? Math.abs(row.at)
      : row.updatedAt;
  const why = group === "recent" ? (row.reason ? "上次跟进 · " + row.reason : "你最近跟进过") : row.reason;
  return (
    <div className="task-board-item">
      <button type="button" className="task-board-card" onClick={onOpen} title={row.title}>
        <span className="task-board-status" data-status={row.status}>
          {row.interactionId
            ? "等待你回答"
            : row.toolCallId
              ? "等待你批准"
              : (statuses[row.status] ?? "状态待核实")}
        </span>
        <strong>{row.title}</strong>
        {why && <span className="task-board-why">{why}</span>}
        {row.resultSinceFollow && (
          <span className="task-board-why">{format.format(row.resultSinceFollow)} 收到新结果</span>
        )}
        {(date || row.unread || row.planned || row.pinned) && (
          <span className="task-board-signals">
            {date && (
              <time
                dateTime={msToDateInput(row.dueAt)}
                data-urgent={date.includes("逾期") || date === "今天截止"}
              >
                <IconCalendar size={12} />
                {date}
              </time>
            )}
            {row.unread && <span>未读结果</span>}
            {row.planned && <span>今天要做</span>}
            {row.pinned && <IconPin size={12} />}
          </span>
        )}
        <span className="task-board-meta">
          <IconFolder size={12} />
          <span>{spaceName}</span>
          <time>{format.format(when)}</time>
        </span>
      </button>
      {!row.jobId && (
        <div className="task-board-card-tools">
          {!row.request && (
            <>
              <button title="设置截止日期" aria-label={`设置截止日期：${row.title}`} onClick={() => onEdit()}>
                <IconCalendar size={13} />
              </button>
              <button
                title="置顶"
                aria-label={`置顶：${row.title}`}
                aria-pressed={row.pinned}
                onClick={() => onAction("pin")}
              >
                <IconPin size={13} />
              </button>
            </>
          )}
          <button aria-label={`安排：${row.title}`} aria-expanded={expanded} onClick={() => onToggle()}>
            ···
          </button>
        </div>
      )}
      {expanded && (
        <div className="task-board-actions">
          <button onClick={() => onAction(row.planned ? "clear" : "today")}>
            {row.planned ? "移出今天" : "今天要做"}
          </button>
          <button onClick={() => onAction(row.laterUntil && row.laterUntil > Date.now() ? "clear" : "later")}>
            {row.laterUntil && row.laterUntil > Date.now() ? "恢复显示" : "明天再看"}
          </button>
        </div>
      )}
    </div>
  );
}
