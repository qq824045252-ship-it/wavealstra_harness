import { formatCount, formatRateDash, formatTokenCount } from "@shared/token-format";

export interface HeaderUsage {
  input?: number;
  totalInput?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  turns?: number;
}
export interface HeaderMetric { key: string; label: string; value: string; title: string }

/** Pi counters are exclusive: input is uncached input, not total prompt tokens.
 * Read only this child's snapshot. Never add parent/siblings or sum snapshots.
 * Missing/invalid counters remain unknown; explicit zero is a valid measurement.
 */
export function subagentHeaderMetrics(usage?: HeaderUsage, scope = "本子代理累计"): HeaderMetric[] {
  const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  // Spawn/failed-call snapshots can contain only zero placeholders. Without
  // any positive measurement these cannot prove a known-zero provider receipt.
  const measured = usage && ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every((n) => n === 0);
  const input = measured ? number(usage.input) : undefined;
  const output = measured ? number(usage.output) : undefined;
  const read = measured ? number(usage.cacheRead) : undefined;
  const write = measured ? number(usage.cacheWrite) : undefined;
  const denominator = number(usage?.totalInput) ?? (input !== undefined && read !== undefined && write !== undefined ? input + read + write : undefined);
  const hit = denominator !== undefined && Number.isFinite(denominator) && denominator > 0 && read !== undefined ? read! / denominator : undefined;
  const token = (key: string, label: string, value: number | undefined, meaning: string): HeaderMetric => ({
    key, label, value: formatTokenCount(value),
    title: value === undefined ? `${meaning}：未取得有效计量，不按 0 计算` : `${meaning}：${formatCount(value)} tokens（${scope}）`,
  });
  return [
    token("input", usage?.totalInput !== undefined ? "总输入" : "新输入", number(usage?.totalInput) ?? input, usage?.totalInput !== undefined ? "供应商报告的总输入，包含缓存部分" : "未命中的输入，不含缓存读取和缓存写入"),
    token("cacheRead", "缓存读取", read, "命中缓存的输入 token"),
    token("output", "输出", output, "输出 token"),
    token("cacheWrite", "缓存写", write, "写入缓存的输入 token"),
    { key: "hit", label: "缓存命中率", value: formatRateDash(hit),
      title: usage?.totalInput !== undefined ? `${scope}：缓存读 ÷ 供应商总输入 tokens；未将缺失缓存写入视为 0` : `${scope}：缓存读 ÷（新输入 + 缓存读 + 缓存写）；缺少任一分量或分母为 0 时显示 —` },
  ];
}
