import { createHash } from "node:crypto";
import type { RuntimeMaterialUseDto } from "../../shared/agent-ipc";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const string = (value: unknown, max = 2048): string => typeof value === "string" ? value.slice(0, max) : "";
const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Only known read tools qualify. No prose parsing and no post-hoc filesystem reread. */
export function collectRuntimeMaterialEvidence(event: {
  toolCallId: string; toolName: string; args: unknown; result: unknown; isError: boolean;
}, at = Date.now()): RuntimeMaterialUseDto[] {
  if (event.isError || !["read", "project_knowledge_read", "project_knowledge_search", "fetch_content"].includes(event.toolName)) return [];
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
  if (event.toolName === "fetch_content") {
    const urls = Array.isArray(details.urls) ? details.urls : [];
    const target = typeof args.url === "string" ? args.url : Array.isArray(args.urls) && args.urls.length === 1 ? args.urls[0] : undefined;
    if (typeof target !== "string" || urls.length !== 1 || urls[0] !== target) return [];
    try { const url = new URL(target); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return []; } catch { return []; }
    const complete = details.materialKind === "web-content" && details.successful === 1 && details.urlCount === 1
      && typeof details.status === "number" && details.status >= 200 && details.status < 300 && details.status !== 206
      && details.truncated === false && ["raw", "readable"].includes(String(details.mode))
      && !args.prompt && images === 0 && returnedChars > 0 && details.totalChars === returnedChars;
    return [{ ...base, target, title: string(details.title, 256) || target, kind: "web-content", partial: !complete }];
  }
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
