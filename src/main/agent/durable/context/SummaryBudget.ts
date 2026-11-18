/**
 * 摘要大小契约 —— 这个数字的唯一所有者。
 *
 * 内核是固定 SHA 的 vendor（`vendor/acp-kernel/SOURCE.md`：不允许手改源文件），它的
 * `Config.compress.maxSummaryLength`（默认 20000 **字符**）是唯一会被真正执行的硬约束：
 * 任何一条摘要超长都会让 `applyCompression` 拒绝**整批**范围（内核 #3003 的 all-or-nothing）。
 *
 * 历史上宿主另按 **token** 算预算（输入/3、合并上限 24000 token），两套单位互相不知道：
 * 英文 20000 字符只有约 5000 token，等于把上限放开了 4 倍，范围一大就必然被内核拒绝；
 * 而且拒绝发生在整批之后，宿主退回旧投影，下一轮范围更大、摘要更长 —— 失败是稳定的，不是偶发。
 *
 * 所以这里只保留一条规则，并从内核配置派生所有数字：
 *   1. 一条摘要 ≤ `charMax` 字符（内核上限，唯一的硬约束）；
 *   2. 一条摘要最多代表 `maxRangeChars = charMax × SUMMARY_RANGE_RATIO` 字符原文。
 *      超过就沿原子边界**拆成更多块**，而不是逼出一条超长摘要：拆块保住的细节比截断多；
 *   3. 生成侧的输出 token、分块上限、合并目标都由这两个数字反推，
 *      提示词里写明字符上限 —— 生产者在把摘要交给内核之前就已经满足契约。
 *
 * 原生（Pi）压缩路径没有内核门禁，摘要越完整越好，只是各自输入块要受窗口与成本约束；
 * 它用 {@link nativeSummaryBudget}，与本契约分开但共用同一套推导。
 */
import type { Config } from "../../../../../vendor/acp-kernel/src/index.ts";
import { estimateTextTokens as estimateTokensByScript } from "../../../../shared/token-format";

/** 一条摘要能代表的原文上限，以摘要上限的倍数表示。4:1 是保住 KEEP-VERBATIM 细节的下限。 */
export const SUMMARY_RANGE_RATIO = 4;

/** 原生路径单次摘要请求的输入上限（成本/延迟策略，不是摘要长度上限）。 */
const NATIVE_INPUT_TOKENS = 24_000;

/** 超过这个字符数的摘要不进内存缓存，避免一次长摘要长期占住解析器内存。 */
const MEMO_CACHE_CHARS = 32_768;

/**
 * 摘要超出字符契约（模型无视了提示词里的上限，condense 之后仍然超）。
 * 这是**单个范围**的失败：跳过它继续整理其它范围；其它错误（模型/窗口/响应）是系统性的，
 * 必须中止本轮，否则每多一个候选范围就多浪费三次模型调用。
 */
export class SummaryOverLimitError extends Error {
  constructor(message: string) { super(message); this.name = "Error"; }
}

export interface SummaryBudget {
  /** 内核硬上限（字符）。`Number.POSITIVE_INFINITY` 表示该契约不设长度上限。 */
  readonly charMax: number;
  /** 内核下限（字符）。 */
  readonly charMin: number;
  /** 一条摘要最多代表的原文字符数。 */
  readonly maxRangeChars: number;
  /** 摘要（trim 后）是否满足内核校验。 */
  fits(text: string): boolean;
  /** 生成 `charMax` 字符摘要所需的输出 token，按 `sample` 的字符/token 密度反推。 */
  outputTokens(sample: string): number;
  /** 单次摘要请求可送入的原文 token 上限（同时受窗口余量与契约约束）。 */
  inputLimitTokens(charsPerToken: number, windowTokens: number): number;
  /** 追加到摘要提示词里的硬性规则（含真实数字）。 */
  rule(): string;
  /** 超限时的可执行拒绝文案：超了多少、怎么改。 */
  overage(text: string): string;
  /** 该摘要是否值得进缓存。 */
  cacheable(text: string): boolean;
}

/**
 * 内核折叠（billion-context）使用的契约。数字全部来自即将交给内核的
 * `Config.compress` —— 谁的校验，就用谁的上限，不再出现第二套预算。
 */
export function blockSummaryBudget(compress: Config["compress"]): SummaryBudget {
  const charMax = compress.maxSummaryLength > 0 ? compress.maxSummaryLength : Number.POSITIVE_INFINITY;
  return createBudget(
    charMax,
    Math.max(0, compress.minSummaryLength),
    Number.isFinite(charMax) ? charMax * SUMMARY_RANGE_RATIO : Number.POSITIVE_INFINITY,
    NATIVE_INPUT_TOKENS,
  );
}

