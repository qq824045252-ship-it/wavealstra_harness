import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Context } from "@earendil-works/chord/context";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { workspaceDocumentPath } from "../../../shared/pstack/paths";
import { nativeFileVersion } from "../../../shared/native-execution-receipt";
import { guardedWorkspaceTarget } from "./PstackDecisionFile";
import { playbookFor, transcript, type Api, type WorkflowRun } from "./PstackState";
import type { PstackCheckReceipt } from "./PstackVerificationEvidence";
import { observedReviewFiles } from "./PstackReviewEvidence";

export { createPstackStatechartTool } from "./PstackStatechartTool";
export { createPstackVideoInspectTool } from "./PstackVideoInspection";

export const advancedSkillIds = ["ketchup-video", "create-formal-verification-skill", "maintain-formal-verification-skill", "statechart"] as const;
export type AdvancedSkillId = typeof advancedSkillIds[number];
export function currentAdvancedMethod(run: WorkflowRun): string | undefined {
  const stage = playbookFor(run).stages[run.stage];
  const nested = stage?.id.split("::")[1];
  return nested ?? (run.playbook.startsWith("skill:") ? run.playbook.slice(6) : undefined);
}
export type AdvancedFile = { path: string; digest: string; role: "artifact" | "input" };
export const statechartReceiptMemo = "pstack-statechart-receipt";
export const videoReceiptMemo = "pstack-video-inspection-receipt";
const exec = promisify(execFile);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const nonempty = z.string().trim().min(1).max(4000);
const strings = z.array(nonempty).min(1).max(100);
const fileSchema = z.object({ path: nonempty, digest: sha, role: z.enum(["artifact", "input"]) });

export const statechartReceiptSchema = z.object({
  version: z.literal(1), kind: z.literal("statechart-execution"), workflowRun: z.number().int(), taskId: z.number().int(),
  shellTaskId: z.number().int(), executionId: z.string().min(1), command: z.string().min(1), exitCode: z.union([z.literal(0), z.literal(1)]),
  spec: nonempty, config: nonempty, view: nonempty.optional(), out: nonempty, hasChart: z.boolean(), files: z.array(fileSchema).min(4),
});
export type StatechartReceipt = z.infer<typeof statechartReceiptSchema>;
export const videoReceiptSchema = z.object({
  version: z.literal(1), kind: z.literal("video-inspection"), workflowRun: z.number().int(), taskId: z.number().int(),
  video: nonempty, slidePlanDigest: sha, duration: z.number().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
  files: z.array(fileSchema).min(3),
  frames: z.array(z.object({ path: nonempty, digest: sha, slide: z.number().int().nonnegative(), seconds: z.number().nonnegative(), matchedSeconds: z.number().positive() })).min(1).max(10),
});
export type VideoInspectionReceipt = z.infer<typeof videoReceiptSchema>;
export const videoManifestSchema = z.object({
  version: z.literal(1), kind: z.literal("ketchup-video"), video: nonempty,
  slides: z.array(z.object({ image: nonempty, subtitle: nonempty, onScreenText: z.string().max(4000), startSeconds: z.number().nonnegative(), endSeconds: z.number().positive() })).min(1).max(10),
  inspectionTaskId: z.number().int().optional(),
  visualReview: z.array(z.object({ frame: nonempty, readTaskId: z.number().int(), note: nonempty })).max(10).optional(),
});
export type VideoManifest = z.infer<typeof videoManifestSchema>;
const statechartManifestSchema = z.object({
  version: z.literal(1), kind: z.literal("statechart"), executionTaskId: z.number().int(), scope: nonempty, assumptions: strings, interpretation: nonempty,
});
const formalManifestSchema = z.object({
  version: z.literal(1), kind: z.literal("formal-verification"), skillPath: nonempty, syncCommit: commit,
  tool: nonempty, toolVersion: nonempty, command: nonempty, properties: strings, bounds: strings, assumptions: strings,
  sources: z.array(z.object({ path: nonempty, digest: sha, symbols: strings })).min(1).max(100),
  verificationFiles: z.array(nonempty).min(1).max(100), cleanCheckTaskId: z.number().int(),
  mutation: z.object({ checkTaskId: z.number().int(), sourcePath: nonempty, description: nonempty, failureEvidence: nonempty }),
  previousSyncCommit: commit.optional(), changeSummary: nonempty.optional(), status: z.enum(["in sync", "updated"]).optional(), baselineCheckTaskId: z.number().int().optional(),
});
export type FormalManifest = z.infer<typeof formalManifestSchema>;
export type CheckSnapshot = { fingerprint: string; coverageComplete: boolean; fileDigests: Record<string, string>; checkoutSha?: string };
export type CheckSnapshots = Record<number, CheckSnapshot>;
export type AdvancedArtifactReceipt = {
  version: 1; kind: AdvancedSkillId; artifact: string; workflowRun: number; files: AdvancedFile[];
  statechart?: StatechartReceipt;
  video?: VideoInspectionReceipt;
  visualReview?: NonNullable<VideoManifest["visualReview"]>;
  formal?: { cleanCheckTaskId: number; mutationCheckTaskId: number; command: string; syncCommit: string; sourcePaths: string[]; status?: "in sync" | "updated" };
};

