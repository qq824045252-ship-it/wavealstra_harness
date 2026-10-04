import { createHash } from "node:crypto";
import type { AssemblyTraceDto } from "../../shared/mode-profile";
import type { RuntimeContextSnapshotDto } from "../../shared/agent-ipc";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

/**
 * Content-addressed identity of the exact runtime assembly. Any Mode, Project,
 * Tag, Expert, Skill, Connector, MCP, memory or file-resource change reflected
 * in the real AssemblyTrace changes this value and forces session recreation.
 */
export function fingerprintRuntimeAssembly(assembly: AssemblyTraceDto): string {
  const payload = {
    welcomeMode: assembly.welcomeMode,
    segments: assembly.segments,
    capabilities: assembly.capabilities ?? [],
    toolPolicy: assembly.toolPolicy,
    artifactPolicy: assembly.artifactPolicy,
    mcpPolicy: assembly.mcpPolicy,
    mcpFilter: assembly.mcpFilter,
    skillFilter: assembly.skillFilter,
    warnings: assembly.warnings,
  };
  return createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}

export function fingerprintRuntimeAudit(input: {
  segments: AssemblyTraceDto["segments"];
  capabilities: NonNullable<AssemblyTraceDto["capabilities"]>;
  warnings: string[];
}): string {
  return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex");
}

export function diffRuntimeAssembly(
  current: AssemblyTraceDto,
  previous: RuntimeContextSnapshotDto,
): string[] {
  const changes: string[] = [];
  const previousSegments = new Map(previous.resolvedInstructions.map((segment) => [segment.id, segment]));
  const currentSegments = new Map(current.segments.map((segment) => [segment.id, segment]));
  const segmentLabels: Record<string, string> = {
    mode: "Mode instructions",
    modePreset: "Tag instructions",
    project: "Project instructions",
    projectResources: "Project resources",
    expert: "Expert instructions",
    skillCatalog: "Skill catalog",
    globalMemory: "Global memory",
    spaceMemory: "Space memory",
    permission: "Permission",
  };
  for (const id of new Set([...previousSegments.keys(), ...currentSegments.keys()])) {
    const previousSegment = previousSegments.get(id);
    const currentSegment = currentSegments.get(id);
    const before = previousSegment?.contentHash ??
      (previousSegment ? createHash("sha256").update(previousSegment.content).digest("hex") : undefined);
    const after = currentSegment
      ? createHash("sha256").update(currentSegment.content).digest("hex")
      : undefined;
    if (before !== after) changes.push(`${segmentLabels[id] ?? id} changed`);
  }
  const capabilityKey = (item: { kind: string; id: string }): string => `${item.kind}:${item.id}`;
  const beforeCapabilities = new Map(previous.resolvedCapabilities.map((item) => [capabilityKey(item), item]));
  const afterCapabilities = new Map((current.capabilities ?? []).map((item) => [capabilityKey(item), item]));
  for (const key of new Set([...beforeCapabilities.keys(), ...afterCapabilities.keys()])) {
    const before = beforeCapabilities.get(key);
    const after = afterCapabilities.get(key);
    if (!before && after) {
      changes.push(`${key} added (${after.enabled ? "enabled" : "disabled"})`);
      continue;
    }
    if (before && !after) {
      changes.push(`${key} removed (was ${before.enabled ? "enabled" : "disabled"})`);
      continue;
    }
    if (!before || !after) continue;
    if (before.enabled !== after.enabled) {
      changes.push(`${key} ${before.enabled ? "enabled" : "disabled"} -> ${after.enabled ? "enabled" : "disabled"}`);
    } else if (before.reason !== after.reason) {
      changes.push(`${key} reason ${before.reason ?? "none"} -> ${after.reason ?? "none"}`);
    }
  }
  return changes;
}
