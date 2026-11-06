import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";

export type PromptFailureCause = "provider-authentication" | "provider-rate-limit" | "provider-network" | "provider-timeout" | "provider-model-unavailable" | "provider-server-error";

export interface PromptFailureClassification {
  causeCode: PromptFailureCause;
  recovery: "recoverable" | "requires-user-action";
  message: string;
  nextAction: string;
}

function errorFacts(error: unknown): { message: string; code: string; status?: number; name: string } {
  const object = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const cause = object.cause && typeof object.cause === "object" ? object.cause as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(object.message ?? error ?? "");
  const code = String(object.code ?? cause.code ?? "");
  const rawStatus = object.status ?? object.statusCode ?? cause.status ?? cause.statusCode;
  const status = typeof rawStatus === "number" && Number.isFinite(rawStatus) ? rawStatus : typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : undefined;
  const name = error instanceof Error ? error.name : String(object.name ?? "");
  return { message, code, status, name };
}

/** Conservative provider failure classification. Unknown/model-content errors intentionally return null. */
export function classifyPromptFailure(error: unknown): PromptFailureClassification | null {
  const facts = errorFacts(error);
  const text = `${facts.name} ${facts.code} ${facts.status ?? ""} ${facts.message}`.toLowerCase();
  if (/aborterror|aborted|cancelled|canceled|user cancel|用户.*(取消|停止)/i.test(text)) return null;
  if (facts.status === 401 || /unauthori[sz]ed|invalid api[-_ ]?key|authentication failed|incorrect api[-_ ]?key|api key.*invalid/i.test(text)) {
    return { causeCode: "provider-authentication", recovery: "requires-user-action", message: facts.message,
      nextAction: "Check or renew the model provider credential, then retry after authentication succeeds." };
  }
  if (facts.status === 429 || /rate.?limit|too many requests|usage[_ -]?limit|quota.*(exceeded|reached)|insufficient[_ -]?quota|tier_limit_exceeded|membership concurrency limit exceeded/i.test(text)) {
    return { causeCode: "provider-rate-limit", recovery: "recoverable", message: facts.message,
      nextAction: "Wait for the provider limit to recover or switch to an available model. Do not blindly replay if tools may already have run." };
  }
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"].includes(facts.code.toUpperCase())
    || /fetch failed|socket hang up|network.*(error|failed)|connection (reset|refused)|dns.*failed/i.test(text)) {
    return { causeCode: "provider-network", recovery: "recoverable", message: facts.message,
      nextAction: "Restore network/provider connectivity and inspect any tool side effects before retrying the turn." };
  }
  if (/time.?out|timed out|deadline exceeded/i.test(text)) {
    return { causeCode: "provider-timeout", recovery: "recoverable", message: facts.message,
      nextAction: "Check provider connectivity and inspect any tool side effects before retrying; the turn is not auto-replayed." };
  }
  if ((facts.status === 404 && /model/i.test(text)) || /model .*(not found|does not exist|unavailable|not available)|unknown model/i.test(text)) {
    return { causeCode: "provider-model-unavailable", recovery: "requires-user-action", message: facts.message,
      nextAction: "Choose an available model or refresh the provider model list, then retry." };
  }
  if (facts.status !== undefined && facts.status >= 500 && facts.status <= 599) {
    return { causeCode: "provider-server-error", recovery: "recoverable", message: facts.message,
      nextAction: "Retry after the provider service recovers; inspect any tool side effects before replaying the turn." };
  }
  return null;
}

export function promptFailureTarget(modelKey: string | undefined): string {
  return `model:${modelKey?.trim() || "unknown"}`;
}

const PROMPT_FAILURE_CODES: PromptFailureCause[] = ["provider-authentication", "provider-rate-limit", "provider-network", "provider-timeout", "provider-model-unavailable", "provider-server-error"];

export function recordPromptFailureRecovery(input: {
  failures: ExecutionFailureRepository;
  taskId: string;
  executionId?: string;
  assistantMessageId?: string;
  modelKey?: string;
  error: unknown;
}): PromptFailureClassification | null {
  const classified = classifyPromptFailure(input.error);
  if (!classified) return null;
  input.failures.recordIfAbsent({ taskId: input.taskId, executionId: input.executionId, assistantMessageId: input.assistantMessageId,
    causeCode: classified.causeCode, phase: "execute", recovery: classified.recovery, sideEffects: "unknown",
    target: promptFailureTarget(input.modelKey), message: classified.message.slice(0, 8000), nextAction: classified.nextAction });
  return classified;
}

export function resolvePromptFailureRecovery(failures: ExecutionFailureRepository, taskId: string, modelKey?: string): number {
  return failures.resolveMatching(taskId, { target: promptFailureTarget(modelKey), causeCodes: PROMPT_FAILURE_CODES });
}