/** Read only a regular, unlinked file under the task root, checking the open
 * descriptor and the named file again so a concurrent replacement is rejected. */
export async function inspectAdvancedFile(cwd: string, name: string, role: AdvancedFile["role"], options: { signal?: AbortSignal; text?: boolean; maxBytes?: number } = {}) {
  const path = workspaceDocumentPath(name, "pstack 产物"), target = await guardedWorkspaceTarget(cwd, path);
  if (!target.info) throw Error("Missing pstack file: " + path);
  const handle = await open(target.path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat(), max = options.maxBytes ?? (options.text ? 2 * 1024 * 1024 : 256 * 1024 * 1024);
    if (!before.isFile() || before.nlink !== 1 || before.ino !== target.info.ino || before.dev !== target.info.dev || before.size > max)
      throw Error("Invalid or oversized pstack file: " + path);
    const hash = createHash("sha256"), chunks: Buffer[] = [], buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (size < before.size) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - size), size);
      if (!bytesRead) throw Error("Pstack file changed during inspection: " + path);
      const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); if (options.text) chunks.push(Buffer.from(bytes));
      size += bytesRead;
    }
    const after = (await guardedWorkspaceTarget(cwd, path)).info;
    if (!after || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw Error("Pstack file changed during inspection: " + path);
    return { path, digest: hash.digest("hex"), role, size, absolutePath: target.path, ...(options.text && { text: Buffer.concat(chunks).toString("utf8") }) };
  } finally { await handle.close(); }
}

const fileOnly = ({ path, digest, role }: AdvancedFile): AdvancedFile => ({ path, digest, role });
export async function checkAdvancedArtifact(receipt: Pick<AdvancedArtifactReceipt, "files">, options: { cwd: string; signal?: AbortSignal }) {
  for (const file of receipt.files) {
    const actual = await inspectAdvancedFile(options.cwd, file.path, file.role, { signal: options.signal });
    if (actual.digest !== file.digest) throw Error("Verified pstack file changed: " + file.path + ". Run the affected verification again.");
  }
}
export function videoPlanDigest(manifest: Pick<VideoManifest, "video" | "slides">) {
  return createHash("sha256").update(JSON.stringify({ video: manifest.video, slides: manifest.slides })).digest("hex");
}

async function nativeReceipt<T extends { workflowRun: number; taskId: number }>(api: Api, ctx: Context, run: Pick<WorkflowRun, "run" | "task">, taskId: number, key: string, schema: z.ZodType<T>): Promise<T> {
  const task = await api.getTask(taskId as Parameters<Api["getTask"]>[0], ctx), value = schema.parse(task?.memos?.[key]);
  if (value.taskId !== taskId || value.workflowRun !== run.run) throw Error("The artifact receipt belongs to a different workflow.");
  return value;
}
export const readStatechartReceipt = (api: Api, ctx: Context, run: Pick<WorkflowRun, "run" | "task">, taskId: number) =>
  nativeReceipt(api, ctx, run, taskId, statechartReceiptMemo, statechartReceiptSchema);
export const readVideoInspectionReceipt = (api: Api, ctx: Context, run: Pick<WorkflowRun, "run" | "task">, taskId: number) =>
  nativeReceipt(api, ctx, run, taskId, videoReceiptMemo, videoReceiptSchema);

/** The snapshot was written by verify before the native command. A manifest's
 * claim about which source was mutated cannot substitute for this evidence. */
