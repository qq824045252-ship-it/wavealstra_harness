/**
 * diagnosticsRules.ts — 「执行诊断」的判定层（纯函数，可单测）。
 *
 * 目标：让不接 AI 的人也能看出「哪一轮不正常、为什么」。原则：
 * 1. 只判有证据的事实；缺数据一律 `unknown` 并写明缺什么，绝不编造；
 * 2. 硬事实（失败/重试/HTTP 错误/工具失败/中断）不看基线；
 * 3. 性能类（首字延迟、输出速率）只跟**本任务同模型的历史分布**比，样本不足 → unknown；
 * 4. 每条判定都带 ruleId + 事实值 + 判定依据，UI 可逐条展开。
 *
 * 缓存口径与 shared/usage-stats 一致：cacheRead / (cacheRead + input + cacheWrite)，
 * 按已知分量加权（不是各请求命中率的算术平均）；分母未知 → null（显示「—」）。
 */
import type {
  DiagnosticSource,
  ModelRequestDiagnostic,
  TaskDiagnosticsDto,
  ToolDiagnostic,
  WaitDiagnostic,
} from "@shared/task-diagnostics";
import { formatTokenCount } from "@shared/token-format";

export type Verdict = "ok" | "warn" | "error" | "unknown" | "waiting";

export interface Finding {
  ruleId: string;
  verdict: Verdict;
  /** 一句话结论（人类可读） */
  title: string;
  /** 事实值（带数字，便于复核） */
  evidence: string;
  /** 为什么这样判：阈值/基线来源 */
  basis: string;
}

export interface CacheSummary {
  /** 加权命中率；分母未知 → null */
  hitRate: number | null;
  cacheRead: number | null;
  input: number | null;
  cacheWrite: number | null;
  /** 参与计算的请求数 */
  requests: number;
  /** 有未知分量（cacheWrite 等）→ 命中率是降级口径 */
  degraded: boolean;
}

export interface TurnDiagnostics {
  key: string;
  /** 「第 3 轮」 */
  label: string;
  index: number;
  sourceKind: DiagnosticSource;
  startedAt: number;
  endedAt: number | null;
  requests: ModelRequestDiagnostic[];
  tools: ToolDiagnostic[];
  waits: WaitDiagnostic[];
  verdict: Verdict;
  findings: Finding[];
  cache: CacheSummary;
  /** 上一轮（同会话）的命中率，用于展示 Δ */
  previousHitRate: number | null;
  hitRateDeltaPct: number | null;
  modelMs: number | null;
  toolMs: number;
  waitingMs: number;
  costUsd: number | null;
  costComplete: boolean;
  firstTokenMs: number | null;
  outputTps: number | null;
  /** 等待项是按时间窗口归到本轮的（不是 executionId 精确匹配） */
  approximateWaits: boolean;
}

export interface Baseline {
  /** 首字延迟 p90（同任务同模型，含样本数） */
  firstToken: { p90: number | null; samples: number };
  /** 输出速率 p10 */
  tps: { p10: number | null; samples: number };
}

export interface DiagnosticsReport {
  turns: TurnDiagnostics[];
  summary: Record<Verdict, number>;
  headline: string;
  baseline: Baseline;
  totals: { requests: number; tools: number; waits: number };
  /** 判定用到的全部规则标题（UI「规则说明」用） */
  rules: Array<{ ruleId: string; text: string }>;
}

/** 首字等待超过该值才算异常（流式首 token 30s 已属异常） */
const FIRST_TOKEN_SLOW_MS = 30_000;
/** 缓存命中率相对上一轮下降超过 30 个百分点 → 回源 */
const CACHE_DROP_PP = 30;
/** 基线最少样本数（不足一律「样本不足」） */
const MIN_BASELINE_SAMPLES = 5;
/** 输出速率下限样本 */
const MIN_TPS = 5;

