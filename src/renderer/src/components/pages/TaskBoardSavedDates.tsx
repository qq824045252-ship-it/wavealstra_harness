import { useState } from "react";
import type { BoardDates } from "./TaskBoardDates";

interface SavedFilter {
  label: string;
  dates: BoardDates;
  scope?: string | null;
  search: string;
}
const storageKey = "mybuddy.task-board.saved-date-filters";
function readSaved(): SavedFilter[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(rows)
      ? rows.filter(
          (row) =>
            row &&
            typeof row.label === "string" &&
            typeof row.search === "string" &&
            row.dates &&
            typeof row.dates.kind === "string" &&
            typeof row.dates.range === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function TaskBoardSavedDates({
  dates,
  scope,
  search,
  scopeName,
  projectName,
  valid,
  restore,
}: {
  dates: BoardDates;
  scope?: string | null;
  search: string;
  scopeName: string;
  projectName?: string;
  valid: boolean;
  restore: (v: SavedFilter) => void;
}) {
  const [saved, setSaved] = useState(readSaved);
  const [error, setError] = useState("");
  const when = {
    today: "今天",
    week: "本周",
    previous: "上周",
    next: "下周",
    seven: "近 7 天",
    month: "近 30 天",
    custom: dates.start + " 至 " + dates.end,
  }[dates.range];
  const kind = { follow: "我跟进过", result: "有新结果", due: "到期", updated: "最后更新" }[dates.kind];
  const filter = {
    dates: {
      ...dates,
      start: dates.range === "custom" ? dates.start : "",
      end: dates.range === "custom" ? dates.end : "",
    },
    scope,
    search: search.trim(),
    label: [when + " · " + kind, scope !== undefined ? scopeName : "", projectName, search.trim()]
      .filter(Boolean)
      .join(" · "),
  };
  const key = (v: SavedFilter) =>
    JSON.stringify([
      v.dates.kind,
      v.dates.range,
      v.dates.start,
      v.dates.end,
      v.dates.projectId,
      v.scope === undefined ? "*" : v.scope,
      v.search,
    ]);
  const selected = saved.findIndex((v) => key(v) === key(filter));
  function save(next: SavedFilter[]) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSaved(next);
      setError("");
    } catch {
      setError("筛选未能保存到本机");
    }
  }
  return (
    <>
      {saved.length > 0 && (
        <select
          aria-label="已存筛选"
          value={selected}
          onChange={(e) => {
            const row = saved[Number(e.target.value)];
            if (row) restore(row);
          }}
        >
          <option value={-1} disabled>
            已存筛选
          </option>
          {saved.map((v, i) => (
            <option key={key(v)} value={i}>
              {v.label}
            </option>
          ))}
        </select>
      )}
      <button
        className="btn"
        disabled={!valid}
        onClick={() => save(selected < 0 ? [...saved, filter] : saved.filter((_, i) => i !== selected))}
      >
        {selected < 0 ? "保存此筛选" : "移除已存筛选"}
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
