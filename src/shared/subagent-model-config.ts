import {
  normalizeReasoningPreference,
  type ModelMetadataDto,
  type ModelReasoningPreferenceDto,
} from "./model-metadata";

/**
 * Subagent model/reasoning helpers.
 *
 * Product truth:
 * - chat capabilities and thinking levels come from Pi ModelRuntime
 * - Subagent stores a native reasoning override (enabled/effort/budgetTokens)
 * - Pi CLI thinking levels are transport-only and never define model capability
 */
export interface SubagentModelOptionLike {
  id: string;
  name?: string;
  vendor?: string;
  supportsReasoning?: boolean;
  thinkingLevels?: string[];
  metadata?: ModelMetadataDto;
}

/** Pi subprocess transport values. This is not a model capability list. */
export const SUBPROCESS_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export interface SubagentReasoningValidationResult {
  preference?: ModelReasoningPreferenceDto;
  cliThinking?: string;
  problems: string[];
}

export function modelOptionLabel(model: SubagentModelOptionLike): string {
  const name = (model.name ?? "").trim() || model.id;
  const vendor = (model.vendor ?? "").trim();
  return vendor ? `${vendor} · ${name}` : name;
}

export function targetSubagentModel(
  models: SubagentModelOptionLike[],
  modelId: string | null | undefined,
  globalDefaultModelId: string | null | undefined,
): SubagentModelOptionLike | undefined {
  return modelId
    ? models.find((model) => model.id === modelId)
    : models.find((model) => model.id === globalDefaultModelId);
}

/**
 * Validate a native Subagent reasoning override against the target model.
 *
 * If Pi CLI cannot express a valid native preference losslessly, keep the
 * product preference and return no cliThinking. Runtime must use model default
 * rather than inventing a low/medium/high approximation.
 */
export function validateSubagentReasoningPreference(opts: {
  defaultModel: string | null | undefined;
  preference: ModelReasoningPreferenceDto | undefined;
  models: SubagentModelOptionLike[];
  globalDefaultModelId: string | null | undefined;
}): SubagentReasoningValidationResult {
  const target = targetSubagentModel(
    opts.models,
    opts.defaultModel,
    opts.globalDefaultModelId,
  );

  if (!opts.preference) {
    return { preference: undefined, cliThinking: undefined, problems: [] };
  }

  if (!target) {
    return {
      preference: opts.preference,
      cliThinking: undefined,
      problems: ["目标模型暂不可用；已保留原生 Subagent reasoning override，运行时不会猜测传输档位"],
    };
  }

  if (!target.metadata || target.metadata.reasoningOptions === undefined) {
    return {
      preference: opts.preference,
      cliThinking: undefined,
      problems: ["目标模型 reasoning_options 暂不可验证；已保留原生 Subagent override，不猜测 transport"],
    };
  }

  const preference = normalizeReasoningPreference(opts.preference, target.metadata);
  if (!preference) {
    return {
      preference: undefined,
      cliThinking: undefined,
      problems: ["当前模型不支持这组 reasoning override，已回退为模型默认"],
    };
  }

  const problems: string[] = [];
  let cliThinking: string | undefined;

  if (preference.enabled === false || preference.effort === "none") {
    cliThinking = "off";
  } else if (preference.effort) {
    if ((SUBPROCESS_THINKING_LEVELS as readonly string[]).includes(preference.effort)) {
      cliThinking = preference.effort;
    } else {
      problems.push(
        `模型 effort「${preference.effort}」无法由当前 Pi CLI --thinking 无损表达；Subagent 将使用模型默认`,
      );
    }
  } else if (typeof preference.budgetTokens === "number") {
    problems.push(
      "当前 Pi Subagent CLI 没有 budget_tokens 参数；已保留原生偏好，但不会伪造 low/medium/high",
    );
  } else if (preference.enabled === true) {
    problems.push(
      "当前 Pi Subagent CLI 不能无损表达 toggle-only 的“开启”；已保留原生偏好，但不会伪造思考档位",
    );
  }

  return { preference, cliThinking, problems };
}

/**
 * Revalidate an existing native override after changing the target model.
 * Unsupported preferences return to model default; they never fall back to
 * the first transport level.
 */
export function resolveSubagentReasoningAfterModelSwitch(opts: {
  previous: ModelReasoningPreferenceDto | undefined;
  newModelId: string | null | undefined;
  models: SubagentModelOptionLike[];
  globalDefaultModelId: string | null | undefined;
}): { preference?: ModelReasoningPreferenceDto; changed: boolean; problem?: string } {
  if (!opts.previous) return { preference: undefined, changed: false };

  const target = targetSubagentModel(
    opts.models,
    opts.newModelId,
    opts.globalDefaultModelId,
  );
  if (!target || !target.metadata || target.metadata.reasoningOptions === undefined) {
    return { preference: opts.previous, changed: false };
  }

  const normalized = normalizeReasoningPreference(opts.previous, target.metadata);
  if (normalized) return { preference: normalized, changed: false };

  return {
    preference: undefined,
    changed: true,
    problem: "新模型不支持原 Subagent reasoning override，已回到模型默认",
  };
}

/**
 * Extract subagentId from tool output/detail so failed/cancelled runs can still
 * open the Subagent panel.
 */
export function extractSubagentIdFromToolResult(
  tool: string,
  output: string | undefined,
  detail: string | undefined,
): string | null {
  if (tool !== "subagent") return null;
  const text = `${output ?? ""}\n${detail ?? ""}`;
  const match =
    text.match(/subagent: ([a-zA-Z0-9_-]+)/)
    ?? text.match(/\(id: ([a-zA-Z0-9_-]+)\)/);
  return match?.[1] ?? match?.[2] ?? null;
}
