import type { RuntimeContextSnapshotDto } from "./agent-ipc";

function redactText(value: string | undefined): string | undefined {
  if (!value) return value;
  return value
    .replace(/\b(?:[A-Za-z]:\\|\\\\)[^\s"']+/g, "[local-path]")
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, "[secret]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [secret]");
}

/** Export deliberately omits instruction content while retaining provenance and hashes. */
export function sanitizeRuntimeAuditSnapshot(snapshot: RuntimeContextSnapshotDto): object {
  return {
    id: snapshot.id,
    executionId: snapshot.executionId,
    taskId: snapshot.taskId,
    createdAt: snapshot.createdAt,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    status: snapshot.status,
    error: redactText(snapshot.error),
    assemblyHash: snapshot.assemblyHash,
    modelId: snapshot.modelId,
    permissionMode: snapshot.permissionMode,
    mode: snapshot.mode,
    tagId: snapshot.tagId,
    projectId: snapshot.projectId,
    projectUpdatedAt: snapshot.projectUpdatedAt,
    storageBytes: snapshot.storageBytes,
    instructions: snapshot.resolvedInstructions.map(({ content: _content, ...segment }) => segment),
    capabilities: snapshot.resolvedCapabilities,
    warnings: snapshot.warnings.map((warning) => redactText(warning) ?? ""),
  };
}

export function diffRuntimeAuditSnapshots(
  older: RuntimeContextSnapshotDto,
  newer: RuntimeContextSnapshotDto,
): string[] {
  const changes: string[] = [];
  const scalar: Array<[string, unknown, unknown]> = [
    ["Mode", older.mode, newer.mode],
    ["Tag", older.tagId, newer.tagId],
    ["Project", older.projectId, newer.projectId],
    ["Project revision", older.projectUpdatedAt, newer.projectUpdatedAt],
    ["Model", older.modelId, newer.modelId],
    ["Permission", older.permissionMode, newer.permissionMode],
    ["Assembly", older.assemblyHash, newer.assemblyHash],
  ];
  for (const [label, before, after] of scalar) {
    if (before !== after) changes.push(`${label}: ${String(before ?? "—")} → ${String(after ?? "—")}`);
  }
  const beforeSegments = new Map(older.resolvedInstructions.map((item) => [item.id, item]));
  const afterSegments = new Map(newer.resolvedInstructions.map((item) => [item.id, item]));
  for (const id of new Set([...beforeSegments.keys(), ...afterSegments.keys()])) {
    if (beforeSegments.get(id)?.contentHash !== afterSegments.get(id)?.contentHash) {
      changes.push(`Instruction ${id} changed`);
    }
  }
  const key = (item: { kind: string; id: string }): string => `${item.kind}:${item.id}`;
  const beforeCapabilities = new Map(older.resolvedCapabilities.map((item) => [key(item), item]));
  const afterCapabilities = new Map(newer.resolvedCapabilities.map((item) => [key(item), item]));
  for (const id of new Set([...beforeCapabilities.keys(), ...afterCapabilities.keys()])) {
    const before = beforeCapabilities.get(id);
    const after = afterCapabilities.get(id);
    if (!before && after) {
      changes.push(`${id}: added (${after.enabled ? "enabled" : "disabled"})`);
      continue;
    }
    if (before && !after) {
      changes.push(`${id}: removed (was ${before.enabled ? "enabled" : "disabled"})`);
      continue;
    }
    if (!before || !after) continue;
    if (before.enabled !== after.enabled) {
      changes.push(`${id}: ${before.enabled ? "enabled" : "disabled"} → ${after.enabled ? "enabled" : "disabled"}`);
    } else if (before.reason !== after.reason) {
      changes.push(`${id}: reason ${before.reason ?? "—"} → ${after.reason ?? "—"}`);
    }
  }
  return changes;
}
