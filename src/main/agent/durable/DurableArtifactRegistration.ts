import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, realpath, mkdir, link, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, join, extname } from "node:path";
import { defineEntry, defineTool, LiveDoc, type EntryRecord, type ToolRegistration, type Cursor } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { z } from "zod";

export const DURABLE_ARTIFACT_ENTRY_KIND = "mybuddy.artifact-registered";
const ArtifactRegistered = defineEntry<DurableArtifactRegistration>(DURABLE_ARTIFACT_ENTRY_KIND);
export const durableArtifactRegistrationSchema = z.object({
  snapshotPath: z.string().min(1), path: z.string().min(1), cwd: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(), registeredAt: z.number().int().nonnegative(),
  toolCallId: z.string().min(1), toolTaskId: z.number().int().nonnegative(),
  toolConversationId: z.number().int().nonnegative(), inputIds: z.array(z.number().int().nonnegative()).min(1),
});
export type DurableArtifactRegistration = z.infer<typeof durableArtifactRegistrationSchema>;
function inside(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function snapshotName(path: string, digest: string): string {
  const extension = extname(path).toLowerCase();
  return digest + (/^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ".bin");
}
/** Only host entries are evidence; model text and tool-result details cannot register files. */
export function durableRegisteredArtifact(entry: EntryRecord, inputId: number, workspaceBinding?: string, directory?: string): DurableArtifactRegistration | undefined {
  if (!directory || entry.kind !== DURABLE_ARTIFACT_ENTRY_KIND) return undefined;
  const parsed = durableArtifactRegistrationSchema.safeParse(entry.data);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  let bound = workspaceBinding && resolve(workspaceBinding);
  if (bound) { try { bound = realpathSync(bound); } catch { /* Keep historical evidence if the workspace was removed. */ } }
  if (!data.inputIds.includes(inputId) || !isAbsolute(data.path) || !isAbsolute(data.cwd)
    || !inside(data.cwd, data.path) || (bound && bound !== data.cwd)) return undefined;
  let store = resolve(directory);
  try { store = realpathSync(store); } catch { /* Historical paths can outlive their stores. */ }
  if (data.snapshotPath !== join(store, "artifacts", snapshotName(data.path, data.digest))) return undefined;
  try { if (realpathSync(data.snapshotPath) !== data.snapshotPath) return undefined; } catch { /* Opening reports a missing snapshot separately. */ }
  return data;
}
/** Verify a regular file and hash stable bytes. Never enumerate the workspace. */
export async function inspectDurableArtifact(cwd: string, path: string, directory?: string): Promise<Pick<DurableArtifactRegistration, "path" | "cwd" | "digest" | "sizeBytes"> & { snapshotPath?: string }> {
  const root = await realpath(cwd), requested = resolve(root, path);
  if (!inside(root, requested)) throw new Error("Artifact path must be inside the bound workspace");
  const canonical = await realpath(requested);
  if (!inside(root, canonical)) throw new Error("Artifact resolves outside the bound workspace");
  const before = await lstat(canonical);
  if (!before.isFile()) throw new Error("Artifact must be a regular file");
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let temporary: string | undefined;
  let snapshot: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let store: string | undefined;
    if (directory) {
      await mkdir(directory, { recursive: true });
      const canonicalStore = await realpath(directory);
      store = join(canonicalStore, "artifacts");
      await mkdir(store, { recursive: true });
      if (await realpath(store) !== store) throw new Error("Artifact snapshot directory must not be a symlink");
      temporary = join(store, `.pending-${randomUUID()}`);
      snapshot = await open(temporary, "wx", 0o600);
    }
    const start = await file.stat();
    if (!start.isFile() || start.dev !== before.dev || start.ino !== before.ino) throw new Error("Artifact changed before inspection");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
    let sizeBytes = 0;
    while (sizeBytes < start.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, start.size - sizeBytes), null);
      if (!bytesRead) break;
      sizeBytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
      if (snapshot) await snapshot.writeFile(buffer.subarray(0, bytesRead));
    }
    const end = await file.stat(), current = await lstat(canonical);
    if (await realpath(requested) !== canonical || !current.isFile() || current.dev !== start.dev || current.ino !== start.ino
      || end.size !== start.size || sizeBytes !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs
      || current.size !== end.size || current.mtimeMs !== end.mtimeMs || current.ctimeMs !== end.ctimeMs)
      throw new Error("Artifact changed during inspection; register it after the write finishes");
    const digest = hash.digest("hex");
    let snapshotPath: string | undefined;
    if (snapshot && temporary && store) {
      await snapshot.sync();
      await snapshot.close(); snapshot = undefined;
      snapshotPath = join(store, snapshotName(canonical, digest));
      try { await link(temporary, snapshotPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await lstat(snapshotPath)).isFile() || await realpath(snapshotPath) !== snapshotPath) throw new Error("Existing artifact snapshot must be a regular file at its trusted path");
        const stored = await inspectDurableArtifact(store, snapshotName(canonical, digest));
        if (stored.digest !== digest || stored.sizeBytes !== sizeBytes) throw new Error("Existing artifact snapshot failed integrity verification");
      }
    }
    return { cwd: root, path: canonical, digest, sizeBytes, ...(snapshotPath ? { snapshotPath } : {}) };
  } finally {
    await file.close(); await snapshot?.close();
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

type Api = Parameters<ToolRegistration["execute"]>[1];
type Context = Parameters<ToolRegistration["execute"]>[2];
/** Replay-safe host receipt, scoped to the owning run and exact native call. */
async function register(path: string, api: Api, context: Context, directory: string): Promise<DurableArtifactRegistration> {
  const agent = await api.agent(context);
  if (!agent.cwd) throw new Error("Artifact registration requires a host-bound workspace");
  const owner = await api.commit(async tx => {
    let id = api.conversationId;
    const seen = new Set<number>();
    for (;;) {
      if (seen.has(id)) throw new Error("Invalid artifact conversation owner chain");
      seen.add(id);
      const conversation = await tx.conversation(id);
      if (!conversation) throw new Error("Artifact conversation is missing");
      if (!conversation.owner) return id;
      id = conversation.owner.conversationId;
    }
  }, context);
  const findExisting = async (tx: Parameters<Parameters<Api["commit"]>[0]>[0]) => {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId: owner, order: "descending" }, 100, cursor);
      for (const entry of page.items) {
        const parsed = entry.kind === DURABLE_ARTIFACT_ENTRY_KIND ? durableArtifactRegistrationSchema.safeParse(entry.data) : undefined;
        const data = parsed?.success ? parsed.data : undefined;
        if (data?.toolTaskId === api.taskId && data.toolCallId === api.callId && data.toolConversationId === api.conversationId) return data;
      }
      cursor = page.next;
    } while (cursor);
    return undefined;
  };
  const existing = await api.commit(findExisting, context);
  if (existing) return existing;
  // LiveRun.inputs is SubmissionId[], not entry IDs. Code Mode's tool conversation
  // does not own the user's submission, so use the presentation owner's run.
  const live = await api.snapshot(LiveDoc, owner, context);
  const inputIds = [...live?.run?.inputs ?? []];
  if (!inputIds.length) throw new Error("Artifact registration requires an active input identity");
  const file = await inspectDurableArtifact(agent.cwd, path, directory);
  context.abortSignal?.throwIfAborted();
  if (!file.snapshotPath) throw new Error("Artifact snapshot was not persisted");
  const data = { ...file, snapshotPath: file.snapshotPath, registeredAt: Date.now(), toolCallId: api.callId, toolTaskId: api.taskId,
    toolConversationId: api.conversationId, inputIds };
  return api.commit(async tx => {
    const previous = await findExisting(tx);
    if (previous) return previous;
    await tx.appendEntry(ArtifactRegistered, owner, { data });
    return data;
  }, context);
}

