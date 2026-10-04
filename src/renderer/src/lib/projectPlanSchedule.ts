/**
 * 计划甘特 / 日历：当地日粒度，纯计算。
 */

export type GanttScale = "week" | "month" | "quarter" | "year";

export interface GanttTick {
  at: number;
  end: number;
  label: string;
  sub?: string;
  isToday: boolean;
  isWeekend: boolean;
}

export interface DateSpan {
  startAt: number;
  dueAt: number;
  inferred: boolean;
}

export function startOfLocalDay(ms: number = Date.now()): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function addLocalDays(ms: number, days: number): number {
  const date = new Date(startOfLocalDay(ms));
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function addLocalMonths(ms: number, months: number): number {
  const date = new Date(startOfLocalDay(ms));
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

export function startOfWeek(ms: number): number {
  const date = new Date(startOfLocalDay(ms));
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return date.getTime();
}

export function startOfMonth(ms: number): number {
  const date = new Date(startOfLocalDay(ms));
  date.setDate(1);
  return date.getTime();
}

export function startOfQuarter(ms: number): number {
  const date = new Date(startOfMonth(ms));
  const month = date.getMonth();
  date.setMonth(month - (month % 3));
  return date.getTime();
}

export function startOfYear(ms: number): number {
  const date = new Date(startOfLocalDay(ms));
  date.setMonth(0, 1);
  return date.getTime();
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function msToDateInput(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function dateInputToMs(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : startOfLocalDay(date.getTime());
}

export function formatDayLabel(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatMonthLabel(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

export function weekdayLabel(ms: number): string {
  const day = new Date(ms).getDay();
  return WEEKDAYS[day === 0 ? 6 : day - 1] ?? "";
}

export function resolveTaskSpan(task: {
  startAt?: number;
  dueAt?: number;
  updatedAt: number;
}): DateSpan {
  const today = startOfLocalDay();
  const inferredFrom = startOfLocalDay(task.startAt ?? task.dueAt ?? task.updatedAt ?? today);
  const startAt = startOfLocalDay(task.startAt ?? inferredFrom);
  const dueAt = startOfLocalDay(task.dueAt ?? task.startAt ?? inferredFrom);
  return {
    ...normalizeSpan(startAt, dueAt),
    inferred: task.startAt == null && task.dueAt == null,
  };
}

export function normalizeSpan(startAt: number, dueAt: number): { startAt: number; dueAt: number } {
  const start = startOfLocalDay(startAt);
  const due = startOfLocalDay(dueAt);
  return due < start ? { startAt: due, dueAt: start } : { startAt: start, dueAt: due };
}

export function moveSpan(startAt: number, dueAt: number, dayDelta: number): { startAt: number; dueAt: number } {
  return normalizeSpan(addLocalDays(startAt, dayDelta), addLocalDays(dueAt, dayDelta));
}

export function moveSpanByMonths(startAt: number, dueAt: number, monthDelta: number): { startAt: number; dueAt: number } {
  return normalizeSpan(addLocalMonths(startAt, monthDelta), addLocalMonths(dueAt, monthDelta));
}

export function resizeSpanByMonths(
  startAt: number,
  dueAt: number,
  edge: "start" | "end",
  monthDelta: number,
): { startAt: number; dueAt: number } {
  if (edge === "start") return normalizeSpan(addLocalMonths(startAt, monthDelta), dueAt);
  return normalizeSpan(startAt, addLocalMonths(dueAt, monthDelta));
}

export function resizeSpan(
  startAt: number,
  dueAt: number,
  edge: "start" | "end",
  dayDelta: number,
): { startAt: number; dueAt: number } {
  if (edge === "start") return normalizeSpan(addLocalDays(startAt, dayDelta), dueAt);
  return normalizeSpan(startAt, addLocalDays(dueAt, dayDelta));
}

export function shiftAnchor(anchor: number, scale: GanttScale, direction: -1 | 1): number {
  if (scale === "week") return addLocalDays(anchor, 7 * direction);
  if (scale === "month") return addLocalMonths(anchor, direction);
  if (scale === "quarter") return addLocalMonths(anchor, 3 * direction);
  return addLocalMonths(anchor, 12 * direction);
}

export function ganttRange(anchor: number, scale: GanttScale): { start: number; end: number; ticks: GanttTick[] } {
  const today = startOfLocalDay();
  if (scale === "year") {
    const start = startOfYear(anchor);
    const ticks: GanttTick[] = [];
    for (let month = 0; month < 12; month++) {
      const at = addLocalMonths(start, month);
      const end = addLocalMonths(start, month + 1);
      ticks.push({
        at,
        end,
        label: `${month + 1}月`,
        isToday: today >= at && today < end,
        isWeekend: false,
      });
    }
    return { start, end: addLocalMonths(start, 12), ticks };
  }

  let start = startOfWeek(anchor);
  let days = 7;
  if (scale === "month") {
    start = startOfMonth(anchor);
    const next = addLocalMonths(start, 1);
    days = Math.round((next - start) / 86_400_000);
  } else if (scale === "quarter") {
    start = startOfQuarter(anchor);
    const next = addLocalMonths(start, 3);
    days = Math.round((next - start) / 86_400_000);
  }

  const ticks: GanttTick[] = [];
  for (let i = 0; i < days; i++) {
    const at = addLocalDays(start, i);
    const end = addLocalDays(start, i + 1);
    const date = new Date(at);
    ticks.push({
      at,
      end,
      label: String(date.getDate()),
      sub: weekdayLabel(at),
      isToday: at === today,
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
    });
  }
  return { start, end: addLocalDays(start, days), ticks };
}

export function ganttRangeTitle(anchor: number, scale: GanttScale): string {
  const date = new Date(startOfLocalDay(anchor));
  if (scale === "week" || scale === "month") return formatMonthLabel(anchor);
  if (scale === "quarter") {
    const q = Math.floor(date.getMonth() / 3) + 1;
    return `${date.getFullYear()}年 Q${q}`;
  }
  return `${date.getFullYear()}年`;
}

/** 今天在时间轴上的位置（列中线，0-100）；不在范围内返回 null */
export function todayMarkerPercent(
  ticks: readonly GanttTick[],
  today: number = startOfLocalDay(),
): number | null {
  if (ticks.length === 0) return null;
  const index = ticks.findIndex((tick) => today >= tick.at && today < tick.end);
  if (index < 0) return null;
  return ((index + 0.5) / ticks.length) * 100;
}

export function taskBarLayout(
  startAt: number,
  dueAt: number,
  rangeStart: number,
  rangeEnd: number,
): { left: number; width: number } | null {
  const span = normalizeSpan(startAt, dueAt);
  const barEnd = addLocalDays(span.dueAt, 1);
  if (barEnd <= rangeStart || span.startAt >= rangeEnd) return null;
  const total = rangeEnd - rangeStart;
  if (total <= 0) return null;
  const leftMs = Math.max(span.startAt, rangeStart) - rangeStart;
  const rightMs = Math.min(barEnd, rangeEnd) - rangeStart;
  return {
    left: (leftMs / total) * 100,
    width: Math.max(1.2, ((rightMs - leftMs) / total) * 100),
  };
}

export function dayDeltaFromPixels(dx: number, colWidth: number): number {
  if (!Number.isFinite(dx) || !Number.isFinite(colWidth) || colWidth <= 0) return 0;
  return Math.round(dx / colWidth);
}

export interface CalendarCell {
  at: number;
  inMonth: boolean;
  isToday: boolean;
}

export function monthGrid(anchor: number): CalendarCell[] {
  const today = startOfLocalDay();
  const monthStart = startOfMonth(anchor);
  const gridStart = startOfWeek(monthStart);
  const nextMonth = addLocalMonths(monthStart, 1);
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const at = addLocalDays(gridStart, i);
    cells.push({
      at,
      inMonth: at >= monthStart && at < nextMonth,
      isToday: at === today,
    });
  }
  return cells;
}

export function taskSpansDay(span: DateSpan, day: number): boolean {
  const dayStart = startOfLocalDay(day);
  return span.startAt <= dayStart && span.dueAt >= dayStart;
}
