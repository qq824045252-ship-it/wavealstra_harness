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
  const byId = new Map<string, WorkspaceResourceHit>();
  for (const h of lexical) byId.set(h.id, h);

  // lexical strong guard: title/filename never displaced
  const lexicalStrongIds = new Set(
    lexical.filter((h) => h.matchedBy === "title" || h.matchedBy === "filename").map((h) => h.id),
  );

  const semanticHits: WorkspaceResourceHit[] = semantic.map((c) => {
    const item = getItem(c.itemId);
    return {
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
    };
  });

  // merge: keep lexical strong, fill with semantic + weak lexical by relevance
  const strongLex = lexical.filter((h) => lexicalStrongIds.has(h.id));
  const weakLex = lexical.filter((h) => !lexicalStrongIds.has(h.id));
  // classify strong lexical (fts with good score)
  const strongFts = weakLex.filter((h) => h.matchedBy === "fts" && h.score < 1);
  const weakRest = weakLex.filter((h) => !(h.matchedBy === "fts" && h.score < 1));

  // precedence: title/filename > strongFts > semantic > weakRest (but semantic interleave is by score)
  const out: WorkspaceResourceHit[] = [...strongLex, ...strongFts];
  const remaining = limit - out.length;
  if (remaining <= 0) return out.slice(0, limit);

  // merge semantic vs weakRest by score (semantic score is 1-cos, lexical weak score is 2/3)
  const semSorted = [...semanticHits].sort((a, b) => a.score - b.score);
  const weakSorted = [...weakRest].sort((a, b) => a.score - b.score);

  let i = 0,
    j = 0;
  while (out.length < limit && (i < semSorted.length || j < weakSorted.length)) {
    const s = semSorted[i];
    const w = weakSorted[j];
    if (!s) {
      if (w && !byId.has(w.id) && !out.some((o) => o.id === w.id)) out.push(w);
      j++;
      continue;
    }
    if (!w) {
      if (!out.some((o) => o.id === s.id) && !byId.has(s.id) || !lexicalStrongIds.has(s.id)) {
        if (!out.some((o) => o.id === s.id)) out.push(s);
      } else if (!out.some((o) => o.id === s.id)) {
        // still add if not duplicate strong
        out.push(s);
      }
      i++;
      continue;
    }
    // prefer semantic when it exists and lexical is weak chunk/fallback
    const wIsWeak = w.matchedBy === "chunk" || w.matchedBy === "fallback";
    if (wIsWeak || s.score < w.score) {
      if (!out.some((o) => o.id === s.id)) out.push(s);
      i++;
    } else {
      if (!out.some((o) => o.id === w.id)) out.push(w);
      j++;
    }
  }
  // fill any remaining weak if semantic exhausted
  while (out.length < limit && j < weakSorted.length) {
    const w = weakSorted[j++]!;
    if (!out.some((o) => o.id === w.id)) out.push(w);
  }
  while (out.length < limit && i < semSorted.length) {
    const s = semSorted[i++]!;
    if (!out.some((o) => o.id === s.id)) out.push(s);
  }
  // Determinism tie-break
  out.sort((a, b) => {
    const ap = precedence(a);
    const bp = precedence(b);
    if (ap !== bp) return ap - bp;
    if (a.score !== b.score) return a.score - b.score;
    if (b.freshness !== a.freshness) return b.freshness - a.freshness;
    return a.id.localeCompare(b.id);
  });
  return out.slice(0, limit);
}

function precedence(h: WorkspaceResourceHit): number {
  if (h.matchedBy === "title" || h.matchedBy === "filename") return 0;
  // Semantic relevance (high cosine) should interleave with FTS, not always after.
  // Use score-based tie inside same band: semantic 1-cos ~0.2-0.5 vs FTS rank 2 + bm25
  // Keep FTS strong (score<1 bm25 negative) still ahead, but semantic 0.36 is better than FTS 2
  if (h.matchedBy === "semantic") return 1;
  if (h.matchedBy === "fts") return 1;
  return 3; // chunk/fallback/body
}
