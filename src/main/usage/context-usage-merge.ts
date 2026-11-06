/**
 * context-usage-merge.ts — 会话上下文用量：pi 账本计算值 × 诊断观测值的合并口径。
 *
 * 两个来源都是同一 conversation 口径：
 * - 计算值：pi durable 的 usage 账本（本会话已结算的 input/output/cacheRead/cacheWrite，
 *   四个分量都是 pi 归一化后的互斥数字）；
 * - 观测值：TaskDiagnosticsRepository.usageForConversation（按 provider 上报逐请求累计，
 *   供应商没上报的分量是 null）。
 *
 * 观测值只能补它确实知道的字段：null 表示「不知道」，不能覆盖账本算出的已知值。
 * 旧实现把观测对象整体展开到 contextUsage 上，于是任一 null 字段都会把账本里真实的
 * 计数与缓存命中率擦成 unknown（上下文弹窗因此显示「缓存命中率 —」）。
 */
export interface ComputedContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ObservedContextUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheHitRate: number | null;
}

export interface ContextUsagePatch {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheHitRate: number | null;
}

/** cacheRead/(input+cacheRead+cacheWrite)，对齐 pi footer CH；分母 ≤ 0 → null。 */
export function computedCacheHitRate(usage: ComputedContextUsage): number | null {
  const denominator = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return denominator > 0 ? usage.cacheReadTokens / denominator : null;
}

/** 观测值逐字段补充；未知（null）字段保留账本计算值。 */
export function mergeContextUsage(
  computed: ComputedContextUsage,
  observed?: ObservedContextUsage | null,
): ContextUsagePatch {
  return {
    inputTokens: observed?.inputTokens ?? computed.inputTokens,
    outputTokens: observed?.outputTokens ?? computed.outputTokens,
    cacheReadTokens: observed?.cacheReadTokens ?? computed.cacheReadTokens,
    cacheHitRate: observed?.cacheHitRate ?? computedCacheHitRate(computed),
  };
}
