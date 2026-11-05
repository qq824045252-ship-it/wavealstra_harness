/**
 * usage-stats.ts — 用量统计聚合纯函数（主进程查询行 → 展示 VM；renderer 与测试共用）。
 *
 * 输入：usage_events 原始行（统一字段见 UsageEventRow）；输出：账户面板所需视图模型。
 * 所有口径集中在纯函数，对齐当前安装版 pi（AgentSession.getSessionStats）语义：
 * - calls = assistant message 数 = 模型调用数（每个 turn_start/turn_end 包裹恰好一条
 *   assistant 响应，pi 的 assistantMessages 即模型调用数；compaction/toolResult 开销行
 *   与 dispose 安全结算行不计调用）；
 * - turns = 用户轮次 = 每个 session 中 user message 数（可从 session JSONL 重建：
 *   entry.type=message && role=user；pi 每次用户消息开启一轮 agent loop）；
 * - tokens/cost = assistant + toolResult + compaction/branch_summary 全部 usage 之和
 *   （与 pi getSessionStats 的 addUsageToTotals 一致，input/cacheRead/cacheWrite 均为
 *   pi 归一化后的互斥字段）；cache hit = cacheRead/(input+cacheRead+cacheWrite)（对齐 pi
 *   footer CH；cacheWrite 属未命中侧）；
 * - 错误率 = error/errorMessage 非空调用行 / 调用行数；TTFT/TPS 平均仅统计非 null 样本；
 *   sessions = distinct session_file+source_kind，不重复放大。
 */
export interface UsageKnownFields { input: boolean; output: boolean; cacheRead: boolean; cacheWrite: boolean; cost: boolean }
export interface UsageEventRow {
  known?: UsageKnownFields;
  entryId: string;
  taskId: string | null;
  sessionFile: string | null;
  sourceKind: string; // main | subagent | btw | auxiliary
  sourceDetail: string | null;
  provider: string | null;
  model: string | null;
  responseModel: string | null;
  ts: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number | null;
  reasoningTokens: number | null;
  totalTokens: number;
  costTotal: number;
  stopReason: string | null;
  errorMessage: string | null;
  ttftMs: number | null;
  decodeMs: number | null;
  generationTps: number | null;
  modelWallMs: number | null;
  turnIndex: number | null;
  /** 用户轮次（该 assistant 调用所属 user message 序号，1 基；live/backfill 双路径写入；无 user 归属为 null） */
  userTurn: number | null;
}

export interface UsageSummaryVm {
  known?: UsageKnownFields;
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number | null;
  reasoning: number | null;
  cost: number;
  calls: number;
  turns: number;
  sessions: number;
  providers: number;
  cacheHitRate: number | null; // 0..1，无数据 null
  errorRate: number | null; // 0..1，无数据 null
  avgTtftMs: number | null;
  avgTps: number | null;
  avgModelWallMs: number | null;
  errors: number;
}

export interface ProviderModelStat {
  known?: UsageKnownFields;
  provider: string;
  model: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
  totalTokens: number;
  cost: number;
  ttftMs: number | null;
  tps: number | null;
  wallMs: number | null;
  errors: number;
  /** 该模型单独口径的缓存命中率 0..1；无数据 null。 */
  cacheHitRate: number | null;
}

export interface TrendPoint {
  key: string; // "2026-08-15" 或 "15:00"
  tokens: number;
  calls: number;
  cost: number;
}

export const WEEKS_IN_YEAR = 53;

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return sum / nums.length;
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

/** 行内错误判定：stopReason=error 或 errorMessage 非空。 */
export function isErrorRow(row: UsageEventRow): boolean {
  return row.stopReason === "error" || Boolean(row.errorMessage);
}

/**
 * 参与"调用"口径的行 = 模型调用行（main/btw/subagent/auxiliary assistant message）。
 * 排除：compaction/toolresult 开销行（pi getSessionStats 计入 tokens/cost 但不计调用）
 * 与 dispose 安全结算行（stopReason=disposed：请求已开始但 pi 未持久化 assistant message，
 * PI 权威统计不将其计为调用）。
 */
