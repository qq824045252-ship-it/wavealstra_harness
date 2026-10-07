/**
 * config.ts — Subagent 模型/思考强度三级优先级解析（纯函数，可测）。
 *
 * 模型优先级：role frontmatter > subagent.json default > MyBuddy 全局默认；思考 transport 只来自宿主由 defaultReasoning 派生，并绑定派生时的 modelId。
 * - 模型：`provider/id` 形式稳定生效；裸模型名按 settings.defaultProvider 唯一化；
 *   无法唯一解析 → 明确诊断 + 回退（不传 --model，用子进程全局默认）。
 * - 思考 transport：仅在最终模型与 transportThinkingModelId 完全一致时传给 Pi CLI；否则使用模型默认。
 */

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Pi 1.0.3 renamed the Azure provider; role files keep their original contents. */
export function canonicalSubagentModelReference(reference: string): string {
  const legacyPrefix = "azure-openai-responses/";
  return reference.startsWith(legacyPrefix) ? `azure/${reference.slice(legacyPrefix.length)}` : reference;
}

/** 严格校验思考强度；非法返回 null（调用方给出诊断）。 */
export function normalizeThinking(value: unknown): ThinkingLevel | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(v) ? (v as ThinkingLevel) : null;
}

export interface SubagentModelThinkingInput {
  /** role frontmatter model（可含 provider/id 或裸名） */
  roleModel?: string;
  /** subagent.json defaultModel */
  defaultModel?: string;
  /** Main-derived Pi CLI transport; never a user preference. */
  transportThinking?: string;
  /** Model id that transportThinking was derived for. */
  transportThinkingModelId?: string;
  /** settings.json defaultModelId（MyBuddy 全局默认，通常 provider/id） */
  globalDefaultModel?: string;
  /** settings.json defaultProvider（裸名唯一化依据） */
  globalDefaultProvider?: string;
}

export interface SubagentModelThinkingResult {
  /** 最终传给 --model 的值（null = 不传，子进程用全局默认） */
  model: string | null;
  /** 最终传给 --thinking 的值（null = 不传） */
  thinking: string | null;
  modelSource: "role" | "default" | "global" | null;
  thinkingSource: "transport" | null;
  /** 用户可见诊断（裸名解析/非法值/回退） */
  diagnostics: string[];
}

/** 裸模型名按 defaultProvider 唯一化；无法唯一 → null + 诊断。 */
export function resolveBareModel(
  name: string,
  defaultProvider: string | undefined,
  diagnostics: string[],
): string | null {
  if (name.includes("/")) return canonicalSubagentModelReference(name); // provider/id 显式
  if (defaultProvider) {
    const resolved = canonicalSubagentModelReference(`${defaultProvider}/${name}`);
    diagnostics.push(`角色模型「${name}」为裸名，已按 settings.defaultProvider 解析为 ${resolved}`);
    return resolved;
  }
  diagnostics.push(
    `角色模型「${name}」为裸名且无法唯一解析（settings 无 defaultProvider），已回退子进程全局默认模型`,
  );
  return null;
}

/**
 * 三级优先级解析：role > subagent default > MyBuddy global。
 * 任一来源的非法值 → 诊断 + 视为未设置（继续降级）；绝不静默失败。
 */
export function resolveSubagentModelThinking(
  input: SubagentModelThinkingInput,
): SubagentModelThinkingResult {
  const diagnostics: string[] = [];

  // ---- 模型 ----
  let model: string | null = null;
  let modelSource: SubagentModelThinkingResult["modelSource"] = null;
  const roleModel = input.roleModel?.trim();
  const defaultModel = input.defaultModel?.trim();
  const globalModel = input.globalDefaultModel?.trim();
  if (roleModel) {
    modelSource = "role";
    model = resolveBareModel(roleModel, input.globalDefaultProvider, diagnostics);
    if (!model) modelSource = null; // 无法解析 → 诊断已给，回退下一级
  }
  if (!model && defaultModel) {
    modelSource = "default";
    model = resolveBareModel(defaultModel, input.globalDefaultProvider, diagnostics);
    if (!model) modelSource = null;
  }
  if (!model && globalModel) {
    modelSource = "global";
    model = resolveBareModel(globalModel, input.globalDefaultProvider, diagnostics);
    if (!model) modelSource = null;
  }

  // ---- Pi thinking transport ----
  let thinking: string | null = null;
  let thinkingSource: SubagentModelThinkingResult["thinkingSource"] = null;
  const transportModelId = input.transportThinkingModelId?.trim()
    ? canonicalSubagentModelReference(input.transportThinkingModelId.trim()) : undefined;
  const transportValue = input.transportThinking?.trim();
  if (transportValue && model && transportModelId === model) {
    const normalized = normalizeThinking(transportValue);
    if (normalized) {
      thinking = normalized;
      thinkingSource = "transport";
    } else {
      diagnostics.push(`内部 transportThinking「${transportValue}」非法，已使用模型默认`);
    }
  } else if (transportValue && model && transportModelId !== model) {
    diagnostics.push(`思考 transport 绑定 ${transportModelId ?? "未知模型"}，当前目标为 ${model}；已使用当前模型默认`);
  }

  return { model, thinking, modelSource, thinkingSource, diagnostics };
}
