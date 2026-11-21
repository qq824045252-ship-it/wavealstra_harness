import type { ImprovementAssetKind, ImprovementOutcome } from "./native-improvement";

export const improvementAssetLabels: Record<ImprovementAssetKind, string> = {
  hook: "Hook", tool: "脚本／工具", skill: "技能", convention: "约定", memory: "记忆",
};

export const improvementOutcomeLabels: Record<ImprovementOutcome["state"], string> = {
  effective: "有效", ineffective: "无效", pending: "待验证", regressed: "退化／失效",
};

export function improvementPercent(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return "未测量";
  if (numerator > denominator) return "统计口径不一致";
  return `${(100 * numerator / denominator).toFixed(1)}%`;
}
