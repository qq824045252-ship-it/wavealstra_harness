/**
 * R3.5 extension — pure helpers for Fusion & semantic bridging.
 * Kept separate to avoid bloating main locator file; imported lazily.
 */
import type { WorkspaceResourceHit } from "../../shared/workspace-resource-locator";
import type { SemanticCandidate } from "../retrieval/WorkspaceSemanticProvider";

/** Fusion precedence: exact title/filename > strong lexical > semantic > weak lexical ; score=relevance */
export function fuseHits(
  lexical: WorkspaceResourceHit[],
  semantic: SemanticCandidate[],
  getItem: (id: string) => { spaceId?: string; title?: string; filename?: string; kind?: string; updatedAt?: number } | undefined,
  limit: number,
): WorkspaceResourceHit[] {
  if (limit <= 0) return [];
  const semanticHits: WorkspaceResourceHit[] = semantic.flatMap((c): WorkspaceResourceHit[] => {
    const item = getItem(c.itemId);
    if (!item) return [];
    return [{
      resourceType: "library" as const,
      id: c.itemId,
      spaceId: item?.spaceId ?? "",
      title: item?.title ?? "",
      filename: item?.filename ?? "",
      preview: c.preview,
      matchedBy: "semantic" as const,
      score: 1 - c.score, // relevance → sort ascending: higher cosine = smaller score (so semantic ranks well but still after exact)
      freshness: item?.updatedAt ?? Date.now(),
      provider: "library" as const,
      kind: item?.kind ?? "markdown",
      chunkIndex: c.chunkIndex,
      charOffset: c.charOffset,
      location: `chunk ${c.chunkIndex} @ offset ${c.charOffset}`,
    }];
  });

  const ranked = [...lexical, ...semanticHits].sort((a, b) =>
    precedence(a) - precedence(b)
    || a.score - b.score
    || b.freshness - a.freshness
    || a.id.localeCompare(b.id));
  const byId = new Map<string, WorkspaceResourceHit>();
  for (const hit of ranked) {
    if (byId.has(hit.id)) continue;
    byId.set(hit.id, hit);
    if (byId.size === limit) break;
  }
  return [...byId.values()];
}

function precedence(hit: WorkspaceResourceHit): number {
  if (hit.matchedBy === "title" || hit.matchedBy === "filename") return 0;
  if (hit.matchedBy === "fts" && hit.score < 1) return 1;
  if (hit.matchedBy === "semantic" || hit.matchedBy === "fts") return 2;
  return 3;
}