export async function readFormalCheckSnapshots(api: Api, ctx: Context, run: Pick<WorkflowRun, "run" | "checkReceipts">): Promise<CheckSnapshots> {
  const values: CheckSnapshots = {};
  const schema = z.object({ workspace: z.object({ fingerprint: z.string(), coverageComplete: z.boolean(), fileDigests: z.record(z.string(), z.string()), checkoutSha: z.string().optional() }) });
  for (const receipt of run.checkReceipts ?? []) {
    if (receipt.checkIdentity.workflowRun !== run.run) continue;
    const task = await api.getTask(receipt.checkIdentity.operationTaskId as Parameters<Api["getTask"]>[0], ctx);
    const parsed = schema.safeParse(task?.memos?.["pstack-verification-input"]);
    if (parsed.success && parsed.data.workspace.fingerprint === receipt.checkIdentity.beforeFingerprint)
      values[receipt.toolTaskId] = parsed.data.workspace;
  }
  return values;
}

type InspectOptions = {
  cwd: string; skillId: string; artifact: string; workflowRun: number; checkReceipts?: readonly PstackCheckReceipt[];
  statechartReceipt?: StatechartReceipt; videoReceipt?: VideoInspectionReceipt; checkSnapshots?: CheckSnapshots; signal?: AbortSignal;
};
const dedupe = (files: AdvancedFile[]) => {
  const all = new Map<string, AdvancedFile>();
  for (const file of files) {
    const old = all.get(file.path);
    if (old && (old.digest !== file.digest || old.role !== file.role)) throw Error("Conflicting artifact roles or versions: " + file.path);
    all.set(file.path, fileOnly(file));
  }
  return [...all.values()];
};

function verificationReceipt(options: InspectOptions, taskId: number) {
  const found = options.checkReceipts?.find(r => r.toolTaskId === taskId && r.checkIdentity.toolTaskId === taskId && r.checkIdentity.workflowRun === options.workflowRun);
  if (!found || !found.unchanged || found.emptySuite || !found.checkIdentity.executionId)
    throw Error("Formal verification needs an unchanged workspace and a real native verify receipt: " + taskId);
  const snapshot = options.checkSnapshots?.[taskId];
  if (!snapshot?.coverageComplete || snapshot.fingerprint !== found.checkIdentity.beforeFingerprint)
    throw Error("Missing the native pre-check workspace snapshot: " + taskId);
  if (snapshot.checkoutSha !== found.checkIdentity.beforeCheckoutSha || snapshot.checkoutSha !== found.checkIdentity.afterCheckoutSha)
    throw Error("The native check checkout differs from its recorded input version: " + taskId);
  return { receipt: found, snapshot };
}

