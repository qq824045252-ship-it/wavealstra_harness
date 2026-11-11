/**
 * Durable 会话的压缩阈值求解（纯函数）。
 *
 * 产品设置只有两项：窗口比例（ratio）与绝对 token 阈值（absoluteTokens），
 * 两者的口径由 `resolveCompactionPolicy` 统一（先达到者生效）。本文件把它翻译成
 * pi-durable `HarnessSettings.compaction`：native 压缩的 reserveTokens 必须让触发线
 * 严格落在产品阈值上，否则设置页显示 102400、native 实际 111616。
 *
 * 两个刻意的取舍：
 *  - `enabled` 始终为 true：它是 overflow 恢复通道，内嵌引擎（billion-context）自己的
 *    高水位不依赖它；关掉只会让 provider 溢出时无法恢复。
 *  - `backgroundTokens` 固定为 0：内嵌引擎接管期间禁止 native 在后台提前压缩，
 *    否则两条压缩路径会在同一前缀上互相踩。
 */
import { resolveCompactionPolicy, DEFAULT_COMPACTION_TRIGGER_RATIO, DEFAULT_COMPACTION_TRIGGER_TOKENS } from "../../../../shared/compaction-policy";
import type { ProductCompactionSettings } from "./types";

/** 摘要保留的最近上下文默认值：给模型足够近的原文，同时留出摘要本身的预算。 */
export const DEFAULT_DURABLE_KEEP_RECENT_TOKENS = 20_000;

/** 窗口不可用时的保守 reserve：不冒险把上下文压到极小，只保留可用的 overflow 余量。 */
export const CONSERVATIVE_DURABLE_RESERVE_TOKENS = 16_384;

/** 产品设置缺省值（与设置页默认一致）：ratio 0.8 + absolute 200K。 */
export const DEFAULT_PRODUCT_COMPACTION_SETTINGS: ProductCompactionSettings = {
  ratio: DEFAULT_COMPACTION_TRIGGER_RATIO,
  absoluteTokens: DEFAULT_COMPACTION_TRIGGER_TOKENS,
};

export interface ResolveDurableCompactionOptions {
  /** 摘要保留的最近上下文 token 数；缺省 20000。 */
  keepRecentTokens?: number;
  /** 当前会话模型的精确 `"provider/modelId"` key；给了才写 modelOverrides。 */
  modelKey?: string;
}

/** 可直接交给 pi-durable `HarnessSettings.compaction` 的完整字段（全必填）。 */
export interface ResolvedDurableCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  backgroundTokens: number;
  modelOverrides: Record<string, { reserveTokens: number }>;
}

function resolved(keepRecentTokens: number, reserveTokens: number, modelKey?: string): ResolvedDurableCompactionSettings {
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens,
    backgroundTokens: 0,
    modelOverrides: modelKey ? { [modelKey]: { reserveTokens } } : {},
  };
}

/**
 * 把产品阈值翻译成 Durable native 压缩设置。
 *
 * `reserveTokens = contextWindow - triggerTokens`，clamp 到 `[1024, contextWindow - 1]`
 * （与 `resolveCompactionPolicy` 同一口径）。窗口非法时返回保守默认，绝不返回 null：
 * Harness 打开时必须有可读的同步 getter。
 */
export function resolveDurableCompactionSettings(contextWindow: number, product: ProductCompactionSettings,
  options: ResolveDurableCompactionOptions = {}): ResolvedDurableCompactionSettings {
  const keepRecentTokens = Number.isSafeInteger(options.keepRecentTokens) && options.keepRecentTokens! > 0
    ? options.keepRecentTokens!
    : DEFAULT_DURABLE_KEEP_RECENT_TOKENS;
  const policy = resolveCompactionPolicy(contextWindow, product.ratio, product.absoluteTokens);
  // 窗口非法：harness 级保守值对所有模型一致，不需要 per-model 覆盖。
  if (!policy) return resolved(keepRecentTokens, CONSERVATIVE_DURABLE_RESERVE_TOKENS);
  const reserveTokens = Math.min(contextWindow - 1, Math.max(1024, contextWindow - policy.triggerTokens));
  return resolved(keepRecentTokens, reserveTokens, options.modelKey);
}