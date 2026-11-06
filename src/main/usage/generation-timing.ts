/**
 * generation-timing.ts — 生成速度计时（main 进程侧的纯状态机，无计时器、无 I/O）。
 *
 * ## 为什么要 host 自己记时间
 * pi-durable 的 `LiveState.generation` 只有 `attempt / message / retry / deferred`，**没有任何时间戳**；
 * `message` 是节流提交的 partial AssistantMessage。host 每次 watch 提交（pi 的 partial 提交节流
 * 默认 100ms，产品侧界面按半秒刷新）都会在 `refresh()` 里观测一次它，所以「首个输出 → 现在」的
 * 时长只能由 host 自己累计。
 *
 * ## 口径（与用量面板 `PerformanceTracker` 一致）
 * - 流式估算：**与 native 路径 `GenerationSpeedTracker.estimateDeltaTokens()` 完全同一口径**——
 *   ASCII 字符 0.25 token、非 ASCII 1 token，按 **code point** 遍历（emoji 记 1 个字符，不按 UTF-16
 *   代理对算两次）。`tps = 估算 token / (now - firstOutputAt)`；没有输出、或首个输出后不足
 *   `MIN_STREAM_INTERVAL_MS` → null（除零和瞬时尖峰都不出数）。
 *   注意：不是「字符数 ÷ 4」——那个口径会把中文/emoji 低估约 4 倍，与 native 徽标分叉。
 * - 完成态：`tps = usage.output / ((completedAt - firstOutputAt) / 1000)`，`usage.output` 是权威
 *   token 数（与 `PerformanceTracker` 同口径）；decode 时长**不含** TTFT（首响应等待）。
 *   output=0 / 无首个输出 / 无时长 → tps=null（诚实，不造 0）。
 * - TTFT = `firstOutputAt - startedAt`（首个输出块 - 该次 generation 首次被观测到的时间）。
 * - 时钟防御：任何负时长（时钟回拨）都归 null，永不产生 NaN / Infinity / 负数。
 *
 * 观测边界（为什么 startedAt 不是精确的请求开始时间）：`startedAt` 是该 generation 第一次被 host
 * 观测到的时间。pi 在发起 provider 请求前会先提交 `live.generation = { attempt }`，所以它比真正的
 * HTTP 请求略早一点点（含一次上下文投影和 hook），但比「用户消息时间戳」精确得多——后者会把工具
 * 执行、排队和压缩时间算进 TTFT。
 */

/** 与 native `estimateDeltaTokens()` 相同的权重：1 个 ASCII 字符按 0.25 token 计。 */
export const TOKENS_PER_ASCII_CHAR = 0.25;

/**
 * 流式 tps 的发布门槛。低于这个时长时字符粗估的误差太大（1 个 token / 16ms = 62 tok/s 这种尖峰），
 * 宁可先显示「正在生成」。数值取自非 durable 路径的 `GenerationSpeedTracker`（PUBLISH_INTERVAL_MS）。
 */
export const MIN_STREAM_INTERVAL_MS = 500;

/**
 * 文本 → 粗估 token，**与 `GenerationSpeedTracker.estimateDeltaTokens()` 同口径**：
 * ASCII（U+0000..U+007F）0.25，其余每个 code point 1。按 code point 遍历，
 * 所以 emoji / 扩展区字符只算一个字符，不会被 UTF-16 代理对算两次。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) tokens += char.codePointAt(0)! <= 0x7f ? TOKENS_PER_ASCII_CHAR : 1;
  return tokens;
}

function serializedArguments(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "";
  } catch {
    return "";
  }
}

/**
 * 一次模型调用「已经产出多少 token」的粗估：text + thinking + toolCall 参数。
 * partial message 的 `content` 可能来自 JSON 文档（`live.generation.message`），因此按 unknown 解析，
 * 不信任形状。只有模型产出的内容计入，工具结果和系统消息不算。
 */
export function generationContentTokens(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as { type?: unknown; text?: unknown; thinking?: unknown; arguments?: unknown };
    switch (part.type) {
      case "text":
        if (typeof part.text === "string") tokens += estimateTextTokens(part.text);
        break;
      case "thinking":
        if (typeof part.thinking === "string") tokens += estimateTextTokens(part.thinking);
        break;
      case "toolCall":
        tokens += estimateTextTokens(serializedArguments(part.arguments));
        break;
      default:
        break;
    }
  }
  return tokens;
}

/** 一次观测时刻的流式视图（主进程填进 `GenerationStats` 的就是这些字段）。 */
export interface GenerationTimingSnapshot {
  /** 该次 generation 第一次被观测到的时间（≈ 请求开始的可观测下界）。 */
  startedAt: number;
  /** 最近一次输出增长的时间；从未有输出时等于 startedAt（不假装更新，stalled 判定保持诚实）。 */
  updatedAt: number;
  /** 首个有效输出（文本 / 思考 / 工具参数）出现的时间。 */
  firstOutputAt: number | null;
  /** 由已产出内容粗估的 token 数（与 native 路径同口径）。 */
  estimatedTokens: number;
  /** 流式估算速度；不足 `MIN_STREAM_INTERVAL_MS`、无输出或时钟异常时 null。 */
  tps: number | null;
  /** 首响应耗时；从未有输出或时钟异常时 null。 */
  ttftMs: number | null;
}

