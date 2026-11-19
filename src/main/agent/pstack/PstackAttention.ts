import { createHash } from "node:crypto";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { z } from "zod";

export const decisionDigest = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
export const decisionAuthorsMemo = "pstack-decision-audit-authors";

// Report only recognizable model families. Two aliases or gateway routes for
// the same model are not evidence of an independent family.
export function observedModelFamily(model: string) {
  const id = model.split("/").at(-1)?.toLowerCase() ?? "";
  return /^(gpt-|o[1-9](?:[-.]|$))/.test(id) ? "gpt" : /^(claude|gemini|grok|deepseek|qwen|llama|mistral|glm|kimi|command-r)/.exec(id)?.[0];
}
export function independentAttention(authors: string[], reviewers: string[], answers: string[]) {
  const writerFamilies = authors.map(observedModelFamily);
  if (!writerFamilies.length || writerFamilies.includes(undefined)) throw new Error("Cannot establish the author's model family from native receipts.");
  if (reviewers.some(model => !observedModelFamily(model) || writerFamilies.includes(observedModelFamily(model))))
    throw new Error("Decision audit requires a reviewer from a different observed model family. Configure the judgment role.");
  const schema = z.object({ flags: z.array(z.string().trim().min(1)) });
  const flags = answers.flatMap(answer => schema.parse(JSON.parse(answer.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, ""))).flags);
  return { models: reviewers, flags };
}
export function auditTranscript(entries: EntryRecord[]) {
  return entries.flatMap(entry => (entry.model ?? []).flatMap(message => {
    const content = typeof message.content === "string" ? message.content : message.content.flatMap(part =>
      part.type === "text" ? [part.text] : part.type === "toolCall" ? [part.name + " " + JSON.stringify(part.arguments)] : []).join(" ");
    // Checkpoint outputs include the entire run state and would bury the underlying operations.
    if (message.role === "toolResult" && message.toolName === "pstack_workflow" && !message.isError && content.includes('"steps":')) return [];
    return [JSON.stringify({ entry: entry.id, role: message.role, ...(message.role === "toolResult" && { tool: message.toolName, failed: !!message.isError }),
      content: content.slice(0, 650) })];
  })).join("\n");
}
