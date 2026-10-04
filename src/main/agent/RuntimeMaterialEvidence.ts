import { createHash } from "node:crypto";
import type { RuntimeMaterialUseDto } from "../../shared/agent-ipc";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const string = (value: unknown, max = 2048): string => typeof value === "string" ? value.slice(0, max) : "";
const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Only known read tools qualify. No prose parsing and no post-hoc filesystem reread. */
export function collectRuntimeMaterialEvidence(event: {
  toolCallId: string; toolName: string; args: unknown; result: unknown; isError: boolean;
}, at = Date.now()): RuntimeMaterialUseDto[] {
  if (event.isError || !["read", "project_knowledge_read", "project_knowledge_search"].includes(event.toolName)) return [];
  const result = object(event.result);
  const details = object(result.details);
  if (result.isError === true || details.error) return [];
  if (!Array.isArray(result.content) || !result.content.length) return [];
  const digest = createHash("sha256");
  let returnedChars = 0;
  let images = 0;
  let hasOutput = false;
  for (const value of result.content) {
    const block = object(value);
    if (block.type === "text" && typeof block.text === "string") {
      hasOutput = true;
      digest.update("text\0").update(block.text).update("\0"); returnedChars += block.text.length;
    } else if (block.type === "image" && typeof block.data === "string") {
      hasOutput = true;
      digest.update("image\0").update(string(block.mimeType)).update("\0").update(block.data).update("\0"); images++;
    }
  }
  if (!hasOutput) return [];
  const base = { toolCallId: event.toolCallId, toolName: event.toolName, at,
    outputHash: digest.digest("hex"), returnedChars, images };
  const args = object(event.args);
  if (event.toolName === "read") {
    const target = string(args.path);
    return target ? [{ ...base, target, title: target, kind: "file-content",
      partial: !!details.truncation || args.offset !== undefined || args.limit !== undefined,
      offset: positive(args.offset), limit: positive(args.limit) }] : [];
  }
  if (event.toolName === "project_knowledge_search") {
    if (!Array.isArray(details.hits)) return [];
    return details.hits.slice(0, 20).flatMap((value): RuntimeMaterialUseDto[] => {
      const hit = object(value); const target = string(hit.itemId);
      if (!target) return [];
      const snippet = typeof hit.snippet === "string" ? hit.snippet : "";
      return [{ ...base, target, title: string(hit.title, 256) || target,
        kind: snippet ? "search-snippet" : "metadata", returnedChars: snippet.length, images: 0, partial: true }];
    });
  }
  const item = object(details.item); const target = string(item.id);
  if (!target || target !== string(args.id)) return [];
  // A typed marker from the host knowledge adapter distinguishes binary metadata / URLs.
  if (details.materialKind !== "content" && details.materialKind !== "metadata") return [];
  return [{ ...base, target, title: string(item.title, 256) || target,
    kind: details.materialKind === "content" ? "knowledge-content" : "metadata",
    partial: details.materialKind === "metadata" || details.truncated === true }];
}
