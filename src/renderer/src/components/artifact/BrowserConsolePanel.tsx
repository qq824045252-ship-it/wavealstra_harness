import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BROWSER_CONSOLE_MAX_ENTRIES,
  formatBrowserConsoleForChat,
  type BrowserConsoleEntryDto,
  type BrowserConsoleLevel,
  type BrowserConsoleTarget,
} from "@shared/browser-console";
import { IconChevronDown, IconChevronRight, IconFilter, IconSparkles } from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";

const CONSOLE_LEVELS: Array<{ level: BrowserConsoleLevel; label: string }> = [
  { level: "error", label: "错误" },
  { level: "warning", label: "警告" },
  { level: "info", label: "信息" },
  { level: "debug", label: "调试" },
];

interface Props {
  target: BrowserConsoleTarget;
  pageUrl?: string;
  sourceLabel: string;
}

function mergeEntries(base: BrowserConsoleEntryDto[], incoming: BrowserConsoleEntryDto[]): BrowserConsoleEntryDto[] {
  const bySequence = new Map<number, BrowserConsoleEntryDto>();
  for (const entry of [...base, ...incoming]) bySequence.set(entry.sequence, entry);
  return [...bySequence.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-BROWSER_CONSOLE_MAX_ENTRIES);
}

/** 浏览器 / HTML 产物预览共用控制台。采集 truth 在 main RuntimeProbeService。 */
export default function BrowserConsolePanel({ target, pageUrl, sourceLabel }: Props): React.JSX.Element {
  const appendComposer = useAppStore((s) => s.appendComposer);
  const addedTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addedCount, setAddedCount] = useState(0);
  const [entries, setEntries] = useState<BrowserConsoleEntryDto[]>([]);
  const [levels, setLevels] = useState<Record<BrowserConsoleLevel, boolean>>({
    debug: true,
    info: true,
    warning: true,
    error: true,
  });

  useEffect(() => {
    const api = window.api?.runtimeConsole;
    if (!api?.snapshot || !api?.onEntry) return;
    let alive = true;
    setEntries([]);
    void api.snapshot(target).then((snapshot) => {
      if (!alive) return;
      setEntries((prev) => mergeEntries(snapshot.entries, prev));
    }).catch(() => undefined);
    const off = api.onEntry((event) => {
      if (!alive || event.target !== target) return;
      setEntries((prev) => mergeEntries(prev, [event.entry]));
      if (event.entry.level === "error") setOpen(true);
    });
    return () => {
      alive = false;
      off();
    };
  }, [target]);

  useEffect(() => () => {
    if (addedTimer.current !== null) window.clearTimeout(addedTimer.current);
  }, []);

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (!levels[entry.level]) return false;
      if (!needle) return true;
      return [entry.message, entry.url, entry.sourceId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [entries, levels, query]);

  const errorCount = useMemo(
    () => entries.filter((entry) => entry.level === "error").length,
    [entries],
  );
  const allLevelsEnabled = CONSOLE_LEVELS.every(({ level }) => levels[level]);

  const clear = useCallback((): void => {
    setEntries([]);
    setAddedCount(0);
    const runtimeConsole = window.api?.runtimeConsole;
    if (runtimeConsole?.clear) void runtimeConsole.clear(target).catch(() => undefined);
  }, [target]);

  const toggleLevel = useCallback((level: BrowserConsoleLevel): void => {
    setLevels((prev) => ({ ...prev, [level]: !prev[level] }));
  }, []);

  const addToConversation = useCallback((): void => {
    if (!visibleEntries.length) return;
    appendComposer(formatBrowserConsoleForChat(visibleEntries, pageUrl, sourceLabel));
    setAddedCount(visibleEntries.length);
    if (addedTimer.current !== null) window.clearTimeout(addedTimer.current);
    addedTimer.current = window.setTimeout(() => {
      setAddedCount(0);
      addedTimer.current = null;
    }, 1800);
  }, [appendComposer, pageUrl, sourceLabel, visibleEntries]);

  return (
    <section className={`browser-console-panel${open ? " is-open" : ""}`} aria-label="控制台日志">
      <div className="browser-console-toolbar">
        <button
          type="button"
          className="browser-console-title-button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
          <span>控制台日志</span>
        </button>
        {errorCount > 0 && (
          <span className="browser-console-error-count" title={`错误 ${errorCount}`}>
            <span aria-hidden>×</span>
            {errorCount}
          </span>
        )}
        <button
          type="button"
          className={`browser-console-icon-button${filterOpen ? " is-active" : ""}`}
          title="筛选控制台日志"
          aria-label="筛选控制台日志"
          aria-pressed={filterOpen}
          onClick={() => {
            setOpen(true);
            setFilterOpen((value) => !value);
          }}
        >
          <IconFilter size={16} />
        </button>
        <span className="browser-console-toolbar-spacer" />
        <button
          type="button"
          className="browser-console-text-button"
          disabled={!entries.length}
          onClick={clear}
        >
          清除
        </button>
        <button
          type="button"
          className={`browser-console-chat-button${addedCount ? " is-done" : ""}`}
          disabled={!visibleEntries.length}
          onClick={addToConversation}
        >
          <IconSparkles size={15} />
          {addedCount ? `已添加到对话 · ${addedCount}` : `添加到对话 · ${visibleEntries.length}`}
        </button>
      </div>
      {open && filterOpen && (
        <div className="browser-console-filterbar">
          <input
            className="browser-console-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="筛选文本或 URL"
            aria-label="筛选控制台日志文本"
          />
          <button
            type="button"
            className={`browser-console-filter-chip${allLevelsEnabled ? " is-active" : ""}`}
            onClick={() => setLevels({ debug: true, info: true, warning: true, error: true })}
          >
            全部
          </button>
          {CONSOLE_LEVELS.map(({ level, label }) => (
            <button
              key={level}
              type="button"
              className={`browser-console-filter-chip level-${level}${levels[level] ? " is-active" : ""}`}
              aria-pressed={levels[level]}
              onClick={() => toggleLevel(level)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="browser-console-list" role="log" aria-live="polite">
          {visibleEntries.length ? visibleEntries.map((entry) => (
            <div key={entry.sequence} className={`browser-console-row level-${entry.level}`}>
              <span className="browser-console-level-icon" aria-hidden>
                {entry.level === "error" ? "×" : entry.level === "warning" ? "!" : entry.level === "info" ? "i" : "·"}
              </span>
              <span className="browser-console-message">{entry.message}</span>
              {entry.sourceId && (
                <span className="browser-console-source" title={entry.sourceId}>
                  {entry.sourceId.split("/").pop()}{entry.line != null ? `:${entry.line}` : ""}
                </span>
              )}
            </div>
          )) : (
            <div className="browser-console-empty">
              {entries.length ? "没有符合当前筛选条件的日志" : "暂无控制台日志"}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
