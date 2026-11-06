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
 * 子代理累计用量（一个实例在本次运行内的合计，不是单次请求）。
 * 字段与 `SubagentSummaryDto.usage` / usage_events 的 token 列同口径。
 */
export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Durable 子代理结果的结构化视图（工具 details.results[] 的安全投影）。 */
export interface SubagentResultRecord {
  subagentId: string;
  displayName?: string;
  task?: string;
  status?: string;
  exitCode?: number;
  errorMessage?: string;
  /** 该子代理最后一条 assistant 文本（用于完成态摘要） */
  finalText?: string;
  resolvedModel?: string;
  model?: string;
  /** 累计用量；四个主分量任一缺失/畸形则整体视为未知（不补零） */
  usage?: SubagentUsage;
}

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** 累计用量只接受四个主分量为有效非负数；辅助分量缺失时按 0 处理（它们是计数，不是成本估算）。 */
function parseSubagentUsage(raw: unknown): SubagentUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  if (!isNonNegativeNumber(usage.input) || !isNonNegativeNumber(usage.output)
    || !isNonNegativeNumber(usage.cacheRead) || !isNonNegativeNumber(usage.cacheWrite)) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: isNonNegativeNumber(usage.cost) ? usage.cost : 0,
    contextTokens: isNonNegativeNumber(usage.contextTokens) ? usage.contextTokens : 0,
    turns: isNonNegativeNumber(usage.turns) ? Math.round(usage.turns) : 0,
  };
}

function messageFinalText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
    if (message?.role !== "assistant") continue;
    const text = (message.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part?.text ?? "")
      .join("");
    if (text) return text;
  }
  return "";
}

/**
 * 从工具 `detail` 解析 Durable 结构化结果（`details.results[]`）。
 * 新架构里完成态工具的 detail 是结果详情 JSON；旧消息或运行中的工具则是入参，返回空数组。
 */
export function parseSubagentResultDetails(
  tool: string,
  detail: string | undefined,
): SubagentResultRecord[] {
  if (tool !== "subagent" || !detail) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return [];
  }
  const results = (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: SubagentResultRecord[] = [];
  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const subagentId = typeof record.subagentId === "string" ? record.subagentId : "";
    if (!subagentId) continue;
    out.push({
      subagentId,
      displayName: normalizeSubagentDisplayName(record.displayName),
      task: typeof record.task === "string" ? record.task : undefined,
      status: typeof record.status === "string" ? record.status : undefined,
      exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
      errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : undefined,
      finalText: messageFinalText(record.messages) || undefined,
      resolvedModel: typeof record.resolvedModel === "string" ? record.resolvedModel : undefined,
      model: typeof record.model === "string" ? record.model : undefined,
      usage: parseSubagentUsage(record.usage),
    });
  }
  return out;
}

/**
 * Extract subagentId from tool output/detail so failed/cancelled runs can still
 * open the Subagent panel. Prefers Durable structured results; falls back to
 * the legacy text markers (`> subagent: id` / `(id: id)`).
 */
export function extractSubagentIdFromToolResult(
  tool: string,
  output: string | undefined,
  detail: string | undefined,
): string | null {
  if (tool !== "subagent") return null;
  const structured = parseSubagentResultDetails(tool, detail);
  if (structured[0]) return structured[0].subagentId;
  const text = `${output ?? ""}\n${detail ?? ""}`;
  const match =
    text.match(/subagent: ([a-zA-Z0-9_-]+)/)
    ?? text.match(/\(id: ([a-zA-Z0-9_-]+)\)/);
  return match?.[1] ?? match?.[2] ?? null;
}

/** displayName 最大长度（码点）。显示层字段，不参与身份。 */
export const SUBAGENT_DISPLAY_NAME_MAX_CODE_POINTS = 32;

/**
 * 归一化子代理显示名：纯展示字段，允许中文。
 * 去控制/格式字符（换行、RTL 覆盖、零宽等，防排版欺骗），折叠空白，按码点截断（不拆 emoji）。
 * 空值返回 undefined，调用方回退到 role / subagentId。
 */
export function normalizeSubagentDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    // 保留 ZWJ，其余格式字符与换行一律转空格（emoji 组合序列不被拆散）
    .replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === "\u200d" ? ch : " "))
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= SUBAGENT_DISPLAY_NAME_MAX_CODE_POINTS) return cleaned;
  return codePoints
    .slice(0, SUBAGENT_DISPLAY_NAME_MAX_CODE_POINTS)
    .join("")
    .trim() || undefined;
}

/**
 * 从工具结果解析 displayName：优先 Durable 结构化结果，缺失时回退旧文本标记
 * `> subagent-name: <name>`；都没有返回 null。
 */
export function extractSubagentDisplayNameFromToolResult(
  tool: string,
  output: string | undefined,
  detail: string | undefined,
): string | null {
  if (tool !== "subagent") return null;
  const structured = parseSubagentResultDetails(tool, detail);
  const structuredName = structured[0]?.displayName;
  if (structuredName) return structuredName;
  const text = `${output ?? ""}\n${detail ?? ""}`;
  const match = text.match(/^\s*>\s*subagent-name:\s*(.+)$/m);
  return normalizeSubagentDisplayName(match?.[1]) ?? null;
}
