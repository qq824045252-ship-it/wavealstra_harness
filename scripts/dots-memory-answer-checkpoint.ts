export type AnswerProgressRow = { id: string; actual?: string; executionFailure?: string } & Record<string,unknown>;

/** A failed request was paid for but produced no answer. Resume it, including cases where
 * other questions reached a terminal incorrect answer before the previous run stopped. */
export function restoreAnswerProgress(report: unknown, conditions: Record<string,unknown>, questions: Set<string>): AnswerProgressRow[] {
  if (!report || typeof report !== "object" || !("conditions" in report) || JSON.stringify(report.conditions) !== JSON.stringify(conditions))
    throw new Error("Checkpoint conditions changed: choose a new DOTS_MEMORY_ANSWER_RUN or restore the original model, dataset and code.");
  if (!("rows" in report) || !Array.isArray(report.rows)) throw new Error("Missing checkpoint rows");
  const seen = new Set<string>();
  const completed: AnswerProgressRow[] = [];
  for (const row of report.rows) {
    if (!row || typeof row.id !== "string" || !questions.has(row.id) || seen.has(row.id)) throw new Error("Invalid or duplicate checkpoint question");
    seen.add(row.id);
    if (row.executionFailure) continue;
    if (typeof row.actual !== "string" || typeof row.combined !== "boolean" || typeof row.sourceCorrect !== "boolean"
      || typeof row.factCorrect !== "boolean" || typeof row.abstentionCorrect !== "boolean") throw new Error("Incomplete checkpoint answer");
    completed.push(row);
  }
  return completed;
}
