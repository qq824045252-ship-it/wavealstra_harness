/**
 * token-format.ts — token 数量的统一显示口径（主进程 DTO 与 renderer 共用）。
 *
 * 产品口径（用户 2026-11-06 明确要求）：token 数字**一律用 M（百万）**，最多 3 位小数，
 * 不再出现「万 / 亿 / K」这类混合单位：
 * - 64.9K   → 0.065M
 * - 1048.0K → 1.048M
 * - 352.3万 → 3.523M
 *
 * 为什么去尾零：1.000M 显示成「1M」更干净，但 0.042M 必须保留三位（否则退化成 0.04M 后
 * 与 0.044M 无法区分）。四舍五入到 3 位后仍为 0 的正数显示「<0.001M」，避免把真实的小额
 * 用量伪装成 0。
 *
 * 只处理「token 数量」。会话数 / 运行次数这类计数请用 formatCount，不要套 M 单位。
 */

function trimZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * token 数量 →「X.XXXM」。
 * @param n token 数；null / undefined / NaN → 「—」（未知，不伪装成 0）
 */
export function formatTokenCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n <= 0) return "0M";
  const millions = n / 1_000_000;
  const fixed = millions.toFixed(3);
  if (Number(fixed) === 0) return "<0.001M";
  return `${trimZeros(fixed)}M`;
}

/** 计数（会话数 / 运行次数 / 次数等）→ 千分位整数；未知 → 「—」。 */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const rounded = Math.round(n);
  return rounded.toLocaleString("en-US");
}

/** 0..1 的比率 → 整数百分比；null/NaN → 「未知」。 */
export function formatRatePercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "未知";
  const pct = rate * 100;
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** 0..1 的比率 → 「—」兜底的短百分比（上下文弹窗用：未知显示破折号而不是「未知」两字）。 */
export function formatRateDash(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  const pct = rate * 100;
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}
