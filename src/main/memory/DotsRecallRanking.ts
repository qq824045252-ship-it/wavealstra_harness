import type { MemoryRecordDto, MemorySearchHit } from "../../shared/memory-kernel";

// Question scaffolding should not outweigh names and subject words in a conversation search.
const stopWords = new Set(("a an the am are is was were be been being do does did have has had can could should would will " +
  "i me my mine you your yours our ours we they their it its this that these those what which where when why who whom " +
  "how for from with in on at by as and or of to about some any there than into said say tell told mention mentioned " +
  "我 我们 你 你们 的 了 吗 呢 是 有 在 和 什么 哪个 哪些 多少 哪里 怎么 如何 请 请问 之前 记得").split(" "));

const han = /\p{Script=Han}/u;
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
function wordsIn(text: string): string[] {
  const normalized = text.toLowerCase().normalize("NFKC");
  if (!han.test(normalized)) return normalized.match(/[a-z0-9]+/g) ?? [];
  return Array.from(segmenter.segment(normalized), item => item.isWordLike ? item.segment : "").filter(Boolean);
}

function wordStem(raw: string): string {
  if (raw.length < 5 || !/^[a-z]+$/.test(raw)) return raw;
  if (raw.endsWith("ies")) return raw.slice(0, -3) + "y";
  let stem = raw;
  if (raw.endsWith("ing") && raw.length > 5) stem = raw.slice(0, -3);
  else if (raw.endsWith("ed")) stem = raw.slice(0, -2);
  else if (/(?:sh|ch|ss|x|z)es$/.test(raw)) stem = raw.slice(0, -2);
  else if (raw.endsWith("s") && !/(ss|us|is)$/.test(raw)) stem = raw.slice(0, -1);
  if (stem !== raw && /([b-df-hj-np-tv-z])\1$/.test(stem)) stem = stem.slice(0, -1);
  // Match inflections of silent-e verbs as well as their base form.
  if (stem.endsWith("e") && stem.length > 4) stem = stem.slice(0, -1);
  return stem;
}

export function dotsQuestionTerms(query: string): string[] {
  if (/\b[0-9a-f]{12,128}\b/i.test(query)) return [];
  const words = wordsIn(query);
  return [...new Set(words.filter(word => word.length >= 2 && !stopWords.has(word)).map(wordStem))].slice(0, 32);
}

function sourceOf(memory: MemoryRecordDto): string | undefined {
  // An entire Task or Workspace can contain unrelated material. Only use a concrete source link.
  const evidence = memory.evidence.find(ref => ref.evidenceKind === "message" || ref.evidenceKind === "conversation");
  return evidence && JSON.stringify([evidence.evidenceKind, evidence.refId]);
}

function speaker(memory: MemoryRecordDto): "user" | "assistant" | undefined {
  if (memory.sourceType === "user") return "user";
  if (memory.sourceType === "agent") return "assistant";
  // Imported transcripts may label the speaker in the title. This only affects ranking.
  if (/^(?:user\b|用户)(?:\s|[:：]|$)/i.test(memory.title)) return "user";
  if (/^(?:assistant\b|助手)(?:\s|[:：]|$)/i.test(memory.title)) return "assistant";
  return undefined;
}

function requestedSpeaker(query: string): ReturnType<typeof speaker> {
  if (/\b(?:you (?:recommended|suggested|said|told|gave|listed)|did you (?:recommend|suggest|say|tell|give|list))\b|你.{0,6}(?:建议|推荐|提到|告诉|说过)/i.test(query)) return "assistant";
  if (/\b(?:i|my|mine|me)\b|我/i.test(query)) return "user";
  return undefined;
}

/** Rank only the currently authorized passages supplied by the kernel. A strong passage
 * can ground a shorter statement from the same source even if the speakers use different words. */
export function rankDotsEvidence(query: string, hits: readonly MemorySearchHit[], limit: number,
  semanticScores?: ReadonlyMap<string, number>): MemorySearchHit[] {
  const terms = dotsQuestionTerms(query);
  if (!terms.length || !hits.length) return hits.slice(0, limit);
  const sought = new Set(terms);
  const wantedSpeaker = requestedSpeaker(query);
  const documents = hits.map((hit, index) => {
    const frequencies = new Map<string, number>();
    const words = wordsIn(hit.memory.title + "\n" + hit.memory.content);
    for (const word of words) {
      const stem = wordStem(word);
      if (sought.has(stem)) frequencies.set(stem, (frequencies.get(stem) ?? 0) + 1);
    }
    return { hit, index, words: words.length, frequencies, source: sourceOf(hit.memory), speaker: speaker(hit.memory) };
  });
  const weights = new Map(terms.map(term => {
    const count = documents.filter(doc => doc.frequencies.has(term)).length;
    return [term, Math.log1p((documents.length + 0.5) / (count + 0.5))];
  }));
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const averageLength = documents.reduce((sum, doc) => sum + doc.words, 0) / documents.length;
  const bestSource = new Map<string, number>();
  const scored = documents.map(doc => {
    let relevance = 0;
    for (const [term, count] of doc.frequencies) {
      // Concise statements keep up with long assistant responses that repeat their subject.
      const length = 0.75 + 0.25 * doc.words / Math.max(1, averageLength);
      relevance += weights.get(term)! * count * 2 / (count + length);
    }
    relevance /= totalWeight;
    const cosine = semanticScores?.get(doc.hit.memory.id);
    if (cosine !== undefined) relevance = Math.max(relevance, Math.max(0, (cosine - 0.5) / 0.5));
    if (doc.source) bestSource.set(doc.source, Math.max(relevance, bestSource.get(doc.source) ?? 0));
    return { ...doc, relevance };
  });
  const ranked = scored.map(doc => {
    const context = doc.source ? bestSource.get(doc.source) ?? 0 : 0;
    const opening = 1 / (1 + doc.index / 9);
    const attribution = wantedSpeaker && doc.speaker === wantedSpeaker ? 0.22 : 0;
    const adjacent = attribution && doc.hit.reasons.includes("source-context");
    const grounding = Math.max(doc.relevance, adjacent ? 0.72 * context : 0) + attribution * Math.min(1, context);
    // Preserve vector-only matches for paraphrases. Context cannot introduce a new source.
    const score = grounding + 0.16 * context + 0.42 * opening +
      (doc.hit.reasons.includes("semantic") ? 0.24 * opening : 0);
    return { ...doc, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  const counts = new Map<string, number>();
  const selected: MemorySearchHit[] = [];
  while (selected.length < limit && ranked.length) {
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < ranked.length; i++) {
      const row = ranked[i]!;
      const repeats = row.source ? counts.get(row.source) ?? 0 : 0;
      const adjusted = row.score - 0.18 * Math.min(repeats, 3);
      if (adjusted > bestScore) { best = i; bestScore = adjusted; }
    }
    const row = ranked.splice(best, 1)[0]!;
    if (row.source) counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
    selected.push({ ...row.hit, score: bestScore * 100 });
  }
  return selected;
}
