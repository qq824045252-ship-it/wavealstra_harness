import { z } from "zod";
import type { ReportedTokenUsage } from "../../shared/task-diagnostics";

const count = z.number().finite().nonnegative().nullable().catch(null);
const usage = z.object({
  input_tokens: count.optional(), output_tokens: count.optional(),
  cache_read_input_tokens: count.optional(), cache_creation_input_tokens: count.optional(),
  input_tokens_details: z.object({ cached_tokens: count.optional() }).optional(),
  prompt_tokens: count.optional(), completion_tokens: count.optional(),
  prompt_tokens_details: z.object({ cached_tokens: count.optional() }).optional(),
});
const eventSchema = z.object({
  type: z.string().optional(), usage: usage.optional(),
  response: z.object({ usage: usage.optional() }).optional(),
  message: z.object({ usage: usage.optional() }).optional(),
  usageMetadata: z.object({ promptTokenCount: count.optional(), candidatesTokenCount: count.optional(),
    thoughtsTokenCount: count.optional(), cachedContentTokenCount: count.optional() }).optional(),
});
export const unknownTokenUsage = (): ReportedTokenUsage => ({ input: null, output: null, cacheRead: null, cacheWrite: null });

const providerCostSchema = z.object({ usage: z.object({ cost: z.union([z.number().finite().nonnegative(), z.object({ total: z.number().finite().nonnegative() })]) }) });
export function reportedCostTotal(value: unknown): number | undefined {
  const parsed = providerCostSchema.safeParse(value);
  if (!parsed.success) return;
  const cost = parsed.data.usage.cost;
  return typeof cost === "number" ? cost : cost.total;
}

/** Parse only provider-reported counters. Absence and explicit zero remain distinct. */
export function reportedTokenUsage(value: unknown): { source: string; values: Partial<ReportedTokenUsage> } | undefined {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) return;
  const event = parsed.data;
  const raw = event.response?.usage ?? event.message?.usage ?? event.usage;
  if (raw) {
    if (event.type?.startsWith("message_") || raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined) {
      return { source: "anthropic", values: { ...(raw.input_tokens !== undefined ? { input: raw.input_tokens } : {}),
        ...(raw.output_tokens !== undefined ? { output: raw.output_tokens } : {}),
        ...(raw.cache_read_input_tokens !== undefined ? { cacheRead: raw.cache_read_input_tokens } : {}),
        ...(raw.cache_creation_input_tokens !== undefined ? { cacheWrite: raw.cache_creation_input_tokens } : {}) } };
    }
    const input = raw.input_tokens ?? raw.prompt_tokens ?? null;
    const cacheRead = raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? null;
    return { source: event.response ? "responses" : "chat-completions", values: {
      // These APIs include cached input in prompt/input_tokens. Without a cache counter the new input is unknown.
      input: input !== null && cacheRead !== null ? Math.max(0, input - cacheRead) : null,
      output: raw.output_tokens ?? raw.completion_tokens ?? null, cacheRead, cacheWrite: null,
    } };
  }
  if (event.usageMetadata) {
    const data = event.usageMetadata;
    const prompt = data.promptTokenCount ?? null;
    const cached = data.cachedContentTokenCount ?? null;
    return { source: "google", values: { input: prompt !== null && cached !== null ? Math.max(0, prompt - cached) : null,
      output: data.candidatesTokenCount != null && data.thoughtsTokenCount != null ? data.candidatesTokenCount + data.thoughtsTokenCount : null,
      cacheRead: cached, cacheWrite: null } };
  }
}
