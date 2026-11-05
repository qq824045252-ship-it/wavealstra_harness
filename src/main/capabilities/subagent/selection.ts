import type { ModelReasoningPreferenceDto } from "../../../shared/model-metadata";
import { reasoningEffortValues, reasoningPreferenceFromTransportLevel } from "../../../shared/model-metadata";
import {
  validateSubagentReasoningPreference,
  type SubagentModelOptionLike,
} from "../../../shared/subagent-model-config";
import {
  canonicalSubagentModelReference,
  resolveSubagentModelThinking,
  type SubagentModelThinkingInput,
} from "./config";

export interface SubagentInvocationSelection {
  model?: string;
  reasoning?: ModelReasoningPreferenceDto;
}

export interface SubagentSelectionInput {
  invocation?: SubagentInvocationSelection;
  parentModelId?: string;
  defaults: SubagentModelThinkingInput;
  availableModels: SubagentModelOptionLike[];
}

export interface SubagentSelectionResult {
  model: string;
  modelSource: "invocation" | "parent" | "role" | "default" | "global";
  thinking: string | null;
  thinkingSource: "invocation" | "transport" | null;
  diagnostics: string[];
}

function requireAvailableModel(reference: string, models: SubagentModelOptionLike[]): string {
  const model = canonicalSubagentModelReference(reference.trim());
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1 || /\s/.test(model)) {
    throw new Error(`Subagent model must be an explicit provider/id reference: ${reference}`);
  }
  if (!models.some((candidate) => candidate.id === model)) {
    throw new Error(`Subagent model is unavailable in the native model scope: ${model}`);
  }
  return model;
}

function validateExplicitReasoning(
  model: string,
  preference: ModelReasoningPreferenceDto,
  models: SubagentModelOptionLike[],
): string {
  const validated = validateSubagentReasoningPreference({
    defaultModel: model,
    preference,
    models,
    globalDefaultModelId: undefined,
  });
  const normalized = validated.preference;
  const changed = !normalized
    || normalized.enabled !== preference.enabled
    || normalized.effort !== preference.effort
    || normalized.budgetTokens !== preference.budgetTokens;
  const disabledEffort = preference.effort === "none" || preference.effort === "off";
  const conflicting = (preference.enabled === false && preference.effort !== undefined && !disabledEffort)
    || (preference.enabled === true && disabledEffort);
  if (changed || conflicting || preference.budgetTokens !== undefined
    || validated.problems.length > 0 || !validated.cliThinking) {
    throw new Error(`Subagent reasoning cannot be honored losslessly for ${model}: ${
      validated.problems.join("; ") || "unsupported, conflicting, or unrepresentable native preference"
    }`);
  }
  return validated.cliThinking;
}

export function resolveSubagentSelection(input: SubagentSelectionInput): SubagentSelectionResult {
  const diagnostics: string[] = [];
  let model: string;
  let modelSource: SubagentSelectionResult["modelSource"];
  const requested = input.invocation?.model;
  if (requested !== undefined) {
    const reference = requested.trim();
    if (reference === "inherit-parent" || reference === "auto") {
      if (!input.parentModelId) throw new Error(`Subagent ${reference} requires an explicit parent model`);
      model = requireAvailableModel(input.parentModelId, input.availableModels);
      modelSource = "parent";
    } else {
      model = requireAvailableModel(reference, input.availableModels);
      modelSource = "invocation";
    }
  } else {
    const defaults = { ...input.defaults };
    let resolved = resolveSubagentModelThinking(defaults);
    diagnostics.push(...resolved.diagnostics);
    while (resolved.model && !input.availableModels.some((candidate) => candidate.id === resolved.model)) {
      diagnostics.push(`Subagent default model ${resolved.model} is unavailable in the native model scope; falling back`);
      switch (resolved.modelSource) {
        case "role": defaults.roleModel = undefined; break;
        case "default": defaults.defaultModel = undefined; break;
        case "global": defaults.globalDefaultModel = undefined; break;
        case null: throw new Error("Resolved subagent model has no configuration source");
      }
      resolved = resolveSubagentModelThinking(defaults);
      diagnostics.push(...resolved.diagnostics);
    }
    if (!resolved.model || !resolved.modelSource) {
      throw new Error(`No usable subagent default model in the native model scope${diagnostics.length ? `: ${diagnostics.join("; ")}` : ""}`);
    }
    model = resolved.model;
    modelSource = resolved.modelSource;
  }

  let thinking: string | null = null;
  let thinkingSource: SubagentSelectionResult["thinkingSource"] = null;
  if (input.invocation?.reasoning !== undefined) {
    thinking = validateExplicitReasoning(model, input.invocation.reasoning, input.availableModels);
    thinkingSource = "invocation";
  } else {
    const resolved = resolveSubagentModelThinking({
      ...input.defaults,
      roleModel: undefined,
      defaultModel: undefined,
      globalDefaultModel: model,
    });
    diagnostics.push(...resolved.diagnostics);
    if (resolved.thinking) {
      const target = input.availableModels.find((candidate) => candidate.id === model);
      const preference = reasoningEffortValues(target?.metadata?.reasoningOptions).includes(resolved.thinking)
        ? { effort: resolved.thinking }
        : reasoningPreferenceFromTransportLevel(resolved.thinking, target?.metadata);
      try {
        if (!preference) throw new Error("Native metadata does not support the configured thinking transport");
        thinking = validateExplicitReasoning(model, preference, input.availableModels);
        if (thinking !== resolved.thinking) throw new Error("Native reasoning does not preserve the configured thinking transport");
        thinkingSource = "transport";
      } catch (error) {
        thinking = null;
        diagnostics.push(`${error instanceof Error ? error.message : String(error)}; using model default reasoning`);
      }
    }
  }
  return { model, modelSource, thinking, thinkingSource, diagnostics: [...new Set(diagnostics)] };
}