export const RULE_TEXTS: Array<{ ruleId: string; text: string }> = [
  { ruleId: "A1", text: "模型请求失败或带错误 → 异常" },
  { ruleId: "A2", text: "请求被进程退出打断（interrupted）→ 观测缺口，不算失败" },
  { ruleId: "A3", text: "同一请求发生重试 → 需注意" },
  { ruleId: "A4", text: "HTTP 429/5xx → 异常" },
  { ruleId: "A5", text: `流式请求 ${FIRST_TOKEN_SLOW_MS / 1000}s 内没有任何输出 → 需注意` },
  { ruleId: "A6", text: "工具失败；同名工具连续失败 → 异常（疑似循环）" },
  { ruleId: "A7", text: "工具诊断非空（写冲突/降级/模型回退）→ 需注意" },
  { ruleId: "A8", text: "工具观测不完整（complete=false）→ 观测缺口" },
  { ruleId: "A9", text: "本轮在等待用户回答/审批 → 状态「在等人」，不算故障" },
  { ruleId: "B1", text: "用量字段缺失 → 观测缺口（不按 0 计）" },
  { ruleId: "B2", text: "费用来自 SDK 默认值 → 不是真实账单" },
  { ruleId: "B3", text: "缓存前缀被打断且配置没变 → 需注意" },
  { ruleId: "C1", text: `首字延迟 > 同任务同模型历史 p90（样本 ≥ ${MIN_BASELINE_SAMPLES}）→ 需注意` },
  { ruleId: "C2", text: `输出速率 < 同任务同模型历史 p10（样本 ≥ ${MIN_TPS}）→ 需注意` },
  { ruleId: "C3", text: `缓存命中率比上一轮低 ${CACHE_DROP_PP}pp 以上且输入未缩小 → 需注意（大量回源）` },
];

const VERDICT_RANK: Record<Verdict, number> = { ok: 0, unknown: 1, waiting: 2, warn: 3, error: 4 };

function worst(findings: Finding[]): Verdict {
  return findings.reduce<Verdict>((acc, item) => (VERDICT_RANK[item.verdict] > VERDICT_RANK[acc] ? item.verdict : acc), "ok");
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function ms(value: number | null): string {
  if (value === null) return "未知";
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

/** 分位（线性插值；输入已排序）。 */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low] ?? null;
  const a = sorted[low] ?? 0;
  const b = sorted[high] ?? a;
  return a + (b - a) * (position - low);
}

/**
 * 缓存汇总（加权）：
 * - 分量未知 → hitRate 用已知分量计算并标记 degraded；
 * - input 或 cacheRead 完全未知 → hitRate = null（不写 0，0 会被当成"全部未命中"）。
 */
export function summarizeCache(requests: ModelRequestDiagnostic[]): CacheSummary {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let anyInput = false;
  let anyRead = false;
  let anyWrite = false;
  let degraded = false;
  for (const request of requests) {
    const { input: i, cacheRead: r, cacheWrite: w } = request.usage;
    if (i === null) degraded = true; else { input += i; anyInput = true; }
    if (r === null) degraded = true; else { cacheRead += r; anyRead = true; }
    if (w === null) degraded = true; else { cacheWrite += w; anyWrite = true; }
  }
  const denominator = input + cacheRead + cacheWrite;
  const hitRate = anyInput && anyRead && denominator > 0 ? cacheRead / denominator : null;
  return {
    hitRate,
    cacheRead: anyRead ? cacheRead : null,
    input: anyInput ? input : null,
    cacheWrite: anyWrite ? cacheWrite : null,
    requests: requests.length,
    degraded,
  };
}

function firstTokenOf(request: ModelRequestDiagnostic): number | null {
  return request.firstResponseAt === null ? null : Math.max(0, request.firstResponseAt - request.startedAt);
}

function tpsOf(request: ModelRequestDiagnostic): number | null {
  const output = request.usage.output;
  if (output === null || output <= 0 || request.modelMs === null || request.modelMs < 1000) return null;
  return output / (request.modelMs / 1000);
}