async function inspectFormal(options: InspectOptions, raw: unknown, files: AdvancedFile[]) {
  const manifest = formalManifestSchema.parse(raw);
  const skill = await inspectAdvancedFile(options.cwd, manifest.skillPath, "artifact", { text: true, signal: options.signal });
  if (!/\/(?:SKILL\.md)$/i.test("/" + skill.path) || !/^---\r?\n[\s\S]*?\bname:\s*\S+[\s\S]*?\bdescription:\s*\S+[\s\S]*?\r?\n---(?:\r?\n|$)/.test(skill.text ?? ""))
    throw Error("The project-local skill needs a real SKILL.md with name and description frontmatter.");
  if (!skill.text?.includes(manifest.command) || !skill.text.includes(manifest.syncCommit)) throw Error("SKILL.md must contain its reproducible command and sync commit.");
  const currentHead = (await exec("git", ["-C", options.cwd, "rev-parse", "HEAD"], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, signal: options.signal })).stdout.trim();
  if (currentHead !== manifest.syncCommit) throw Error("The formal verification sync commit must identify the actual current checkout.");
  const clean = verificationReceipt(options, manifest.cleanCheckTaskId), broken = verificationReceipt(options, manifest.mutation.checkTaskId);
  if (!clean.receipt.passed || clean.receipt.outcome !== "passed" || clean.receipt.exitCode !== 0 || broken.receipt.passed ||
    !["command_failed", "assertion_failed"].includes(broken.receipt.outcome) || broken.receipt.exitCode === null || broken.receipt.exitCode <= 0 || broken.receipt.exitCode >= 126 ||
    clean.receipt.command !== manifest.command || broken.receipt.command !== manifest.command ||
    broken.receipt.checkIdentity.operationTaskId >= clean.receipt.checkIdentity.operationTaskId || clean.receipt.fingerprint === broken.receipt.fingerprint)
    throw Error("Run the same real check against a broken source variant, restore it, then obtain a clean pass.");
  if (!broken.receipt.output.output.includes(manifest.mutation.failureEvidence) || /\b(?:ENOENT|command not found|ModuleNotFoundError|SyntaxError|unrecognized (?:argument|option)|cannot find module)\b/i.test(broken.receipt.output.output))
    throw Error("The negative case must show the target property failing, not a missing dependency or invalid command.");
  files.push(fileOnly(skill));
  const prefix = (await exec("git", ["--no-replace-objects", "-C", options.cwd, "rev-parse", "--show-prefix"], { windowsHide: true, timeout: 10000, signal: options.signal })).stdout.trim();
  const verifyCleanVersion = async (file: AdvancedFile) => {
    let expected = clean.snapshot.fileDigests[file.path];
    // measureWorkspace records a delta, so absent paths are not evidence of
    // the current bytes. Recover their exact checked version from the commit
    // that the host captured before AND after the native check.
    if (expected === undefined) {
      if (!clean.snapshot.checkoutSha || clean.snapshot.checkoutSha !== manifest.syncCommit)
        throw Error("No checked version is available for " + file.path + ". Verify a versioned checkout again.");
      try {
        const blob = await exec("git", ["--no-replace-objects", "-C", options.cwd, "cat-file", "blob", clean.snapshot.checkoutSha + ":" + prefix + file.path],
          { encoding: "buffer", windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 * 1024, signal: options.signal });
        expected = createHash("sha256").update(blob.stdout).digest("hex");
      } catch { throw Error("No checked Git file version is available for " + file.path + ". Rerun the check with this file in scope."); }
    }
    if (expected !== file.digest) throw Error("File changed after the clean check: " + file.path);
  };
  const sourcePaths = new Set<string>();
  for (const source of manifest.sources) {
    const actual = await inspectAdvancedFile(options.cwd, source.path, "input", { signal: options.signal });
    if (actual.digest !== source.digest) throw Error("Source mapping is stale: " + source.path);
    await verifyCleanVersion(actual);
    sourcePaths.add(actual.path); files.push(fileOnly(actual));
  }
  const mutated = workspaceDocumentPath(manifest.mutation.sourcePath, "破坏变体源码");
  const source = files.find(file => file.role === "input" && file.path === mutated);
  if (!source || !broken.snapshot.fileDigests[mutated] || broken.snapshot.fileDigests[mutated] === source.digest)
    throw Error("The failed check must have observed an actual mutation of a covered source file.");
  for (const name of manifest.verificationFiles) {
    const actual = await inspectAdvancedFile(options.cwd, name, "artifact", { signal: options.signal });
    if (sourcePaths.has(actual.path)) throw Error("Verification helpers cannot relabel covered product source as artifacts.");
    if (!actual.path.startsWith(dirname(skill.path).replaceAll("\\", "/") + "/") &&
      !/(?:^|[\/._-])(?:test|tests|check|checks|verify|verification|proof|proofs|spec|specs|models?)(?:[\/._-]|$)/i.test(actual.path))
      throw Error("Keep verification helpers in the skill or a clearly named verification directory: " + actual.path);
    await verifyCleanVersion(actual);
    files.push(fileOnly(actual));
  }
  if (options.skillId === "maintain-formal-verification-skill") {
    if (!manifest.previousSyncCommit || !manifest.changeSummary || !manifest.status || manifest.baselineCheckTaskId === undefined)
      throw Error("Maintenance must record previousSyncCommit, changeSummary, status and baselineCheckTaskId.");
    const baseline = verificationReceipt(options, manifest.baselineCheckTaskId);
    if (baseline.receipt.checkIdentity.operationTaskId >= broken.receipt.checkIdentity.operationTaskId)
      throw Error("Run the previous verification before updating it and testing the mutation.");
    await exec("git", ["-C", options.cwd, "merge-base", "--is-ancestor", manifest.previousSyncCommit, manifest.syncCommit], { windowsHide: true, timeout: 10000, signal: options.signal });
  }
  return { cleanCheckTaskId: manifest.cleanCheckTaskId, mutationCheckTaskId: manifest.mutation.checkTaskId,
    command: manifest.command, syncCommit: manifest.syncCommit, sourcePaths: [...sourcePaths], ...(manifest.status && { status: manifest.status }) };
}

