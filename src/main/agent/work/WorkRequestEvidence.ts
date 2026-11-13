import { z } from "zod";

const requestSchema = z.object({ userRequest: z.object({ messages: z.array(z.object({
  text: z.string(), role: z.enum(["user", "assistant"]).optional(), peerOrigin: z.unknown().optional(),
  revoked: z.boolean().optional(),
})) }).optional() });

/** Only host-bound human requirements authorize continuation, waiting or closure.
 * Dialogue, quoted assistant plans and peer messages remain reference material. */
export function workRequestTexts(input: unknown, fallback?: string): string[] {
  const parsed = requestSchema.safeParse(input ?? {});
  if (!parsed.success) return [];
  if (!parsed.data.userRequest) return fallback ? [fallback] : [];
  return parsed.data.userRequest.messages.filter(message => message.role !== "assistant"
    && message.peerOrigin === undefined && !message.revoked).map(message => message.text);
}

export function workRequestIncludes(input: unknown, excerpt: string, fallback?: string): boolean {
  return Boolean(excerpt.trim()) && workRequestTexts(input, fallback).some(text => text.includes(excerpt));
}