/** 基线：完成态的请求，按 provider/model 分桶，取 p90 首字与 p10 速率。 */
export function buildBaseline(requests: ModelRequestDiagnostic[]): Baseline {
  const completed = requests.filter((request) => request.status === "completed" && request.sourceKind !== "auxiliary");
  const first = completed.map(firstTokenOf).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const tps = completed.map(tpsOf).filter((value): value is number => value !== null).sort((a, b) => a - b);
  return {
    firstToken: { p90: first.length >= MIN_BASELINE_SAMPLES ? percentile(first, 0.9) : null, samples: first.length },
    tps: { p10: tps.length >= MIN_TPS ? percentile(tps, 0.1) : null, samples: tps.length },
  };
}

function requestFindings(
  requests: ModelRequestDiagnostic[],
  baseline: Baseline,
  cache: CacheSummary,
): Finding[] {
  const findings: Finding[] = [];
  for (const request of requests) {
    const label = `${request.provider}/${request.model}`;
    if (request.status === "failed" || request.error) {
      findings.push({
        ruleId: "A1", verdict: "error",
        title: `${label} 请求失败`,
        evidence: request.error ?? request.outcome ?? "无错误文本",
        basis: "请求状态为 failed，或错误字段非空。",
      });
    } else if (request.status === "interrupted") {
      findings.push({
        ruleId: "A2", verdict: "unknown",
        title: `${label} 观测被中断`,
        evidence: "进程退出，该请求的耗时与用量未观测完",
        basis: "诊断库在启动时把遗留 running 记录标为 interrupted；这是观测缺口，不是执行失败。",
      });
    } else if (request.status === "aborted") {
      findings.push({
        ruleId: "A1", verdict: "warn",
        title: `${label} 被中止`,
        evidence: "用户或上游中止了该请求",
        basis: "status=aborted。中止是人为动作，记录为需注意而不是异常。",
      });
    }
    const retries = request.attempts.length - 1;
    if (retries > 0) {
      const statuses = request.attempts.map((attempt) => attempt.httpStatus ?? "?").join(" → ");
      findings.push({
        ruleId: "A3", verdict: "warn",
        title: `发生 ${retries} 次重试`,
        evidence: `HTTP 序列 ${statuses}`,
        basis: "同一请求出现多个 HTTP attempt。",
      });
    }
    const bad = request.attempts.filter((attempt) => attempt.httpStatus !== null && (attempt.httpStatus === 429 || attempt.httpStatus >= 500));
    if (bad.length > 0) {
      findings.push({
        ruleId: "A4", verdict: "error",
        title: `HTTP ${[...new Set(bad.map((attempt) => attempt.httpStatus))].join("/")}`,
        evidence: `${bad.length} 次 429/5xx`,
        basis: "限流或服务端错误。",
      });
    }
    const first = firstTokenOf(request);
    if (first !== null && first > FIRST_TOKEN_SLOW_MS) {
      findings.push({
        ruleId: "A5", verdict: "warn",
        title: "首字等待过长",
        evidence: `${ms(first)} 没有任何输出`,
        basis: `阈值 ${FIRST_TOKEN_SLOW_MS / 1000}s（流式首 token 的硬上限）。`,
      });
    } else if (request.status === "running" && first === null) {
      const age = Date.now() - request.startedAt;
      if (age > FIRST_TOKEN_SLOW_MS) {
        findings.push({
          ruleId: "A5", verdict: "warn",
          title: "仍在等待首字",
          evidence: `已等待 ${ms(age)}`,
          basis: `阈值 ${FIRST_TOKEN_SLOW_MS / 1000}s。`,
        });
      }
    }
    if (baseline.firstToken.p90 !== null && first !== null && first > baseline.firstToken.p90) {
      findings.push({
        ruleId: "C1", verdict: "warn",
        title: "首字比历史慢",
        evidence: `${ms(first)} > p90 ${ms(baseline.firstToken.p90)}`,
        basis: `同任务同模型完成态请求 p90（样本 ${baseline.firstToken.samples}）。`,
      });
    }
    const tps = tpsOf(request);
    if (baseline.tps.p10 !== null && tps !== null && tps < baseline.tps.p10) {
      findings.push({
        ruleId: "C2", verdict: "warn",
        title: "输出速率低于历史",
        evidence: `${tps.toFixed(1)} tok/s < p10 ${baseline.tps.p10.toFixed(1)} tok/s`,
        basis: `同任务同模型完成态请求 p10（样本 ${baseline.tps.samples}）。`,
      });
    }
    if (cache.hitRate === null && (request.usage.input === null || request.usage.cacheRead === null)) {
      findings.push({
        ruleId: "B1", verdict: "unknown",
        title: "用量不完整",
        evidence: `缺失：${[request.usage.input === null ? "新输入" : "", request.usage.cacheRead === null ? "缓存读" : "", request.usage.cacheWrite === null ? "缓存写" : ""].filter(Boolean).join("、")}`,
        basis: "供应商原始事件没有给出这些字段，未按 0 补。",
      });
    }
    if (request.costSource === "sdk-default") {
      findings.push({
        ruleId: "B2", verdict: "warn",
        title: "费用不是真实账单",
        evidence: "费用来自 SDK 初始默认值",
        basis: "没有取得供应商或 Pi 原生计价。",
      });
    }
    if (request.cacheContext.prefixStable === false) {
      const changed = request.cacheContext.changedFields;
      findings.push(changed.length > 0
        ? {
          ruleId: "B3", verdict: "ok",
          title: "缓存前缀变化有解释",
          evidence: `配置变更：${changed.join("、")}`,
          basis: "前缀失效与配置变化同时发生，属于预期。",
        }
        : {
          ruleId: "B3", verdict: "warn",
          title: "缓存前缀无故失效",
          evidence: "前缀已变、但没有观察到配置变化",
          basis: "同一会话下没有 model/tools/instructions 变更却重建了前缀。",
        });
    }
    if (request.cacheContext.coverage && request.cacheContext.coverage !== "complete" && request.cacheContext.coverage !== "unobserved") {
      findings.push({
        ruleId: "B3", verdict: "unknown",
        title: "缓存观测覆盖不全",
        evidence: `coverage=${request.cacheContext.coverage}`,
        basis: "请求体类型不可读（流/二进制）时无法比较前缀。",
      });
    }
  }
  return findings;
}

