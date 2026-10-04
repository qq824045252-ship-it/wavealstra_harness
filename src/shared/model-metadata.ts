/**
 * Chat model facts are projected from Pi ModelRuntime, including Pi's supported
 * thinking levels and provider-owned catalogs.
 * Other integrations can retain their source-specific capability vocabulary.
 */

export type ModelMetadataSource = "pi" | "provider" | "manual" | "builtin";

export interface ModelReasoningOptionDto {
  type: "effort" | "toggle" | "budget_tokens" | string;
  values?: string[];
  min?: number;
  max?: number;
}

export interface ModelLimitsDto {
  context?: number;
  input?: number;
  output?: number;
}

export interface ModelModalitiesDto {
  input: string[];
  output: string[];
}

export interface ModelCostDto {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputAudio?: number;
  outputAudio?: number;
}

export interface ModelMetadataDto {
  source: ModelMetadataSource;
  catalogName?: string;
  /** Missing output ceilings are left to the server, not fabricated from a request budget. */
  outputLimitPolicy?: "server";
  parameterSources?: { maxTokens?: string; reasoning?: string };
  reasoningControl?: "effort" | "toggle" | "budget" | "provider-default" | "unknown";
  /** Required runtime values for which the provider has published no limit/capability. */
  defaultedFields?: Array<"contextWindow" | "maxTokens" | "reasoning" | "input">;
  /** Local declaration provenance only; resolved values still come from Pi. */
  configuration?: {
    kind: "definition" | "override";
    defaultedFields: Array<"contextWindow" | "maxTokens" | "reasoning" | "input">;
  };
  fetchedAt?: number;
  description?: string;
  family?: string;
  attachment?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  knowledge?: string;
  releaseDate?: string;
  lastUpdated?: string;
  openWeights?: boolean;
  status?: "alpha" | "beta" | "deprecated" | string;
  /** Provider /models transport routes, e.g. /responses or /chat/completions. */
  supportedEndpoints?: string[];
  interleaved?: boolean | { field?: string };
  /** Explicit source-declared reasoning capability. */
  reasoning?: boolean;
  reasoningOptions?: ModelReasoningOptionDto[];
  modalities?: ModelModalitiesDto;
  limits?: ModelLimitsDto;
  cost?: ModelCostDto;
}


export interface ModelReasoningPreferenceDto {
  /** Legacy toggle input; native chat preferences use effort. */
  enabled?: boolean;
  /** Pi thinking level for chat; external integrations may expose native values. */
  effort?: string;
  /** Raw token budget for budget_tokens controls. */
  budgetTokens?: number;
}

export interface ModelPreferenceDto {
  reasoning?: ModelReasoningPreferenceDto;
}

export type ModelPreferencesDto = Record<string, ModelPreferenceDto>;

