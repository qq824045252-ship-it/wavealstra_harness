export type DotsWorkerOutcome =
  | { dotsState: "complete"; result: string }
  | { dotsState: "progress"; result: string; remainingQuote: string };

/** An accepted native answer ends a model turn. The worker declares whether it ends the assignment. */
export function readDotsWorkerOutcome(text: string): DotsWorkerOutcome | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.startsWith("```") ? /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed) : undefined;
  return parseWorkerOutcome(fenced?.[1] ?? trimmed);
}

function parseWorkerOutcome(json: string, exact = false): DotsWorkerOutcome | undefined {
  if (!json.startsWith("{")) return;
  try {
    const value = JSON.parse(json);
    if (typeof value?.result !== "string") return;
    if (value.dotsState === "complete" && (!exact || Object.keys(value).length === 2)) {
      return { dotsState: value.dotsState, result: value.result };
    }
    if (value.dotsState === "progress" && typeof value.remainingQuote === "string" && (!exact || Object.keys(value).length === 3)) {
      return { dotsState: value.dotsState, result: value.result, remainingQuote: value.remainingQuote.trim() };
    }
  } catch {
    // Ordinary model prose does not declare an outcome.
  }
}

/** Presentation only. A manual follow-up can echo the wire envelope from a prior delegation. */
export function recoverDotsNarrativeReply(text: string, streaming = false): string | undefined {
  const opening = /\r?\n```json[ \t]*\r?\n/i.exec(text);
  if (!opening) return;
  const prose = text.slice(0, opening.index).trimEnd();
  if (!prose.trim() || /^ {0,3}(?:`{3,}|~{3,})/m.test(prose)) return;
  const rest = text.slice(opening.index + opening[0].length);
  const closing = /\r?\n```[ \t]*\s*$/.exec(rest);
  if (!closing) return streaming && /^\s*\{\s*"dotsState"\s*:/.test(rest) ? prose : undefined;
  const outcome = parseWorkerOutcome(rest.slice(0, closing.index).trim(), true);
  if (!outcome) return;
  return [prose, outcome.result].filter(Boolean).join("\n\n");
}