function toolFindings(tools: ToolDiagnostic[]): Finding[] {
  const findings: Finding[] = [];
  const failures = new Map<string, number>();
  for (const tool of tools) {
    if (tool.status === "failed") {
      findings.push({
        ruleId: "A6", verdict: "error",
        title: `工具 ${tool.name} 失败`,
        evidence: tool.diagnostics.join("、") || "无诊断文本",
        basis: "工具结束事件标记 isError。",
      });
      failures.set(tool.name, (failures.get(tool.name) ?? 0) + 1);
    }
    if (tool.status === "interrupted" || !tool.complete) {
      findings.push({
        ruleId: "A8", verdict: "unknown",
        title: `工具 ${tool.name} 观测不完整`,
        evidence: "执行区间在中途结束，耗时只算到中断点",
        basis: "complete=false（进程退出/观测中断）。",
      });
    }
    if (tool.diagnostics.length > 0 && tool.status !== "failed") {
      findings.push({
        ruleId: "A7", verdict: "warn",
        title: `工具 ${tool.name} 有降级/冲突诊断`,
        evidence: tool.diagnostics.join("、"),
        basis: "工具结果携带诊断文本（写冲突、模型回退等）。",
      });
    }
  }
  for (const [name, count] of failures) {
    if (count >= 2) {
      findings.push({
        ruleId: "A6", verdict: "error",
        title: `同名工具连续失败 ${count} 次`,
        evidence: `${name} × ${count}`,
        basis: "同一轮内同名工具失败 ≥2 次，属于循环征兆。",
      });
    }
  }
  return findings;
}

