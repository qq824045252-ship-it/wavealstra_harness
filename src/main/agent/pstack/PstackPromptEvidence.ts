import type { EntryRecord } from "@earendil-works/pi-durable";
import { PSTACK_READ_ONLY_METHODS, PSTACK_TEXT_ONLY_METHODS } from "../../../shared/pstack/upstream";
import { nativeExecutionSucceeded } from "../../../shared/native-execution-receipt";

export type ReframeSource = { term: string; url: string };
export const textOnlyPstackMethod = (playbook: string) =>
  playbook.startsWith("skill:") && PSTACK_TEXT_ONLY_METHODS.includes(playbook.slice(6));
export const readOnlyPstackMethod = (playbook: string) =>
  playbook.startsWith("skill:") && PSTACK_READ_ONLY_METHODS.includes(playbook.slice(6));
export const promptPstackMethod = (playbook: string) =>
  playbook.startsWith("skill:") && ["in-your-own-words", "sharpen", "reframe", "ketchup"].includes(playbook.slice(6));

function sourceUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Reframe sources must use HTTP or HTTPS.");
  url.hash = "";
  return url.href;
}

/** Count only successful fetches paired to this conversation's actual calls.
 * A search snippet, a failed batch member, or a URL in prose is not a read. */
export function fetchedPstackSources(entries: readonly EntryRecord[]): Set<string> {
  const calls = new Map<string, string[]>(), fetched = new Set<string>();
  for (const entry of entries) {
    if (entry.byTaskId === undefined) continue;
    for (const message of entry.model ?? []) {
      if (entry.kind === "pi.assistant" && message.role === "assistant") for (const part of message.content) {
        if (part.type !== "toolCall" || part.name !== "fetch_content") continue;
        const urls = Array.isArray(part.arguments.urls) ? part.arguments.urls : [part.arguments.url];
        calls.set(part.id, urls.filter((url): url is string => typeof url === "string"));
      }
      if (entry.kind !== "pi.tool-result" || message.role !== "toolResult" || message.toolName !== "fetch_content") continue;
      const urls = calls.get(message.toolCallId);
      calls.delete(message.toolCallId);
      if (!urls || !nativeExecutionSucceeded(message, { conversationId: entry.conversationId, toolTaskId: entry.byTaskId,
        toolName: message.toolName, callId: message.toolCallId })) continue;
      const details = message.details as { error?: unknown; results?: { url?: string; error?: unknown; errorCode?: unknown }[] } | undefined;
      if (details?.error) continue;
      const successes = details?.results ? details.results.filter(row => !row.error && !row.errorCode).map(row => row.url) : urls;
      for (const url of successes) {
        if (typeof url !== "string" || !urls.includes(url)) continue;
        try { fetched.add(sourceUrl(url)); } catch { /* Invalid tool URLs cannot support a citation. */ }
      }
    }
  }
  return fetched;
}

export function validateReframeSources(sources: readonly ReframeSource[] | undefined, entries: readonly EntryRecord[]): ReframeSource[] {
  if (!sources || sources.length < 8 || sources.length > 12)
    throw new Error("Reframe terms requires sources: eight to twelve {term,url} entries. Fetch every cited source with fetch_content first.");
  const terms = new Set<string>(), fetched = fetchedPstackSources(entries);
  return sources.map(source => {
    const term = source.term.trim(), url = sourceUrl(source.url);
    if (!term || terms.has(term.toLocaleLowerCase())) throw new Error("Each reframe source needs a distinct, nonempty term.");
    if (!fetched.has(url)) throw new Error("Reframe source has no successful fetch_content receipt: " + source.url);
    terms.add(term.toLocaleLowerCase());
    return { term, url };
  });
}

export function observedPstackStatus(entries: readonly EntryRecord[]): boolean {
  const calls = new Set<string>();
  for (const entry of entries) {
    if (entry.byTaskId === undefined) continue;
    for (const message of entry.model ?? []) {
      if (entry.kind === "pi.assistant" && message.role === "assistant") for (const part of message.content)
        if (part.type === "toolCall" && part.name === "pstack_workflow" && part.arguments.action === "status") calls.add(part.id);
      if (entry.kind === "pi.tool-result" && message.role === "toolResult" && message.toolName === "pstack_workflow" &&
        calls.delete(message.toolCallId) && nativeExecutionSucceeded(message, { conversationId: entry.conversationId,
          toolTaskId: entry.byTaskId, toolName: message.toolName, callId: message.toolCallId })) return true;
    }
  }
  return false;
}
