import type { Api, Model } from "@earendil-works/pi-ai";

const EVIDENCE_SEGMENTS = new Set([
  "projectSharedContext", "projectPinnedRefs", "projectResources", "projectPlan", "library", "libraryAttachments",
]);
export const isEvidenceSegment = (id: string): boolean => EVIDENCE_SEGMENTS.has(id);

export function clipEvidence(text: string, bytes: number, keepLatest = false): string {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  const suffix = "\n[资料已按本轮预算截断；不能将未显示的内容视为已查阅。]";
  let remaining = bytes - Buffer.byteLength(suffix, "utf8");
  if (remaining <= 0) return "";
  const chars: string[] = [];
  const input = Array.from(text);
  if (keepLatest) input.reverse();
  for (const char of input) {
    remaining -= Buffer.byteLength(char, "utf8");
    if (remaining < 0) break;
    chars.push(char);
  }
  return keepLatest ? suffix + chars.reverse().join("") : chars.join("") + suffix;
}

export type EvidenceAccess =
  | { kind: "work-collaboration"; workId: string; bindingId: string; botId: string; messageIds: string[] }
  | { kind: "library"; itemId: string; origin: "attached" | "pinned" | "catalog"; projectId: string | null }
  | { kind: "project"; projectId: string; resourceIds: string[] }
  | { kind: "project-note"; projectId: string }
  | { kind: "workspace-note"; workspaceId: string };

export interface SupplementalEvidence {
  id: string;
  kind: "project" | "library" | "conversation";
  revision: string;
  text: string;
  /** Explicit project references are projected in full, independently of the automatic evidence budget. */
  explicitProjectReference?: boolean;
  /** Current access/deletion only; ordinary content changes wait for the next user turn. */
  validate: () => void;
  /** Historical permission check, separate from an optional stricter in-turn freshness check. */
  validateAccess?: () => void;
  /** Access witness only, never a claim that the original body can be restored. */
  access?: EvidenceAccess;
}

/** Bounds only automatically injected Memory/Project/Library supplements.
 * Pi owns tool-output truncation, context compaction and autonomous continuation.
 * Exhausting this budget omits supplements; it must never disable tools. */
export class EvidenceBudget {
  readonly limit: number;
  readonly memoryCap: number;
  private initialRemaining: number;
  readonly allocations: Array<{ source: string; used: number; excluded: boolean }> = [];

  constructor(model: Model<Api>, contextTokens: number) {
    const available = model.contextWindow - contextTokens - model.maxTokens - Math.ceil(model.contextWindow * 0.15) - 2048;
    this.limit = Math.max(0, Math.floor(Math.min(24_000, model.contextWindow * 0.2, available)));
    // Conservative byte caps for supplements, separate from Pi's token accounting.
    this.initialRemaining = Math.floor(this.limit * 0.45);
    this.memoryCap = Math.max(0, Math.floor(Math.min(4000, model.contextWindow * 0.04, this.initialRemaining * 0.5)));
  }

  takeInitial(source: string, text: string, cap = this.initialRemaining, keepLatest = false): string {
    const selected = clipEvidence(text, Math.max(0, Math.min(cap, this.initialRemaining)), keepLatest);
    const used = Buffer.byteLength(selected, "utf8");
    this.initialRemaining -= used;
    this.allocations.push({ source, used, excluded: !selected });
    return selected;
  }

}
