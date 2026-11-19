import { defineDoc, type EntryId, type EntryRecord, type Harness, type HookApi, type ToolHooks } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getSkillsDir } from "../../paths";
import { canonicalPathKey } from "../../platform/paths";
import { state, transcript, WorkflowState, type Api, type WorkflowOptions, type WorkflowRun } from "./PstackState";
import { missingFile, skillFileState, type FileState, type ScopedFile } from "./PstackWorkspace";

type Owned = { id: string; root: string; operation: number; before: FileState };
const Files = defineDoc({
  kind: "mybuddy.pstack-authored-skills", version: 1, scope: "conversation", history: "rewindable", fork: "initial",
  checkpointWhen: () => true, initial: (): { run: number; files: Owned[]; through?: EntryId } => ({ run: 0, files: [] }),
});
const tools = new Set(["skill_authoring_create", "skill_authoring_assess"]);
function object(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null; }
function target(name: string, result: unknown) {
  if (!object(result)) return;
  const created = name === "skill_authoring_create" && result.created === true;
  const skill = created && object(result.result) && object(result.result.skill) ? result.result.skill : undefined;
  const id = created ? skill?.id : name === "skill_authoring_assess" && result.decision === "improve-existing" ? result.targetSkillId : undefined;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return;
  const root = resolve(getSkillsDir()), path = join(root, id, "SKILL.md");
  if (created && (!skill?.installed || typeof skill.filePath !== "string" || canonicalPathKey(skill.filePath) !== canonicalPathKey(path))) return;
  if (!created && !existsSync(path)) return;
  return { id, created, root };
}

export function captureAuthoredSkill(options: WorkflowOptions): (...args: [...Parameters<ToolHooks["afterTool"]>, Harness["commit"]?]) => Promise<void> {
  return async (call, result, api, ctx, commit) => {
    if (!options.active() || !commit || result.isError || !tools.has(call.name)) return;
    const run = await state(api, ctx);
    if (run?.phase !== "running" || run.task !== options.taskId || api.taskId <= run.run) return;
    const item = target(call.name, result.details ?? result.structuredOutput);
    if (!item) return;
    const before = item.created ? missingFile : await skillFileState(item.root, item.id, true, ctx.abortSignal);
    await commit(async tx => {
      const active = (await tx.doc(WorkflowState, api.conversationId)).run;
      if (!options.active() || active?.run !== run.run || active.phase !== "running") return;
      const doc = await tx.doc(Files, api.conversationId);
      if (doc.run !== run.run) { doc.run = run.run; doc.files = []; delete doc.through; }
      if (!doc.files.some(f => f.id === item.id)) doc.files.push({ id: item.id, root: item.root, operation: api.taskId, before });
    }, ctx);
  };
}

export async function authoredFiles(api: Api | HookApi, ctx: Context, run: WorkflowRun, history?: readonly EntryRecord[], retain = false): Promise<ScopedFile[]> {
  const doc = await api.snapshot(Files, api.conversationId, ctx);
  const owned = new Map((doc?.run === run.run ? doc.files : []).map(f => [f.id, f]));
  // Completed create receipts can also be recovered after an interruption
  // between package installation and publication of the observer document.
  const through = doc?.run === run.run ? doc.through : undefined;
  const source = history ?? await transcript(api, ctx, through ?? run.first);
  for (const e of source) {
    if (e.kind !== "pi.tool-result" || e.byTaskId === undefined || e.byTaskId <= run.run || (through && e.id <= through)) continue;
    for (const m of e.model ?? []) {
      if (m.role !== "toolResult" || m.isError || !tools.has(m.toolName)) continue;
      const item = target(m.toolName, m.details);
      if (!item || owned.has(item.id)) continue;
      if (!item.created) throw Error("The pre-edit snapshot of assessed skill " + item.id + " is unavailable. A new assessment is required before modifying or merging.");
      owned.set(item.id, { id: item.id, root: item.root, operation: e.byTaskId, before: missingFile });
    }
  }
  const last = source.at(-1)?.id;
  if ("commit" in api && last && (!through || through < last)) await api.commit(async tx => {
    const active = (await tx.doc(WorkflowState, api.conversationId)).run;
    if (active?.run !== run.run) throw Error("Active skill workflow changed.");
    const snapshot = await tx.doc(Files, api.conversationId);
    if (snapshot.run !== run.run) { snapshot.run = run.run; snapshot.files = []; delete snapshot.through; }
    for (const file of owned.values()) if (!snapshot.files.some(f => f.id === file.id)) snapshot.files.push(file);
    if (!snapshot.through || snapshot.through < last) snapshot.through = last;
  }, ctx);
  if (!owned.size) return [];
  const root = resolve(getSkillsDir());
  return Promise.all([...owned.values()].sort((a, b) => a.id.localeCompare(b.id)).map(async item => {
    if (!item.root || canonicalPathKey(item.root) !== canonicalPathKey(root)) throw Error("The installed location of assessed skill " + item.id + " changed during this task.");
    const current = await skillFileState(root, item.id, retain, ctx.abortSignal);
    if (!current.digest || current.binary) throw Error("The authored SKILL.md is missing or is binary: " + item.id);
    return { path: join(root, item.id, "SKILL.md"), before: item.before, current };
  }));
}
