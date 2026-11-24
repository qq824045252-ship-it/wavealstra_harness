const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const conclusionPrefix = /^(?:(?:[-*]|#{1,6})\s+)?(?:\*\*)?(?:本步结论|阶段结论|结论|小结|总结|conclusion|summary|takeaway)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?/iu;
const maxConclusionLength = 240;

/** Use a brief public update or extract the end of the visible thinking segment. */
export function thinkingConclusion(thinking: string, progress?: string): string | undefined {
  const publicUpdate = progress?.replace(/\s+/gu, " ").trim();
  if (publicUpdate && !/^[{[<`]/u.test(publicUpdate) && publicUpdate.length <= maxConclusionLength) {
    return publicUpdate.replace(conclusionPrefix, "");
  }

  const prose = thinking.replace(/^`{3,}[^\n]*\n[\s\S]*?^`{3,}[^\n]*$/gmu, " ").replace(/\s+/gu, " ").trim();
  const tail = Array.from(sentenceSegmenter.segment(prose)).slice(-2);
  const marked = tail.filter(sentence => conclusionPrefix.test(sentence.segment.trimStart())).at(-1);
  const last = tail.at(-1);
  if (!last) return undefined;
  const start = marked ?? (prose.length - tail[0].index <= maxConclusionLength ? tail[0] : last);
  const text = prose.slice(start.index).trim().replace(conclusionPrefix, "");
  if (!/[\p{L}\p{N}]/u.test(text)) return undefined;
  if (!text) return undefined;
  const characters = Array.from(text);
  return characters.length <= maxConclusionLength ? text : characters.slice(0, maxConclusionLength).join("").trimEnd() + "…";
}
