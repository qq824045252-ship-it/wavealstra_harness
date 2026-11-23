import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryRecord } from "@earendil-works/pi-durable";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalPathKey } from "../../platform/paths";
import { matchingNativeExecutionReceipt, nativeExecutionSucceeded, nativeFileVersion, type NativeExecutionReceipt } from "../../../shared/native-execution-receipt";
import type { Api } from "./PstackState";

type Seen = { tool: "read" | "read_missing" | "ls"; path: string; entry: number; executionReceipt?: NativeExecutionReceipt };
export type ReviewInspection = { child: number; observations: Seen[] };
function taskMetadata(name: string) { return /(?:^|\/)(?:\.mybuddy-task\.json|\.git(?:\/|$))/.test(name); }

export async function reviewTargets(root: string, changed: string[], requests: string[], history: readonly EntryRecord[]) {
  const targets = new Set(changed);
  // A clean tree can still be the explicit review target. Bind file names in
  // user text to actual files; an incidental read of task metadata cannot
  // stand in for the source requested by the user.
  const candidates = new Set<string>();
  for (const text of requests) {
    const local = text.replace(/https?:\/\/[^\s)\]]+/g, "");
    for (const match of local.matchAll(/["'\x60]([^"'\x60\n]{1,300}\.[\p{L}\p{N}_-]{1,14})(?::\d+)?["'\x60]|(?:^|[\s,(（【])((?:[a-z]:[\\/]|\.{0,2}\/)?[\p{L}\p{N}_@./\\-]+\.[\p{L}\p{N}_-]{1,14})(?=$|[^\p{L}\p{N}_/\\-])/giu))
      candidates.add(match[1] ?? match[2]);
  }
  for (const name of [...candidates].slice(0, 128)) {
    const full = resolve(root, name), rel = relative(root, full);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) continue;
    try {
      if ((await lstat(full)).isFile() && canonicalPathKey(await realpath(full)) === canonicalPathKey(full)) targets.add(rel.split(sep).join("/"));
    } catch (e) { if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; }
  }
  if (!targets.size) for (const row of observedReviewFiles(history, root, root)) {
    if (row.tool === "read" && !taskMetadata(row.path)) targets.add(row.path);
  }
  return [...targets].sort();
}

/** Only a committed, successful native result paired to that assistant's
 * own exact call is an observation. A path quoted in child prose is not. */
export function observedReviewFiles(entries: readonly EntryRecord[], cwd: string, root: string, registered: readonly string[] = []): Seen[] {
  const calls = new Map<string, { tool: "read" | "ls"; raw: string }>(), observed: Seen[] = [];
  const allowed = new Map(registered.map(path => [canonicalPathKey(path),path]));
  for (const entry of entries) {
    if (entry.byTaskId === undefined) continue;
    for (const message of entry.model ?? []) {
      if (entry.kind === "pi.assistant" && message.role === "assistant") for (const part of message.content) {
        if (part.type !== "toolCall" || (part.name !== "read" && part.name !== "ls")) continue;
        const raw = part.arguments.path ?? (part.name === "ls" ? "." : undefined);
        if (typeof raw === "string") calls.set(part.id, { tool: part.name, raw });
      }
      if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
        const called = calls.get(message.toolCallId);
        calls.delete(message.toolCallId);
        if (!called || called.tool !== message.toolName) continue;
        const identity = { conversationId: entry.conversationId, toolTaskId: entry.byTaskId, toolName: called.tool, callId: message.toolCallId };
        const executionReceipt = matchingNativeExecutionReceipt(message, identity);
        const missing = called.tool === "read" && executionReceipt?.fileReadAttempt?.openFailure === "not_found";
        if (!missing && !nativeExecutionSucceeded(message, identity)) continue;
        const target = missing ? executionReceipt?.fileReadAttempt?.target : executionReceipt?.fileRead?.target;
        if (executionReceipt && called.tool === "read" && !target) continue;
        const full = target ?? resolve(cwd, called.raw), rel = relative(root, full);
        const path = rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)
          ? called.tool === "read" ? allowed.get(canonicalPathKey(full)) : undefined
          : rel.split(sep).join("/") || ".";
        if (path) observed.push({ tool: missing ? "read_missing" : called.tool, path, entry: entry.id,
          ...(executionReceipt && { executionReceipt }) });
      }
    }
  }
  return observed;
}

export async function childInspection(api: Api, id: number, cwd: string, root: string, ctx: Context, registered: readonly string[] = []): Promise<ReviewInspection> {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await api.commit(tx => tx.scanEntries({ conversationId: id as ConversationId, order: "ascending" }, 100, cursor), ctx);
    entries.push(...page.items); cursor = page.next;
  } while (cursor);
  return { child: id, observations: observedReviewFiles(entries, cwd, root, registered) };
}

export async function validateInspections(root: string, targetFiles: string[], receipts: ReviewInspection[], requireFullCoverage = true,
  measuredFiles?: ReadonlyMap<string, string>) {
  const needed = new Map<string, string>();
  const lookup = new Map<string, string[]>();
  for (const path of targetFiles) {
    const target = resolve(root, path);
    const key = canonicalPathKey(target);
    try {
      await lstat(target);
      needed.set(key, "read " + path);
      lookup.set("read:" + key, [key]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      needed.set(key, "confirm removal of " + path);
      lookup.set("read_missing:" + key, [key]);
      let parent = dirname(target);
      while (parent !== root) {
        try { if ((await lstat(parent)).isDirectory()) break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
      const listing = "ls:" + canonicalPathKey(parent);
      lookup.set(listing, [...(lookup.get(listing) ?? []), key]);
    }
  }
  const hit = new Set<string>();
  for (const receipt of receipts) {
    let inspected = false;
    for (const row of receipt.observations) {
      const expected = measuredFiles?.get(row.path), observed = nativeFileVersion(row.executionReceipt);
      if (row.tool === "read" && expected && observed && expected !== observed) continue;
      const key = row.tool + ":" + canonicalPathKey(resolve(root, row.path));
      const targets = lookup.get(key);
      if (targets?.length || (!needed.size && row.tool === "read" && !taskMetadata(row.path))) {
        inspected = true;
        for (const target of targets ?? []) hit.add(target);
      }
    }
    if (!inspected) throw new Error("Reviewer " + receipt.child + " returned a verdict without a successful native read or a native absence receipt for a review target.");
  }
  const missing = [...needed].filter(([key]) => !hit.has(key)).map(([, value]) => value);
  if (requireFullCoverage && missing.length) throw new Error("Review panel has no inspection receipts for: " + missing.join(", "));
}
