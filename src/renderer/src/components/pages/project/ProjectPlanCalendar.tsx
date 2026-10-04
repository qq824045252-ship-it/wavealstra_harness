import { useMemo, useState } from "react";
import { IconChevronLeft, IconChevronRight, IconPlus } from "@/components/common/icons";
import {
  addLocalMonths,
  formatMonthLabel,
  monthGrid,
  resolveTaskSpan,
  startOfLocalDay,
  taskSpansDay,
} from "@/lib/projectPlanSchedule";
import { planColumnOf, PROJECT_PLAN_COLUMNS } from "@/lib/projectWorkspace";
import type { PlanScheduleItem } from "./ProjectPlanGantt";

interface Props {
  items: PlanScheduleItem[];
  archived: boolean;
  onOpenItem: (id: string) => void;
  onCreate: (day: number) => void;
}

export default function ProjectPlanCalendar({
  items,
  archived,
  onOpenItem,
  onCreate,
}: Props): React.JSX.Element {
  const [anchor, setAnchor] = useState(() => Date.now());
  const cells = useMemo(() => monthGrid(anchor), [anchor]);
  const spans = useMemo(
    () =>
      items.map((item) => ({
        item,
        span: resolveTaskSpan(item),
        tone: PROJECT_PLAN_COLUMNS.find((column) => column.id === planColumnOf(item.status))?.tone ?? "neutral",
      })),
    [items],
  );

  return (
    <div className="project-cal">
      <div className="project-gantt-toolbar">
        <button type="button" className="project-gantt-nav" onClick={() => setAnchor((value) => addLocalMonths(value, -1))}>
          <IconChevronLeft size={15} />
        </button>
        <button type="button" className="project-gantt-today" onClick={() => setAnchor(Date.now())}>
          今天
        </button>
        <button type="button" className="project-gantt-nav" onClick={() => setAnchor((value) => addLocalMonths(value, 1))}>
          <IconChevronRight size={15} />
        </button>
        <strong>{formatMonthLabel(anchor)}</strong>
      </div>
      <div className="project-cal-weekdays">
        {["一", "二", "三", "四", "五", "六", "日"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="project-cal-grid">
        {cells.map((cell) => {
          const dayItems = spans.filter((entry) => taskSpansDay(entry.span, cell.at));
          return (
            <div
              key={cell.at}
              className={`project-cal-cell ${cell.inMonth ? "" : "out"} ${cell.isToday ? "today" : ""}`}
            >
              <div className="project-cal-cell-head">
                <span>{new Date(cell.at).getDate()}</span>
                {!archived && cell.inMonth && (
                  <button
                    type="button"
                    className="project-cal-add"
                    title="这一天添加待办"
                    onClick={() => onCreate(startOfLocalDay(cell.at))}
                  >
                    <IconPlus size={12} />
                  </button>
                )}
              </div>
              <div className="project-cal-chips">
                {dayItems.slice(0, 3).map((entry) => (
                  <button
                    key={entry.item.id}
                    type="button"
                    className={`project-cal-chip tone-${entry.tone}`}
                    onClick={() => onOpenItem(entry.item.id)}
                  >
                    {entry.item.title}
                  </button>
                ))}
                {dayItems.length > 3 && <span className="project-cal-more">+{dayItems.length - 3}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
