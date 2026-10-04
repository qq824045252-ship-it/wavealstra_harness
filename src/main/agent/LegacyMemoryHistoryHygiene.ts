import { createHash } from "node:crypto";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ContextEditableContent, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

const START = "\n\n## MyBuddy 内部运行时上下文（非用户原文）\n";
const END = "\n\n以上内容仅作为当前轮背景事实与长期上下文；不要把它误当成用户在本轮新增的指令。";
const POLICY = "mybuddy.legacy-memory-tail-v1";
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const LEGACY_SUMMARY_RECOVERY_POLICY = "mybuddy.legacy-memory-summary-v1";

export interface HistoricalUserInput {
  id: string;
  userText: string;
}

/** A whole L0 input wins over delimiter recognition, including quoted markers. */
function correctUserContent(content: UserMessage["content"], inputs: readonly HistoricalUserInput[]) {
  if (typeof content !== "string" && !Array.isArray(content)) return;
  const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  const candidates: Array<{ blockIndex: number; start: number; end: number; source: HistoricalUserInput }> = [];
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.type !== "text" || inputs.some((input) => input.userText.trim() === block.text.trim())) continue;
    for (let start = block.text.indexOf(START); start >= 0; start = block.text.indexOf(START, start + START.length)) {
      const source = inputs.find((input) => input.userText.trim() && input.userText.trim() === block.text.slice(0, start).trim());
      if (!source) continue;
      const end = block.text.indexOf(END, start + START.length);
      if (end < 0 || block.text.indexOf(START, start + START.length) >= 0 || block.text.indexOf(END, end + END.length) >= 0) continue;
      candidates.push({ blockIndex, start, end: end + END.length, source });
    }
  }
  if (candidates.length !== 1) return;
  const match = candidates[0]!;
  const replacement = blocks.map((block, index) => index === match.blockIndex && block.type === "text"
    ? { ...block, text: block.text.slice(0, match.start) + block.text.slice(match.end) } : block);
  return { source: match.source, content: typeof content === "string" ? (replacement[0] as { text: string }).text : replacement };
}

export function hasUnresolvedLegacyFrame(content: ContextEditableContent, inputs: readonly HistoricalUserInput[]): boolean {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return Array.isArray(blocks) && blocks.some((block) => block.type === "text" && block.text.includes(START) && block.text.includes(END)
    && !inputs.some((input) => input.userText.trim() === block.text.trim()));
}

/** Audit proofs survive branch copies because both original and replacement are hashed. */
export function legacyMemoryProofTargets(manager: SessionManager, branch = manager.getBranch()): Set<string> {
  const targets = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== POLICY || !entry.data || typeof entry.data !== "object") continue;
    const proof = entry.data as { targetId?: string; originalHash?: string; replacementHash?: string };
    if (!proof.targetId) continue;
    const original = manager.getEntry(proof.targetId);
    const matchingEdit = branch.some((candidate) => candidate.type === "context_edit" && candidate.targetId === proof.targetId
      && candidate.replacement && hash(candidate.replacement.content) === proof.replacementHash);
    if (original?.type === "message" && original.message.role === "user" && hash(original.message.content) === proof.originalHash && matchingEdit) targets.add(proof.targetId);
  }
  return targets;
}