export function isCallRow(row: UsageEventRow): boolean {
  return (
    (row.sourceKind === "main" || row.sourceKind === "btw" || row.sourceKind === "subagent" || row.sourceKind === "auxiliary") &&
    row.stopReason !== "disposed"
  );
}

/**
 * 用量面板按 MyBuddy 选择的模型记账，不跟 pi session jsonl 的 message.model。
 * myBuddyModelId 形如 `provider/id`；有则覆盖 provider/model，pi 原模型退到 responseModel。
 */
export function applyMyBuddyModelAttribution(
  pi: { provider?: string | null; model?: string | null; responseModel?: string | null },
  myBuddyModelId?: string | null,
): { provider: string | null; model: string | null; responseModel: string | null } {
  const trimmed = myBuddyModelId?.trim() ?? "";
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return {
      provider: pi.provider ?? null,
      model: pi.model ?? pi.responseModel ?? null,
      responseModel: pi.responseModel ?? null,
    };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
    responseModel: pi.model ?? pi.responseModel ?? null,
  };
}

export function localDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地日历日 YYYY-MM-DD（不用 UTC ISO，避免时区错日）。 */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 今天 0 点起往回 (rangeDays-1) 个本地日；「今天」= 当日 0 点，不是滚动 24h。 */
export function rangeStartMs(rangeDays: number, now: number): number {
  const today = localDayStart(now);
  const days = Math.max(1, Math.floor(rangeDays) || 1);
  return today - (days - 1) * 24 * 60 * 60 * 1000;
}

export function enumerateLocalDays(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  const end = localDayStart(toMs);
  let t = localDayStart(fromMs);
  while (t <= end) {
    out.push(localDayKey(t));
    t += 24 * 60 * 60 * 1000;
  }
  return out;
}

export interface DailyActivity {
  date: string;
  tokens: number;
  calls: number;
  cost: number;
}

export function dailyActivity(rows: UsageEventRow[], fromMs: number, toMs: number): DailyActivity[] {
  const map = new Map<string, DailyActivity>();
  for (const key of enumerateLocalDays(fromMs, toMs)) {
    map.set(key, { date: key, tokens: 0, calls: 0, cost: 0 });
  }
  for (const r of rows) {
    const key = localDayKey(r.ts);
    const cur = map.get(key);
    if (!cur) continue;
    cur.tokens += r.totalTokens;
    if (isCallRow(r)) cur.calls += 1;
    cur.cost += r.costTotal;
  }
  return [...map.values()];
}

export interface WeeklyActivity {
  weekStart: string;
  tokens: number;
  calls: number;
}

/** 周一=0 … 周日=6，热力图列按周一到周日。 */
export function mondayIndex(date: string | number | Date): number {
  const d = typeof date === "string" ? new Date(`${date}T12:00:00`) : new Date(date);
  return (d.getDay() + 6) % 7;
}

/** 按周一对齐的周合计（与热力图列一致）。 */
export function weeklyTotals(days: Array<{ date: string; tokens: number; calls: number }>): WeeklyActivity[] {
  if (days.length === 0) return [];
  const pad = mondayIndex(days[0].date);
  const out: WeeklyActivity[] = [];
  let week: WeeklyActivity | null = null;
  for (let i = 0; i < pad + days.length; i++) {
    if (i % 7 === 0) {
      if (week) out.push(week);
      const day = i < pad ? null : days[i - pad];
      week = { weekStart: day?.date ?? days[0].date, tokens: 0, calls: 0 };
    }
    if (i >= pad) {
      const day = days[i - pad];
      if (week && day) {
        week.tokens += day.tokens;
        week.calls += day.calls;
        if (!week.weekStart) week.weekStart = day.date;
      }
    }
  }
  if (week) out.push(week);
  return out;
}

/** 把数值映射成 0..maxBars 的柱高；有量至少 1 格，按最大值等比。 */
export function barHeights(values: number[], maxBars: number): number[] {
  const cap = Math.max(1, maxBars);
  const peak = values.reduce((m, v) => Math.max(m, v), 0);
  if (peak <= 0) return values.map(() => 0);
  return values.map((v) => (v <= 0 ? 0 : Math.max(1, Math.round((v / peak) * cap))));
}

