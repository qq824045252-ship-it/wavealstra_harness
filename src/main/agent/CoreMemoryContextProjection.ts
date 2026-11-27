import {
  MEMORY_CONTEXT_DEFAULT_BUDGET, MEMORY_CONTEXT_HARD_BUDGET,
  type MemoryKind, type MemorySearchHit, type MemorySearchRequest,
} from "../../shared/memory-kernel";
import { CoreMemoryRecallUnavailable } from "../memory/MemoryCoreRecall";
import type { MemoryService } from "../memory/MemoryService";
import { MEMORY_EVIDENCE_CONTENT_LENGTH, MEMORY_EVIDENCE_RENDERER, memoryProjectionQuery, renderMemoryEvidence, type ProjectedMemoryContext } from "./MemoryContextProjection";

const PREFERENCES: MemoryKind[] = ["preference", "identity", "constraint"];

/** Production ordinary desktop L1 selection. Each ledger block records its actual Core revision. */
export async function readCoreMemoryContext(memory: MemoryService,
  input: MemorySearchRequest & { budgetChars?: number }): Promise<ProjectedMemoryContext> {
  const budget = Math.max(0, Math.min(MEMORY_CONTEXT_HARD_BUDGET, input.budgetChars ?? MEMORY_CONTEXT_DEFAULT_BUDGET));
  const result: ProjectedMemoryContext = {
    items: [], text: "", query: input.query?.trim() ?? "", budgetChars: budget, includedChars: 0, trimmed: false,
    scenarioIds: [], profileIds: [], blocks: [], sourceRevisions: [], groundingScenarioIds: [],
  };
  if (!budget) return result;
  const authority = await memory.readCoreRecallAuthority(input);
  const baseline = (scopeTypes: MemorySearchRequest["scopeTypes"], limit: number, kinds = input.kinds) =>
    memory.searchLexical({ ...input, query: undefined, scopeTypes, statuses: ["active"], kinds, limit });
  const preferenceKinds = PREFERENCES.filter(kind => !input.kinds?.length || input.kinds.includes(kind));
  const [queryHits, project, preferences] = await Promise.all([
    memory.searchCoreLexical(memoryProjectionQuery(input), authority),
    result.query && authority.scopes.some(scope => scope.scopeType === "project") ? baseline(["project"], 8) : [],
    result.query && preferenceKinds.length && authority.scopes.some(scope => scope.scopeType === "global")
      ? baseline(["global"], 6, preferenceKinds) : [],
  ]);
  const unique = new Map<string, MemorySearchHit>();
  for (const hit of [...preferences, ...queryHits, ...project]) if (!unique.has(hit.memory.id)) unique.set(hit.memory.id, hit);
  const header = "历史记忆证据：L1 是事实来源。本轮明确指令优先。";
  let bytes = Buffer.byteLength(header + "\n");
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit || 16)));
  const lines: string[] = [];
  for (const hit of unique.values()) {
    if (result.items.length >= limit) { result.trimmed = true; break; }
    const atom = await memory.readCoreRecallAtom(hit.memory.id, input, authority);
    const now = Date.now();
    if (!atom || atom.memory.contentHash !== hit.memory.contentHash || atom.memory.status !== "active"
      || (atom.memory.validFrom !== undefined && atom.memory.validFrom > now)
      || (atom.memory.validUntil !== undefined && atom.memory.validUntil <= now)) continue;
    const record = atom.memory;
    const scope = memory.bestMatchedScope(record, authority.scopes);
    const text = renderMemoryEvidence({ ...record, memoryId: record.id, revision: atom.revision }, scope.scopeType);
    const length = Buffer.byteLength(text + "\n");
    if (bytes + length > budget) { result.trimmed = true; continue; }
    bytes += length;
    lines.push(text);
    const sources = [{ id: record.id, revision: atom.revision }];
    result.blocks.push({ id: `memory:${record.id}`, revision: String(atom.revision), text, sources, scenarioIds: [], profileIds: [],
      fullInstruction: record.content.length <= MEMORY_EVIDENCE_CONTENT_LENGTH ? record.content : undefined,
      reference: { renderer: MEMORY_EVIDENCE_RENDERER, id: record.id, revision: atom.revision, scopeType: scope.scopeType } });
    result.sourceRevisions.push(...sources);
    result.items.push({ id: record.id, kind: record.kind, title: record.title, content: record.content,
      scopeType: scope.scopeType, scopeId: scope.scopeId, importance: record.importance, confidence: record.confidence,
      score: hit.score, reasons: hit.reasons });
  }
  const current = await memory.readCoreRecallAuthority(input);
  if (current.witness !== authority.witness) throw new CoreMemoryRecallUnavailable("记忆投影期间任务的可见范围已变化");
  if (lines.length) result.text = [header, ...lines].join("\n");
  result.includedChars = result.text.length;
  return result;
}
