/** Product thresholds only. Pi owns eligibility, summarization, persistence and retry. */
export const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.8;
export const DEFAULT_COMPACTION_TRIGGER_TOKENS = 200_000;
export const MIN_COMPACTION_TRIGGER_TOKENS = 1_000;
export const MAX_COMPACTION_TRIGGER_TOKENS = 100_000_000;

export function normalizeCompactionTriggerRatio(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_COMPACTION_TRIGGER_RATIO;
  return Math.min(0.9, Math.max(0.1, Math.round(raw * 100) / 100));
}

/** null explicitly disables the absolute threshold; absent/invalid values use the default. 1K = 1000. */
export function normalizeCompactionTriggerTokens(raw: unknown): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_COMPACTION_TRIGGER_TOKENS;
  return Math.min(MAX_COMPACTION_TRIGGER_TOKENS, Math.max(MIN_COMPACTION_TRIGGER_TOKENS, Math.round(raw)));
}

export function resolveCompactionPolicy(contextWindow: number, ratioInput?: unknown, tokensInput?: unknown) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2) return null;
  const ratio = normalizeCompactionTriggerRatio(ratioInput);
  const absoluteTokens = normalizeCompactionTriggerTokens(tokensInput);
  const ratioTokens = Math.floor(contextWindow * ratio);
  const requestedTokens = Math.min(ratioTokens, absoluteTokens ?? Infinity);
  const reserveTokens = Math.min(contextWindow - 1, Math.max(1024, contextWindow - requestedTokens));
  return { ratio, absoluteTokens, ratioTokens, contextWindow, reserveTokens,
    triggerTokens: contextWindow - reserveTokens,
    limitedBy: absoluteTokens !== null && absoluteTokens < ratioTokens ? "absolute" as const : "ratio" as const };
}