export function streakStats(
  days: DailyActivity[],
  todayKey: string,
): { current: number; longest: number } {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    const on = day.tokens > 0 || day.calls > 0;
    if (on) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  let current = 0;
  const idx = days.findIndex((d) => d.date === todayKey);
  for (let i = idx >= 0 ? idx : days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (!day) break;
    if (day.tokens > 0 || day.calls > 0) current += 1;
    else break;
  }
  return { current, longest };
}

/**
 * 最长任务 = 窗口内一次用户轮次（一次运行）的时长，不是会话文件的跨日跨度。
 * 有多轮模型调用时取 max(模型 wall 之和, 该轮首尾时间差)；无 userTurn 则按单次调用 wall。
 */
export function longestSessionMs(rows: UsageEventRow[]): number {
  const map = new Map<string, { min: number; max: number; wall: number }>();
  for (const r of rows.filter(isCallRow)) {
    const session = r.sessionFile ?? r.taskId ?? "?";
    const key = r.userTurn === null ? `${session}:call:${r.entryId}` : `${session}:turn:${r.userTurn}`;
    const cur = map.get(key);
    const wall = r.modelWallMs ?? 0;
    if (!cur) {
      map.set(key, { min: r.ts, max: r.ts, wall });
    } else {
      if (r.ts < cur.min) cur.min = r.ts;
      if (r.ts > cur.max) cur.max = r.ts;
      cur.wall += wall;
    }
  }
  let best = 0;
  for (const g of map.values()) {
    const span = Math.max(0, g.max - g.min);
    best = Math.max(best, g.wall, span);
  }
  return best;
}

/**
 * 用户消息里的技能调用：行首 `/officecli` 或 `$docs-sprint`。
 * 只认消息开头/换行后，避免把路径片段算进去。
 */
export function parseSkillInvocations(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (raw: string): void => {
    const name = raw.trim();
    if (name.length < 2 || name.length > 64) return;
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const takeText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") {
          const o = b as { text?: unknown; content?: unknown };
          if (typeof o.text === "string") return o.text;
          if (typeof o.content === "string") return o.content;
        }
        return "";
      })
      .join("\n");
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } } | null = null;
    try {
      entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
    } catch {
      continue;
    }
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const body = takeText(entry.message.content);
    for (const part of body.split(/\r?\n/)) {
      const m = part.match(/^\s*[/\$]([A-Za-z][\w.-]{1,64})\b/);
      if (m?.[1]) bump(m[1]);
    }
  }
  return counts;
}

/**
 * 窗口内轮次 = Σ 每会话 distinct user_turn（只看传入行）。
 * 不再用整段 jsonl 水位：否则 7 天视图会把会话历史轮次全算进来。
 */
function computeTurns(callRows: UsageEventRow[]): number {
  const liveTurns = new Map<string, Set<number>>();
  for (const r of callRows) {
    if (r.userTurn === null) continue;
    const key = r.sessionFile ?? r.taskId ?? "?";
    let set = liveTurns.get(key);
    if (!set) {
      set = new Set();
      liveTurns.set(key, set);
    }
    set.add(r.userTurn);
  }
  let turns = 0;
  for (const set of liveTurns.values()) turns += set.size;
  return turns;
}

/**
 * cache hit = cacheRead / (input + cacheRead + cacheWrite)，对齐 pi footer CH 官方口径
 * （pi：promptTokens = input+cacheRead+cacheWrite，CH = cacheRead/promptTokens；
 * interactive 侧同样把 cacheWrite 归入 uncached 侧）。cacheWrite 是重新计费的新写入
 * token，属未命中侧。分母 ≤ 0 → null（不 NaN）；全 cacheWrite 轮（input=cacheRead=0,
 * cacheWrite>0）分母>0 → 返回 0（对齐 pi 显示 0%）。
 */
export function cacheHitRate(rows: UsageEventRow[]): number | null {
  if (rows.some(row => row.known && (!row.known.input || !row.known.cacheRead || !row.known.cacheWrite))) return null;
  const cacheRead = sum(rows.map((r) => r.cacheRead));
  const uncached = sum(rows.map((r) => r.inputTokens + r.cacheWrite));
  const denom = cacheRead + uncached;
  if (denom <= 0) return null;
  return cacheRead / denom;
}

