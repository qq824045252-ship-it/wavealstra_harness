import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { readPlanFile } from "./PstackWorkspace";
import { z } from "zod";

const exec = promisify(execFile);
type SubmissionMessage = { role: string; toolName?: string; toolCallId?: string; isError?: boolean;
  content: { type: string; name?: string; id?: string; arguments?: Record<string,unknown> }[] };
type SubmittedWorkspace = { cwd: string; kind?: string; baseCommit?: string };

export function arenaSurvivors(details: unknown, count: number) {
  const all = z.object({ results: z.array(z.object({subagentId:z.string().min(1),status:z.string(),
    exitCode:z.number(),rejected:z.boolean().optional(),writeConflicts:z.array(z.string()).optional(),
    errorMessage:z.string().optional()}).passthrough()).length(count) }).parse(details).results;
  if (new Set(all.map(item => item.subagentId)).size !== count) throw Error("Arena returned duplicate seats.");
  const pass = (r: typeof all[number]) => r.status === "completed" && r.exitCode === 0 && !r.rejected && !r.writeConflicts?.length;
  const results = all.filter(pass), dropouts = all.filter(r => !pass(r)).map(r => ({ child:r.subagentId, status:r.status,
    reason:r.errorMessage || r.writeConflicts?.join(", ") || "Exit " + r.exitCode }));
  if (!results.length) throw Error("No Arena author returned a usable artifact: " + JSON.stringify(dropouts));
  return {results,dropouts};
}

/** In a private worktree include edits made via shells and commits as well.
 * In a shared workspace only a successful write by this author is attributable. */
export async function arenaSubmission(workspace: SubmittedWorkspace, messages: SubmissionMessage[], signal?: AbortSignal) {
  const paths = new Set<string>();
  if (workspace.kind === "worktree") {
    if (!workspace.baseCommit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(workspace.baseCommit)) throw Error("Arena worktree has no observed base commit.");
    const git = async (args: string[]) => (await exec("git", ["--no-optional-locks","-C",workspace.cwd,...args], { windowsHide:true,timeout:12_000,maxBuffer:1024*1024,signal })).stdout.split("\0").filter(Boolean);
    const results = await Promise.all([git(["diff","--relative","--no-renames","--no-ext-diff","--name-only","-z",workspace.baseCommit,"--","."]),
      git(["ls-files","--others","--exclude-standard","-z","--","."])]);
    results.flat().forEach(name => paths.add(name));
  } else {
    const calls = new Map<string,{tool:string; path:string}>();
    for (const message of messages) {
      if (message.role === "assistant") for (const part of message.content) {
        if (part.type === "toolCall" && part.id && (part.name === "write" || part.name === "edit") && typeof part.arguments?.path === "string")
          calls.set(part.id,{tool:part.name,path:part.arguments.path});
      }
      if (message.role !== "toolResult" || message.isError || !message.toolCallId) continue;
      const call = calls.get(message.toolCallId);
      if (call && message.toolName === call.tool) paths.add(call.path);
    }
  }
  const files: Record<string, string | null> = Object.create(null);
  let bytes = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const target = resolve(workspace.cwd,path), rel = relative(workspace.cwd,target);
    if (!rel || rel === ".." || rel.startsWith(".."+sep) || isAbsolute(rel)) throw Error("Arena output exceeds its assigned workspace.");
    const name = rel.split(sep).join("/");
    try { await lstat(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files[name] = null; continue;
    }
    const file = await readPlanFile(workspace.cwd, name);
    if (file.text.includes("\0") || (bytes += Buffer.byteLength(file.text)) > 128 * 1024) throw Error("Arena currently requires text artifacts of at most 128 KiB per author.");
    files[name] = file.text;
  }
  return files;
}