function waitFindings(waits: WaitDiagnostic[], now: number): Finding[] {
  const findings: Finding[] = [];
  for (const wait of waits) {
    if (wait.status === "pending") {
      findings.push({
        ruleId: "A9", verdict: "waiting",
        title: "在等你回答",
        evidence: `${wait.title} · 已等 ${ms(Math.max(0, now - wait.startedAt))}`,
        basis: "存在未完成的交互请求；这是等待人为输入，不算故障。",
      });
    }
  }
  return findings;
}

interface Bucket {
  key: string;
  sourceKind: DiagnosticSource;
  requests: ModelRequestDiagnostic[];
  tools: ToolDiagnostic[];
  waits: WaitDiagnostic[];
  approximateWaits: boolean;
}

/** 按 executionId 分轮：请求/工具/等待三类共用同一个 id（主进程派生），不靠时间猜。 */
export function bucketTurns(value: TaskDiagnosticsDto): Bucket[] {
  const buckets = new Map<string, Bucket>();
  const bucket = (key: string, sourceKind: DiagnosticSource): Bucket => {
    let item = buckets.get(key);
    if (!item) {
      item = { key, sourceKind, requests: [], tools: [], waits: [], approximateWaits: false };
      buckets.set(key, item);
    }
    return item;
  };
  for (const request of value.requests) bucket(request.executionId, request.sourceKind).requests.push(request);
  for (const tool of value.tools) bucket(tool.executionId, tool.sourceKind).tools.push(tool);
  for (const wait of value.waits) {
    const exact = buckets.get(wait.executionId);
    if (exact) { exact.waits.push(wait); continue; }
    // 等待的 executionId 口径偶尔不同（旧记录/克隆）：按时间窗口归到最近一轮，并标注为估算
    const candidates = [...buckets.values()].filter((item) => item.requests.length > 0);
    const target = candidates
      .filter((item) => Math.min(...item.requests.map((request) => request.startedAt)) <= wait.startedAt)
      .sort((a, b) => Math.max(...b.requests.map((request) => request.startedAt)) - Math.max(...a.requests.map((request) => request.startedAt)))[0];
    if (target) { target.waits.push(wait); target.approximateWaits = true; }
    else {
      const orphan = bucket(wait.executionId, "main");
      orphan.waits.push(wait);
      orphan.approximateWaits = true;
    }
  }
  return [...buckets.values()].sort((a, b) => {
    const start = (item: Bucket) => Math.min(...[...item.requests.map((r) => r.startedAt), ...item.tools.map((t) => t.startedAt), ...item.waits.map((w) => w.startedAt)]);
    return start(a) - start(b);
  });
}