/**
 * 总览（传入行 = 已按窗口筛过）。
 * turns = 窗口内 distinct user_turn；sessions = 去重 session 文件/任务（不含 sourceKind，
 * 避免 compaction/toolresult 把一次对话拆成多个会话）。
 * TTFT/TPS/wall 只平均调用行。
 */
export function summarizeRows(rows: UsageEventRow[], _userTurnsBySession?: ReadonlyMap<string, number>): UsageSummaryVm {
  const callRows = rows.filter(isCallRow);
  const calls = callRows.length;
  const errorRows = callRows.filter(isErrorRow);
  const ttfts = callRows.filter((r) => r.ttftMs !== null).map((r) => r.ttftMs as number);
  const tpss = callRows.filter((r) => r.generationTps !== null).map((r) => r.generationTps as number);
  const walls = callRows.filter((r) => r.modelWallMs !== null).map((r) => r.modelWallMs as number);
  const reasoning = rows.some((r) => r.reasoningTokens !== null)
    ? sum(rows.map((r) => r.reasoningTokens ?? 0))
    : null;
  const cacheWrite1h = rows.some((r) => r.cacheWrite1h !== null)
    ? sum(rows.map((r) => r.cacheWrite1h ?? 0))
    : null;
  return {
    known: { input: rows.every(row => row.known?.input !== false), output: rows.every(row => row.known?.output !== false),
      cacheRead: rows.every(row => row.known?.cacheRead !== false), cacheWrite: rows.every(row => row.known?.cacheWrite !== false), cost: rows.every(row => row.known?.cost !== false) },
    totalTokens: sum(rows.map((r) => r.totalTokens)),
    input: sum(rows.map((r) => r.inputTokens)),
    output: sum(rows.map((r) => r.outputTokens)),
    cacheRead: sum(rows.map((r) => r.cacheRead)),
    cacheWrite: sum(rows.map((r) => r.cacheWrite)),
    cacheWrite1h,
    reasoning,
    cost: sum(rows.map((r) => r.costTotal)),
    calls,
    turns: computeTurns(callRows),
    sessions: new Set(callRows.map((r) => r.sessionFile ?? r.taskId ?? "?")).size,
    providers: new Set(callRows.map((r) => r.provider ?? "unknown")).size,
    cacheHitRate: cacheHitRate(rows),
    errorRate: calls > 0 ? errorRows.length / calls : null,
    avgTtftMs: avg(ttfts),
    avgTps: avg(tpss),
    avgModelWallMs: avg(walls),
    errors: errorRows.length,
  };
}