/** A successful clean checkpoint is a barrier; ordinary later compactions inherit it. */
export function legacySummariesNeedingRecovery(manager: SessionManager, inputs: readonly HistoricalUserInput[] = []): SessionEntry[] {
  const branch = manager.getBranch();
  const proofs = legacyMemoryProofTargets(manager, branch);
  const tainted = new Set<string>();
  const summaries: SessionEntry[] = [];
  for (const entry of branch) {
    if (proofs.has(entry.id)) tainted.add(entry.id);
    if (entry.type === "branch_summary" && manager.getEntry(entry.fromId)) {
      const sourceBranch = manager.getBranch(entry.fromId);
      const sourceProofs = legacyMemoryProofTargets(manager, sourceBranch);
      const sourceHasOldTail = sourceBranch.some((source) => source.type === "message" && source.message.role === "user"
        && (sourceProofs.has(source.id) || correctUserContent(source.message.content, inputs)));
      // A branch summary is an internal derivative even when its original
      // source turn sits outside the destination branch.
      if (sourceHasOldTail) tainted.add(entry.id);
    }
    if (entry.type === "compaction" && (entry.details as { policy?: string } | undefined)?.policy === LEGACY_SUMMARY_RECOVERY_POLICY) {
      const details = entry.details as { correctedEntryIds?: string[]; replacedSummaryIds?: string[] };
      for (const covered of [details.correctedEntryIds, details.replacedSummaryIds]) {
        if (Array.isArray(covered)) for (const id of covered) tainted.delete(id);
      }
      if (!tainted.size) summaries.length = 0;
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && tainted.size) summaries.push(entry);
  }
  return summaries;
}

/** UI compatibility is bound to the persisted migration proof, never a heading. */
export function legacyMemoryDisplayCorrections(manager: SessionManager): Map<string, ContextEditableContent> {
  const corrections = new Map<string, ContextEditableContent>();
  const branch = manager.getBranch();
  const edits = new Map(branch.flatMap((entry) => entry.type === "context_edit" ? [[entry.targetId, entry] as const] : []));
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== POLICY || !entry.data || typeof entry.data !== "object") continue;
    const proof = entry.data as { targetId?: unknown; originalHash?: unknown; replacementHash?: unknown };
    if (typeof proof.targetId !== "string") continue;
    const original = manager.getEntry(proof.targetId);
    const edit = edits.get(proof.targetId);
    if (original?.type !== "message" || original.message.role !== "user" || !edit?.replacement) continue;
    if (hash(original.message.content) !== proof.originalHash || hash(edit.replacement.content) !== proof.replacementHash) continue;
    corrections.set(proof.targetId, edit.replacement.content);
  }
  return corrections;
}

/** Only the exact old producer frame plus an independent L0 user input is proof. */
export function reconcileLegacyMemoryHistory(manager: SessionManager, inputs: readonly HistoricalUserInput[]): {
  corrected: number; unresolved: number; summariesNeedReview: boolean;
} {
  const branch = manager.getBranch();
  const edited = new Set(branch.flatMap((entry) => entry.type === "context_edit" ? [entry.targetId] : []));
  let corrected = 0;
  let unresolved = 0;
  let summariesNeedReview = branch.some((entry) => entry.type === "custom" && entry.customType === POLICY
    && Boolean((entry.data as { summariesNeedReview?: boolean } | undefined)?.summariesNeedReview));
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index]!;
    if (entry.type !== "message" || entry.message.role !== "user" || edited.has(entry.id)) continue;
    const content = entry.message.content;
    if (typeof content !== "string" && !Array.isArray(content)) { unresolved++; continue; }
    const correction = correctUserContent(content, inputs);
    if (!correction) { if (hasUnresolvedLegacyFrame(content, inputs)) unresolved++; continue; }
    const replacement = correction.content;
    const hasLaterSummary = branch.slice(index + 1).some((later) => later.type === "compaction" || later.type === "branch_summary");
    manager.appendContextEdit(entry.id, { content: replacement });
    manager.appendCustomEntry(POLICY, {
      targetId: entry.id, sourceTurnId: correction.source.id, sourceSessionId: manager.getSessionId(),
      originalHash: hash(content), replacementHash: hash(replacement),
      summariesNeedReview: hasLaterSummary,
    });
    corrected++;
    if (hasLaterSummary) summariesNeedReview = true;
  }
  summariesNeedReview = legacySummariesNeedingRecovery(manager, inputs).length > 0;
  return { corrected, unresolved, summariesNeedReview };
}