export function normalizeReasoningPreference(
  preference: ModelReasoningPreferenceDto | undefined,
  metadata: Pick<ModelMetadataDto, "reasoningOptions"> | undefined,
): ModelReasoningPreferenceDto | undefined {
  if (!preference) return undefined;
  const options = metadata?.reasoningOptions ?? [];
  const hasToggle = hasReasoningOption(options, "toggle");
  const effortValues = reasoningEffortValues(options);
  const budget = options.find((option) => option.type === "budget_tokens");

  const next: ModelReasoningPreferenceDto = {};
  if (hasToggle && typeof preference.enabled === "boolean") {
    next.enabled = preference.enabled;
  }
  if (typeof preference.effort === "string" && effortValues.includes(preference.effort)) {
    next.effort = preference.effort;
  }
  if (budget && typeof preference.budgetTokens === "number" && Number.isFinite(preference.budgetTokens)) {
    const min = typeof budget.min === "number" ? budget.min : 0;
    const max = typeof budget.max === "number" ? budget.max : Number.MAX_SAFE_INTEGER;
    next.budgetTokens = Math.min(max, Math.max(min, Math.round(preference.budgetTokens)));
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function normalizeModelPreferences(
  preferences: ModelPreferencesDto | undefined,
): ModelPreferencesDto {
  if (!preferences || typeof preferences !== "object") return {};
  const out: ModelPreferencesDto = {};
  for (const [rawModelId, rawPreference] of Object.entries(preferences)) {
    const modelId = rawModelId.trim();
    if (!modelId || !rawPreference || typeof rawPreference !== "object") continue;
    const reasoning = rawPreference.reasoning;
    if (!reasoning || typeof reasoning !== "object") continue;
    const next: ModelReasoningPreferenceDto = {};
    if (typeof reasoning.enabled === "boolean") next.enabled = reasoning.enabled;
    if (typeof reasoning.effort === "string" && reasoning.effort.trim()) next.effort = reasoning.effort.trim();
    if (typeof reasoning.budgetTokens === "number" && Number.isFinite(reasoning.budgetTokens) && reasoning.budgetTokens >= 0) {
      next.budgetTokens = Math.round(reasoning.budgetTokens);
    }
    if (Object.keys(next).length > 0) out[modelId] = { reasoning: next };
  }
  return out;
}

export function reasoningPreferenceFromTransportLevel(
  level: string | undefined,
  metadata: Pick<ModelMetadataDto, "reasoningOptions"> | undefined,
): ModelReasoningPreferenceDto | undefined {
  if (!level) return undefined;
  const options = metadata?.reasoningOptions ?? [];
  const effortValues = reasoningEffortValues(options);
  const hasToggle = hasReasoningOption(options, "toggle");
  if (level === "off") {
    if (effortValues.includes("none")) return { effort: "none" };
    if (hasToggle) return { enabled: false };
    return undefined;
  }
  if (effortValues.includes(level)) {
    return { ...(hasToggle ? { enabled: true } : {}), effort: level };
  }
  return hasToggle ? { enabled: true } : undefined;
}

export function transportThinkingLevelFromPreference(
  preference: ModelReasoningPreferenceDto | undefined,
  metadata: Pick<ModelMetadataDto, "reasoningOptions"> | undefined,
  runtimeLevels: readonly string[],
): string | undefined {
  if (!preference) return undefined;
  const options = metadata?.reasoningOptions ?? [];
  const effortValues = reasoningEffortValues(options);
  if (preference.enabled === false) return runtimeLevels.includes("off") ? "off" : undefined;
  if (preference.effort === "none") return runtimeLevels.includes("off") ? "off" : undefined;
  if (preference.effort && effortValues.includes(preference.effort) && runtimeLevels.includes(preference.effort)) {
    return preference.effort;
  }
  // Toggle-only / budget-only models intentionally have no product-level fake effort.
  // Runtime-specific translation owns how "enabled" or a token budget is transported.
  return undefined;
}

export function reasoningPreferenceSummary(
  preference: ModelReasoningPreferenceDto | undefined,
  metadata: Pick<ModelMetadataDto, "reasoningOptions" | "reasoningControl"> | undefined,
): string {
  if (!preference) return "默认";
  const parts: string[] = [];
  if (typeof preference.enabled === "boolean") parts.push(preference.enabled ? "开" : "关");
  if (preference.effort) parts.push(reasoningEffortLabel(preference.effort, metadata));
  if (typeof preference.budgetTokens === "number") parts.push(`${preference.budgetTokens} tokens`);
  return parts.join(" · ") || "默认";
}

/** Display toggle-only models as on/off while preserving Pi's transport values. */
export function reasoningEffortLabel(level: string, metadata?: Pick<ModelMetadataDto, "reasoningControl">): string {
  if (metadata?.reasoningControl === "toggle") return level === "off" || level === "none" ? "关闭" : "开启";
  return level === "off" || level === "none" ? `${level}（关闭）` : level;
}

/** Raw effort values declared by the runtime or provider (for UI display). */
export function reasoningEffortValues(
  options: readonly ModelReasoningOptionDto[] | undefined,
): string[] {
  if (!options) return [];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const option of options) {
    if (option?.type !== "effort" || !Array.isArray(option.values)) continue;
    for (const value of option.values) {
      const normalized = String(value).trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      values.push(normalized);
    }
  }
  return values;
}

export function hasReasoningOption(
  options: readonly ModelReasoningOptionDto[] | undefined,
  type: "effort" | "toggle" | "budget_tokens",
): boolean {
  return Boolean(options?.some((option) => option?.type === type));
}

/**
 * Pi currently transports reasoning with a compact level enum. Convert only
 * explicit provider effort values; never invent minimal/low/medium/high.
 *
 * "none" is an external provider effort-off value and maps to Pi's internal "off".
 * A separate toggle also exposes internal "off". Toggle/budget-only models do
 * not gain a fake intensity here.
 */
export function transportThinkingLevelsFromReasoningOptions(
  options: readonly ModelReasoningOptionDto[] | undefined,
): string[] {
  if (!options) return [];
  const out: string[] = [];
  const push = (value: string): void => {
    if (!out.includes(value)) out.push(value);
  };

  const effort = reasoningEffortValues(options);
  if (effort.includes("none")) push("off");
  else if (hasReasoningOption(options, "toggle")) push("off");

  for (const value of effort) {
    if (value === "none") continue;
    push(value);
  }
  return out;
}
