import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronLeft, IconChevronRight } from "@/components/common/icons";
import {
  dayDeltaFromPixels,
  ganttRange,
  ganttRangeTitle,
  moveSpan,
  moveSpanByMonths,
  resizeSpan,
  resizeSpanByMonths,
  resolveTaskSpan,
  shiftAnchor,
  taskBarLayout,
  type GanttScale,
} from "@/lib/projectPlanSchedule";
import { planColumnOf, PROJECT_PLAN_COLUMNS } from "@/lib/projectWorkspace";

export interface PlanScheduleItem {
  id: string;
  title: string;
  status?: string;
  startAt?: number;
  dueAt?: number;
  updatedAt: number;
}

interface Props {
  items: PlanScheduleItem[];
  archived: boolean;
  onOpenItem: (id: string) => void;
  onSchedule: (id: string, span: { startAt: number; dueAt: number }) => void;
}

const SCALES: Array<{ id: GanttScale; label: string }> = [
  { id: "week", label: "周" },
  { id: "month", label: "月" },
  { id: "quarter", label: "季" },
  { id: "year", label: "年" },
];

const COL_MIN: Record<GanttScale, number> = {
  week: 48,
  month: 32,
  quarter: 22,
  year: 64,
};

export default function ProjectPlanGantt({
  items,
  archived,
  onOpenItem,
  onSchedule,
}: Props): React.JSX.Element {
  const [scale, setScale] = useState<GanttScale>("week");
  const [anchor, setAnchor] = useState(() => Date.now());
  const timeRef = useRef<HTMLDivElement>(null);
  const [colWidth, setColWidth] = useState(COL_MIN.week);
  const dragRef = useRef<{
    id: string;
    edge: "move" | "start" | "end";
    x: number;
    startAt: number;
    dueAt: number;
    moved: boolean;
  } | null>(null);

  const range = useMemo(() => ganttRange(anchor, scale), [anchor, scale]);
  const columns = `repeat(${range.ticks.length}, minmax(${COL_MIN[scale]}px, 1fr))`;

  const rows = useMemo(
    () =>
      items.map((item) => {
        const span = resolveTaskSpan(item);
        const layout = taskBarLayout(span.startAt, span.dueAt, range.start, range.end);
        const column = PROJECT_PLAN_COLUMNS.find((entry) => entry.id === planColumnOf(item.status));
        return { item, span, layout, tone: column?.tone ?? "neutral" };
      }),
    [items, range.start, range.end],
  );

  useEffect(() => {
    const el = timeRef.current;
    if (!el) return;
    const measure = (): void => {
      setColWidth(Math.max(COL_MIN[scale], el.clientWidth / Math.max(1, range.ticks.length)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scale, range.ticks.length]);

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      if (dayDeltaFromPixels(event.clientX - drag.x, colWidth) !== 0) drag.moved = true;
    };
    const onUp = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      const delta = dayDeltaFromPixels(event.clientX - drag.x, colWidth);
      if (delta === 0) return;
      const next =
        scale === "year"
          ? drag.edge === "move"
            ? moveSpanByMonths(drag.startAt, drag.dueAt, delta)
            : resizeSpanByMonths(drag.startAt, drag.dueAt, drag.edge === "start" ? "start" : "end", delta)
          : drag.edge === "move"
            ? moveSpan(drag.startAt, drag.dueAt, delta)
            : resizeSpan(drag.startAt, drag.dueAt, drag.edge === "start" ? "start" : "end", delta);
      onSchedule(drag.id, next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [colWidth, onSchedule, scale]);

  const beginDrag = (
    event: React.PointerEvent,
    item: PlanScheduleItem,
    edge: "move" | "start" | "end",
  ): void => {
    if (archived) return;
    event.preventDefault();
    event.stopPropagation();
    const span = resolveTaskSpan(item);
    dragRef.current = {
      id: item.id,
      edge,
      x: event.clientX,
      startAt: span.startAt,
      dueAt: span.dueAt,
      moved: false,
    };
  };

  return (
    <div className="project-gantt">
      <div className="project-gantt-toolbar">
        <div className="project-gantt-head-nav">
          <button type="button" className="project-gantt-nav" onClick={() => setAnchor((value) => shiftAnchor(value, scale, -1))}>
            <IconChevronLeft size={14} />
          </button>
          <button type="button" className="project-gantt-today" onClick={() => setAnchor(Date.now())}>
            今天
          </button>
          <button type="button" className="project-gantt-nav" onClick={() => setAnchor((value) => shiftAnchor(value, scale, 1))}>
            <IconChevronRight size={14} />
          </button>
          <strong>{ganttRangeTitle(anchor, scale)}</strong>
        </div>
        <div className="project-plan-views">
          {SCALES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`project-plan-view ${scale === item.id ? "active" : ""}`}
              onClick={() => setScale(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="project-gantt-sheet">
        <div className="project-gantt-labels">
          <div className="project-gantt-label-head">标题</div>
          {rows.map((row) => (
            <button
              key={row.item.id}
              type="button"
              className="project-gantt-label"
              onClick={() => onOpenItem(row.item.id)}
            >
              {row.item.title}
            </button>
          ))}
        </div>

        <div className="project-gantt-time" ref={timeRef}>
          <div className="project-gantt-days" style={{ gridTemplateColumns: columns }}>
            {range.ticks.map((tick) => (
              <div
                key={tick.at}
                className={`project-gantt-tick ${tick.isToday ? "today" : ""} ${tick.isWeekend ? "weekend" : ""}`}
              >
                <b>{tick.label}</b>
                {tick.sub ? <i>{tick.sub}</i> : null}
              </div>
            ))}
          </div>

          <div className="project-gantt-lanes">
            {rows.map((row) => (
              <div key={row.item.id} className="project-gantt-lane">
                <div className="project-gantt-lane-grid" style={{ gridTemplateColumns: columns }}>
                  {range.ticks.map((tick) => (
                    <span
                      key={tick.at}
                      className={`project-gantt-cell ${tick.isToday ? "today" : ""} ${tick.isWeekend ? "weekend" : ""}`}
                    />
                  ))}
                </div>
                {row.layout && (
                  <div
                    className={`project-gantt-bar tone-${row.tone} ${row.span.inferred ? "inferred" : ""}`}
                    style={{ left: `${row.layout.left}%`, width: `${row.layout.width}%` }}
                    title={row.item.title}
                    onPointerDown={(event) => beginDrag(event, row.item, "move")}
                    onClick={(event) => {
                      if (dragRef.current?.moved) {
                        event.preventDefault();
                        return;
                      }
                      onOpenItem(row.item.id);
                    }}
                  >
                    {!archived && (
                      <span
                        className="project-gantt-handle start"
                        onPointerDown={(event) => beginDrag(event, row.item, "start")}
                      />
                    )}
                    <span className="project-gantt-bar-label">{row.item.title}</span>
                    {!archived && (
                      <span
                        className="project-gantt-handle end"
                        onPointerDown={(event) => beginDrag(event, row.item, "end")}
                      />
                    )}
                  </div>
                )}
              </div>
            ))}
            {rows.length === 0 && <div className="project-plan-empty">还没有可排期的任务</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
