export type DotsWorkerOutcome =
  | { dotsState: "complete"; result: string }
  | { dotsState: "progress"; result: string; remainingQuote: string };

/** An accepted native answer ends a model turn. The worker declares whether it ends the assignment. */
export function readDotsWorkerOutcome(text: string): DotsWorkerOutcome | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.startsWith("```") ? /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed) : undefined;
  const json = fenced?.[1] ?? trimmed;
  if (!json.startsWith("{")) return;
  try {
    const value = JSON.parse(json);
    if (typeof value?.result !== "string") return;
    if (value.dotsState === "complete") return { dotsState: value.dotsState, result: value.result };
    if (value.dotsState === "progress" && typeof value.remainingQuote === "string") {
      return { dotsState: value.dotsState, result: value.result, remainingQuote: value.remainingQuote.trim() };
    }
  } catch {
    // Ordinary model prose does not declare an outcome.
  }
}