/** Provider → Model drilldown（按 provider+model 分组排序；仅调用行）。 */
export function groupByProviderModel(rows: UsageEventRow[]): ProviderModelStat[] {
  const map = new Map<string, ProviderModelStat & { _ttft: number[]; _tps: number[]; _wall: number[] }>();
  for (const r of rows.filter(isCallRow)) {
    const provider = r.provider ?? "unknown";
    const model = r.model ?? r.responseModel ?? "unknown";
    const key = `${provider}\u0000${model}`;
    let stat = map.get(key);
    if (!stat) {
      stat = {
        provider,
        model,
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: null,
        totalTokens: 0,
        cost: 0,
        ttftMs: null,
        tps: null,
        wallMs: null,
        errors: 0,
        cacheHitRate: null,
        known: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
        _ttft: [],
        _tps: [],
        _wall: [],
      };
      map.set(key, stat);
    }
    stat.calls += 1;
    if (r.known && stat.known) {
      stat.known.input &&= r.known.input; stat.known.output &&= r.known.output;
      stat.known.cacheRead &&= r.known.cacheRead; stat.known.cacheWrite &&= r.known.cacheWrite; stat.known.cost &&= r.known.cost;
    }
    stat.input += r.inputTokens;
    stat.output += r.outputTokens;
    stat.cacheRead += r.cacheRead;
    stat.cacheWrite += r.cacheWrite;
    stat.totalTokens += r.totalTokens;
    stat.cost += r.costTotal;
    if (r.reasoningTokens !== null) stat.reasoning = (stat.reasoning ?? 0) + r.reasoningTokens;
    if (isErrorRow(r)) stat.errors += 1;
    if (r.ttftMs !== null) stat._ttft.push(r.ttftMs);
    if (r.generationTps !== null) stat._tps.push(r.generationTps);
    if (r.modelWallMs !== null) stat._wall.push(r.modelWallMs);
  }
  const out = [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  for (const s of out) {
    s.ttftMs = avg(s._ttft);
    s.tps = avg(s._tps);
    s.wallMs = avg(s._wall);
    const denom = s.cacheRead + s.input + s.cacheWrite;
    s.cacheHitRate = denom > 0 && s.known?.input !== false && s.known?.cacheRead !== false && s.known?.cacheWrite !== false ? s.cacheRead / denom : null;
    delete (s as { _ttft?: number[] })._ttft;
    delete (s as { _tps?: number[] })._tps;
    delete (s as { _wall?: number[] })._wall;
  }
  return out;
}

/** 日趋势：本地日历日，窗口内每天一个点（「今天」也是 1 个日点，不再混小时）。 */
export function dailyTrend(rows: UsageEventRow[], rangeDays: number, now: number): TrendPoint[] {
  const from = rangeStartMs(rangeDays, now);
  return dailyActivity(rows, from, now).map((d) => ({
    key: d.date,
    tokens: d.tokens,
    calls: d.calls,
    cost: d.cost,
  }));
}

/** 53 周热力图：ISO 周键 → { tokens, calls }；无数据周为 0。 */
export function weekHeatmap(rows: UsageEventRow[], year: number): Array<{ week: number; tokens: number; calls: number }> {
  const map = new Map<number, { tokens: number; calls: number }>();
  for (let w = 1; w <= WEEKS_IN_YEAR; w++) map.set(w, { tokens: 0, calls: 0 });
  for (const r of rows) {
    const d = new Date(r.ts);
    if (d.getFullYear() !== year) continue;
    const week = isoWeek(d);
    const cur = map.get(week) ?? { tokens: 0, calls: 0 };
    cur.tokens += r.totalTokens;
    if (isCallRow(r)) cur.calls += 1;
    map.set(week, cur);
  }
  return [...map.entries()].map(([week, v]) => ({ week, ...v }));
}

/** ISO 8601 周数（周一为一周起点）。 */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** 月度汇总。 */
export function monthlySummary(rows: UsageEventRow[]): Array<{ key: string; tokens: number; calls: number; cost: number }> {
  const map = new Map<string, { tokens: number; calls: number; cost: number }>();
  for (const r of rows) {
    const d = new Date(r.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const cur = map.get(key) ?? { tokens: 0, calls: 0, cost: 0 };
    cur.tokens += r.totalTokens;
    if (isCallRow(r)) cur.calls += 1;
    cur.cost += r.costTotal;
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** CSV 导出（drilldown 行）。时间列为 UTC ISO（列名标注 ts_utc_iso，与 UI 本地时区口径区分）。 */
export function toCsv(rows: UsageEventRow[]): string {
  const header = [
    "ts_utc_iso", "source_kind", "provider", "model", "input", "output", "cache_read", "cache_write",
    "reasoning", "total_tokens", "cost", "stop_reason", "error", "ttft_ms", "generation_tps", "model_wall_ms",
  ];
  const lines = rows.map((r) =>
    [
      new Date(r.ts).toISOString(),
      r.sourceKind,
      r.provider ?? "",
      r.model ?? "",
      r.known?.input === false ? "unknown" : r.inputTokens,
      r.known?.output === false ? "unknown" : r.outputTokens,
      r.known?.cacheRead === false ? "unknown" : r.cacheRead,
      r.known?.cacheWrite === false ? "unknown" : r.cacheWrite,
      r.reasoningTokens ?? "",
      r.known && (!r.known.input || !r.known.output || !r.known.cacheRead || !r.known.cacheWrite) ? "unknown" : r.totalTokens,
      r.known?.cost === false ? "unknown" : r.costTotal.toFixed(6),
      r.stopReason ?? "",
      isErrorRow(r) ? "1" : "0",
      r.ttftMs ?? "",
      r.generationTps !== null ? r.generationTps.toFixed(2) : "",
      r.modelWallMs ?? "",
    ]
      .map((v) => `"${String(v).replaceAll('"', '""')}"`)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