/** 完成态结算结果（写入历史投影的是 `tps` 与 `ttftMs`）。 */
export interface GenerationTimingMetrics {
  /** 权威口径：`usage.output / (decodeMs / 1000)`；拿不到完整输出或无时长时 null。 */
  tps: number | null;
  /** 首响应耗时（首个输出块 - generation 首次被观测）。 */
  ttftMs: number | null;
  /** 解码时长（首个输出块 → 完成），不含 TTFT。 */
  decodeMs: number | null;
  /** 权威输出 token；0 时为 null（不把 0 当成「已统计」）。 */
  outputTokens: number | null;
  /** 结束时字符粗估的 token，仅用于诊断/对照，不参与任何计费。 */
  estimatedTokens: number;
}

/**
 * 一次模型调用的生成计时。调用方在 generation 出现（或 attempt 变化）时新建一个实例，
 * 每次观察到 partial 就 `observe()`，展示用 `snapshot()`，收到终态消息时 `finalize()`。
 */
export class GenerationTiming {
  readonly startedAt: number;
  private tokens = 0;
  private firstOutputAt: number | null = null;
  private lastOutputAt: number;
  private settled = false;

  constructor(now: number = Date.now()) {
    const at = Number.isFinite(now) ? now : Date.now();
    this.startedAt = at;
    this.lastOutputAt = at;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  /** 当前累计的粗估 token（text + thinking + toolCall 参数）。 */
  get estimatedTokens(): number {
    return this.tokens;
  }

  /**
   * 观测 partial 的累计粗估 token（`generationContentTokens(partial.content)`）。
   * 只在数值增长时推进 `lastOutputAt` / `firstOutputAt`；工具参数被修复后可能变短——那是更正，不是新输出。
   */
  observe(partialTokens: number, now: number = Date.now()): void {
    if (this.settled) return;
    const tokens = Number.isFinite(partialTokens) ? Math.max(0, partialTokens) : 0;
    if (tokens > this.tokens) {
      this.tokens = tokens;
      // 时钟防御：观测时间早于 startedAt（时钟回拨）时按 startedAt 记，避免负时长。
      const at = Number.isFinite(now) ? Math.max(this.startedAt, now) : this.startedAt;
      this.firstOutputAt ??= at;
      this.lastOutputAt = Math.max(this.lastOutputAt, at);
      return;
    }
    if (tokens < this.tokens) this.tokens = tokens;
  }

  /** 流式视图。幂等、只读；`now` 由调用方传入，便于测试注入时钟。 */
  snapshot(now: number = Date.now()): GenerationTimingSnapshot {
    let tps: number | null = null;
    if (this.firstOutputAt !== null && this.tokens > 0 && Number.isFinite(now)) {
      const elapsedMs = now - this.firstOutputAt;
      // 不足发布门槛（含负时长）→ 不出数；除法分母恒 > 0，不会产生 Infinity。
      if (elapsedMs >= MIN_STREAM_INTERVAL_MS) tps = this.tokens / (elapsedMs / 1000);
    }
    return {
      startedAt: this.startedAt,
      updatedAt: this.lastOutputAt,
      firstOutputAt: this.firstOutputAt,
      estimatedTokens: this.tokens,
      tps: tps !== null && Number.isFinite(tps) && tps > 0 ? tps : null,
      ttftMs: this.ttftMs(),
    };
  }

  /**
   * 用权威 usage.output 与完成时间结算。`outputTokens <= 0`、没有首个输出、或时长非正 → tps=null。
   * 结算后实例不再接受 `observe()`（该次 generation 已结束）。
   */
  finalize(outputTokens: number, completedAt: number = Date.now()): GenerationTimingMetrics {
    this.settled = true;
    const output = Number.isFinite(outputTokens) && outputTokens > 0 ? Math.floor(outputTokens) : 0;
    const decodeMs = this.firstOutputAt !== null && Number.isFinite(completedAt) && completedAt >= this.firstOutputAt
      ? completedAt - this.firstOutputAt
      : null;
    const tps = output > 0 && decodeMs !== null && decodeMs > 0 ? output / (decodeMs / 1000) : null;
    return {
      tps: tps !== null && Number.isFinite(tps) && tps > 0 ? tps : null,
      ttftMs: this.ttftMs(),
      decodeMs,
      outputTokens: output > 0 ? output : null,
      estimatedTokens: this.tokens,
    };
  }

  private ttftMs(): number | null {
    if (this.firstOutputAt === null) return null;
    const ttft = this.firstOutputAt - this.startedAt;
    return Number.isFinite(ttft) && ttft >= 0 ? ttft : null;
  }
}