export function createDurableArtifactRegistrationTool(directory: string): ToolRegistration {
  return defineTool({
    name: "register_artifact", replay: "safe",
    description: "Register a generated file for display in this task's deliverables. Immediately after creating a file with shell, Python or another tool, call register_artifact with its path; do not wait for your final reply. The host verifies a regular file within the bound workspace and records its hash and size durably. Register only intended output files; do not enumerate the workspace. This records generated evidence, not acceptance or task completion. Call again after changing the file to record its new version.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, description: "Generated file path, relative to the bound workspace or absolute within it." }) }),
    execute: async ({ path }, api, context) => {
      const data = await register(path, api, context, directory);
      return { output: [{ type: "text", text: `Registered generated file: ${data.path} (${data.sizeBytes} bytes, SHA-256 ${data.digest})` }] };
    },
  });
}

/** Preserve native write/edit outcomes; only successful calls can supply implicit evidence. */
export function withDurableArtifactRegistration(tool: ToolRegistration, directory: string): ToolRegistration {
  if (tool.name !== "write" && tool.name !== "edit") return tool;
  return { ...tool, execute: async (args, api, context) => {
    const result = await tool.execute(args, api, context);
    const parsed = z.object({ path: z.string() }).safeParse(args);
    if (!result.isError && parsed.success) {
      // Discovery is supplementary. A missing/deleted/outside file must not turn a
      // successful native edit into a failed write that might be replayed.
      try { await register(parsed.data.path, api, context, directory); }
      catch (error) { api.output(`Generated file registration unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return result;
  } };
}
