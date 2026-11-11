/** Renderer test double only. Production queries use the SQLite summary reader. */
import type { WorkQueryRequest, WorkQueryResult } from "../src/shared/bot-work-query";
import type { WorkProjectionDto } from "../src/shared/bot-work";
import { canArchiveWork, isWorkArchived } from "../src/shared/bot-work-archive";
import { nextWatchCheckAt } from "../src/renderer/src/lib/botWatchPresentation";
import { workMatchesSearch, workMatchesView, workSearchText, workStatus } from "../src/renderer/src/lib/botWorkspacePresentation";
export function queryWorkFixture(all: WorkProjectionDto[], request: WorkQueryRequest): WorkQueryResult {
  const scoped = all.filter(work => !work.team?.removedAt && (request.scope.kind === "all" || request.scope.kind === "historical_teams" || request.scope.kind === "removed_teams" ? request.scope.kind === "all" || Boolean(work.team) : request.scope.kind === "team" ? work.team?.teamId === request.scope.teamId : !work.team && work.ownerBotId === request.scope.botId));
  const counts = { active: 0, completed: 0, closed: 0, all: 0 };
  for (const work of scoped) { for (const view of ["active", "completed", "closed"] as const) if (workMatchesView(work, view)) counts[view]++; if (!work.archive?.deletedAt) counts.all++; }
  const visible = scoped.filter(work => request.showDeleted ? Boolean(work.archive?.deletedAt) && isWorkArchived(work) : request.view && request.view !== "all" ? workMatchesView(work, request.view) : !work.archive?.deletedAt);
  const searched = visible.filter(work => workMatchesSearch(workSearchText(work), request.query ?? ""));
  const filterCounts: WorkQueryResult["filterCounts"] = {};
  for (const work of searched) { const group = workStatus(work).group; filterCounts[group] = (filterCounts[group] ?? 0) + 1; }
  const filtered = searched.filter(work => !request.status || request.status === "all" || workStatus(work).group === request.status)
    .sort((a,b) => (request.sort === "oldest" ? a.updatedAt-b.updatedAt : b.updatedAt-a.updatedAt) || a.workId.localeCompare(b.workId));
  const pageSize = request.pageSize ?? 24, pages = Math.max(1, Math.ceil(filtered.length / pageSize)), page = Math.min(request.page ?? 1, pages);
  return { works: filtered.slice((page-1)*pageSize,page*pageSize).map(work => ({ ...work,
    listSummary: { status: workStatus(work), excerpt: work.closureSummary ?? work.deliverables.at(-1)?.summary ?? work.nextSteps[0] ?? "", deliverableCount: work.deliverables.length, nextCheckAt: nextWatchCheckAt(work), canArchive: canArchiveWork(work), executionTaskIds: work.executions.map(item=>item.taskId), running: work.executions.some(item=>item.status === "running") },
    goalDescription: undefined, criteria: [], deliverables: [], blockers: [], executions: [], notifications: [], cards: [], generatedArtifacts: [], historicalGeneratedArtifacts: [], runtimeObservations: [], phase3: undefined, phase4: undefined, nextSteps: [],
  })), total: visible.length, filtered: filtered.length, page, pageSize, pages, filterCounts, viewCounts: counts, deletedCount: scoped.filter(work=>work.archive?.deletedAt).length, workExecutionTaskIds: [], watermark:{epoch:"fixture",sequence:1,revision:"fixture"} };
}
