import type Database from "better-sqlite3";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";
import { watchGoalEvidence, type WatchGoalEvidence } from "./WorkWatchGoal";

export const WATCH_PREVIOUS_SOURCE_LIMIT = 8;
export const WATCH_PREVIOUS_EVIDENCE_BUDGET = 16 * 1024;
export interface PreviousWatchObservations {
  status: "complete" | "unavailable" | "budget_exceeded";
  reason?: "no_history" | "current_unavailable" | "history_unavailable" | "source_mismatch" | "ambiguous_source" | "source_limit" | "text_budget";
  baselineResultId?: string;
  reportedAt?: number;
  observations: WatchGoalEvidence[];
}

const sourceKey = (item: WatchGoalEvidence) => JSON.stringify([item.toolName, item.source]);
function sourceMap(items: WatchGoalEvidence[]): Map<string, WatchGoalEvidence> | undefined {
  const result = new Map<string, WatchGoalEvidence>();
  for (const item of items) {
    const key = sourceKey(item), previous = result.get(key);
    if (previous && previous.text !== item.text) return undefined;
    result.set(key, item);
  }
  return result;
}

/** Historical comparison material only. Never append it to the current round's
 * verifiedObservations or pass it to watchGoalMet. Use one eligible earlier
 * round, without reaching past a missing/failed receipt for a nicer baseline. */
export function previousWatchObservations(db: Database.Database, works: WorkService,
  binding: WorkExecutionBindingDto, current: WatchGoalEvidence[]): PreviousWatchObservations {
  const report = works.repo.previousWatchReports(binding).at(-1);
  if (!report) return { status: "unavailable", reason: "no_history", observations: [] };
  const base = { baselineResultId: report.deliverableId, reportedAt: report.createdAt };
  const unavailable = (reason: PreviousWatchObservations["reason"]): PreviousWatchObservations =>
    ({ ...base, status: "unavailable", reason, observations: [] });
  const sources = sourceMap(current);
  if (!sources) return unavailable("ambiguous_source");
  if (!sources.size) return unavailable("current_unavailable");
  if (sources.size > WATCH_PREVIOUS_SOURCE_LIMIT)
    return { ...base, status: "budget_exceeded", reason: "source_limit", observations: [] };
  const previous = works.repo.getBinding(report.executionId);
  if (!previous || report.isSpeculation || report.hasWriteConflicts || report.uncoveredScope.length)
    return unavailable("history_unavailable");
  const historicalEvidence = watchGoalEvidence(db, works, previous);
  if (!historicalEvidence.length) return unavailable("history_unavailable");
  const history = sourceMap(historicalEvidence.filter(item => sources.has(sourceKey(item))));
  if (!history) return unavailable("ambiguous_source");
  const observations: WatchGoalEvidence[] = [];
  for (const key of sources.keys()) {
    const item = history.get(key);
    if (!item) return unavailable("source_mismatch");
    observations.push(item);
  }
  // Omit the entire package on overflow. A clipped source must never appear to
  // be a complete historical read, even if its visible prefix matches today.
  const complete: PreviousWatchObservations = { ...base, status: "complete", observations };
  if (Buffer.byteLength(JSON.stringify(complete), "utf8") > WATCH_PREVIOUS_EVIDENCE_BUDGET)
    return { ...base, status: "budget_exceeded", reason: "text_budget", observations: [] };
  return complete;
}
