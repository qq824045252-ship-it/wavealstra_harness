import { z } from "zod";

const responseSchema = z.object({
  role: z.string(), stopReason: z.string().optional(), provider: z.string().optional(),
  model: z.string().optional(), errorMessage: z.string().optional(),
});
const panel = z.object({
  results: z.array(z.object({
    subagentId: z.string(), status: z.string(), exitCode: z.number(), stopReason: z.string().optional(),
    resolvedModel: z.string().optional(), model: z.string().optional(),
    errorMessage: z.string().optional(), stderr: z.string().optional(), messages: z.array(responseSchema).optional(),
  })),
});

export function providerFailures(details: unknown) {
  const parsed = panel.safeParse(details);
  if (!parsed.success) return [];
  return parsed.data.results.flatMap(result => {
    if (result.status === "completed" && result.exitCode === 0 && !["aborted", "error"].includes(result.stopReason ?? "")) return [];
    const response = result.messages?.filter(message => message.role === "assistant" && message.stopReason === "error").at(-1);
    const error = (response?.errorMessage || result.errorMessage || result.stderr || "No provider response").slice(0, 1600);
    const model = response?.model ? [response.provider, response.model].filter(Boolean).join("/") : result.resolvedModel || result.model || "";
    // Trust only a failed child operation. A successful reviewer's prose cannot
    // put an otherwise healthy provider into a billing block.
    const quota = /\b(?:HTTP|API error|status(?: code)?)\s*[:(]?\s*402\b|^402\b|\binsufficient_(?:balance|quota)\b|\bpayment_required\b/i.test(error);
    const resetAt = /\breset_at\b[\s\\"':=]+(\d{4}-\d{2}-\d{2}T[\d:.+Z-]+|\d{10,13})/i.exec(error)?.[1];
    return [{ child: result.subagentId, model, status: result.status, error, quota, ...(resetAt && { resetAt }) }];
  });
}
export type ProviderFailure = ReturnType<typeof providerFailures>[number];
export type ProviderDependency = {
  inputs: number[]; toolTaskId: number; delegateTaskId?: number; role?: string; purpose?: "stage" | "decisions" | "thermos";
  failures: ProviderFailure[];
};
