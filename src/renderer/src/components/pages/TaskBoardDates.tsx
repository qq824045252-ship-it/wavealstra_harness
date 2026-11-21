import type { BoardDateKind } from "@shared/task-board";
import { addLocalDays, dateInputToMs, msToDateInput, startOfWeek } from "@/lib/projectPlanSchedule";
import { useAppStore } from "@/store/appStore";
import type { ReactNode } from "react";

type Range = "today" | "week" | "previous" | "next" | "seven" | "month" | "custom";
export interface BoardDates {
  kind: BoardDateKind;
  range: Range;
  start: string;
  end: string;
  projectId?: string;
}
export function boardRange(dates: BoardDates, today: number) {
  if (dates.range === "custom") {
    const from = dateInputToMs(dates.start),
      last = dateInputToMs(dates.end);
    return from != null && last != null && last >= from ? { from, until: addLocalDays(last, 1) } : undefined;
  }
  const monday = startOfWeek(today);
  if (dates.range === "week") return { from: monday, until: addLocalDays(monday, 7) };
  if (dates.range === "previous") return { from: addLocalDays(monday, -7), until: monday };
  if (dates.range === "next") return { from: addLocalDays(monday, 7), until: addLocalDays(monday, 14) };
  if (dates.range === "seven") return { from: addLocalDays(today, -6), until: addLocalDays(today, 1) };
  return { from: dates.range === "month" ? addLocalDays(today, -29) : today, until: addLocalDays(today, 1) };
}

export function TaskBoardDates({
  value,
  change,
  today,
  children,
}: {
  value: BoardDates;
  change: (v: BoardDates) => void;
  today: number;
  children?: ReactNode;
}) {
  const update = (part: Partial<BoardDates>) => change({ ...value, ...part });
  const projects = useAppStore((s) => s.projects);
  return (
    <div className="task-board-date-filters">
      <select
        aria-label="日期依据"
        value={value.kind}
        onChange={(e) => update({ kind: e.target.value as BoardDateKind })}
      >
        <option value="follow">我跟进过</option>
        <option value="result">有新结果</option>
        <option value="due">到期</option>
        <option value="updated">最后更新</option>
      </select>
      <select
        aria-label="日期范围"
        value={value.range}
        onChange={(e) =>
          update({
            range: e.target.value as Range,
            start: value.start || msToDateInput(today),
            end: value.end || msToDateInput(today),
          })
        }
      >
        <option value="today">今天</option>
        <option value="week">本周</option>
        <option value="previous">上周</option>
        <option value="next">下周</option>
        <option value="seven">近 7 天</option>
        <option value="month">近 30 天</option>
        <option value="custom">自定义</option>
      </select>
      {projects.some((p) => !p.archived) && (
        <select
          aria-label="筛选项目"
          value={value.projectId ?? ""}
          onChange={(e) => update({ projectId: e.target.value || undefined })}
        >
          <option value="">全部项目</option>
          {projects
            .filter((p) => !p.archived)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      )}
      {value.range === "custom" && (
        <>
          <input
            type="date"
            aria-label="开始日期"
            value={value.start}
            onChange={(e) => update({ start: e.target.value })}
          />
          <span>至</span>
          <input
            type="date"
            aria-label="结束日期"
            min={value.start}
            value={value.end}
            onChange={(e) => update({ end: e.target.value })}
          />
        </>
      )}
      {children}
    </div>
  );
}
