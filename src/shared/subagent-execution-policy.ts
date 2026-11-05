import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 600_000;
export const MAX_SUBAGENT_TIMEOUT_MS = 3_600_000;
const ModelId = Type.String({ pattern: "^[^\\s/]+/[^\\s]+$" });
export const SubagentExecutionPolicySchema = Type.Object({
  allowedModels: Type.Optional(Type.Array(ModelId, { uniqueItems: true })),
  roles: Type.Optional(Type.Record(Type.String({ pattern: "^(?!(?:auto|inherit-parent|__proto__|constructor|prototype)$)[a-zA-Z0-9_-]+$" }), Type.Array(ModelId, { uniqueItems: true }), { additionalProperties: false })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_SUBAGENT_TIMEOUT_MS })),
  timeoutPolicy: Type.Optional(Type.Union([Type.Literal("fixed"), Type.Literal("allow-override")])),
});
export type SubagentExecutionPolicy = Static<typeof SubagentExecutionPolicySchema>;
export const SUBAGENT_POLICY_KEYS = ["allowedModels", "roles", "timeoutMs", "timeoutPolicy"] as const;

export function parseSubagentExecutionPolicy(value: unknown): SubagentExecutionPolicy {
  if (!Check(SubagentExecutionPolicySchema, value)) {
    throw new Error("Invalid subagent execution settings: use full provider/model IDs, unique lists, role names without spaces, and a time limit of 1 to 3600 seconds.");
  }
  return {
    allowedModels: value.allowedModels,
    roles: value.roles,
    timeoutMs: value.timeoutMs,
    timeoutPolicy: value.timeoutPolicy,
  };
}

export function assertSubagentModelAllowed(policy: SubagentExecutionPolicy, modelId: string): void {
  if (policy.allowedModels !== undefined && !policy.allowedModels.includes(modelId)) {
    throw new Error(`Subagent model is blocked by Settings > Models > Subagent execution limits: ${modelId}`);
  }
}

export function filterSubagentModels<T extends { id: string }>(models: T[], policy: SubagentExecutionPolicy): T[] {
  const allowed = policy.allowedModels;
  return allowed === undefined ? models : models.filter(model => allowed.includes(model.id));
}

export function resolveSubagentTimeout(policy: SubagentExecutionPolicy, requested?: number): {
  timeoutMs: number;
  timeoutSource: "settings" | "invocation";
} {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1000 || requested > MAX_SUBAGENT_TIMEOUT_MS)) {
    throw new Error("Subagent timeout_ms must be an integer between 1000 and 3600000.");
  }
  if (policy.timeoutPolicy === "allow-override" && requested !== undefined) {
    return { timeoutMs: requested, timeoutSource: "invocation" };
  }
  return { timeoutMs: policy.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS, timeoutSource: "settings" };
}
