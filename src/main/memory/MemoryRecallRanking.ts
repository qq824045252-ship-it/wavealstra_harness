import { setImmediate as yieldThread } from "node:timers/promises";
import type { MemoryRecordDto, MemorySearchHit, MemorySearchRequest } from "../../shared/memory-kernel";
import type { MemoryRepository } from "./MemoryRepository";
import type { MemorySearchScope } from "./MemorySearchScope";
import { normalizeSearchText } from "./MemorySearchText";

export function tokenSimilarity(a: string, b: string): number {
  const aa = normalizeSearchText(a);
  const bb = normalizeSearchText(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) return 0.86;
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < Math.max(1, s.length - 1); i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(aa); const gb = grams(bb);
  let hit = 0; for (const g of ga) if (gb.has(g)) hit++;
  return hit / Math.max(1, ga.size + gb.size - hit);
}

type RankingInput = {
  scoped: ReturnType<MemoryRepository["listByScopes"]>; ftsRank: ReadonlyMap<string, number>; query: string;
  request: MemorySearchRequest; scopes: Array<MemorySearchScope["scopes"][number] & { distance?: number }>;
  visible: (memory: MemoryRecordDto) => boolean;
};

function scoreMemoryItem(item: RankingInput["scoped"][number], { ftsRank, query, request, scopes, visible }: RankingInput, now: number, similarities: Map<string, number>): MemorySearchHit | undefined {
  const distance = scopes.find((scope) => scope.scopeType === item.scopeType && (scope.scopeId ?? "") === (item.scopeId ?? ""))?.distance ?? 10;
  const memory = item.memory;
  if (!visible(memory)) return;
  if (memory.status === "active" && ((memory.validFrom !== undefined && memory.validFrom > now)
    || (memory.validUntil !== undefined && memory.validUntil <= now))) return;
  const reasons: string[] = [];
  let score = 0;
  if (query) {
    // Ranking candidates can share a source passage or have several readable bindings.
    // The query is fixed for this call; reuse pure text scores, never authorization.
    const similarity = (text: string) => {
      let value = similarities.get(text);
      if (value === undefined) { value = tokenSimilarity(query, text); similarities.set(text, value); }
      return value;
    };
    const titleSim = similarity(memory.title);
    const contentSim = similarity(memory.content);
    const sim = Math.max(titleSim * 1.15, contentSim);
    const rank = ftsRank.get(memory.id);
    if (rank !== undefined) {
      score += 48 / (1 + Math.log2(rank + 1));
      reasons.push("bm25");
    }
    if (sim > 0) score += sim * 36;
    if (sim > 0.8) reasons.push("lexical-exact");
    else if (sim > 0.20) reasons.push("lexical-related");
    // Query mode must not return unrelated recent memories merely because they are in scope.
    if (rank === undefined && sim < 0.10) return;
  } else {
    score += 12;
  }
  score += Math.max(0, 18 - distance * 2.5);
  reasons.push(`scope:${item.scopeType}${distance ? `/${distance}` : ""}`);
  score += memory.importance * 8;
  if (memory.importance >= 2) reasons.push(`importance:${memory.importance}`);
  score += memory.confidence * 8;
  if (memory.explicit) { score += 10; reasons.push("explicit"); }
  if (memory.kind === "identity" || memory.kind === "preference") score += item.scopeType === "global" ? 8 : 2;
  const ageDays = Math.max(0, (now - memory.updatedAt) / 86_400_000);
  score += Math.max(0, 5 - Math.log2(ageDays + 1));
  if (item.binding === "promoted") reasons.push("promoted");
  return { memory, score, reasons, scopeDistance: distance };
}

function* scoreMemorySearch(input: RankingInput): Generator<MemorySearchHit | undefined> {
  const now = Date.now();
  const similarities = new Map<string, number>();
  for (const item of input.scoped) yield scoreMemoryItem(item, input, now, similarities);
}

function collect(hits: Iterable<MemorySearchHit | undefined>): MemorySearchHit[] {
  const byId = new Map<string, MemorySearchHit>();
  for (const hit of hits) {
    if (!hit) continue;
    const previous = byId.get(hit.memory.id);
    if (!previous || hit.score > previous.score) byId.set(hit.memory.id, hit);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);
}

export function rankMemorySearch(input: RankingInput): MemorySearchHit[] {
  return collect(scoreMemorySearch(input)).slice(0, Math.max(1, Math.min(100, input.request.limit ?? 20)));
}

export async function rankMemorySearchAsync(input: RankingInput & { current: (id: string) => MemoryRecordDto | undefined }): Promise<MemorySearchHit[]> {
  const scored: MemorySearchHit[] = [];
  let started = performance.now();
  for (const hit of scoreMemorySearch(input)) {
    if (hit) scored.push(hit);
    if (performance.now() - started >= 4) { await yieldThread(); started = performance.now(); }
  }
  const result: MemorySearchHit[] = [];
  const statuses = input.request.statuses?.length ? input.request.statuses : ["active"];
  const now = Date.now();
  for (const hit of collect(scored)) {
    const memory = input.current(hit.memory.id);
    if (!memory || memory.contentHash !== hit.memory.contentHash || !statuses.includes(memory.status)
      || (input.request.kinds?.length && !input.request.kinds.includes(memory.kind))
      || (memory.status === "active" && ((memory.validFrom !== undefined && memory.validFrom > now)
        || (memory.validUntil !== undefined && memory.validUntil <= now))) || !input.visible(memory)) continue;
    result.push({ ...hit, memory });
    if (result.length >= Math.max(1, Math.min(100, input.request.limit ?? 20))) break;
  }
  return result;
}
