import { MEMORY_CONTENT_MAX_CHARS, MEMORY_CONTEXT_HARD_BUDGET } from "./memory-kernel";

interface DotsLimitField {
  group: "automatic" | "lookup";
  label: string;
  defaultValue: number;
  min: number;
  max: number;
}

// Historic evidence references without an explicit length use these exact values.
export const LEGACY_DERIVED_MEMORY_CHARS = { scenario: 700, profile: 1000 } as const;

export const dotsMemoryLimitFields = {
  contextBytes: { group: "automatic", label: "每轮自动记忆预算（字节）", defaultValue: MEMORY_CONTEXT_HARD_BUDGET, min: 0, max: MEMORY_CONTEXT_HARD_BUDGET },
  entries: { group: "automatic", label: "每轮自动带入的原始记忆条数", defaultValue: 16, min: 1, max: 32 },
  extendedEntries: { group: "automatic", label: "使用较长摘录的前几条记忆", defaultValue: 4, min: 0, max: 32 },
  extendedBytes: { group: "automatic", label: "较长摘录每条（字节）", defaultValue: 1800, min: 96, max: MEMORY_CONTEXT_HARD_BUDGET },
  excerptBytes: { group: "automatic", label: "其余摘录每条（字节）", defaultValue: 800, min: 96, max: MEMORY_CONTEXT_HARD_BUDGET },
  scenarioChars: { group: "automatic", label: "场景摘要每条（字符）", defaultValue: LEGACY_DERIVED_MEMORY_CHARS.scenario, min: 0, max: MEMORY_CONTENT_MAX_CHARS },
  profileChars: { group: "automatic", label: "个人画像每条（字符）", defaultValue: LEGACY_DERIVED_MEMORY_CHARS.profile, min: 0, max: MEMORY_CONTENT_MAX_CHARS },
  quoteBytes: { group: "automatic", label: "自动附带的用户原话（字节）", defaultValue: 1400, min: 0, max: MEMORY_CONTEXT_HARD_BUDGET },
  searchPreviewChars: { group: "lookup", label: "搜索结果每条预览（字符）", defaultValue: 360, min: 0, max: MEMORY_CONTENT_MAX_CHARS },
  historyPreviewChars: { group: "lookup", label: "历史版本每条预览（字符）", defaultValue: 300, min: 0, max: MEMORY_CONTENT_MAX_CHARS },
  searchDefaultResults: { group: "lookup", label: "主动搜索默认条数", defaultValue: 10, min: 1, max: 100 },
  searchMaxResults: { group: "lookup", label: "主动搜索最多条数", defaultValue: 30, min: 1, max: 100 },
} satisfies Record<string, DotsLimitField>;

export type DotsMemoryLimit = keyof typeof dotsMemoryLimitFields;
export type DotsMemoryLimits = Record<DotsMemoryLimit, number>;

export function resolveDotsMemoryLimits(input?: Partial<DotsMemoryLimits>, fallback?: DotsMemoryLimits): DotsMemoryLimits {
  const limits = {} as DotsMemoryLimits;
  for (const key of Object.keys(dotsMemoryLimitFields) as DotsMemoryLimit[]) {
    const { defaultValue, min, max } = dotsMemoryLimitFields[key];
    const value = input?.[key];
    limits[key] = typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
      ? value : fallback?.[key] ?? defaultValue;
  }
  limits.searchDefaultResults = Math.min(limits.searchDefaultResults, limits.searchMaxResults);
  return limits;
}

export const defaultDotsMemoryLimits = resolveDotsMemoryLimits();
