/**
 * UsageStatsModal — 「我的账户 → 用量」面板。
 * 布局参照活跃度仪表：KPI + 日热力图 + 活跃/Token/Cache + skills/模型。
 * 数据来自主进程 usage:dashboard（本地日历窗口，按 MyBuddy 所选模型记账）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { IconX, IconDownload, IconRefresh } from "@/components/common/icons";
import type { UsageDashboardDto, UsageDailyCellDto } from "../../../../shared/agent-ipc";
import type { UsageKnownFields } from "../../../../shared/usage-stats";
import { barHeights, mondayIndex, weeklyTotals } from "@shared/usage-stats";

const allTokensKnown = (known?: UsageKnownFields) => !known || known.input && known.output && known.cacheRead && known.cacheWrite;
const fmtKnown = (value: number, known?: boolean) => known === false ? "未知" : fmtZh(value);
const fmtKnownTotal = (value: number, known?: UsageKnownFields) => allTokensKnown(known) ? fmtZh(value) : value > 0 ? `已知 ${fmtZh(value)}` : "未知";

const RANGES = [
  { days: 1, label: "今天" },
  { days: 7, label: "7 天" },
  { days: 14, label: "14 天" },
  { days: 30, label: "30 天" },
  { days: 90, label: "90 天" },
  { days: 3650, label: "全部" },
];

const HEAT_MODES = [
  { id: "daily" as const, label: "每日" },
  { id: "weekly" as const, label: "每周" },
  { id: "cumulative" as const, label: "累计" },
];

type HeatMode = (typeof HEAT_MODES)[number]["id"];

function trimNum(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function fmtZh(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100_000_000) return `${trimNum(n / 100_000_000, abs >= 1_000_000_000 ? 1 : 1)}亿`;
  if (abs >= 10_000) return `${trimNum(n / 10_000, abs >= 100_000 ? 1 : 1)}万`;
  if (abs >= 1000) return trimNum(n, 0);
  return String(Math.round(n));
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}秒`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem ? `${hours}小时 ${rem}分钟` : `${hours}小时`;
  const days = Math.floor(hours / 24);
  const rh = hours % 24;
  return rh ? `${days}天 ${rh}小时` : `${days}天`;
}

function fmtPct(p: number | null): string {
  return p === null ? "未知" : `${trimNum(p * 100, 0)}%`;
}

function heatLevel(tokens: number, max: number): number {
  if (tokens <= 0) return 0;
  if (max <= 0) return 1;
  const r = tokens / max;
  if (r < 0.2) return 1;
  if (r < 0.45) return 2;
  if (r < 0.75) return 3;
  return 4;
}

type HeatCell = { on: boolean; level: number; title?: string };

function padWeeks(days: UsageDailyCellDto[]): Array<Array<UsageDailyCellDto | null>> {
  if (days.length === 0) return [];
  const pad = mondayIndex(days[0].date);
  const cells: Array<UsageDailyCellDto | null> = [...Array.from({ length: pad }, () => null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<UsageDailyCellDto | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function buildHeatColumns(
  days: UsageDailyCellDto[],
  mode: HeatMode,
): Array<{ cells: HeatCell[]; month?: string }> {
  const weeks = padWeeks(days);
  if (weeks.length === 0) return [];
  const maxDay = days.reduce((m, d) => Math.max(m, d.tokens), 0);
  const weekStats = weeklyTotals(days);
  const weekTokens = weeks.map((_, i) => weekStats[i]?.tokens ?? 0);
  const maxWeek = weekTokens.reduce((m, value) => Math.max(m, value), 0);
  let cum = 0;
  const cumTokens = weekTokens.map((t) => {
    cum += t;
    return cum;
  });
  const cumH = barHeights(cumTokens, 7);
  const seen = new Set<number>();
  return weeks.map((week, wi) => {
    const month = weekMonthLabel(week, seen) || undefined;
    if (mode === "daily") {
      return {
        month,
        cells: week.map((cell) =>
          cell
            ? {
                on: cell.tokens > 0 || cell.calls > 0,
                level: heatLevel(cell.tokens, maxDay),
                title: `${cell.date}: ${fmtZh(cell.tokens)} tokens / ${cell.calls} 次`,
              }
            : { on: false, level: 0 },
        ),
      };
    }
    const stat = weekStats[wi];
    if (mode === "weekly") {
      const title = `${stat?.weekStart ?? ""} 当周 ${fmtZh(stat?.tokens ?? 0)} tokens / ${stat?.calls ?? 0} 次`;
      const level = heatLevel(stat?.tokens ?? 0, maxWeek);
      return {
        month,
        cells: week.map((cell) => {
          const on = Boolean(cell && (cell.tokens > 0 || cell.calls > 0));
          return { on, level: on ? level : 0, title: on ? title : undefined };
        }),
      };
    }

    const height = cumH[wi] ?? 0;
    const title = `${stat?.weekStart ?? ""} 累计 ${fmtZh(cumTokens[wi] ?? 0)} tokens`;
    return {
      month,
      cells: Array.from({ length: 7 }, (_, row) => {
        const fromBottom = 6 - row;
        const on = fromBottom < height;
        return { on, level: on ? 2 : 0, title: on || height > 0 ? title : undefined };
      }),
    };
  });
}

function weekMonthLabel(week: Array<UsageDailyCellDto | null>, seen: Set<number>): string {
  for (const cell of week) {
    if (!cell) continue;
    const month = Number(cell.date.slice(5, 7));
    const day = Number(cell.date.slice(8, 10));
    if (day <= 7 && !seen.has(month)) {
      seen.add(month);
      return `${month}月`;
    }
  }
  return "";
}

function Kpi({
  icon,
  value,
  label,
}: {
  icon: string;
  value: string;
  label: string;
}): React.JSX.Element {
  return (
    <div className="us-kpi">
      <div className="us-kpi-icon" aria-hidden>
        {icon}
      </div>
      <div>
        <div className="us-kpi-value">{value}</div>
        <div className="us-kpi-label">{label}</div>
      </div>
    </div>
  );
}

function StatGrid({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; value: string }>;
}): React.JSX.Element {
  return (
    <section className="us-box">
      <div className="us-box-title">{title}</div>
      <div className="us-stat-grid">
        {items.map((it) => (
          <div key={it.label} className="us-stat">
            <div className="us-stat-label">{it.label}</div>
            <div className="us-stat-value">{it.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function UsageStatsModal(): React.JSX.Element | null {
  const open = useAppStore((s) => s.usageStatsOpen);
  const close = useAppStore((s) => s.closeUsageStats);
  const [rangeDays, setRangeDays] = useState(1);
  const [data, setData] = useState<UsageDashboardDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [skillPage, setSkillPage] = useState(0);
  const [modelPage, setModelPage] = useState(0);
  const [heatMode, setHeatMode] = useState<HeatMode>("daily");

  const load = useCallback(async (days: number): Promise<void> => {
    setLoading(true);
    setLoadError(false);
    try {
      const next = await window.api?.usage?.dashboard(days);
      setData(next ?? null);
      setSkillPage(0);
      setModelPage(0);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setRangeDays(1);
      setHeatMode("daily");
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    void load(rangeDays);
  }, [open, rangeDays, load]);

  const heatCols = useMemo(() => buildHeatColumns(data?.days ?? [], heatMode), [data, heatMode]);

  const skillPageSize = 6;
  const modelPageSize = 4;
  const skillPages = Math.max(1, Math.ceil((data?.skills.length ?? 0) / skillPageSize));
  const modelPages = Math.max(1, Math.ceil((data?.models.length ?? 0) / modelPageSize));
  const skills = (data?.skills ?? []).slice(skillPage * skillPageSize, skillPage * skillPageSize + skillPageSize);
  const models = (data?.models ?? []).slice(modelPage * modelPageSize, modelPage * modelPageSize + modelPageSize);

  if (!open) return null;

  const exportCsv = async (): Promise<void> => {
    try {
      const csv = await window.api?.usage?.exportCsv(rangeDays);
      if (!csv) return;
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mybuddy-usage-${rangeDays}d.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="us-backdrop" onClick={close}>
      <div
        className="us-panel"
        role="dialog"
        aria-modal="true"
        aria-label="用量"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="us-head">
          <div>
            <div className="us-title">用量</div>
            <div className="us-sub">查看 token 活跃度、连续使用、skills 与模型用量。</div>
          </div>
          <div className="us-range">
            {RANGES.map((r) => (
              <button
                key={r.days}
                className={`us-range-btn ${rangeDays === r.days ? "active" : ""}`}
                onClick={() => setRangeDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="us-actions">
            <button className="us-text-btn" title="刷新" onClick={() => void load(rangeDays)} disabled={loading}>
              <IconRefresh size={14} /> 刷新
            </button>
            <button className="icon-btn" title="导出 CSV" onClick={() => void exportCsv()}>
              <IconDownload size={15} />
            </button>
            <button className="icon-btn" title="关闭" onClick={close}>
              <IconX size={15} />
            </button>
          </div>
        </div>

        {loading && !data && !loadError && <div className="us-empty">加载中…</div>}
        {loadError && (
          <div className="us-empty us-empty--error">统计加载失败。请稍后重试或重启应用。</div>
        )}
        {!loading && !loadError && !data && (
          <div className="us-empty">暂无用量数据（完成一次模型对话后开始统计）。</div>
        )}

        {data && (
          <div className="us-body">
            <div className="us-kpis">
              <Kpi icon="☰" value={fmtKnownTotal(data.totalTokens, data.known)} label="累计 tokens" />
              <Kpi icon="⌃" value={fmtZh(data.dailyPeakTokens)} label="单日峰值 tokens" />
              <Kpi icon="◷" value={fmtDuration(data.longestTaskMs)} label="最长任务" />
              <Kpi icon="🔥" value={`${data.currentStreakDays} 天`} label="当前连续" />
              <Kpi icon="▦" value={`${data.longestStreakDays} 天`} label="最长连续" />
            </div>

            <section className="us-box us-heat-box">
              <div className="us-box-head">
                <div className="us-box-title">Token 活动</div>
                <div className="us-heat-modes" role="tablist" aria-label="热力图粒度">
                  {HEAT_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="tab"
                      aria-selected={heatMode === m.id}
                      className={`us-heat-mode ${heatMode === m.id ? "active" : ""}`}
                      onClick={() => setHeatMode(m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="us-heat">
                <div className="us-heat-main">
                  <div className="us-heat-grid">
                    {heatCols.map((col, wi) => (
                      <div key={wi} className="us-heat-col">
                        {col.cells.map((cell, di) => (
                          <div
                            key={`${wi}-${di}`}
                            className={`us-heat-cell lv-${cell.on ? cell.level : 0}`}
                            title={cell.title}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="us-heat-months">
                    {heatCols.map((col, i) => (
                      <span key={i}>{col.month ?? ""}</span>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <div className="us-triple">
              <StatGrid
                title="活跃度指标"
                items={[
                  { label: "总会话数", value: fmtZh(data.sessions) },
                  { label: "总运行数", value: fmtZh(data.runs) },
                  { label: "平均 tokens / 运行", value: allTokensKnown(data.known) ? fmtZh(data.avgTokensPerRun) : "未知" },
                  { label: "最长任务", value: fmtDuration(data.longestTaskMs) },
                ]}
              />
              <StatGrid
                title="Token 指标"
                items={[
                  { label: "输入 tokens", value: fmtKnown(data.input, data.known?.input) },
                  { label: "输出 tokens", value: fmtKnown(data.output, data.known?.output) },
                  { label: "缓存读取 tokens", value: fmtKnown(data.cacheRead, data.known?.cacheRead) },
                  { label: "缓存写入 tokens", value: fmtKnown(data.cacheWrite, data.known?.cacheWrite) },
                ]}
              />
              <StatGrid
                title="Cache 指标"
                items={[
                  { label: "缓存 tokens", value: data.known?.cacheRead === false || data.known?.cacheWrite === false ? "未知" : fmtZh(data.cacheRead + data.cacheWrite) },
                  { label: "Cache 命中率", value: fmtPct(data.cacheHitRate) },
                ]}
              />
            </div>

            <div className="us-split">
              <section className="us-box">
                <div className="us-box-head">
                  <div className="us-box-title">最常用 skills</div>
                  {skillPages > 1 && (
                    <div className="us-pager">
                      <span>
                        {skillPage + 1} / {skillPages}
                      </span>
                      <button type="button" disabled={skillPage <= 0} onClick={() => setSkillPage((p) => p - 1)}>
                        ‹
                      </button>
                      <button
                        type="button"
                        disabled={skillPage >= skillPages - 1}
                        onClick={() => setSkillPage((p) => p + 1)}
                      >
                        ›
                      </button>
                    </div>
                  )}
                </div>
                {skills.length === 0 ? (
                  <div className="us-empty-inline">窗口内没有检测到 /skill 调用</div>
                ) : (
                  <ul className="us-skill-list">
                    {skills.map((s) => (
                      <li key={s.name}>
                        <span className="us-skill-name">/{s.name}</span>
                        <span className="us-skill-count">{s.count}次</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="us-box">
                <div className="us-box-head">
                  <div className="us-box-title">模型用量</div>
                  {modelPages > 1 && (
                    <div className="us-pager">
                      <span>
                        {modelPage + 1} / {modelPages}
                      </span>
                      <button type="button" disabled={modelPage <= 0} onClick={() => setModelPage((p) => p - 1)}>
                        ‹
                      </button>
                      <button
                        type="button"
                        disabled={modelPage >= modelPages - 1}
                        onClick={() => setModelPage((p) => p + 1)}
                      >
                        ›
                      </button>
                    </div>
                  )}
                </div>
                {models.length === 0 ? (
                  <div className="us-empty-inline">无模型调用</div>
                ) : (
                  <div className="us-model-list">
                    {models.map((m) => (
                      <article key={`${m.provider}:${m.model}`} className="us-model">
                        <div className="us-model-top">
                          <div>
                            <div className="us-model-name">{m.model}</div>
                            <div className="us-model-prov">{m.provider}</div>
                          </div>
                          <div className="us-model-total">
                            <div>{fmtKnownTotal(m.totalTokens, m.known)}</div>
                            <div className="us-model-total-hint">总 tokens</div>
                          </div>
                        </div>
                        <div className="us-model-metrics">
                          <span>输入 {fmtKnown(m.input, m.known?.input)}</span>
                          <span>输出 {fmtKnown(m.output, m.known?.output)}</span>
                          <span>缓存读取 {fmtKnown(m.cacheRead, m.known?.cacheRead)}</span>
                          <span>缓存写入 {fmtKnown(m.cacheWrite, m.known?.cacheWrite)}</span>
                          <span className="us-model-hit">缓存命中率 {fmtPct(m.cacheHitRate)}</span>
                          <span className="us-model-calls">{m.calls}次</span>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <div className="us-note">
              数字按所选时间窗口统计（今天 = 当日 0 点起）。模型按 MyBuddy 所选模型记账。Token /
              费用含压缩摘要，但不计为调用。费用按目录单价估算。供应商未报告的字段显示未知；有缺失时，总量和趋势只显示已知部分。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