/** 诊断报告：按轮次给出判定、缓存、基线。 */
export function buildDiagnosticsReport(value: TaskDiagnosticsDto, now = Date.now()): DiagnosticsReport {
  const baseline = buildBaseline(value.requests);
  const buckets = bucketTurns(value);
  const turns: TurnDiagnostics[] = [];
  let previousHitRate: number | null = null;
  buckets.forEach((bucket, index) => {
    const requests = [...bucket.requests].sort((a, b) => a.startedAt - b.startedAt);
    const cache = summarizeCache(requests);
    const findings = [
      ...requestFindings(requests, baseline, cache),
      ...toolFindings(bucket.tools),
      ...waitFindings(bucket.waits, now),
    ];
    if (requests.length === 0 && bucket.tools.length === 0 && bucket.waits.length === 0) {
      findings.push({ ruleId: "B0", verdict: "unknown", title: "没有观测记录", evidence: "该轮只有身份没有读数", basis: "诊断库只保存观测到的事件。" });
    }
    const hitRateDeltaPct = cache.hitRate !== null && previousHitRate !== null ? Math.round((cache.hitRate - previousHitRate) * 100) : null;
    if (cache.hitRate !== null && previousHitRate !== null && hitRateDeltaPct !== null && hitRateDeltaPct <= -CACHE_DROP_PP) {
      const inputGrew = (cache.input ?? 0) >= (turns[turns.length - 1]?.cache.input ?? 0);
      findings.push({
        ruleId: "C3", verdict: inputGrew ? "warn" : "ok",
        title: inputGrew ? "缓存大量回源" : "缓存率下降但输入缩小",
        evidence: `${pct(previousHitRate)} → ${pct(cache.hitRate)}（${hitRateDeltaPct}pp）`,
        basis: `同会话上一轮命中率对比；阈值 ${CACHE_DROP_PP}pp。输入缩小通常意味着上下文被裁剪，不是回源。`,
      });
    }
    const startedAt = Math.min(...[...requests.map((r) => r.startedAt), ...bucket.tools.map((t) => t.startedAt), ...bucket.waits.map((w) => w.startedAt)]);
    const ends = [...requests.map((r) => r.finishedAt), ...bucket.tools.map((t) => t.finishedAt), ...bucket.waits.map((w) => w.finishedAt)];
    const firstTokenMs = requests.map(firstTokenOf).filter((v): v is number => v !== null)[0] ?? null;
    const tpsValues = requests.map(tpsOf).filter((v): v is number => v !== null);
    turns.push({
      key: bucket.key,
      label: `第 ${index + 1} 轮`,
      index,
      sourceKind: bucket.sourceKind,
      startedAt: Number.isFinite(startedAt) ? startedAt : now,
      endedAt: ends.every((end) => end === null) ? null : Math.max(...ends.filter((end): end is number => end !== null)),
      requests,
      tools: bucket.tools,
      waits: bucket.waits,
      verdict: worst(findings),
      findings,
      cache,
      previousHitRate,
      hitRateDeltaPct,
      modelMs: requests.some((r) => r.modelMs !== null) ? requests.reduce((sum, r) => sum + (r.modelMs ?? 0), 0) : null,
      toolMs: bucket.tools.reduce((sum, tool) => sum + tool.activeMs, 0),
      waitingMs: bucket.waits.reduce((sum, wait) => sum + Math.max(0, (wait.finishedAt ?? now) - wait.startedAt), 0),
      costUsd: requests.some((r) => r.knownCostUsd !== null) ? requests.reduce((sum, r) => sum + (r.knownCostUsd ?? 0), 0) : null,
      costComplete: requests.length > 0 && requests.every((r) => r.costComplete),
      firstTokenMs,
      outputTps: tpsValues.length > 0 ? tpsValues[tpsValues.length - 1]! : null,
      approximateWaits: bucket.approximateWaits,
    });
    previousHitRate = cache.hitRate ?? previousHitRate;
  });

  const summary: Record<Verdict, number> = { ok: 0, warn: 0, error: 0, unknown: 0, waiting: 0 };
  for (const turn of turns) summary[turn.verdict] += 1;
  const priority = (verdict: Verdict) => VERDICT_RANK[verdict];
  const worstTurn = [...turns].sort((a, b) => priority(b.verdict) - priority(a.verdict)).find((turn) => turn.findings.length > 0);
  const headline = worstTurn && worstTurn.verdict !== "ok"
    ? `${worstTurn.label}：${worstTurn.findings.slice().sort((a, b) => priority(b.verdict) - priority(a.verdict))[0]?.title ?? ""}`
    : turns.length > 0 ? "本任务没有发现异常" : "还没有可判定的观测记录";

  return {
    turns,
    summary,
    headline,
    baseline,
    totals: { requests: value.requests.length, tools: value.tools.length, waits: value.waits.length },
    rules: RULE_TEXTS,
  };
}

/** 缓存一行的可读文本（UI 与测试共用）：`83% · 缓存读 1.2M · 新输入 340K · 缓存写 0` */
export function cacheLine(cache: CacheSummary): string {
  const parts = [
    `缓存命中 ${pct(cache.hitRate)}`,
    cache.cacheRead === null ? "缓存读 未知" : `缓存读 ${formatTokenCount(cache.cacheRead)}`,
    cache.input === null ? "新输入 未知" : `新输入 ${formatTokenCount(cache.input)}`,
    cache.cacheWrite === null ? "缓存写 未知" : `缓存写 ${formatTokenCount(cache.cacheWrite)}`,
  ];
  return `${parts.join(" · ")}${cache.degraded ? "（含未知分量）" : ""}`;
}
