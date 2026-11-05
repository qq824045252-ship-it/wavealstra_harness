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
  /** subagent.json roles：角色别名 → 候选模型（按优先级）。未配置的角色名按显式模型处理。 */
  roles?: Record<string, string[]>;
}

export interface SubagentSelectionResult {
  model: string;
  modelSource: "invocation" | "role-map" | "parent" | "role" | "default" | "global";
  thinking: string | null;
  thinkingSource: "invocation" | "transport" | null;
  diagnostics: string[];
  /** 命中角色别名时回读角色名与候选清单，便于确认模型来源 */
  modelRole?: string;
  roleCandidates?: string[];
}

/** 保留角色名：扇出时按任务分配不同模型；单任务使用它直接报错，不退化为同模型。 */
export const DIVERSE_SUBAGENT_ROLE = "diverse";

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

function resolveRoleCandidate(
  candidates: string[],
  models: SubagentModelOptionLike[],
): string | undefined {
  const seen: string[] = [];
  for (const raw of candidates) {
    const reference = canonicalSubagentModelReference(raw.trim());
    if (!reference || seen.includes(reference)) continue;
    seen.push(reference);
    if (models.some((candidate) => candidate.id === reference)) return reference;
  }
  return undefined;
}

/**
 * `model: "diverse"` 的扇出分配：每个任务拿到不同的可用模型。
 * 候选不足时直接报错，不静默复同模型。
 */
export function assignDiverseModels(input: {
  candidates: string[];
  availableModels: SubagentModelOptionLike[];
  taskCount: number;
  mode: "parallel" | "chain";
}): string[] {
  if (!Number.isInteger(input.taskCount) || input.taskCount < 2) throw new Error("Diverse selection requires at least two tasks");
  const distinct: string[] = [];
  const identities = new Set<string>();
  for (const raw of input.candidates) {
    const reference = canonicalSubagentModelReference(raw.trim());
    if (!reference || distinct.includes(reference)) continue;
    if (!input.availableModels.some((candidate) => candidate.id === reference)) continue;
    // 网关路由前缀和 provider 不算模型身份；同名后端按一个候选计数。
    const identity = reference.split("/").at(-1)!.toLowerCase();
    if (identities.has(identity)) continue;
    identities.add(identity);
    distinct.push(reference);
  }
  if (distinct.length < input.taskCount) {
    throw new Error(
      `Subagent model role "${DIVERSE_SUBAGENT_ROLE}" needs ${input.taskCount} distinct available models for ${input.mode}, got ${distinct.length}`
      + `${distinct.length > 0 ? `: ${distinct.join(", ")}` : ""}. Configure at least ${input.taskCount} entries in subagent.json roles.${DIVERSE_SUBAGENT_ROLE}; refusing to run the same model as a multi-model panel.`,
    );
  }
  return distinct.slice(0, input.taskCount);
}

export function resolveSubagentSelection(input: SubagentSelectionInput): SubagentSelectionResult {
  const diagnostics: string[] = [];
  let model: string;
  let modelSource: SubagentSelectionResult["modelSource"];
  let modelRole: string | undefined;
  let roleCandidates: string[] | undefined;
  const requested = input.invocation?.model;
  if (requested !== undefined) {
    const reference = requested.trim();
    if (reference === "inherit-parent" || reference === "auto") {
      if (!input.parentModelId) throw new Error(`Subagent ${reference} requires an explicit parent model`);
      model = requireAvailableModel(input.parentModelId, input.availableModels);
      modelSource = "parent";
    } else if (reference === DIVERSE_SUBAGENT_ROLE) {
      throw new Error(
        `Subagent model role "${DIVERSE_SUBAGENT_ROLE}" requires a parallel or chain fan-out; a single task would silently run one model.`,
      );
    } else if (input.roles && Object.hasOwn(input.roles, reference) && (roleCandidates = input.roles[reference]) !== undefined) {
      const picked = resolveRoleCandidate(roleCandidates, input.availableModels);
      if (!picked) {
        throw new Error(
          `Subagent model role "${reference}" has no available model in the native model scope. Candidates: ${
            roleCandidates.join(", ") || "(empty)"
          }`,
        );
      }
      model = picked;
      modelSource = "role-map";
      modelRole = reference;
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
  return {
    model,
    modelSource,
    thinking,
    thinkingSource,
    diagnostics: [...new Set(diagnostics)],
    ...(modelRole ? { modelRole } : {}),
    ...(roleCandidates ? { roleCandidates } : {}),
  };
}
