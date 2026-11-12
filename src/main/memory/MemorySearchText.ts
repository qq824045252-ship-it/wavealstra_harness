const MEMORY_FTS_MAX_TRIGRAMS = 64;
export const normalizeSearchText = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");

export function buildMemoryFtsQuery(query: string): string | null {
  const compact = query.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
  if (compact.length < 3) return null;
  const grams: string[] = [];
  const add = (value: string) => {
    const term = value.trim();
    if (term.length < 3 || grams.includes(term)) return;
    grams.push(term);
  };
  const normalized = query.normalize("NFKC").toLowerCase();
  for (const word of normalized.split(/[^\p{L}\p{N}_+.-]+/u)) {
    if (word.length >= 3 && word.length <= 40) add(word);
  }
  // Latin/number identifiers (models, part numbers) embedded in CJK text are the most selective terms.
  for (const word of normalized.match(/[a-z0-9][a-z0-9_+.-]{2,39}/g) ?? []) add(word);
  // Trigrams make natural-language questions retrieve the embedded noun/model phrase without exact sentence matching.
  // Sample across the whole prompt so terms late in a long message still participate.
  const trigramCount = compact.length - 2;
  const step = Math.max(1, trigramCount / MEMORY_FTS_MAX_TRIGRAMS);
  for (let i = 0; i < trigramCount; i += step) add(compact.slice(Math.floor(i), Math.floor(i) + 3));
  return grams.length ? grams.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ") : null;
}