/**
 * Pi 原生压缩的契约：没有内核门禁，摘要按窗口尽量完整；输入块仍受 24K token 成本上限。
 * `charMin` 为 0，因为原生摘要没有下限校验。
 */
export function nativeSummaryBudget(): SummaryBudget {
  return createBudget(Number.POSITIVE_INFINITY, 0, Number.POSITIVE_INFINITY, NATIVE_INPUT_TOKENS);
}

function createBudget(charMax: number, charMin: number, maxRangeChars: number, inputTokenCap: number): SummaryBudget {
  const capped = Number.isFinite(charMax);
  // 与内核一致：校验对象是 trim 之后的摘要（compress.ts 的 validateSummaryLength）。
  const fits = (text: string): boolean => text.trim().length <= charMax;
  return {
    charMax,
    charMin,
    maxRangeChars,
    fits,
    // 摘要与原文同语言，所以原文的字符/token 密度就是摘要的密度：
    // 用 CJK 感知的估算器（CJK 1 字符 ≈ 1 token，英文 ≈ 4 字符/token），
    // 不用 pi-ai 的 chars/3.5 —— 后者对中文会把输出预算低估 3.5 倍。
    outputTokens: sample => {
      const tokens = estimateTokensByScript(sample);
      const charsPerToken = tokens > 0 && sample.length > 0 ? sample.length / tokens : 4;
      if (!capped) return Math.max(512, Math.ceil(tokens / 3));
      return Math.max(512, Math.ceil((charMax / Math.max(1, charsPerToken)) * 1.1));
    },
    inputLimitTokens: (charsPerToken, windowTokens) => Math.max(256, Math.min(
      windowTokens,
      inputTokenCap,
      Number.isFinite(maxRangeChars) ? Math.ceil(maxRangeChars / Math.max(1, charsPerToken)) : inputTokenCap,
    )),
    rule: () => capped
      ? `HARD LIMIT: at most ${charMax} characters — count characters (Unicode code points), not words or tokens. A longer summary is rejected and the whole fold is lost, so cut detail instead of exceeding it: drop process narration, repeated tool output and intermediate states; keep paths, versions, exact errors, decisions and open objectives.`
      : `No hard character limit applies to this summary. Be as complete as the window allows, but remove process narration, repeated tool output and intermediate states.`,
    overage: text => {
      const length = text.trim().length;
      if (!capped) return `摘要 ${length} 字符超出当前窗口可用预算：请删掉过程叙述和重复工具输出后再试。`;
      return `摘要 ${length} 字符，超过单块上限 ${charMax} 字符（超出 ${length - charMax}）。`
        + `删掉过程叙述、重复工具输出与中间状态，保留路径、版本、错误原文、决策和未完成目标；`
        + `或把这个范围拆成两个更小的范围分别折叠。`;
    },
    cacheable: text => text.length <= MEMO_CACHE_CHARS,
  };
}

/** 输出上限来自解析后的模型，不使用前台软触发线。 */
export function summaryModelLimits(model: unknown, fallbackWindow: number) {
  const metadata = model as { contextWindow?: number; maxTokens?: number; reasoning?: boolean } | undefined;
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  const window = Math.floor(positive(metadata?.contextWindow) ? Math.min(metadata.contextWindow, fallbackWindow) : fallbackWindow);
  // Missing output metadata is explicit conservative fallback, not unlimited capacity.
  const output = Math.floor(positive(metadata?.maxTokens) ? metadata.maxTokens : Math.min(4096, window / 4));
  const safety = Math.max(256, Math.min(1024, Math.ceil(window * 0.01)));
  return { window, output, safety, reasoning: metadata?.reasoning === true };
}

/** 输出被截断时只放大同一请求的输出预算；输入与提示词保持不变。 */
export function nextSummaryOutputBudget(current: number, ceiling: number): number {
  return Math.min(ceiling, current * 2);
}

/** Responses can omit the reason even when generation hits the requested output cap. */
export function classifySummaryStop(result: { stopReason?: string; rawStopReason?: string; errorMessage?: string; usage?: { output?: number } }, cap: number) {
  const raw = result.rawStopReason;
  if (result.stopReason === "length") return "length";
  if (result.stopReason === "error" && (raw === "incomplete.max_output_tokens" || raw === "incomplete.length")) return "length";
  if (result.stopReason !== "error") return result.stopReason ?? "unknown";
  if (raw === "incomplete.content_filter") return "error:content_filter";
  if (raw === "incomplete") {
    const reasonMissing = result.errorMessage === undefined || result.errorMessage === "Response incomplete without a provider reason";
    if (reasonMissing && Number.isFinite(cap) && cap > 0 && result.usage?.output === cap) return "length:incomplete-at-cap";
    return "error:incomplete";
  }
  return raw?.startsWith("incomplete.") ? "error:incomplete-explicit-reason" : "error";
}
