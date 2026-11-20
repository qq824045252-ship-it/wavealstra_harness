import type { Message } from "@earendil-works/pi-ai";
import { LiveDoc, type Storage, type HookApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { AnswerRoutingService } from "../AnswerRoutingService";

export interface TurnAnswerRouting {
  enabled(): boolean;
  prepare(inputId: string, query: string): ReturnType<AnswerRoutingService["prepare"]>;
}

/** Bind only the current native input. Context hooks may already have added synthetic user messages. */
export async function projectAnswerRule(routing: TurnAnswerRouting, storage: Storage, api: HookApi,
  context: Context, messages: readonly Message[], findInstruction?: (instruction: string, sourceId: string | null) => { id: string; revision: number } | undefined) {
  if (!routing.enabled()) return;
  const run = (await api.snapshot(LiveDoc, api.conversationId, context))?.run;
  if (run?.inputs.length !== 1) return;
  const receipt = await storage.submission(run.inputs[0], context);
  if (receipt?.type !== "input" || !receipt.entry || !receipt.requestId || receipt.conversationId !== api.conversationId) return;
  const entry = await api.entry(receipt.entry, context);
  const data = entry?.data;
  const meta = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
  if (entry?.kind !== "mybuddy.user" || !meta || typeof meta !== "object" || Array.isArray(meta) || meta.goalContinuation
    || typeof meta.displayText !== "string" || (typeof meta.text === "string" && meta.text.trimStart().startsWith("/"))) return;
  const original = entry.model?.find(message => message.role === "user");
  if (!original) return;
  // A memory capsule deliberately shares its source input's timestamp. Match the
  // canonical body as well, preserving the capsule and multimodal input order.
  let serialized: string | undefined;
  const candidates = messages.filter(message => message.role === "user" && message.timestamp === original.timestamp
    && (message.content === original.content || (typeof message.content === typeof original.content
      && JSON.stringify(message.content) === (serialized ??= JSON.stringify(original.content)))));
  if (candidates.length !== 1) return;
  const anchor = candidates[0];
  if (anchor.role !== "user") return;
  const applied = await routing.prepare(receipt.requestId, meta.displayText);
  if (!applied) return;
  const content = typeof anchor.content === "string" ? [{ type: "text" as const, text: anchor.content }] : anchor.content;
  const projected = [...messages];
  const { sourcePrefixLength, instruction: fullText, sourceMemoryId } = applied.rule;
  const memoryText = sourcePrefixLength ? fullText.slice(0, sourcePrefixLength) : fullText;
  const memory = findInstruction?.(memoryText, sourceMemoryId);
  const text = memory ? applied.render(`本轮规则采用记忆 [L1 ${memory.id}@${memory.revision}] 中的做法。${fullText.slice(memoryText.length)}`) : applied.text;
  projected[messages.indexOf(anchor)] = { ...anchor, content: [...content, { type: "text", text: "\n\n" + text }] };
  return { messages: projected, validate: applied.validate, record: applied.record };
}
