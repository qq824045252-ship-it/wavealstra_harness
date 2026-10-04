import { createHash } from "node:crypto";
import type { RuntimeAuditInstructionDto } from "../../shared/agent-ipc";
import type { AssemblySegmentDto } from "../../shared/mode-profile";

export const RUNTIME_AUDIT_MAX_RECORDS_PER_TASK = 50;
export const RUNTIME_AUDIT_MAX_BYTES_PER_TASK = 2 * 1024 * 1024;
export const RUNTIME_AUDIT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const FULL_SEGMENT_MAX_CHARS = 4_000;
const EXCERPT_HEAD_CHARS = 600;
const EXCERPT_TAIL_CHARS = 200;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Snapshots retain exact identity and useful diagnostics without retaining an
 * unbounded second copy of every prompt/resource body. Large segments are
 * represented by a deterministic head/tail excerpt plus their SHA-256 hash.
 */
export function compactRuntimeAuditInstructions(
  segments: readonly AssemblySegmentDto[],
): RuntimeAuditInstructionDto[] {
  return segments.map((segment) => {
    const contentHash = hashContent(segment.content);
    if (segment.content.length <= FULL_SEGMENT_MAX_CHARS) {
      return {
        ...segment,
        contentHash,
        storage: "full",
        storedChars: segment.content.length,
      };
    }
    const omitted = Math.max(0, segment.content.length - EXCERPT_HEAD_CHARS - EXCERPT_TAIL_CHARS);
    const content = `${segment.content.slice(0, EXCERPT_HEAD_CHARS)}\n\n[…已省略 ${omitted} 字符…]\n\n${segment.content.slice(-EXCERPT_TAIL_CHARS)}`;
    return {
      ...segment,
      content,
      contentHash,
      storage: "excerpt",
      storedChars: content.length,
    };
  });
}

export function normalizeStoredAuditInstructions(value: unknown): RuntimeAuditInstructionDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<RuntimeAuditInstructionDto>;
    if (typeof candidate.id !== "string" || typeof candidate.content !== "string") return [];
    if (
      typeof candidate.contentHash === "string" &&
      (candidate.storage === "full" || candidate.storage === "excerpt") &&
      typeof candidate.storedChars === "number"
    ) {
      return [candidate as RuntimeAuditInstructionDto];
    }
    return compactRuntimeAuditInstructions([candidate as AssemblySegmentDto]);
  });
}

export function runtimeAuditStorageBytes(parts: readonly string[]): number {
  return parts.reduce((total, part) => total + Buffer.byteLength(part, "utf8"), 0);
}