export async function inspectAdvancedArtifact(options: InspectOptions): Promise<AdvancedArtifactReceipt> {
  if (!(advancedSkillIds as readonly string[]).includes(options.skillId)) throw Error("This skill has no advanced artifact contract.");
  const manifest = await inspectAdvancedFile(options.cwd, options.artifact, "artifact", { signal: options.signal, text: true });
  let raw: unknown;
  try { raw = JSON.parse(manifest.text!); } catch { throw Error("The pstack artifact must be a JSON manifest."); }
  const files: AdvancedFile[] = [fileOnly(manifest)];
  const result: AdvancedArtifactReceipt = { version: 1, kind: options.skillId as AdvancedSkillId, artifact: manifest.path, workflowRun: options.workflowRun, files };
  if (options.skillId === "statechart") {
    const document = statechartManifestSchema.parse(raw), receipt = statechartReceiptSchema.parse(options.statechartReceipt);
    if (receipt.workflowRun !== options.workflowRun || receipt.taskId !== document.executionTaskId) throw Error("Statechart requires this workflow's native execution receipt.");
    await checkAdvancedArtifact(receipt, options); files.push(...receipt.files); result.statechart = receipt;
  } else if (options.skillId === "ketchup-video") {
    const document = videoManifestSchema.parse(raw), receipt = videoReceiptSchema.parse(options.videoReceipt);
    if (document.inspectionTaskId !== receipt.taskId || receipt.workflowRun !== options.workflowRun || receipt.slidePlanDigest !== videoPlanDigest(document))
      throw Error("Inspect this exact video and slide plan with pstack_video_inspect before delivery.");
    if (!document.visualReview || document.visualReview.length !== receipt.frames.length || new Set(document.visualReview.map(item => item.frame)).size !== receipt.frames.length ||
      receipt.frames.some(frame => !document.visualReview!.some(item => item.frame === frame.path)))
      throw Error("Record a real image read and visual review for every decoded video frame. Technical media checks alone do not prove readability.");
    await checkAdvancedArtifact(receipt, options); files.push(...receipt.files); result.video = receipt; result.visualReview = document.visualReview;
  } else result.formal = await inspectFormal(options, raw, files);
  result.files = dedupe(files);
  return result;
}

/** Workflow integration: resolve receipt ids from the manifest, never from
 * model-supplied receipt objects, and retain the existing verify snapshots. */
export async function inspectWorkflowAdvancedArtifact(options: {
  cwd: string; skillId: string; artifact: string; run: WorkflowRun; api: Api; ctx: Context;
}): Promise<AdvancedArtifactReceipt> {
  const { api, ctx, run } = options;
  const file = await inspectAdvancedFile(options.cwd, options.artifact, "artifact", { signal: ctx.abortSignal, text: true });
  const document: unknown = JSON.parse(file.text!);
  const receipt = await inspectAdvancedArtifact({
    cwd: options.cwd, skillId: options.skillId, artifact: options.artifact, workflowRun: run.run,
    checkReceipts: run.checkReceipts, signal: ctx.abortSignal,
    ...(options.skillId === "statechart" && { statechartReceipt: await readStatechartReceipt(api, ctx, run, statechartManifestSchema.parse(document).executionTaskId) }),
    ...(options.skillId === "ketchup-video" && { videoReceipt: await readVideoInspectionReceipt(api, ctx, run, z.number().int().parse(videoManifestSchema.parse(document).inspectionTaskId)) }),
    ...(/^(?:create|maintain)-formal-verification-skill$/.test(options.skillId) && { checkSnapshots: await readFormalCheckSnapshots(api, ctx, run) }),
  });
  if (receipt.video) validateVideoVisualReviews(await transcript(api, ctx, run.first), options.cwd, run.task, receipt.video, receipt.visualReview ?? []);
  return receipt;
}

export function validateVideoVisualReviews(entries: readonly EntryRecord[], cwd: string, taskId: string,
  receipt: VideoInspectionReceipt, reviews: NonNullable<VideoManifest["visualReview"]>) {
  const observations = observedReviewFiles(entries, cwd, cwd);
  for (const frame of receipt.frames) {
    const review = reviews.find(item => item.frame === frame.path);
    const found = review && observations.find(item => item.tool === "read" && item.path === frame.path &&
      item.executionReceipt?.toolTaskId === review.readTaskId && item.executionReceipt.taskId === taskId &&
      item.executionReceipt.status === "passed" && item.executionReceipt.transport === "returned" && item.executionReceipt.settlement === "consumed" &&
      !item.executionReceipt.fileRead?.partial && (item.executionReceipt.fileRead?.images ?? 0) > 0 && nativeFileVersion(item.executionReceipt) === frame.digest);
    if (!found) throw Error("Read the actual decoded image before marking it visually checked: " + frame.path + ". Its successful paired native read must include this file version and image content.");
  }
}
