import assert from "node:assert/strict";
import {
  addLocalDays,
  dateInputToMs,
  dayDeltaFromPixels,
  ganttRange,
  ganttRangeTitle,
  todayMarkerPercent,
  monthGrid,
  moveSpan,
  msToDateInput,
  normalizeSpan,
  resizeSpan,
  resolveTaskSpan,
  startOfLocalDay,
  startOfWeek,
  taskBarLayout,
  taskSpansDay,
} from "../src/renderer/src/lib/projectPlanSchedule";

const wed = new Date(2026, 7, 12, 15, 30, 0).getTime(); // 2026-08-12
const day = startOfLocalDay(wed);
assert.equal(new Date(day).getHours(), 0);

const monday = startOfWeek(wed);
assert.equal(new Date(monday).getDay(), 1);

{
  const span = resolveTaskSpan({ updatedAt: wed });
  assert.equal(span.inferred, true);
  assert.equal(span.startAt, day);
  assert.equal(span.dueAt, day);
}

{
  const span = resolveTaskSpan({ startAt: day, dueAt: addLocalDays(day, -2), updatedAt: wed });
  assert.equal(span.startAt, addLocalDays(day, -2));
  assert.equal(span.dueAt, day);
  assert.equal(span.inferred, false);
}

{
  const moved = moveSpan(day, addLocalDays(day, 2), 3);
  assert.equal(moved.startAt, addLocalDays(day, 3));
  assert.equal(moved.dueAt, addLocalDays(day, 5));
  const resized = resizeSpan(day, addLocalDays(day, 2), "end", 1);
  assert.equal(resized.dueAt, addLocalDays(day, 3));
  const flipped = normalizeSpan(addLocalDays(day, 4), day);
  assert.equal(flipped.startAt, day);
  assert.equal(flipped.dueAt, addLocalDays(day, 4));
}

{
  const week = ganttRange(wed, "week");
  assert.equal(week.ticks.length, 7);
  assert.ok(ganttRangeTitle(wed, "week").includes("8月"));
  const marker = todayMarkerPercent(week.ticks, day);
  assert.ok(marker != null && marker > 0 && marker < 100);
  const month = ganttRange(wed, "month");
  assert.ok(month.ticks.length === 31);
  const year = ganttRange(wed, "year");
  assert.equal(year.ticks.length, 12);
  const layout = taskBarLayout(day, day, week.start, week.end);
  assert.ok(layout);
  assert.ok(layout.left >= 0 && layout.left < 100);
  assert.ok(layout.width > 0);
  assert.equal(taskBarLayout(addLocalDays(week.end, 2), addLocalDays(week.end, 3), week.start, week.end), null);
}

{
  assert.equal(dayDeltaFromPixels(56, 56), 1);
  assert.equal(dayDeltaFromPixels(20, 56), 0);
  assert.equal(msToDateInput(day), "2026-08-12");
  assert.equal(dateInputToMs("2026-08-12"), day);
}

{
  const grid = monthGrid(wed);
  assert.equal(grid.length, 42);
  assert.ok(grid.some((cell) => cell.isToday === false));
  const span = resolveTaskSpan({ startAt: day, dueAt: addLocalDays(day, 1), updatedAt: wed });
  assert.equal(taskSpansDay(span, day), true);
  assert.equal(taskSpansDay(span, addLocalDays(day, 2)), false);
}

console.log("project-plan-schedule-test: PASS");
