import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryRecord } from "@earendil-works/pi-durable";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalPathKey } from "../../platform/paths";
import type { Api } from "./PstackState";

type Seen = { tool: "read" | "ls"; path: string; entry: number };
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
  const calls = new Map<string, Omit<Seen, "entry">>(), observed: Seen[] = [];
  const allowed = new Map(registered.map(path => [canonicalPathKey(path),path]));
  for (const entry of entries) {
    if (entry.byTaskId === undefined) continue;
    for (const message of entry.model ?? []) {
      if (entry.kind === "pi.assistant" && message.role === "assistant") for (const part of message.content) {
        if (part.type !== "toolCall" || (part.name !== "read" && part.name !== "ls")) continue;
        const raw = part.arguments.path ?? (part.name === "ls" ? "." : undefined);
        if (typeof raw !== "string") continue;
        const full = resolve(cwd, raw), rel = relative(root, full);
        if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
          const external = allowed.get(canonicalPathKey(full));
          if (external && part.name === "read") calls.set(part.id, {tool:"read", path:external});
          continue;
        }
        calls.set(part.id, { tool: part.name, path: rel.split(sep).join("/") || "." });
      }
      if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
        const called = calls.get(message.toolCallId);
        if (called && called.tool === message.toolName && !message.isError) observed.push({ ...called, entry: entry.id });
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

export async function validateInspections(root: string, targetFiles: string[], receipts: ReviewInspection[], requireFullCoverage = true) {
  const needed = new Map<string, { path: string; tool: Seen["tool"] }>();
  for (const path of targetFiles) {
    let target = resolve(root, path), tool: Seen["tool"] = "read";
    try { await lstat(target); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // A deleted path is reviewed against its frozen before-image and a
      // real listing of the directory where it (or its subtree) disappeared.
      tool = "ls";
      while (target !== root) {
        target = dirname(target);
        try { if ((await lstat(target)).isDirectory()) break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    needed.set(tool + ":" + canonicalPathKey(target), { path: relative(root, target).split(sep).join("/") || ".", tool });
  }
  const hit = new Set<string>();
  for (const receipt of receipts) {
    let inspected = false;
    for (const row of receipt.observations) {
      const key = row.tool + ":" + canonicalPathKey(resolve(root, row.path));
      if (needed.has(key) || (!needed.size && row.tool === "read" && !taskMetadata(row.path))) { inspected = true; hit.add(key); }
    }
    if (!inspected) throw new Error("Reviewer " + receipt.child + " returned a verdict without a successful native read of a review target (ls of parent for a deletion).");
  }
  const missing = [...needed].filter(([key]) => !hit.has(key)).map(([, value]) => value.tool + " " + value.path);
  if (requireFullCoverage && missing.length) throw new Error("Review panel has no inspection receipts for: " + missing.join(", "));
}
