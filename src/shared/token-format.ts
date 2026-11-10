/** Token quantities use millions with exactly three decimals (user 2026-11-10).
 * Rounded small positive values may display 0.000M; exact counts belong in tooltips.
 * Non-token counts must continue using formatCount.
 */

/**
 * token 数量 →「X.XXXM」。
 * @param n token 数；null / undefined / NaN → 「—」（未知，不伪装成 0）
 */
export function formatTokenCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(Math.max(0, n) / 1_000_000).toFixed(3)}M`;
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
