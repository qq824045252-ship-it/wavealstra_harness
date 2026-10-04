import {
  MEMORY_CONTEXT_DEFAULT_BUDGET, MEMORY_CONTEXT_HARD_BUDGET,
  type MemorySearchRequest, type ResolvedMemoryContext,
} from "../../shared/memory-kernel";
import type { MemoryService } from "../memory/MemoryService";

const PROJECT_BASELINE_LIMIT = 8;

export interface ProjectedMemoryContext extends ResolvedMemoryContext {
  sourceRevisions: Array<{ id: string; revision: number }>;
  groundingScenarioIds: string[];
}

/** Stateless selection/serialization. Memory repositories own facts and grounding. */
export function projectMemoryContext(
  memory: MemoryService,
  input: MemorySearchRequest & { budgetChars?: number; trackRecall?: boolean },
): ProjectedMemoryContext {
  const budget = Math.max(0, Math.min(MEMORY_CONTEXT_HARD_BUDGET, input.budgetChars ?? MEMORY_CONTEXT_DEFAULT_BUDGET));
  const result: ProjectedMemoryContext = {
    items: [], text: "", query: input.query?.trim() ?? "", budgetChars: budget,
    includedChars: 0, trimmed: false, scenarioIds: [], profileIds: [],
    sourceRevisions: [], groundingScenarioIds: [],
  };
  if (!budget) return result;
  const header = "历史记忆证据：L1 是事实来源，L2/L3 是经审批且仍有依据的派生视图；本轮明确指令优先。";
  const lines: string[] = [];
  // UTF-8 byte budget is conservative for tokens, including labels and separators.
  let bytes = Buffer.byteLength(header + "\n", "utf8");
  const push = (line: string): boolean => {
    const size = Buffer.byteLength(line + "\n", "utf8");
    if (bytes + size > budget) { result.trimmed = true; return false; }
    lines.push(line);
    bytes += size;
    return true;
  };
  const sources = memory.cognition.getContextSources(input);
  const visible = (id: string) => {
    const atom = memory.get(id);
    const now = Date.now();
    return atom?.status === "active" && memory.canAccess(id, input)
      && (atom.validFrom === undefined || atom.validFrom <= now)
      && (atom.validUntil === undefined || atom.validUntil > now);
  };
  const scenarios = sources.scenarios.filter((scenario) => scenario.sourceMemoryIds.every(visible));
  const byScenario = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const coveredAtoms = new Set<string>();
  const coveredScenarios = new Set<string>();
  const revisions = (ids: string[]) => ids.map((id) => `${id}@${memory.history(id)[0]?.revision ?? 0}`).join(",");
  // Only use a derived view if all of its grounding remains visible. Deduplication
  // follows source IDs, never similarity or untraceable paraphrase heuristics.
  for (const profile of sources.profiles) {
    if (!profile.sourceScenarioIds.every((id) => byScenario.has(id))) continue;
    const atomIds = [...new Set(profile.sourceScenarioIds.flatMap((id) => byScenario.get(id)!.sourceMemoryIds))];
    if (!atomIds.length || atomIds.every((id) => coveredAtoms.has(id))) continue;
    const line = `- [L3 derived:${profile.id}][${profile.scopeType}] ${profile.title} — ${profile.content.slice(0, 1000)} (sources: ${revisions(atomIds)})`;
    if (push(line)) {
      result.profileIds!.push(profile.id);
      profile.sourceScenarioIds.forEach((id) => coveredScenarios.add(id));
      atomIds.forEach((id) => coveredAtoms.add(id));
    }
  }
  const queried = memory.search({ ...input, statuses: input.statuses ?? ["active"], limit: Math.max(32, (input.limit ?? 16) * 3) })
    .filter((hit) => visible(hit.memory.id));
  // Shared project cognition is a baseline for every bound task, not only for lexically similar prompts.
  const queriedIds = new Set(queried.map((hit) => hit.memory.id));
  const projectBaseline = input.query?.trim() && (input.projectId || input.taskId)
    ? memory.search({ ...input, query: undefined, scopeTypes: ["project"], statuses: ["active"], limit: PROJECT_BASELINE_LIMIT })
      .filter((hit) => !queriedIds.has(hit.memory.id) && visible(hit.memory.id))
    : [];
  const hits = [...queried, ...projectBaseline];
  const relevantIds = queriedIds;
  for (const scenario of scenarios) {
    if (coveredScenarios.has(scenario.id)) continue;
    if (input.query?.trim() && !scenario.sourceMemoryIds.some((id) => relevantIds.has(id))) continue;
    if (scenario.sourceMemoryIds.every((id) => coveredAtoms.has(id))) continue;
    const line = `- [L2 derived:${scenario.id}][${scenario.scopeType}] ${scenario.title} — ${scenario.summary.slice(0, 700)} (sources: ${revisions(scenario.sourceMemoryIds)})`;
    if (push(line)) {
      result.scenarioIds!.push(scenario.id);
      coveredScenarios.add(scenario.id);
      scenario.sourceMemoryIds.forEach((id) => coveredAtoms.add(id));
    }
  }
  const chain = memory.resolveScopeChain(input);
  const decorated = hits.map((hit) => ({ hit, scope: memory.bestMatchedScope(hit.memory, chain) }));
  const picked = new Set<string>();
  const ordered: typeof decorated = [];
  const add = (entry: typeof decorated[number]) => {
    if (picked.has(entry.hit.memory.id) || coveredAtoms.has(entry.hit.memory.id)) return;
    picked.add(entry.hit.memory.id);
    ordered.push(entry);
  };
  for (const scope of chain) {
    const first = decorated.find((entry) => entry.scope.scopeType === scope.scopeType && entry.scope.scopeId === scope.scopeId);
    if (first) add(first);
  }
  decorated.forEach(add);
  for (const { hit, scope } of ordered) {
    if (result.items.length >= (input.limit ?? 16)) { result.trimmed = true; break; }
    const atom = hit.memory;
    if (!push(`- [L1 ${revisions([atom.id])}][${atom.kind}][${scope.scopeType}] ${atom.title}${atom.content ? ` — ${atom.content.slice(0, 700)}` : ""}`)) continue;
    result.items.push({ id: atom.id, kind: atom.kind, title: atom.title, content: atom.content,
      scopeType: scope.scopeType, scopeId: scope.scopeId, importance: atom.importance, confidence: atom.confidence,
      score: hit.score, reasons: hit.reasons });
  }
  if (lines.length) result.text = [header, ...lines].join("\n");
  result.includedChars = result.text.length;
  const sourceIds = [...new Set([...coveredAtoms, ...result.items.map((item) => item.id)])];
  result.sourceRevisions = sourceIds.map((id) => ({ id, revision: memory.history(id)[0]?.revision ?? 0 }));
  result.groundingScenarioIds = [...coveredScenarios];
  if (input.trackRecall !== false) memory.noteContextRecall(sourceIds);
  return result;
}

/** Current task ownership only. A removed workspace must not fall back to session creation metadata. */
export function resolveTaskMemoryScope(taskId: string, task: { projectId?: string | null; spaceId?: string | null } | undefined) {
  return { taskId, projectId: task?.projectId ?? undefined, workspaceId: task?.spaceId ?? undefined };
}
