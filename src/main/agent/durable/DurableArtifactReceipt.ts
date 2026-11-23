import { realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { z } from "zod";

export const DURABLE_ARTIFACT_ENTRY_KIND = "mybuddy.artifact-registered";
export const durableArtifactRegistrationSchema = z.object({
  previewManifestPath: z.string().optional(), snapshotPath: z.string().min(1), path: z.string().min(1), cwd: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(), registeredAt: z.number().int().nonnegative(),
  toolCallId: z.string().min(1), toolTaskId: z.number().int().nonnegative(),
  toolConversationId: z.number().int().nonnegative(), inputIds: z.array(z.number().int().nonnegative()).min(1),
  explicitlyRegistered: z.literal(true).optional(),
});
export type DurableArtifactRegistration = z.infer<typeof durableArtifactRegistrationSchema>;
export function inside(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function snapshotName(path: string, digest: string): string {
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
